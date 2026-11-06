//! History: bash's `history` builtin and history list (`builtins/history.def`,
//! `bashhist.c`) here, zsh's (`hist.c`, `bin_fc`) in the submodules.
//!
//! The bash list holds the lines the reader [`remember`]s while `set -o
//! history` is on, plus `history -s` entries. Entries are numbered from a
//! base that grows as `HISTSIZE` drops the oldest ones.
//!
//! zsh's list ([`model`]) is driven by the reader through [`zsh`] (`hbegin`,
//! history expansion, `hend`, the startup read and the exit save), its file
//! is [`file`], its expansion [`bang`], its builtins [`zfc`].

pub mod bang;
pub mod bash;
pub mod file;
pub mod io;
pub mod model;
pub mod words;
pub mod zfc;
pub mod zsh;

use bstr::{BString, ByteSlice};

use super::{Control, Ctx, Outcome, R, done, number, opts};
use crate::bash::{
	diag::Diag,
	ids::Dialect,
	store::{Key, KeyBuf, MiscKey, OptId, Record, StateStore, StoreError},
	vm::{
		Kernel,
		exec::push_script,
		proc::{ScriptKind, Vproc},
		state::{self, Root},
	},
};

/// The history list as stored: entries, the number of the first one
/// (bash's `history_base`), and whether the last entry is the current
/// input line, added by [`remember`] and not yet replaced by `history -s`.
/// Each entry has a start time (`0`: none, as when `HISTTIMEFORMAT` was
/// unset when it was added). `in_file` counts the entries of `$HISTFILE`
/// the shell knows of (bash `history_lines_in_file`, for `history -n`),
/// `session` the entries added since the last `history -a`/`-w`
/// (`history_lines_this_session`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct List {
	entries: Vec<BString>,
	times:   Vec<i64>,
	base:    i64,
	pending: bool,
	in_file: i64,
	session: i64,
}

impl List {
	/// Read the list (`MiscKey::History` entries, `MiscKey::HistoryTimes`,
	/// `MiscKey::HistoryCounts` = `[base, pending, in_file, session]`).
	fn load(store: &mut dyn StateStore, vp: &Vproc) -> Result<Self, StoreError> {
		let words = |store: &mut dyn StateStore, key| -> Result<Vec<BString>, StoreError> {
			Ok(match state::record(store, vp, Key::Misc(key))? {
				Some(Record::Words(w)) => w.clone(),
				_ => Vec::new(),
			})
		};
		let entries = words(store, MiscKey::History)?;
		let mut times: Vec<i64> = words(store, MiscKey::HistoryTimes)?
			.iter()
			.map(|t| number(t).unwrap_or(0))
			.collect();
		times.resize(entries.len(), 0);
		let counts = words(store, MiscKey::HistoryCounts)?;
		let count = |i: usize| counts.get(i).and_then(|b| number(b));
		Ok(Self {
			entries,
			times,
			base: count(0).unwrap_or(1),
			pending: counts.get(1).is_some_and(|p| p == "1"),
			in_file: count(2).unwrap_or(0),
			session: count(3).unwrap_or(0),
		})
	}

	/// Write the list back.
	fn save(self, root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
		let times = self.times.iter().any(|&t| t != 0).then(|| {
			Record::Words(
				self
					.times
					.iter()
					.map(|t| BString::from(t.to_string()))
					.collect(),
			)
		});
		state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::HistoryTimes), times);
		let entries = (!self.entries.is_empty()).then_some(Record::Words(self.entries));
		state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::History), entries);
		let counts = vec![
			BString::from(self.base.to_string()),
			BString::from(if self.pending { "1" } else { "0" }),
			BString::from(self.in_file.to_string()),
			BString::from(self.session.to_string()),
		];
		state::store_record(
			root,
			store,
			vp,
			KeyBuf::Misc(MiscKey::HistoryCounts),
			Some(Record::Words(counts)),
		);
	}

	/// Append `line` started at `time`, then drop the oldest entries past
	/// `HISTSIZE` (bash's `stifle_history`), moving the base along.
	fn add(&mut self, line: BString, size: Option<usize>, time: i64) {
		self.entries.push(line);
		self.times.push(time);
		self.session += 1;
		if let Some(max) = size
			&& self.entries.len() > max
		{
			let drop = self.entries.len() - max;
			self.entries.drain(..drop);
			self.times.drain(..drop);
			self.base += drop as i64;
		}
	}

	/// Drop the last entry.
	fn pop(&mut self) {
		self.entries.pop();
		self.times.pop();
		self.session = (self.session - 1).max(0);
	}

	/// Drop every entry.
	fn clear(&mut self) {
		self.entries.clear();
		self.times.clear();
		self.pending = false;
		self.session = 0;
	}
}

/// `HISTSIZE` as a limit: a non-negative number, else no limit.
fn hist_size(value: Option<&[u8]>) -> Option<usize> {
	value.and_then(number).and_then(|n| usize::try_from(n).ok())
}

/// A shell variable's scalar value (a store failure reads as unset).
fn scalar(
	root: &Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
	name: &[u8],
) -> Result<Option<BString>, StoreError> {
	Ok(state::lookup(root, store, vp, name)?.and_then(|v| v.as_scalar().map(BString::from)))
}

/// Whether `line` is kept under `HISTCONTROL` (`ignorespace`, `ignoredups`,
/// `ignoreboth`, `erasedups`; colon-separated) given the previous entry;
/// `erasedups` removes earlier copies from the list.
fn keep_line(control: &[u8], line: &[u8], list: &mut List) -> bool {
	let mut keep = true;
	for word in control.split(|&c| c == b':') {
		match word {
			b"ignorespace" => keep &= !line.starts_with(b" "),
			b"ignoredups" => keep &= list.entries.last().is_none_or(|last| last != line),
			b"ignoreboth" => {
				keep &= !line.starts_with(b" ") && list.entries.last().is_none_or(|last| last != line);
			},
			b"erasedups" => {
				let mut i = 0;
				while i < list.entries.len() {
					if list.entries[i] == line {
						list.entries.remove(i);
						list.times.remove(i);
					} else {
						i += 1;
					}
				}
			},
			_ => {},
		}
	}
	keep
}

/// Whether the shell's input lines join the history (the reader asks
/// before it parses a command): bash with `set -o history` on, zsh when
/// interactive and reading standard input (zsh `hbegin`'s `stophist`).
///
/// # Errors
/// [`StoreError`] when an option record cannot be read.
pub fn recording(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<bool, StoreError> {
	// A program's shell keeps no history ([`crate::bash::Profile::Tool`]).
	if crate::bash::vm::is_tool(store, vp)? {
		return Ok(false);
	}
	if vp.mode.dialect() == Dialect::Zsh {
		return zsh::active(root, store, vp);
	}
	state::option(root, store, vp, OptId::History)
}

/// bash's reader hook once it parsed a command while [`recording`]:
/// `lines` (the input lines the command spans, without their newlines)
/// join the history list, each unless `HISTCONTROL` excludes it
/// (`maybe_add_history`) or `HISTIGNORE` matches it; `now` stamps them
/// while `HISTTIMEFORMAT` is set. zsh's reader calls [`zsh::hend`] instead.
/// A store failure is recorded on the kernel.
pub fn remember(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	lines: Vec<BString>,
	now: i64,
) {
	let res = lines
		.iter()
		.try_for_each(|line| try_remember(k, store, vp, line, now));
	if let Err(e) = res {
		k.fail(e);
	}
}

fn try_remember(
	k: &mut Kernel,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	line: &[u8],
	now: i64,
) -> Result<(), StoreError> {
	let mut list = List::load(store, vp)?;
	let control = scalar(&k.root, store, vp, b"HISTCONTROL")?.unwrap_or_default();
	if !keep_line(&control, line, &mut list) || bash::ignored(k, store, vp, line, &list)? {
		list.pending = false;
		list.save(&mut k.root, store, vp);
		return Ok(());
	}
	let root = &mut k.root;
	let size = hist_size(
		scalar(root, store, vp, b"HISTSIZE")?
			.as_ref()
			.map(|v| v.as_slice()),
	);
	let time = bash::stamp(root, store, vp, now)?;
	list.add(BString::from(line), size, time);
	list.pending = true;
	list.save(root, store, vp);
	Ok(())
}

/// A single `history -d` position: `-N` counts back from the end (`-1` is
/// the last entry), `N` is an entry number. `None` when out of range.
fn position(arg: &[u8], n: i64, list: &List) -> Option<usize> {
	let len = list.entries.len() as i64;
	let index = if arg.first() == Some(&b'-') && n < 0 {
		len + n
	} else {
		n - list.base
	};
	(0..len).contains(&index).then_some(index as usize)
}

/// One end of a `history -d start-end` range, as bash computes it: `-N`
/// counts back, a positive number is an entry number, `0` is the first
/// entry. `None` when out of range.
fn range_end(arg: &[u8], n: i64, list: &List) -> Option<usize> {
	let len = list.entries.len() as i64;
	let index = if arg.first() == Some(&b'-') && n < 0 {
		len + n
	} else if n > 0 {
		n - list.base
	} else {
		n
	};
	(0..len).contains(&index).then_some(index as usize)
}

/// `history [-c] [-d offset] [n]`, `history -s arg …`; `-anrw` and `-p`
/// are not supported.
pub fn history(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let o = match opts(ctx, args, b"acnprsw", b"d", false) {
		Ok(o) => o,
		Err(st) => return done(st),
	};
	let files: Vec<u8> = b"anrw".iter().copied().filter(|&c| o.has(c)).collect();
	if files.len() > 1 {
		ctx.usage("cannot use more than one of -anrw");
		return done(1);
	}
	let mut list = List::load(ctx.cx.store, ctx.vp)?;
	if o.has(b'c') {
		list.clear();
	}
	if o.has(b's') {
		if !o.rest.is_empty() {
			// bash's `push_history`: the `history -s` line itself goes.
			if list.pending {
				list.pop();
				list.pending = false;
			}
			let line = BString::from(bstr::join(b" ", o.rest));
			let control = ctx.scalar(b"HISTCONTROL")?.unwrap_or_default();
			let ignored = bash::ignored(ctx.k, ctx.cx.store, ctx.vp, &line, &list)?;
			if keep_line(&control, &line, &mut list) && !ignored {
				let size = hist_size(ctx.scalar(b"HISTSIZE")?.as_ref().map(|v| v.as_slice()));
				let now = ctx.cx.host.wall().secs;
				let time = bash::stamp(&ctx.k.root, ctx.cx.store, ctx.vp, now)?;
				list.add(line, size, time);
			}
		}
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		return done(0);
	}
	if o.has(b'p') {
		// bash: the `history -p` line itself leaves the list.
		if list.pending {
			list.pop();
			list.pending = false;
		}
		let status = bash::expand_args(ctx, &list, o.rest);
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		return done(status);
	}
	if let Some(arg) = o.arg(b'd') {
		return delete(ctx, list, arg);
	}
	if let Some(&flag) = files.first() {
		return bash::file_op(ctx, list, flag, o.rest.first());
	}
	if o.has(b'c') {
		// bash lists nothing after `-c`, operands or not.
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		return done(0);
	}
	display(ctx, &list, o.rest)
}

/// bash `fc_number`: an optional `-` and a number, which ends `fc`'s
/// options (`fc -l -2`).
fn fc_number(arg: &[u8]) -> bool {
	let digits = arg.strip_prefix(b"-").unwrap_or(arg);
	!digits.is_empty() && digits.iter().all(u8::is_ascii_digit)
}

/// bash `fc_gethnum`: the index in `list` of history specification `spec`
/// among the first `count` entries (those before the running `fc` line),
/// `None` when no entry starts with it. A negative number counts back (`-1`
/// is the last entry), `0` is the last; a positive one is an entry number,
/// `0` below the list and `above` past it (bash uses the first entry for
/// the start of a listed range, the last one otherwise).
fn fc_index(list: &List, count: usize, spec: &[u8], above: usize) -> Option<usize> {
	let last = count.checked_sub(1)?;
	if fc_number(spec) {
		let n = number(spec).unwrap_or(i64::MAX);
		let i = match n.cmp(&0) {
			std::cmp::Ordering::Less => (last as i64).saturating_add(1).saturating_add(n).max(0),
			std::cmp::Ordering::Equal => last as i64,
			std::cmp::Ordering::Greater => match n.saturating_sub(list.base) {
				i if i > last as i64 => above as i64,
				i => i.max(0),
			},
		};
		return usize::try_from(i).ok();
	}
	(0..count)
		.rev()
		.find(|&i| list.entries[i].starts_with(spec))
}

/// Write what of `bytes` fd `fd` takes without waiting, returning the rest.
/// A builtin's queued output is written only after the frame it runs, so
/// output that must come before that frame goes out here.
fn write_now<'b>(ctx: &Ctx<'_, '_>, fd: i32, mut bytes: &'b [u8]) -> &'b [u8] {
	let waker = ctx.k.waker.clone();
	let mut tcx = std::task::Context::from_waker(&waker);
	let handle = ctx.vp.fds.handle(fd);
	while !bytes.is_empty() {
		match handle.poll_write(&mut tcx, bytes) {
			std::task::Poll::Ready(Ok(n)) if n > 0 => bytes = &bytes[n..],
			_ => break,
		}
	}
	bytes
}

/// `fc [-e ename] [-lnr] [first [last]]`, `fc -s [pat=rep …] [command]`
/// (bash `fc.def`): list history entries (`-l`; `-n` without numbers, `-r`
/// newest first) or run one again (`-s`, or `-e -`), echoing it to stderr
/// after replacing every `pat` with `rep`.
///
/// Editing entries before running them (`fc` without `-l` or `-s`) runs an
/// editor, an interactive step this shell does not take: with no entry to
/// edit (a `-c` shell's empty history) it succeeds as bash's does, else it
/// fails loudly.
pub fn fc(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let (mut listing, mut numbered, mut reverse, mut execute) = (false, true, false, false);
	let mut editor: Option<BString> = None;
	let mut i = 0;
	while let Some(arg) = args.get(i) {
		if arg.as_slice() == b"--" {
			i += 1;
			break;
		}
		if arg.len() < 2 || arg[0] != b'-' || fc_number(arg) {
			break;
		}
		for (j, &c) in arg.iter().enumerate().skip(1) {
			match c {
				b'l' => listing = true,
				b'n' => numbered = false,
				b'r' => reverse = true,
				b's' => execute = true,
				b'e' => {
					let attached = &arg[j + 1..];
					editor = Some(if attached.is_empty() {
						i += 1;
						if let Some(name) = args.get(i) {
							name.clone()
						} else {
							ctx.usage("-e: option requires an argument");
							ctx.builtin_usage();
							return done(2);
						}
					} else {
						attached.into()
					});
					break;
				},
				c => {
					ctx.usage(format!("-{}: invalid option", char::from(c)));
					ctx.builtin_usage();
					return done(2);
				},
			}
		}
		i += 1;
	}
	let rest = &args[i..];
	execute |= editor.as_ref().is_some_and(|e| e == "-");
	let mut list = List::load(ctx.cx.store, ctx.vp)?;
	// While the reader records history, the running `fc` line is the last
	// entry; bash's `last_hist` leaves it out.
	let count = list.entries.len() - usize::from(list.pending);
	if execute {
		let split = rest
			.iter()
			.position(|w| !w.contains(&b'='))
			.unwrap_or(rest.len());
		let (subs, spec) = rest.split_at(split);
		let last = count.checked_sub(1);
		let found = match (spec.first(), last) {
			(Some(spec), Some(last)) => fc_index(&list, count, spec, last),
			_ => last,
		};
		let Some(found) = found else {
			ctx.usage("no command found");
			return done(1);
		};
		let mut command = list.entries[found].clone();
		for sub in subs {
			let (pat, rep) = sub.split_once_str(b"=").unwrap_or((sub.as_slice(), b""));
			if !pat.is_empty() {
				command = command.replace(pat, rep).into();
			}
		}
		// bash echoes the command before running it.
		let mut echoed = command.clone();
		echoed.push(b'\n');
		let unwritten = write_now(&*ctx, 2, &echoed);
		if !unwritten.is_empty() {
			ctx.out_fd(2, unwritten);
		}
		// bash's `fc_replhist`: the command takes the `fc` line's place.
		if list.pending
			&& let Some(entry) = list.entries.last_mut()
		{
			*entry = command.clone();
			list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		}
		push_script(ctx.vp, &command, ctx.line, ScriptKind::Eval);
		return Ok(Outcome { status: 0, control: Control::Frame });
	}
	let Some(last) = count.checked_sub(1) else {
		return done(0);
	};
	let start_above = if listing { 0 } else { last };
	let index = |spec: &BString, above| fc_index(&list, count, spec, above);
	let (mut first, mut end) = match rest {
		[] if listing => (last.saturating_sub(15), Some(last)),
		[] => (last, Some(last)),
		[spec] => match index(spec, start_above) {
			Some(n) => (n, Some(if listing { last } else { n })),
			None => (usize::MAX, None),
		},
		[a, b, ..] => (index(a, start_above).unwrap_or(usize::MAX), index(b, last)),
	};
	let Some(mut end_at) = end.take().filter(|_| first != usize::MAX) else {
		ctx.usage("no command found");
		return done(1);
	};
	if end_at < first {
		std::mem::swap(&mut first, &mut end_at);
		reverse = true;
	}
	if !listing {
		return bash::edit(ctx, list, first, end_at, reverse, editor);
	}
	let sep: &[u8] = if ctx.option(OptId::Posix)? {
		b"\t"
	} else {
		b"\t "
	};
	let mut out = Vec::new();
	let mut line = |i: usize| {
		if numbered {
			out.extend_from_slice((i as i64 + list.base).to_string().as_bytes());
		}
		out.extend_from_slice(sep);
		out.extend_from_slice(&list.entries[i]);
		out.push(b'\n');
	};
	if reverse {
		(first..=end_at).rev().for_each(&mut line);
	} else {
		(first..=end_at).for_each(&mut line);
	}
	ctx.out(&out);
	done(0)
}

/// `history -d offset` / `history -d start-end`.
fn delete(ctx: &mut Ctx<'_, '_>, mut list: List, arg: &BString) -> R {
	let lead = usize::from(arg.first() == Some(&b'-'));
	let dash = arg[lead..]
		.iter()
		.position(|&c| c == b'-')
		.map(|i| i + lead);
	let out_of_range = |ctx: &mut Ctx<'_, '_>, what: &[u8]| {
		ctx.usage(format!("{}: history position out of range", what.as_bstr()));
		done(1)
	};
	let (start, end) = if let Some(dash) = dash {
		let (a, b) = (&arg[..dash], &arg[dash + 1..]);
		let (Some(x), Some(y)) = (number(a), number(b)) else {
			return out_of_range(ctx, arg);
		};
		let Some(start) = range_end(a, x, &list) else {
			return out_of_range(ctx, a);
		};
		let Some(end) = range_end(b, y, &list) else {
			return out_of_range(ctx, b);
		};
		(start, end)
	} else {
		let Some(n) = number(arg) else {
			ctx.usage(format!("{}: invalid number", arg.as_bstr()));
			return done(1);
		};
		let Some(at) = position(arg, n, &list) else {
			return out_of_range(ctx, arg);
		};
		(at, at)
	};
	if start <= end {
		list.entries.drain(start..=end);
		list.times.drain(start..=end);
	}
	list.pending = false;
	list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
	done(0)
}

/// `history [n]`: the last `n` entries (all without `n`), numbered.
fn display(ctx: &mut Ctx<'_, '_>, list: &List, rest: &[BString]) -> R {
	let limit = match rest {
		[] => None,
		[n] => {
			let Some(n) = number(n) else {
				ctx.diag(Diag::NumericArg { cmd: "history".into(), arg: n.clone() });
				ctx.usage_error = true;
				return done(2);
			};
			Some(n.unsigned_abs())
		},
		_ => {
			ctx.diag(Diag::TooManyArgs { cmd: "history".into() });
			ctx.usage_error = true;
			return done(2);
		},
	};
	// `HISTTIMEFORMAT`: each entry's time (`??` when it has none) first.
	let timefmt = ctx.scalar(b"HISTTIMEFORMAT")?;
	let tz = ctx.scalar(b"TZ")?.filter(|t| !t.is_empty());
	let len = list.entries.len();
	let first = limit.map_or(0, |n| len.saturating_sub(usize::try_from(n).unwrap_or(usize::MAX)));
	let mut out = Vec::new();
	for (i, line) in list.entries.iter().enumerate().skip(first) {
		out.extend_from_slice(format!("{:5}  ", list.base + i as i64).as_bytes());
		if let Some(fmt) = &timefmt {
			let t = list.times.get(i).copied().unwrap_or(0);
			if t == 0 {
				out.extend_from_slice(b"??");
			} else {
				let (off, abbr) = ctx.cx.host.tz_offset(tz.as_ref().map(|t| t.as_bstr()), t);
				out.extend_from_slice(&super::strftime::format(fmt, t, off, &abbr));
			}
		}
		out.extend_from_slice(line);
		out.push(b'\n');
	}
	ctx.out(&out);
	done(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn list(entries: &[&str]) -> List {
		List {
			entries: entries.iter().map(|e| BString::from(*e)).collect(),
			times: vec![0; entries.len()],
			base: 1,
			..List::default()
		}
	}

	/// Goldens: bash 5.3.20 `history -d` on a 6-entry list.
	#[test]
	fn delete_positions_follow_bash() {
		let l = list(&["a", "b", "c", "d", "e", "f"]);
		assert_eq!(position(b"1", 1, &l), Some(0));
		assert_eq!(position(b"6", 6, &l), Some(5));
		assert_eq!(position(b"7", 7, &l), None);
		assert_eq!(position(b"0", 0, &l), None);
		assert_eq!(position(b"-1", -1, &l), Some(5));
		assert_eq!(position(b"-6", -6, &l), Some(0));
		assert_eq!(position(b"-7", -7, &l), None);
	}

	#[test]
	fn histsize_drops_the_oldest_and_moves_the_base() {
		let mut l = list(&["a", "b"]);
		l.add("c".into(), Some(2), 0);
		assert_eq!(l.entries, ["b", "c"]);
		assert_eq!(l.base, 2);
		l.add("d".into(), None, 0);
		assert_eq!(l.entries.len(), 3);
	}

	#[test]
	fn histcontrol_filters_lines() {
		let mut e = list(&["ls"]);
		assert!(!keep_line(b"ignorespace", b" ls", &mut e));
		assert!(!keep_line(b"ignoredups", b"ls", &mut e));
		assert!(keep_line(b"ignoredups", b"pwd", &mut e));
		assert!(!keep_line(b"ignoreboth", b" x", &mut e));
		assert!(keep_line(b"erasedups", b"ls", &mut e));
		assert!(e.entries.is_empty());
	}
}
