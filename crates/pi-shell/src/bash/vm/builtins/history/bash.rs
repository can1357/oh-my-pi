//! bash's history files and timestamps (`bashhist.c`, `history.def`,
//! readline's `histfile.c`): `history -a -n -r -w`, `HISTTIMEFORMAT`
//! stamps, `HISTIGNORE`, `history -p`, and `fc`'s editor.
//!
//! A history file holds one entry per line; with `HISTTIMEFORMAT` set an
//! entry's time is written before it as `#SECONDS` (and such lines are
//! read back as times, else as entries).

use bstr::{BString, ByteSlice};

use super::{
	List,
	bang::{self, BangOpts, Lex, LineState},
	hist_size,
	io::{HistOp, HistOut, Steps, WriteHow},
	model::{Entry, HA_ACTIVE, Hist},
	scalar,
	words::lex_words,
	write_now,
	zsh::in_builtin,
};
use crate::bash::{
	pattern::PatOpts,
	store::{OptId, StateStore, StoreError},
	vm::{
		Kernel,
		builtins::{Control, Ctx, Outcome, R, done},
		exec::push_script,
		locale,
		proc::{ScriptKind, Vproc},
		state::{self, Root},
	},
};

/// An entry's time: `now` while `HISTTIMEFORMAT` is set, else none.
///
/// # Errors
/// [`StoreError`] when the variable cannot be read.
pub(super) fn stamp(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	now: i64,
) -> Result<i64, StoreError> {
	Ok(if scalar(root, store, vp, b"HISTTIMEFORMAT")?.is_some() {
		now
	} else {
		0
	})
}

/// Whether `HISTIGNORE` (colon-separated patterns, `&` for the previous
/// entry, `\:` a literal colon) matches all of `line`.
///
/// # Errors
/// [`StoreError`] when a variable or option cannot be read.
pub(super) fn ignored(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &Vproc,
	line: &[u8],
	list: &List,
) -> Result<bool, StoreError> {
	let Some(spec) = scalar(&k.root, store, vp, b"HISTIGNORE")?.filter(|s| !s.is_empty()) else {
		return Ok(false);
	};
	let extglob = state::option(&mut k.root, store, vp, OptId::Extglob)?;
	let utf8 = locale::is_utf8(k, store, vp);
	let opts = PatOpts::shell(extglob, false, utf8);
	let mut pats: Vec<Vec<u8>> = vec![Vec::new()];
	let mut i = 0;
	while i < spec.len() {
		match spec[i] {
			b'\\' if spec.get(i + 1) == Some(&b':') => {
				if let Some(p) = pats.last_mut() {
					p.push(b':');
				}
				i += 1;
			},
			b':' => pats.push(Vec::new()),
			c => {
				if let Some(p) = pats.last_mut() {
					p.push(c);
				}
			},
		}
		i += 1;
	}
	for pat in pats.iter().filter(|p| !p.is_empty()) {
		if pat.as_slice() == b"&" {
			if list.entries.last().is_some_and(|l| l.as_slice() == line) {
				return Ok(true);
			}
			continue;
		}
		if k.engine.patterns().get(pat, opts).matches(line) {
			return Ok(true);
		}
	}
	Ok(false)
}

/// The list as zsh's history machinery sees it, for expansion: entry
/// numbers from the base, the words as bash's tokenizer splits them, and
/// an event begun for the text being expanded.
fn as_hist(list: &List) -> Hist {
	let mut h = Hist::default();
	for (i, text) in list.entries.iter().enumerate() {
		h.events_mut().push(Entry {
			text: text.clone(),
			num: list.base + i as i64,
			words: lex_words(text, false),
			..Entry::default()
		});
	}
	h.st.curhist = list.base + list.entries.len() as i64;
	h.st.histactive = HA_ACTIVE;
	h.st.linked = true;
	h
}

/// `history -p arg …`: each argument history-expanded and printed, the
/// list unchanged; 1 when one fails (`history expansion failed`).
pub(super) fn expand_args(ctx: &mut Ctx<'_, '_>, list: &List, args: &[BString]) -> i32 {
	let mut status = 0;
	let mut out = Vec::new();
	let o = BangOpts { cwd: ctx.vp.cwd.clone(), bash: true, ..BangOpts::default() };
	let none = |_: &crate::bash::vm::proc::Probe| None;
	for arg in args {
		let mut h = as_hist(list);
		let defev = h.addhistnum(h.st.curhist, -1, 0);
		h.curline = Some(LineState { defev, lex: Lex::new(), ..LineState::default() });
		let mut steps = Steps::new(&none, 0);
		if let Ok(text) = bang::expand_line(&mut h, arg, &o, &mut steps) {
			out.extend_from_slice(&text);
			out.push(b'\n');
		} else {
			ctx.out(&std::mem::take(&mut out));
			ctx.usage(format!("{}: history expansion failed", arg.as_bstr()));
			status = 1;
		}
	}
	ctx.out(&out);
	status
}

/// What bash's history expansion made of an input line (`set -o
/// histexpand`, readline's `history_expand` in `pre_process_line`).
#[derive(Debug)]
pub enum Expanded {
	/// The line as read: no history reference in it.
	Same,
	/// The expanded line: show it (standard error), then parse it.
	Line(BString),
	/// `:p`: show the expanded line, record it, do not run it.
	Print(BString),
	/// The expansion failed: the message (`SPEC: event not found`, …);
	/// the line is dropped.
	Failed(BString),
}

/// bash's history expansion of one input line `line` (with its newline)
/// of an interactive shell with `histexpand` on.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn expand_reader_line(
	store: &mut dyn StateStore,
	vp: &Vproc,
	line: &[u8],
) -> Result<Expanded, StoreError> {
	let list = List::load(store, vp)?;
	let mut h = as_hist(&list);
	let defev = h.addhistnum(h.st.curhist, -1, 0);
	h.curline = Some(LineState { defev, comments: true, lex: Lex::new(), ..LineState::default() });
	let o = BangOpts { cwd: vp.cwd.clone(), bash: true, ..BangOpts::default() };
	let none = |_: &crate::bash::vm::proc::Probe| None;
	let mut steps = Steps::new(&none, 0);
	Ok(match bang::expand_line(&mut h, line, &o, &mut steps) {
		Ok(text) => {
			let done = h.curline.as_ref().map_or(0, |l| l.done);
			if done & bang::HISTFLAG_NOEXEC != 0 {
				Expanded::Print(text)
			} else if done & bang::HISTFLAG_DONE != 0 {
				Expanded::Line(text)
			} else {
				Expanded::Same
			}
		},
		Err(bang::Stop::Error(e)) => Expanded::Failed(
			e.bash()
				.cloned()
				.unwrap_or_else(|| BString::from("history expansion failed")),
		),
		Err(bang::Stop::Pending(_)) => Expanded::Failed(BString::from("history expansion failed")),
	})
}

/// Whether bash's reader expands history in the lines it reads: bash
/// dialect, `set -o history`, `set -o histexpand`, an interactive shell.
pub fn histexpand_active(k: &mut Kernel, store: &mut dyn StateStore, vp: &Vproc) -> bool {
	use crate::bash::store::{Key, MiscKey, Record};
	vp.mode.dialect() != crate::bash::ids::Dialect::Zsh
		&& state::option(&mut k.root, store, vp, OptId::History).unwrap_or(false)
		&& state::option(&mut k.root, store, vp, OptId::Histexpand).unwrap_or(false)
		&& matches!(
			state::record(store, vp, Key::Misc(MiscKey::Interactive)),
			Ok(Some(Record::Misc(v))) if v.as_slice() == b"1"
		)
}

/// bash's reader step for one line read (`text`, with its newline) while
/// [`histexpand_active`]: the line to parse (empty when it is dropped).
/// An expanded line is shown on standard error first; `:p` shows and
/// records it without running it; a failure prints bash's message.
pub fn reader_line(
	k: &mut Kernel,
	cx: &mut crate::bash::vm::Cx<'_>,
	vp: &mut Vproc,
	text: BString,
) -> BString {
	use crate::bash::vm::proc::PendingWrite;
	match expand_reader_line(cx.store, vp, &text) {
		Ok(Expanded::Same) => text,
		Ok(Expanded::Line(t)) => {
			vp.out
				.push_back(PendingWrite { fd: 2, bytes: t.clone(), off: 0 });
			t
		},
		Ok(Expanded::Print(t)) => {
			vp.out
				.push_back(PendingWrite { fd: 2, bytes: t.clone(), off: 0 });
			let now = cx.host.wall().secs;
			if let Err(e) = record_line(k, cx.store, vp, &t, now) {
				k.fail(e);
			}
			BString::default()
		},
		Ok(Expanded::Failed(msg)) => {
			// bash's reader reports without a line number: `bash: MSG`.
			let mut bytes = k.argv0.clone();
			bytes.extend_from_slice(b": ");
			bytes.extend_from_slice(&msg);
			bytes.push(b'\n');
			vp.out.push_back(PendingWrite { fd: 2, bytes, off: 0 });
			BString::default()
		},
		Err(e) => {
			k.fail(e);
			text
		},
	}
}

/// Record `text` (an expanded `:p` line) as bash's reader would.
///
/// # Errors
/// [`StoreError`] when the history cannot be read.
pub fn record_line(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	text: &[u8],
	now: i64,
) -> Result<(), StoreError> {
	let mut list = List::load(store, vp)?;
	let size = hist_size(
		scalar(&k.root, store, vp, b"HISTSIZE")?
			.as_ref()
			.map(|v| v.as_slice()),
	);
	let time = stamp(&k.root, store, vp, now)?;
	let line = text.strip_suffix(b"\n").unwrap_or(text);
	list.add(BString::from(line), size, time);
	list.pending = false;
	list.save(&mut k.root, store, vp);
	Ok(())
}

/// One history file entry as bash writes it.
fn write_entry(out: &mut Vec<u8>, text: &[u8], time: i64, stamps: bool) {
	if stamps && time != 0 {
		out.extend_from_slice(format!("#{time}\n").as_bytes());
	}
	out.extend_from_slice(text);
	out.push(b'\n');
}

/// The entries of a history file: text and time (`#SECONDS` lines are
/// times when `stamps`).
fn read_entries(data: &[u8], stamps: bool) -> Vec<(BString, i64)> {
	let mut out = Vec::new();
	let mut time = 0;
	let body = data.strip_suffix(b"\n").unwrap_or(data);
	if body.is_empty() && data.is_empty() {
		return out;
	}
	for line in body.split(|&c| c == b'\n') {
		if stamps && line.len() > 1 && line[0] == b'#' && line[1].is_ascii_digit() {
			time = line[1..]
				.iter()
				.take_while(|c| c.is_ascii_digit())
				.fold(0_i64, |n, &c| n.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
			continue;
		}
		out.push((BString::from(line), time));
		time = 0;
	}
	out
}

/// `history -a -n -r -w [file]` on `list` (the file defaults to
/// `$HISTFILE`).
pub(super) fn file_op(
	ctx: &mut Ctx<'_, '_>,
	mut list: List,
	flag: u8,
	file: Option<&BString>,
) -> R {
	let file = match file {
		Some(f) => Some(f.clone()),
		None => ctx.scalar(b"HISTFILE")?.filter(|f| !f.is_empty()),
	};
	let Some(file) = file else {
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		ctx.usage("HISTFILE: parameter null or not set");
		return done(1);
	};
	let path = crate::bash::vm::probe::absolute(&ctx.vp.cwd, &file);
	let is_histfile = ctx.scalar(b"HISTFILE")?.is_some_and(|h| h == file);
	let stamps = ctx.scalar(b"HISTTIMEFORMAT")?.is_some();
	let size = hist_size(ctx.scalar(b"HISTSIZE")?.as_ref().map(|v| v.as_slice()));
	let status = match flag {
		b'w' | b'a' => {
			let from = if flag == b'w' {
				0
			} else {
				list
					.entries
					.len()
					.saturating_sub(usize::try_from(list.session).unwrap_or(0))
			};
			let mut data = Vec::new();
			for i in from..list.entries.len() {
				write_entry(&mut data, &list.entries[i], list.times[i], stamps);
			}
			let how = if flag == b'w' {
				WriteHow::Trunc
			} else {
				WriteHow::Append
			};
			let res = in_builtin(ctx, |steps| {
				steps.ask(HistOp::Write {
					path: path.clone(),
					data: data.clone().into(),
					how,
					mode: 0o600,
				})
			})?;
			match res {
				Ok(_) => {
					let written = (list.entries.len() - from) as i64;
					if flag == b'w' {
						if is_histfile {
							list.in_file = list.entries.len() as i64;
						}
					} else {
						list.in_file += written;
					}
					list.session = 0;
					0
				},
				Err(e) => {
					if flag == b'a' {
						ctx.usage(format!(
							"{}: cannot create: {}",
							file.as_bstr(),
							capitalized(&e.msg).as_bstr()
						));
					}
					1
				},
			}
		},
		_ => {
			let res = in_builtin(ctx, |steps| steps.ask(HistOp::Read { path: path.clone() }))?;
			match res {
				Ok(HistOut::Bytes(data)) => {
					let entries = read_entries(&data, stamps);
					let skip = if flag == b'n' {
						usize::try_from(list.in_file).unwrap_or(0)
					} else {
						0
					};
					let mut added = 0;
					for (text, time) in entries.into_iter().skip(skip) {
						let session = list.session;
						list.add(text, size, time);
						// Only `-n` reads count as this session's.
						if flag == b'r' {
							list.session = session;
						}
						added += 1;
					}
					if flag == b'n' {
						list.in_file += added;
					} else {
						list.in_file = added;
					}
					0
				},
				_ => 1,
			}
		},
	};
	list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	done(status)
}

/// zsh's `%e` text back to C's `strerror` capitalisation.
fn capitalized(msg: &[u8]) -> BString {
	let mut b = BString::from(msg);
	if let Some(c) = b.first_mut() {
		c.make_ascii_uppercase();
	}
	b
}

/// `fc` without `-l`/`-s` (bash `fc.def`): the entries `first..=last` go
/// to a temporary file, the editor (`-e`, `$FCEDIT`, `$EDITOR`, `vi`) runs
/// on it, then its lines are echoed to standard error, replace the `fc`
/// line in the history and run.
pub(super) fn edit(
	ctx: &mut Ctx<'_, '_>,
	mut list: List,
	first: usize,
	last: usize,
	reverse: bool,
	editor: Option<BString>,
) -> R {
	let mut text = Vec::new();
	let mut push = |i: usize| {
		text.extend_from_slice(&list.entries[i]);
		text.push(b'\n');
	};
	if reverse {
		(first..=last).rev().for_each(&mut push);
	} else {
		(first..=last).for_each(&mut push);
	}
	let editor = match editor {
		Some(e) => e,
		None => match ctx.scalar(b"FCEDIT")? {
			Some(e) => e,
			None => ctx
				.scalar(b"EDITOR")?
				.unwrap_or_else(|| BString::from("vi")),
		},
	};
	let pid = ctx.k.shell_pid;
	let tmpdir = ctx
		.scalar(b"TMPDIR")?
		.filter(|t| !t.is_empty())
		.unwrap_or_else(|| BString::from("/tmp"));
	let made = in_builtin(ctx, |steps| {
		for n in 0..100u32 {
			let mut path = tmpdir.clone();
			if !path.ends_with(b"/") {
				path.push(b'/');
			}
			path.extend_from_slice(format!("bash-fc.{pid}.{n}").as_bytes());
			let op = HistOp::Write {
				path: path.clone(),
				data: text.clone().into(),
				how:  WriteHow::Excl,
				mode: 0o600,
			};
			match steps.ask(op)? {
				Ok(_) => return Ok(Some(path)),
				Err(e) if e.kind == super::io::ErrKind::Exists => {},
				Err(_) => return Ok(None),
			}
		}
		Ok(None)
	})?;
	let Some(path) = made else {
		ctx.usage("cannot open temp file");
		return done(1);
	};
	if ctx.resumed == 0 {
		let mut cmd = editor;
		cmd.push(b' ');
		cmd.extend_from_slice(&path);
		push_script(ctx.vp, &cmd, ctx.line, ScriptKind::Eval);
		return Ok(Outcome { status: 0, control: Control::Resume });
	}
	let edited = ctx.vp.status == 0;
	let contents = in_builtin(ctx, |steps| {
		let got = if edited {
			match steps.ask(HistOp::Read { path: path.clone() })? {
				Ok(HistOut::Bytes(b)) => Some(b),
				_ => None,
			}
		} else {
			None
		};
		// Temporary-file cleanup must not replace the editor/read outcome.
		let _ = steps.ask(HistOp::Unlink { path: path.clone() })?;
		Ok(got)
	})?;
	let Some(contents) = contents else {
		return done(1);
	};
	let unwritten = write_now(&*ctx, 2, &contents).to_vec();
	if !unwritten.is_empty() {
		ctx.out_fd(2, &unwritten);
	}
	// bash's `fc_replhist`: the edited lines take the `fc` line's place.
	if list.pending {
		list.pop();
		list.pending = false;
	}
	let size = hist_size(ctx.scalar(b"HISTSIZE")?.as_ref().map(|v| v.as_slice()));
	let now = ctx.cx.host.wall().secs;
	let time = stamp(&ctx.k.root, ctx.cx.store, ctx.vp, now)?;
	for line in contents.lines().filter(|l| !l.is_empty()) {
		list.add(BString::from(line), size, time);
	}
	list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	push_script(ctx.vp, &contents, ctx.line, ScriptKind::Eval);
	Ok(Outcome { status: 0, control: Control::Frame })
}
