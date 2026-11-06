//! The zsh pattern compiler: zsh 5.9 `pattern.c` `patcompile` and its
//! recursive descent (`patcompswitch` for alternatives and exclusions,
//! `patcompbranch` for a sequence, `patcomppiece` for one piece with its
//! closure, `patcompnot` for `^`/`!( )`, `patgetglobflags` for `(#…)`),
//! emitting the node program of [`super::prog`] with zsh's linking
//! primitives (`patnode`, `patinsert`, `pattail`, `patoptail`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use super::{
	BadPattern, Opts, PatFlags, ZPC_COUNT, ZPC_HASH, ZPC_HAT, ZPC_INANG, ZPC_INPAR, ZPC_KSH_AT,
	ZPC_KSH_BANG, ZPC_KSH_BANG2, ZPC_KSH_PLUS, ZPC_KSH_QUEST, ZPC_KSH_STAR, ZPC_NO_KSH_GLOB,
	ZPC_SEG_COUNT, ZPC_SLASH, ZPC_TILDE,
	class::{self, SetItem},
	mbchar::metacharinc,
	prog::*,
	token::remnulargs,
};
use crate::bash::syntax::zsh::tok::{
	BANG, BAR, BNULLKEEP, COMMA, DASH, HAT, INANG, INBRACK, INPAR, MARKER, META, NULARG, OUTANG,
	OUTBRACK, OUTPAR, POUND, QUEST, STAR, TILDE, head, is_tok, span, tail, tok_char, unmetafy,
};

/// zsh's special pattern characters, indexed by `ZPC_*` (zsh `zpc_chars`).
const ZPC_CHARS: [u8; ZPC_COUNT] = [
	b'/', 0, BAR, OUTPAR, TILDE, INPAR, QUEST, STAR, INBRACK, INANG, HAT, POUND, BNULLKEEP, QUEST,
	STAR, b'+', BANG, b'!', b'@',
];

/// The globbing flags a file glob threads from one path segment to the
/// next (zsh's `patglobflags` between `patcompile` calls of one glob):
/// `(#i)` at the end of `(#i)dir/` applies to the following segments.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileGlobState(u32);

impl FileGlobState {
	/// zsh `patcompstart`: the state before the first segment of a glob,
	/// case-insensitive without `CASE_GLOB` and `CASE_PATHS`.
	pub const fn start(opts: &Opts) -> Self {
		let mut f = if opts.case_glob || opts.case_paths {
			0
		} else {
			GF_IGNCASE
		};
		if opts.multibyte {
			f |= GF_MULTIBYTE;
		}
		Self(f)
	}
}

/// A compiled zsh pattern (zsh `Patprog`): immutable and cheap to clone,
/// so the engine can cache it by (text, [`PatFlags`], [`Opts`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pattern {
	/// The program and header.
	pub(super) prog: Arc<Prog>,
}

impl Pattern {
	/// zsh `patcompile` for a pattern that is not a file-name segment:
	/// `case`, `[[ = ]]`, `${x#p}` and friends. `text` is a metafied,
	/// tokenized zsh string; its quote tokens are removed first (zsh
	/// `remnulargs`).
	pub fn compile(text: &[u8], flags: PatFlags, opts: &Opts) -> Result<Self, BadPattern> {
		let mut state = FileGlobState::start(opts);
		patcompile(text, flags, opts, &mut state).map(|(p, _)| p)
	}

	/// zsh `patcompile` with `PAT_FILE` (added to `flags`): one segment of
	/// a file glob, ending before an unquoted `/` (or at the end). Returns
	/// the pattern and the index in `text` where it stopped (zsh
	/// `endexp`). The engine's globbing calls it segment by segment with
	/// one `state`, after removing the quote tokens itself. With
	/// [`PatFlags::ANY`] the text is ignored and the pattern matches
	/// anything (zsh's `patcompile(NULL, PAT_ANY)` for a `*` segment).
	pub fn compile_segment(
		text: &[u8],
		flags: PatFlags,
		opts: &Opts,
		state: &mut FileGlobState,
	) -> Result<(Self, usize), BadPattern> {
		patcompile(text, flags | PatFlags::FILE, opts, state)
	}

	/// The `PAT_*` flags of the compiled pattern, including the ones the
	/// compiler sets ([`PatFlags::PURES`], [`PatFlags::HAS_EXCLUDP`]).
	pub fn flags(&self) -> PatFlags {
		self.prog.flags
	}

	/// The plain string of a [`PatFlags::PURES`] pattern, unmetafied: the
	/// engine's globbing tests it with one `stat` instead of a directory
	/// scan.
	pub fn pure(&self) -> Option<&[u8]> {
		self
			.prog
			.flags
			.contains(PatFlags::PURES)
			.then_some(&*self.prog.pure)
	}

	/// The number of `(#b)` capturing parentheses (zsh `patnpar`, at most
	/// 9): the length of `$match` after a successful match.
	pub fn npar(&self) -> usize {
		self.prog.npar as usize
	}

	/// Whether `(#m)` is in effect at the end of the pattern, so that a
	/// successful match sets `$MATCH`, `$MBEGIN`, `$MEND`.
	pub fn sets_match(&self) -> bool {
		self.prog.globend & GF_MATCHREF != 0
	}

	/// Whether a successful match sets any capture variable: `${x/p/r}`
	/// then expands `r` again for every match (zsh `SUB_DOSUBST`).
	pub fn has_refs(&self) -> bool {
		self.npar() > 0 || self.sets_match()
	}
}

/// zsh `patcompile`: compile `exp` under `inflags`; for `PAT_FILE`
/// patterns the globbing flags come from and go back to `state`.
fn patcompile(
	exp: &[u8],
	inflags: PatFlags,
	opts: &Opts,
	state: &mut FileGlobState,
) -> Result<(Pattern, usize), BadPattern> {
	let file = inflags.contains(PatFlags::FILE);
	let flags = inflags.without(PatFlags::PURES | PatFlags::HAS_EXCLUDP);
	if flags.contains(PatFlags::ANY) {
		return Ok((Pattern { prog: Arc::new(any_prog(flags, opts, state)) }, 0));
	}
	let owned;
	let pat: &[u8] = if file {
		exp
	} else {
		let mut v = exp.to_vec();
		remnulargs(&mut v);
		owned = v;
		&owned
	};
	let mut c = Compiler {
		pat,
		parse: 0,
		npar: 1,
		code: vec![Upat::Node { op: P_END, next: 0 }],
		flags,
		globflags: 0,
		head: 0,
		special: charsset(opts),
		nsync: 0,
		ncount: 0,
	};
	if file {
		c.globflags = state.0;
	} else {
		c.special[ZPC_SLASH] = MARKER;
		c.globflags = if opts.multibyte { GF_MULTIBYTE } else { 0 };
	}
	if c.flags.contains(PatFlags::LCMATCHUC) {
		c.globflags |= GF_LCMATCHUC;
	}
	c.head = c.globflags;

	let mut pflags = 0u8;
	let mut pure = None;
	// Look for a really pure string, with no tokens at all.
	let strp = (c.globflags & !GF_MULTIBYTE == 0).then(|| {
		let e = usize::from(c.at(0) == NULARG);
		let mut s = e;
		while c.at(s) != 0 && (!file || c.at(s) != b'/') && !is_tok(c.at(s)) {
			s += 1;
		}
		(e, s)
	});
	match strp {
		Some((e, s)) if c.at(s) == 0 || c.at(s) == b'/' => {
			c.parse = s;
			pure = Some(unmetafy(span(pat, e, s)).into_boxed_slice());
			c.flags |= PatFlags::PURES;
		},
		_ => {
			if c.compswitch(false, &mut pflags) == 0 {
				return Err(BadPattern);
			}
		},
	}
	state.0 = c.globflags;

	let mut globflags = c.head;
	let mut globend = c.globflags;
	if file && !opts.case_glob && !c.flags.contains(PatFlags::PURES) {
		globflags |= GF_IGNCASE;
		globend |= GF_IGNCASE;
	}

	let mut must = None;
	if pure.is_none() && c.op(c.next(1)) == P_END {
		// Only one top level choice.
		let mut pscan = 2;
		if pflags & P_PURESTR != 0 {
			// A string compare does it; only the first string counts.
			c.flags |= PatFlags::PURES;
			let mut s: Box<[u8]> = Box::default();
			while pscan != 0 {
				if c.op(pscan) == P_EXACTLY {
					s = exact_of(&c.code, pscan).into();
					break;
				}
				pscan = c.next(pscan);
			}
			pure = Some(s);
		} else if pflags & P_HSTART != 0 && globflags == 0 {
			// The longest literal string in something expensive.
			let mut lng: &[u8] = &[];
			while pscan != 0 {
				if c.op(pscan) == P_EXACTLY && exact_of(&c.code, pscan).len() >= lng.len() {
					lng = exact_of(&c.code, pscan);
				}
				pscan = c.next(pscan);
			}
			if !lng.is_empty() {
				must = Some(lng.into());
			}
		}
	}

	let end = c.parse;
	let code = if pure.is_some() {
		Box::default()
	} else {
		c.code.into_boxed_slice()
	};
	let prog = Prog {
		code,
		pure: pure.unwrap_or_default(),
		must,
		globflags,
		globend,
		flags: c.flags,
		npar: (c.npar - 1) as u8,
		nsync: c.nsync,
		ncount: c.ncount,
		multibyte: opts.multibyte,
	};
	Ok((Pattern { prog: Arc::new(prog) }, end))
}

/// zsh `patcompile` under `PAT_ANY`: no compilation, a pattern that matches
/// anything except a leading `.` under [`PatFlags::NOGLD`].
fn any_prog(flags: PatFlags, opts: &Opts, state: &mut FileGlobState) -> Prog {
	let file = flags.contains(PatFlags::FILE);
	let mut globflags = if file {
		state.0
	} else if opts.multibyte {
		GF_MULTIBYTE
	} else {
		0
	};
	if flags.contains(PatFlags::LCMATCHUC) {
		globflags |= GF_LCMATCHUC;
	}
	state.0 = globflags;
	if file && !opts.case_glob {
		globflags |= GF_IGNCASE;
	}
	Prog {
		code: Box::default(),
		pure: Box::default(),
		must: None,
		globflags,
		globend: globflags,
		flags,
		npar: 0,
		nsync: 0,
		ncount: 0,
		multibyte: opts.multibyte,
	}
}

/// zsh `patcompcharsset`: the active special characters under `opts`.
fn charsset(opts: &Opts) -> [u8; ZPC_COUNT] {
	let mut sp = ZPC_CHARS;
	for (i, c) in sp.iter_mut().enumerate() {
		if opts.disables.has(i) {
			*c = MARKER;
		}
	}
	if !opts.extended_glob {
		sp[ZPC_TILDE] = MARKER;
		sp[ZPC_HAT] = MARKER;
		sp[ZPC_HASH] = MARKER;
	}
	if !opts.ksh_glob {
		for i in [ZPC_KSH_QUEST, ZPC_KSH_STAR, ZPC_KSH_PLUS, ZPC_KSH_BANG, ZPC_KSH_BANG2, ZPC_KSH_AT]
		{
			sp[i] = MARKER;
		}
	}
	if opts.sh_glob {
		sp[ZPC_INPAR] = MARKER;
		sp[ZPC_INANG] = MARKER;
	}
	sp
}

/// The `P_EXACTLY` string of node `p` in `code`.
fn exact_of(code: &[Upat], p: usize) -> &[u8] {
	match code.get(p + 1) {
		Some(Upat::Exact(s)) => s,
		_ => &[],
	}
}

/// zsh `zstrtol` in base 10 on the pattern from `i`: leading blanks, a sign,
/// digits (wrapping past 64 bits as zsh truncates). Returns the value and
/// the index after the digits.
fn zstrtol(p: &[u8], mut i: usize) -> (i64, usize) {
	let at = |k: usize| p.get(k).copied().unwrap_or(0);
	while matches!(at(i), b' ' | b'\t' | b'\n') {
		i += 1;
	}
	let neg = at(i) == b'-' || at(i) == DASH;
	if neg || at(i) == b'+' {
		i += 1;
	}
	let mut calc: u64 = 0;
	let mut trunc = false;
	while at(i).is_ascii_digit() {
		if !trunc {
			let new = calc.wrapping_mul(10).wrapping_add(u64::from(at(i) - b'0'));
			if new < calc {
				trunc = true;
			} else {
				calc = new;
			}
		}
		i += 1;
	}
	if !trunc && (calc as i64) < 0 && (!neg || calc & !(1u64 << 63) != 0) {
		calc /= 10;
	}
	let v = calc as i64;
	(if neg { v.wrapping_neg() } else { v }, i)
}

/// The state of one compilation (zsh's `patparse`, `patnpar`, `patcode`,
/// `patflags`, `patglobflags`, `zpc_special` and the header's
/// `globflags`).
struct Compiler<'p> {
	/// The pattern, quote tokens removed.
	pat:       &'p [u8],
	/// The parse position (zsh `patparse`).
	parse:     usize,
	/// The next capture number, from 1 (zsh `patnpar`).
	npar:      usize,
	/// The program being emitted; unit 0 is never a node.
	code:      Vec<Upat>,
	/// `PAT_*` flags (zsh `patflags`).
	flags:     PatFlags,
	/// The globbing flags in effect (zsh `patglobflags`).
	globflags: u32,
	/// The globbing flags at the start, header field (zsh
	/// `((Patprog)patout)->globflags`).
	head:      u32,
	/// Active special characters (zsh `zpc_special`).
	special:   [u8; ZPC_COUNT],
	/// Scratch slots allocated so far.
	nsync:     u16,
	/// Count slots allocated so far.
	ncount:    u16,
}

impl Compiler<'_> {
	/// The pattern byte at `i`, NUL past the end.
	#[inline]
	fn at(&self, i: usize) -> u8 {
		self.pat.get(i).copied().unwrap_or(0)
	}

	/// The byte `k` after the parse position.
	#[inline]
	fn ahead(&self, k: usize) -> u8 {
		self.at(self.parse + k)
	}

	/// Whether `c` ends a pattern segment (zsh `memchr(zpc_special, c,
	/// ZPC_SEG_COUNT)`).
	#[inline]
	fn seg_special(&self, c: u8) -> bool {
		head(&self.special, ZPC_SEG_COUNT).contains(&c)
	}

	/// Whether multibyte characters are in effect at this point.
	#[inline]
	const fn mb(&self) -> bool {
		self.globflags & GF_MULTIBYTE != 0
	}

	/// Step the parse position past one (possibly multibyte) character
	/// (zsh `METACHARINC`), returning it.
	#[inline]
	fn charinc(&mut self) -> u32 {
		let mb = self.mb();
		let pat = self.pat;
		metacharinc(pat, &mut self.parse, mb)
	}

	/// The operator of emitted node `p`.
	#[inline]
	fn op(&self, p: usize) -> u8 {
		op_at(&self.code, p)
	}

	/// The node after emitted node `p`.
	#[inline]
	fn next(&self, p: usize) -> usize {
		next_at(&self.code, p)
	}

	/// zsh `patnode`: emit a node, returning its index.
	fn node(&mut self, op: u8) -> usize {
		self.code.push(Upat::Node { op, next: 0 });
		self.code.len() - 1
	}

	/// Emit a scratch-slot operand for a `P_WBRANCH` or `P_EXCLUDE`.
	const fn sync_operand(&mut self) -> Upat {
		let s = self.nsync;
		self.nsync += 1;
		Upat::Sync(s)
	}

	/// zsh `patinsert`: put `units` in front of the operand at `opnd`,
	/// relocating it.
	fn insert<const N: usize>(&mut self, opnd: usize, units: [Upat; N]) {
		self.code.splice(opnd..opnd, units);
	}

	/// Replace the operator of node `p`.
	fn set_op(&mut self, p: usize, new: u8) {
		if let Some(Upat::Node { op, .. }) = self.code.get_mut(p) {
			*op = new;
		}
	}

	/// zsh `pattail`: set the next link at the end of the chain from `p`
	/// to `val`.
	fn tail(&mut self, p: usize, val: usize) {
		let mut scan = p;
		loop {
			let t = self.next(scan);
			if t == 0 {
				break;
			}
			scan = t;
		}
		let offset = val.abs_diff(scan) as u32;
		if let Some(Upat::Node { next, .. }) = self.code.get_mut(scan) {
			*next |= offset;
		}
	}

	/// zsh `patoptail`: [`Self::tail`] on the operand of the branch `p`; a
	/// no-op for anything else.
	fn optail(&mut self, p: usize, val: usize) {
		let op = self.op(p);
		if p == 0 || !is_branch(op) {
			return;
		}
		if op == P_BRANCH {
			self.tail(p + 1, val);
		} else {
			self.tail(p + 2, val);
		}
	}

	/// zsh `patcompswitch`: the main body or a parenthesized group:
	/// branches separated by `|`, each possibly followed by `~` exclusions.
	/// Returns the first node, 0 on error.
	fn compswitch(&mut self, paren: bool, flagp: &mut u8) -> usize {
		let mut excsync = 0;
		let mut parno = 0;
		let mut flags = 0u8;
		let mut gfchanged = false;
		let savglobflags = self.globflags;
		*flagp = 0;

		let mut starter = if paren && self.globflags & GF_BACKREF != 0 && self.npar <= NSUBEXP {
			// Parenthesized: make an open node. Only the first nine can be
			// referred to.
			parno = self.npar;
			self.npar += 1;
			self.node(P_OPEN + parno as u8)
		} else {
			0
		};
		let mut br = self.node(P_BRANCH);
		if self.compbranch(&mut flags, paren) == 0 {
			return 0;
		}
		if self.globflags != savglobflags {
			gfchanged = true;
		}
		if starter != 0 {
			self.tail(starter, br);
		} else {
			starter = br;
		}
		*flagp |= flags & (P_HSTART | P_PURESTR);

		loop {
			let c = self.ahead(0);
			let c1 = self.ahead(1);
			let tilde_ch = self.special[ZPC_TILDE];
			if !(c == BAR || (c == tilde_ch && (c1 == b'/' || !self.seg_special(c1)))) {
				break;
			}
			self.parse += 1;
			let mut tilde = u8::from(c == tilde_ch);
			let mut gfnode = 0;
			*flagp &= !P_PURESTR;
			if tilde != 0 {
				// excsync remembers the P_EXCSYNC node before a chain of
				// exclusions: all point back to this.
				if excsync == 0 {
					excsync = self.node(P_EXCSYNC);
					self.optail(br, excsync);
				}
				// Approximations are off in exclusions by default.
				self.globflags &= !GF_ERRS;
				if !self.flags.contains(PatFlags::FILET) || paren {
					br = self.node(P_EXCLUDE);
				} else {
					// Top level of a file glob: exclude against the whole
					// path so far.
					br = self.node(P_EXCLUDP);
					self.flags |= PatFlags::HAS_EXCLUDP;
				}
				let s = self.sync_operand();
				self.code.push(s);
				// / is not special in a top level exclusion.
				if !paren && self.special[ZPC_SLASH] == b'/' {
					tilde += 1;
					self.special[ZPC_SLASH] = MARKER;
				}
			} else {
				excsync = 0;
				br = self.node(P_BRANCH);
				// Flags set in the main branch carry over to the exclusion.
				if paren {
					self.globflags = savglobflags;
				} else {
					// (#i)foo|bar: the header flags only apply to foo.
					self.globflags = 0;
					if self.head != 0 {
						gfnode = self.node(P_GFLAGS);
						self.code.push(Upat::Flags(self.globflags));
					}
				}
			}
			let newbr = self.compbranch(&mut flags, paren);
			if tilde == 2 {
				self.special[ZPC_SLASH] = b'/';
			}
			if newbr == 0 {
				return 0;
			}
			if gfnode != 0 {
				self.tail(gfnode, newbr);
			}
			if tilde == 0 && self.globflags != savglobflags {
				gfchanged = true;
			}
			self.tail(starter, br);
			if excsync != 0 {
				let end = self.node(P_EXCEND);
				self.optail(br, end);
			}
			*flagp |= flags & P_HSTART;
		}

		// The closing node, hooked to the end of every branch except the
		// exclusions, which end where they are.
		let ender_op = if !paren {
			P_END
		} else if parno != 0 {
			P_CLOSE + parno as u8
		} else {
			P_NOTHING
		};
		let ender = self.node(ender_op);
		self.tail(starter, ender);
		let mut ptr = starter;
		while ptr != 0 {
			if !is_exclude(self.op(ptr)) {
				self.optail(ptr, ender);
			}
			ptr = self.next(ptr);
		}

		// Check for proper termination.
		if paren {
			let c = self.ahead(0);
			self.parse += 1;
			if c != OUTPAR {
				return 0;
			}
		} else if self.ahead(0) != 0
			&& !(self.flags.contains(PatFlags::FILE) && self.ahead(0) == b'/')
		{
			return 0;
		}

		if paren && gfchanged {
			// Restore the flags when leaving the parentheses.
			let g = self.node(P_GFLAGS);
			self.tail(ender, g);
			self.globflags = savglobflags;
			self.code.push(Upat::Flags(savglobflags));
		}
		starter
	}

	/// zsh `patcompbranch`: the pieces up to `|`, `)`, `~` or the end.
	/// Returns the first node, 0 on error.
	fn compbranch(&mut self, flagp: &mut u8, paren: bool) -> usize {
		let mut chain = 0;
		let mut starter = 0;
		let mut flags = 0u8;
		*flagp = P_PURESTR;

		loop {
			let c = self.ahead(0);
			let c1 = self.ahead(1);
			if self.seg_special(c)
				&& !(c == self.special[ZPC_TILDE] && c1 != b'/' && self.seg_special(c1))
			{
				break;
			}
			let latest;
			if (c == self.special[ZPC_INPAR] && c1 == self.special[ZPC_HASH])
				|| (c == self.special[ZPC_KSH_AT]
					&& c1 == INPAR
					&& self.ahead(2) == self.special[ZPC_HASH])
			{
				// Globbing flags.
				let pp1 = self.parse;
				let oldglobflags = self.globflags;
				self.parse += if c == b'@' { 3 } else { 2 };
				let mut assert = 0u8;
				let mut ignore = false;
				if !self.getglobflags(&mut assert, &mut ignore) {
					return 0;
				}
				if ignore {
					if self.ahead(0) == 0 {
						break;
					}
					continue;
				}
				if assert != 0 {
					// Start/end assertions are nodes.
					latest = self.node(assert);
					flags = 0;
				} else if pp1 == 0 {
					// Right at the start: the header takes them.
					self.head = self.globflags;
					continue;
				} else if self.ahead(0) == 0 {
					// Right at the end: the next segment picks them up.
					break;
				} else if oldglobflags != self.globflags {
					latest = self.node(P_GFLAGS);
					self.code.push(Upat::Flags(self.globflags));
				} else {
					continue;
				}
			} else if c == self.special[ZPC_HAT] {
				// ^pat: anything but pat, compiled as *~pat.
				self.parse += 1;
				latest = self.compnot(false, &mut flags);
			} else {
				latest = self.comppiece(&mut flags, paren);
			}
			if latest == 0 {
				return 0;
			}
			if starter == 0 {
				starter = latest;
			}
			if flags & P_PURESTR == 0 {
				*flagp &= !P_PURESTR;
			}
			if chain == 0 {
				*flagp |= flags & P_HSTART;
			} else {
				self.tail(chain, latest);
			}
			chain = latest;
		}
		if chain == 0 {
			starter = self.node(P_NOTHING);
		}
		starter
	}

	/// zsh `patgetglobflags`: the flags of `(#…)` from the parse position
	/// (after `(#`). Sets the `(#s)`/`(#e)` assertion in `assertp`;
	/// `ignore` stays set for `(#q…)` glob qualifiers. False on error.
	fn getglobflags(&mut self, assertp: &mut u8, ignore: &mut bool) -> bool {
		let start = self.parse;
		let mut ptr = start;
		*assertp = 0;
		*ignore = true;
		while self.at(ptr) != 0 && self.at(ptr) != OUTPAR {
			let ch = self.at(ptr);
			if ch == b'q' {
				// Glob qualifiers, ignored in pattern code.
				while self.at(ptr) != 0 && self.at(ptr) != OUTPAR {
					ptr += 1;
				}
				break;
			}
			*ignore = false;
			match ch {
				b'a' => {
					// Approximate matching, at most 254 errors.
					let (ret, nptr) = zstrtol(self.pat, ptr + 1);
					if !(0..=254).contains(&ret) || nptr == ptr + 1 {
						return false;
					}
					self.globflags = (self.globflags & !GF_ERRS) | ret as u32;
					ptr = nptr - 1;
				},
				b'l' => self.globflags = (self.globflags & !GF_IGNCASE) | GF_LCMATCHUC,
				b'i' => self.globflags = (self.globflags & !GF_LCMATCHUC) | GF_IGNCASE,
				b'I' => self.globflags &= !(GF_LCMATCHUC | GF_IGNCASE),
				b'b' => self.globflags |= GF_BACKREF,
				b'B' => self.globflags &= !GF_BACKREF,
				b'm' => self.globflags |= GF_MATCHREF,
				b'M' => self.globflags &= !GF_MATCHREF,
				b's' => *assertp = P_ISSTART,
				b'e' => *assertp = P_ISEND,
				b'u' => self.globflags |= GF_MULTIBYTE,
				b'U' => self.globflags &= !GF_MULTIBYTE,
				_ => return false,
			}
			ptr += 1;
		}
		if self.at(ptr) != OUTPAR {
			return false;
		}
		// Start/end assertions must appear on their own.
		if *assertp != 0 && self.at(start + 1) != OUTPAR {
			return false;
		}
		self.parse = ptr + 1;
		true
	}

	/// zsh `patcomppiece`: a literal string, `?`, `*`, `[...]`, a group or
	/// `<n-m>`, then any `#`, `##`, `(#cN,M)` or ksh closure. Returns the
	/// first node, 0 on error.
	fn comppiece(&mut self, flagp: &mut u8, paren: bool) -> usize {
		let starter;
		let mut flags = 0u8;
		let mut kshchar: i32;
		let str0 = self.parse;
		let mut patprev = self.parse;
		loop {
			// A string must not introduce a ksh-like group.
			let c = self.ahead(0);
			kshchar = 0;
			if c != 0 && self.ahead(1) == INPAR {
				let sp = &self.special;
				kshchar = if c == sp[ZPC_KSH_PLUS] {
					i32::from(b'+')
				} else if c == sp[ZPC_KSH_BANG] || c == sp[ZPC_KSH_BANG2] {
					i32::from(b'!')
				} else if c == sp[ZPC_KSH_AT] {
					i32::from(b'@')
				} else if c == sp[ZPC_KSH_STAR] {
					i32::from(b'*')
				} else if c == sp[ZPC_KSH_QUEST] {
					i32::from(b'?')
				} else {
					0
				};
			}
			// With ( disabled, ) is an ordinary character outside groups.
			if (self.special[ZPC_INPAR] != MARKER || c != OUTPAR || paren)
				&& (kshchar != 0
					|| (head(&self.special, ZPC_NO_KSH_GLOB).contains(&c)
						&& (c != self.special[ZPC_TILDE]
							|| self.ahead(1) == b'/'
							|| !self.seg_special(self.ahead(1)))))
			{
				break;
			}
			patprev = self.parse;
			self.charinc();
		}

		if self.parse > str0 {
			// An ordinary string: cancel the kshchar lookahead.
			kshchar = 0;
			flags |= P_PURESTR;
			let morelen = patprev > str0;
			// A following # or (#c…) only applies to the last character.
			let c = self.ahead(0);
			let sp = self.special;
			if (c == sp[ZPC_HASH]
				|| (c == sp[ZPC_INPAR] && self.ahead(1) == sp[ZPC_HASH] && self.ahead(2) == b'c')
				|| (c == sp[ZPC_KSH_AT]
					&& self.ahead(1) == INPAR
					&& self.ahead(2) == sp[ZPC_HASH]
					&& self.ahead(3) == b'c'))
				&& morelen
			{
				self.parse = patprev;
			}
			if !morelen {
				flags |= P_SIMPLE;
			}
			starter = self.node(P_EXACTLY);
			let s0 = if self.at(str0) == NULARG {
				str0 + 1
			} else {
				str0
			};
			let text = untok_unmeta(span(self.pat, s0.min(self.parse), self.parse));
			let dots = text == b"." || text == b"..";
			self.code.push(Upat::Exact(text.into_boxed_slice()));
			// Case-insensitive or approximate matching is no pure string,
			// except . and .. in file names.
			if self.globflags & (GF_ERRS | GF_LCMATCHUC | GF_IGNCASE) != 0
				&& (!self.flags.contains(PatFlags::FILE) || !dots)
			{
				flags &= !P_PURESTR;
			}
		} else {
			if kshchar != 0 {
				self.parse += 1;
			}
			let patch = self.ahead(0);
			self.charinc();
			match patch {
				QUEST => {
					flags |= P_SIMPLE;
					starter = self.node(P_ANY);
				},
				STAR => {
					// kshchar is a sign that no #'s may follow.
					kshchar = -1;
					starter = self.node(P_STAR);
				},
				INBRACK => {
					flags |= P_SIMPLE;
					starter = self.bracket();
					if starter == 0 {
						return 0;
					}
				},
				INPAR => {
					let mut flags2 = 0u8;
					starter = if kshchar == i32::from(b'!') {
						// !(foo) is an extendedglob ^ in parentheses.
						self.compnot(true, &mut flags2)
					} else {
						self.compswitch(true, &mut flags2)
					};
					if starter == 0 {
						return 0;
					}
					flags |= flags2 & P_HSTART;
				},
				INANG => {
					starter = self.numeric();
					if starter == 0 {
						return 0;
					}
				},
				BNULLKEEP => {
					// A backslash kept for output matches no character; the
					// rest can no longer be a pure string.
					let next = self.comppiece(flagp, paren);
					*flagp &= !P_PURESTR;
					return next;
				},
				// A # here does not follow anything repeatable.
				_ => return 0,
			}
		}

		let c = self.ahead(0);
		let sp = self.special;
		let hash = c == sp[ZPC_HASH];
		let count = !hash
			&& ((c == sp[ZPC_INPAR] && self.ahead(1) == sp[ZPC_HASH] && self.ahead(2) == b'c')
				|| (c == sp[ZPC_KSH_AT]
					&& self.ahead(1) == INPAR
					&& self.ahead(2) == sp[ZPC_HASH]
					&& self.ahead(3) == b'c'));
		if !hash
			&& !count
			&& (kshchar <= 0 || kshchar == i32::from(b'@') || kshchar == i32::from(b'!'))
		{
			*flagp = flags;
			return starter;
		}
		// Too much at once doesn't work.
		if kshchar != 0 && (hash || count) {
			return 0;
		}
		let op;
		if kshchar == i32::from(b'*') {
			op = P_ONEHASH;
			*flagp = P_HSTART;
		} else if kshchar == i32::from(b'+') {
			op = P_TWOHASH;
			*flagp = P_HSTART;
		} else if kshchar == i32::from(b'?') {
			op = 0;
			*flagp = 0;
		} else if count {
			op = P_COUNT;
			self.parse += 3;
			*flagp = P_HSTART;
		} else {
			self.parse += 1;
			if self.ahead(0) == sp[ZPC_HASH] {
				op = P_TWOHASH;
				self.parse += 1;
			} else {
				op = P_ONEHASH;
			}
			*flagp = P_HSTART;
		}

		// Backtracking tries the non-empty branch of a closure before the
		// empty one at every repetition.
		if op == P_COUNT {
			// (#cN,M)
			let opp = self.parse;
			let (mut min, np) = zstrtol(self.pat, self.parse);
			self.parse = np;
			if self.parse == opp {
				min = 0;
			}
			let max = if self.ahead(0) != b',' && self.ahead(0) != COMMA {
				if self.ahead(0) != OUTPAR {
					return 0;
				}
				min
			} else {
				self.parse += 1;
				let opp = self.parse;
				let (m, np) = zstrtol(self.pat, self.parse);
				self.parse = np;
				if self.ahead(0) != OUTPAR {
					return 0;
				}
				// A missing maximum is infinity.
				if self.parse == opp { -1 } else { m }
			};
			self.parse += 1;
			let slot = self.ncount;
			self.ncount += 1;
			self.insert(starter, [
				Upat::Node { op: P_COUNTSTART, next: 0 },
				Upat::Node { op: P_COUNT, next: 0 },
				Upat::Count { min, max, slot },
			]);
			// The operand loops back to the P_COUNT; the counters' next is
			// the tail of the closure.
			let opnd = starter + 1 + P_CT_OPERAND;
			let back = self.node(P_BACK);
			self.tail(opnd, back);
			self.tail(opnd, starter + 1);
			let next = self.node(P_NOTHING);
			self.tail(starter, next);
			self.tail(starter + 1, next);
		} else if flags & P_SIMPLE != 0
			&& (op == P_ONEHASH || op == P_TWOHASH)
			&& self.op(starter) == P_ANY
		{
			// ?# is *, ?## is ?*.
			if op == P_TWOHASH {
				let star = self.node(P_STAR);
				self.tail(starter, star);
			} else {
				self.set_op(starter, P_STAR);
			}
		} else if flags & P_SIMPLE != 0 && op != 0 && self.globflags & GF_ERRS == 0 {
			// Simple, unless approximations need the branch form.
			self.insert(starter, [Upat::Node { op, next: 0 }]);
		} else if op == P_ONEHASH {
			// x# is (x&|), & meaning self.
			let s = self.sync_operand();
			self.insert(starter, [Upat::Node { op: P_WBRANCH, next: 0 }, s]);
			let back = self.node(P_BACK);
			self.optail(starter, back);
			self.optail(starter, starter);
			let br = self.node(P_BRANCH);
			self.tail(starter, br);
			let nothing = self.node(P_NOTHING);
			self.tail(starter, nothing);
		} else if op == P_TWOHASH {
			// x## is x(&|).
			let next = self.node(P_WBRANCH);
			let s = self.sync_operand();
			self.code.push(s);
			self.tail(starter, next);
			let back = self.node(P_BACK);
			self.tail(back, starter);
			let br = self.node(P_BRANCH);
			self.tail(next, br);
			let nothing = self.node(P_NOTHING);
			self.tail(starter, nothing);
		} else if kshchar == i32::from(b'?') {
			// ?(x) is (x|).
			self.insert(starter, [Upat::Node { op: P_BRANCH, next: 0 }]);
			let br = self.node(P_BRANCH);
			self.tail(starter, br);
			let next = self.node(P_NOTHING);
			self.tail(starter, next);
			self.optail(starter, next);
		}
		if self.ahead(0) == sp[ZPC_HASH] {
			return 0;
		}
		starter
	}

	/// The `[...]` part of zsh `patcomppiece`, after the `[`: a set of
	/// characters, `a-z` ranges (an unquoted `-` only) and `[:name:]`
	/// classes. A `]` first is a member when another `]` follows. Returns
	/// the node, 0 when the `]` is missing.
	fn bracket(&mut self) -> usize {
		let op = if self.ahead(0) == HAT || self.ahead(0) == BANG {
			self.parse += 1;
			P_ANYBUT
		} else {
			P_ANYOF
		};
		let starter = self.node(op);
		let mut items = Vec::new();
		if self.ahead(0) == OUTBRACK && tail(self.pat, self.parse + 1).contains(&OUTBRACK) {
			self.parse += 1;
			items.push(SetItem::Char(u32::from(b']')));
		}
		while self.ahead(0) != 0 && self.ahead(0) != OUTBRACK {
			if self.ahead(0) == INBRACK && self.ahead(1) == b':' {
				let from = self.parse + 2;
				if let Some(rel) = tail(self.pat, from).iter().position(|&b| b == b':')
					&& self.at(from + rel + 1) == OUTBRACK
				{
					// A POSIX class.
					let ch = class::range_type(span(self.pat, from, from + rel));
					self.parse = from + rel + 2;
					if ch != class::PP_UNKWN {
						items.push(SetItem::Class(ch));
					}
					continue;
				}
			}
			let lo = self.charinc();
			if self.ahead(0) == DASH && self.ahead(1) != 0 && self.ahead(1) != OUTBRACK {
				self.parse += 1;
				let hi = self.charinc();
				items.push(SetItem::Range(lo, hi));
			} else {
				items.push(SetItem::Char(lo));
			}
		}
		if self.ahead(0) != OUTBRACK {
			return 0;
		}
		self.parse += 1;
		self.code.push(Upat::Set(items.into_boxed_slice()));
		starter
	}

	/// The `<n-m>` part of zsh `patcomppiece`, after the `<`. Returns the
	/// node, 0 when the `>` is missing.
	fn numeric(&mut self) -> usize {
		let mut len = 0;
		let mut from = 0;
		let mut to = 0;
		if self.ahead(0).is_ascii_digit() {
			(from, self.parse) = zstrtol(self.pat, self.parse);
			len |= 1;
		}
		// The - (zsh asserts it is there).
		self.parse += 1;
		if self.ahead(0).is_ascii_digit() {
			(to, self.parse) = zstrtol(self.pat, self.parse);
			len |= 2;
		}
		if self.ahead(0) != OUTANG {
			return 0;
		}
		self.parse += 1;
		match len {
			3 => {
				let n = self.node(P_NUMRNG);
				self.code.push(Upat::Num(from));
				self.code.push(Upat::Num(to));
				n
			},
			2 => {
				let n = self.node(P_NUMTO);
				self.code.push(Upat::Num(to));
				n
			},
			1 => {
				let n = self.node(P_NUMFROM);
				self.code.push(Upat::Num(from));
				n
			},
			_ => self.node(P_NUMANY),
		}
	}

	/// zsh `patcompnot`: `^foo` (`paren` false) or `!(foo)` (`paren` true)
	/// as `*~foo`. Returns the first node, 0 on error.
	fn compnot(&mut self, paren: bool, flagsp: &mut u8) -> usize {
		*flagsp = P_HSTART;
		let starter = self.node(P_BRANCH);
		let br = self.node(P_STAR);
		let excsync = self.node(P_EXCSYNC);
		self.tail(br, excsync);
		let excl = self.node(P_EXCLUDE);
		self.tail(starter, excl);
		let s = self.sync_operand();
		self.code.push(s);
		let mut dummy = 0u8;
		let br = if paren {
			self.compswitch(true, &mut dummy)
		} else {
			self.compbranch(&mut dummy, false)
		};
		if br == 0 {
			return 0;
		}
		let end = self.node(P_EXCEND);
		self.tail(br, end);
		let n = self.node(P_NOTHING);
		self.tail(excsync, n);
		self.tail(excl, n);
		starter
	}
}

/// zsh `patadd` with `PA_UNMETA`: `s` unmetafied, tokens turned back into
/// their characters.
fn untok_unmeta(s: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(s.len());
	let mut i = 0;
	while i < s.len() {
		let c = s[i];
		if is_tok(c) {
			out.push(tok_char(c).unwrap_or(0));
			i += 1;
		} else if c == META && i + 1 < s.len() {
			out.push(s[i + 1] ^ 32);
			i += 2;
		} else {
			out.push(c);
			i += 1;
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn zstrtol_reads_signs_blanks_and_stops_at_non_digits() {
		assert_eq!(zstrtol(b" 12,3", 0), (12, 3));
		assert_eq!(zstrtol(&[DASH, b'4'], 0), (-4, 2));
		assert_eq!(zstrtol(b"x", 0), (0, 0));
		assert_eq!(zstrtol(b"99999999999999999999)", 0).1, 20);
	}
}
