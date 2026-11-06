//! zsh's `fc`, `history` and `r` (`builtin.c` `bin_fc`, `fcgetcomm`,
//! `fcsubs`, `fclist`, `fcedit`; `hist.c` `pushhiststack`, `pophiststack`,
//! `saveandpophiststack`) and `print -s`/`-S`.
//!
//! Re-running events (`fc -e`, `fc -s`, `r`) puts them in a temporary file,
//! runs the editor on it as shell code (`$FCEDIT`, `$EDITOR`, `vi`; none
//! for `-` and `r`), then prints the file to standard error and runs it as
//! one event of the history.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::sync::Arc;

use bstr::{BString, ByteSlice};
use serde::{Deserialize, Serialize};

use super::{
	file::{self, FileOpts, HFILE_APPEND, HFILE_SKIPOLD, HFILE_USE_OPTIONS, Locks, Report},
	io::{ErrKind, HistOp, HistOut, Pending, Steps, WriteHow},
	model::{DEFAULT_HISTSIZE, Entry, HIST_FOREIGN, HIST_READ, Hist, ZState, inblank, same_text},
	words::lex_words,
	zsh as hz,
};
use crate::bash::{
	diag::Diag,
	pattern::zsh::{CharEnv, PatFlags, Pattern},
	store::{Attrs, KeyBuf, MiscKey, Record, StateStore, StoreError},
	syntax::zsh::tok::metafy,
	vm::{
		builtins::{Control, Ctx, Need, Outcome, R, done, zsh_args::Ops, zsh_quote::niceformat},
		exec::push_script,
		proc::{FrameKind, ScriptKind, Vproc},
		state::{self, Level, Root, Var},
	},
	zshopt::ZshOpt,
};

/// The `HISTFILE` a history stack level restores when popped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistfileRestore {
	/// Leave `HISTFILE` alone.
	#[default]
	Keep,
	/// Set `HISTFILE` to the value (`None` unsets it).
	Set(Option<BString>),
}

/// One level of the history stack (zsh `struct histsave`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct StackLevel {
	/// `HISTFILE` to restore.
	pub histfile:   HistfileRestore,
	/// The saved events.
	pub entries:    Vec<Entry>,
	/// The saved state.
	pub st:         ZState,
	/// The function depth that pushed it with `fc -a` (`-1`: none).
	pub locallevel: i64,
}

/// The history stack, bottom first.
///
/// # Errors
/// [`StoreError`] when the record cannot be read.
pub fn stack_load(store: &mut dyn StateStore, vp: &Vproc) -> Result<Vec<StackLevel>, StoreError> {
	Ok(match state::record(store, vp, crate::bash::store::Key::Misc(MiscKey::ZshHistoryStack))? {
		Some(Record::Words(w)) => w
			.iter()
			.filter_map(|b| postcard::from_bytes(b).ok())
			.collect(),
		_ => Vec::new(),
	})
}

/// The depth of the history stack (zsh `histsave_stack_pos`).
///
/// # Errors
/// [`StoreError`] when the record cannot be read.
pub fn stack_depth(store: &mut dyn StateStore, vp: &Vproc) -> Result<usize, StoreError> {
	Ok(match state::record(store, vp, crate::bash::store::Key::Misc(MiscKey::ZshHistoryStack))? {
		Some(Record::Words(w)) => w.len(),
		_ => 0,
	})
}

/// Write the history stack back.
pub fn stack_save(
	stack: &[StackLevel],
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
) {
	let rec = (!stack.is_empty()).then(|| {
		Record::Words(
			stack
				.iter()
				.map(|l| BString::from(postcard::to_allocvec(l).unwrap_or_default()))
				.collect(),
		)
	});
	state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::ZshHistoryStack), rec);
}

/// zsh `pushhiststack`: the current list goes on the stack, a fresh one
/// with `hs`/`shs` replaces it. Returns the `HISTFILE` to set (`Some`) and
/// the level pushed.
fn push(
	h: &mut Hist,
	histfile_now: Option<BString>,
	hf: Option<&[u8]>,
	hs: i64,
	shs: i64,
	level: i64,
) -> StackLevel {
	let linked = h.st.linked;
	let mut saved = std::mem::take(h);
	if linked {
		saved.st.curhist -= 1;
		saved.st.linked = false;
	}
	let mut st = ZState {
		curhist: 0,
		histsiz: hs.max(1),
		savehistsiz: shs.max(0),
		chars: saved.st.chars,
		hsubl: saved.st.hsubl.clone(),
		hsubr: saved.st.hsubr.clone(),
		marg: saved.st.marg,
		mev: saved.st.mev,
		ignore_all_dups: saved.st.ignore_all_dups,
		histactive: saved.st.histactive,
		curline_num: saved.st.curline_num,
		init: true,
		started: saved.st.started,
		..ZState::default()
	};
	if linked {
		st.curhist = 1;
		st.linked = true;
	}
	h.st = st;
	h.curline = saved.curline.take();
	StackLevel {
		histfile:   if hf.is_some() {
			HistfileRestore::Set(histfile_now)
		} else {
			HistfileRestore::Keep
		},
		entries:    Arc::unwrap_or_clone(saved.entries),
		st:         saved.st,
		locallevel: level,
	}
}

/// zsh `pophiststack`: restore `lv`; the `HISTFILE` to restore.
fn pop(h: &mut Hist, lv: StackLevel) -> HistfileRestore {
	let linked = h.st.linked;
	let curline = h.curline.take();
	let (chars, hsubl, hsubr, marg, mev, histactive, curline_num) = (
		h.st.chars,
		h.st.hsubl.take(),
		h.st.hsubr.take(),
		h.st.marg,
		h.st.mev,
		h.st.histactive,
		h.st.curline_num,
	);
	h.replace_events(lv.entries);
	h.st = lv.st;
	h.st.chars = chars;
	h.st.hsubl = hsubl;
	h.st.hsubr = hsubr;
	h.st.marg = marg;
	h.st.mev = mev;
	h.st.histactive = histactive;
	h.st.curline_num = curline_num;
	h.curline = curline;
	if linked {
		h.st.curhist += 1;
		h.st.linked = true;
	}
	lv.histfile
}

/// Set or unset `HISTFILE`.
fn set_histfile(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, v: Option<BString>) {
	let var = v.map(|v| Var::scalar(v, Attrs::NONE));
	state::store_var(root, store, vp, b"HISTFILE", var, Level::Global);
}

/// zsh `saveandpophiststack(pop_through, writeflags)` as a [`Steps`]
/// operation over `h` and `stack`: each level popped is saved to its
/// file first. `histfile` is the current `HISTFILE`; `locallevel` the
/// current function depth. Returns whether anything was popped and the
/// `HISTFILE` to leave set (outer `None`: unchanged).
#[allow(clippy::too_many_arguments, reason = "zsh's arguments plus the operation's context")]
pub fn save_and_pop(
	h: &mut Hist,
	stack: &mut Vec<StackLevel>,
	steps: &mut Steps<'_>,
	o: &FileOpts,
	mut pop_through: i64,
	writeflags: u32,
	locallevel: i64,
	nohistsave: bool,
	r: &mut Report,
) -> Result<(bool, HistfileRestore), Pending> {
	let pos = stack.len() as i64;
	if pop_through <= 0 {
		pop_through += pos + 1;
		if pop_through <= 0 {
			pop_through = 1;
		}
	}
	while pop_through > 1 && stack[(pop_through - 2) as usize].locallevel > locallevel {
		pop_through -= 1;
	}
	if (stack.len() as i64) < pop_through {
		return Ok((false, HistfileRestore::Keep));
	}
	let mut fopts = o.clone();
	let mut set = HistfileRestore::Keep;
	loop {
		if !nohistsave {
			let mut l = Locks::default();
			file::savehistfile(h, steps, &fopts, &mut l, None, true, writeflags, r)?;
		}
		let Some(lv) = stack.pop() else { break };
		if let HistfileRestore::Set(hf) = pop(h, lv) {
			fopts.histfile = hf.clone().filter(|f| !f.is_empty());
			set = HistfileRestore::Set(hf);
		}
		if (stack.len() as i64) < pop_through {
			break;
		}
	}
	Ok((true, set))
}

/// The function depth of `vp` (zsh `locallevel`).
pub fn locallevel(vp: &Vproc) -> i64 {
	vp.frames
		.iter()
		.filter(|f| matches!(f.kind, FrameKind::Function { .. }))
		.count() as i64
}

/// zsh `fcgetcomm`: an event number (negative: relative to the running
/// line), else the newest event starting with `s`; `None` after `event
/// not found`.
fn fcgetcomm(ctx: &mut Ctx<'_, '_>, h: &Hist, s: &[u8]) -> Option<i64> {
	let cmd = atoi(s);
	if cmd != 0 || s.first() == Some(&b'0') {
		let cmd = if cmd < 0 {
			h.addhistnum(h.st.curline_num, cmd, HIST_FOREIGN)
		} else {
			cmd
		};
		return Some(cmd.max(0));
	}
	if let Some(i) = h.search_up(|t| t.starts_with(s)) {
		Some(h.num_at(i))
	} else {
		warn(ctx, format!("event not found: {}", s.as_bstr()));
		None
	}
}

/// C `atoi`.
fn atoi(s: &[u8]) -> i64 {
	let blanks = s
		.iter()
		.take_while(|c| matches!(c, b' ' | b'\t'..=b'\r'))
		.count();
	let s = &s[blanks..];
	let (neg, digits) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = digits
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0_i64, |n, &c| n.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	if neg { -n } else { n }
}

/// zsh `zwarnnam("fc", …)`.
fn warn(ctx: &mut Ctx<'_, '_>, msg: String) {
	ctx.diag(Diag::Usage { msg: msg.into() }.by("fc"));
}

/// zsh `zerr`: the message, and the rest of the command line abandoned.
fn zerr_report(ctx: &mut Ctx<'_, '_>, r: Report, status: i32) -> R {
	let error = r.error;
	for m in r.msgs {
		ctx.diag(Diag::Usage { msg: m.to_str_lossy().into_owned().into() });
	}
	if error {
		return Ok(Outcome { status, control: Control::DiscardAll });
	}
	done(status)
}

/// zsh `fcsubs`: every `old=new` applied in turn; whether one matched.
fn fcsubs(s: &mut BString, subs: &[(BString, BString)]) -> bool {
	let mut subbed = false;
	for (old, new) in subs {
		let mut from = 0;
		while let Some(p) = s[from..].find(old.as_slice()) {
			let at = from + p;
			let mut n = BString::from(&s[..at]);
			n.extend_from_slice(new);
			from = n.len();
			n.extend_from_slice(&s[at + old.len()..]);
			*s = n;
			subbed = true;
			if old.is_empty() {
				break;
			}
		}
	}
	subbed
}

/// The options read once per `fc`.
fn fc_opts(ctx: &mut Ctx<'_, '_>) -> Result<FileOpts, Need> {
	let euid = ctx.cx.host.user().euid;
	let pid = ctx.k.shell_pid;
	Ok(hz::file_opts(&mut ctx.k.root, ctx.cx.store, ctx.vp, pid, euid)?)
}

/// zsh `bin_fc` for `fc`, `history` (implied `-l`) and `r` (editor `-`).
#[allow(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn zsh_fc(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let is_r = ctx.name == "r";
	let h = hz::load(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	if ops.isset(b'p') {
		let mut argv = args.iter();
		let mut hf: &[u8] = b"";
		let mut hs = DEFAULT_HISTSIZE;
		let mut shs = 0;
		let level = if ops.isset(b'a') {
			locallevel(ctx.vp)
		} else {
			-1
		};
		if let Some(f) = argv.next() {
			hf = f;
			if let Some(a) = argv.next() {
				let Some(v) = strict_int(a) else {
					warn(ctx, "HISTSIZE must be an integer".into());
					return done(1);
				};
				hs = v;
				if let Some(b) = argv.next() {
					let Some(v) = strict_int(b) else {
						warn(ctx, "SAVEHIST must be an integer".into());
						return done(1);
					};
					shs = v;
				} else {
					shs = hs;
				}
				if argv.next().is_some() {
					warn(ctx, "too many arguments".into());
					return done(1);
				}
			} else {
				hs = h.st.histsiz;
				shs = h.st.savehistsiz;
			}
		}
		let o = fc_opts(ctx)?;
		let now_file = ctx.scalar(b"HISTFILE")?;
		let mut stack = stack_load(ctx.cx.store, ctx.vp)?;
		let mut fresh = h.clone();
		let lv = push(&mut fresh, now_file, Some(hf), hs, shs, level);
		let r = if hf.is_empty() {
			Report::default()
		} else {
			let mut fo = o;
			fo.histfile = Some(BString::from(hf));
			let hfb = BString::from(hf);
			let res = hz::in_builtin(ctx, |steps| {
				let mut h2 = fresh.clone();
				let mut r2 = Report::default();
				let exists = match steps.ask(HistOp::Stat { path: hfb.clone(), follow: true })? {
					Ok(_) => true,
					Err(e) => e.kind != ErrKind::NotFound,
				};
				if exists {
					let mut l = Locks::default();
					file::readhistfile(
						&mut h2,
						steps,
						&fo,
						&mut l,
						Some(&hfb),
						true,
						HFILE_USE_OPTIONS,
						&mut r2,
					)?;
				}
				Ok((h2, r2))
			})?;
			fresh = res.0;
			res.1
		};
		stack.push(lv);
		stack_save(&stack, &mut ctx.k.root, ctx.cx.store, ctx.vp);
		fresh.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		let v = (!hf.is_empty()).then(|| BString::from(hf));
		set_histfile(&mut ctx.k.root, ctx.cx.store, ctx.vp, v);
		return zerr_report(ctx, r, 0);
	}
	if ops.isset(b'P') {
		if !args.is_empty() {
			warn(ctx, "too many arguments".into());
			return done(1);
		}
		let o = fc_opts(ctx)?;
		let ll = locallevel(ctx.vp);
		let stack0 = stack_load(ctx.cx.store, ctx.vp)?;
		let (h2, stack, popped, set, r) = hz::in_builtin(ctx, |steps| {
			let mut h2 = h.clone();
			let mut stack = stack0.clone();
			let mut r = Report::default();
			let (popped, set) =
				save_and_pop(&mut h2, &mut stack, steps, &o, -1, HFILE_USE_OPTIONS, ll, false, &mut r)?;
			Ok((h2, stack, popped, set, r))
		})?;
		if popped {
			h2.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
			stack_save(&stack, &mut ctx.k.root, ctx.cx.store, ctx.vp);
			if let HistfileRestore::Set(v) = set {
				set_histfile(&mut ctx.k.root, ctx.cx.store, ctx.vp, v);
			}
		}
		return zerr_report(ctx, r, i32::from(!popped));
	}
	let mut args = args;
	let mut pprog: Option<Pattern> = None;
	if ops.isset(b'm')
		&& let Some((pat, rest)) = args.split_first()
	{
		let mut t = metafy(pat);
		crate::bash::pattern::zsh::tokenize(&mut t);
		let popts = crate::bash::pattern::zsh::Opts {
			extended_glob: ctx.zsh_option(ZshOpt::Extendedglob)?,
			ksh_glob: ctx.zsh_option(ZshOpt::Kshglob)?,
			sh_glob: ctx.zsh_option(ZshOpt::Shglob)?,
			..crate::bash::pattern::zsh::Opts::default()
		};
		if let Ok(p) = Pattern::compile(&t, PatFlags::NONE, &popts) {
			pprog = Some(p);
		} else {
			ctx.diag(Diag::Usage { msg: "invalid match pattern".into() }.by(ctx.name));
			return done(1);
		}
		args = rest;
	}
	for (c, flags) in [(b'R', 0u32), (b'W', 0), (b'A', HFILE_APPEND)] {
		if !ops.isset(c) {
			continue;
		}
		let o = fc_opts(ctx)?;
		let skip = if ops.isset(b'I') { HFILE_SKIPOLD } else { 0 };
		let target = args.first().cloned();
		let (h2, r) = hz::in_builtin(ctx, |steps| {
			let mut h2 = h.clone();
			let mut r = Report::default();
			let mut l = Locks::default();
			let fname = target.as_ref().map(|t| t.as_slice());
			if c == b'R' {
				file::readhistfile(&mut h2, steps, &o, &mut l, fname, true, skip, &mut r)?;
			} else {
				file::savehistfile(&mut h2, steps, &o, &mut l, fname, true, flags | skip, &mut r)?;
			}
			Ok((h2, r))
		})?;
		h2.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		return zerr_report(ctx, r, 0);
	}
	if crate::bash::vm::zle::active(ctx.vp) {
		warn_name(ctx, "no interactive history within ZLE".into());
		return done(1);
	}
	// `old=new` substitutions.
	let mut subs: Vec<(BString, BString)> = Vec::new();
	while let Some((arg, rest)) = args.split_first()
		&& let Some(eq) = arg.find_byte(b'=')
	{
		if eq == 0 {
			warn_name(ctx, format!("invalid replacement pattern: ={}", arg[1..].as_bstr()));
			return done(1);
		}
		subs.push((BString::from(&arg[..eq]), BString::from(&arg[eq + 1..])));
		args = rest;
	}
	let mut first = -1;
	let mut last = -1;
	if let Some((a, rest)) = args.split_first() {
		let Some(n) = fcgetcomm(ctx, &h, a) else {
			return done(1);
		};
		first = n;
		args = rest;
	}
	if let Some((a, rest)) = args.split_first() {
		let Some(n) = fcgetcomm(ctx, &h, a) else {
			return done(1);
		};
		last = n;
		args = rest;
	}
	if !args.is_empty() {
		warn(ctx, "too many arguments".into());
		return done(1);
	}
	let listing = ops.isset(b'l');
	let curhist = h.st.curhist;
	if last == -1 {
		if listing && first < curhist {
			last = if h.st.curline_num == curhist {
				h.addhistnum(curhist, -1, 0)
			} else {
				curhist
			};
			last = last.max(h.firsthist());
		} else {
			last = first;
		}
	}
	if first == -1 {
		let xflags = if ops.isset(b'L') { HIST_FOREIGN } else { 0 };
		first = if listing {
			h.addhistnum(curhist, -16, xflags)
		} else {
			h.addhistnum(h.st.curline_num, -1, xflags)
		};
		first = first.max(1);
		last = last.max(first);
	}
	if listing {
		let mut out = Vec::new();
		let st = fclist(ctx, &h, ops, first, last, &subs, pprog.as_ref(), false, &mut out)?;
		ctx.out(&out);
		return done(st);
	}
	// Edit and re-run.
	if last >= curhist {
		last = curhist - 1;
		if first > last {
			warn(ctx, "current history line would recurse endlessly, aborted".into());
			return done(1);
		}
	}
	let mut text = Vec::new();
	let st = fclist(ctx, &h, ops, first, last, &subs, pprog.as_ref(), true, &mut text)?;
	if st != 0 {
		return done(1);
	}
	let editor: BString = if is_r || ops.isset(b's') {
		BString::from("-")
	} else if let Some(e) = ops.arg(b'e').filter(|_| ops.hasarg(b'e')) {
		BString::from(e)
	} else if let Some(e) = ctx.scalar(b"FCEDIT")? {
		e
	} else if let Some(e) = ctx.scalar(b"EDITOR")? {
		e
	} else {
		BString::from("vi")
	};
	rerun(ctx, h, BString::from(text), &editor)
}

/// `zwarnnam(nam, …)` under the builtin's own name.
fn warn_name(ctx: &mut Ctx<'_, '_>, msg: String) {
	let name = ctx.name;
	ctx.diag(Diag::Usage { msg: msg.into() }.by(name));
}

/// An integer argument as `zstrtol(…, &check, 10)` with nothing after it.
fn strict_int(s: &[u8]) -> Option<i64> {
	let t = s.trim_ascii_start();
	let (neg, d) = match t.first() {
		Some(b'-') => (true, &t[1..]),
		Some(b'+') => (false, &t[1..]),
		_ => (false, t),
	};
	if !d.iter().all(u8::is_ascii_digit) {
		return None;
	}
	let n = d
		.iter()
		.fold(0_i64, |n, &c| n.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	Some(if neg { -n } else { n })
}

/// The local time zone at `secs` (`$TZ` when set).
fn zone(ctx: &mut Ctx<'_, '_>, secs: i64) -> Result<(i32, BString), Need> {
	let tz = ctx.scalar(b"TZ")?.filter(|t| !t.is_empty());
	Ok(ctx
		.cx
		.host
		.tz_offset(tz.as_ref().map(|t| t.as_bstr()), secs))
}

/// zsh `fclist`: events `first..last` (`-r`: reversed), numbered unless
/// `-n` or `command` (the text to run), with timestamps (`-d -f -E -i -t`)
/// and durations (`-D`); `old=new` applied. The status (1 after a
/// warning).
#[allow(clippy::too_many_arguments, reason = "zsh's arguments")]
fn fclist(
	ctx: &mut Ctx<'_, '_>,
	h: &Hist,
	ops: &Ops,
	mut first: i64,
	mut last: i64,
	subs: &[(BString, BString)],
	pprog: Option<&Pattern>,
	command: bool,
	out: &mut Vec<u8>,
) -> Result<i32, Need> {
	if ops.isset(b'r') {
		std::mem::swap(&mut first, &mut last);
	}
	if command && first > last {
		warn(ctx, "history events can't be executed backwards, aborted".into());
		return Ok(1);
	}
	let dir: i32 = if first < last { 1 } else { -1 };
	let start = h.gethistent(first, dir).filter(|&i| {
		let n = h.num_at(i);
		if first < last { n <= last } else { n >= last }
	});
	let Some(mut i) = start else {
		if first == last {
			warn(ctx, format!("no such event: {first}"));
		} else {
			warn(ctx, "no events in that range".into());
		}
		return Ok(1);
	};
	let tdfmt: Option<BString> = if ops.isset(b't') {
		ops.arg(b't').map(BString::from)
	} else if ops.isset(b'i') {
		Some("%Y-%m-%d %H:%M".into())
	} else if ops.isset(b'E') {
		Some("%f.%-m.%Y %H:%M".into())
	} else if ops.isset(b'f') {
		Some("%-m/%f/%Y %H:%M".into())
	} else if ops.isset(b'd') {
		Some("%H:%M".into())
	} else {
		None
	};
	let mut xflags = 0;
	if ops.isset(b'L') {
		xflags |= HIST_FOREIGN;
	}
	if ops.isset(b'I') {
		xflags |= HIST_READ;
	}
	let numbered = !ops.isset(b'n') && !command;
	let cs = super::super::zsh_print::charset(ctx)?;
	let mut done_any = false;
	let env = CharEnv::DEFAULT;
	loop {
		let flags = h.flags_at(i);
		if flags & xflags == 0 {
			let mut s = BString::from(h.text_at(i));
			if pprog.is_none_or(|p| p.matches(&metafy(&s), &env)) {
				done_any |= if subs.is_empty() {
					true
				} else {
					fcsubs(&mut s, subs)
				};
				if numbered {
					let mark = if flags & HIST_FOREIGN != 0 { '*' } else { ' ' };
					out.extend_from_slice(format!("{:>5}{mark} ", h.num_at(i)).as_bytes());
				}
				let (stim, ftim) = h.entries.get(i).map_or((0, 0), |e| (e.stim, e.ftim));
				if let Some(fmt) = &tdfmt {
					let (off, abbr) = zone(ctx, stim)?;
					let t = super::super::zsh_mod_stat::ztrftime(fmt, stim, 0, off, &abbr, 256);
					out.extend_from_slice(&t);
					out.extend_from_slice(b"  ");
				}
				if ops.isset(b'D') {
					let diff = if ftim != 0 { ftim - stim } else { 0 };
					out.extend_from_slice(format!("{}:{:02}  ", diff / 60, diff % 60).as_bytes());
				}
				if command {
					out.extend_from_slice(&s);
				} else {
					out.extend_from_slice(&niceformat(&s, false, cs));
				}
				out.push(b'\n');
			}
		}
		let next = if first < last {
			i + 1
		} else {
			i.wrapping_sub(1)
		};
		if next >= h.ring_len() {
			break;
		}
		let n = h.num_at(next);
		if (first < last && n > last) || (first >= last && n < last) {
			break;
		}
		i = next;
	}
	if !done_any {
		if !subs.is_empty() {
			warn(ctx, "no substitutions performed".into());
		} else if xflags != 0 || pprog.is_some() {
			warn(ctx, "no matching events found".into());
		}
		return Ok(1);
	}
	Ok(0)
}

/// Add `text` (an event run by `fc`/`r`, or `print -s`) to the list as
/// zsh's `hend` would: a copy of the latest event replaces it under
/// `histignoredups`. Returns its number.
fn add_event(
	h: &mut Hist,
	text: &[u8],
	words: Vec<u32>,
	now: i64,
	ignoredups: bool,
	dups_first: bool,
) -> i64 {
	let i = if ignoredups && h.entries.last().is_some_and(|t| same_text(text, &t.text)) {
		h.entries.len() - 1
	} else {
		h.prepnext(dups_first)
	};
	let he = &mut h.events_mut()[i];
	he.text = BString::from(text);
	he.stim = now;
	he.ftim = 0;
	he.flags = 0;
	he.words = words;
	let num = he.num;
	h.addhistnode(i);
	num
}

/// The temporary file `fc` edits (zsh `gettempfile`): `$TMPPREFIX` and a
/// suffix unique to this shell and attempt.
fn temp_name(prefix: &[u8], pid: u32, n: u32) -> BString {
	let mut p = BString::from(prefix);
	p.extend_from_slice(format!("fc{pid}x{n}").as_bytes());
	p
}

/// Write the events to a temporary file, run the editor on it (none for
/// `-`), print it to standard error and run it as one event.
fn rerun(ctx: &mut Ctx<'_, '_>, h: Hist, text: BString, editor: &[u8]) -> R {
	let prefix = ctx
		.scalar(b"TMPPREFIX")?
		.unwrap_or_else(|| BString::from("/tmp/zsh"));
	let pid = ctx.k.shell_pid;
	let edit = editor != b"-";
	// The file: created exclusively under the first free name.
	let made = hz::in_builtin(ctx, |steps| {
		for n in 0..100 {
			let path = temp_name(&prefix, pid, n);
			let how = WriteHow::Excl;
			match steps.ask(HistOp::Write {
				path: path.clone(),
				data: text.clone(),
				how,
				mode: 0o600,
			})? {
				Ok(_) => return Ok(Ok(path)),
				Err(e) if e.kind == ErrKind::Exists => {},
				Err(e) => return Ok(Err(e.msg)),
			}
		}
		Ok(Err(BString::from("file exists")))
	})?;
	let path = match made {
		Ok(p) => p,
		Err(msg) => {
			warn(ctx, format!("can't open temp file: {}", msg.to_str_lossy()));
			return done(1);
		},
	};
	if edit && ctx.resumed == 0 {
		// zsh `fcedit`: `editor file` run as shell code.
		let mut cmd = BString::from(editor);
		cmd.push(b' ');
		cmd.extend_from_slice(&path);
		push_script(ctx.vp, &cmd, ctx.line, ScriptKind::Eval);
		return Ok(Outcome { status: 0, control: Control::Resume });
	}
	let edited = if edit { ctx.vp.status == 0 } else { true };
	let contents = hz::in_builtin(ctx, |steps| {
		let got = if edited {
			match steps.ask(HistOp::Read { path: path.clone() })? {
				Ok(HistOut::Bytes(b)) => Some(Ok(b)),
				Ok(_) => Some(Ok(BString::default())),
				Err(e) => Some(Err(e.msg)),
			}
		} else {
			None
		};
		// Temporary-file cleanup must not replace the editor/read outcome.
		let _ = steps.ask(HistOp::Unlink { path: path.clone() })?;
		Ok(got)
	})?;
	let contents = match contents {
		None => return done(1),
		Some(Ok(c)) => c,
		Some(Err(msg)) => {
			warn(ctx, format!("{}: {}", msg.to_str_lossy(), path.to_str_lossy()));
			return done(1);
		},
	};
	// zsh `stuff`: the file goes to standard error first.
	let unwritten = super::write_now(&*ctx, 2, &contents).to_vec();
	if !unwritten.is_empty() {
		ctx.out_fd(2, &unwritten);
	}
	let event = contents
		.strip_suffix(b"\n")
		.unwrap_or(contents.as_slice())
		.to_vec();
	if !event.iter().all(|&c| inblank(c)) {
		let mut h = h;
		let now = ctx.cx.host.wall().secs;
		let ignoredups =
			ctx.zsh_option(ZshOpt::Histignoredups)? || ctx.zsh_option(ZshOpt::Histignorealldups)?;
		let dups_first = ctx.zsh_option(ZshOpt::Histexpiredupsfirst)?;
		let words = lex_words(&event, false);
		let num = add_event(&mut h, &event, words, now, ignoredups, dups_first);
		h.st.curline_num = num;
		h.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	}
	push_script(ctx.vp, &contents, ctx.line, ScriptKind::Eval);
	Ok(Outcome { status: 0, control: Control::Frame })
}

/// `print -s` (`lex` false: the words joined by spaces, each a history
/// word) and `print -S` (one argument, split by the lexer): a new event.
pub fn print_s(ctx: &mut Ctx<'_, '_>, words: &[Vec<u8>], lex: bool) -> R {
	if lex && words.len() > 1 {
		let name = ctx.name;
		ctx.diag(Diag::Usage { msg: "option -S takes a single argument".into() }.by(name));
		return done(1);
	}
	let text = BString::from(bstr::join(b" ", words));
	let bounds = if lex {
		lex_words(&text, false)
	} else {
		let mut b = Vec::with_capacity(words.len() * 2);
		let mut pos = 0u32;
		for w in words {
			b.push(pos);
			pos += w.len() as u32;
			b.push(pos);
			pos += 1;
		}
		b
	};
	add_print_event(ctx, text, bounds)
}

/// `print -s -f fmt …`: the formatted text as one event.
pub fn print_s_text(ctx: &mut Ctx<'_, '_>, text: Vec<u8>) -> R {
	add_print_event(ctx, BString::from(text), Vec::new())
}

/// The event `print -s` adds (zsh: `prepnexthistent`, `addhistnode`,
/// start and finish time now, no `histignoredups`).
fn add_print_event(ctx: &mut Ctx<'_, '_>, text: BString, words: Vec<u32>) -> R {
	let mut h = hz::load(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	let dups_first = ctx.zsh_option(ZshOpt::Histexpiredupsfirst)?;
	let now = ctx.cx.host.wall().secs;
	let i = h.prepnext(dups_first);
	{
		let he = &mut h.events_mut()[i];
		he.text = text;
		he.stim = now;
		he.ftim = now;
		he.flags = 0;
		he.words = words;
	}
	h.addhistnode(i);
	h.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	done(0)
}
