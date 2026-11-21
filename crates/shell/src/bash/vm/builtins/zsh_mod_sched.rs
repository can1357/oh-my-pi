//! zsh/sched: the `sched` builtin and `$zsh_scheduled_events`.
//!
//! The event list lives in the store ([`MiscKey::ZshSched`]), in zsh's
//! order (by time; see [`insert`]). Running due events is the interactive
//! reader's job (zsh's `checksched` is a pre-prompt function and a ZLE
//! timed function): it calls [`next_due`] for its idle wakeup and
//! [`take_due`] before each prompt, running each event's command as zsh's
//! `execstring(cmd, 0, 0, "sched")`. A non-interactive shell never runs
//! them, as zsh.
//!
//! Ported from zsh 5.9 `Src/Builtins/sched.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::zx,
	zsh_mod_util::{local_zone, zstrtol, ztrftime},
};
use crate::bash::{
	store::{Key, KeyBuf, MiscKey, Record, StateStore, StoreError},
	vm::{
		proc::Vproc,
		state::{self, Root},
	},
};

/// `SCHEDFLAG_TRASH_ZLE` (`sched -o`): clear the ZLE display before the
/// event runs.
pub const TRASH_ZLE: u8 = 1;

/// One scheduled event (zsh `struct schedcmd`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SchedEvent {
	/// When to run it, seconds since the epoch.
	pub time:  i64,
	/// `SCHEDFLAG_*` bits ([`TRASH_ZLE`]).
	pub flags: u8,
	/// The command (raw bytes), run as `eval` would.
	pub cmd:   BString,
}

impl SchedEvent {
	/// Whether the reader must trash the ZLE display first (`sched -o`).
	pub const fn trash_zle(&self) -> bool {
		self.flags & TRASH_ZLE != 0
	}
}

/// The events a [`MiscKey::ZshSched`] record holds (`time`, `flags`,
/// `cmd` per event).
fn decode(rec: Option<&Record>) -> Vec<SchedEvent> {
	let Some(Record::Words(w)) = rec else {
		return Vec::new();
	};
	w.as_chunks::<3>()
		.0
		.iter()
		.map(|c| SchedEvent {
			time:  c[0].to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(0),
			flags: c[1].to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(0),
			cmd:   c[2].clone(),
		})
		.collect()
}

/// [`decode`] backwards (`None`: no events).
fn encode(events: &[SchedEvent]) -> Option<Record> {
	if events.is_empty() {
		return None;
	}
	let mut w = Vec::with_capacity(events.len() * 3);
	for e in events {
		w.push(BString::from(e.time.to_string()));
		w.push(BString::from(e.flags.to_string()));
		w.push(e.cmd.clone());
	}
	Some(Record::Words(w))
}

/// The scheduled events `vp` sees, in order.
///
/// # Errors
/// A store failure.
pub fn events(store: &mut dyn StateStore, vp: &Vproc) -> Result<Vec<SchedEvent>, StoreError> {
	Ok(decode(state::record(store, vp, Key::Misc(MiscKey::ZshSched))?))
}

/// Store `events` as `vp`'s list.
fn save(root: &mut Root, store: &mut dyn StateStore, vp: &mut Vproc, events: &[SchedEvent]) {
	state::store_record(root, store, vp, KeyBuf::Misc(MiscKey::ZshSched), encode(events));
}

/// When the first event is due (seconds since the epoch): the reader's
/// idle wakeup (zsh's `addtimedfn(checksched, schedcmds->time)`).
///
/// # Errors
/// A store failure.
pub fn next_due(store: &mut dyn StateStore, vp: &Vproc) -> Result<Option<i64>, StoreError> {
	Ok(events(store, vp)?.first().map(|e| e.time))
}

/// zsh `checksched`, one step: remove and return the first event if it is
/// due at `now` (seconds since the epoch). The reader calls it before each
/// prompt (and when [`next_due`] passes while it waits for input) until it
/// returns `None`, running each event before taking the next: an event
/// may schedule or delete others.
///
/// # Errors
/// A store failure.
pub fn take_due(
	root: &mut Root,
	store: &mut dyn StateStore,
	vp: &mut Vproc,
	now: i64,
) -> Result<Option<SchedEvent>, StoreError> {
	let mut ev = events(store, vp)?;
	if ev.first().is_none_or(|e| e.time > now) {
		return Ok(None);
	}
	let first = ev.remove(0);
	save(root, store, vp, &ev);
	Ok(Some(first))
}

/// `$zsh_scheduled_events` (zsh `schedgetfn`): `time:flags:command` per
/// event, `flags` being `-o` or empty.
///
/// # Errors
/// A store failure.
pub fn scheduled_events(
	store: &mut dyn StateStore,
	vp: &Vproc,
) -> Result<Vec<BString>, StoreError> {
	Ok(events(store, vp)?
		.into_iter()
		.map(|e| {
			let flags: &[u8] = if e.trash_zle() { b"-o" } else { b"" };
			let mut s = BString::from(e.time.to_string());
			s.push(b':');
			s.extend_from_slice(flags);
			s.push(b':');
			s.extend_from_slice(&e.cmd);
			s
		})
		.collect())
}

/// Insert `e` in time order as zsh does: before the head when earlier
/// than it, else after the last of the following events earlier than it.
fn insert(events: &mut Vec<SchedEvent>, e: SchedEvent) {
	if events.first().is_none_or(|h| e.time < h.time) {
		events.insert(0, e);
		return;
	}
	let mut k = 0;
	while k + 1 < events.len() && events[k + 1].time < e.time {
		k += 1;
	}
	events.insert(k + 1, e);
}

/// zsh `bin_sched`: `sched [-o] [+]hh:mm[:ss] command…`, `sched [-o]
/// [+]seconds command…`, `sched -N` (delete item N), `sched` (list).
pub fn sched(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	let mut flags = 0;
	let mut i = 0;
	while let Some(a) = args.get(i).filter(|a| a.first() == Some(&b'-')) {
		let arg = &a[1..];
		if arg.first().is_some_and(u8::is_ascii_digit) {
			// `atoi`.
			#[allow(clippy::cast_possible_truncation, reason = "zsh's int")]
			let sn = zstrtol(arg).0 as i32;
			if sn == 0 {
				ctx.usage("usage for delete: sched -<item#>.");
				return done(1);
			}
			let mut ev = events(ctx.cx.store, ctx.vp)?;
			let Some(idx) = usize::try_from(sn - 1).ok().filter(|&n| n < ev.len()) else {
				ctx.usage("not that many entries");
				return done(1);
			};
			ev.remove(idx);
			save(&mut ctx.k.root, ctx.cx.store, ctx.vp, &ev);
			return done(0);
		} else if arg.first() == Some(&b'-') {
			// `--` ends the options.
			i += 1;
			break;
		} else if arg == b"o" {
			flags |= TRASH_ZLE;
		} else {
			match arg.first() {
				Some(&c) => ctx.usage(format!("bad option: -{}", BStr::new(&[c]))),
				None => ctx.usage("option expected"),
			}
			return done(1);
		}
		i += 1;
	}
	let rest = &args[i..];
	let Some(spec) = rest.first() else {
		return list(ctx);
	};
	if rest.len() < 2 {
		ctx.usage("not enough arguments");
		return done(1);
	}
	let Some(time) = parse_time(ctx, spec)? else {
		ctx.usage("bad time specifier");
		return done(1);
	};
	let cmd = BString::from(rest[1..].join(&b" "[..]));
	let mut ev = events(ctx.cx.store, ctx.vp)?;
	insert(&mut ev, SchedEvent { time, flags, cmd });
	save(&mut ctx.k.root, ctx.cx.store, ctx.vp, &ev);
	done(0)
}

/// The time `s` names (`+h:m[:s]`, `+secs`, `h:m[:s][am|pm]` today or
/// tomorrow, raw seconds since the epoch); `None` for a bad specifier.
fn parse_time(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> Result<Option<i64>, super::Need> {
	let now = ctx.cx.host.wall().secs;
	// `h:m[:s]` after the hours: the minutes, seconds and what follows.
	let hms = |rest: &[u8]| -> Option<(i64, i64, Vec<u8>)> {
		let rest = rest.strip_prefix(b":")?;
		let (m, rest) = zstrtol(rest);
		let (sec, rest) = match rest.strip_prefix(b":") {
			Some(r) => zstrtol(r),
			None => (0, rest),
		};
		Some((m, sec, rest.to_vec()))
	};
	if let Some(rel) = s.strip_prefix(b"+") {
		// A relative time.
		let (zl, rest) = zstrtol(rel);
		if let Some((m, sec, tail)) = hms(rest) {
			if !tail.is_empty() {
				return Ok(None);
			}
			return Ok(Some(
				now.wrapping_add(zl.wrapping_mul(3600))
					.wrapping_add(m.wrapping_mul(60))
					.wrapping_add(sec),
			));
		}
		return Ok(rest.is_empty().then(|| now.wrapping_add(zl)));
	}
	let (zl, rest) = zstrtol(s);
	let Some((m, sec, tail)) = hms(rest) else {
		// Raw seconds since the epoch.
		return Ok(rest.is_empty().then_some(zl));
	};
	if tail
		.first()
		.is_some_and(|c| !matches!(c, b'a' | b'A' | b'p' | b'P'))
	{
		return Ok(None);
	}
	let (offset, _) = match zx(ctx, |ex| local_zone(ex, now))? {
		Ok(z) => z,
		Err(d) => {
			ctx.diag(d);
			return Ok(None);
		},
	};
	// Today's local midnight.
	let mut t = now - (now + i64::from(offset)).rem_euclid(86_400);
	let mut h = zl;
	if matches!(tail.first(), Some(b'p' | b'P')) {
		h = h.wrapping_add(12);
	}
	t = t
		.wrapping_add(h.wrapping_mul(3600))
		.wrapping_add(m.wrapping_mul(60))
		.wrapping_add(sec);
	// An earlier time of day is tomorrow's.
	if t < now {
		t += 86_400;
	}
	Ok(Some(t))
}

/// `sched` without arguments: the list, `%3d %a %b %e %k:%M:%S [-o ][--
/// ]command`.
fn list(ctx: &mut Ctx<'_, '_>) -> R {
	let ev = events(ctx.cx.store, ctx.vp)?;
	let mut out = Vec::new();
	for (n, e) in ev.iter().enumerate() {
		let tbuf = match zx(ctx, |ex| ztrftime(ex, b"%a %b %e %k:%M:%S", e.time))? {
			Ok(t) => t,
			Err(d) => {
				ctx.out(&out);
				ctx.diag(d);
				return done(1);
			},
		};
		out.extend_from_slice(format!("{:3} ", n + 1).as_bytes());
		out.extend_from_slice(&tbuf);
		out.push(b' ');
		if e.trash_zle() {
			out.extend_from_slice(b"-o ");
		}
		if e.cmd.first() == Some(&b'-') {
			out.extend_from_slice(b"-- ");
		}
		out.extend_from_slice(&e.cmd);
		out.push(b'\n');
	}
	ctx.out(&out);
	done(0)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn ev(time: i64, cmd: &str) -> SchedEvent {
		SchedEvent { time, flags: 0, cmd: cmd.into() }
	}

	#[test]
	fn insertion_follows_zsh_list_order() {
		let mut v = Vec::new();
		insert(&mut v, ev(5, "a"));
		insert(&mut v, ev(5, "b"));
		insert(&mut v, ev(5, "c"));
		insert(&mut v, ev(1, "d"));
		let cmds: Vec<&[u8]> = v.iter().map(|e| e.cmd.as_slice()).collect();
		assert_eq!(cmds, [&b"d"[..], b"a", b"c", b"b"]);
	}

	#[test]
	fn records_round_trip() {
		let v = vec![ev(10, "x y"), SchedEvent { time: 20, flags: TRASH_ZLE, cmd: "-z".into() }];
		assert_eq!(decode(encode(&v).as_ref()), v);
		assert_eq!(encode(&[]), None);
	}
}
