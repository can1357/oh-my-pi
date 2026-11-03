//! The `history` builtin and the history list (bash `builtins/history.def`
//! and `bashhist.c`), kept in the state store, and zsh's `fc -l`/`history`
//! listing of it ([`zsh_fc`]).
//!
//! The list holds the lines the reader [`remember`]s while `set -o history`
//! is on, plus `history -s` entries. Entries are numbered from a base that
//! grows as `HISTSIZE` drops the oldest ones. History files (`-a`, `-n`,
//! `-r`, `-w`), history expansion (`-p`) and `HISTTIMEFORMAT` timestamps
//! are not supported and fail loudly.

use bstr::{BString, ByteSlice};

use super::{
	Control, Ctx, Outcome, R, done, number, opts, zsh_args::Ops, zsh_print::charset,
	zsh_quote::niceformat,
};
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
	zshopt::ZshOpt,
};

/// The history list as stored: entries, the number of the first one
/// (bash's `history_base`), and whether the last entry is the current
/// input line, added by [`remember`] and not yet replaced by `history -s`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct List {
	entries: Vec<BString>,
	base:    i64,
	pending: bool,
}

impl List {
	/// Read the list (`MiscKey::History` entries, `MiscKey::HistoryCounts`
	/// = `[base, pending]`).
	fn load(store: &mut dyn StateStore, vp: &Vproc) -> Result<Self, StoreError> {
		let entries = match state::record(store, vp, Key::Misc(MiscKey::History))? {
			Some(Record::Words(w)) => w.clone(),
			_ => Vec::new(),
		};
		let counts = match state::record(store, vp, Key::Misc(MiscKey::HistoryCounts))? {
			Some(Record::Words(w)) => w.clone(),
			_ => Vec::new(),
		};
		let base = counts.first().and_then(|b| number(b)).unwrap_or(1);
		let pending = counts.get(1).is_some_and(|p| p == "1");
		Ok(Self { entries, base, pending })
	}

	/// Write the list back.
	fn save(self, root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc) {
		let entries = (!self.entries.is_empty()).then_some(Record::Words(self.entries));
		state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::History), entries);
		let counts = vec![
			BString::from(self.base.to_string()),
			BString::from(if self.pending { "1" } else { "0" }),
		];
		state::store_record(
			root,
			store,
			vp,
			KeyBuf::Misc(MiscKey::HistoryCounts),
			Some(Record::Words(counts)),
		);
	}

	/// Append `line`, then drop the oldest entries past `HISTSIZE`
	/// (bash's `stifle_history`), moving the base along.
	fn add(&mut self, line: BString, size: Option<usize>) {
		self.entries.push(line);
		if let Some(max) = size
			&& self.entries.len() > max
		{
			let drop = self.entries.len() - max;
			self.entries.drain(..drop);
			self.base += drop as i64;
		}
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
/// `erasedups` removes earlier copies from `entries`.
fn keep_line(control: &[u8], line: &[u8], entries: &mut Vec<BString>) -> bool {
	let mut keep = true;
	for word in control.split(|&c| c == b':') {
		match word {
			b"ignorespace" => keep &= !line.starts_with(b" "),
			b"ignoredups" => keep &= entries.last().is_none_or(|last| last != line),
			b"ignoreboth" => {
				keep &= !line.starts_with(b" ") && entries.last().is_none_or(|last| last != line);
			},
			b"erasedups" => entries.retain(|e| e != line),
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
	if vp.mode.dialect() == Dialect::Zsh {
		return Ok(state::zsh_option(root, store, vp, ZshOpt::Interactive)?
			&& state::zsh_option(root, store, vp, ZshOpt::Shinstdin)?);
	}
	state::option(root, store, vp, OptId::History)
}

/// The reader's hook once it parsed a command while [`recording`]: `lines`
/// (the input lines the command spans, without their newlines) join the
/// history list. bash (`maybe_add_history`) adds each line unless
/// `HISTCONTROL` excludes it; zsh (`hend`) adds them as one event, joined
/// by newlines, without the blank lines before it (each its own discarded
/// event). A store failure is recorded on the kernel.
pub fn remember(k: &mut Kernel, store: &mut dyn StateStore, vp: &mut Vproc, lines: Vec<BString>) {
	let res = if vp.mode.dialect() == Dialect::Zsh {
		let Some(start) = lines
			.iter()
			.position(|l| !l.iter().all(u8::is_ascii_whitespace))
		else {
			return;
		};
		let event = bstr::join(b"\n", &lines[start..]);
		try_remember_zsh(&mut k.root, store, vp, event.into())
	} else {
		lines
			.iter()
			.try_for_each(|line| try_remember(&mut k.root, store, vp, line))
	};
	if let Err(e) = res {
		k.fail(e);
	}
}

/// zsh: append `event` and trim the list to `HISTSIZE`.
fn try_remember_zsh(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	event: BString,
) -> Result<(), StoreError> {
	let mut list = List::load(store, vp)?;
	let size = hist_size(
		scalar(root, store, vp, b"HISTSIZE")?
			.as_ref()
			.map(|v| v.as_slice()),
	);
	list.add(event, size);
	list.pending = true;
	list.save(root, store, vp);
	Ok(())
}

fn try_remember(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	line: &[u8],
) -> Result<(), StoreError> {
	let mut list = List::load(store, vp)?;
	let control = scalar(root, store, vp, b"HISTCONTROL")?.unwrap_or_default();
	if !keep_line(&control, line, &mut list.entries) {
		list.pending = false;
		list.save(root, store, vp);
		return Ok(());
	}
	let size = hist_size(
		scalar(root, store, vp, b"HISTSIZE")?
			.as_ref()
			.map(|v| v.as_slice()),
	);
	list.add(BString::from(line), size);
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
		list.entries.clear();
		list.pending = false;
	}
	if o.has(b's') {
		if !o.rest.is_empty() {
			// bash's `push_history`: the `history -s` line itself goes.
			if list.pending {
				list.entries.pop();
				list.pending = false;
			}
			let size = hist_size(ctx.scalar(b"HISTSIZE")?.as_ref().map(|v| v.as_slice()));
			list.add(bstr::join(b" ", o.rest).into(), size);
		}
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		return done(0);
	}
	if o.has(b'p') {
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		if o.rest.is_empty() {
			return done(0);
		}
		ctx.err(Diag::Unsupported { what: "-p (history expansion)".into() });
		return done(1);
	}
	if let Some(arg) = o.arg(b'd') {
		return delete(ctx, list, arg);
	}
	if let Some(&flag) = files.first() {
		list.save(&mut ctx.k.root, ctx.cx.store, ctx.vp);
		ctx.err(Diag::Unsupported { what: format!("-{} (history files)", flag as char).into() });
		return done(1);
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
		ctx.err(Diag::Unsupported { what: "editing history entries (fc without -l or -s)".into() });
		return done(1);
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

/// The zsh view of the history list: event numbers `first..=cur`
/// (`firsthist()`, `curhist`), and the number of the event being run
/// (`curline.histnum`; `0` when the running command is not in the list).
struct Events<'a> {
	list:  &'a List,
	first: i64,
	cur:   i64,
	line:  i64,
}

impl<'a> Events<'a> {
	const fn new(list: &'a List) -> Self {
		let cur = list.base + list.entries.len() as i64 - 1;
		let first = if list.entries.is_empty() {
			cur
		} else {
			list.base
		};
		Self { list, first, cur, line: if list.pending { cur } else { 0 } }
	}

	/// The text of event `n` (in range).
	fn text(&self, n: i64) -> &'a BString {
		&self.list.entries[usize::try_from(n - self.list.base).unwrap_or(0)]
	}

	/// zsh `gethistent`: event `ev`, else with `dir` > 0 the next newer,
	/// with `dir` < 0 the next older one.
	fn get(&self, ev: i64, dir: i64) -> Option<i64> {
		if self.list.entries.is_empty() {
			None
		} else if (self.first..=self.cur).contains(&ev) {
			Some(ev)
		} else if ev < self.first {
			(dir > 0).then_some(self.first)
		} else {
			(dir < 0).then_some(self.cur)
		}
	}

	/// zsh `addhistnum`: the event `n` events from `hl`.
	fn add(&self, hl: i64, mut n: i64) -> i64 {
		let dir = n.signum();
		let Some(he) = self.get(hl, dir) else {
			return 0;
		};
		if he != hl {
			n -= dir;
		}
		let target = he + n;
		if (self.first..=self.cur).contains(&target) {
			target
		} else if dir < 0 {
			self.first - 1
		} else {
			self.cur + 1
		}
	}

	/// zsh `hcomsearch`: the newest event before the latest one that
	/// starts with `prefix`.
	fn search(&self, prefix: &[u8]) -> Option<i64> {
		(self.first..self.cur)
			.rev()
			.find(|&n| self.text(n).starts_with(prefix))
	}
}

/// zsh `fcgetcomm`: an event number (negative: relative to the running
/// command), else the newest event starting with `s`; `None` after a
/// warning when none does.
fn fc_event(ctx: &mut Ctx<'_, '_>, ev: &Events<'_>, s: &[u8]) -> Option<i64> {
	let cmd = zsh_atoi(s);
	if cmd != 0 || s.first() == Some(&b'0') {
		return Some(if cmd < 0 {
			ev.add(ev.line, cmd).max(0)
		} else {
			cmd
		});
	}
	let found = ev.search(s);
	if found.is_none() {
		ctx.diag(Diag::Usage { msg: format!("event not found: {}", s.as_bstr()).into() }.by("fc"));
	}
	found
}

/// C `atoi`: optional blanks and sign, then the leading digits.
fn zsh_atoi(s: &[u8]) -> i64 {
	// C `isspace` (not bstr's Unicode `trim_start`, whose DFA tables cost
	// relocations at every start).
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

/// zsh `bin_fc` for `fc` and `history` (which implies `-l`): lists events
/// (`-l`, with `-n` without numbers, `-r` newest first, `old=new`
/// substitutions applied to the listed text). Re-running events, history
/// files (`-pPRWA`), pattern selection (`-m`) and timestamps (`-dfEitD`)
/// are not supported and fail loudly.
pub fn zsh_fc(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	for (c, what) in [
		(b'p', "-p (history stack)"),
		(b'P', "-P (history stack)"),
		(b'R', "-R (history files)"),
		(b'W', "-W (history files)"),
		(b'A', "-A (history files)"),
		(b'm', "-m (history patterns)"),
	]
	.into_iter()
	.chain(
		b"dfEitD"
			.iter()
			.map(|&c| (c, "-dfEitD (history timestamps)")),
	) {
		if ops.isset(c) {
			ctx.err(Diag::Unsupported { what: format!("{} {what}", ctx.name).into() });
			return done(1);
		}
	}
	if !ops.isset(b'l') {
		ctx.err(Diag::Unsupported {
			what: format!("{} without -l (re-running history events)", ctx.name).into(),
		});
		return done(1);
	}
	let list = List::load(ctx.cx.store, ctx.vp)?;
	let ev = Events::new(&list);
	let mut args = args;
	let mut subs: Vec<(&[u8], &[u8])> = Vec::new();
	while let Some((arg, rest)) = args.split_first()
		&& let Some(eq) = arg.find_byte(b'=')
	{
		if eq == 0 {
			ctx.usage(format!("invalid replacement pattern: ={}", arg[1..].as_bstr()));
			return done(1);
		}
		subs.push((&arg[..eq], &arg[eq + 1..]));
		args = rest;
	}
	let mut spec = [-1_i64; 2];
	for slot in &mut spec {
		let Some((arg, rest)) = args.split_first() else {
			break;
		};
		let Some(n) = fc_event(ctx, &ev, arg) else {
			return done(1);
		};
		*slot = n;
		args = rest;
	}
	if !args.is_empty() {
		ctx.diag(Diag::Usage { msg: "too many arguments".into() }.by("fc"));
		return done(1);
	}
	let [mut first, mut last] = spec;
	if last == -1 {
		last = if first < ev.cur {
			let last = if ev.line == ev.cur {
				ev.add(ev.cur, -1)
			} else {
				ev.cur
			};
			last.max(ev.first)
		} else {
			first
		};
	}
	if first == -1 {
		first = ev.add(ev.cur, -16).max(1);
		last = last.max(first);
	}
	if ops.isset(b'r') {
		std::mem::swap(&mut first, &mut last);
	}
	let dir = if first < last { 1 } else { -1 };
	let before_last = |n: i64| if dir > 0 { n <= last } else { n >= last };
	let start = ev.get(first, dir).filter(|&n| before_last(n));
	let Some(start) = start else {
		let msg = if first == last {
			format!("no such event: {first}")
		} else {
			"no events in that range".to_owned()
		};
		ctx.diag(Diag::Usage { msg: msg.into() }.by("fc"));
		return done(1);
	};
	let cs = charset(ctx)?;
	let mut out = Vec::new();
	let mut subbed = subs.is_empty();
	let mut n = start;
	while (ev.first..=ev.cur).contains(&n) && before_last(n) {
		let mut text = ev.text(n).clone();
		for &(old, new) in &subs {
			if text.find(old).is_some() {
				text = text.replace(old, new).into();
				subbed = true;
			}
		}
		if !ops.isset(b'n') {
			out.extend_from_slice(format!("{n:>5}  ").as_bytes());
		}
		out.extend_from_slice(&niceformat(&text, false, cs));
		out.push(b'\n');
		n += dir;
	}
	ctx.out(&out);
	if !subbed {
		ctx.diag(Diag::Usage { msg: "no substitutions performed".into() }.by("fc"));
		return done(1);
	}
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
	if ctx.scalar(b"HISTTIMEFORMAT")?.is_some() {
		ctx.err(Diag::Unsupported { what: "HISTTIMEFORMAT (history timestamps)".into() });
		return done(1);
	}
	let len = list.entries.len();
	let first = limit.map_or(0, |n| len.saturating_sub(usize::try_from(n).unwrap_or(usize::MAX)));
	let mut out = Vec::new();
	for (i, line) in list.entries.iter().enumerate().skip(first) {
		out.extend_from_slice(format!("{:5}  ", list.base + i as i64).as_bytes());
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
			base:    1,
			pending: false,
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
		l.add("c".into(), Some(2));
		assert_eq!(l.entries, ["b", "c"]);
		assert_eq!(l.base, 2);
		l.add("d".into(), None);
		assert_eq!(l.entries.len(), 3);
	}

	#[test]
	fn histcontrol_filters_lines() {
		let mut e: Vec<BString> = vec!["ls".into()];
		assert!(!keep_line(b"ignorespace", b" ls", &mut e));
		assert!(!keep_line(b"ignoredups", b"ls", &mut e));
		assert!(keep_line(b"ignoredups", b"pwd", &mut e));
		assert!(!keep_line(b"ignoreboth", b" x", &mut e));
		assert!(keep_line(b"erasedups", b"ls", &mut e));
		assert!(e.is_empty());
	}
}
