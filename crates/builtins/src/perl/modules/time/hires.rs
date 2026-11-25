//! Time::HiRes: clocks, sleeps, interpreter alarms and high-resolution file times.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use omp_vfs::FileTime;

use super::calendar;
use crate::perl::{
	interp::{Cx, Flow, Interp, NativeFn, PResult, Ret},
	io::{self, FileTestTarget},
	modules::{arg, boolean, constant, export, text, version},
	value::{PStr, Ref, Sv, Value},
};

const PKG: &str = "Time::HiRes";
const FUNCTIONS: &[(&str, NativeFn, Option<&str>)] = &[
	("time", time, Some("")), ("gettimeofday", gettimeofday, Some("")),
	("tv_interval", tv_interval, None), ("clock", clock, Some("")),
	("sleep", sleep, Some(";@")), ("usleep", usleep, Some("$")), ("nanosleep", nanosleep, Some("$")),
	("alarm", alarm, Some("$;$")), ("ualarm", ualarm, Some("$;$")),
	("getitimer", getitimer, Some("$")), ("setitimer", setitimer, Some("$$;$")),
	("clock_gettime", clock_gettime, Some(";$")), ("clock_getres", clock_getres, Some(";$")),
	("clock_nanosleep", clock_nanosleep, Some("$$;$")),
	("stat", stat, Some(";$")), ("lstat", lstat, Some(";$")), ("utime", utime, Some("$$@")),
];
const CAPABILITIES: &[&str] = &["d_usleep", "d_ualarm", "d_gettimeofday", "d_getitimer", "d_setitimer",
	"d_nanosleep", "d_clock_gettime", "d_clock_getres", "d_clock", "d_clock_nanosleep",
	"d_hires_stat", "d_futimens", "d_utimensat", "d_hires_utime"];
const CLOCKS: &[(&str, i64)] = &[
	("CLOCKS_PER_SEC", 1_000_000), ("CLOCK_REALTIME", 0),
	("CLOCK_MONOTONIC", if cfg!(target_vendor = "apple") { 6 } else { 1 }),
	("CLOCK_PROCESS_CPUTIME_ID", if cfg!(target_vendor = "apple") { 12 } else { 2 }),
	("CLOCK_THREAD_CPUTIME_ID", if cfg!(target_vendor = "apple") { 16 } else { 3 }),
	("CLOCK_MONOTONIC_RAW", 4), ("ITIMER_REAL", 0), ("ITIMER_VIRTUAL", 1), ("ITIMER_PROF", 2),
	#[cfg(target_vendor = "apple")] ("CLOCK_UPTIME_RAW", 8),
	#[cfg(target_os = "linux")] ("CLOCK_REALTIME_COARSE", 5),
	#[cfg(target_os = "linux")] ("CLOCK_MONOTONIC_COARSE", 6),
	#[cfg(target_os = "linux")] ("CLOCK_BOOTTIME", 7),
	#[cfg(target_os = "linux")] ("TIMER_ABSTIME", 1),
];
const VENDOR_CLOCKS: &[&str] = &["CLOCK_BOOTTIME", "CLOCK_HIGHRES", "CLOCK_MONOTONIC_COARSE", "CLOCK_MONOTONIC_FAST",
	"CLOCK_MONOTONIC_PRECISE", "CLOCK_MONOTONIC_RAW", "CLOCK_PROF", "CLOCK_REALTIME_COARSE", "CLOCK_REALTIME_FAST",
	"CLOCK_REALTIME_PRECISE", "CLOCK_REALTIME_RAW", "CLOCK_SECOND", "CLOCK_SOFTTIME", "CLOCK_TIMEOFDAY", "CLOCK_UPTIME",
	"CLOCK_UPTIME_COARSE", "CLOCK_UPTIME_FAST", "CLOCK_UPTIME_PRECISE", "CLOCK_UPTIME_RAW", "CLOCK_VIRTUAL", "ITIMER_REALPROF", "TIMER_ABSTIME"];

/// Install the clocks, timers and timestamp APIs exported by Time::HiRes.
pub(super) fn load(interp: &mut Interp<'_>) {
	version(interp, PKG, "1.9767");
	for &(name, func, proto) in FUNCTIONS {
		let qualified = format!("{PKG}::{name}");
		if let Some(p) = proto { interp.define_native_proto(&qualified, func, p); }
		else { interp.define_native(&qualified, func); }
	}
	for &(name, n) in CLOCKS { constant(interp, &format!("{PKG}::{name}"), Value::Int(n)); }
	for name in CAPABILITIES {
		constant(interp, &format!("{PKG}::{name}"), Value::Int(i64::from(cfg!(unix) || !matches!(*name,
			"d_getitimer" | "d_setitimer" | "d_clock_gettime" | "d_clock_getres" | "d_clock_nanosleep" | "d_futimens" | "d_utimensat"))));
	}
	for name in VENDOR_CLOCKS {
		if !CLOCKS.iter().any(|&(clock, _)| clock == *name) { interp.define_native_proto(&format!("{PKG}::{name}"), vendor_macro, ""); }
	}
	let names = FUNCTIONS.iter().map(|x| x.0).chain(CAPABILITIES.iter().copied()).chain(CLOCKS.iter().map(|x| x.0)).chain(VENDOR_CLOCKS.iter().copied()).collect::<Vec<_>>();
	export(interp, PKG, &[], &names);
}

fn vendor_macro(interp: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = interp.current_sub_name().unwrap_or_else(|| "Time::HiRes".into());
	let name = name.rsplit("::").next().unwrap_or(&name);
	Err(interp.die_msg(format!("Your vendor has not defined Time::HiRes macro {name}, used")))
}
fn usage(interp: &mut Interp<'_>, func: &str, sig: &str) -> Flow { interp.die_msg(format!("Usage: Time::HiRes::{func}({sig})")) }
fn one(v: Value) -> PResult<Ret> { Ok(Ret::One(v)) }

fn time(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "time", "")); }
	one(Value::Num(calendar::epoch_f64()))
}
fn gettimeofday(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "gettimeofday", "")); }
	let (sec, usec) = match SystemTime::now().duration_since(UNIX_EPOCH) {
		Ok(d) => (d.as_secs() as i64, i64::from(d.subsec_micros())),
		Err(e) => { let d = e.duration(); let u = i64::from(d.subsec_micros()); (-(d.as_secs() as i64) - i64::from(u != 0), (-u).rem_euclid(1_000_000)) }
	};
	if cx == Cx::List { Ok(Ret::Many(vec![Value::Int(sec), Value::Int(usec)])) }
	else { one(Value::Num(sec as f64 + usec as f64 * 1e-6)) }
}
fn tv_interval(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut secs = [0.0, calendar::epoch_f64()];
	let mut micros = [0.0, 0.0];
	for i in 0..a.len().min(2) {
		let v = arg(&a, i);
		if i == 1 && !v.truthy() { break; }
		if let Value::Ref(Ref::Array(array)) = v {
			let [sec, usec] = {
				let elems = array.elems();
				[elems.first().cloned(), elems.get(1).cloned()]
			};
			secs[i] = if let Some(sec) = sec { interp.read_sv(&sec)?.to_f64() } else { 0.0 };
			micros[i] = if let Some(usec) = usec { interp.read_sv(&usec)?.to_f64() } else { 0.0 };
		} else if !v.is_undef() {
			let v = v.to_pstr();
			return Err(interp.die_msg(format!("Can't use string (\"{}\") as an ARRAY ref while \"strict refs\" in use", v.to_string_lossy())));
		}
	}
	one(Value::Num(secs[1] - secs[0] + (micros[1] - micros[0]) * 1e-6))
}

/// Cumulative user and system CPU seconds for this process or its reaped children.
pub(super) fn resource_time(children: bool) -> (f64, f64) {
	#[cfg(unix)] {
		use nix::sys::{resource::{UsageWho, getrusage}, time::TimeValLike};
		let who = if children { UsageWho::RUSAGE_CHILDREN } else { UsageWho::RUSAGE_SELF };
		if let Ok(time) = getrusage(who) {
			return (time.user_time().num_microseconds() as f64 * 1e-6, time.system_time().num_microseconds() as f64 * 1e-6);
		}
	}
	let _ = children;
	(0.0, 0.0)
}
/// Cumulative user plus system CPU time of the current process.
pub(super) fn cpu_seconds() -> f64 { let (u, s) = resource_time(false); u + s }
fn clock(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !a.is_empty() { return Err(usage(interp, "clock", "")); }
	one(Value::Num(cpu_seconds()))
}

fn nap(interp: &mut Interp<'_>, duration: Option<Duration>) -> PResult<f64> {
	let start = Instant::now();
	let deadline = match duration {
		Some(d) => Some(start.checked_add(d).ok_or_else(|| interp.die_msg("Time::HiRes sleep duration out of range"))?),
		None => None,
	};
	loop {
		let now = Instant::now();
		let alarm = interp.alarm_deadline();
		interp.poll()?;
		if alarm.is_some_and(|t| t <= now) { break; }
		if deadline.is_some_and(|t| t <= now) { break; }
		let duration = [deadline, alarm].into_iter().flatten().map(|t| t.saturating_duration_since(now))
			.min().unwrap_or(Duration::MAX).min(Duration::from_millis(20));
		std::thread::sleep(duration);
	}
	Ok(start.elapsed().as_secs_f64())
}
fn sleep_for(interp: &mut Interp<'_>, a: &[Sv], func: &str, unit: f64, signature: &str) -> PResult<Ret> {
	if a.is_empty() && func == "sleep" { return one(Value::Num(nap(interp, None)?)); }
	if a.len() != 1 && func != "sleep" { return Err(usage(interp, func, signature)); }
	let t = arg(a, 0).to_f64();
	if t < 0.0 { return Err(interp.die_msg(format!("Time::HiRes::{func}({}): negative time not invented yet", text(a, 0)))); }
	let Ok(duration) = Duration::try_from_secs_f64(t / unit) else { return Err(interp.die_msg(format!("Time::HiRes::{func}({}): time out of range", text(a, 0)))); };
	let elapsed = if duration.is_zero() { interp.poll()?; 0.0 } else { nap(interp, Some(duration))? };
	one(Value::Num(elapsed * unit))
}
fn sleep(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { sleep_for(interp, &a, "sleep", 1.0, "seconds") }
fn usleep(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { sleep_for(interp, &a, "usleep", 1e6, "usec") }
fn nanosleep(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { sleep_for(interp, &a, "nanosleep", 1e9, "nsec") }

fn timer_pair(interp: &Interp<'_>) -> (f64, f64) {
	(interp.alarm_deadline().map_or(0.0, |t| t.saturating_duration_since(Instant::now()).as_secs_f64()),
		interp.alarm_interval().map_or(0.0, |d| d.as_secs_f64()))
}
fn timer_set(interp: &mut Interp<'_>, value: f64, interval: f64) -> bool {
	let Some(value) = Duration::try_from_secs_f64(value).ok() else { interp.set_errno_code(libc::EINVAL); return false; };
	let Some(interval) = Duration::try_from_secs_f64(interval).ok() else { interp.set_errno_code(libc::EINVAL); return false; };
	let deadline = if value.is_zero() { None } else {
		let Some(deadline) = Instant::now().checked_add(value) else { interp.set_errno_code(libc::EINVAL); return false; };
		Some(deadline)
	};
	interp.set_alarm_interval(deadline, (!interval.is_zero()).then_some(interval));
	true
}
fn alarm_for(interp: &mut Interp<'_>, a: &[Sv], func: &str, sig: &str, unit: f64) -> PResult<Ret> {
	if !(1..=2).contains(&a.len()) { return Err(usage(interp, func, sig)); }
	let n = arg(a, 0).to_f64();
	let interval = arg(a, 1).to_f64();
	if n < 0.0 || interval < 0.0 { return Err(interp.die_msg(format!("Time::HiRes::{func}({n}, {interval}): negative time not invented yet"))); }
	let old = timer_pair(interp).0 * unit;
	if !timer_set(interp, n / unit, interval / unit) { return one(Value::Undef); }
	one(if unit == 1e6 { Value::Int(old as i64) } else { Value::Num(old) })
}
fn alarm(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { alarm_for(interp, &a, "alarm", "seconds, interval=0", 1.0) }
fn ualarm(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { alarm_for(interp, &a, "ualarm", "useconds, uinterval=0", 1e6) }
fn itimer(cx: Cx, (value, interval): (f64, f64)) -> PResult<Ret> {
	if cx == Cx::List { Ok(Ret::Many(vec![Value::Num(value), Value::Num(interval)])) } else { one(Value::Num(value)) }
}
fn bad_timer(interp: &mut Interp<'_>, cx: Cx) -> PResult<Ret> {
	interp.set_errno_code(libc::EINVAL);
	if cx == Cx::List { Ok(Ret::Many(Vec::new())) } else { one(Value::Undef) }
}
fn getitimer(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if a.len() != 1 { return Err(usage(interp, "getitimer", "which")); }
	match arg(&a, 0).to_i64() {
		0 => itimer(cx, timer_pair(interp)),
		1 | 2 => itimer(cx, (0.0, 0.0)),
		_ => bad_timer(interp, cx),
	}
}
fn setitimer(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	if !(2..=3).contains(&a.len()) { return Err(usage(interp, "setitimer", "which, seconds, interval = 0")); }
	let w = arg(&a, 0).to_i64();
	let t = arg(&a, 1).to_f64();
	let d = arg(&a, 2).to_f64();
	if t < 0.0 || d < 0.0 { return Err(interp.die_msg(format!("Time::HiRes::setitimer({w}, {t}, {d}): negative time not invented yet"))); }
	if w != 0 {
		if matches!(w, 1 | 2) && t == 0.0 { return itimer(cx, (0.0, 0.0)); }
		return bad_timer(interp, cx);
	}
	let old = timer_pair(interp);
	if !timer_set(interp, t, d) { return bad_timer(interp, cx); }
	itimer(cx, old)
}

fn read_clock(id: i64, res: bool) -> Option<f64> {
	#[cfg(unix)] {
		use rustix::time::{ClockId, clock_getres, clock_gettime};
		let id = ClockId::try_from(libc::clockid_t::try_from(id).ok()?).ok()?;
		let t = if res { clock_getres(id) } else { clock_gettime(id) };
		Some(t.tv_sec as f64 + t.tv_nsec as f64 * 1e-9)
	}
	#[cfg(not(unix))] { if id == 0 { Some(if res { 1e-6 } else { calendar::epoch_f64() }) } else { None } }
}
fn clock_value(interp: &mut Interp<'_>, a: &[Sv], res: bool) -> PResult<Ret> {
	if a.len() > 1 { return Err(usage(interp, if res { "clock_getres" } else { "clock_gettime" }, "clock_id = CLOCK_REALTIME")); }
	if let Some(x) = read_clock(arg(a, 0).to_i64(), res) { one(Value::Num(x)) }
	else { interp.set_errno_code(libc::EINVAL); one(Value::Int(-1)) }
}
fn clock_gettime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { clock_value(interp, &a, false) }
fn clock_getres(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { clock_value(interp, &a, true) }
fn clock_nanosleep(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !(2..=3).contains(&a.len()) { return Err(usage(interp, "clock_nanosleep", "clock_id, nsec, flags = 0")); }
	if !cfg!(target_os = "linux") { return Err(interp.die_msg("Time::HiRes::clock_nanosleep(): unimplemented in this platform")); }
	let id = arg(&a, 0).to_i64();
	let nsec = arg(&a, 1).to_f64();
	let flags = arg(&a, 2).to_i64();
	if nsec < 0.0 { return Err(interp.die_msg(format!("Time::HiRes::clock_nanosleep({id}, {nsec}, {flags}): negative time not invented yet"))); }
	let Some(clock) = read_clock(id, false).filter(|_| matches!(flags, 0 | 1)) else {
		interp.set_errno_code(libc::EINVAL);
		return one(Value::Int(-1));
	};
	let sleep = (nsec * 1e-9 - if flags == 1 { clock } else { 0.0 }).max(0.0);
	let Ok(duration) = Duration::try_from_secs_f64(sleep) else { interp.set_errno_code(libc::EINVAL); return one(Value::Int(-1)); };
	one(Value::Num(nap(interp, Some(duration))? * 1e9))
}

fn high_stat(interp: &mut Interp<'_>, a: &[Sv], cx: Cx, follow: bool) -> PResult<Ret> {
	if a.len() > 1 { return Err(usage(interp, if follow { "stat" } else { "lstat" }, "file = $_")); }
	let v = a.first().cloned().unwrap_or_else(|| interp.topic());
	let v = interp.read_sv(&v)?;
	let meta = match v {
		Value::Glob(g) | Value::Ref(Ref::Glob(g)) => if let Some(h) = g.io.borrow().clone() {
			io::stat_metadata(interp.host(), FileTestTarget::Handle(&h), follow)
		} else { Err(std::io::Error::from_raw_os_error(libc::EBADF)) },
		Value::Ref(Ref::Io(h)) => io::stat_metadata(interp.host(), FileTestTarget::Handle(&h), follow),
		v => {
			let mut path = interp.stringify(&v)?;
			let bytes = path.downgraded().unwrap_or_else(|| std::mem::take(&mut path.bytes));
			let full = interp.resolve_path(&bytes);
			if follow { interp.host().fs().metadata(&full) } else { interp.host().fs().symlink_metadata(&full) }
		}
	};
	match meta {
		Ok(meta) if cx == Cx::List => {
			let mut vals = io::stat(interp.host(), FileTestTarget::Cached(&meta), follow).map_err(|e| { interp.set_errno(&e); interp.die_msg(e.to_string()) })?;
			for (idx, ns) in [(8, meta.atime_nsec()), (9, meta.mtime_nsec()), (10, meta.ctime_nsec())] {
				if let Some(ns) = ns.filter(|&ns| ns != 0) { vals[idx] = Value::Num(vals[idx].to_f64() + ns as f64 * 1e-9); }
			}
			Ok(Ret::Many(Vec::from(vals)))
		}
		Ok(_) => Ok(boolean(true)),
		Err(e) => { interp.set_errno(&e); if cx == Cx::List { Ok(Ret::Many(Vec::new())) } else { Ok(boolean(false)) } }
	}
}
fn stat(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { high_stat(interp, &a, cx, true) }
fn lstat(interp: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> { high_stat(interp, &a, cx, false) }
fn utime(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if a.len() < 2 { return Err(usage(interp, "utime", "atime, mtime, ...")); }
	let at = arg(&a, 0);
	let mt = arg(&a, 1);
	let to_time = |n: &Value| {
		let seconds = n.to_f64();
		let duration = Duration::try_from_secs_f64(seconds.abs()).ok()?;
		let time = if seconds.is_sign_negative() { UNIX_EPOCH.checked_sub(duration) } else { UNIX_EPOCH.checked_add(duration) };
		time.map(FileTime::At)
	};
	let (at, mt) = if at.is_undef() && mt.is_undef() { (FileTime::Now, FileTime::Now) }
	else if let (Some(at), Some(mt)) = (to_time(&at), to_time(&mt)) { (at, mt) }
	else { interp.set_errno_code(libc::EINVAL); return one(Value::Int(0)); };
	let mut n = 0;
	for s in a.iter().skip(2) {
		let value = interp.read_sv(s)?;
		let p: PStr = interp.stringify(&value)?;
		let full = interp.resolve_path(&p.bytes);
		match interp.host().fs().set_times(full, at, mt, true) {
			Ok(()) => n += 1,
			Err(e) => interp.set_errno(&e),
		}
	}
	one(Value::Int(n))
}
