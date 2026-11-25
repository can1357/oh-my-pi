//! POSIX and the Time::* libraries, with per-interpreter calendar and timer state.

mod benchmark;
mod calendar;
mod hires;
mod locale;
mod piece;
mod posix;
mod posix_exports;

use super::{define, export, version};
use crate::perl::{interp::{Cx, Interp, PResult, Ret}, value::{Sv, Value}};

/// Install the requested timing and calendar library.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"POSIX" => posix::load(interp)?,
		"Time::HiRes" => hires::load(interp),
		"Time::Local" => load_local(interp),
		"Time::Piece" => piece::load_piece(interp)?,
		"Time::Seconds" => piece::load_seconds(interp),
		"Benchmark" => benchmark::load(interp),
		_ => unreachable!(),
	}
	Ok(())
}

fn load_local(interp: &mut Interp<'_>) {
	version(interp, "Time::Local", "1.30");
	define(interp, "Time::Local", &[("timegm", timegm), ("timelocal", timelocal),
		("timegm_modern", timegm_modern), ("timelocal_modern", timelocal_modern),
		("timegm_nocheck", timegm_nocheck), ("timelocal_nocheck", timelocal_nocheck),
		("timegm_posix", timegm_posix), ("timelocal_posix", timelocal_posix)]);
	export(interp, "Time::Local", &["timegm", "timelocal"], &["timegm_modern", "timelocal_modern",
		"timegm_nocheck", "timelocal_nocheck", "timegm_posix", "timelocal_posix"]);
}

#[derive(Clone, Copy)]
enum Year { Legacy, Modern, Posix }

fn local_epoch(interp: &mut Interp<'_>, a: &[Sv], local: bool, mode: Year, checked: bool) -> PResult<Ret> {
	let mut values = std::array::from_fn::<_, 6, _>(|_| Value::Undef);
	for (value, sv) in values.iter_mut().zip(a) { *value = interp.read_sv(sv)?; }
	let mut fields = std::array::from_fn::<_, 6, _>(|idx| values[idx].to_i64());
	fields[5] = match mode {
		Year::Modern => fields[5],
		Year::Posix => fields[5].saturating_add(1900),
		Year::Legacy => match fields[5] {
			1000.. => fields[5],
			0..=99 => {
				let now = jiff::Timestamp::from_second(calendar::now_epoch()).map_err(|_| interp.die_msg("Day too big"))?;
				let year = i64::from(now.to_zoned(calendar::timezone(interp)).year());
				let start = year - 49;
				start + (fields[5] - start).rem_euclid(100)
			}
			_ => fields[5].saturating_add(1900),
		},
	};
	if checked {
		for (idx, name, max) in [(4, "Month", 11), (3, "Day", calendar::month_days(fields[5], fields[4].saturating_add(1))),
			(2, "Hour", 23), (1, "Minute", 59), (0, "Second", 59)] {
			let low = i64::from(idx == 3);
			if !(low..=max).contains(&fields[idx]) {
				let value = values[idx].to_pstr();
				return Err(interp.die_msg(format!("{name} '{}' out of range {low}..{max}", value.to_string_lossy())));
			}
		}
	} else {
		fields[4] = fields[4].rem_euclid(12);
	}
	let [sec, min, hour] = std::array::from_fn(|i| values[i].to_f64().fract());
	let fraction = sec + min * 60.0 + hour * 3600.0;
	let naive = calendar::naive_epoch(fields).and_then(|n| n.checked_add(fraction.trunc() as i64)).ok_or_else(|| interp.die_msg("Day too big"))?;
	let epoch = if local {
		let tz = calendar::timezone(interp);
		calendar::local_epoch_for_naive(&tz, naive, -1).ok_or_else(|| interp.die_msg("Day too big"))?
	} else { naive };
	let subsec = fraction.fract() * if local { 2.0 } else { 1.0 };
	Ok(Ret::One(if subsec == 0.0 { Value::Int(epoch) } else { Value::Num(epoch as f64 + subsec) }))
}

macro_rules! local_fn {
	($name:ident, $local:expr, $year:ident, $check:expr) => {
		fn $name(interp: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { local_epoch(interp, &a, $local, Year::$year, $check) }
	};
}
local_fn!(timegm, false, Legacy, true);
local_fn!(timelocal, true, Legacy, true);
local_fn!(timegm_modern, false, Modern, true);
local_fn!(timelocal_modern, true, Modern, true);
local_fn!(timegm_nocheck, false, Legacy, false);
local_fn!(timelocal_nocheck, true, Legacy, false);
local_fn!(timegm_posix, false, Posix, true);
local_fn!(timelocal_posix, true, Posix, true);
