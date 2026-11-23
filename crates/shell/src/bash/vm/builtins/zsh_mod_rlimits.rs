//! zsh/rlimits: `limit`, `ulimit`, `unlimit`.
//!
//! zsh keeps two tables: `limits`, what the commands it starts get, and
//! `current_limits`, the shell process's own. The engine never changes its
//! process's limits, so `limits` is the vproc's
//! [`rlimits`](crate::bash::vm::proc::Vproc::rlimits) over the host's
//! ([`Host::rlimit`](crate::bash::Host::rlimit)), handed to every external
//! it spawns, and `current_limits` is the host's overlaid with what
//! `limit -s`, `unlimit -s` and `ulimit` applied "to the shell"
//! ([`MiscKey::ZshRlimits`]). Applying a limit refuses what `setrlimit(2)`
//! refuses: a soft limit above the hard one (`EINVAL`) and, unprivileged, a
//! hard limit above the current one (`EPERM`).
//!
//! The resources are the platform's `RLIMIT_*` in number order (zsh's
//! `resinfo[]`): macOS has nine (its `RLIMIT_RSS` is `RLIMIT_AS`), Linux
//! sixteen. A resource number past those is the platform's `getrlimit`
//! failing with `EINVAL`.
//!
//! Ported from zsh 5.9 `Src/Builtins/rlimits.c` (MIT-style licence,
//! Copyright (c) 1992-1997 Paul Falstad and the zsh development group).

use std::{fmt::Write as _, io};

use bstr::{BStr, BString, ByteSlice};

use super::{
	Ctx, R, done,
	zsh_args::Ops,
	zsh_mod_util::{zsh_errmsg, zstrtol},
};
use crate::bash::{
	host::Rlimit,
	store::{Key, KeyBuf, MiscKey, Record},
};

/// The platform's `RLIM_INFINITY` as zsh compares values (`rlim_t`).
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, reason = "rlim_t is u64 on 64-bit targets only")]
const INF: u64 = libc::RLIM_INFINITY as u64;
/// The platform's `RLIM_INFINITY` as zsh compares values (`rlim_t`).
#[cfg(not(unix))]
const INF: u64 = u64::MAX;

/// zsh `enum zlimtype`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	/// `ZLIMTYPE_MEMORY`: bytes, shown in `kB`/`MB`.
	Memory,
	/// `ZLIMTYPE_NUMBER`: a count.
	Number,
	/// `ZLIMTYPE_TIME`: seconds, shown as `h:mm:ss`.
	Time,
	/// `ZLIMTYPE_MICROSECONDS` (Linux's `RLIMIT_RTTIME`).
	#[cfg_attr(
		not(target_os = "linux"),
		allow(dead_code, reason = "RLIMIT_RTTIME exists only on Linux")
	)]
	Micro,
}

/// zsh `resinfo_T`: one known resource.
struct ResInfo {
	res:   Rlimit,
	/// `limit`'s name.
	name:  &'static str,
	kind:  Kind,
	/// `ulimit`'s unit in bytes (1, 512 or 1024).
	unit:  u64,
	/// `ulimit`'s option letter.
	opt:   u8,
	/// `ulimit -a`'s description.
	descr: &'static str,
}

const fn ri(
	res: Rlimit,
	name: &'static str,
	kind: Kind,
	unit: u64,
	opt: u8,
	descr: &'static str,
) -> ResInfo {
	ResInfo { res, name, kind, unit, opt, descr }
}

/// zsh's `resinfo[]` on Linux, indexed by `RLIMIT_*` number.
#[cfg(target_os = "linux")]
const RESINFO: &[ResInfo] = &[
	ri(Rlimit::Cpu, "cputime", Kind::Time, 1, b't', "cpu time (seconds)"),
	ri(Rlimit::Fsize, "filesize", Kind::Memory, 512, b'f', "file size (blocks)"),
	ri(Rlimit::Data, "datasize", Kind::Memory, 1024, b'd', "data seg size (kbytes)"),
	ri(Rlimit::Stack, "stacksize", Kind::Memory, 1024, b's', "stack size (kbytes)"),
	ri(Rlimit::Core, "coredumpsize", Kind::Memory, 512, b'c', "core file size (blocks)"),
	ri(Rlimit::Rss, "resident", Kind::Memory, 1024, b'm', "resident set size (kbytes)"),
	ri(Rlimit::Nproc, "maxproc", Kind::Number, 1, b'u', "processes"),
	ri(Rlimit::Nofile, "descriptors", Kind::Number, 1, b'n', "file descriptors"),
	ri(Rlimit::Memlock, "memorylocked", Kind::Memory, 1024, b'l', "locked-in-memory size (kbytes)"),
	ri(Rlimit::Vmem, "addressspace", Kind::Memory, 1024, b'v', "address space (kbytes)"),
	ri(Rlimit::Locks, "maxfilelocks", Kind::Number, 1, b'x', "file locks"),
	ri(Rlimit::Sigpending, "sigpending", Kind::Number, 1, b'i', "pending signals"),
	ri(Rlimit::Msgqueue, "msgqueue", Kind::Number, 1, b'q', "bytes in POSIX msg queues"),
	ri(Rlimit::Nice, "nice", Kind::Number, 1, b'e', "max nice"),
	ri(Rlimit::Rtprio, "rt_priority", Kind::Number, 1, b'r', "max rt priority"),
	ri(Rlimit::Rttime, "rt_time", Kind::Micro, 1, b'N', "rt cpu time (microseconds)"),
];

/// zsh's `resinfo[]` on macOS (and the BSD layout it shares), indexed by
/// `RLIMIT_*` number; `RLIMIT_RSS` is `RLIMIT_AS` there.
#[cfg(not(target_os = "linux"))]
const RESINFO: &[ResInfo] = &[
	ri(Rlimit::Cpu, "cputime", Kind::Time, 1, b't', "cpu time (seconds)"),
	ri(Rlimit::Fsize, "filesize", Kind::Memory, 512, b'f', "file size (blocks)"),
	ri(Rlimit::Data, "datasize", Kind::Memory, 1024, b'd', "data seg size (kbytes)"),
	ri(Rlimit::Stack, "stacksize", Kind::Memory, 1024, b's', "stack size (kbytes)"),
	ri(Rlimit::Core, "coredumpsize", Kind::Memory, 512, b'c', "core file size (blocks)"),
	ri(Rlimit::Vmem, "addressspace", Kind::Memory, 1024, b'v', "address space (kbytes)"),
	ri(Rlimit::Memlock, "memorylocked", Kind::Memory, 1024, b'l', "locked-in-memory size (kbytes)"),
	ri(Rlimit::Nproc, "maxproc", Kind::Number, 1, b'u', "processes"),
	ri(Rlimit::Nofile, "descriptors", Kind::Number, 1, b'n', "file descriptors"),
];

/// `RLIM_NLIMITS`.
const NLIMITS: usize = RESINFO.len();

/// `RLIMIT_FSIZE`, `ulimit`'s default resource.
const FSIZE: usize = 1;

/// A `struct rlimit` in zsh's raw form ([`INF`] is unlimited).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Lim {
	cur: u64,
	max: u64,
}

/// An engine limit (`None`: unlimited) as `rlim_t`.
#[allow(
	clippy::unnecessary_min_or_max,
	reason = "INF is u64::MAX on Linux but i64::MAX on macOS, where the clamp matters"
)]
fn raw(v: Option<u64>) -> u64 {
	v.map_or(INF, |v| v.min(INF))
}

/// An `rlim_t` as an engine limit.
const fn unraw(v: u64) -> Option<u64> {
	if v == INF { None } else { Some(v) }
}

/// zsh's `limits` and `current_limits` for the running builtin: read once,
/// written back by [`State::save`]. A resource the host cannot read keeps
/// its error (zsh would have read it at startup; hosts without resource
/// limits refuse).
struct State {
	host:    Vec<Result<Lim, io::ErrorKind>>,
	limits:  Vec<Result<Lim, io::ErrorKind>>,
	current: Vec<Result<Lim, io::ErrorKind>>,
	euid:    u32,
}

impl State {
	fn load(ctx: &mut Ctx<'_, '_>) -> Result<Self, super::Need> {
		let host: Vec<Result<Lim, io::ErrorKind>> = RESINFO
			.iter()
			.map(|r| {
				ctx.cx
					.host
					.rlimit(r.res)
					.map(|(s, h)| Lim { cur: raw(s), max: raw(h) })
					.map_err(|e| e.kind())
			})
			.collect();
		let limits = RESINFO
			.iter()
			.zip(&host)
			.map(|(r, h)| match ctx.vp.rlimits.iter().find(|(res, ..)| *res == r.res) {
				Some(&(_, s, h)) => Ok(Lim { cur: raw(s), max: raw(h) }),
				None => *h,
			})
			.collect();
		let applied = match ctx.record(Key::Misc(MiscKey::ZshRlimits))? {
			Some(Record::Words(w)) => decode(&w),
			_ => Vec::new(),
		};
		let current = RESINFO
			.iter()
			.zip(&host)
			.map(|(r, h)| match applied.iter().find(|(res, _)| *res == r.res) {
				Some(&(_, l)) => Ok(l),
				None => *h,
			})
			.collect();
		Ok(Self { host, limits, current, euid: ctx.cx.host.user().euid })
	}

	/// Write the changed `limits` to the vproc and `current_limits` to the
	/// store.
	fn save(&self, ctx: &mut Ctx<'_, '_>, before: &Self) {
		for (i, r) in RESINFO.iter().enumerate() {
			if let Ok(l) = self.limits[i]
				&& before.limits[i] != Ok(l)
			{
				let limits = &mut ctx.vp.rlimits;
				limits.retain(|(res, ..)| *res != r.res);
				limits.push((r.res, unraw(l.cur), unraw(l.max)));
			}
		}
		if self.current != before.current {
			let words: Vec<BString> = RESINFO
				.iter()
				.enumerate()
				.filter_map(|(i, r)| {
					let l = self.current[i].ok()?;
					(self.host[i] != Ok(l)).then(|| encode(r.res, l))
				})
				.collect();
			let rec = (!words.is_empty()).then_some(Record::Words(words));
			ctx.store_record(KeyBuf::Misc(MiscKey::ZshRlimits), rec);
		}
	}

	fn snapshot(&self) -> Self {
		Self {
			host:    self.host.clone(),
			limits:  self.limits.clone(),
			current: self.current.clone(),
			euid:    self.euid,
		}
	}
}

/// `resource:soft:hard` (`-` for unlimited), as [`MiscKey::ZshRlimits`]
/// keeps an applied limit.
fn encode(res: Rlimit, l: Lim) -> BString {
	let n = |v: u64| {
		if v == INF {
			String::from("-")
		} else {
			v.to_string()
		}
	};
	format!("{}:{}:{}", <&'static str>::from(res), n(l.cur), n(l.max)).into()
}

/// [`encode`] backwards (malformed entries are skipped).
fn decode(words: &[BString]) -> Vec<(Rlimit, Lim)> {
	words
		.iter()
		.filter_map(|w| {
			let mut parts = w.split_str(":");
			let (name, cur, max) = (parts.next()?, parts.next()?, parts.next()?);
			let res = RESINFO
				.iter()
				.find(|r| <&'static str>::from(r.res).as_bytes() == name)?
				.res;
			let n = |p: &[u8]| -> Option<u64> {
				if p == b"-" {
					Some(INF)
				} else {
					p.to_str().ok()?.parse().ok()
				}
			};
			Some((res, Lim { cur: n(cur)?, max: n(max)? }))
		})
		.collect()
}

/// zsh `zwarnnam(nam, "can't read limit: %e", errno)`.
fn cant_read(ctx: &mut Ctx<'_, '_>, e: io::Error) {
	ctx.usage(format!("can't read limit: {}", zsh_errmsg(&e)));
}

/// `getrlimit` of resource number `lim` past `RLIM_NLIMITS`: `EINVAL`.
fn einval() -> io::Error {
	#[cfg(unix)]
	return io::Error::from_raw_os_error(libc::EINVAL);
	#[cfg(not(unix))]
	return io::ErrorKind::InvalidInput.into();
}

/// What `setrlimit(2)` says to `new` given the process's `cur`.
fn setrlimit_check(new: Lim, cur: Lim, euid: u32) -> io::Result<()> {
	#[cfg(unix)]
	{
		if new.cur > new.max {
			return Err(io::Error::from_raw_os_error(libc::EINVAL));
		}
		if new.max > cur.max && euid != 0 {
			return Err(io::Error::from_raw_os_error(libc::EPERM));
		}
		Ok(())
	}
	#[cfg(not(unix))]
	{
		let _ = (new, cur, euid);
		Err(io::ErrorKind::Unsupported.into())
	}
}

/// zsh `zstrtorlimt(s, &t, 10)`: the value and the unparsed rest.
fn zstrtorlimt(s: &[u8]) -> (u64, &[u8]) {
	if s == b"unlimited" {
		return (INF, &s[9..]);
	}
	let n = s.iter().take_while(|c| c.is_ascii_digit()).count();
	let v = s[..n]
		.iter()
		.fold(0u64, |v, &c| v.wrapping_mul(10).wrapping_add(u64::from(c - b'0')));
	(v, &s[n..])
}

/// zsh `showlimitvalue`.
fn show_value(out: &mut Vec<u8>, lim: usize, val: u64) {
	let r = &RESINFO[lim];
	out.extend_from_slice(format!("{:<16}", r.name).as_bytes());
	let text = if val == INF {
		"unlimited\n".to_owned()
	} else {
		match r.kind {
			// `(int)(val / 3600)`, `(int)(val / 60) % 60`, `(int)(val % 60)`.
			#[allow(clippy::cast_possible_truncation, reason = "zsh's int casts")]
			Kind::Time => format!(
				"{}:{:02}:{:02}\n",
				(val / 3600) as i32,
				((val / 60) as i32) % 60,
				(val % 60) as i32
			),
			Kind::Micro => format!("{val}us\n"),
			Kind::Number => format!("{val}\n"),
			Kind::Memory if val >= 1024 * 1024 => format!("{}MB\n", val / (1024 * 1024)),
			Kind::Memory => format!("{}kB\n", val / 1024),
		}
	};
	out.extend_from_slice(text.as_bytes());
}

/// zsh `showlimits`: one resource (`Some`) or all; status.
fn show_limits(ctx: &mut Ctx<'_, '_>, st: &State, hard: bool, lim: Option<usize>) -> i32 {
	let range = match lim {
		Some(l) if l >= NLIMITS => {
			cant_read(ctx, einval());
			return 1;
		},
		Some(l) => l..l + 1,
		None => 0..NLIMITS,
	};
	let mut out = Vec::new();
	for i in range {
		match st.limits[i] {
			Ok(l) => show_value(&mut out, i, if hard { l.max } else { l.cur }),
			Err(e) => {
				ctx.out(&out);
				cant_read(ctx, e.into());
				return 1;
			},
		}
	}
	ctx.out(&out);
	0
}

/// zsh `printulimit`: status.
fn print_ulimit(ctx: &mut Ctx<'_, '_>, st: &State, lim: usize, hard: bool, head: bool) -> i32 {
	if lim >= NLIMITS {
		cant_read(ctx, einval());
		return 1;
	}
	let l = match st.limits[lim] {
		Ok(l) => l,
		Err(e) => {
			cant_read(ctx, e.into());
			return 1;
		},
	};
	let limit = if hard { l.max } else { l.cur };
	let info = &RESINFO[lim];
	let mut out = String::new();
	if head {
		if info.opt == b'N' {
			let _ = write!(out, "-N {lim:2}: {:<29}", info.descr);
		} else {
			let _ = write!(out, "-{}: {:<32}", char::from(info.opt), info.descr);
		}
	}
	if limit == INF {
		out.push_str("unlimited\n");
	} else {
		let _ = writeln!(out, "{}", limit / info.unit);
	}
	ctx.out(out.as_bytes());
	0
}

/// zsh `zsetlimit`: apply `limits[lim]` to the shell; `Err` after
/// restoring it (and, given a name, a warning).
fn zsetlimit(ctx: &mut Ctx<'_, '_>, st: &mut State, lim: usize, warn: bool) -> Result<(), ()> {
	let (Ok(new), Ok(cur)) = (st.limits[lim], st.current[lim]) else {
		return Err(());
	};
	if new != cur {
		if let Err(e) = setrlimit_check(new, cur, st.euid) {
			if warn {
				ctx.usage(format!("setrlimit failed: {}", zsh_errmsg(&e)));
			}
			st.limits[lim] = Ok(cur);
			return Err(());
		}
		st.current[lim] = Ok(new);
	}
	Ok(())
}

/// zsh `setlimits`: apply every limit; the number that failed.
fn setlimits(ctx: &mut Ctx<'_, '_>, st: &mut State, warn: bool) -> i32 {
	(0..NLIMITS)
		.map(|l| i32::from(zsetlimit(ctx, st, l, warn).is_err()))
		.sum()
}

/// The `limits` and `current_limits` entries of `lim`, or the warning.
fn pair(ctx: &mut Ctx<'_, '_>, st: &State, lim: usize) -> Option<(Lim, Lim)> {
	if lim >= NLIMITS {
		cant_read(ctx, einval());
		return None;
	}
	match (st.limits[lim], st.current[lim]) {
		(Ok(l), Ok(c)) => Some((l, c)),
		(Err(e), _) | (_, Err(e)) => {
			cant_read(ctx, e.into());
			None
		},
	}
}

/// zsh `do_limit`: status 0 or 1.
fn do_limit(
	ctx: &mut Ctx<'_, '_>,
	st: &mut State,
	lim: usize,
	val: u64,
	(hard, soft, set): (bool, bool, bool),
) -> i32 {
	// Past `RLIM_NLIMITS`, zsh's `getrlimit` fails first.
	let Some((mut l, cur)) = pair(ctx, st, lim) else {
		return 1;
	};
	if hard {
		// Only root raises hard limits.
		if val > cur.max && st.euid != 0 {
			ctx.usage("can't raise hard limits");
			return 1;
		}
		l.max = val;
		if val < l.cur {
			l.cur = val;
		}
		st.limits[lim] = Ok(l);
	}
	if soft || !hard {
		if val > l.max {
			if ctx.name.starts_with('u') {
				// `ulimit` raises the hard limit along.
				if val > cur.max && st.euid != 0 {
					ctx.usage("value exceeds hard limit");
					return 1;
				}
				l.max = val;
				l.cur = val;
			} else {
				ctx.usage("limit exceeds hard limit");
				return 1;
			}
		} else {
			l.cur = val;
		}
		st.limits[lim] = Ok(l);
		if set && zsetlimit(ctx, st, lim, true).is_err() {
			return 1;
		}
	}
	0
}

/// zsh `do_unlimit`: status 0 or 1.
fn do_unlimit(
	ctx: &mut Ctx<'_, '_>,
	st: &mut State,
	lim: usize,
	(hard, soft, set): (bool, bool, bool),
) -> i32 {
	let Some((mut l, cur)) = pair(ctx, st, lim) else {
		return 1;
	};
	if hard {
		if st.euid != 0 && cur.max != INF {
			ctx.usage("can't remove hard limits");
			return 1;
		}
		l.max = INF;
	}
	if !hard || soft {
		l.cur = l.max;
	}
	st.limits[lim] = Ok(l);
	if set && zsetlimit(ctx, st, lim, true).is_err() {
		return 1;
	}
	0
}

/// The resource `limit`/`unlimit` argument `s` names: a number, else the
/// one name it starts; the warning otherwise.
fn resource(ctx: &mut Ctx<'_, '_>, s: &[u8]) -> Option<usize> {
	if s.first().is_some_and(u8::is_ascii_digit) {
		#[allow(clippy::cast_possible_truncation, reason = "zsh's (int) cast")]
		let n = zstrtol(s).0 as i32;
		if let Ok(n) = usize::try_from(n) {
			return Some(n);
		}
		ctx.usage(format!("no such resource: {}", s.as_bstr()));
		return None;
	}
	let mut found = None;
	for (i, r) in RESINFO.iter().enumerate() {
		if r.name.as_bytes().starts_with(s) {
			if found.is_some() {
				ctx.usage(format!("ambiguous resource specification: {}", s.as_bstr()));
				return None;
			}
			found = Some(i);
		}
	}
	if found.is_none() {
		ctx.usage(format!("no such resource: {}", s.as_bstr()));
	}
	found
}

/// Run `f` over the limits, then store what changed.
fn with_state(ctx: &mut Ctx<'_, '_>, f: impl FnOnce(&mut Ctx<'_, '_>, &mut State) -> i32) -> R {
	let mut st = State::load(ctx)?;
	let before = st.snapshot();
	let status = f(ctx, &mut st);
	st.save(ctx, &before);
	done(status)
}

/// zsh `bin_limit`: `limit [-hs] [resource [value]] …`.
pub fn limit(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let hard = ops.isset(b'h');
	let set = ops.isset(b's');
	with_state(ctx, |ctx, st| {
		if set && args.is_empty() {
			return setlimits(ctx, st, false);
		}
		if args.is_empty() {
			return show_limits(ctx, st, hard, None);
		}
		let mut ret = 0;
		let mut it = args.iter();
		while let Some(s) = it.next() {
			let Some(lim) = resource(ctx, s) else {
				return 1;
			};
			// Without a value, show the limit (and stop).
			let Some(s) = it.next() else {
				return show_limits(ctx, st, hard, Some(lim));
			};
			let Some(val) = limit_value(ctx, lim, s) else {
				return 1;
			};
			ret += do_limit(ctx, st, lim, val, (hard, !hard, set));
		}
		ret
	})
}

/// `limit`'s value `s` for resource `lim`, scaled by its kind; the
/// warning otherwise.
fn limit_value(ctx: &mut Ctx<'_, '_>, lim: usize, s: &[u8]) -> Option<u64> {
	let scaling = |ctx: &mut Ctx<'_, '_>, rest: &[u8]| {
		ctx.usage(format!("unknown scaling factor: {}", rest.as_bstr()));
		None
	};
	if lim >= NLIMITS {
		let (val, rest) = zstrtorlimt(s);
		return if rest.is_empty() {
			Some(val)
		} else {
			scaling(ctx, rest)
		};
	}
	match RESINFO[lim].kind {
		// Seconds, `Nh`, `Nm` or `M:S`.
		Kind::Time => {
			let (val, rest) = zstrtorlimt(s);
			match rest {
				[] => Some(val),
				[b'h' | b'H'] => Some(val.wrapping_mul(3600)),
				[b'm' | b'M'] => Some(val.wrapping_mul(60)),
				[b':', tail @ ..] => Some(val.wrapping_mul(60).wrapping_add(zstrtorlimt(tail).0)),
				_ => scaling(ctx, rest),
			}
		},
		// A plain number; what follows its digits is ignored.
		Kind::Number | Kind::Micro => {
			let (val, rest) = zstrtorlimt(s);
			if rest.len() == s.len() {
				ctx.usage("limit must be a number");
				return None;
			}
			Some(val)
		},
		// Kilobytes, or `k`, `M`, `G` multiples.
		Kind::Memory => {
			let (val, rest) = zstrtorlimt(s);
			match rest {
				[] | [b'k' | b'K'] => Some(if val == INF {
					val
				} else {
					val.wrapping_mul(1024)
				}),
				[b'M' | b'm'] => Some(val.wrapping_mul(1024 * 1024)),
				[b'G' | b'g'] => Some(val.wrapping_mul(1024 * 1024 * 1024)),
				_ => scaling(ctx, rest),
			}
		},
	}
}

/// zsh `bin_unlimit`: `unlimit [-hs] resource …`.
pub fn unlimit(ctx: &mut Ctx<'_, '_>, ops: &Ops, args: &[BString]) -> R {
	let hard = ops.isset(b'h');
	let set = ops.isset(b's');
	with_state(ctx, |ctx, st| {
		let mut ret = 0;
		if args.is_empty() {
			// Remove every limit.
			for lim in 0..NLIMITS {
				let (Ok(mut l), Ok(cur)) = (st.limits[lim], st.current[lim]) else {
					ret += 1;
					continue;
				};
				if hard {
					if st.euid != 0 && cur.max != INF {
						ret += 1;
					} else {
						l.max = INF;
					}
				} else {
					l.cur = l.max;
				}
				st.limits[lim] = Ok(l);
			}
			if set {
				ret += setlimits(ctx, st, true);
			}
			if ret != 0 {
				ctx.usage("can't remove hard limits");
			}
			return ret;
		}
		for a in args {
			let Some(lim) = resource(ctx, a) else {
				return 1;
			};
			ret += do_unlimit(ctx, st, lim, (hard, !hard, set));
		}
		ret
	})
}

/// zsh `find_resource`: the resource `ulimit -c` names.
fn find_resource(c: u8) -> Option<usize> {
	RESINFO.iter().position(|r| r.opt == c)
}

/// zsh `bin_ulimit`: `ulimit [-SHa] [-{tfdscvlunN…} [value]] …`.
pub fn ulimit(ctx: &mut Ctx<'_, '_>, args: &[BString]) -> R {
	with_state(ctx, |ctx, st| ulimit_in(ctx, st, args))
}

/// The bit of resource `res` in `ulimit`'s `int` mask: zsh's `1 << res`,
/// whose shift count the CPU takes modulo 32 (`ulimit -N 35` shows
/// resource 3).
const fn bit(res: usize) -> u64 {
	1u64 << (res & 31)
}

#[allow(clippy::too_many_lines, reason = "one port of bin_ulimit's loop")]
fn ulimit_in(ctx: &mut Ctx<'_, '_>, st: &mut State, args: &[BString]) -> i32 {
	let (mut resmask, mut hard, mut soft, mut nres, mut all, mut ret) =
		(0u64, false, false, 0, false, 0);
	let mut i = 0;
	loop {
		let options: Option<&[u8]> = args.get(i).map(|w| w.as_slice());
		if options == Some(&b"-"[..]) {
			ctx.usage("missing option letter");
			return 1;
		}
		// `None`: no resource (zsh's -1); a number may be past the table.
		let mut res: Option<usize> = None;
		if let Some(word) = options.filter(|o| o.first() == Some(&b'-')) {
			i += 1;
			let mut j = 1;
			while j < word.len() {
				let c = word[j];
				res = None;
				match c {
					b'H' => {
						hard = true;
						j += 1;
						continue;
					},
					b'S' => {
						soft = true;
						j += 1;
						continue;
					},
					b'N' => {
						let number: &[u8] = if j + 1 < word.len() {
							&word[j + 1..]
						} else if let Some(next) = args.get(i) {
							i += 1;
							next.as_slice()
						} else {
							ctx.usage("number required after -N");
							return 1;
						};
						let (n, rest) = zstrtol(number);
						if !rest.is_empty() {
							ctx.usage(format!("invalid number: {}", number.as_bstr()));
							return 1;
						}
						#[allow(clippy::cast_possible_truncation, reason = "zsh's (int) cast")]
						let n = n as i32;
						// A negative resource reads as none.
						res = usize::try_from(n).ok();
						// The rest of the word was the number.
						j = word.len() - 1;
					},
					b'a' => {
						if resmask != 0 {
							ctx.usage("no limits allowed with -a");
							return 1;
						}
						all = true;
						resmask = (1u64 << NLIMITS) - 1;
						nres = NLIMITS;
						j += 1;
						continue;
					},
					_ => {
						let Some(r) = find_resource(c) else {
							ctx.usage(format!("bad option: -{}", BStr::new(&[c])));
							return 1;
						};
						res = Some(r);
					},
				}
				if j + 1 < word.len() {
					resmask |= res.map_or(0, bit);
					nres += 1;
				}
				if all && res.is_some() {
					ctx.usage("no limits allowed with -a");
					return 1;
				}
				j += 1;
			}
		}
		let arg = args.get(i);
		if arg.is_none_or(|a| a.first() == Some(&b'-')) {
			let r = match res {
				Some(r) => r,
				None if arg.is_some() || nres != 0 => {
					if arg.is_none() {
						break;
					}
					continue;
				},
				None => FSIZE,
			};
			resmask |= bit(r);
			nres += 1;
			if arg.is_none() {
				break;
			}
			continue;
		}
		let arg = arg.expect("checked above");
		if all {
			ctx.usage("no arguments allowed after -a");
			return 1;
		}
		let res = res.unwrap_or(FSIZE);
		if arg.as_slice() == b"unlimited" {
			ret += do_unlimit(ctx, st, res, (hard, soft, true));
		} else {
			let limit = if arg.as_slice() == b"hard" {
				// The shell's own hard limit (`getrlimit`).
				if res >= NLIMITS {
					cant_read(ctx, einval());
					return 1;
				}
				match st.current[res] {
					Ok(c) => c.max,
					Err(e) => {
						cant_read(ctx, e.into());
						return 1;
					},
				}
			} else {
				let (v, rest) = zstrtorlimt(arg);
				if !rest.is_empty() {
					ctx.usage(format!("invalid number: {}", arg.as_bstr()));
					return 1;
				}
				match RESINFO.get(res) {
					Some(r) => v.wrapping_mul(r.unit),
					None => v,
				}
			};
			ret += do_limit(ctx, st, res, limit, (hard, soft, true));
		}
		i += 1;
		if i >= args.len() {
			break;
		}
	}
	let mut res = 0;
	while resmask != 0 {
		if resmask & 1 != 0 {
			ret += print_ulimit(ctx, st, res, hard, nres > 1);
		}
		res += 1;
		resmask >>= 1;
	}
	ret
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn values_show_in_their_units() {
		let idx = |name: &str| RESINFO.iter().position(|r| r.name == name).unwrap();
		let mut out = Vec::new();
		show_value(&mut out, idx("cputime"), 90);
		show_value(&mut out, idx("stacksize"), 8_372_224);
		show_value(&mut out, idx("coredumpsize"), 0);
		show_value(&mut out, idx("descriptors"), INF);
		assert_eq!(
			out.to_str().unwrap(),
			"cputime         0:01:30\nstacksize       7MB\ncoredumpsize    0kB\ndescriptors     \
			 unlimited\n"
		);
	}

	#[test]
	fn numbers_parse_like_zstrtorlimt() {
		assert_eq!(zstrtorlimt(b"unlimited"), (INF, &b""[..]));
		assert_eq!(zstrtorlimt(b"12k"), (12, &b"k"[..]));
	}
}
