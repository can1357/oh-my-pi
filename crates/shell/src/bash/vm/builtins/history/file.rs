//! zsh's history file (`hist.c` `readhistfile`, `savehistfile`,
//! `lockhistfile`, `unlockhistfile`, `flockhistfile`, `checklocktime`).
//!
//! The file is the one real zsh writes: one event per line, metafied, a
//! newline inside an event written as `\` + newline, a line ending in
//! backslashes followed by one space, and with `extendedhistory`
//! `: start:elapsed;` before the text (else a leading `:` escaped as
//! `\:`). Locking is zsh's: a symbolic link `$HISTFILE.LOCK` holding
//! `/pid-PID/host-HOST`, a stale one (ten seconds old) removed; with
//! `histfcntllock` an `fcntl` lock on the file itself.
//!
//! Every function here is a [`Steps`] operation: it runs again from the
//! start each time a step is answered, so it works on a copy of the
//! history its caller commits once it is done.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::{BString, ByteSlice};

use super::{
	io::{ErrKind, HistErr, HistOp, HistOut, Pending, Steps, WriteHow},
	model::{
		HA_ACTIVE, HIST_BLANKWORDS, HIST_DUP, HIST_FOREIGN, HIST_MAKEUNIQUE, HIST_NOWRITE, HIST_OLD,
		HIST_READ, HIST_TMPSTORE, Hist,
	},
	words::lex_words,
};
use crate::bash::{
	pattern::zsh::{CharEnv, PatFlags, Pattern},
	syntax::zsh::tok::{metafy, unmetafy},
};

/// Append to the file.
pub const HFILE_APPEND: u32 = 0x0001;
/// Skip (write) or mark unique (read) events already in the file.
pub const HFILE_SKIPOLD: u32 = 0x0002;
/// Skip duplicates.
pub const HFILE_SKIPDUPS: u32 = 0x0004;
/// Skip events from other shells.
pub const HFILE_SKIPFOREIGN: u32 = 0x0008;
/// Incremental read or write (`sharehistory`, `incappendhistory`).
pub const HFILE_FAST: u32 = 0x0010;
/// Do not rewrite the file after appending (exit on a signal).
pub const HFILE_NO_REWRITE: u32 = 0x0020;
/// Honour the history options.
pub const HFILE_USE_OPTIONS: u32 = 0x8000;

/// The options and process facts the file code reads.
#[derive(Clone, Debug, Default)]
pub struct FileOpts {
	/// The shell is interactive (zsh `interact`): nothing is saved
	/// otherwise.
	pub interactive:   bool,
	/// `extendedhistory`.
	pub extended:      bool,
	/// `appendhistory`.
	pub append:        bool,
	/// `incappendhistory`.
	pub incappend:     bool,
	/// `incappendhistorytime`.
	pub incappendtime: bool,
	/// `sharehistory`.
	pub share:         bool,
	/// `histsavenodups`.
	pub savenodups:    bool,
	/// `histsavebycopy`.
	pub savebycopy:    bool,
	/// `histfcntllock`.
	pub fcntllock:     bool,
	/// `histlexwords`.
	pub lexwords:      bool,
	/// `interactivecomments` (word splitting with `histlexwords`).
	pub comments:      bool,
	/// `histexpiredupsfirst`.
	pub dups_first:    bool,
	/// `histignorealldups`.
	pub ignorealldups: bool,
	/// `$HISTFILE`.
	pub histfile:      Option<BString>,
	/// `$HISTORY_IGNORE`, compiled (`None`: unset or a bad pattern).
	pub ignore:        Option<Pattern>,
	/// `$$`.
	pub pid:           u32,
	/// `$HOST`.
	pub host:          BString,
	/// The effective uid (`savehistfile`'s ownership check).
	pub euid:          u32,
	/// The skip flags of history navigation (`hist_skip_flags`).
	pub skip_flags:    u32,
}

impl FileOpts {
	/// Compile `$HISTORY_IGNORE` (zsh `tokenize` + `patcompile`).
	pub fn compile_ignore(text: &[u8], opts: &crate::bash::pattern::zsh::Opts) -> Option<Pattern> {
		let mut t = metafy(text);
		crate::bash::pattern::zsh::tokenize(&mut t);
		crate::bash::pattern::zsh::remnulargs(&mut t);
		Pattern::compile(&t, PatFlags::NONE, opts).ok()
	}
}

/// A message zsh prints (`zerr`/`zwarn` text, without the `zsh: `).
pub type Msg = BString;

/// What a file operation did: the messages to print, in order.
#[derive(Debug, Default)]
pub struct Report {
	/// Messages.
	pub msgs:  Vec<Msg>,
	/// An error (`zerr`) was reported: the builtin fails.
	pub error: bool,
}

impl Report {
	fn err(&mut self, m: impl Into<BString>) {
		self.msgs.push(m.into());
		self.error = true;
	}

	fn warn(&mut self, m: impl Into<BString>) {
		self.msgs.push(m.into());
	}
}

/// The locks one operation holds (zsh's statics `lockhistct`, `flock_fd`).
#[derive(Debug, Default)]
pub struct Locks {
	ct:    u32,
	flock: bool,
	/// The error of the last failed lock attempt (`%e`).
	errno: Option<HistErr>,
}

/// How a lock attempt ended (zsh: 0, 1, 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lock {
	Ok,
	Failed,
	Permanent,
}

/// `fn.LOCK`.
fn lockfile(fn_: &[u8]) -> BString {
	let mut l = BString::from(fn_);
	l.extend_from_slice(b".LOCK");
	l
}

/// zsh `zsleep_random` before the next lock attempt: up to `sleep_us`,
/// not past `end` (seconds).
fn backoff(steps: &mut Steps<'_>, sleep_us: u64, now: i64, end: i64) -> Result<(), Pending> {
	let left = u64::try_from((end - now).max(0))
		.unwrap_or(0)
		.saturating_mul(1_000_000);
	let us = sleep_us.min(left).max(1);
	// Sleep only waits for the host timer; its completed answer cannot fail.
	let _ = steps.ask(HistOp::Sleep { ns: us.saturating_mul(1000) })?;
	Ok(())
}

/// zsh `flockhistfile`.
fn flockhistfile(
	steps: &mut Steps<'_>,
	l: &mut Locks,
	fn_: &[u8],
	keep_trying: bool,
) -> Result<Lock, Pending> {
	if l.flock {
		return Ok(Lock::Ok);
	}
	let mut sleep_us: u64 = 0x10000;
	let start = steps.now()?;
	let end = start + 10;
	loop {
		match steps.ask(HistOp::Lock { path: fn_.into() })? {
			Ok(_) => {
				l.flock = true;
				return Ok(Lock::Ok);
			},
			// A missing file is "successfully" locked.
			Err(e) if e.kind == ErrKind::NotFound => return Ok(Lock::Ok),
			Err(e) if e.kind == ErrKind::WouldBlock => {
				l.errno = Some(e);
				let now = steps.now()?;
				if !keep_trying || now >= end {
					return Ok(Lock::Failed);
				}
				backoff(steps, sleep_us, now, end)?;
				sleep_us <<= 1;
			},
			Err(e) => {
				l.errno = Some(e);
				return Ok(Lock::Permanent);
			},
		}
	}
}

/// zsh `lockhistfile`: `Ok`, `Failed` this time, or `Permanent`.
fn lockhistfile(
	steps: &mut Steps<'_>,
	l: &mut Locks,
	o: &FileOpts,
	fn_: &[u8],
	keep_trying: bool,
) -> Result<Lock, Pending> {
	let was = l.ct;
	l.ct += 1;
	if was != 0 {
		return Ok(Lock::Ok);
	}
	if o.fcntllock {
		let r = flockhistfile(steps, l, fn_, keep_trying)?;
		if r != Lock::Ok {
			l.ct -= 1;
		}
		return Ok(r);
	}
	let lock = lockfile(fn_);
	let target = BString::from(format!("/pid-{}/host-{}", o.pid, o.host.to_str_lossy()));
	let mut sleep_us: u64 = 0x10000;
	let mut ret = Lock::Ok;
	let mut got = false;
	loop {
		match steps.ask(HistOp::Symlink { target: target.clone(), path: lock.clone() })? {
			Ok(_) => {
				got = true;
				break;
			},
			Err(e) if e.kind != ErrKind::Exists => {
				l.errno = Some(e);
				ret = Lock::Permanent;
				break;
			},
			Err(e) => {
				l.errno = Some(e);
				if !keep_trying {
					ret = Lock::Failed;
					break;
				}
			},
		}
		let then = match steps.ask(HistOp::Stat { path: lock.clone(), follow: false })? {
			Ok(HistOut::Stat(st)) => st.mtime_ns.div_euclid(1_000_000_000),
			Err(e) if e.kind == ErrKind::NotFound => continue,
			_ => break,
		};
		// zsh `checklocktime`.
		let now = steps.now()?;
		if now + 10 < then {
			l.errno = Some(HistErr { kind: ErrKind::Exists, msg: "file exists".into() });
			ret = Lock::Failed;
			break;
		}
		if now - then < 10 {
			backoff(steps, sleep_us, now, then + 10)?;
			sleep_us <<= 1;
		} else {
			match steps.ask(HistOp::Unlink { path: lock.clone() })? {
				Ok(_) => {},
				// Another shell may already have removed the stale lock.
				Err(e) if e.kind == ErrKind::NotFound => {},
				Err(e) => {
					l.errno = Some(e);
					ret = Lock::Permanent;
					break;
				},
			}
		}
	}
	if !got {
		l.ct -= 1;
	}
	Ok(ret)
}

/// zsh `unlockhistfile`.
fn unlockhistfile(steps: &mut Steps<'_>, l: &mut Locks, fn_: &[u8]) -> Result<(), Pending> {
	if l.ct > 1 {
		l.ct -= 1;
		return Ok(());
	}
	if l.ct == 0 {
		return Ok(());
	}
	l.ct = 0;
	// Best-effort cleanup: an fcntl lock has no lockfile, and release
	// must continue even if the symlink cannot be removed.
	let _ = steps.ask(HistOp::Unlink { path: lockfile(fn_) })?;
	if l.flock {
		// Unlock drops the held handle and has no fallible host operation.
		let _ = steps.ask(HistOp::Unlock)?;
		l.flock = false;
	}
	Ok(())
}

impl Locks {
	/// Whether the file is locked (zsh `histfileIsLocked`).
	pub const fn held(&self) -> bool {
		self.ct > 0
	}
}

/// zsh `lockhistfile(fn, keep_trying) == 0`: whether the lock was taken.
///
/// # Errors
/// [`Pending`] while a step has no answer.
pub fn lock(
	steps: &mut Steps<'_>,
	l: &mut Locks,
	o: &FileOpts,
	fn_: &[u8],
	keep_trying: bool,
) -> Result<bool, Pending> {
	Ok(lockhistfile(steps, l, o, fn_, keep_trying)? == Lock::Ok)
}

/// zsh `unlockhistfile(fn)`.
///
/// # Errors
/// [`Pending`] while a step has no answer.
pub fn unlock(steps: &mut Steps<'_>, l: &mut Locks, fn_: &[u8]) -> Result<(), Pending> {
	unlockhistfile(steps, l, fn_)
}

/// The `%e` text of the last lock failure.
fn lock_errno(l: &Locks) -> String {
	l.errno
		.as_ref()
		.map_or_else(|| "file exists".to_owned(), |e| e.msg.to_str_lossy().into_owned())
}

/// zsh `zstrtol(s, &end, 0)` after leading blanks: the value and the bytes
/// it took.
fn strtol0(s: &[u8]) -> (i64, usize) {
	let mut i = s.iter().take_while(|&&c| matches!(c, b' ' | b'\t')).count();
	let neg = match s.get(i) {
		Some(b'-') => {
			i += 1;
			true
		},
		Some(b'+') => {
			i += 1;
			false
		},
		_ => false,
	};
	let (base, skip) = match (s.get(i), s.get(i + 1)) {
		(Some(b'0'), Some(b'x' | b'X')) => (16, 2),
		(Some(b'0'), _) => (8, 0),
		_ => (10, 0),
	};
	i += skip;
	let mut n: i64 = 0;
	while let Some(d) = s.get(i).and_then(|&c| char::from(c).to_digit(base)) {
		n = n.wrapping_mul(i64::from(base)).wrapping_add(i64::from(d));
		i += 1;
	}
	(if neg { -n } else { n }, i)
}

/// One event read from the file (zsh `readhistline`): its text and the
/// offset after it.
fn readhistline(data: &[u8], mut pos: usize) -> Option<(Vec<u8>, usize)> {
	if pos >= data.len() {
		return None;
	}
	let mut buf: Vec<u8> = Vec::new();
	loop {
		let end = data[pos..].find_byte(b'\n').map(|i| pos + i);
		let Some(nl) = end else {
			// The last line, without its newline.
			buf.extend_from_slice(&data[pos..]);
			return Some((buf, data.len()));
		};
		buf.extend_from_slice(&data[pos..nl]);
		pos = nl + 1;
		if buf.last() == Some(&b'\\') {
			// `\` + newline: the event goes on.
			let last = buf.len() - 1;
			buf[last] = b'\n';
			if pos < data.len() {
				continue;
			}
		}
		// A trailing space after backslashes was added by the writer.
		let spaces = buf.iter().rev().take_while(|&&c| c == b' ').count();
		if spaces > 0 && buf.len() > spaces && buf[buf.len() - spaces - 1] == b'\\' {
			buf.pop();
		}
		return Some((buf, pos));
	}
}

/// The word bounds of a line read from the file (zsh `histsplitwords`):
/// with `histlexwords` (not on an incremental read) the lexer's, else the
/// blank-separated runs, computed on demand.
fn file_words(text: &[u8], uselex: bool, comments: bool) -> (Vec<u32>, u32) {
	if uselex {
		(lex_words(text, comments), 0)
	} else {
		(Vec::new(), HIST_BLANKWORDS)
	}
}

/// zsh `readhistfile(fn, err, readflags)`.
///
/// # Errors
/// [`Pending`] while a step has no answer.
#[allow(clippy::too_many_arguments, reason = "zsh's arguments plus the operation's context")]
pub fn readhistfile(
	h: &mut Hist,
	steps: &mut Steps<'_>,
	o: &FileOpts,
	l: &mut Locks,
	fn_: Option<&[u8]>,
	err: bool,
	readflags: u32,
	r: &mut Report,
) -> Result<(), Pending> {
	let Some(fn_) = fn_.or_else(|| o.histfile.as_ref().map(|f| f.as_slice())) else {
		return Ok(());
	};
	let fn_ = BString::from(fn_);
	let st = match steps.ask(HistOp::Stat { path: fn_.clone(), follow: true })? {
		Ok(HistOut::Stat(st)) if st.size != 0 => st,
		_ => return Ok(()),
	};
	let mtim = st.mtime_ns.div_euclid(1_000_000_000);
	if readflags & HFILE_FAST != 0 {
		let last = &h.st.last;
		if !last.interrupted && last.fsiz == st.size && last.mtim == mtim {
			return Ok(());
		}
		if !last.interrupted && lockhistfile(steps, l, o, &fn_, false)? != Lock::Ok {
			return Ok(());
		}
		h.st.last.fsiz = st.size;
		h.st.last.mtim = mtim;
		h.st.last.interrupted = false;
	} else {
		match lockhistfile(steps, l, o, &fn_, true)? {
			Lock::Ok => {},
			Lock::Permanent => {
				r.warn(format!(
					"locking failed for {}: {}: reading anyway",
					fn_.to_str_lossy(),
					lock_errno(l)
				));
			},
			Lock::Failed => {
				r.err(format!("locking failed for {}: {}", fn_.to_str_lossy(), lock_errno(l)));
				return Ok(());
			},
		}
	}
	match steps.ask(HistOp::Read { path: fn_.clone() })? {
		Ok(HistOut::Bytes(data)) => {
			let tim = steps.now()?;
			parse_file(h, o, &data, readflags, tim);
		},
		_ => {
			if err {
				r.err(format!("can't read history file {}", fn_.to_str_lossy()));
			}
		},
	}
	unlockhistfile(steps, l, &fn_)?;
	Ok(())
}

/// The event-reading loop of `readhistfile` over the file's bytes.
fn parse_file(h: &mut Hist, o: &FileOpts, data: &[u8], readflags: u32, tim: i64) {
	let fast = readflags & HFILE_FAST != 0;
	let use_opts = readflags & HFILE_USE_OPTIONS != 0;
	// 1: looking for the last line read before; -1: skipping older lines.
	let mut searching = 0i32;
	let mut pos = 0usize;
	if fast && h.st.last.text.is_some() {
		if h.st.last.fpos < h.st.last.fsiz {
			pos = usize::try_from(h.st.last.fpos).unwrap_or(0).min(data.len());
			searching = 1;
		} else {
			h.st.linect = 0;
			searching = -1;
		}
	}
	let mut newflags = HIST_OLD | HIST_READ;
	if fast {
		newflags |= HIST_FOREIGN;
	}
	if readflags & HFILE_SKIPOLD != 0 || (h.st.ignore_all_dups && newflags & o.skip_flags != 0) {
		newflags |= HIST_MAKEUNIQUE;
	}
	let uselex = o.lexwords && !fast;
	let mut start: Option<BString> = None;
	if h.tab.is_none() {
		h.build_tab();
	}
	while let Some((line, next)) = readhistline(data, pos) {
		let fpos = pos;
		pos = next;
		let raw = unmetafy(&line);
		let (stim, ftim, text) = if raw.first() == Some(&b':') {
			let rest = &raw[1..];
			let (stim, used) = strtol0(rest);
			let mut p = rest[used..]
				.iter()
				.position(|&c| c == b':')
				.map(|i| used + i);
			match p.take() {
				Some(colon) => {
					let after = &rest[colon + 1..];
					let (ftim, used2) = strtol0(after);
					let semi = after[used2..]
						.iter()
						.position(|&c| c == b';')
						.map(|i| used2 + i);
					let text = semi.map_or(&b""[..], |s| &after[s + 1..]);
					(stim, ftim, text.to_vec())
				},
				None => (stim, stim, Vec::new()),
			}
		} else {
			let text = if raw.starts_with(b"\\:") {
				raw[1..].to_vec()
			} else {
				raw
			};
			(0, 0, text)
		};
		if searching != 0 {
			if searching > 0 {
				let same = h
					.st
					.last
					.text
					.as_ref()
					.is_some_and(|t| super::model::same_text(&text, t));
				if stim == h.st.last.stim && same {
					searching = 0;
				} else {
					pos = 0;
					h.st.linect = 0;
					searching = -1;
				}
				continue;
			} else if stim < h.st.last.stim {
				h.st.linect += 1;
				continue;
			}
			searching = 0;
		}
		if use_opts {
			h.st.linect += 1;
			h.st.last.fpos = fpos as u64;
			h.st.last.stim = stim;
		}
		let i = h.prepnext(o.dups_first);
		let (words, wflag) = file_words(&text, uselex, o.comments);
		{
			let he = &mut h.events_mut()[i];
			he.text = BString::from(text.clone());
			he.flags = newflags | wflag;
			if stim == 0 {
				he.stim = tim;
				he.ftim = tim;
			} else {
				he.stim = stim;
				he.ftim = if ftim < stim { stim + ftim } else { ftim };
			}
			he.words = words;
		}
		let i = h.addhistnode(i);
		if h.entries[i].flags & HIST_DUP != 0 {
			h.remove(i);
			h.st.curhist -= 1;
		}
		start = Some(BString::from(text));
	}
	if let Some(s) = start
		&& use_opts
	{
		h.st.last.text = Some(s);
	}
}

/// The bytes of one event as zsh writes it.
fn event_line(out: &mut Vec<u8>, text: &[u8], stim: i64, ftim: i64, extended: bool) {
	let t = metafy(text);
	if extended {
		let elapsed = if ftim != 0 { ftim - stim } else { 0 };
		out.extend_from_slice(format!(": {stim}:{elapsed};").as_bytes());
	} else if t.first() == Some(&b':') {
		out.push(b'\\');
	}
	let mut end_backslashes = false;
	for &c in &t {
		if c == b'\n' {
			out.push(b'\\');
		}
		end_backslashes = c == b'\\' || (end_backslashes && c == b' ');
		out.push(c);
	}
	if end_backslashes {
		out.push(b' ');
	}
	out.push(b'\n');
}

/// zsh `savehistfile(fn, err, writeflags)`.
///
/// # Errors
/// [`Pending`] while a step has no answer.
#[allow(clippy::too_many_lines, reason = "a faithful port of one C function")]
#[allow(clippy::too_many_arguments, reason = "zsh's arguments plus the operation's context")]
pub fn savehistfile(
	h: &mut Hist,
	steps: &mut Steps<'_>,
	o: &FileOpts,
	l: &mut Locks,
	fn_: Option<&[u8]>,
	mut err: bool,
	mut writeflags: u32,
	r: &mut Report,
) -> Result<(), Pending> {
	let xcurhist = h.st.curhist - i64::from(h.st.histactive & HA_ACTIVE != 0);
	let mut extended = o.extended;
	if !o.interactive || h.st.savehistsiz <= 0 || h.entries.is_empty() {
		return Ok(());
	}
	let Some(fn_) = fn_.or_else(|| o.histfile.as_ref().map(|f| f.as_slice())) else {
		return Ok(());
	};
	let fn_ = BString::from(fn_);
	let mut first: Option<usize>;
	if writeflags & HFILE_FAST != 0 {
		first = h
			.gethistent(h.st.last.next_write_ev, 1)
			.filter(|&i| i < h.entries.len());
		while let Some(i) = first
			&& h.entries[i].flags & HIST_OLD != 0
		{
			h.st.last.next_write_ev = h.entries[i].num + 1;
			first = (i + 1 < h.entries.len()).then_some(i + 1);
		}
		if first.is_none() || lockhistfile(steps, l, o, &fn_, false)? != Lock::Ok {
			return Ok(());
		}
		if h.st.linect > h.st.savehistsiz + h.st.savehistsiz / 5 {
			writeflags &= !HFILE_FAST;
		}
	} else {
		if lockhistfile(steps, l, o, &fn_, true)? != Lock::Ok {
			r.err(format!("locking failed for {}: {}", fn_.to_str_lossy(), lock_errno(l)));
			return Ok(());
		}
		first = Some(0);
	}
	if writeflags & HFILE_USE_OPTIONS != 0 {
		if o.append || o.incappend || o.incappendtime || o.share {
			writeflags |= HFILE_APPEND | HFILE_SKIPOLD;
		} else {
			h.st.linect = 0;
		}
		if o.savenodups {
			writeflags |= HFILE_SKIPDUPS;
		}
		if o.share {
			extended = true;
		}
	}
	// Where the output goes: the file itself, or `fn.new` renamed over it.
	let mut tmpfile: Option<BString> = None;
	let mut mode = 0o600;
	let mut base: u64 = 0;
	let mut ok = true;
	let mut errno: Option<HistErr> = None;
	if writeflags & HFILE_APPEND != 0 {
		if let Ok(HistOut::Stat(st)) =
			steps.ask(HistOp::Stat { path: fn_.clone(), follow: true })?
		{
			base = st.size;
		}
	} else if o.savebycopy {
		let mut tmp = fn_.clone();
		tmp.extend_from_slice(b".new");
		match steps.ask(HistOp::Unlink { path: tmp.clone() })? {
			Err(e) if e.kind != ErrKind::NotFound => {
				errno = Some(e);
				ok = false;
			},
			_ => {
				if let Ok(HistOut::Stat(st)) =
					steps.ask(HistOp::Stat { path: fn_.clone(), follow: true })?
				{
					if o.euid != 0 && st.uid != o.euid {
						if err {
							let shared = o.append || o.incappend || o.incappendtime || o.share;
							let what = if shared {
								"skipped"
							} else {
								"history not saved"
							};
							r.err(format!(
								"rewriting {} would change its ownership -- {what}",
								fn_.to_str_lossy()
							));
							err = false;
						}
						ok = false;
					} else {
						mode = st.mode & 0o7777;
					}
				}
				if ok {
					tmpfile = Some(tmp);
				}
			},
		}
	}
	if ok {
		let mut out: Vec<u8> = Vec::new();
		let mut start: Option<BString> = None;
		let mut i = first.unwrap_or(0);
		while i < h.entries.len() && h.entries[i].num <= xcurhist {
			let flags = h.entries[i].flags;
			let skip = (writeflags & HFILE_SKIPDUPS != 0 && flags & HIST_DUP != 0)
				|| (writeflags & HFILE_SKIPFOREIGN != 0 && flags & HIST_FOREIGN != 0)
				|| flags & HIST_TMPSTORE != 0
				|| o
					.ignore
					.as_ref()
					.is_some_and(|p| p.matches(&metafy(&h.entries[i].text), &CharEnv::DEFAULT));
			if skip {
				i += 1;
				continue;
			}
			if writeflags & HFILE_SKIPOLD != 0 {
				if flags & (HIST_OLD | HIST_NOWRITE) != 0 {
					i += 1;
					continue;
				}
				h.events_mut()[i].flags |= HIST_OLD;
				if writeflags & HFILE_USE_OPTIONS != 0 {
					h.st.last.next_write_ev = h.entries[i].num + 1;
				}
			}
			if writeflags & HFILE_USE_OPTIONS != 0 {
				h.st.last.fpos = base + out.len() as u64;
				h.st.last.stim = h.entries[i].stim;
				h.st.linect += 1;
			}
			let e = &h.entries[i];
			event_line(&mut out, &e.text, e.stim, e.ftim, extended);
			start = Some(e.text.clone());
			i += 1;
		}
		let target = tmpfile.clone().unwrap_or_else(|| fn_.clone());
		let how = if writeflags & HFILE_APPEND != 0 {
			WriteHow::Append
		} else if tmpfile.is_some() {
			WriteHow::Excl
		} else {
			WriteHow::Trunc
		};
		match steps.ask(HistOp::Write { path: target.clone(), data: out.into(), how, mode })? {
			Ok(_) => {
				if let Some(text) = start
					&& writeflags & HFILE_USE_OPTIONS != 0
				{
					if let Ok(HistOut::Stat(st)) =
						steps.ask(HistOp::Stat { path: target, follow: true })?
					{
						h.st.last.fsiz = st.size;
						h.st.last.mtim = st.mtime_ns.div_euclid(1_000_000_000);
					}
					h.st.last.text = Some(text);
				}
			},
			Err(e) => {
				errno = Some(e);
				ok = false;
			},
		}
		if ok && let Some(tmp) = &tmpfile {
			if steps
				.ask(HistOp::Rename { from: tmp.clone(), to: fn_.clone() })?
				.is_ok()
			{
				// The fcntl lock was on the file renamed over.
				if l.flock {
					// Unlock only drops the held handle; it cannot fail.
					let _ = steps.ask(HistOp::Unlock)?;
					l.flock = false;
				}
			} else {
				r.err(format!("can't rename {}.new to $HISTFILE", fn_.to_str_lossy()));
				ok = false;
				err = false;
			}
		}
		if ok && writeflags & HFILE_SKIPOLD != 0 && writeflags & (HFILE_FAST | HFILE_NO_REWRITE) == 0
		{
			// Read the file back into a fresh list (zsh `pushhiststack`)
			// and write that, trimmed to `SAVEHIST` lines.
			let mut fresh = Hist::default();
			fresh.st.histsiz = h.st.savehistsiz;
			fresh.st.savehistsiz = h.st.savehistsiz;
			fresh.st.ignore_all_dups = h.st.ignore_all_dups || o.savenodups;
			fresh.st.chars = h.st.chars;
			readhistfile(&mut fresh, steps, o, l, Some(&fn_), err, 0, r)?;
			if !fresh.entries.is_empty() {
				fresh.st.ignore_all_dups = h.st.ignore_all_dups;
				savehistfile(&mut fresh, steps, o, l, Some(&fn_), err, 0, r)?;
			}
		}
	}
	if !ok && err {
		let e = errno.map_or_else(|| "file exists".to_owned(), |e| e.msg.to_str_lossy().into_owned());
		if tmpfile.is_some() {
			r.err(format!("failed to write history file {}.new: {e}", fn_.to_str_lossy()));
		} else {
			r.err(format!("failed to write history file {}: {e}", fn_.to_str_lossy()));
		}
	}
	unlockhistfile(steps, l, &fn_)?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn lines_join_continuations_and_drop_the_writer_space() {
		let data = b": 1:0;a\\\nb\n: 2:0;c\\ \nd";
		let (l1, p) = readhistline(data, 0).unwrap();
		assert_eq!(l1, b": 1:0;a\nb");
		let (l2, p) = readhistline(data, p).unwrap();
		assert_eq!(l2, b": 2:0;c\\");
		let (l3, p) = readhistline(data, p).unwrap();
		assert_eq!(l3, b"d");
		assert!(readhistline(data, p).is_none());
	}

	#[test]
	fn events_are_written_as_zsh_does() {
		let mut out = Vec::new();
		event_line(&mut out, b"a\nb", 5, 7, true);
		event_line(&mut out, b"x\\", 5, 0, true);
		event_line(&mut out, b":y", 5, 0, false);
		assert_eq!(out, b": 5:2;a\\\nb\n: 5:0;x\\ \n\\:y\n");
	}

	#[test]
	fn read_then_write_round_trips() {
		let data: &[u8] = b": 1781352489:0;sudo iptables -L\\\nsudo iptables -t nat\n: 1781352490:3;echo \xc4\x83\xa3\n: 1781352491:0;tail\\ \n";
		let mut h = Hist::default();
		h.st.histsiz = 100;
		parse_file(&mut h, &FileOpts::default(), data, 0, 0);
		assert_eq!(h.entries.len(), 3);
		assert_eq!(h.entries[0].text, "sudo iptables -L\nsudo iptables -t nat");
		assert_eq!(h.entries[1].text, b"echo \xc4\x83".as_slice());
		assert_eq!(h.entries[1].ftim, 1_781_352_493);
		let mut out = Vec::new();
		for e in h.entries.iter() {
			event_line(&mut out, &e.text, e.stim, e.ftim, true);
		}
		assert_eq!(out, data);
	}
}
