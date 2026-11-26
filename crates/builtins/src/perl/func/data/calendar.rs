//! Wall-clock/calendar conversion, process CPU times and interruptible sleep (perlfunc).

use std::time::{Duration, Instant, SystemTime};

use jiff::{Timestamp, tz::TimeZone};

use crate::{perl::{
	ast::{Builtin, Call},
	interp::{Cx, Flow, Interp, PResult, Ret},
	value::{HKey, PStr, Value},
}, time_zone::shell_time_zone};

use super::{int_arg, numify, scalar_args, warn_undef};

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
	let arg = scalar_args(interp, b, call, 0, usize::from(!matches!(b, Builtin::Time | Builtin::Times)))?.first();
	match b {
		Builtin::Time => Ok(Ret::One(Value::Int(now_seconds()))),
		Builtin::Times => times(interp, cx),
		Builtin::Sleep => {
			let target = if let Some(e) = arg {
				let duration = int_arg(interp, e, "sleep")?;
				if duration < 0 {
					interp.warn_category("misc", "sleep() with negative argument");
					interp.set_errno_code(libc::EINVAL);
					return Ok(Ret::One(Value::Int(0)));
				}
				Some(Duration::from_secs(duration as u64))
			} else {
				None
			};
			sleep(interp, target).map(|s| Ret::One(Value::Int(s as i64)))
		}
		Builtin::Gmtime | Builtin::Localtime => {
			let local = b == Builtin::Localtime;
			let op = b.name();
			let time = if let Some(e) = arg {
				let value = interp.eval_scalar(e)?;
				if value.is_undef() {
					warn_undef(interp, arg.filter(|_| local), op, false);
					0.0
				} else {
					numify(interp, &value, arg, op, false)?.to_f64().floor()
				}
			} else {
				now_seconds() as f64
			};
			const LOWEST: f64 = -67_768_100_567_755_200.0;
			const HIGHEST: f64 = 67_767_976_233_316_800.0;
			if !(LOWEST..=HIGHEST).contains(&time) {
				return Ok(invalid(interp, op, time, cx));
			}
			let time = time as i64;
			let (offset, dst) = if local { local_offset(interp, time) } else { (0, false) };
			let adjusted = time + i64::from(offset);
			let (y, m, d, ordinal, weekday) = civil_date(adjusted.div_euclid(86_400));
			let secs = adjusted.rem_euclid(86_400);
			let (hour, min, sec) = (secs / 3600, (secs / 60) % 60, secs % 60);
			Ok(match cx {
				Cx::List => Ret::Many([
					sec, min, hour, d, m as i64, y - 1900, weekday as i64, ordinal, i64::from(dst),
				].into_iter().map(Value::Int).collect()),
				Cx::Void => Ret::One(Value::Undef),
				Cx::Scalar => {
					const WDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
					const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
					let wday = WDAYS[weekday];
					let month = MONTHS[m];
					let text = format!("{wday} {month} {d:2} {hour:02}:{min:02}:{sec:02} {y}");
					Ret::One(Value::Str(PStr::new(text.into_bytes(), false)))
				}
			})
		}
		_ => unreachable!("not a calendar intrinsic"),
	}
}

fn now_seconds() -> i64 {
	match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
		Ok(delta) => delta.as_secs() as i64,
		Err(err) => -(err.duration().as_secs() as i64) - i64::from(err.duration().subsec_nanos() != 0),
	}
}

fn invalid(interp: &mut Interp<'_>, op: &str, time: f64, cx: Cx) -> Ret {
	if interp.warn_on("overflow") {
		let shown = if time.is_nan() { "NaN".to_owned() }
			else if time == f64::INFINITY { "Inf".to_owned() }
			else if time == f64::NEG_INFINITY { "-Inf".to_owned() }
			else { format!("{time:.0}") };
		let which = if time < 0.0 { "small" } else { "large" };
		interp.warn_category("overflow", format!("{op}({shown}) too {which}"));
		interp.warn_category("overflow", format!("{op}({shown}) failed"));
	}
	if cx == Cx::List { Ret::empty() } else { Ret::One(Value::Undef) }
}

fn local_offset(interp: &mut Interp<'_>, seconds: i64) -> (i32, bool) {
	let env = interp.hv("main::ENV");
	let key = HKey::new(&PStr::from_bytes(b"TZ"));
	let tz = env.entries().get(&key).map(|s| s.get().to_pstr());
	let tz = match &tz {
		None => TimeZone::system(),
		Some(tz) if interp.host().var("TZ").is_some_and(|v| v.as_bytes() == tz.bytes) => shell_time_zone(interp.host()),
		Some(tz) => {
			let text = tz.to_string_lossy();
			let name = text.strip_prefix(':').unwrap_or(&text);
			if name.is_empty() { TimeZone::UTC }
			else { TimeZone::get(name).or_else(|_| TimeZone::posix(name)).unwrap_or(TimeZone::UTC) }
		}
	};
	let t = Timestamp::from_second(seconds).unwrap_or_else(|_| {
		if seconds < 0 {
			Timestamp::MIN
		} else {
			// Project very large years onto an equivalent point in the Gregorian
			// cycle, after the database's explicit transitions, for POSIX DST rules.
			const CYCLE: i64 = 146_097 * 86_400;
			let near = 2 * CYCLE + seconds.rem_euclid(CYCLE);
			Timestamp::from_second(near).unwrap_or(Timestamp::MAX)
		}
	});
	let info = tz.to_offset_info(t);
	(info.offset().seconds(), info.dst().is_dst())
}

// Split a Gregorian day count into 400-year cycles with the leap day last
// (March first), then map back to January and compute the C tm fields.
fn civil_date(days: i64) -> (i64, usize, i64, i64, usize) {
	const CYCLE: i64 = 146_097;
	let march_days = days + 719_468;
	let era = march_days.div_euclid(CYCLE);
	let day = march_days.rem_euclid(CYCLE);
	let years = (day - day / 1460 + day / 36_524 - day / 146_096) / 365;
	let year_day = day - (365 * years + years / 4 - years / 100);
	let month = (5 * year_day + 2) / 153;
	let day_of_month = year_day - (153 * month + 2) / 5 + 1;
	let year = era * 400 + years + i64::from(month >= 10);
	let month = ((month + 2) % 12) as usize;
	let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
	const MONTH_STARTS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
	let ordinal = MONTH_STARTS[month] + day_of_month - 1 + i64::from(leap && month >= 2);
	(year, month, day_of_month, ordinal, (days + 4).rem_euclid(7) as usize)
}

#[cfg(unix)]
fn times(interp: &mut Interp<'_>, cx: Cx) -> PResult<Ret> {
	fn cpu(children: bool) -> nix::Result<(f64, f64)> {
		use nix::sys::resource::{UsageWho, getrusage};
		let who = if children { UsageWho::RUSAGE_CHILDREN } else { UsageWho::RUSAGE_SELF };
		let usage = getrusage(who)?;
		let user = usage.user_time();
		let sys = usage.system_time();
		// Darwin and Linux expose times(2) through 100 Hz clock ticks.
		let secs = |sec, usec| sec as f64 + (usec / 10_000) as f64 / 100.0;
		Ok((secs(user.tv_sec(), user.tv_usec()), secs(sys.tv_sec(), sys.tv_usec())))
	}
	let (user, sys) = cpu(false).map_err(|e| interp.die_msg(format!("Can't get process times: {e}")))?;
	if cx != Cx::List { return Ok(Ret::One(Value::Num(user))); }
	let (cuser, csys) = cpu(true).map_err(|e| interp.die_msg(format!("Can't get child process times: {e}")))?;
	Ok(Ret::Many([user, sys, cuser, csys].into_iter().map(Value::Num).collect()))
}

#[cfg(not(unix))]
fn times(interp: &mut Interp<'_>, _cx: Cx) -> PResult<Ret> {
	Err(interp.die_msg("The times function is unimplemented"))
}

fn sleep(interp: &mut Interp<'_>, duration: Option<Duration>) -> PResult<u64> {
	let start = Instant::now();
	const STEP: Duration = Duration::from_millis(25);
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		if interp.poll_alarm()? { return Ok(start.elapsed().as_secs()); }
		let elapsed = start.elapsed();
		if let Some(duration) = duration {
			if elapsed >= duration {
				#[cfg(target_os = "macos")]
				interp.set_errno_code(libc::ETIMEDOUT);
				return Ok(elapsed.as_secs());
			}
			std::thread::sleep((duration - elapsed).min(STEP));
		} else {
			std::thread::sleep(STEP);
		}
	}
}
