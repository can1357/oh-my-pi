//! Calendar helpers for POSIX, Time::Local and Time::Piece.

use std::{fmt::Write, sync::LazyLock, time::{SystemTime, UNIX_EPOCH}};

use chrono::{Datelike, NaiveDate};
use jiff::{Timestamp, Zoned, tz::TimeZone};

use crate::perl::{interp::Interp, value::{HKey, PStr, Value}};

/// English C-locale month names in calendar order.
pub(super) const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/// English C-locale weekday names beginning with Sunday.
pub(super) const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/// Seconds in a nominal calendar day.
pub(super) const DAY: i64 = 86_400;
/// `%ENV` key used by Perl's local calendar routines.
pub(super) static TZ: LazyLock<HKey> = LazyLock::new(|| HKey::new(&PStr::from_bytes(b"TZ")));

/// Read the configured zone from the interpreter, never from a process-wide mutation.
pub(super) fn timezone(interp: &mut Interp<'_>) -> TimeZone {
	let env = interp.hv("main::ENV");
	let map = env.entries();
	let Some(cell) = map.get(&*TZ) else { return TimeZone::system(); };
	let tz = cell.get().to_pstr();
	let name = tz.to_string_lossy();
	let name = name.strip_prefix(':').unwrap_or(&name);
	if name.is_empty() { return TimeZone::UTC; }
	TimeZone::get(name).or_else(|_| TimeZone::posix(name)).unwrap_or(TimeZone::UTC)
}

/// Current wall-clock time as fractional epoch seconds.
pub(super) fn epoch_f64() -> f64 {
	match SystemTime::now().duration_since(UNIX_EPOCH) {
		Ok(d) => d.as_secs_f64(), Err(e) => -e.duration().as_secs_f64(),
	}
}

/// Current wall-clock time rounded down to the second.
pub(super) fn now_epoch() -> i64 { epoch_f64().floor() as i64 }

/// Whether an absolute year has a Gregorian leap day.
pub(super) fn leap(year: i64) -> bool { year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) }

/// Number of days in a one-based month.
pub(super) fn month_days(year: i64, month: i64) -> i64 {
	match month { 2 => 28 + i64::from(leap(year)), 4 | 6 | 9 | 11 => 30, _ => 31 }
}

/// POSIX months are zero-based, and the year here is absolute. All fields normalize.
pub(super) fn naive_epoch([sec, min, hour, day, month, year]: [i64; 6]) -> Option<i64> {
	let year = i128::from(year) + i128::from(month.div_euclid(12));
	let month = i128::from(month.rem_euclid(12)) + 1;
	// Count completed Gregorian years from March, where leap days end the year.
	let y = year - i128::from(month < 3);
	let m = (month + 9) % 12;
	let years = 365 * y + y.div_euclid(4) - y.div_euclid(100) + y.div_euclid(400);
	let days = years + (153 * m + 2) / 5 + i128::from(day) - 1 - 719_468;
	let secs = days * i128::from(DAY) + i128::from(hour) * 3600 + i128::from(min) * 60 + i128::from(sec);
	i64::try_from(secs).ok()
}

/// Interpret a civil epoch as local time, applying Perl's explicit `tm_isdst` hint.
pub(super) fn local_epoch_for_naive(zone: &TimeZone, naive: i64, dst: i64) -> Option<i64> {
	// Zones repeat their future Gregorian transition rules every 400 years.
	// Moving far dates into Jiff's range also preserves pre-transition offsets.
	const CYCLE: i64 = 146_097 * DAY;
	let bounded = if Timestamp::from_second(naive).is_ok() { naive }
	else if naive > 0 { let max = Timestamp::MAX.as_second(); max - (i128::from(max) - i128::from(naive)).rem_euclid(i128::from(CYCLE)) as i64 }
	else { let min = Timestamp::MIN.as_second(); min + (i128::from(naive) - i128::from(min)).rem_euclid(i128::from(CYCLE)) as i64 };
	let timestamp = Timestamp::from_second(bounded).ok()?;
	let with_offset = |result: i64| naive.checked_add(result - bounded);
	let civil = timestamp.to_zoned(TimeZone::UTC).datetime();
	let compatible = zone.to_timestamp(civil).ok()?;
	if dst < 0 { return with_offset(compatible.as_second()); }
	let target = dst != 0;
	let off = zone.to_offset_info(compatible);
	if off.dst().is_dst() == target { return with_offset(compatible.as_second()); }
	let dt = compatible.as_second();
	// An explicit tm_isdst chooses its corresponding offset, even on the opposite
	// side of a spring gap or on a day outside that half of the DST season.
	for delta in [-3600, 3600, -90 * DAY, 90 * DAY, -180 * DAY, 180 * DAY] {
		let Ok(other) = Timestamp::from_second(dt.checked_add(delta)?) else { continue; };
		let info = zone.to_offset_info(other);
		if info.dst().is_dst() == target {
			return naive.checked_sub(i64::from(info.offset().seconds()));
		}
	}
	with_offset(dt)
}

/// Render epoch seconds in a timezone when the calendar date fits Jiff.
pub(super) fn zoned(epoch: i64, tz: TimeZone) -> Option<Zoned> {
	Timestamp::from_second(epoch).ok().map(|ts| ts.to_zoned(tz))
}

/// Broken-down C calendar fields, with the full year retained internally.
#[derive(Clone)]
pub(super) struct Fields {
	pub(super) sec: i64,
	pub(super) min: i64,
	pub(super) hour: i64,
	pub(super) day: i64,
	pub(super) month: i64,
	pub(super) year: i64,
	pub(super) weekday: i64,
	pub(super) yearday: i64,
	pub(super) dst: i64,
}

impl Fields {
	/// Capture the calendar fields in the zoned timestamp's local time.
	pub(super) fn from_zoned(z: &Zoned) -> Self {
		Self {
			sec: z.second().into(), min: z.minute().into(), hour: z.hour().into(), day: z.day().into(),
			month: i64::from(z.month()) - 1, year: z.year().into(), weekday: z.weekday().to_sunday_zero_offset().into(),
			yearday: i64::from(z.date().day_of_year()) - 1,
			dst: i64::from(z.time_zone().to_offset_info(z.timestamp()).dst().is_dst()),
		}
	}

	/// Perl's nine ordered time values.
	pub(super) fn values(&self) -> Vec<Value> {
		[self.sec, self.min, self.hour, self.day, self.month, self.year - 1900, self.weekday, self.yearday, self.dst]
			.into_iter().map(Value::Int).collect()
	}

	/// Scalar Perl calendar rendering, without a trailing newline.
	pub(super) fn ctime(&self) -> String {
		let (wd, month) = (name(&DAYS, self.weekday), name(&MONTHS, self.month));
		format!("{} {} {:2} {:02}:{:02}:{:02} {}", short(wd), short(month), self.day, self.hour, self.min, self.sec, self.year)
	}

	/// Normalize the calendar fields as if they were in UTC.
	pub(super) fn epoch_naive(&self) -> Option<i64> {
		naive_epoch([self.sec, self.min, self.hour, self.day, self.month, self.year])
	}

	/// ISO week-based year and one-based week number.
	pub(super) fn week(&self) -> (i64, u32) {
		let Some(date) = i32::try_from(self.year).ok().and_then(|y| NaiveDate::from_ymd_opt(y, (self.month + 1) as u32, self.day as u32)) else { return (self.year, 1); };
		let week = date.iso_week();
		(i64::from(week.year()), week.week())
	}
}

/// Look up a named field, falling back to a question mark for an invalid index.
pub(super) fn name(names: &'static [&str], idx: i64) -> &'static str { names.get(idx as usize).copied().unwrap_or("?") }
/// Short C-locale spelling of a weekday or month name.
pub(super) fn short(name: &str) -> &str { name.get(..3).unwrap_or(name) }

/// C-locale C/POSIX `strftime`. Process locale and process TZ are never changed.
pub(super) fn strftime(fmt: &PStr, t: &Fields, epoch: i64, abbr: &str, offset: Option<i32>) -> PStr {
	let mut out = Vec::with_capacity(fmt.bytes.len());
	format_bytes(&fmt.bytes, t, epoch, abbr, offset, &mut out);
	PStr::new(out, fmt.utf8)
}

fn format_bytes(fmt: &[u8], t: &Fields, epoch: i64, abbr: &str, offset: Option<i32>, out: &mut Vec<u8>) {
	let mut i = 0;
	let mut num = String::new();
	while let Some(&byte) = fmt.get(i) {
		i += 1;
		if byte == 0 { break; }
		if byte != b'%' { out.push(byte); continue; }
		let mut flag = 0;
		let mut case = 0;
		while let Some(&b) = fmt.get(i) {
			match b {
				b'-' | b'_' | b'0' => flag = b,
				b'^' | b'#' => case = b,
				_ => break,
			}
			i += 1;
		}
		let mut width = None;
		while let Some(b) = fmt.get(i).copied().filter(u8::is_ascii_digit) {
			width = Some(usize::min(1024, width.unwrap_or(0) * 10 + usize::from(b - b'0')));
			i += 1;
		}
		if matches!(fmt.get(i), Some(b'E' | b'O')) { i += 1; }
		let Some(&c) = fmt.get(i) else { out.push(b'%'); break; };
		i += 1;
		if c == 0 { out.push(b'%'); break; }
		let start = out.len();
		let wd = name(&DAYS, t.weekday);
		let month = name(&MONTHS, t.month);
		let hour = (t.hour + 11).rem_euclid(12) + 1;
		let mut nested: Option<&[u8]> = None;
		let mut number = None;
		let mut string = "";
		match c {
			b'%' => string = "%", b'n' => string = "\n", b't' => string = "\t",
			b'A' => string = wd, b'a' => string = short(wd), b'B' => string = month, b'b' | b'h' => string = short(month),
			b'c' => nested = Some(b"%a %e %b %Y %T"), b'+' => nested = Some(b"%a %b %e %T %Z %Y"),
			b'v' => nested = Some(b"%e-%^b-%Y"), b'x' => nested = Some(b"%m/%d/%y"), b'X' => nested = Some(b"%T"),
			b'F' => nested = Some(b"%Y-%m-%d"), b'D' => nested = Some(b"%m/%d/%y"),
			b'R' => nested = Some(b"%H:%M"), b'T' => nested = Some(b"%H:%M:%S"), b'r' => nested = Some(b"%I:%M:%S %p"),
			b'P' => string = "P", b'p' => string = if t.hour < 12 { "AM" } else { "PM" },
			b'Z' => string = abbr,
			b'z' => if let Some(off) = offset {
				let abs = off.unsigned_abs();
				num.clear();
				let _ = write!(num, "{}{:02}{:02}", if off < 0 { '-' } else { '+' }, abs / 3600, abs / 60 % 60);
				string = &num;
			},
			b'C' => number = Some((t.year.div_euclid(100), 2, b'0')),
			b'y' => number = Some((t.year.rem_euclid(100), 2, b'0')), b'Y' => number = Some((t.year, 4, b'0')),
			b'd' => number = Some((t.day, 2, b'0')), b'e' => number = Some((t.day, 2, b' ')),
			b'm' => number = Some((t.month + 1, 2, b'0')), b'j' => number = Some((t.yearday + 1, 3, b'0')),
			b'H' => number = Some((t.hour, 2, b'0')), b'k' => number = Some((t.hour, 2, b' ')),
			b'I' => number = Some((hour, 2, b'0')), b'l' => number = Some((hour, 2, b' ')),
			b'M' => number = Some((t.min, 2, b'0')), b'S' => number = Some((t.sec, 2, b'0')),
			b'w' => number = Some((t.weekday, 1, b'0')), b'u' => number = Some(((t.weekday + 6).rem_euclid(7) + 1, 1, b'0')),
			b'U' => number = Some(((t.yearday + 7 - t.weekday) / 7, 2, b'0')),
			b'W' => number = Some(((t.yearday + 7 - (t.weekday + 6).rem_euclid(7)) / 7, 2, b'0')),
			b'V' => number = Some((i64::from(t.week().1), 2, b'0')),
			b'G' => number = Some((t.week().0, 4, b'0')), b'g' => number = Some((t.week().0.rem_euclid(100), 2, b'0')),
			b's' => number = Some((epoch, 0, b'0')),
			_ => out.push(c),
		}
		if let Some(nested) = nested { format_bytes(nested, t, epoch, abbr, offset, out); }
		else if let Some((value, n, pad)) = number {
			num.clear();
			let _ = write!(num, "{}", value.unsigned_abs());
			let pad = match flag { b'_' => b' ', b'0' => b'0', _ => pad };
			let neg = value < 0;
			if neg && pad == b'0' { out.push(b'-'); }
			if flag != b'-' { out.extend(std::iter::repeat_n(pad, width.unwrap_or(n).saturating_sub(num.len() + usize::from(neg)))); }
			if neg && pad != b'0' { out.push(b'-'); }
			out.extend_from_slice(num.as_bytes());
		} else { out.extend_from_slice(string.as_bytes()); }
		if case == b'^' { out[start..].make_ascii_uppercase(); }
		else if case == b'#' { for b in &mut out[start..] { if b.is_ascii_lowercase() { b.make_ascii_uppercase(); } else { b.make_ascii_lowercase(); } } }
	}
}
