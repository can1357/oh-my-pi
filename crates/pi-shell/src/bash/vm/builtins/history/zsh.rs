//! The zsh history mechanism as the shell drives it (`hist.c` `hbegin`,
//! `hend`, `should_ignore_line`, `histreduceblanks`, the startup read and
//! the exit save), its parameters (`HISTCMD`, `HISTSIZE`, `SAVEHIST`,
//! `histchars`, `$history`, `$historywords`) and the drivers that run a
//! history operation's filesystem steps from the reader or a builtin.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	bang::{self, BangOpts, HISTFLAG_DONE, HISTFLAG_NOEXEC, HISTFLAG_RECALL, Lex, LineState},
	file::{self, FileOpts, HFILE_FAST, HFILE_NO_REWRITE, HFILE_USE_OPTIONS, Locks, Report},
	io::{Pending, Steps},
	model::{
		HA_ACTIVE, HA_NOINC, HIST_FOREIGN, HIST_NOWRITE, HIST_OLD, HIST_TMPSTORE, Hist, ZState,
	},
	words::lex_words,
};
use crate::bash::{
	diag::Diag,
	event::WaitKey,
	store::{Key, StateStore, StoreError},
	vm::{
		Cx, Kernel,
		builtins::{Ctx, Need},
		probe,
		proc::{Probe, Scratch, Vproc},
		state::{self, Root},
	},
	zshopt::ZshOpt,
};

/// Probe sequence bases of the reader's operations (one probe cache).
const BASE_HBEGIN: u32 = 1 << 24;
const BASE_EXPAND: u32 = 2 << 24;
const BASE_HEND: u32 = 3 << 24;
const BASE_FILE: u32 = 4 << 24;
const BASE_ZLE: u32 = 5 << 24;

/// An option as `vp` sees it.
fn zopt(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	o: ZshOpt,
) -> Result<bool, StoreError> {
	state::zsh_option(root, store, vp, o)
}

/// A variable's scalar value.
fn var(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<BString>, StoreError> {
	Ok(state::lookup(root, store, vp, name)?.and_then(|v| v.as_scalar().map(BString::from)))
}

/// zsh `zstrtol(s, NULL, 10)` of a parameter value (`HISTSIZE=abc` is 0).
fn int_value(s: &[u8]) -> i64 {
	let s = s.trim_ascii_start();
	let (neg, d) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = d
		.iter()
		.take_while(|c| c.is_ascii_digit())
		.fold(0_i64, |n, &c| n.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	if neg { -n } else { n }
}

/// Initialise the state of a new shell: `HISTSIZE` and `SAVEHIST` imported
/// from the environment (zsh's `IPDEF1` parameters), clamped.
fn init_state(
	st: &mut ZState,
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<(), StoreError> {
	if st.init {
		return Ok(());
	}
	st.init = true;
	if let Some(v) = var(root, store, vp, b"HISTSIZE")? {
		st.histsiz = int_value(&v).max(1);
	}
	if let Some(v) = var(root, store, vp, b"SAVEHIST")? {
		st.savehistsiz = int_value(&v).max(0);
	}
	Ok(())
}

/// The history as `vp` sees it.
///
/// # Errors
/// [`StoreError`] when a record cannot be read.
pub fn load(root: &Root, store: &mut dyn StateStore, vp: &Vproc) -> Result<Hist, StoreError> {
	let mut h = Hist::load(root, store, vp)?;
	init_state(&mut h.st, root, store, vp)?;
	Ok(h)
}

/// The history state (no events) as `vp` sees it.
///
/// # Errors
/// [`StoreError`] when a record cannot be read.
pub fn load_state(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<ZState, StoreError> {
	let mut st = Hist::load_state(store, vp)?;
	init_state(&mut st, root, store, vp)?;
	Ok(st)
}

/// zsh's `curhist`: the number of the latest event, or of the line being
/// read while one is (`HISTCMD`, the prompt's `%h`/`%!`).
///
/// # Errors
/// [`StoreError`] when the state cannot be read.
pub fn curhist(root: &Root, store: &mut dyn StateStore, vp: &Vproc) -> Result<i64, StoreError> {
	Ok(load_state(root, store, vp)?.curhist)
}

/// `$history` (zsh/parameter `scanpmhistory`): event number and text,
/// newest first, from the event before the latest one.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn history_param(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<(BString, BString)>, StoreError> {
	let h = load(root, store, vp)?;
	let start = h.addhistnum(h.st.curhist, -1, HIST_FOREIGN);
	let Some(top) = h.gethistent(start, -1) else {
		return Ok(Vec::new());
	};
	Ok((0..=top)
		.rev()
		.map(|i| (BString::from(h.num_at(i).to_string()), BString::from(h.text_at(i))))
		.collect())
}

/// `$history[key]` (zsh/parameter `getpmhistory`): the event numbered
/// `key` (digits only).
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn history_elem(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	key: &[u8],
) -> Result<Option<BString>, StoreError> {
	let ok =
		key == b"0" || (!key.is_empty() && key[0] != b'0' && key.iter().all(u8::is_ascii_digit));
	if !ok {
		return Ok(None);
	}
	let h = load(root, store, vp)?;
	Ok(h
		.index_of(int_value(key))
		.map(|i| BString::from(h.text_at(i))))
}

/// `$historywords` (zsh/parameter `histwgetfn`): every event's words,
/// newest event and last word first, from the event before the latest.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn historywords_param(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<BString>, StoreError> {
	let h = load(root, store, vp)?;
	let start = h.addhistnum(h.st.curhist, -1, HIST_FOREIGN);
	let Some(top) = h.gethistent(start, -1) else {
		return Ok(Vec::new());
	};
	let mut out = Vec::new();
	for i in (0..=top).rev() {
		let text = h.text_at(i);
		let words = h.words_at(i);
		for w in words.chunks(2).rev() {
			let (s, e) = (w[0] as usize, w[1] as usize);
			out.push(BString::from(text.get(s..e.min(text.len())).unwrap_or_default()));
		}
	}
	Ok(out)
}

/// `HISTSIZE` (`save` false) or `SAVEHIST`: `None` once unset. An
/// assignment after `unset` lands in a plain variable of that name: it is
/// taken over here (zsh revives the special).
///
/// # Errors
/// [`StoreError`] when the state cannot be read.
pub fn size_param(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	save: bool,
) -> Result<Option<i64>, StoreError> {
	let st = load_state(root, store, vp)?;
	let unset = if save {
		st.savehist_unset
	} else {
		st.histsiz_unset
	};
	let name: &[u8] = if save { b"SAVEHIST" } else { b"HISTSIZE" };
	if unset && let Some(v) = var(root, store, vp, name)? {
		state::unset_var(root, store, vp, name, true);
		set_size_param(root, store, vp, save, Some(int_value(&v)))?;
	}
	let st = load_state(root, store, vp)?;
	Ok(if save {
		(!st.savehist_unset).then_some(st.savehistsiz)
	} else {
		(!st.histsiz_unset).then_some(st.histsiz)
	})
}

/// Assign `HISTSIZE` (at least 1; the list shrinks at once, zsh
/// `resizehistents`) or `SAVEHIST` (at least 0); `None` unsets.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn set_size_param(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	save: bool,
	v: Option<i64>,
) -> Result<(), StoreError> {
	if save {
		let mut st = load_state(root, store, vp)?;
		if let Some(v) = v {
			st.savehistsiz = v.max(0);
			st.savehist_unset = false;
		} else {
			st.savehist_unset = true;
			state::unset_var(root, store, vp, b"SAVEHIST", true);
		}
		Hist::save_state(&st, root, store, vp);
		return Ok(());
	}
	let dups_first = zopt(root, store, vp, ZshOpt::Histexpiredupsfirst)?;
	let mut h = load(root, store, vp)?;
	if let Some(v) = v {
		h.st.histsiz = v.max(1);
		h.st.histsiz_unset = false;
		h.resize(dups_first);
	} else {
		h.st.histsiz_unset = true;
		state::unset_var(root, store, vp, b"HISTSIZE", true);
	}
	h.save(root, store, vp);
	Ok(())
}

/// `histchars` / `HISTCHARS`.
///
/// # Errors
/// [`StoreError`] when the state cannot be read.
pub fn histchars_param(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<BString, StoreError> {
	let st = load_state(root, store, vp)?;
	Ok(BString::from(
		st.chars
			.iter()
			.copied()
			.take_while(|&c| c != 0)
			.collect::<Vec<u8>>(),
	))
}

/// Assign `histchars` (zsh `histcharssetfn`): up to three ASCII
/// characters; `Err` holds the warning when one is not ASCII.
///
/// # Errors
/// [`StoreError`] when the state cannot be read.
pub fn set_histchars_param(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	v: &[u8],
) -> Result<Result<(), Diag>, StoreError> {
	let v = &v[..v.len().min(3)];
	if !v.is_ascii() {
		return Ok(Err(Diag::Warning { msg: "HISTCHARS can only contain ASCII characters".into() }));
	}
	let mut st = load_state(root, store, vp)?;
	st.chars = [
		v.first().copied().unwrap_or(0),
		v.get(1).copied().unwrap_or(0),
		v.get(2).copied().unwrap_or(0),
	];
	Hist::save_state(&st, root, store, vp);
	Ok(Ok(()))
}

/// Whether the shell's input lines join the history (zsh `hbegin`: an
/// interactive shell reading standard input).
///
/// # Errors
/// [`StoreError`] when an option cannot be read.
pub fn active(root: &mut Root, store: &mut dyn StateStore, vp: &Vproc) -> Result<bool, StoreError> {
	Ok(zopt(root, store, vp, ZshOpt::Interactive)? && zopt(root, store, vp, ZshOpt::Shinstdin)?)
}

/// The options the history file code reads.
///
/// # Errors
/// [`StoreError`] when an option or variable cannot be read.
pub fn file_opts(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	pid: u32,
	euid: u32,
) -> Result<FileOpts, StoreError> {
	let mut o = FileOpts {
		interactive: zopt(root, store, vp, ZshOpt::Interactive)?,
		extended: zopt(root, store, vp, ZshOpt::Extendedhistory)?,
		append: zopt(root, store, vp, ZshOpt::Appendhistory)?,
		incappend: zopt(root, store, vp, ZshOpt::Incappendhistory)?,
		incappendtime: zopt(root, store, vp, ZshOpt::Incappendhistorytime)?,
		share: zopt(root, store, vp, ZshOpt::Sharehistory)?,
		savenodups: zopt(root, store, vp, ZshOpt::Histsavenodups)?,
		savebycopy: zopt(root, store, vp, ZshOpt::Histsavebycopy)?,
		fcntllock: zopt(root, store, vp, ZshOpt::Histfcntllock)?,
		lexwords: zopt(root, store, vp, ZshOpt::Histlexwords)?,
		comments: zopt(root, store, vp, ZshOpt::Interactivecomments)?,
		dups_first: zopt(root, store, vp, ZshOpt::Histexpiredupsfirst)?,
		ignorealldups: zopt(root, store, vp, ZshOpt::Histignorealldups)?,
		histfile: var(root, store, vp, b"HISTFILE")?.filter(|f| !f.is_empty()),
		ignore: None,
		pid,
		host: var(root, store, vp, b"HOST")?.unwrap_or_default(),
		euid,
		skip_flags: 0,
	};
	if let Some(pat) = var(root, store, vp, b"HISTORY_IGNORE")? {
		let popts = crate::bash::pattern::zsh::Opts {
			extended_glob: zopt(root, store, vp, ZshOpt::Extendedglob)?,
			ksh_glob: zopt(root, store, vp, ZshOpt::Kshglob)?,
			sh_glob: zopt(root, store, vp, ZshOpt::Shglob)?,
			case_glob: zopt(root, store, vp, ZshOpt::Caseglob)?,
			case_paths: zopt(root, store, vp, ZshOpt::Casepaths)?,
			..crate::bash::pattern::zsh::Opts::default()
		};
		o.ignore = FileOpts::compile_ignore(&pat, &popts);
	}
	Ok(o)
}

/// [`file_opts`] for the shell `k` runs.
fn file_opts_k(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Result<FileOpts, StoreError> {
	let euid = cx.host.user().euid;
	file_opts(&mut k.root, cx.store, vp, k.shell_pid, euid)
}

/// Run a history operation's steps from the reader: each unanswered step
/// is performed with the reader's scratch `sc` and `op` runs again; `Err`
/// is the wait key while a step is pending.
///
/// # Errors
/// The [`WaitKey`] to park on.
pub fn drive<T>(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	base: u32,
	mut op: impl FnMut(&mut Steps<'_>) -> Result<T, Pending>,
) -> Result<T, WaitKey> {
	loop {
		let res = {
			let look = |p: &Probe| probe::cached(sc, p).cloned();
			let mut steps = Steps::new(&look, base);
			op(&mut steps)
		};
		match res {
			Ok(v) => return Ok(v),
			Err(Pending(p)) => {
				probe::perform(k, cx, vp, sc, &p)?;
			},
		}
	}
}

/// Replay an editing operation from the authoritative store after a pending
/// step. The successful attempt owns the cached events instead of sharing a
/// full-list retry snapshot with itself.
fn drive_hist<T>(
	k: &Kernel,
	cx: &mut Cx<'_>,
	vp: &Vproc,
	sc: &mut Scratch,
	base: u32,
	mut op: impl FnMut(Hist, &mut Steps<'_>) -> Result<T, Pending>,
) -> Result<Result<T, StoreError>, WaitKey> {
	loop {
		let mut h = match Hist::take(&k.root, cx.store, vp) {
			Ok(h) => h,
			Err(e) => return Ok(Err(e)),
		};
		if let Err(e) = init_state(&mut h.st, &k.root, cx.store, vp) {
			return Ok(Err(e));
		}
		let res = {
			let look = |p: &Probe| probe::cached(sc, p).cloned();
			let mut steps = Steps::new(&look, base);
			op(h, &mut steps)
		};
		match res {
			Ok(v) => return Ok(Ok(v)),
			Err(Pending(p)) => {
				probe::perform(k, cx, vp, sc, &p)?;
			},
		}
	}
}

/// Run a history operation's steps from a builtin (the builtin runs again
/// once a step is answered).
///
/// # Errors
/// [`Need::Probe`] for the next unanswered step.
pub fn in_builtin<T>(
	ctx: &Ctx<'_, '_>,
	op: impl FnOnce(&mut Steps<'_>) -> Result<T, Pending>,
) -> Result<T, Need> {
	let look = |p: &Probe| ctx.probe(p.clone()).ok();
	let mut steps = Steps::new(&look, 0);
	op(&mut steps).map_err(|Pending(p)| Need::Probe(p))
}

/// Queue zsh's messages (`zerr`/`zwarn` texts) as diagnostics.
fn report_k(k: &mut Kernel, cx: &mut Cx<'_>, vp: &mut Vproc, r: Report) {
	for m in r.msgs {
		k.diag(cx, vp, 0, Diag::Usage { msg: m.to_str_lossy().into_owned().into() });
	}
}

/// zsh `hbegin(1)` for the next event of an interactive shell reading
/// standard input: the line being read is linked at the top of the ring
/// as event `curhist + 1`, the default event (`!!`) is the one before;
/// under `incappendhistorytime` (alone) the file gets the new events.
/// Call it before the first line of each event, when [`active`].
///
/// # Errors
/// The [`WaitKey`] to park on (call again once woken).
pub fn hbegin(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
) -> Result<(), WaitKey> {
	let loaded = (|| -> Result<(FileOpts, bool, bool, bool), StoreError> {
		let o = file_opts_k(k, cx, vp)?;
		let bang = zopt(&mut k.root, cx.store, vp, ZshOpt::Banghist)?;
		let comments = zopt(&mut k.root, cx.store, vp, ZshOpt::Interactivecomments)?;
		let rcs = zopt(&mut k.root, cx.store, vp, ZshOpt::Rcs)?;
		Ok((o, bang, comments, rcs))
	})();
	let (o, banghist, comments, rcs) = match loaded {
		Ok(v) => v,
		Err(e) => {
			k.fail(e);
			return Ok(());
		},
	};
	let stack0 = match super::zfc::stack_load(cx.store, vp) {
		Ok(s) => s,
		Err(e) => {
			k.fail(e);
			return Ok(());
		},
	};
	let ll = super::zfc::locallevel(vp);
	let now = cx.host.wall().secs;
	let result = drive_hist(k, cx, vp, sc, BASE_HBEGIN, |mut h, steps| {
		let mut r = Report::default();
		// zsh `endparamscope`: levels `fc -a -p` pushed in functions that
		// have returned are saved and popped.
		let mut stack = stack0.clone();
		let (_, set) = super::zfc::save_and_pop(
			&mut h,
			&mut stack,
			steps,
			&o,
			0,
			HFILE_USE_OPTIONS,
			ll,
			false,
			&mut r,
		)?;
		let mut o = o.clone();
		if let super::zfc::HistfileRestore::Set(hf) = &set {
			o.histfile = hf.clone().filter(|f| !f.is_empty());
		}
		// zsh reads the file once its startup files ran (end of `init_misc`).
		if !h.st.started {
			h.st.started = true;
			if o.interactive && rcs {
				let mut l = Locks::default();
				file::readhistfile(&mut h, steps, &o, &mut l, None, false, HFILE_USE_OPTIONS, &mut r)?;
			}
		}
		if h.entries.last().is_some_and(|top| top.ftim == 0)
			&& let Some(top) = h.events_mut().last_mut()
		{
			top.ftim = now;
		}
		h.st.histactive = HA_ACTIVE;
		h.st.curhist += 1;
		h.st.linked = true;
		h.st.curline_num = h.st.curhist;
		let defev = h.addhistnum(h.st.curhist, -1, HIST_FOREIGN);
		h.curline = Some(LineState {
			disabled: !banghist,
			defev,
			comments,
			lex: Lex::new(),
			..LineState::default()
		});
		if o.incappendtime && !o.share && !o.incappend {
			let mut l = Locks::default();
			file::savehistfile(
				&mut h,
				steps,
				&o,
				&mut l,
				None,
				false,
				HFILE_USE_OPTIONS | HFILE_FAST,
				&mut r,
			)?;
		}
		Ok(((h, r), stack, set))
	})?;
	let (h, stack, set) = match result {
		Ok(v) => v,
		Err(e) => {
			k.fail(e);
			return Ok(());
		},
	};
	let (h, r) = h;
	h.save(&mut k.root, cx.store, vp);
	if stack.len() != stack0.len() {
		super::zfc::stack_save(&stack, &mut k.root, cx.store, vp);
	}
	if let super::zfc::HistfileRestore::Set(hf) = set {
		let var = hf.map(|v| state::Var::scalar(v, crate::bash::store::Attrs::NONE));
		state::store_var(&mut k.root, cx.store, vp, b"HISTFILE", var, state::Level::Global);
	}
	report_k(k, cx, vp, r);
	Ok(())
}

/// The result of [`expand`].
#[derive(Debug)]
pub enum Expanded {
	/// The line as the parser reads it.
	Line(BString),
	/// History expansion failed: the event is abandoned (`$?` becomes 1
	/// when it was 0); the message to print, if any.
	Failed(Option<Diag>),
}

/// The options history expansion reads.
fn bang_opts(k: &mut Kernel, cx: &mut Cx<'_>, vp: &Vproc) -> Result<BangOpts, StoreError> {
	Ok(BangOpts {
		cshjunkie:    zopt(&mut k.root, cx.store, vp, ZshOpt::Cshjunkiehistory)?,
		verify:       zopt(&mut k.root, cx.store, vp, ZshOpt::Histverify)?,
		substpattern: zopt(&mut k.root, cx.store, vp, ZshOpt::Histsubstpattern)?,
		cwd:          vp.cwd.clone(),
		path:         var(&k.root, cx.store, vp, b"PATH")?.unwrap_or_default(),
		bash:         false,
		multibyte:    zopt(&mut k.root, cx.store, vp, ZshOpt::Multibyte)?
			&& crate::bash::vm::locale::is_utf8(k, cx.store, vp),
	})
}

/// zsh's history expansion of one input line of the event [`hbegin`]
/// started (`line` with its newline): the text to parse, or the failure
/// to report. Without an event begun the line is returned as is.
///
/// # Errors
/// The [`WaitKey`] to park on (call again with the same line once woken).
pub fn expand(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	line: &[u8],
) -> Result<Expanded, WaitKey> {
	let loaded = (|| -> Result<(Hist, BangOpts), StoreError> {
		Ok((load(&k.root, cx.store, vp)?, bang_opts(k, cx, vp)?))
	})();
	let (h0, o) = match loaded {
		Ok(v) => v,
		Err(e) => {
			k.fail(e);
			return Ok(Expanded::Line(BString::from(line)));
		},
	};
	if h0.curline.is_none() {
		return Ok(Expanded::Line(BString::from(line)));
	}
	let (h, res) = drive(k, cx, vp, sc, BASE_EXPAND, |steps| {
		let mut h = h0.clone();
		match bang::expand_line(&mut h, line, &o, steps) {
			Ok(text) => Ok((h, Expanded::Line(text))),
			Err(bang::Stop::Pending(p)) => Err(p),
			Err(bang::Stop::Error(e)) => {
				if let Some(ls) = &mut h.curline {
					ls.failed = true;
				}
				Ok((h, Expanded::Failed(e.0)))
			},
		}
	})?;
	h.save(&mut k.root, cx.store, vp);
	Ok(res)
}

/// zsh `doexpandhist` for ZLE's `expand-history` and `magic-space`: the
/// edited line `line` (raw bytes, no newline) with its history references
/// expanded and the cursor `cs` (byte offset) moved along; `None` when the
/// expansion fails (silently, as with `noerrs`) or changes nothing. No event
/// is added; the `:s` strings and the last `!?str?` match stay set.
///
/// # Errors
/// The [`WaitKey`] to park on (`:A`, `:P`, `:c` steps; call again with the
/// same scratch once woken).
pub fn expand_zle(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	line: &[u8],
	cs: usize,
) -> Result<Option<(BString, usize)>, WaitKey> {
	let loaded = (|| -> Result<(Hist, BangOpts), StoreError> {
		Ok((load(&k.root, cx.store, vp)?, bang_opts(k, cx, vp)?))
	})();
	let (h0, o) = match loaded {
		Ok(v) => v,
		Err(e) => {
			k.fail(e);
			return Ok(None);
		},
	};
	let (st, res) = drive(k, cx, vp, sc, BASE_ZLE, |steps| {
		let mut h = h0.clone();
		match bang::expand_for_zle(&mut h, line, cs, &o, steps) {
			Ok(r) => Ok((h.st, r)),
			Err(bang::Stop::Pending(p)) => Err(p),
			Err(bang::Stop::Error(_)) => Ok((h.st, None)),
		}
	})?;
	let mut cur = h0.st;
	cur.hsubl = st.hsubl;
	cur.hsubr = st.hsubr;
	cur.marg = st.marg;
	cur.mev = st.mev;
	Hist::save_state(&cur, &mut k.root, cx.store, vp);
	Ok(res)
}

/// The first argument of `preexec` (zsh `loop`): the text of the newest
/// event when it is the line just read (`curline.histnum == curhist`),
/// else empty.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn latest_text(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<BString, StoreError> {
	let h = load(root, store, vp)?;
	Ok(match h.entries.last() {
		Some(e) if h.st.curline_num == h.st.curhist => e.text.clone(),
		_ => BString::default(),
	})
}

/// Where the reader stands with the event being read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventState {
	/// No event begun: call [`hbegin`] before reading.
	None,
	/// An event is being read.
	Open,
	/// History expansion failed on it: call [`hend`] (with no parsed
	/// event) before going on.
	Failed,
}

/// [`EventState`] of `vp`.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn event_state(store: &mut dyn StateStore, vp: &Vproc) -> Result<EventState, StoreError> {
	Ok(match Hist::load_line(store, vp)? {
		None => EventState::None,
		Some(ls) if ls.failed => EventState::Failed,
		Some(_) => EventState::Open,
	})
}

/// What the reader does before it reads a line: the `hend` of an event a
/// failed expansion abandoned (`Hend::failed`: set `$?` to 1 when it was
/// 0), or of one whose lines held no command (blank lines, a comment: zsh
/// ends an event at every line the parser finishes, whether or not it
/// found a command); then [`hbegin`] when no event is open. Show the
/// returned output.
///
/// # Errors
/// The [`WaitKey`] to park on (call again once woken).
pub fn before_line(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
) -> Result<Option<Hend>, WaitKey> {
	let state = match event_state(cx.store, vp) {
		Ok(s) => s,
		Err(e) => {
			k.fail(e);
			return Ok(None);
		},
	};
	let mut out = None;
	let mut open = state == EventState::Open;
	if state == EventState::Failed {
		let mut h = hend(k, cx, vp, sc, None, 0)?;
		h.failed = true;
		out = Some(h);
	} else if open {
		let empty = match Hist::load_line(cx.store, vp) {
			Ok(Some(ls)) => {
				!ls.chline.is_empty() && ls.lex.idle() && lex_words(&ls.chline, ls.comments).is_empty()
			},
			Ok(None) => false,
			Err(e) => {
				k.fail(e);
				false
			},
		};
		if empty {
			out = Some(hend(k, cx, vp, sc, None, 0)?);
			open = false;
		}
	}
	if !open {
		hbegin(k, cx, vp, sc)?;
	}
	Ok(out)
}

/// [`ProgInfo`] of a parsed event whose source is `src`.
pub fn prog_info(cc: &crate::bash::syntax::CompleteCommand, src: &[u8]) -> ProgInfo {
	use crate::bash::syntax::tree::CommandKind;
	let Some(item) = cc.list().items().first() else {
		return ProgInfo::default();
	};
	let ao = item.and_or();
	let funcdef = ao.rest().len() == 0
		&& ao
			.first()
			.stages()
			.one()
			.is_some_and(|c| matches!(c.kind(), CommandKind::FuncDef(_)));
	let (lo, hi) = (ao.span().lo as usize, ao.span().hi as usize);
	let text = BString::from(src.get(lo..hi.min(src.len())).unwrap_or_default());
	ProgInfo { funcdef, text }
}

/// zsh `zexit`'s history save (`saveandpophiststack(1, …)` then
/// `savehistfile(NULL, 1, …)`) as a [`Steps`] operation; `signal`: the
/// shell ends on a signal (no rewrite of the file).
fn exit_op(
	h: &mut Hist,
	stack: &mut Vec<super::zfc::StackLevel>,
	steps: &mut Steps<'_>,
	o: &FileOpts,
	ll: i64,
	signal: bool,
	r: &mut Report,
) -> Result<(), Pending> {
	let flags = HFILE_USE_OPTIONS | if signal { HFILE_NO_REWRITE } else { 0 };
	let (_, set) = super::zfc::save_and_pop(h, stack, steps, o, 1, flags, ll, false, r)?;
	let mut fo = o.clone();
	if let super::zfc::HistfileRestore::Set(hf) = set {
		fo.histfile = hf.filter(|f| !f.is_empty());
	}
	let mut l = Locks::default();
	file::savehistfile(h, steps, &fo, &mut l, None, true, flags, r)
}

/// Whether the shell saves its history when it exits (zsh: `RCS` and
/// interactive, not a subshell).
fn saves_at_exit(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<bool, StoreError> {
	Ok(vp.parent.is_none()
		&& !crate::bash::vm::is_tool(store, vp)?
		&& !crate::bash::vm::nested::in_subshell(store, vp)
		&& zopt(root, store, vp, ZshOpt::Rcs)?
		&& zopt(root, store, vp, ZshOpt::Interactive)?)
}

/// The history save of an interactive shell ending at the end of its
/// input (zsh `zexit`), from the reader.
///
/// # Errors
/// The [`WaitKey`] to park on (call again once woken).
pub fn exit_save(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
) -> Result<(), WaitKey> {
	let loaded =
		(|| -> Result<Option<(Hist, Vec<super::zfc::StackLevel>, FileOpts)>, StoreError> {
			if !saves_at_exit(&mut k.root, cx.store, vp)? {
				return Ok(None);
			}
			let h = load(&k.root, cx.store, vp)?;
			let stack = super::zfc::stack_load(cx.store, vp)?;
			let o = file_opts_k(k, cx, vp)?;
			Ok(Some((h, stack, o)))
		})();
	let (h0, stack0, o) = match loaded {
		Ok(Some(v)) => v,
		Ok(None) => return Ok(()),
		Err(e) => {
			k.fail(e);
			return Ok(());
		},
	};
	let ll = super::zfc::locallevel(vp);
	let (h, stack, r) = drive(k, cx, vp, sc, BASE_FILE, |steps| {
		let mut h = h0.clone();
		let mut stack = stack0.clone();
		let mut r = Report::default();
		exit_op(&mut h, &mut stack, steps, &o, ll, false, &mut r)?;
		Ok((h, stack, r))
	})?;
	h.save(&mut k.root, cx.store, vp);
	super::zfc::stack_save(&stack, &mut k.root, cx.store, vp);
	report_k(k, cx, vp, r);
	Ok(())
}

/// [`exit_save`] from `exit`/`logout`.
///
/// # Errors
/// [`Need::Probe`] for the next filesystem step.
pub fn exit_save_in_builtin(ctx: &mut Ctx<'_, '_>) -> Result<(), Need> {
	if !saves_at_exit(&mut ctx.k.root, ctx.cx.store, ctx.vp)? {
		return Ok(());
	}
	let h0 = load(&ctx.k.root, ctx.cx.store, ctx.vp)?;
	let stack0 = super::zfc::stack_load(ctx.cx.store, ctx.vp)?;
	let euid = ctx.cx.host.user().euid;
	let o = file_opts(&mut ctx.k.root, ctx.cx.store, ctx.vp, ctx.k.shell_pid, euid)?;
	let ll = super::zfc::locallevel(ctx.vp);
	let (h, stack, r) = in_builtin(ctx, |steps| {
		let mut h = h0.clone();
		let mut stack = stack0.clone();
		let mut r = Report::default();
		exit_op(&mut h, &mut stack, steps, &o, ll, false, &mut r)?;
		Ok((h, stack, r))
	})?;
	h.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	super::zfc::stack_save(&stack, &mut ctx.k.root, ctx.cx.store, ctx.vp);
	for m in r.msgs {
		ctx.diag(Diag::Usage { msg: m.to_str_lossy().into_owned().into() });
	}
	Ok(())
}

/// The argument of the `zshaddhistory` hook for the event being read: its
/// history text with the final newline, when there is one and the event is
/// to be recorded. The reader runs `zshaddhistory` and the functions in
/// `zshaddhistory_functions` with it and passes [`hend`] the first nonzero
/// status (zsh `callhookfunc`).
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn hook_text(store: &mut dyn StateStore, vp: &Vproc) -> Result<Option<BString>, StoreError> {
	let st = Hist::load_state(store, vp)?;
	let line = Hist::load_line(store, vp)?;
	Ok(match line {
		Some(ls) if st.histactive & HA_NOINC == 0 && !ls.chline.is_empty() => Some(ls.chline),
		_ => None,
	})
}

/// What the parser made of the event, for `histnofunctions` and
/// `histnostore` (zsh `should_ignore_line`).
#[derive(Clone, Debug, Default)]
pub struct ProgInfo {
	/// The event is a function definition (a simple list whose first
	/// command is one).
	pub funcdef: bool,
	/// Its first command's text (zsh `getjobtext`).
	pub text:    BString,
}

/// What [`hend`] decided.
#[derive(Clone, Debug, Default)]
pub struct Hend {
	/// Run the event (false after `:p`, under `histverify` after an
	/// expansion, or after a failed expansion).
	pub run:    bool,
	/// The event's text to print on the terminal before it runs (an
	/// expansion happened, not `histverify`): zsh writes it with a newline
	/// to its terminal output (`shout`, standard error when there is no
	/// terminal).
	pub print:  Option<BString>,
	/// The expanded line to give back to the editor (`histverify`).
	pub recall: Option<BString>,
	/// Messages to print (`sharehistory`/`incappendhistory` file errors).
	pub msgs:   Vec<BString>,
	/// The event was abandoned by a failed expansion: `$?` becomes 1 when
	/// it was 0 (zsh `loop` after `LEXERR`).
	pub failed: bool,
}

/// zsh `histreduceblanks` on `chline` with word bounds `words`.
fn reduce_blanks(chline: &mut Vec<u8>, words: &mut [u32], ignorespace: bool) {
	let spacecount = if ignorespace {
		chline.iter().take_while(|&&c| c == b' ').count()
	} else {
		0
	};
	let n = words.len() / 2;
	let mut len = spacecount;
	for i in 0..n {
		len += (words[2 * i + 1] - words[2 * i]) as usize
			+ usize::from(i > 0 && words[2 * i] > words[2 * i - 1]);
	}
	if len >= chline.len() {
		return;
	}
	let lastptr = if n > 0 { words[2 * n - 1] as usize } else { 0 };
	let mut pos = spacecount;
	for i in 0..n {
		let (start, end) = (words[2 * i] as usize, words[2 * i + 1] as usize);
		let wlen = end - start;
		let needblank = usize::from(i + 1 < n && words[2 * i + 2] > words[2 * i + 1]);
		if pos != start {
			chline.copy_within(start..start + wlen + needblank, pos);
			words[2 * i] = pos as u32;
			words[2 * i + 1] = (pos + wlen) as u32;
		}
		pos += wlen + needblank;
	}
	let tail = chline[lastptr..].to_vec();
	if tail.iter().all(|&c| super::model::inblank(c)) {
		chline.truncate(pos);
	} else if pos < lastptr {
		chline.truncate(pos);
		chline.extend_from_slice(&tail);
	}
}

/// zsh `should_ignore_line`.
fn should_ignore(
	store: &mut dyn StateStore,
	vp: &Vproc,
	chline: &[u8],
	prog: Option<&ProgInfo>,
	ignorespace: bool,
	nofunctions: bool,
	nostore: bool,
) -> Result<bool, StoreError> {
	if ignorespace && chline.first() == Some(&b' ') {
		return Ok(true);
	}
	let Some(prog) = prog else {
		return Ok(false);
	};
	if nofunctions && prog.funcdef {
		return Ok(true);
	}
	if nostore {
		let mut b: &[u8] = &prog.text;
		let saw_builtin = b.starts_with(b"builtin ");
		if saw_builtin {
			b = &b[8..];
		}
		let func = |store: &mut dyn StateStore, name: &str| -> Result<bool, StoreError> {
			Ok(state::record(store, vp, Key::Func(name.as_bytes().as_bstr()))?.is_some())
		};
		if b.starts_with(b"history")
			&& matches!(b.get(7), None | Some(b' '))
			&& (saw_builtin || !func(store, "history")?)
		{
			return Ok(true);
		}
		if b.first() == Some(&b'r')
			&& matches!(b.get(1), None | Some(b' '))
			&& (saw_builtin || !func(store, "r")?)
		{
			return Ok(true);
		}
		if b.starts_with(b"fc -") && (saw_builtin || !func(store, "fc")?) {
			let letters = b[4..].iter().take_while(|c| c.is_ascii_alphabetic());
			if letters.clone().any(|&c| c == b'l') {
				return Ok(true);
			}
		}
	}
	Ok(false)
}

/// zsh `hend`: the event read since [`hbegin`] ends; its history text joins
/// the list unless an option or the hook (`hookret`: 1 drop, 2 keep but do
/// not write) says otherwise; `sharehistory` reads the new lines of the
/// file first, `incappendhistory`/`sharehistory` write the new events
/// after. `prog` is the parsed event (`None` when it did not parse).
///
/// # Errors
/// The [`WaitKey`] to park on (call again once woken).
#[allow(clippy::too_many_lines, reason = "a faithful port of one C function")]
pub fn hend(
	k: &mut Kernel,
	cx: &mut Cx<'_>,
	vp: &mut Vproc,
	sc: &mut Scratch,
	prog: Option<&ProgInfo>,
	hookret: i32,
) -> Result<Hend, WaitKey> {
	struct Flags {
		ignorespace: bool,
		ignoredups:  bool,
		reduce:      bool,
		ignore:      bool,
		pushed:      bool,
	}
	let loaded = (|| -> Result<(FileOpts, Flags), StoreError> {
		let line = Hist::load_line(cx.store, vp)?;
		let o = file_opts_k(k, cx, vp)?;
		let ignorespace = zopt(&mut k.root, cx.store, vp, ZshOpt::Histignorespace)?;
		let nofunctions = zopt(&mut k.root, cx.store, vp, ZshOpt::Histnofunctions)?;
		let nostore = zopt(&mut k.root, cx.store, vp, ZshOpt::Histnostore)?;
		let chline = line.as_ref().map_or_default(|l| l.chline.clone());
		let ignore = should_ignore(cx.store, vp, &chline, prog, ignorespace, nofunctions, nostore)?;
		let f = Flags {
			ignorespace,
			ignoredups: zopt(&mut k.root, cx.store, vp, ZshOpt::Histignoredups)?,
			reduce: zopt(&mut k.root, cx.store, vp, ZshOpt::Histreduceblanks)?,
			ignore,
			pushed: super::zfc::stack_depth(cx.store, vp)? != 0,
		};
		Ok((o, f))
	})();
	let (o, f) = match loaded {
		Ok(v) => v,
		Err(e) => {
			k.fail(e);
			return Ok(Hend { run: true, ..Hend::default() });
		},
	};
	let now = cx.host.wall().secs;
	let result = drive_hist(k, cx, vp, sc, BASE_HEND, |mut h, steps| {
		let mut out = Hend::default();
		let mut r = Report::default();
		let Some(ls) = h.curline.take() else {
			out.run = true;
			return Ok((h, out, r));
		};
		if h.st.histactive & HA_NOINC == 0 && h.st.linked {
			h.st.linked = false;
			h.st.curhist -= 1;
		}
		if h.st.histactive & HA_NOINC != 0 {
			h.st.histactive = 0;
			out.run = true;
			return Ok((h, out, r));
		}
		if h.st.ignore_all_dups != o.ignorealldups {
			h.st.ignore_all_dups = o.ignorealldups;
			if o.ignorealldups {
				h.remove_dups();
			}
		}
		let mut l = Locks::default();
		let hf = o.histfile.clone();
		// zsh locks the file once for both the read and the write.
		if o.share
			&& let Some(hf) = &hf
			&& file::lock(steps, &mut l, &o, hf, false)?
		{
			let flags = HFILE_USE_OPTIONS | HFILE_FAST;
			file::readhistfile(&mut h, steps, &o, &mut l, Some(hf), false, flags, &mut r)?;
			h.st.curline_num = h.st.curhist + 1;
		}
		let flag = ls.done;
		let mut chline: Vec<u8> = ls.chline.to_vec();
		let mut save: i32 = if chline.is_empty() {
			0
		} else {
			let only_newline = chline.as_slice() == b"\n";
			if chline.len() > 1 && chline.last() == Some(&b'\n') {
				chline.pop();
			}
			let nwords =
				lex_words(&ls.chline, ls.comments).len() / 2 + usize::from(ls.chline.ends_with(b"\n"));
			if nwords <= 1 && !ls.lex.had_comment {
				0
			} else if f.ignore {
				-1
			} else if hookret == 2 {
				-2
			} else if hookret != 0 {
				-1
			} else {
				i32::from(!only_newline)
			}
		};
		if flag & (HISTFLAG_DONE | HISTFLAG_RECALL) != 0 {
			if flag & (HISTFLAG_DONE | HISTFLAG_RECALL) == HISTFLAG_DONE {
				out.print = Some(BString::from(chline.clone()));
			}
			if flag & HISTFLAG_RECALL != 0 {
				out.recall = Some(BString::from(chline.clone()));
				save = 0;
			}
		}
		if save != 0 || chline.first() == Some(&b' ') {
			// A temporary event (`histignorespace`, the hook's 1) goes now.
			if let Some(i) = (0..h.entries.len())
				.rev()
				.find(|&i| h.entries[i].flags & HIST_FOREIGN == 0)
				&& h.entries[i].flags & HIST_TMPSTORE != 0
			{
				if i + 1 == h.entries.len() {
					h.st.curline_num = h.st.curhist;
					h.st.curhist -= 1;
				}
				h.remove(i);
			}
		}
		if save != 0 {
			let mut words = lex_words(&chline, ls.comments);
			if f.reduce {
				reduce_blanks(&mut chline, &mut words, f.ignorespace);
			}
			let mut newflags = match save {
				-1 => HIST_TMPSTORE,
				-2 => HIST_NOWRITE,
				_ => 0,
			};
			let same_top = (f.ignoredups || o.ignorealldups)
				&& save > 0
				&& h
					.entries
					.last()
					.is_some_and(|top| super::model::same_text(&chline, &top.text));
			let i = if same_top {
				let i = h.entries.len() - 1;
				newflags |= h.entries[i].flags & HIST_OLD;
				h.st.curline_num = h.st.curhist;
				// zsh `freehistdata`: the old text leaves `histtab`.
				i
			} else {
				let i = h.prepnext(o.dups_first);
				h.st.curline_num = h.entries[i].num;
				i
			};
			{
				let he = &mut h.events_mut()[i];
				he.text = BString::from(chline.clone());
				he.stim = now;
				he.ftim = 0;
				he.flags = newflags;
				he.words = words;
			}
			if newflags & HIST_TMPSTORE == 0 {
				h.addhistnode(i);
			}
		}
		h.st.histactive = 0;
		let write = if o.share {
			l.held()
		} else {
			o.incappend || (o.incappendtime && f.pushed)
		};
		if write && let Some(hf) = &hf {
			let flags = HFILE_USE_OPTIONS | HFILE_FAST;
			file::savehistfile(&mut h, steps, &o, &mut l, Some(hf), false, flags, &mut r)?;
		}
		if let Some(hf) = &hf {
			file::unlock(steps, &mut l, hf)?;
		}
		out.run = flag & HISTFLAG_NOEXEC == 0;
		Ok((h, out, r))
	})?;
	let (h, out, r) = match result {
		Ok(v) => v,
		Err(e) => {
			k.fail(e);
			return Ok(Hend { run: true, ..Hend::default() });
		},
	};
	h.save(&mut k.root, cx.store, vp);
	let mut out = out;
	out.msgs = r.msgs;
	Ok(out)
}
