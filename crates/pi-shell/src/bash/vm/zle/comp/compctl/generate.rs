//! compctl.c's generation side: the `compctl_make` hook (`ccmakehookfn`),
//! `compcall` (`makecomplistctl`), the walk over the compctls that apply
//! to the word (`makecomplistglobal` … `makecomplistflags`) and the match
//! sources (`gen_matches_files`, `dumphashtable`, `maketildelist`, the
//! `-K`/`-y` functions, `-s`, `-g`, `-H`, …), plus `read -c`/`-l`
//! (`compctlread`).
//!
//! The generation runs inside the `compcall` builtin, so it can probe the
//! file system, run command substitutions and call shell functions the
//! way builtins do: it is re-run from scratch after each of them. A run
//! ([`Run`]) keeps the completion state as it was when the builtin started
//! (restored before each re-run), the `$reply` each function call left
//! (replayed in order), and the file-system answers it got (by question
//! number, so one run asks all the questions it can answer at once
//! instead of one re-run per question).

use std::sync::Arc;

use bstr::{BStr, BString, ByteSlice};

use super::{
	super::{
		Comp, K, comp, comp_mut, compcore, compmatch, qt,
		types::{Cexpl, Cl, cgf, cmf},
	},
	Arg, Cc, Cond, State, Xor, cc, cc2, cct, state,
};
use crate::bash::{
	diag::Diag,
	fs::{Stat, StatKind},
	ids::{Dialect, IntrinsicId},
	pattern::zsh::{PatFlags, Pattern, remnulargs, tokenize},
	store::{Key, KeyBuf, MiscKey, Record, Table},
	syntax::zsh::{
		LEXFLAGS_ZLE, LexTok as T, ZleLex, ZleWords, parsestr,
		tok::{
			self, BNULL, DASH, DNULL, EQUALS, OUTPAR, QSTRING, SNULL, STAR, STRING, TICK, TILDE, at,
			metafy, unmetafy, untokenize,
		},
	},
	vm::{
		builtins::{
			Control, Ctx, Need, Outcome, R, done,
			history::{model::HIST_FOREIGN, zsh as zhist},
			zsh_args::{Ops, zx},
			zsh_module,
		},
		expand::{Expander, X},
		fsprobe::{FsAns, FsReq},
		mode, probe,
		proc::{Probe, ProbeResult, Scratch},
		state as vstate,
		zle::exec::{Await, Got, WResult, Zw, push_call, then},
		zsh::{
			nameddir::{self, ND_USERNAME},
			params::{self, PValue, PmFlags},
			specials, subst, text, zglob, zpattern,
		},
	},
	zshopt::ZshOpt,
};

/// Things `makecomplistglobal` is not to do (zsh `CFN_*`).
const CFN_FIRST: i32 = 1;
const CFN_DEFAULT: i32 = 2;
/// zsh `MAX_CDEPTH`: nested `compcall`s.
const MAX_CDEPTH: usize = 16;

/// zsh's `linwhat` values.
const IN_MATH: i32 = 2;
const IN_COND: i32 = 3;
const IN_ENV: i32 = 4;

// ---- state kept in the completion state
// ---------------------------------------

/// zsh/compctl's part of the completion state ([`Comp::cc`]).
#[derive(Clone, Debug, Default)]
pub struct CcRun {
	/// The `compctl_make` hook's data while its `compcall` is due or
	/// running.
	make: Option<MakeDat>,
	/// Generation runs in progress, innermost last.
	runs: Vec<Run>,
}

/// zsh `struct ccmakedat`, plus the frame depth of the `compcall`
/// running it.
#[derive(Clone, Debug)]
struct MakeDat {
	s:     BString,
	incmd: i32,
	lst:   i32,
	depth: Option<usize>,
}

/// One generation run of a `compcall` (see the module doc).
#[derive(Clone, Debug)]
struct Run {
	/// Frame depth of the `compcall`.
	depth:    usize,
	/// The completion state when it started.
	snap:     Box<Comp>,
	/// The `$reply` of each shell function called, in order.
	calls:    Vec<Option<Vec<BString>>>,
	/// A function was pushed: its `$reply` is to be read.
	awaiting: bool,
	/// File-system answers by question number.
	facts:    Vec<Option<ProbeResult>>,
}

/// Why a generation run stopped before its end.
enum Halt {
	/// The builtin needs a probe, a substitution or the store.
	Need(Need),
	/// Call shell function `name` with `args`, then run again.
	Call { name: BString, args: Vec<BString> },
}

impl From<Need> for Halt {
	fn from(n: Need) -> Self {
		Self::Need(n)
	}
}

type G<T> = Result<T, Halt>;

// ---- the hooks
// ------------------------------------------------------------------

/// Whether zsh/compctl is loaded: its `compctl_make` hook is in place.
pub fn loaded(zw: &mut Zw<'_, '_>) -> bool {
	zsh_module::loaded(zw.cx.store, zw.vp, b"zsh/compctl").unwrap_or(false)
}

/// zsh `ccmakehookfn` (the `compctl_make` hook of `makecomplist` when the
/// completion widget has no function): the matches for word `s` from the
/// compctls; `k` gets zsh's `dat->lst`. The generation runs as the
/// `compcall` builtin in a frame of the editing shell (see the module
/// doc); this leaves the hook's data for it in the completion state.
pub fn make(zw: &mut Zw<'_, '_>, s: BString, incmd: i32, lst: i32, k: K<i32>) -> WResult {
	zw.zle.comp.cc.make = Some(MakeDat { s, incmd, lst, depth: None });
	let args = vec![BString::from("compcall")];
	then(Await::Command { name: BString::from("builtin"), args }, move |zw, _: Got| {
		let lst = zw.zle.comp.cc.make.take().map_or(lst, |m| m.lst);
		k(zw, lst)
	})
}

/// zsh `cccleanuphookfn` (the `compctl_cleanup` hook): forget the runs.
pub fn cleanup(c: &mut Comp) {
	c.cc.runs.clear();
}

// ---- compcall
// ------------------------------------------------------------------

/// The completion state of the vproc, taken out while the generation
/// runs (shell code is not run meanwhile), put back by [`put`].
fn take(ctx: &mut Ctx<'_, '_>) -> Option<Comp> {
	comp_mut(ctx.vp).map(std::mem::take)
}

fn put(ctx: &mut Ctx<'_, '_>, c: Comp) {
	if let Some(slot) = comp_mut(ctx.vp) {
		*slot = c;
	}
}

/// zsh `bin_compcall` (`compcall [-TD]` in a completion function: the
/// matches of the compctls), and the generation of the `compctl_make`
/// hook ([`make`]).
pub fn compcall(ctx: &mut Ctx<'_, '_>, ops: &Ops, _args: &[BString]) -> R {
	let depth = ctx.vp.frames.len();
	let hook = comp(ctx.vp)
		.and_then(|c| c.cc.make.as_ref())
		.is_some_and(|m| m.depth.is_none_or(|d| d == depth));
	if !hook && comp(ctx.vp).map_or(0, |c| c.incompfunc) != 1 {
		ctx.usage("can only be called from completion function");
		return done(1);
	}
	let Some(mut c) = take(ctx) else {
		return done(1);
	};
	if hook && let Some(m) = &mut c.cc.make {
		m.depth = Some(depth);
	}
	// A new run, or the same one again after a probe or a function.
	let mut run = match c.cc.runs.last() {
		Some(r) if r.depth == depth => {
			let mut run = c.cc.runs.pop().expect("checked");
			let cc = std::mem::take(&mut c.cc);
			c = (*run.snap).clone();
			c.cc = cc;
			if run.awaiting {
				run.awaiting = false;
				let reply = get_user_var(ctx, b"reply");
				let reply = match reply {
					Ok(r) => r,
					Err(n) => {
						run.awaiting = true;
						c.cc.runs.push(run);
						put(ctx, c);
						return Err(n);
					},
				};
				run.calls.push(reply);
			}
			run
		},
		_ => {
			if c.cc.runs.len() >= MAX_CDEPTH {
				put(ctx, c);
				return done(0);
			}
			let mut snap = c.clone();
			snap.cc = CcRun::default();
			Run { depth, snap: Box::new(snap), calls: Vec::new(), awaiting: false, facts: Vec::new() }
		},
	};
	let defs = match state(ctx) {
		Ok(d) => d,
		Err(n) => {
			c.cc.runs.push(run);
			put(ctx, c);
			return Err(n);
		},
	};
	let result = {
		let mut g = Gen::new(ctx, &mut c, &defs, &run.calls, &mut run.facts);
		if hook {
			let m = g.c.cc.make.clone().expect("hook data");
			g.ccmakehookfn(&m.s, m.incmd).map(|lst| (0, Some(lst)))
		} else {
			let flags = (if ops.isset(b'T') { 0 } else { CFN_FIRST })
				| (if ops.isset(b'D') { 0 } else { CFN_DEFAULT });
			g.makecomplistctl(flags).map(|r| (r, None))
		}
	};
	match result {
		Ok((ret, lst)) => {
			if let (Some(lst), Some(m)) = (lst, &mut c.cc.make) {
				m.lst = lst;
			}
			put(ctx, c);
			done(ret)
		},
		Err(Halt::Call { name, args }) => {
			// The function runs with the state the generation reached.
			run.awaiting = true;
			c.cc.runs.push(run);
			put(ctx, c);
			push_call(ctx.k, ctx.vp, &name, &args, false);
			Ok(Outcome { status: 0, control: Control::Resume })
		},
		Err(Halt::Need(n)) => {
			c.cc.runs.push(run);
			put(ctx, c);
			Err(n)
		},
	}
}

/// zsh `get_user_var(nam)`: the words of `(…)` or the value of array,
/// association or scalar `nam`.
fn get_user_var(ctx: &mut Ctx<'_, '_>, nam: &[u8]) -> Result<Option<Vec<BString>>, Need> {
	Ok(zx(ctx, |ex| compcore::get_user_var(ex, Some(nam)))?
		.ok()
		.flatten())
}

// ---- read -c / -l
// ------------------------------------------------------------

/// zsh `compctlread`: `read -l` and `read -c` in a function a compctl
/// called (`args` are the names after `reply`). The `read` builtin calls
/// it for `-l`/`-c`.
pub fn compctlread(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString], reply: &[u8]) -> R {
	if !zsh_module::loaded(ctx.cx.store, ctx.vp, b"zsh/compctl")? {
		ctx.usage("no loaded module provides read for completion context");
		return done(1);
	}
	let Some(c) = comp(ctx.vp).filter(|c| c.incompctlfunc).cloned() else {
		ctx.usage("option valid only in functions called via compctl");
		return done(1);
	};
	let e = ops.isset(b'e');
	let big_e = ops.isset(b'E');
	let mut out = Vec::new();
	let mut failed = false;
	let set = |ctx: &mut Ctx<'_, '_>, failed: &mut bool, name: &[u8], val: &[u8]| {
		super::super::computil::setsparam(ctx, failed, name, &unmetafy(val))
	};
	if ops.isset(b'l') {
		if ops.isset(b'n') {
			let n = format!("{}", c.line.cs + 1);
			if e || big_e {
				out.extend_from_slice(n.as_bytes());
				out.push(b'\n');
			}
			ctx.out(&out);
			if !e {
				set(ctx, &mut failed, reply, n.as_bytes())?;
			}
			return done(0);
		}
		let line = c.line.bytes().to_vec();
		if e || big_e {
			out.extend_from_slice(&unmetafy(&line));
			out.push(b'\n');
		}
		ctx.out(&out);
		if !e {
			set(ctx, &mut failed, reply, &line)?;
		}
		return done(0);
	}
	let t = &c.tricky;
	if ops.isset(b'n') {
		let n = format!("{}", t.clwpos + 1);
		if e || big_e {
			out.extend_from_slice(n.as_bytes());
			out.push(b'\n');
		}
		ctx.out(&out);
		if !e {
			set(ctx, &mut failed, reply, n.as_bytes())?;
		}
		return done(0);
	}
	let clwnum = usize::try_from(t.clwnum).unwrap_or(0).min(t.clwords.len());
	let words = &t.clwords[..clwnum];
	if ops.isset(b'A') && !e {
		let vals = words.iter().map(|w| BString::from(unmetafy(w))).collect();
		super::super::computil::setaparam(ctx, &mut failed, reply, vals)?;
		return done(0);
	}
	if e || big_e {
		for w in words {
			out.extend_from_slice(&unmetafy(w));
			out.push(b'\n');
		}
		ctx.out(&out);
		if e {
			return done(0);
		}
	}
	let mut reply = BString::from(reply);
	let mut i = 0;
	let mut rest = args.iter();
	while i < words.len() {
		let Some(next) = rest.next() else {
			break;
		};
		set(ctx, &mut failed, &reply, &words[i])?;
		reply = next.clone();
		i += 1;
	}
	let buf: Vec<u8> = words[i..].join(&b' ');
	set(ctx, &mut failed, &reply, &buf)?;
	done(0)
}

// ---- the compctls of a run
// ------------------------------------------------------

/// A compctl of the run (zsh `Compctl` pointer): its position in
/// [`Arena::nodes`].
type Id = usize;

/// The special compctls' positions.
const COMPOS: Id = 0;
const DEFAULT: Id = 1;
const FIRST: Id = 2;
const DUMMY: Id = 3;

/// One compctl of the run: its flags, `-x` patterns and `+` alternative
/// by position.
#[derive(Clone, Debug)]
struct Node {
	cc:   Cc,
	ext:  Vec<Id>,
	xor:  Option<Id>,
	cond: Vec<Vec<Cond>>,
}

/// The compctls numbered for a run: zsh's identity of compctls.
struct Arena {
	nodes: Vec<Node>,
	tab:   std::collections::BTreeMap<BString, Id>,
	pats:  Vec<(BString, Id)>,
}

impl Arena {
	fn new(st: &State) -> Self {
		let mut a = Self { nodes: Vec::new(), tab: Default::default(), pats: Vec::new() };
		for c in [&st.compos, &st.default, &st.first] {
			a.add(c);
		}
		a.nodes
			.push(Node { cc: Cc::zero(), ext: Vec::new(), xor: None, cond: Vec::new() });
		for (name, c) in &st.tab {
			let id = a.add(c);
			a.tab.insert(name.clone(), id);
		}
		for (pat, c) in &st.pats {
			let id = a.add(c);
			a.pats.push((pat.clone(), id));
		}
		a
	}

	fn add(&mut self, c: &Cc) -> Id {
		let id = self.nodes.len();
		let mut flat = c.clone();
		flat.ext = Vec::new();
		flat.xor = None;
		let cond = std::mem::take(&mut flat.cond);
		self
			.nodes
			.push(Node { cc: flat, ext: Vec::new(), xor: None, cond });
		let ext: Vec<Id> = c.ext.iter().map(|e| self.add(e)).collect();
		let xor = match &c.xor {
			None => None,
			Some(Xor::Default) => Some(DEFAULT),
			Some(Xor::Cc(x)) => Some(self.add(x)),
		};
		self.nodes[id].ext = ext;
		self.nodes[id].xor = xor;
		id
	}
}

// ---- the generation
// ---------------------------------------------------------------

/// A pattern of the run (zsh `Patprog`).
type Pat = Arc<Pattern>;

/// compctl.c's statics during a run, and what the run works with.
struct Gen<'r, 'a, 'c> {
	ctx:      &'r mut Ctx<'a, 'c>,
	c:        &'r mut Comp,
	ar:       Arena,
	calls:    &'r [Option<Vec<BString>>],
	ncalls:   usize,
	facts:    &'r mut Vec<Option<ProbeResult>>,
	nfacts:   usize,
	errflag:  bool,
	// compctl.c's statics.
	curcc:    Id,
	ccstack:  Vec<Id>,
	brange:   i32,
	erange:   i32,
	ccont:    u32,
	patcomp:  Option<Pat>,
	filecomp: Option<Pat>,
	lpre:     BString,
	lsuf:     BString,
	rpre:     BString,
	rsuf:     BString,
	ppre:     Option<BString>,
	psuf:     Option<BString>,
	lppre:    Option<BString>,
	lpsuf:    Option<BString>,
	prpre:    Option<BString>,
	fpre:     BString,
	fsuf:     BString,
	qfpre:    BString,
	qfsuf:    BString,
	qrpre:    BString,
	qrsuf:    BString,
	qlpre:    BString,
	qlsuf:    BString,
	lpl:      i32,
	lsl:      i32,
	rpl:      i32,
	rsl:      i32,
	fpl:      i32,
	fsl:      i32,
	lppl:     i32,
	lpsl:     i32,
	noreal:   bool,
	ic:       u8,
	addwhat:  i32,
	/// zsh `cmdstr` while the run changes it (`clwords` too live in the
	/// completion state).
	cmdstr:   Option<BString>,
}

/// zsh `DISABLED`, `ALIAS_GLOBAL` of a hash node.
const DISABLED: u32 = 1 << 0;
const ALIAS_GLOBAL: u32 = 1 << 1;

/// What `addmatch` reads of the hash node a name came from.
#[derive(Clone, Default)]
struct Hn {
	/// zsh's node flags: [`DISABLED`]/[`ALIAS_GLOBAL`] for commands and
	/// aliases, the `PM_*` bits for parameters.
	flags:  u32,
	/// A parameter: defined at level 0 (zsh `!pm->level`).
	global: bool,
	/// A parameter: scalar with this value.
	scalar: Option<BString>,
}

/// The hash tables `dumphashtable` reads.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ht {
	Cmdnam,
	Alias,
	Reswd,
	Shfunc,
	Builtin,
	Param,
	Nameddir,
	Option,
	Thingy,
}

/// zsh's option aliases (`OPT_ALIAS` entries of `optns`), which
/// `optiontab` lists with the options.
const OPTION_ALIASES: &[&str] = &[
	"braceexpand",
	"dotglob",
	"hashall",
	"histappend",
	"histexpand",
	"log",
	"mailwarn",
	"onecmd",
	"physical",
	"promptvars",
	"stdin",
	"trackall",
];

/// zsh's reserved words (`hashtable.c` `reswds`).
const RESWDS: &[&str] = &[
	"!",
	"[[",
	"{",
	"}",
	"case",
	"coproc",
	"declare",
	"do",
	"done",
	"elif",
	"else",
	"end",
	"esac",
	"export",
	"fi",
	"float",
	"for",
	"foreach",
	"function",
	"if",
	"integer",
	"local",
	"nocorrect",
	"readonly",
	"repeat",
	"select",
	"then",
	"time",
	"typeset",
	"until",
	"while",
];

/// zsh's precommand modifiers in its builtin table.
const PREFIXES: &[&str] = &["-", "builtin", "command", "exec", "noglob"];

/// `s` as zsh's `dupstring` of a possibly-`NULL` C string.
fn opt(s: Option<&BString>) -> &[u8] {
	s.map_or(&[][..], |s| s.as_slice())
}

/// zsh `rembslash` of a metafied string.
fn rembslash(s: &[u8]) -> BString {
	super::rembslash(s)
}

/// zsh `strpfx(s, t)`: `s` is a prefix of `t`.
fn strpfx(s: &[u8], t: &[u8]) -> bool {
	t.starts_with(s)
}

/// zsh `pfxlen(s, t)`: the length of the common prefix.
fn pfxlen(s: &[u8], t: &[u8]) -> usize {
	s.iter().zip(t).take_while(|(a, b)| a == b).count()
}

/// zsh `itok`.
const fn itok(c: u8) -> bool {
	tok::is_tok(c)
}

/// zsh `inull`.
const fn inull(c: u8) -> bool {
	tok::is_null(c)
}

/// zsh `isrelative`: a path not starting with `/`, or with a `.`/`..`
/// component.
fn isrelative(s: &[u8]) -> bool {
	if s.first() != Some(&b'/') {
		return true;
	}
	s.split(|&c| c == b'/').any(|p| p == b"." || p == b"..")
}

impl<'r, 'a, 'c> Gen<'r, 'a, 'c> {
	fn new(
		ctx: &'r mut Ctx<'a, 'c>,
		c: &'r mut Comp,
		defs: &State,
		calls: &'r [Option<Vec<BString>>],
		facts: &'r mut Vec<Option<ProbeResult>>,
	) -> Self {
		let cmdstr = c.tricky.cmdstr.clone();
		Self {
			ctx,
			c,
			ar: Arena::new(defs),
			calls,
			ncalls: 0,
			facts,
			nfacts: 0,
			errflag: false,
			curcc: DUMMY,
			ccstack: Vec::new(),
			brange: 0,
			erange: 0,
			ccont: 0,
			patcomp: None,
			filecomp: None,
			lpre: BString::default(),
			lsuf: BString::default(),
			rpre: BString::default(),
			rsuf: BString::default(),
			ppre: None,
			psuf: None,
			lppre: None,
			lpsuf: None,
			prpre: None,
			fpre: BString::default(),
			fsuf: BString::default(),
			qfpre: BString::default(),
			qfsuf: BString::default(),
			qrpre: BString::default(),
			qrsuf: BString::default(),
			qlpre: BString::default(),
			qlsuf: BString::default(),
			lpl: 0,
			lsl: 0,
			rpl: 0,
			rsl: 0,
			fpl: 0,
			fsl: 0,
			lppl: 0,
			lpsl: 0,
			noreal: false,
			ic: 0,
			addwhat: 0,
			cmdstr,
		}
	}

	// ---- services ------------------------------------------------------------

	/// Parameter and expansion code; `Err` of the inner result is a zsh
	/// error (zsh's `errflag`), not reported (zsh's `noerrs`).
	fn ex<T>(&mut self, f: impl FnOnce(&mut Expander<'_, '_>) -> X<T>) -> G<Result<T, Diag>> {
		Ok(zx(self.ctx, f)?)
	}

	/// An option.
	fn isset(&mut self, o: ZshOpt) -> G<bool> {
		Ok(self.ctx.zsh_option(o)?)
	}

	/// zsh `get_user_var`.
	fn get_user_var(&mut self, nam: &[u8]) -> G<Option<Vec<BString>>> {
		Ok(zx(self.ctx, |ex| compcore::get_user_var(ex, Some(nam)))?
			.ok()
			.flatten())
	}

	/// The next shell function call of the run: its `$reply`, or a stop
	/// to make it.
	fn call(&mut self, name: &[u8], args: Vec<BString>) -> G<Option<Vec<BString>>> {
		if let Some(r) = self.calls.get(self.ncalls) {
			self.ncalls += 1;
			return Ok(r.clone());
		}
		// The function sees `read -c`/`-l` (zsh `incompctlfunc`) unless
		// it is called from a completion function.
		if self.c.incompfunc != 1 {
			self.c.incompctlfunc = true;
		}
		self.c.tricky.cmdstr.clone_from(&self.cmdstr);
		Err(Halt::Call { name: name.into(), args })
	}

	/// The answer to file-system question `p`: from this run's facts, the
	/// builtin's probe cache, or asked now (the run stops only for an
	/// answer that is not there at once).
	fn ask(&mut self, p: Probe) -> G<ProbeResult> {
		let n = self.nfacts;
		self.nfacts += 1;
		if let Some(Some(r)) = self.facts.get(n) {
			return Ok(r.clone());
		}
		let r = match self.ctx.probe(p) {
			Ok(r) => r,
			Err(Need::Probe(p)) => {
				let mut sc = Scratch::default();
				match probe::perform_mut(self.ctx.k, self.ctx.cx, self.ctx.vp, &mut sc, &p) {
					Ok(r) => r,
					Err(_) => return Err(Halt::Need(Need::Probe(p))),
				}
			},
			Err(n) => return Err(Halt::Need(n)),
		};
		if self.facts.len() <= n {
			self.facts.resize(n + 1, None);
		}
		self.facts[n] = Some(r.clone());
		Ok(r)
	}

	/// A numbered file-system request.
	fn fs(&mut self, req: FsReq) -> G<Option<FsAns>> {
		let seq = u32::try_from(self.nfacts).unwrap_or(u32::MAX);
		Ok(match self.ask(Probe::Fs { seq, req: Box::new(req) })? {
			ProbeResult::Fs(Ok(a)) => Some(a),
			_ => None,
		})
	}

	/// A raw path relative to the shell's directory as the host sees it.
	fn abs(&self, path: &[u8]) -> BString {
		probe::absolute(&self.ctx.vp.cwd, path)
	}

	/// `stat` (`follow`) or `lstat` (raw path).
	fn stat_as(&mut self, path: &[u8], follow: bool) -> G<Option<Stat>> {
		let path = self.abs(path);
		Ok(match self.fs(FsReq::Stat { path, follow })? {
			Some(FsAns::Stat(st)) => Some(st),
			_ => None,
		})
	}

	/// `stat` (raw path).
	fn stat(&mut self, path: &[u8]) -> G<Option<Stat>> {
		self.stat_as(path, true)
	}

	/// `access(path, mode)` (raw path; mode bits 4 = execute, 0 =
	/// exists).
	fn access(&mut self, path: &[u8], mode: u8) -> G<bool> {
		let path = self.abs(path);
		Ok(matches!(self.fs(FsReq::Access { path, mode })?, Some(FsAns::Done)))
	}

	/// The entries of a directory (raw path), `None` when it cannot be
	/// opened.
	fn readdir(&mut self, path: &[u8]) -> G<Option<Vec<BString>>> {
		let path = self.abs(path);
		Ok(match self.fs(FsReq::ReadDir { path })? {
			Some(FsAns::Names(n)) => Some(n),
			_ => None,
		})
	}

	/// zsh `iscom`.
	fn iscom(&mut self, s: &[u8]) -> G<bool> {
		let us = unmetafy(s);
		Ok(self.access(&us, 4)? && self.stat(&us)?.is_some_and(|st| st.kind == StatKind::File))
	}

	/// zsh `patcompile(s, PAT_STATIC, NULL)` of a tokenized string.
	fn patcompile(&mut self, s: &[u8]) -> G<Option<Pat>> {
		Ok(self.ex(|ex| zpattern::compile(ex, s, PatFlags::NONE))?.ok())
	}

	/// zsh `pattry`.
	fn pattry(&mut self, p: &Pat, s: &[u8]) -> G<bool> {
		let p = Arc::clone(p);
		Ok(self.ex(|ex| zpattern::matches(ex, &p, s))?.unwrap_or(false))
	}

	/// zsh `quotename(s)` (`quotestring(s, instring or QT_BACKSLASH)`).
	fn quotename(&mut self, s: &[u8]) -> G<BString> {
		let (bang, bang_special) = crate::bash::vm::zsh::params::bang_quoting(
			&mut self.ctx.k.root,
			self.ctx.cx.store,
			self.ctx.vp,
		);
		let o = text::QuoteOpts {
			rcquotes: self.isset(ZshOpt::Rcquotes)?,
			magic_equal_subst: self.isset(ZshOpt::Magicequalsubst)?,
			extended_glob: self.isset(ZshOpt::Extendedglob)?,
			bang,
			bang_special,
			mb: crate::bash::vm::zsh::params::mb_quiet(self.ctx.k, self.ctx.cx.store, self.ctx.vp),
		};
		let ins = u8::try_from(self.c.tricky.instring).unwrap_or(qt::NONE);
		let q = if ins == qt::NONE { qt::BACKSLASH } else { ins };
		Ok(super::super::quotestring(s, q, o).into())
	}

	/// zsh `multiquote(s, ign)`.
	fn multiquote(&mut self, s: &[u8], ign: bool) -> G<BString> {
		let c = &*self.c;
		Ok(zx(self.ctx, |ex| Ok(compcore::multiquote(ex, c, s, ign)))?.unwrap_or_else(|_| s.into()))
	}

	/// zsh `tildequote(s, ign)`.
	fn tildequote(&mut self, s: &[u8], ign: bool) -> G<BString> {
		let c = &*self.c;
		Ok(zx(self.ctx, |ex| Ok(compcore::tildequote(ex, c, s, ign)))?.unwrap_or_else(|_| s.into()))
	}

	/// zsh `findcmd(arg0, docopy, 0)` (metafied).
	fn findcmd(&mut self, arg0: &[u8]) -> G<Option<BString>> {
		let raw = unmetafy(arg0);
		let mut cn: Option<BString> = match self.ctx.record(Key::CmdHash(BStr::new(&raw)))? {
			Some(Record::CmdHash { path, .. }) => Some(metafy(&path).into()),
			_ => None,
		};
		if cn.is_none() && self.isset(ZshOpt::Hashcmds)? && !isrelative(arg0) {
			cn = self.hashcmd(arg0)?;
		}
		if raw.len() > 4096 {
			return Ok(None);
		}
		if let Some(s) = arg0.find_byte(b'/') {
			if self.iscom(arg0)? {
				return Ok(Some(arg0.into()));
			}
			if s == 0
				|| !self.isset(ZshOpt::Pathdirs)?
				|| arg0.starts_with(b"./")
				|| arg0.starts_with(b"../")
			{
				return Ok(None);
			}
		}
		if let Some(nn) = cn
			&& self.iscom(&nn)?
		{
			return Ok(Some(nn));
		}
		for dir in self.path()? {
			let mut buf = dir;
			if !buf.is_empty() {
				buf.push(b'/');
			}
			buf.extend_from_slice(arg0);
			if self.iscom(&buf)? {
				return Ok(Some(buf));
			}
		}
		Ok(None)
	}

	/// zsh `hashcmd(arg0, path)`: the first executable `arg0` in an
	/// absolute `$path` entry, hashed.
	fn hashcmd(&mut self, arg0: &[u8]) -> G<Option<BString>> {
		for dir in self.path()? {
			if dir.first() != Some(&b'/') {
				continue;
			}
			let mut buf = dir;
			buf.push(b'/');
			buf.extend_from_slice(arg0);
			if self.iscom(&buf)? {
				let raw = unmetafy(&buf);
				self.ctx.store_record(
					KeyBuf::CmdHash(unmetafy(arg0).into()),
					Some(Record::CmdHash { path: raw.into(), hits: 0 }),
				);
				return Ok(Some(buf));
			}
		}
		Ok(None)
	}

	/// `$path` (metafied).
	fn path(&mut self) -> G<Vec<BString>> {
		Ok(self
			.ex(|ex| params::getaparam(ex, b"path"))?
			.ok()
			.flatten()
			.unwrap_or_default()
			.into_iter()
			.map(|p| BString::from(metafy(&p)))
			.collect())
	}

	/// zsh `cmdnamtab->filltable` (`fillcmdnamtable`): hash every command
	/// in the absolute `$path` directories not hashed yet.
	fn fillcmdnamtable(&mut self) -> G<()> {
		let hashexeconly = self.isset(ZshOpt::Hashexecutablesonly)?;
		for dir in self.path()? {
			if isrelative(&dir) {
				continue;
			}
			let udir = unmetafy(&dir);
			let Some(names) = self.readdir(&udir)? else {
				continue;
			};
			for fname in names {
				if self.ctx.record(Key::CmdHash(BStr::new(&fname)))?.is_some() {
					continue;
				}
				let mut p = udir.clone();
				p.push(b'/');
				p.extend_from_slice(&fname);
				let add = fname.len() > 4096
					|| !hashexeconly
					|| (self.access(&p, 4)?
						&& self
							.stat(&p)?
							.is_some_and(|st| st.kind == StatKind::File && st.mode & 0o111 != 0));
				if add {
					self.ctx.store_record(
						KeyBuf::CmdHash(fname),
						Some(Record::CmdHash { path: p.into(), hits: 0 }),
					);
				}
			}
		}
		Ok(())
	}

	/// The nodes of hash table `ht` (zsh's `ht->nodes` walk; names
	/// metafied).
	fn nodes(&mut self, ht: Ht) -> G<Vec<(BString, Hn)>> {
		let words = |ctx: &mut Ctx<'_, '_>, key: MiscKey| -> Result<Vec<BString>, Need> {
			Ok(match ctx.record(Key::Misc(key))? {
				Some(Record::Words(w)) => w,
				_ => Vec::new(),
			})
		};
		let m = |s: &[u8]| BString::from(metafy(s));
		let dis = |d: &[BString], n: &[u8]| {
			if d.iter().any(|x| x == n) {
				DISABLED
			} else {
				0
			}
		};
		let ctx = &mut *self.ctx;
		Ok(match ht {
			Ht::Cmdnam => vstate::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::CmdHash)
				.map_err(Need::from)?
				.into_iter()
				.filter_map(|(k, _)| match k {
					KeyBuf::CmdHash(n) => Some((m(&n), Hn::default())),
					_ => None,
				})
				.collect(),
			Ht::Alias => {
				let d = words(ctx, MiscKey::ZshDisabledAliases)?;
				let mut out = Vec::new();
				for (k, r) in
					vstate::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Alias).map_err(Need::from)?
				{
					if let (KeyBuf::Alias(n), Record::Alias(_)) = (k, r) {
						out.push((m(&n), Hn { flags: dis(&d, &n), ..Hn::default() }));
					}
				}
				for (k, r) in vstate::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::ZshAlias)
					.map_err(Need::from)?
				{
					if let (KeyBuf::ZshAlias { suffix: false, name }, Record::Alias(_)) = (k, r) {
						out.push((m(&name), Hn {
							flags: dis(&d, &name) | ALIAS_GLOBAL,
							..Hn::default()
						}));
					}
				}
				out
			},
			Ht::Reswd => {
				let d = words(ctx, MiscKey::ZshDisabledReswords)?;
				RESWDS
					.iter()
					.map(|r| (m(r.as_bytes()), Hn { flags: dis(&d, r.as_bytes()), ..Hn::default() }))
					.collect()
			},
			Ht::Shfunc => {
				let d = words(ctx, MiscKey::ZshDisabledFuncs)?;
				vstate::scan(&ctx.k.root, ctx.cx.store, ctx.vp, Table::Func)
					.map_err(Need::from)?
					.into_iter()
					.filter_map(|(k, _)| match k {
						KeyBuf::Func(n) => Some((m(&n), Hn { flags: dis(&d, &n), ..Hn::default() })),
						_ => None,
					})
					.collect()
			},
			Ht::Builtin => {
				let d = words(ctx, MiscKey::DisabledBuiltins)?;
				let mut out: Vec<(BString, Hn)> = PREFIXES
					.iter()
					.map(|p| (m(p.as_bytes()), Hn { flags: dis(&d, p.as_bytes()), ..Hn::default() }))
					.collect();
				use strum::IntoEnumIterator;
				for i in IntrinsicId::iter().filter(|i| i.available_in(Dialect::Zsh)) {
					if zsh_module::builtin_state(ctx.cx.store, ctx.vp, i)
						.map_err(Need::from)?
						.is_some()
					{
						let n: &str = i.into();
						out.push((m(n.as_bytes()), Hn { flags: dis(&d, n.as_bytes()), ..Hn::default() }));
					}
				}
				out
			},
			Ht::Param => {
				// zsh walks `paramtab` without fetching values: a module's
				// parameter (or its autoload stub) is listed with its flags,
				// without loading the module or computing it.
				let names = self.ex(params::scan_names)?.unwrap_or_default();
				let mut out = Vec::with_capacity(names.len());
				for n in names {
					if let Some(sp) = specials::lookup(&n)
						&& sp.module().is_some()
						&& !sp.is_plain()
						&& zsh_module::param_listed(self.ctx.cx.store, self.ctx.vp, &n)
							.map_err(Need::from)?
					{
						out.push((m(&n), Hn { flags: sp.flags().bits(), global: true, scalar: None }));
						continue;
					}
					let Some(p) = self.ex(|ex| params::getparam(ex, &n))?.ok().flatten() else {
						continue;
					};
					let scalar = match (&p.value, p.flags.type_bits()) {
						(PValue::Scalar(s), PmFlags::SCALAR) => Some(BString::from(metafy(s))),
						_ => None,
					};
					out.push((m(&n), Hn { flags: p.flags.bits(), global: p.scope.is_none(), scalar }));
				}
				out
			},
			Ht::Nameddir => match self.ex(nameddir::load)? {
				Ok(t) => t
					.entries()
					.map(|e| (m(e.name), Hn { flags: u32::from(e.flags), ..Hn::default() }))
					.collect(),
				Err(_) => Vec::new(),
			},
			Ht::Option => {
				use strum::VariantNames;
				ZshOpt::VARIANTS
					.iter()
					.chain(OPTION_ALIASES)
					.map(|n| (m(n.as_bytes()), Hn::default()))
					.collect()
			},
			Ht::Thingy => ctx.vp.zle.as_ref().map_or_default(|z| {
				z.widgets
					.iter()
					.map(|(n, _)| (m(n), Hn::default()))
					.collect()
			}),
		})
	}

	/// zsh `dumphashtable(ht, what)`.
	fn dumphashtable(&mut self, ht: Ht, what: i32) -> G<()> {
		self.addwhat = what;
		for (name, hn) in self.nodes(ht)? {
			self.addmatch(&name, Some(&hn))?;
		}
		Ok(())
	}

	/// zsh `maketildelist`: user names and named directories.
	fn maketildelist(&mut self) -> G<()> {
		if let Err(d) = self.ex(nameddir::fill)? {
			let _ = d;
		}
		let want = if self.addwhat == -1 {
			0
		} else {
			u32::from(ND_USERNAME)
		};
		for (name, hn) in self.nodes(Ht::Nameddir)? {
			if hn.flags & want == want {
				self.addmatch(&name, None)?;
			}
		}
		Ok(())
	}

	/// zsh `getreal`: `str` expanded (the first word), or as it is when
	/// that fails or gives nothing.
	fn getreal(&mut self, s: &[u8]) -> G<BString> {
		let r = self.ex(|ex| {
			let mut l = subst::List::one(s.to_vec());
			let mut rf = 0;
			subst::prefork(ex, &mut l, 0, &mut rf)?;
			Ok(l.nodes)
		})?;
		if let Ok(nodes) = r
			&& let Some(first) = nodes.first()
			&& !first.is_empty()
		{
			return Ok(first.clone().into());
		}
		Ok(s.into())
	}

	/// zsh `globlist` with `NULL_GLOB` of tokenized words: the words they
	/// give.
	fn globlist(&mut self, words: Vec<BString>) -> G<Vec<BString>> {
		let ng = self.isset(ZshOpt::Nullglob)?;
		if !ng {
			self.ctx.set_zsh_option(ZshOpt::Nullglob, true)?;
		}
		let globs: Vec<(u32, BString)> = words
			.iter()
			.enumerate()
			.map(|(i, w)| (u32::try_from(i).unwrap_or(u32::MAX), w.clone()))
			.collect();
		let mut items = words;
		let line = self.ctx.line;
		let r = zglob::expand_globs(self.ctx.k, self.ctx.vp, self.ctx.cx, &mut items, &globs, line);
		if !ng {
			self.ctx.set_zsh_option(ZshOpt::Nullglob, false)?;
		}
		match r {
			Ok(()) => Ok(items),
			Err(crate::bash::vm::exec::Flow::Block(key)) => Err(Halt::Need(Need::Park(key))),
			Err(_) => {
				self.errflag = true;
				Ok(Vec::new())
			},
		}
	}

	// ---- ccmakehookfn / makecomplistctl --------------------------------------

	/// zsh `ccmakehookfn`'s body: `dat->lst`.
	fn ccmakehookfn(&mut self, os: &[u8], incmd: i32) -> G<i32> {
		let onm = self.c.core.nmatches;
		let odm = self.c.core.diffmatches;
		// A copy of the global matchers.
		let gm: Vec<_> = state(self.ctx)?
			.gmatch
			.iter()
			.map(|s| {
				(
					s.clone(),
					compmatch::parse_cmatcher(None, s, &mut |_| {})
						.ok()
						.flatten(),
				)
			})
			.collect();
		for (_, m) in &gm {
			if let Some(m) = m {
				self.c.core.matchers.push(Arc::clone(m));
			}
		}
		let zmult = self
			.ctx
			.vp
			.zle
			.as_ref()
			.and_then(|z| z.ed.as_ref())
			.map_or(1, |e| e.zmod.mult);
		let mut mi = 0;
		loop {
			self.c.core.bmatchers = None;
			if let Some((s, m)) = gm.get(mi) {
				self.c.core.mstack = Some(Arc::new(super::super::types::Cmlist {
					next:    None,
					matcher: m.clone(),
					str:     s.clone(),
				}));
				compmatch::add_bmatchers(self.c, m.as_ref());
			} else {
				self.c.core.mstack = None;
			}
			self.c.core.ainfo = Some(Box::default());
			self.c.core.fainfo = Some(Box::default());
			if self.c.tricky.validlist == 0 {
				self.c.tricky.lastambig = 0;
			}
			self.c.core.amatches = None;
			self.c.core.mnum = 0;
			self.c.core.unambig_mnum = -1;
			self.c.core.isuf = None;
			self.c.core.insmnum = i32::try_from(zmult).unwrap_or(1);
			self.c.core.oldlist = 0;
			self.c.core.oldins = 0;
			compcore::begcmgroup(self.c, Some(b"default"), 0);
			self.c.tricky.menucmp = 0;
			self.c.core.menuacc = 0;
			self.c.core.newmatches = 0;
			self.c.core.onlyexpl = 0;
			self.ccstack.clear();
			self.makecomplistglobal(os, incmd, 0)?;
			compcore::endcmgroup(self.c, None);

			let c = &mut *self.c;
			if c.core.oldlist != 0 {
				c.core.nmatches = onm;
				c.core.diffmatches = odm;
				c.tricky.validlist = 1;
				c.core.amatches = c.core.lastmatches;
				c.core.lmatches = c.core.lastlmatches;
				if let Some(p) = c.core.pmatches.take() {
					compcore::freematches(c, Some(p), true);
					c.core.hasperm = 0;
				}
				return Ok(0);
			}
			if let Some(l) = c.core.lastmatches.take() {
				compcore::freematches(c, Some(l), true);
			}
			{
				let c = &mut *self.c;
				zx(self.ctx, |ex| Ok(compcore::permmatches(ex, c, 1)))?.ok();
			}
			let c = &mut *self.c;
			c.core.amatches = c.core.pmatches;
			c.core.lastpermmnum = c.core.permmnum;
			c.core.lastpermgnum = c.core.permgnum;
			c.core.lastmatches = c.core.pmatches;
			c.core.lastlmatches = c.core.lmatches;
			c.core.pmatches = None;
			c.core.hasperm = 0;
			c.core.hasoldlist = 1;
			if c.core.nmatches != 0 && !self.errflag {
				c.tricky.validlist = 1;
				return Ok(0);
			}
			mi += 1;
			if mi >= gm.len() {
				break;
			}
			self.errflag = false;
		}
		Ok(1)
	}

	/// zsh `makecomplistctl(flags)` (`compcall`).
	fn makecomplistctl(&mut self, flags: i32) -> G<i32> {
		let c = &mut *self.c;
		let ooffs = c.tricky.offs;
		let (str, lip, lp) = compcore::comp_str(&*c, false);
		let ow = c.tricky.clwords.clone();
		let on = c.tricky.clwnum;
		let op = c.tricky.clwpos;
		let ois = c.tricky.instring;
		let oib = c.tricky.inbackt;
		let oisuf = c.core.isuf.clone();
		let oqp = c.tricky.qipre.clone();
		let oqs = c.tricky.qisuf.clone();
		let oaq = c.tricky.autoq.clone();
		let os = self.cmdstr.clone();
		let qc = c
			.complete
			.compquote
			.as_ref()
			.and_then(|q| q.first().copied())
			.unwrap_or(0);
		if qc != 0 {
			if qc == b'`' {
				c.tricky.instring = i32::from(qt::NONE);
				c.tricky.inbackt = 0;
				c.tricky.autoq = Some(BString::default());
			} else {
				match qc {
					b'\'' => c.tricky.instring = i32::from(qt::SINGLE),
					b'"' => c.tricky.instring = i32::from(qt::DOUBLE),
					b'$' => c.tricky.instring = i32::from(qt::DOLLARS),
					_ => {},
				}
				c.tricky.inbackt = 0;
				let q = c.complete.compquote.clone().unwrap_or_default();
				let buf = if qc == b'$' { &q[1..] } else { &q[..] };
				c.tricky.autoq = Some(BString::from(&buf[..buf.len().min(2)]));
			}
		} else {
			c.tricky.instring = i32::from(qt::NONE);
			c.tricky.inbackt = 0;
			c.tricky.autoq = Some(BString::default());
		}
		c.tricky.qipre = Some(c.complete.compqiprefix.clone().unwrap_or_default());
		c.tricky.qisuf = Some(c.complete.compqisuffix.clone().unwrap_or_default());
		let mut isuf = c.complete.compisuffix.clone().unwrap_or_default().to_vec();
		compcore::ctokenize(&mut isuf);
		remnulargs(&mut isuf);
		c.core.isuf = Some(isuf.into());
		let words = c.complete.compwords.clone();
		c.tricky.clwnum = i32::try_from(words.len()).unwrap_or(0);
		c.tricky.clwpos = i32::try_from(c.complete.compcurrent - 1).unwrap_or(-1);
		self.cmdstr = words.first().cloned();
		c.tricky.clwords = words
			.iter()
			.map(|w| {
				let mut t = w.to_vec();
				tokenize(&mut t);
				remnulargs(&mut t);
				BString::from(t)
			})
			.collect();
		c.tricky.offs = lip + lp;
		c.incompfunc = 2;
		let clwpos = c.tricky.clwpos;
		let ret = self.makecomplistglobal(&str, i32::from(clwpos == 0), flags);
		let c = &mut *self.c;
		c.incompfunc = 1;
		c.core.isuf = oisuf;
		c.tricky.qipre = oqp;
		c.tricky.qisuf = oqs;
		c.tricky.instring = ois;
		c.tricky.inbackt = oib;
		c.tricky.autoq = oaq;
		c.tricky.offs = ooffs;
		self.cmdstr = os;
		c.tricky.clwords = ow;
		c.tricky.clwnum = on;
		c.tricky.clwpos = op;
		ret
	}

	// ---- which compctls
	// ---------------------------------------------------------

	/// zsh `makecomplistglobal`.
	fn makecomplistglobal(&mut self, os: &[u8], incmd: i32, flags: i32) -> G<i32> {
		self.ccont = cc2::CCCONT;
		self.ar.nodes[DUMMY].cc.suffix = None;
		let linwhat = self.c.core.linwhat;
		let mut cc = None;
		if linwhat == IN_ENV {
			if flags & CFN_DEFAULT == 0 {
				cc = Some(DEFAULT);
				self.c.tricky.keypm = None;
			}
		} else if linwhat == IN_MATH {
			if flags & CFN_DEFAULT == 0 {
				let insubscr = self.c.tricky.insubscr;
				let d = &mut self.ar.nodes[DUMMY].cc;
				if insubscr >= 2 {
					d.mask = 0;
					d.suffix = Some(BString::from(if insubscr == 2 { "]" } else { "" }));
				} else {
					d.mask = cc::PARAMS;
					self.c.tricky.keypm = None;
				}
				cc = Some(DUMMY);
			}
		} else if linwhat == IN_COND {
			if flags & CFN_DEFAULT == 0 {
				let t = &self.c.tricky;
				let s: BString = if t.clwpos > 0 {
					t.clwords
						.get(usize::try_from(t.clwpos - 1).unwrap_or(0))
						.cloned()
						.unwrap_or_default()
				} else {
					BString::default()
				};
				let mask = if s.as_slice() == b"-o" {
					cc::OPTIONS
				} else if (at(&s, 0) == b'-' && at(&s, 1) != 0 && at(&s, 2) == 0)
					|| s.as_slice() == b"-nt"
					|| s.as_slice() == b"-ot"
					|| s.as_slice() == b"-ef"
				{
					cc::FILES
				} else {
					cc::FILES | cc::PARAMS
				};
				self.ar.nodes[DUMMY].cc.mask = mask;
				cc = Some(DUMMY);
				self.c.tricky.keypm = None;
			}
		} else if self.c.tricky.linredir != 0 {
			if flags & CFN_DEFAULT == 0 {
				cc = Some(DEFAULT);
				self.c.tricky.keypm = None;
			}
		} else {
			self.c.tricky.keypm = None;
			return self.makecomplistcmd(os, incmd, flags);
		}
		if let Some(cc) = cc {
			if flags & CFN_FIRST == 0 {
				self.makecomplistcc(FIRST, os, incmd)?;
				if self.ccont & cc2::CCCONT == 0 {
					return Ok(0);
				}
			}
			self.makecomplistcc(cc, os, incmd)?;
			return Ok(1);
		}
		Ok(0)
	}

	/// zsh `makecomplistcmd`.
	fn makecomplistcmd(&mut self, os: &[u8], incmd: i32, flags: i32) -> G<i32> {
		let mut ret = 0;
		if flags & CFN_FIRST == 0 {
			self.makecomplistcc(FIRST, os, incmd)?;
			if self.ccont & cc2::CCCONT == 0 {
				return Ok(0);
			}
		}
		if self.cmdstr.is_some() {
			ret |= self.makecomplistpc(os, incmd)?;
			if self.ccont & cc2::CCCONT == 0 {
				return Ok(ret);
			}
		}
		if let Some(cs) = self.cmdstr.clone()
			&& cs.first() == Some(&EQUALS)
			&& let Some(p) = self.findcmd(&cs[1..])?
		{
			self.cmdstr = Some(p);
		}
		let found = if incmd != 0 {
			None
		} else {
			self.cmdstr.as_ref().and_then(|cs| {
				self.ar.tab.get(cs).copied().or_else(|| {
					let mut s = cs.to_vec();
					remlpaths(&mut s, 1)
						.then(|| self.ar.tab.get(s.as_slice()).copied())
						.flatten()
				})
			})
		};
		let cc = if incmd != 0 {
			COMPOS
		} else if let Some(id) = found {
			ret |= 1;
			id
		} else {
			if flags & CFN_DEFAULT != 0 {
				return Ok(ret);
			}
			DEFAULT
		};
		self.makecomplistcc(cc, os, incmd)?;
		Ok(ret)
	}

	/// zsh `makecomplistpc`: the pattern compctls.
	fn makecomplistpc(&mut self, os: &[u8], incmd: i32) -> G<i32> {
		let cs = self.cmdstr.clone().unwrap_or_default();
		let raw = unmetafy(&cs);
		let isfunc = self.ctx.function(&raw)?.is_some();
		let isbuiltin = self.nodes(Ht::Builtin)?.iter().any(|(n, _)| *n == cs);
		let s = if isfunc || isbuiltin {
			None
		} else {
			self.findcmd(&cs)?
		};
		let mut ret = 0;
		for (pat, id) in self.ar.pats.clone() {
			let Some(p) = self.patcompile(&pat)? else {
				continue;
			};
			let hit = self.pattry(&p, &cs)?
				|| (s.is_some() && self.pattry(&p, s.as_deref().map_or(&[][..], |s| s.as_slice()))?);
			if hit {
				self.makecomplistcc(id, os, incmd)?;
				ret |= 2;
				if self.ccont & cc2::CCCONT == 0 {
					return Ok(ret);
				}
			}
		}
		Ok(ret)
	}

	/// zsh `makecomplistcc`.
	fn makecomplistcc(&mut self, cc: Id, s: &[u8], incmd: i32) -> G<()> {
		self.ccont = 0;
		self.makecomplistor(cc, s, incmd, 0, false)
	}

	/// zsh `makecomplistor`: one run of `+`-alternatives.
	fn makecomplistor(&mut self, cc: Id, s: &[u8], incmd: i32, compadd: i32, sub: bool) -> G<()> {
		let mut um = self.c.tricky.usemenu;
		let mut cc = Some(cc);
		while let Some(start) = cc {
			let mn = self.c.core.mnum;
			let mut cur = Some(start);
			while let Some(id) = cur {
				if !sub {
					self.brange = 0;
					self.erange = self.c.tricky.clwnum - 1;
				}
				self.c.tricky.usemenu = 0;
				self.makecomplistlist(id, s, incmd, compadd)?;
				um |= self.c.tricky.usemenu;
				let ct = self.ar.nodes[id].cc.mask2 & cc2::XORCONT;
				cur = self.ar.nodes[id].xor;
				if !(cur.is_some() && ct != 0) {
					break;
				}
			}
			cc = cur;
			if mn != self.c.core.mnum {
				break;
			}
			if cc.is_some() {
				self.ccont &= !(cc2::DEFCONT | cc2::PATCONT);
				if !sub {
					self.ccont &= !cc2::CCCONT;
				}
			}
		}
		self.c.tricky.usemenu = um;
		Ok(())
	}

	/// zsh `makecomplistlist`.
	fn makecomplistlist(&mut self, cc: Id, s: &[u8], incmd: i32, compadd: i32) -> G<()> {
		let oloffs = self.c.tricky.offs;
		let owe = self.c.tricky.we;
		let owb = self.c.tricky.wb;
		let ocs = self.c.line.cs;
		if self.ar.nodes[cc].ext.is_empty() {
			self.makecomplistflags(cc, s, incmd, compadd)?;
		} else {
			self.makecomplistext(cc, s, incmd)?;
		}
		self.errflag = false;
		self.c.tricky.offs = oloffs;
		self.c.tricky.wb = owb;
		self.c.tricky.we = owe;
		self.c.line.cs = ocs;
		Ok(())
	}

	/// The word `os` untokenized, cut at the cursor under
	/// `COMPLETE_IN_WORD` (the `s`/`S`/`n`/`N` conditions).
	fn cond_word(&mut self, os: &[u8]) -> G<Vec<u8>> {
		let mut s = os.to_vec();
		untokenize(&mut s);
		if self.isset(ZshOpt::Completeinword)? {
			let offs = usize::try_from(self.c.tricky.offs).unwrap_or(0);
			s.truncate(offs);
		}
		Ok(s)
	}

	/// `clwords[i]` (empty out of range).
	fn clword(&self, i: i32) -> BString {
		usize::try_from(i)
			.ok()
			.and_then(|i| self.c.tricky.clwords.get(i))
			.cloned()
			.unwrap_or_default()
	}

	/// zsh `makecomplistext`: the `-x` patterns of `occ`.
	#[allow(clippy::too_many_lines, reason = "one function, as zsh's")]
	fn makecomplistext(&mut self, occ: Id, os: &[u8], incmd: i32) -> G<()> {
		let instring = u8::try_from(self.c.tricky.instring).unwrap_or(0);
		let ins = if instring != qt::NONE {
			instring
		} else if self.c.tricky.inbackt != 0 {
			qt::BACKTICK
		} else {
			0
		};
		let mut m = false;
		let mut d = false;
		for compc in self.ar.nodes[occ].ext.clone() {
			let mut compadd = 0;
			let mut t = false;
			self.brange = 0;
			self.erange = self.c.tricky.clwnum - 1;
			let conds = self.ar.nodes[compc].cond.clone();
			for ands in &conds {
				if t {
					break;
				}
				t = true;
				for cond in ands {
					if !t {
						break;
					}
					t = false;
					for arg in &cond.args {
						if t {
							break;
						}
						self.brange = 0;
						self.erange = self.c.tricky.clwnum - 1;
						let (clwpos, clwnum) = (self.c.tricky.clwpos, self.c.tricky.clwnum);
						match (cond.ty, arg) {
							(cct::QUOTE, Arg::Str(s)) => {
								t = (at(s, 0) == b's' && ins == qt::SINGLE)
									|| (at(s, 0) == b'd' && ins == qt::DOUBLE)
									|| (at(s, 0) == b'b' && ins == qt::BACKTICK);
							},
							(cct::POS | cct::NUMWORDS, Arg::Range(a, b)) => {
								let tt = if cond.ty == cct::POS { clwpos } else { clwnum };
								let a = if *a < 0 { a + clwnum } else { *a };
								let b = if *b < 0 { b + clwnum } else { *b };
								if cond.ty == cct::POS {
									self.brange = a;
									self.erange = b;
								}
								t = tt >= a && tt <= b;
							},
							(cct::CURSUF | cct::CURPRE, Arg::Str(sv)) => {
								let s = if clwpos < clwnum {
									self.cond_word(os)?
								} else {
									Vec::new()
								};
								let sc = rembslash(sv);
								if s.starts_with(&sc) {
									compadd = if cond.ty == cct::CURSUF {
										i32::try_from(sc.len()).unwrap_or(0)
									} else {
										0
									};
									t = true;
								}
							},
							(cct::CURSUB | cct::CURSUBC, Arg::Num(p, sv)) => {
								if clwpos < 0 || clwpos >= clwnum {
									t = false;
								} else {
									let s = self.cond_word(os)?;
									let a = getcpat(&s, *p, sv, cond.ty == cct::CURSUBC);
									if a != -1 {
										compadd = a;
										t = true;
									}
								}
							},
							(cct::CURPAT | cct::CURSTR | cct::WORDPAT | cct::WORDSTR, Arg::Num(p, sv)) => {
								let tt = if matches!(cond.ty, cct::CURPAT | cct::CURSTR) {
									clwpos
								} else {
									0
								};
								let mut a = tt + p;
								if a < 0 {
									a += clwnum;
								}
								let mut s = if a < 0 || a >= clwnum {
									Vec::new()
								} else {
									self.clword(a).to_vec()
								};
								untokenize(&mut s);
								if matches!(cond.ty, cct::CURPAT | cct::WORDPAT) {
									let mut ss = sv.to_vec();
									tokenize(&mut ss);
									t = match self.patcompile(&ss)? {
										Some(pp) => self.pattry(&pp, &s)?,
										None => false,
									};
								} else {
									t = s.as_slice() == rembslash(sv).as_slice();
								}
							},
							(cct::RANGESTR | cct::RANGEPAT, Arg::Pair(la, lb)) => {
								let pat_of = |g: &mut Self, x: &[u8]| -> G<Option<Pat>> {
									let mut sc = x.to_vec();
									tokenize(&mut sc);
									g.patcompile(&sc)
								};
								let hit = |g: &mut Self, x: &[u8], j: i32| -> G<bool> {
									let mut s = g.clword(j).to_vec();
									untokenize(&mut s);
									if cond.ty == cct::RANGESTR {
										Ok(s.starts_with(&rembslash(x)))
									} else {
										match pat_of(g, x)? {
											Some(p) => g.pattry(&p, &s),
											None => Ok(false),
										}
									}
								};
								let mut j = clwpos - 1;
								while j > 0 {
									if hit(self, la, j)? {
										self.brange = j + 1;
										t = true;
										break;
									}
									j -= 1;
								}
								if t && let Some(lb) = lb {
									j += 1;
									while j < clwnum {
										if hit(self, lb, j)? {
											self.erange = j - 1;
											t = clwpos <= self.erange;
											break;
										}
										j += 1;
									}
								}
							},
							_ => {},
						}
					}
				}
			}
			if t {
				m = true;
				self.ccont &= !(cc2::PATCONT | cc2::DEFCONT);
				self.makecomplistor(compc, os, incmd, compadd, true)?;
				if !d && self.ccont & cc2::DEFCONT != 0 {
					d = true;
					self.brange = 0;
					self.erange = self.c.tricky.clwnum - 1;
					self.makecomplistflags(occ, os, incmd, 0)?;
				}
				if self.ccont & cc2::PATCONT == 0 {
					break;
				}
			}
		}
		if !m {
			self.brange = 0;
			self.erange = self.c.tricky.clwnum - 1;
			self.makecomplistflags(occ, os, incmd, 0)?;
		}
		Ok(())
	}

	/// zsh `sep_comp_string(ss, s, noffs)` (`compctl -h`): complete the
	/// word as if `ss` were in front of it, split into words.
	#[allow(clippy::too_many_lines, reason = "one function, as zsh's")]
	fn sep_comp_string(&mut self, ss: &[u8], s: &[u8], noffs: i32) -> G<i32> {
		let owe = self.c.tricky.we;
		let owb = self.c.tricky.wb;
		let ocs = self.c.line.cs;
		let ois = self.c.tricky.instring;
		let oib = self.c.tricky.inbackt;
		let oaq = self.c.tricky.autoq.clone();
		let sl = ss.len();
		let noffs_u = usize::try_from(noffs).unwrap_or(0).min(s.len());
		// The text lexed: `ss`, a space, the word with an `x` at the cursor.
		let mut tmp = Vec::with_capacity(sl + 3 + s.len());
		tmp.extend_from_slice(ss);
		tmp.push(b' ');
		tmp.extend_from_slice(&s[..noffs_u]);
		let scs0 = sl + 1 + noffs_u;
		tmp.push(b'x');
		tmp.extend_from_slice(&s[noffs_u..]);
		let qstack = self.c.complete.compqstack.clone().unwrap_or_default();
		let remq = qstack.first() == Some(&qt::BACKSLASH);
		if remq {
			tmp = rembslash(&tmp).into();
		}
		let feat = mode::features(
			&mut self.ctx.k.root,
			self.ctx.cx.store,
			self.ctx.vp,
			crate::bash::syntax::Features::ZSH,
		)
		.map_err(Need::from)?;
		let mut wordlist: Vec<BString> = Vec::new();
		let mut got = false;
		let mut cur: i32 = -1;
		let mut i: i32 = 0;
		let (mut swb, mut swe, mut soffs) = (0i32, 0i32, 0i32);
		let mut ns: Option<Vec<u8>> = None;
		let scs_i = i32::try_from(scs0).unwrap_or(0);
		{
			let src = unmetafy(&tmp);
			let mut src = src;
			src.push(b' ');
			let z = ZleWords {
				zlemetacs: scs_i,
				zlemetall: i32::try_from(tmp.len()).unwrap_or(0),
				addedx:    1,
				wb:        0,
				we:        0,
				wordbeg:   0,
				parbegin:  -1,
				parend:    -1,
				inwhat:    0,
			};
			let mut lx = ZleLex::new(&src, feat, crate::bash::syntax::NO_ALIASES, true, z);
			loop {
				lx.ctxtlex();
				if lx.tok() == T::Lexerr {
					let Some(ts) = lx.tokstr().map(<[u8]>::to_vec) else {
						break;
					};
					let j = ts.iter().filter(|&&c| c == SNULL || c == DNULL).count();
					if j & 1 != 0 {
						lx.set_tok(T::String);
						let mut ts = ts;
						if ts.last() == Some(&b' ') {
							ts.pop();
						}
						lx.set_tokstr(Some(&ts));
					}
				}
				if matches!(lx.tok(), T::Endinput | T::Lexerr) {
					break;
				}
				let p = lx.tokstr().filter(|t| !t.is_empty()).map(<[u8]>::to_vec);
				if let Some(p) = &p {
					wordlist.push(p.clone().into());
				}
				if !got && lx.lexflags() & LEXFLAGS_ZLE == 0 {
					got = true;
					cur = i;
					swb = lx.z().wb - 1;
					swe = lx.z().we - 1;
					soffs = scs_i - swb;
					let mut p = p.unwrap_or_default();
					// zsh `chuck(p + soffs)`: drop the `x`.
					if let Ok(o) = usize::try_from(soffs)
						&& o < p.len()
					{
						p.remove(o);
					}
					ns = Some(p);
				}
				i += 1;
			}
		}
		self.c.tricky.wb = owb;
		self.c.tricky.we = owe;
		self.c.line.cs = ocs;
		if cur < 0 || i < 1 {
			return Ok(1);
		}
		let mut ns = ns.unwrap_or_default();
		let owb2 = self.c.tricky.offs;
		self.c.tricky.offs = soffs;
		let has_param = compcore::check_param(self.c, &mut ns.clone(), false, true).is_some();
		if has_param {
			for ch in &mut ns {
				if *ch == DNULL {
					*ch = b'"';
				} else if *ch == SNULL {
					*ch = b'\'';
				}
			}
		}
		self.c.tricky.offs = owb2;
		let mut ts = ns.clone();
		untokenize(&mut ts);
		if at(&ns, 0) == SNULL
			|| at(&ns, 0) == DNULL
			|| ((at(&ns, 0) == STRING || at(&ns, 0) == QSTRING) && at(&ns, 1) == SNULL)
		{
			let (nsoff, tsoff) = match at(&ns, 0) {
				SNULL => {
					self.c.tricky.instring = i32::from(qt::SINGLE);
					(0, 0)
				},
				DNULL => {
					self.c.tricky.instring = i32::from(qt::DOUBLE);
					(0, 0)
				},
				_ => {
					self.c.tricky.instring = i32::from(qt::DOLLARS);
					(1, 1)
				},
			};
			self.c.tricky.inbackt = 0;
			swb += 1;
			let nsptr = &ns[nsoff..];
			if nsptr.len() > 1 && nsptr.last() == nsptr.first() {
				swe -= 1;
			}
			let q = &ts[..(tsoff + 1).min(ts.len())];
			self.c.tricky.autoq = Some(if qstack.len() > 1 {
				BString::default()
			} else {
				self.multiquote(q, true)?
			});
			ts = ts[(tsoff + 1).min(ts.len())..].to_vec();
		} else {
			self.c.tricky.instring = i32::from(qt::NONE);
			self.c.tricky.autoq = Some(BString::default());
		}
		let mut scs = scs_i;
		let mut k = 0usize;
		let mut ii = swb;
		while k < ns.len() {
			let ch = ns[k];
			if inull(ch) {
				if ii < scs {
					soffs -= 1;
					if remq && ch == BNULL && k + 1 < ns.len() {
						swb -= 2;
					}
				}
				if k + 1 < ns.len() || ch != BNULL {
					if ch == BNULL {
						if scs == ii + 1 {
							scs += 1;
							soffs += 1;
						}
					} else {
						if scs > ii {
							scs -= 1;
						}
						ii -= 1;
					}
				} else if scs == swe {
					scs -= 1;
				}
				ns.remove(k);
				ii += 1;
				continue;
			}
			k += 1;
			ii += 1;
		}
		let mut ns = ts;
		if self.c.tricky.instring != i32::from(qt::NONE) && qstack.contains(&qt::BACKSLASH) {
			let rl = ns.len();
			let ql = self.multiquote(&ns, qstack.len() > 1)?.len();
			if ql > rl {
				swb -= i32::try_from(ql - rl).unwrap_or(0);
			}
		}
		let cut = usize::try_from(swb - i32::try_from(sl).unwrap_or(0) - 1)
			.unwrap_or(0)
			.min(s.len());
		let mut qp = opt(self.c.tricky.qipre.as_ref()).to_vec();
		qp.extend_from_slice(&self.multiquote(&s[..cut], false)?);
		if swe < swb {
			swe = swb;
		}
		swe -= i32::try_from(sl).unwrap_or(0) + 1;
		let slen = i32::try_from(s.len()).unwrap_or(0);
		if swe > slen {
			swe = slen;
			let lim = usize::try_from(swe - swb + 1).unwrap_or(0);
			if ns.len() > lim {
				ns.truncate(lim);
			}
		}
		let tail = &s[usize::try_from(swe).unwrap_or(0).min(s.len())..];
		let mut qs = self.multiquote(tail, false)?.to_vec();
		qs.extend_from_slice(opt(self.c.tricky.qisuf.as_ref()));
		let nsl = i32::try_from(ns.len()).unwrap_or(0);
		if soffs > nsl {
			soffs = nsl;
		}
		{
			let ow = std::mem::take(&mut self.c.tricky.clwords);
			let os = self.cmdstr.clone();
			let oqp = self.c.tricky.qipre.clone();
			let oqs = self.c.tricky.qisuf.clone();
			let oqst = self.c.complete.compqstack.clone();
			let olws = self.c.tricky.clwsize;
			let olwn = self.c.tricky.clwnum;
			let olwp = self.c.tricky.clwpos;
			let (obr, oer, oof) = (self.brange, self.erange, self.c.tricky.offs);
			let occ = self.ccont;
			let newq = if self.c.tricky.instring == i32::from(qt::NONE) {
				qt::BACKSLASH
			} else {
				u8::try_from(self.c.tricky.instring).unwrap_or(qt::BACKSLASH)
			};
			let mut nq = vec![newq];
			nq.extend_from_slice(&qstack);
			self.c.complete.compqstack = Some(nq.into());
			let words: Vec<BString> = wordlist
				.into_iter()
				.map(|w| {
					let mut w = w.to_vec();
					untokenize(&mut w);
					BString::from(w)
				})
				.collect();
			self.c.tricky.clwsize = i32::try_from(words.len()).unwrap_or(0);
			self.c.tricky.clwnum = self.c.tricky.clwsize;
			self.cmdstr = words.first().cloned();
			self.c.tricky.clwords = words;
			self.c.tricky.clwpos = cur;
			self.brange = 0;
			self.erange = self.c.tricky.clwnum - 1;
			self.c.tricky.qipre = Some(qp.into());
			self.c.tricky.qisuf = Some(qs.into());
			self.c.tricky.offs = soffs;
			self.ccont = cc2::CCCONT;
			let r = self.makecomplistcmd(&ns, i32::from(cur == 0), CFN_FIRST);
			self.ccont = occ;
			self.c.tricky.offs = oof;
			self.cmdstr = os;
			self.c.tricky.clwords = ow;
			self.c.tricky.clwsize = olws;
			self.c.tricky.clwnum = olwn;
			self.c.tricky.clwpos = olwp;
			self.brange = obr;
			self.erange = oer;
			self.c.tricky.qipre = oqp;
			self.c.tricky.qisuf = oqs;
			self.c.complete.compqstack = oqst;
			r?;
		}
		self.c.tricky.autoq = oaq;
		self.c.tricky.instring = ois;
		self.c.tricky.inbackt = oib;
		Ok(0)
	}

	// ---- makecomplistflags
	// ---------------------------------------------------------

	/// zsh `makecomplistflags`: the matches of the flags of `cc`.
	#[allow(clippy::too_many_lines, reason = "one function, as zsh's")]
	fn makecomplistflags(&mut self, cc0: Id, s0: &[u8], incmd0: i32, compadd: i32) -> G<()> {
		let mut incmd = incmd0;
		let um = self.c.tricky.usemenu;
		let mn = self.c.core.mnum;
		let ohp = self.c.core.haspattern;
		let os = s0.to_vec();
		let mut cc = cc0;

		self.ccont |= self.ar.nodes[cc].cc.mask2 & (cc2::CCCONT | cc2::DEFCONT | cc2::PATCONT);
		if self.c.incompfunc != 1 && self.ccstack.contains(&cc) {
			return Ok(());
		}
		self.ccstack.insert(0, cc);
		if self.c.incompfunc != 1
			&& let Some(g) = self.c.core.mgroup
			&& let Some(all) = self.c.groups.get_mut(g).lallccs.as_mut()
		{
			if all.contains(&cc) {
				self.ccstack.remove(0);
				return Ok(());
			}
			all.push(cc);
		}
		// Go to the end of the word unless completing inside it.
		if !self.isset(ZshOpt::Completeinword)?
			&& self.c.line.cs != usize::try_from(self.c.tricky.we).unwrap_or(0)
		{
			self.c.line.cs = usize::try_from(self.c.tricky.we).unwrap_or(0);
			self.c.tricky.offs = i32::try_from(s0.len()).unwrap_or(0);
		}
		let mut s = s0.to_vec();
		let mut delit = false;
		self.c.core.ispattern = 0;
		self.c.tricky.usemenu = um;
		self.patcomp = None;
		self.filecomp = None;
		self.ppre = None;
		self.psuf = None;
		self.lppre = None;
		self.lpsuf = None;
		self.prpre = None;
		self.c.core.ipre = None;
		self.c.core.ripre = None;
		self.curcc = cc;
		self.c.core.mflags = 0;
		let n = self.ar.nodes[cc].cc.clone();
		let gflags = (if n.mask2 & cc2::NOSORT != 0 {
			cgf::NOSORT
		} else {
			0
		}) | (if n.mask2 & cc2::UNIQALL != 0 {
			cgf::UNIQALL
		} else {
			0
		}) | (if n.mask2 & cc2::UNIQCON != 0 {
			cgf::UNIQCON
		} else {
			0
		});
		if let Some(gn) = &n.gname {
			compcore::endcmgroup(self.c, None);
			compcore::begcmgroup(self.c, Some(gn.as_slice()), gflags);
		}
		if n.ylist.is_some() {
			compcore::endcmgroup(self.c, None);
			compcore::begcmgroup(self.c, None, gflags);
		}
		if n.mask & cc::REMOVE != 0 {
			self.c.core.mflags |= i32::try_from(cmf::REMOVE).unwrap_or(0);
		}
		compcore::set_curexpl(self.c, n.explain.is_some().then(Cexpl::default));
		// `compadd` characters at the start of the word are ignored.
		if compadd != 0 {
			let ca = usize::try_from(compadd).unwrap_or(0).min(s.len());
			let mut ipre = s[..ca].to_vec();
			untokenize(&mut ipre);
			self.c.core.ipre = Some(ipre.into());
			self.c.tricky.wb += compadd;
			s.drain(..ca);
			self.c.tricky.offs -= compadd;
			if self.c.tricky.offs < 0 {
				self.ccstack.remove(0);
				return Ok(());
			}
		}
		let matcher = n.mstr.as_ref().and_then(|m| {
			compmatch::parse_cmatcher(None, m, &mut |_| {})
				.ok()
				.flatten()
		});
		let saved_mstack = self.c.core.mstack.clone();
		if let Some(m) = &matcher {
			self.c.core.mstack = Some(Arc::new(super::super::types::Cmlist {
				next:    self.c.core.mstack.clone(),
				matcher: Some(Arc::clone(m)),
				str:     n.mstr.clone().unwrap_or_default(),
			}));
			if self.c.core.mnum == 0 {
				compmatch::add_bmatchers(self.c, Some(m));
			}
			self.c.core.matchers.push(Arc::clone(m));
		}
		if self.c.core.mnum != 0 && (self.c.core.mstack.is_some() || self.c.core.bmatchers.is_some())
		{
			compmatch::update_bmatchers(self.c);
		}
		let mut sd: Option<Vec<u8>> = None;
		// The prefix (`-P`) already on the line.
		if let Some(pfx) = &n.prefix
			&& !s.is_empty()
		{
			let dp = rembslash(pfx);
			let mut d = s.clone();
			untokenize(&mut d);
			let pl = pfxlen(&dp, &d);
			s.drain(..pl.min(s.len()));
			d.drain(..pl.min(d.len()));
			sd = Some(d);
			self.c.tricky.offs -= i32::try_from(pl).unwrap_or(0);
		}
		// A suffix (`-S`) already there is not added again.
		if let Some(sfx) = &n.suffix {
			let mut sdup = rembslash(sfx).to_vec();
			while sdup.last() == Some(&b' ') {
				sdup.pop();
			}
			let sl = sdup.len();
			let d = sd.get_or_insert_with(|| {
				let mut d = s.clone();
				untokenize(&mut d);
				d
			});
			let suffixll = d.len();
			let offs = usize::try_from(self.c.tricky.offs).unwrap_or(0);
			if !d.is_empty()
				&& suffixll >= sl
				&& offs <= suffixll - sl
				&& d[suffixll - sl..] == sdup[..]
			{
				s.truncate(suffixll - sl);
			}
		}
		// `~` or `=` at the start.
		self.ic = 0;
		if self.c.incompfunc == 0 {
			let c0 = at(&s, 0);
			if c0 == TILDE || c0 == EQUALS {
				self.ic = c0;
			}
		}
		// A parameter name to complete.
		if self.c.incompfunc == 0
			&& let Some(p) = compcore::check_param(self.c, &mut s, true, false)
		{
			s.drain(..p.min(s.len()));
			cc = DUMMY;
			self.ar.nodes[DUMMY].cc.mask = cc::PARAMS | cc::ENVVARS;
		}
		let n = self.ar.nodes[cc].cc.clone();
		let ooffs = self.c.tricky.offs;
		if n.mask & cc::DELETE != 0 {
			delit = true;
			s.clear();
			self.c.tricky.offs = 0;
			if self.isset(ZshOpt::Automenu)? {
				self.c.tricky.usemenu = 1;
			}
		}

		// The prefix and suffix on the line.
		let offs = usize::try_from(self.c.tricky.offs)
			.unwrap_or(0)
			.min(s.len());
		self.lpl = i32::try_from(offs).unwrap_or(0);
		let mut lpre = s[..offs].to_vec();
		if self.c.complete.comppatmatch.is_some() {
			for ch in &mut lpre {
				if *ch == DASH {
					*ch = b'-';
				}
			}
		}
		self.qlpre = self.quotename(&lpre)?;
		let lsuf = s[offs..].to_vec();
		self.lsl = i32::try_from(lsuf.len()).unwrap_or(0);
		self.qlsuf = self.quotename(&lsuf)?;

		// `~…/…` is a path.
		if self.ic == TILDE && lpre.contains(&b'/') {
			self.ic = 0;
		}
		// The real (expanded) prefix and suffix.
		self.noreal = !delit;
		let has_exp = |x: &[u8]| x.iter().any(|&c| c == STRING || c == TICK);
		let tt: Vec<u8> = if self.ic != 0 && self.c.core.ispar == 0 {
			lpre.get(1..).unwrap_or_default().to_vec()
		} else {
			lpre.clone()
		};
		let mut rpre: Vec<u8> = if has_exp(&lpre) || at(&lpre, 0) == TILDE || at(&lpre, 0) == EQUALS {
			self.noreal = false;
			self.getreal(&tt)?.into()
		} else {
			tt
		};
		self.qrpre = self.quotename(&rpre)?;
		let mut rsuf: Vec<u8> = if has_exp(&lsuf) {
			self.noreal = false;
			self.getreal(&lsuf)?.into()
		} else {
			lsuf.clone()
		};
		self.qrsuf = self.quotename(&rsuf)?;

		// Is the word a pattern?
		let mut s1: Option<usize> = None;
		let mut sf1 = 0;
		let mut ispattern = 0;
		self.rpl = i32::try_from(rpre.len()).unwrap_or(0);
		let mut p = rpre.len();
		while p > 0 && (ispattern != 3 || sf1 == 0) {
			p -= 1;
			let ch = rpre[p];
			if itok(ch) && (p > 0 || (ch != EQUALS && ch != TILDE)) {
				ispattern |= if sf1 != 0 { 1 } else { 2 };
			} else if ch == b'/' {
				sf1 += 1;
				if s1.is_none() {
					s1 = Some(p);
				}
			}
		}
		self.rsl = i32::try_from(rsuf.len()).unwrap_or(0);
		let mut s2: Option<usize> = None;
		let mut sf2 = 0;
		let mut t = 0;
		for (k, &ch) in rsuf.iter().enumerate() {
			if t != 0 && sf2 != 0 {
				break;
			}
			if itok(ch) {
				t |= if sf2 != 0 { 4 } else { 2 };
			} else if ch == b'/' {
				sf2 += 1;
				if s2.is_none() {
					s2 = Some(k);
				}
			}
		}
		ispattern |= t;
		let comppatmatch = self.c.complete.comppatmatch.clone();
		let cpm = comppatmatch.as_ref().and_then(|c| c.first().copied());
		if cpm.is_none() {
			ispattern = 0;
		}
		self.c.core.ispattern = ispattern;
		if ispattern != 0 {
			let mut p = rpre.clone();
			if !rpre.is_empty() && rpre.last() != Some(&STAR) && cpm == Some(b'*') {
				p.push(STAR);
			}
			p.extend_from_slice(&rsuf);
			self.patcomp = self.patcompile(&p)?;
			self.c.core.haspattern = 1;
		}
		if self.patcomp.is_none() {
			untokenize(&mut rpre);
			untokenize(&mut rsuf);
			self.rpl = i32::try_from(rpre.len()).unwrap_or(0);
			self.rsl = i32::try_from(rsuf.len()).unwrap_or(0);
		} else {
			for ch in rpre.iter_mut().chain(rsuf.iter_mut()) {
				if *ch == DASH {
					*ch = b'-';
				}
			}
		}
		untokenize(&mut lpre);
		let mut lsuf = lsuf;
		untokenize(&mut lsuf);
		self.lpre = lpre.clone().into();
		self.lsuf = lsuf.clone().into();
		self.rpre = rpre.clone().into();
		self.rsuf = rsuf.clone().into();

		if n.mask & cc::DELETE == 0 {
			self.c.core.hasmatched = 1;
		}

		// Files.
		if n.mask & (cc::FILES | cc::DIRS | cc::COMMPATH) != 0 || n.glob.is_some() {
			let s1i = s1.unwrap_or(0);
			let s1_is_rpre = s1.is_none();
			let s2i = s2.unwrap_or(rsuf.len());
			let ppre: Vec<u8> = if at(&rpre, s1i) == b'/' {
				rpre[..=s1i].to_vec()
			} else {
				Vec::new()
			};
			let psuf: Vec<u8> = rsuf[s2i..].to_vec();
			self.ppre = Some(ppre.clone().into());
			self.psuf = Some(psuf.clone().into());
			let cs = self.c.line.cs;
			let wb = usize::try_from(self.c.tricky.wb).unwrap_or(0);
			let we = usize::try_from(self.c.tricky.we).unwrap_or(0);
			if cs == wb {
				self.lppre = None;
				self.lppl = 0;
			} else {
				let line = self.c.line.bytes().to_vec();
				let qipre = opt(self.c.tricky.qipre.as_ref()).to_vec();
				let skip = if qipre.is_empty() {
					0
				} else {
					qipre.len() - usize::from(matches!(qipre[0], b'\'' | b'"'))
				};
				let from = (wb + skip).min(line.len());
				let mut lp = line[from..cs.min(line.len()).max(from)].to_vec();
				for bp in &self.c.tricky.brbeg {
					let q = usize::try_from(bp.qpos).unwrap_or(0);
					let l = bp.str.len();
					if q + l <= lp.len() {
						lp.drain(q..q + l);
					}
				}
				if let Some(slash) = lp.rfind_byte(b'/') {
					lp.truncate(slash + 1);
					self.lppl = i32::try_from(lp.len()).unwrap_or(0);
					self.lppre = Some(lp.into());
				} else if sf1 == 0 {
					self.lppre = None;
					self.lppl = 0;
				} else {
					self.lppl = i32::try_from(ppre.len()).unwrap_or(0);
					self.lppre = Some(ppre.clone().into());
				}
			}
			if cs == we {
				self.lpsuf = None;
				self.lpsl = 0;
			} else {
				let line = self.c.line.bytes().to_vec();
				let mut end = we;
				let qisuf = opt(self.c.tricky.qisuf.as_ref()).to_vec();
				if !qisuf.is_empty() {
					let ql = qisuf.len();
					end -= ql - usize::from(matches!(qisuf[ql - 1], b'\'' | b'"'));
				}
				let mut ls =
					line[cs.min(line.len())..end.min(line.len()).max(cs.min(line.len()))].to_vec();
				for bp in &self.c.tricky.brend {
					let q = usize::try_from(bp.qpos).unwrap_or(0);
					let l = bp.str.len();
					let p2 = (we - cs).saturating_sub(q);
					if p2 >= l && p2 <= ls.len() {
						ls.drain(p2 - l..p2);
					}
				}
				self.lpsuf = match ls.find_byte(b'/') {
					Some(sl) => Some(ls[sl..].to_vec().into()),
					None if sf2 != 0 => Some(psuf.into()),
					None => None,
				};
				self.lpsl = self
					.lpsuf
					.as_ref()
					.map_or(0, |l| i32::try_from(l.len()).unwrap_or(0));
			}
			// The file prefix.
			let s_slash = at(&s, 0) == b'/';
			let fpre_from = if (s1_is_rpre || s1i == 0 || self.ic != 0) && (!s_slash || cs == wb) {
				if s1_is_rpre { 0 } else { s1i }
			} else {
				s1i + 1
			};
			let mut fpre = rpre[fpre_from.min(rpre.len())..].to_vec();
			self.qfpre = self.quotename(&fpre)?;
			let mut fsuf = rsuf[..s2i].to_vec();
			self.qfsuf = self.quotename(&fsuf)?;
			if cpm.is_some() && ispattern & 2 != 0 {
				let mut p = fpre.clone();
				if (p.is_empty() || p.last() != Some(&STAR))
					&& at(&fsuf, 0) != STAR
					&& cpm == Some(b'*')
				{
					p.push(STAR);
				}
				p.extend_from_slice(&fsuf);
				self.filecomp = self.patcompile(&p)?;
			}
			if self.filecomp.is_none() {
				untokenize(&mut fpre);
				untokenize(&mut fsuf);
				self.fpl = i32::try_from(fpre.len()).unwrap_or(0);
				self.fsl = i32::try_from(fsuf.len()).unwrap_or(0);
			}
			self.fpre = fpre.into();
			self.fsuf = fsuf.into();
			self.addwhat = -1;

			if self.ic == TILDE {
				let oi = self.c.core.ipre.clone();
				let mut ni = b"~".to_vec();
				ni.extend_from_slice(opt(oi.as_ref()));
				self.c.core.ipre = Some(ni.into());
				self.maketildelist()?;
				self.c.core.ipre = oi;
			} else if self.ic == EQUALS {
				let oi = self.c.core.ipre.clone();
				let mut ni = b"=".to_vec();
				ni.extend_from_slice(opt(oi.as_ref()));
				self.c.core.ipre = Some(ni.into());
				if self.isset(ZshOpt::Hashlistall)? {
					self.fillcmdnamtable()?;
				}
				self.dumphashtable(Ht::Cmdnam, -7)?;
				self.dumphashtable(Ht::Alias, -2)?;
				self.c.core.ipre = oi;
			} else if ispattern & 1 != 0 {
				// A pattern: glob it.
				self.addwhat = 0;
				let mut p = lpre.clone();
				if at(&lsuf, 0) != b'*' && !lpre.is_empty() && lpre.last() != Some(&b'*') {
					p.push(b'*');
				}
				p.extend_from_slice(&lsuf);
				if !lsuf.is_empty() && !matches!(lsuf.last(), Some(b'*' | b')')) {
					p.push(b'*');
				}
				tokenize(&mut p);
				remnulargs(&mut p);
				let found = self.globlist(vec![p.into()])?;
				if !found.is_empty() {
					self.c.core.mflags |= i32::try_from(cmf::FILE).unwrap_or(0);
					for w in found {
						self.addmatch(&w, None)?;
					}
					self.c.core.mflags &= !i32::try_from(cmf::FILE).unwrap_or(0);
				}
			} else {
				self.addwhat = i32::try_from(cc::FILES).unwrap_or(0);
				let dirs: Option<Vec<BString>> = if let Some(withd) = &n.withd
					&& let Some(pp) = self.get_user_var(withd)?
				{
					Some(
						pp.into_iter()
							.map(|d| {
								let mut tp = d.to_vec();
								tp.push(b'/');
								tp.extend_from_slice(&ppre);
								BString::from(tp)
							})
							.collect(),
					)
				} else {
					None
				};
				let dirs = dirs.unwrap_or_else(|| {
					vec![match &n.withd {
						Some(w) => {
							let mut tp = w.to_vec();
							tp.push(b'/');
							tp.extend_from_slice(&ppre);
							tp.into()
						},
						None => ppre.clone().into(),
					}]
				});
				for dir in dirs {
					self.prpre = Some(dir);
					if sf2 != 0 {
						self.gen_matches_files(true, false, false)?;
					} else {
						if n.mask & cc::FILES != 0 {
							self.gen_matches_files(false, false, true)?;
						} else if n.mask & cc::COMMPATH != 0 {
							if sf1 != 0 || n.withd.is_some() {
								self.gen_matches_files(true, true, false)?;
							} else {
								// Commands reachable through `.` in `$path`.
								let pp = self.prpre.clone();
								if self
									.path()?
									.iter()
									.any(|p| p.is_empty() || p.as_slice() == b".")
								{
									self.prpre = Some(BString::from("./"));
									self.gen_matches_files(true, true, false)?;
									self.prpre = pp;
								}
							}
						} else if n.mask & cc::DIRS != 0 {
							self.gen_matches_files(true, false, false)?;
						}
						if let Some(glob) = &n.glob {
							self.glob_matches(&n, glob, sf1, ispattern)?;
						}
					}
				}
				self.prpre = None;
			}
			self.lppre = None;
			self.lpsuf = None;
			self.lppl = 0;
			self.lpsl = 0;
		}
		if self.ic != 0 {
			let ch: &[u8] = if self.ic == TILDE { b"~" } else { b"=" };
			let mut r = ch.to_vec();
			r.extend_from_slice(&self.rpre);
			self.rpre = r.into();
			self.rpl += 1;
			let mut q = ch.to_vec();
			q.extend_from_slice(&self.qrpre);
			self.qrpre = q.into();
		}
		if self.ic == 0
			&& n.mask & cc::COMMPATH != 0
			&& opt(self.ppre.as_ref()).is_empty()
			&& opt(self.psuf.as_ref()).is_empty()
		{
			// Command names: aliases, reserved words, functions, builtins,
			// external commands.
			self.dumphashtable(Ht::Alias, -3)?;
			self.dumphashtable(Ht::Reswd, -3)?;
			self.dumphashtable(Ht::Shfunc, -3)?;
			self.dumphashtable(Ht::Builtin, -3)?;
			if self.isset(ZshOpt::Hashlistall)? {
				self.fillcmdnamtable()?;
			}
			self.dumphashtable(Ht::Cmdnam, -3)?;
			if self.isset(ZshOpt::Autocd)? && self.isset(ZshOpt::Cdablevars)? {
				self.dumphashtable(Ht::Param, -4)?;
			}
		}
		let oaw = if n.mask & cc::QUOTEFLAG != 0 {
			-2
		} else {
			i32::try_from(cc::QUOTEFLAG).unwrap_or(0)
		};
		self.addwhat = oaw;
		if n.mask & cc::NAMED != 0 {
			self.dumphashtable(Ht::Nameddir, self.addwhat)?;
		}
		if n.mask & cc::OPTIONS != 0 {
			self.dumphashtable(Ht::Option, self.addwhat)?;
		}
		if n.mask & cc::VARS != 0 {
			self.dumphashtable(Ht::Param, -9)?;
			self.addwhat = oaw;
		}
		if n.mask & cc::BINDINGS != 0 {
			self.dumphashtable(Ht::Thingy, i32::try_from(cc::BINDINGS).unwrap_or(0))?;
			self.addwhat = oaw;
		}
		if let Some(kv) = &n.keyvar
			&& let Some(usr) = self.get_user_var(kv)?
		{
			for u in usr {
				self.addmatch(&u, None)?;
			}
		}
		if n.mask & cc::USERS != 0 {
			self.maketildelist()?;
			self.addwhat = oaw;
		}
		if let Some(func) = &n.func {
			let raw = unmetafy(func);
			if self.ctx.function(&raw)?.is_some() {
				let mut args: Vec<BString> = Vec::new();
				if delit {
					let k = usize::try_from(ooffs).unwrap_or(0).min(os.len());
					let mut a = os[..k].to_vec();
					untokenize(&mut a);
					args.push(unmetafy(&a).into());
					let mut b = os[k..].to_vec();
					untokenize(&mut b);
					args.push(unmetafy(&b).into());
				} else {
					args.push(unmetafy(&self.lpre).into());
					args.push(unmetafy(&self.lsuf).into());
				}
				if let Some(r) = self.call(&raw, args)? {
					for w in r {
						self.addmatch(&metafy(&w), None)?;
					}
				}
			}
		}
		if n.mask & (cc::JOBS | cc::RUNNING | cc::STOPPED) != 0 {
			let jobs: Vec<(BString, bool)> = self
				.ctx
				.vp
				.jobs
				.iter()
				.filter(|j| {
					!matches!(j.state, crate::bash::store::JobState::Done(_)) && !j.text.is_empty()
				})
				.map(|j| {
					(
						BString::from(metafy(&j.text)),
						matches!(j.state, crate::bash::store::JobState::Stopped(_)),
					)
				})
				.collect();
			for (j, stopped) in jobs {
				if n.mask & cc::JOBS != 0
					|| (stopped && n.mask & cc::STOPPED != 0)
					|| (!stopped && n.mask & cc::RUNNING != 0)
				{
					self.addmatch(&j, None)?;
				}
			}
		}
		if let Some(str) = &n.str {
			self.str_matches(str)?;
		}
		if let Some(hpat) = &n.hpat {
			self.hist_matches(hpat, n.hnum)?;
		}
		let t = n.mask
			& (cc::ARRAYS
				| cc::INTVARS
				| cc::ENVVARS
				| cc::SCALARS
				| cc::READONLYS
				| cc::SPECIALS
				| cc::PARAMS);
		if t != 0 {
			self.dumphashtable(Ht::Param, i32::try_from(t).unwrap_or(0))?;
		}
		let cmds = n.mask & (cc::DISCMDS | cc::EXCMDS);
		for (bit, ht) in [
			(cc::SHFUNCS, Ht::Shfunc),
			(cc::BUILTINS, Ht::Builtin),
			(cc::EXTCMDS, Ht::Cmdnam),
			(cc::RESWDS, Ht::Reswd),
			(cc::ALREG | cc::ALGLOB, Ht::Alias),
		] {
			let t = n.mask & bit;
			if t != 0 {
				if ht == Ht::Cmdnam && self.isset(ZshOpt::Hashlistall)? {
					self.fillcmdnamtable()?;
				}
				self.dumphashtable(ht, i32::try_from(t | cmds).unwrap_or(0))?;
			}
		}
		if let Some(kp) = self.c.tricky.keypm.clone()
			&& cc == DUMMY
		{
			// The keys of the association being subscripted.
			let keys = self
				.ex(|ex| params::getparam(ex, &unmetafy(&kp)))?
				.ok()
				.flatten();
			if let Some(p) = keys
				&& let PValue::Hash(kv) = p.value
			{
				for (k, _) in kv {
					self.addmatch(&metafy(&k), None)?;
				}
			}
			self.c.tricky.keypm = None;
			self.ar.nodes[DUMMY].cc.suffix = None;
		}
		if !self.errflag && n.ylist.is_some() {
			let ylist = n.ylist.clone().unwrap_or_default();
			let mut uv: Option<Vec<u8>> = None;
			if matches!(at(&ylist, 0), b'$' | b'(') {
				uv = Some(ylist[usize::from(ylist[0] == b'$')..].to_vec());
			} else if self.ctx.function(&unmetafy(&ylist))?.is_some() {
				let mut args: Vec<BString> = Vec::new();
				if let Some(g) = self.c.core.mgroup {
					for m in &self.c.groups.get(g).lmatches {
						let mut p = opt(m.ppre.as_ref()).to_vec();
						if m.ppre.is_some() {
							p.extend_from_slice(&m.str);
							p.extend_from_slice(opt(m.psuf.as_ref()));
						} else {
							p = m.str.to_vec();
						}
						args.push(unmetafy(&p).into());
					}
				}
				self.call(&unmetafy(&ylist), args)?;
				uv = Some(b"reply".to_vec());
			}
			let yaptr = match &uv {
				Some(u) => self.get_user_var(u)?,
				None => None,
			};
			if let Some(tt) = &n.explain {
				let tt = self.explain_str(&n, tt)?;
				if let Some(e) = compcore::curexpl_mut(self.c) {
					e.str = tt;
				}
				if let Some(gn) = &n.gname {
					compcore::endcmgroup(self.c, yaptr);
					compcore::begcmgroup(self.c, Some(gn.as_slice()), gflags);
					compcore::addexpl(self.c, false);
				} else {
					compcore::addexpl(self.c, false);
					compcore::endcmgroup(self.c, yaptr);
					compcore::begcmgroup(self.c, Some(b"default"), 0);
				}
			} else {
				compcore::endcmgroup(self.c, yaptr);
				compcore::begcmgroup(self.c, Some(b"default"), 0);
			}
		} else if let Some(tt) = &n.explain {
			let tt = self.explain_str(&n, tt)?;
			if let Some(e) = compcore::curexpl_mut(self.c) {
				e.str = tt;
			}
			compcore::addexpl(self.c, false);
		}
		if let Some(sub) = &n.subcmd {
			self.subcmd_matches(sub, &s, &mut incmd)?;
		}
		if let Some(ss) = &n.substr {
			let offs = self.c.tricky.offs;
			self.sep_comp_string(ss, &s, offs)?;
		}
		self.ccstack.remove(0);
		if matcher.is_some() {
			self.c.core.mstack = saved_mstack;
		}
		if mn == self.c.core.mnum {
			self.c.core.haspattern = ohp;
		}
		Ok(())
	}

	/// The `-X`/`-Y` explanation: `-Y` expanded.
	fn explain_str(&mut self, n: &Cc, tt: &[u8]) -> G<BString> {
		if n.mask & cc::EXPANDEXPL != 0
			&& let Ok(p) = parsestr(tt)
		{
			let r = self.ex(|ex| subst::singsub(ex, p))?;
			if let Ok(mut v) = r {
				untokenize(&mut v);
				return Ok(v.into());
			}
		}
		Ok(tt.into())
	}

	/// The `-g` patterns of a compctl, globbed in directory `prpre`.
	fn glob_matches(&mut self, n: &Cc, glob: &[u8], sf1: i32, ispattern: i32) -> G<()> {
		let prpre = opt(self.prpre.as_ref()).to_vec();
		let pl = prpre.len();
		let md = self.isset(ZshOpt::Markdirs)?;
		if md {
			self.ctx.set_zsh_option(ZshOpt::Markdirs, false)?;
		}
		let r = self.glob_matches_in(n, glob, sf1, ispattern, &prpre, pl);
		if md {
			self.ctx.set_zsh_option(ZshOpt::Markdirs, true)?;
		}
		r
	}

	fn glob_matches_in(
		&mut self,
		n: &Cc,
		glob: &[u8],
		sf1: i32,
		_ispattern: i32,
		prpre: &[u8],
		pl: usize,
	) -> G<()> {
		self.addwhat = -6;
		let equals = self.isset(ZshOpt::Equals)?;
		let blank = |c: u8| c == b' ' || c == b'\t';
		let mut g = 0;
		while g < glob.len() {
			while g < glob.len() && blank(glob[g]) {
				g += 1;
			}
			if g >= glob.len() {
				break;
			}
			let mut p = g + 1;
			while p < glob.len() && !blank(glob[p]) {
				if glob[p] == b'\\' && p + 1 < glob.len() {
					p += 1;
				}
				p += 1;
			}
			let mut pat = glob[g..p.min(glob.len())].to_vec();
			tokenize(&mut pat);
			if at(&pat, 0) == b'=' && equals {
				pat[0] = EQUALS;
			}
			if at(&pat, 0) == b'~' {
				pat[0] = TILDE;
			}
			remnulargs(&mut pat);
			let special = matches!(at(&pat, 0), EQUALS | TILDE);
			let word: Vec<u8> = if special && n.withd.is_none() {
				let mut w = pat.clone();
				let r = self.ex(|ex| {
					subst::filesub(ex, &mut w, 0)?;
					Ok(w)
				})?;
				r.unwrap_or_else(|_| pat.clone())
			} else if at(&pat, 0) == b'/' && n.withd.is_none() {
				pat.clone()
			} else {
				let mut pa = prpre.to_vec();
				pa.extend_from_slice(&pat);
				pa
			};
			let found = self.globlist(vec![word.into()])?;
			if let Some(first) = found.first()
				&& !first.iter().any(|&c| itok(c))
			{
				if matches!(at(&pat, 0), EQUALS | TILDE | b'/') || n.withd.is_some() {
					for p2 in found {
						if strpfx(prpre, &p2) {
							self.addmatch(&p2[pl..], None)?;
						}
					}
				} else {
					for p2 in found {
						let mut k = 0;
						let mut ns = sf1;
						while k < p2.len() && ns != 0 {
							if p2[k] == b'/' {
								ns -= 1;
							}
							k += 1;
						}
						self.addmatch(&p2[k..], None)?;
					}
				}
			}
			g = p;
		}
		Ok(())
	}

	/// The words of `compctl -s`: `str` lexed as arguments, expanded and
	/// globbed.
	fn str_matches(&mut self, str: &[u8]) -> G<()> {
		let mut wordlist: Vec<Vec<u8>> = Vec::new();
		let feat = mode::features(
			&mut self.ctx.k.root,
			self.ctx.cx.store,
			self.ctx.vp,
			crate::bash::syntax::Features::ZSH,
		)
		.map_err(Need::from)?;
		let mut src = b"foo ".to_vec();
		src.extend_from_slice(&unmetafy(str));
		let z = ZleWords {
			zlemetacs: i32::try_from(self.c.line.cs).unwrap_or(0),
			zlemetall: i32::try_from(self.c.line.ll()).unwrap_or(0),
			addedx:    0,
			wb:        self.c.tricky.wb,
			we:        self.c.tricky.we,
			wordbeg:   0,
			parbegin:  -1,
			parend:    -1,
			inwhat:    0,
		};
		{
			let mut lx = ZleLex::new(&src, feat, crate::bash::syntax::NO_ALIASES, true, z);
			let mut first = true;
			loop {
				lx.ctxtlex();
				if matches!(lx.tok(), T::Endinput | T::Lexerr) {
					break;
				}
				if !first && let Some(t) = lx.tokstr().filter(|t| !t.is_empty()) {
					wordlist.push(t.to_vec());
				}
				first = false;
			}
		}
		let r = self.ex(|ex| {
			let mut l = subst::List { nodes: wordlist, array: false };
			let mut rf = 0;
			subst::prefork(ex, &mut l, 0, &mut rf)?;
			Ok(l.nodes)
		})?;
		if let Ok(words) = r {
			let words: Vec<BString> = words.into_iter().map(BString::from).collect();
			let globbed = self.globlist(words)?;
			if !self.errflag {
				for w in globbed {
					self.addmatch(&w, None)?;
				}
			}
		} else {
			self.errflag = true;
		}
		Ok(())
	}

	/// The words of the history matching `compctl -H num pattern`.
	fn hist_matches(&mut self, hpat: &[u8], hnum: i32) -> G<()> {
		let pprogc = if hpat.is_empty() {
			None
		} else {
			let mut t = hpat.to_vec();
			tokenize(&mut t);
			self.patcompile(&t)?
		};
		let h = {
			let ctx = &mut *self.ctx;
			zhist::load(&ctx.k.root, ctx.cx.store, ctx.vp).map_err(Need::from)?
		};
		let start = h.addhistnum(h.st.curhist, -1, HIST_FOREIGN);
		let Some(top) = h.gethistent(start, -1) else {
			return Ok(());
		};
		let mut n: i64 = if hnum == 0 { -1 } else { i64::from(hnum) };
		let mut i = top;
		loop {
			if n == 0 {
				break;
			}
			n -= 1;
			let text = metafy(h.text_at(i));
			let words = h.words_at(i).into_owned();
			let raw = h.text_at(i).to_vec();
			for w in words.chunks(2).rev() {
				let (a, b) = (w[0] as usize, w[1] as usize);
				let word = metafy(raw.get(a..b.min(raw.len())).unwrap_or_default());
				let _ = &text;
				if !matches!(at(&word, 0), b'\'' | b'"' | b'`' | b'$') {
					let ok = match &pprogc {
						Some(p) => self.pattry(p, &word)?,
						None => true,
					};
					if ok {
						self.addmatch(&word, None)?;
					}
				}
			}
			if i == 0 {
				break;
			}
			i -= 1;
		}
		Ok(())
	}

	/// `compctl -l cmd`: complete the words in the range as the command
	/// line of `cmd` (or of their first word).
	fn subcmd_matches(&mut self, sub: &[u8], s: &[u8], incmd: &mut i32) -> G<()> {
		let ow = self.c.tricky.clwords.clone();
		let os = self.cmdstr.clone();
		let oldn = self.c.tricky.clwnum;
		let oldp = self.c.tricky.clwpos;
		let occ = self.ccont;
		self.ccont = cc2::CCCONT;
		let clwnum = self.c.tricky.clwnum;
		self.brange = self.brange.min(clwnum - 1).max(1);
		self.erange = self.erange.min(clwnum - 1).max(1);
		self.c.tricky.clwnum = self.erange - self.brange + 1;
		self.c.tricky.clwpos -= self.brange;
		let br = usize::try_from(self.brange).unwrap_or(1);
		if sub.is_empty() {
			self.cmdstr = ow.get(br).cloned();
			*incmd = i32::from(self.c.tricky.clwpos == 0);
			self.c.tricky.clwords = ow.get(br..).map_or_default(<[BString]>::to_vec);
		} else {
			self.c.tricky.clwpos += 1;
			self.c.tricky.clwnum += 1;
			*incmd = 0;
			let mut w = ow.get(br - 1..).map_or_default(<[BString]>::to_vec);
			if let Some(first) = w.first_mut() {
				*first = sub.into();
			}
			self.cmdstr = Some(sub.into());
			self.c.tricky.clwords = w;
		}
		let r = self.makecomplistcmd(s, *incmd, CFN_FIRST);
		self.c.tricky.clwords = ow;
		self.cmdstr = os;
		self.c.tricky.clwnum = oldn;
		self.c.tricky.clwpos = oldp;
		self.ccont = occ;
		r.map(|_| ())
	}

	// ---- gen_matches_files
	// ------------------------------------------------------

	/// zsh `gen_matches_files(dirs, execs, all)`: the files of directory
	/// `prpre` (all, or directories and/or executables).
	fn gen_matches_files(&mut self, mut dirs: bool, mut execs: bool, mut all: bool) -> G<()> {
		let aw = self.addwhat;
		let psuf = opt(self.psuf.as_ref()).to_vec();
		let mut ns = false;
		if !psuf.is_empty() {
			let q = *psuf.last().expect("not empty");
			ns = !(q == STAR || q == OUTPAR);
			dirs = true;
			all = false;
			execs = false;
		}
		let pathpref = self
			.prpre
			.as_ref()
			.filter(|p| !p.is_empty())
			.map(|p| unmetafy(p));
		if pathpref.as_ref().is_some_and(|p| p.len() > 4096) {
			return Ok(());
		}
		let dir: Vec<u8> = pathpref.clone().unwrap_or_else(|| b".".to_vec());
		let Some(names) = self.readdir(&dir)? else {
			self.addwhat = aw;
			return Ok(());
		};
		let globdots = self.isset(ZshOpt::Globdots)?;
		let comppatmatch = self.c.complete.comppatmatch.clone();
		let cpm = comppatmatch.as_ref().and_then(|c| c.first().copied());
		for raw in names {
			if self.errflag {
				break;
			}
			let n = metafy(&raw);
			if !(n.first() != Some(&b'.') || at(&self.fpre, 0) == b'.' || globdots) {
				continue;
			}
			self.addwhat = if execs { -8 } else { -5 };
			let test = if let Some(fc) = self.filecomp.clone() {
				self.pattry(&fc, &n)?
			} else {
				let fsl = usize::try_from(self.fsl).unwrap_or(0);
				let fpl = usize::try_from(self.fpl).unwrap_or(0);
				let mut t = n.len() >= fsl && n.starts_with(&self.fpre[..fpl.min(self.fpre.len())]);
				if t {
					t = n[n.len() - fsl..] == self.fsuf[..];
				}
				if !t && self.c.core.mstack.is_some() {
					self.addwhat = i32::try_from(cc::FILES).unwrap_or(0);
					true
				} else {
					t
				}
			};
			if !test {
				continue;
			}
			let mut p: Vec<u8> = pathpref.clone().unwrap_or_default();
			let mut st: Option<Stat> = None;
			if !all {
				if raw.len() + p.len() + 1 > 4096 {
					continue;
				}
				p.extend_from_slice(&raw);
				st = self.stat(&p)?;
				if st.is_none() {
					continue;
				}
			}
			let ok = all
				|| st.as_ref().is_some_and(|st| {
					(dirs && st.kind == StatKind::Dir)
						|| (execs && st.kind == StatKind::File && st.mode & 0o111 != 0)
				});
			if !ok {
				continue;
			}
			if psuf.is_empty() {
				self.addmatch(&n, None)?;
				continue;
			}
			// A path suffix: the file is a match when the path goes on.
			if p.len() + psuf.len() > 4096 {
				continue;
			}
			let mut full = metafy(&p);
			full.extend_from_slice(&psuf);
			let tt = if self.c.core.ispattern != 0 || (ns && cpm.is_some()) {
				if ns && cpm == Some(b'*') {
					full.push(STAR);
				}
				remnulargs(&mut full);
				!self.globlist(vec![full.into()])?.is_empty()
			} else {
				self.access(&unmetafy(&full), 0)?
			};
			if tt {
				self.addmatch(&n, None)?;
			}
		}
		self.addwhat = aw;
		Ok(())
	}

	// ---- addmatch ------------------------------------------------------------

	/// zsh `addmatch(s, t)`: add `s` (metafied) if it matches the word;
	/// `hn` is the hash node it came from.
	#[allow(clippy::too_many_lines, reason = "one function, as zsh's")]
	fn addmatch(&mut self, s: &[u8], hn: Option<&Hn>) -> G<()> {
		let aw = self.addwhat;
		let quoteflag = i32::try_from(cc::QUOTEFLAG).unwrap_or(0);
		for bp in self
			.c
			.tricky
			.brbeg
			.iter_mut()
			.chain(self.c.tricky.brend.iter_mut())
		{
			bp.curpos = if aw == quoteflag { bp.qpos } else { bp.pos };
		}
		let mut isfile = 0;
		let mut isalt = false;
		let mut isexact = 0;
		let mut lc: Option<Cl> = None;
		// Brace cursors: indices into `brbeg`/`brend` (the length is zsh's
		// `NULL`).
		let mut bpl: usize = 0;
		let mut bsl: usize = 0;
		let files_like = aw == -1
			|| aw == -5
			|| aw == -6
			|| aw == i32::try_from(cc::FILES).unwrap_or(0)
			|| aw == -7
			|| aw == -8;
		let ms: Option<BString>;
		if files_like {
			let ppl = opt(self.ppre.as_ref()).len();
			let psl = opt(self.psuf.as_ref()).len();
			let adv = |list: &[super::super::types::Brinfo], mut i: usize, lim: usize| {
				while i < list.len() && usize::try_from(list[i].curpos).unwrap_or(0) < lim {
					i += 1;
				}
				i
			};
			bpl = adv(&self.c.tricky.brbeg, bpl, ppl);
			bsl = adv(&self.c.tricky.brend, bsl, psl);
			if (aw == i32::try_from(cc::FILES).unwrap_or(0) || aw == -5)
				&& opt(self.psuf.as_ref()).is_empty()
			{
				// The fignore check.
				let fignore = self
					.ex(|ex| params::getaparam(ex, b"fignore"))?
					.ok()
					.flatten()
					.unwrap_or_default();
				for f in fignore {
					let f = metafy(&f);
					if f.len() < s.len() && s.ends_with(&f) {
						isalt = true;
						break;
					}
				}
			}
			let filelike =
				aw == i32::try_from(cc::FILES).unwrap_or(0) || aw == -6 || aw == -5 || aw == -8;
			let (p, sf, qu) = if filelike {
				let qfpre = self.qfpre.clone();
				let qfsuf = self.qfsuf.clone();
				(
					self.tildequote(&qfpre, true)?,
					self.multiquote(&qfsuf, true)?,
					if opt(self.ppre.as_ref()).is_empty() {
						2
					} else {
						1
					},
				)
			} else {
				let fpre = self.fpre.clone();
				let fsuf = self.fsuf.clone();
				(self.multiquote(&fpre, true)?, self.multiquote(&fsuf, true)?, 0)
			};
			let fc = self.filecomp.clone();
			let (bcp, bcs) = (i32::try_from(ppl).unwrap_or(0), i32::try_from(psl).unwrap_or(0));
			ms = self.comp_match(
				&p,
				&sf,
				s,
				fc.as_deref(),
				&mut lc,
				qu,
				(&mut bpl, bcp),
				(&mut bsl, bcs),
				&mut isexact,
			)?;
			if ms.is_none() {
				return Ok(());
			}
			if aw == -7 && self.findcmd(s)?.is_none() {
				return Ok(());
			}
			isfile = cmf::FILE;
		} else {
			let hn = hn.cloned().unwrap_or_default();
			let pm = |b: PmFlags| hn.flags & b.bits() != 0;
			let unset = pm(PmFlags::UNSET);
			let aw_u = u32::try_from(aw).unwrap_or(0);
			let ok = aw == quoteflag
				|| aw == -2
				|| (aw == -3 && hn.flags & DISABLED == 0)
				|| (aw == -4
					&& hn.scalar.is_some()
					&& hn.global
					&& hn.scalar.as_ref().is_some_and(|v| v.first() == Some(&b'/')))
				|| (aw == -9 && !unset && hn.global)
				|| (aw > 0
					&& ((!unset
						&& ((aw_u & cc::ARRAYS != 0 && pm(PmFlags::ARRAY))
							|| (aw_u & cc::INTVARS != 0 && pm(PmFlags::INTEGER))
							|| (aw_u & cc::ENVVARS != 0 && pm(PmFlags::EXPORTED))
							|| (aw_u & cc::SCALARS != 0 && pm(PmFlags::SCALAR))
							|| (aw_u & cc::READONLYS != 0 && pm(PmFlags::READONLY))
							|| (aw_u & cc::SPECIALS != 0 && pm(PmFlags::SPECIAL))
							|| (aw_u & cc::PARAMS != 0 && !pm(PmFlags::EXPORTED)))
						&& hn.global)
						|| ((aw_u & cc::SHFUNCS != 0
							|| aw_u & cc::BUILTINS != 0
							|| aw_u & cc::EXTCMDS != 0
							|| aw_u & cc::RESWDS != 0
							|| (aw_u & cc::ALREG != 0 && hn.flags & ALIAS_GLOBAL == 0)
							|| (aw_u & cc::ALGLOB != 0 && hn.flags & ALIAS_GLOBAL != 0))
							&& ((aw_u & cc::DISCMDS != 0 && hn.flags & DISABLED != 0)
								|| (aw_u & cc::EXCMDS != 0 && hn.flags & DISABLED == 0)))
						|| (aw_u & cc::BINDINGS != 0 && hn.flags & DISABLED == 0)));
			if !ok {
				return Ok(());
			}
			let (p1, s1, p2, s2) = if aw == quoteflag {
				(self.qrpre.clone(), self.qrsuf.clone(), self.rpre.clone(), self.rsuf.clone())
			} else {
				(self.qlpre.clone(), self.qlsuf.clone(), self.lpre.clone(), self.lsuf.clone())
			};
			let p1 = self.multiquote(&p1, true)?;
			let s1 = self.multiquote(&s1, true)?;
			let p2 = self.multiquote(&p2, true)?;
			let s2 = self.multiquote(&s2, true)?;
			let (bpt, bst) = (bpl, bsl);
			let qu = i32::from(aw == quoteflag);
			let pc = self.patcomp.clone();
			let len = |x: &BString| i32::try_from(x.len()).unwrap_or(0);
			let (l1, ls1, l2, ls2) = (len(&p1), len(&s1), len(&p2), len(&s2));
			let mut r = self.comp_match(
				&p1,
				&s1,
				s,
				pc.as_deref(),
				&mut lc,
				qu,
				(&mut bpl, l1),
				(&mut bsl, ls1),
				&mut isexact,
			)?;
			if r.is_none() {
				bpl = bpt;
				bsl = bst;
				r = self.comp_match(
					&p2,
					&s2,
					s,
					None,
					&mut lc,
					qu,
					(&mut bpl, l2),
					(&mut bsl, ls2),
					&mut isexact,
				)?;
				if r.is_none() {
					return Ok(());
				}
			}
			ms = r;
		}
		let Some(ms) = ms else {
			return Ok(());
		};
		let cur = &self.ar.nodes[self.curcc].cc;
		let pre = cur.prefix.clone();
		let suf = cur.suffix.clone();
		let ipre = self.c.core.ipre.clone();
		let ripre = self.c.core.ripre.clone();
		let isuf = self.c.core.isuf.clone();
		let flags = u32::try_from(self.c.core.mflags).unwrap_or(0) | isfile;
		if flags & cmf::FILE != 0 && !s.is_empty() && s.last() != Some(&b'/') {
			self.ztat(s)?;
		}
		let prpre = self.prpre.clone();
		let (lppre, lpsuf) = if isfile != 0 {
			(self.lppre.clone(), self.lpsuf.clone())
		} else {
			(None, None)
		};
		compcore::add_match_data(
			self.c,
			isalt,
			&ms,
			s,
			lc,
			sl(ipre.as_ref()),
			sl(ripre.as_ref()),
			sl(isuf.as_ref()),
			sl(pre.as_ref()),
			sl(prpre.as_ref()),
			sl(lppre.as_ref()),
			None,
			sl(lpsuf.as_ref()),
			None,
			sl(suf.as_ref()),
			flags,
			isexact,
		);
		Ok(())
	}

	/// zsh `comp_match` (`bpl`/`bsl`: the brace cursors with their
	/// offsets).
	#[allow(clippy::too_many_arguments, reason = "zsh's comp_match")]
	fn comp_match(
		&mut self,
		pfx: &[u8],
		sfx: &[u8],
		w: &[u8],
		cp: Option<&Pattern>,
		clp: &mut Option<Cl>,
		qu: i32,
		bp: (&mut usize, i32),
		bs: (&mut usize, i32),
		exact: &mut i32,
	) -> G<Option<BString>> {
		let c = &mut *self.c;
		let (bpl, bcp) = bp;
		let (bsl, bcs) = bs;
		Ok(zx(self.ctx, |ex| {
			let env = if cp.is_some() {
				Some(zpattern::char_env(ex)?)
			} else {
				None
			};
			let cp = cp.zip(env.as_ref()).map(|(p, env)| (p, env.env()));
			Ok(compmatch::comp_match(ex, c, pfx, Some(sfx), w, cp, clp, qu, bpl, bcp, bsl, bcs, exact))
		})?
		.ok()
		.flatten())
	}

	/// zsh's `ztat` of a file match for `add_match_data` (`LIST_TYPES`):
	/// the `lstat` and `stat` modes of `prpre`/`./` + `s`, put in the
	/// completion state's cache. An empty `prpre` is `./`, as the lookup
	/// in `add_match_data` takes it; keyed apart, no match found its type.
	fn ztat(&mut self, s: &[u8]) -> G<()> {
		let mut key = self
			.prpre
			.as_ref()
			.filter(|p| !p.is_empty())
			.map_or_else(|| b"./".to_vec(), |p| p.to_vec());
		key.extend_from_slice(s);
		if self.c.core.ztat_cache.contains_key(key.as_slice()) {
			return Ok(());
		}
		let raw = unmetafy(&key);
		let l = self.stat_as(&raw, false)?.map(|st| st_mode(&st));
		let f = self.stat(&raw)?.map(|st| st_mode(&st));
		self.c.core.ztat_cache.insert(key.into(), (l, f));
		Ok(())
	}
}

/// A C string argument that may be `NULL`.
fn sl(s: Option<&BString>) -> Option<&[u8]> {
	s.map(|v| v.as_slice())
}

/// The `st_mode` of `st` (type bits and permissions).
const fn st_mode(st: &Stat) -> u32 {
	let ty = match st.kind {
		StatKind::File => 0o100_000,
		StatKind::Dir => 0o040_000,
		StatKind::Symlink => 0o120_000,
		StatKind::Fifo => 0o010_000,
		StatKind::Socket => 0o140_000,
		StatKind::CharDev => 0o020_000,
		StatKind::BlockDev => 0o060_000,
	};
	ty | (st.mode & 0o7777)
}

/// zsh `remlpaths(&s, count)`: `s` becomes its last `count` path
/// components (trailing slashes dropped); `false` when it has no `/`.
fn remlpaths(s: &mut Vec<u8>, count: i32) -> bool {
	let mut count = count;
	let mut end = s.len();
	if end > 0 && s[end - 1] == b'/' {
		while end > 0 && s[end - 1] == b'/' {
			end -= 1;
		}
		s.truncate(end);
	}
	let mut i = s.len();
	loop {
		while i > 0 {
			i -= 1;
			if s[i] == b'/' {
				count -= 1;
				if count > 0 {
					if i > 0 {
						break;
					}
					return true;
				}
				*s = s[i + 1..].to_vec();
				return true;
			}
		}
		while i > 0 && s[i - 1] == b'/' {
			i -= 1;
		}
		if i == 0 {
			break;
		}
	}
	false
}

/// zsh `getcpat(str, cpatindex, cpat, class)` (the `n`/`N` conditions):
/// where the `cpatindex`-th occurrence of `cpat` (a character of it,
/// `class`) ends in `str`, from the end when negative; -1 when absent.
fn getcpat(str: &[u8], cpatindex: i32, cpat: &[u8], class: bool) -> i32 {
	if str.is_empty() {
		return -1;
	}
	let cpat = rembslash(cpat);
	let mut idx = cpatindex;
	let d = idx < 0;
	if idx == 0 {
		idx = 1;
	} else if d {
		idx = -idx;
	}
	let n = str.len();
	let mut order: Box<dyn Iterator<Item = usize>> = if d {
		Box::new((0..n).rev())
	} else {
		Box::new(0..n)
	};
	for s in &mut order {
		let mut t = s;
		let mut matched = true;
		let mut pi = 0;
		while t < n && pi < cpat.len() {
			if class {
				if cpat[pi] == str[s] {
					idx -= 1;
					if idx == 0 {
						return i32::try_from(s + 1).unwrap_or(-1);
					}
				}
			} else {
				if str[t] != cpat[pi] {
					matched = false;
					break;
				}
				t += 1;
			}
			pi += 1;
		}
		if !class && matched && pi == cpat.len() {
			idx -= 1;
			if idx == 0 {
				return i32::try_from(t).unwrap_or(-1);
			}
		}
	}
	-1
}
