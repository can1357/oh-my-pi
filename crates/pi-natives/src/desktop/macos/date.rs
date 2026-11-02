//! ISO-8601 values for date and time controls, whose `AXValue` is a `CFDate`.
//!
//! Times are `CFAbsoluteTime`: seconds since 2001-01-01T00:00:00Z. Local time
//! is resolved through `offset_at`, the local zone's UTC offset in seconds at
//! an absolute time, so the arithmetic here stays independent of the host.

/// Named by every refusal so a caller can correct its value in one step.
pub(super) const ACCEPTED_FORMS: &str = "YYYY-MM-DD (keeps the control's time of day), \
                                         YYYY-MM-DDTHH:MM[:SS] (local time), or a date-time \
                                         followed by Z or ±HH:MM (that exact instant)";

const SECONDS_PER_DAY: i64 = 86_400;
/// Days from 1970-01-01 to 2001-01-01, the `CFAbsoluteTime` epoch.
const CF_EPOCH_DAYS: i64 = 11_323;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct CivilDate {
	year:  i64,
	month: i64,
	day:   i64,
}

/// A value accepted for a date control.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum DateRequest {
	/// A calendar day; the control keeps its local time of day.
	Day(CivilDate),
	/// A local wall-clock date-time, as seconds since local midnight.
	Local { date: CivilDate, seconds: f64 },
	/// An exact instant.
	Instant(f64),
}

/// Parses `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS[.fraction]]` and either
/// date-time followed by `Z` or `±HH:MM`. `T` may be a space, and the offset
/// may be `±HHMM` after a space: the form the accessibility tree prints for a
/// date (`2026-09-28 04:00:00 +0000`) is written back unchanged. `None` for
/// anything else, including a day or time that does not exist.
pub(super) fn parse(text: &str) -> Option<DateRequest> {
	let text = text.trim();
	let date = parse_date(text.get(..10)?)?;
	let rest = &text[10..];
	if rest.is_empty() {
		return Some(DateRequest::Day(date));
	}
	let rest = rest.strip_prefix(['T', ' '])?;
	let (clock, offset) = match rest.find(['Z', '+', '-']) {
		Some(split) => {
			let clock = &rest[..split];
			(clock.strip_suffix(' ').unwrap_or(clock), Some(parse_offset(&rest[split..])?))
		},
		None => (rest, None),
	};
	let seconds = parse_clock(clock)?;
	Some(match offset {
		None => DateRequest::Local { date, seconds },
		Some(offset) => DateRequest::Instant(civil_seconds(date, seconds) - offset as f64),
	})
}

impl DateRequest {
	/// The `CFAbsoluteTime` to write, given the control's current value.
	///
	/// A local time the zone skips (the hour clocks jump over when
	/// daylight saving starts) or repeats (the hour they go back through when
	/// it ends) is refused rather than moved or guessed: the error names it, and
	/// a date-time with an offset writes either instant exactly.
	pub(super) fn absolute_time(
		self,
		current: f64,
		offset_at: impl Fn(f64) -> i64,
	) -> Result<f64, String> {
		match self {
			Self::Day(date) => {
				let local = current + offset_at(current) as f64;
				let time_of_day = local.rem_euclid(SECONDS_PER_DAY as f64);
				local_to_absolute(civil_seconds(date, time_of_day), offset_at)
			},
			Self::Local { date, seconds } => {
				local_to_absolute(civil_seconds(date, seconds), offset_at)
			},
			Self::Instant(at) => Ok(at),
		}
	}
}

/// Renders `at` as local ISO-8601 with its UTC offset, e.g.
/// `2026-10-05T09:30:00+02:00`, a form [`parse`] accepts back.
pub(super) fn format_local(at: f64, offset_at: impl Fn(f64) -> i64) -> String {
	let offset = offset_at(at);
	format!("{}{}", format_civil(at + offset as f64), format_offset(offset))
}

/// Local wall-clock seconds (on the `CFAbsoluteTime` scale) to the one
/// absolute time that shows that clock in the local zone.
fn local_to_absolute(local: f64, offset_at: impl Fn(f64) -> i64) -> Result<f64, String> {
	// A zone changes its offset at most once within a day of any local time,
	// so the offsets a day either side are the only ones that can apply.
	let earlier = offset_at(local - SECONDS_PER_DAY as f64);
	let later = offset_at(local + SECONDS_PER_DAY as f64);
	let shows = |offset: i64| offset_at(local - offset as f64) == offset;
	match (shows(earlier), earlier != later && shows(later)) {
		(true, false) => Ok(local - earlier as f64),
		(false, true) => Ok(local - later as f64),
		(true, true) => Err(format!(
			"{} occurs twice in the local time zone as clocks go back; add {} for the first or {} \
			 for the second",
			format_civil(local),
			format_offset(earlier),
			format_offset(later),
		)),
		(false, false) => Err(format!(
			"{} does not exist in the local time zone: clocks skip it for daylight saving",
			format_civil(local),
		)),
	}
}

/// Local wall-clock seconds as `YYYY-MM-DDTHH:MM:SS`.
fn format_civil(local: f64) -> String {
	let local = local.floor() as i64;
	let date = civil_from_days(local.div_euclid(SECONDS_PER_DAY) + CF_EPOCH_DAYS);
	let clock = local.rem_euclid(SECONDS_PER_DAY);
	format!(
		"{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
		date.year,
		date.month,
		date.day,
		clock / 3600,
		clock / 60 % 60,
		clock % 60,
	)
}

/// Seconds east of UTC as `±HH:MM`.
fn format_offset(offset: i64) -> String {
	let sign = if offset < 0 { '-' } else { '+' };
	let minutes = offset.abs() / 60;
	format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

fn civil_seconds(date: CivilDate, seconds: f64) -> f64 {
	((days_from_civil(date) - CF_EPOCH_DAYS) * SECONDS_PER_DAY) as f64 + seconds
}

fn parse_date(text: &str) -> Option<CivilDate> {
	let bytes = text.as_bytes();
	if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
		return None;
	}
	let date = CivilDate {
		year:  digits(&text[..4])?,
		month: digits(&text[5..7])?,
		day:   digits(&text[8..])?,
	};
	(1..=12)
		.contains(&date.month)
		.then_some(date)
		.filter(|date| (1..=days_in_month(date.year, date.month)).contains(&date.day))
}

/// `HH:MM`, `HH:MM:SS` or `HH:MM:SS.fraction`, as seconds since midnight.
fn parse_clock(text: &str) -> Option<f64> {
	let (whole, fraction) = match text.split_once('.') {
		Some((whole, fraction)) => (whole, Some(fraction)),
		None => (text, None),
	};
	let mut parts = whole.split(':');
	let hour = two_digits(parts.next()?)?;
	let minute = two_digits(parts.next()?)?;
	let second = parts.next().map_or(Some(0), two_digits)?;
	if parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
		return None;
	}
	let fraction = match fraction {
		None => 0.0,
		// Only after whole seconds, and never empty.
		Some(fraction)
			if whole.len() == 8
				&& !fraction.is_empty()
				&& fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
		{
			format!("0.{fraction}").parse().ok()?
		},
		Some(_) => return None,
	};
	Some((hour * 3600 + minute * 60 + second) as f64 + fraction)
}

/// `Z`, `±HH:MM` or `±HHMM`, as seconds east of UTC.
fn parse_offset(text: &str) -> Option<i64> {
	if text == "Z" {
		return Some(0);
	}
	let (sign, rest) = match text.split_at_checked(1)? {
		("+", rest) => (1, rest),
		("-", rest) => (-1, rest),
		_ => return None,
	};
	let (hours, minutes) = match rest.split_once(':') {
		Some(parts) => parts,
		None => rest.split_at_checked(2)?,
	};
	let (hours, minutes) = (two_digits(hours)?, two_digits(minutes)?);
	(hours <= 23 && minutes <= 59).then_some(sign * (hours * 3600 + minutes * 60))
}

/// A run of ASCII digits (at least one).
fn digits(text: &str) -> Option<i64> {
	if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	text.parse().ok()
}

fn two_digits(text: &str) -> Option<i64> {
	if text.len() == 2 { digits(text) } else { None }
}

const fn days_in_month(year: i64, month: i64) -> i64 {
	match month {
		2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
		2 => 28,
		4 | 6 | 9 | 11 => 30,
		_ => 31,
	}
}

/// Days since 1970-01-01 in the proleptic Gregorian calendar.
const fn days_from_civil(date: CivilDate) -> i64 {
	let year = if date.month <= 2 {
		date.year - 1
	} else {
		date.year
	};
	let era = year.div_euclid(400);
	let year_of_era = year - era * 400;
	let month_index = (date.month + 9) % 12;
	let day_of_year = (153 * month_index + 2) / 5 + date.day - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`].
const fn civil_from_days(days: i64) -> CivilDate {
	let days = days + 719_468;
	let era = days.div_euclid(146_097);
	let day_of_era = days - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_index = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_index + 2) / 5 + 1;
	let month = if month_index < 10 {
		month_index + 3
	} else {
		month_index - 9
	};
	let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
	CivilDate { year, month, day }
}

#[cfg(test)]
mod tests {
	use super::{DateRequest, format_local, parse};

	/// 2026-09-25T17:00:00+02:00.
	const SEPT_25_17H_CEST: f64 = 812_041_200.0;
	/// 2026-03-29T01:00:00Z, when Central European summer time starts.
	const CEST_FROM: f64 = 796_438_800.0;
	/// 2026-10-25T01:00:00Z, when Central European summer time ends.
	const CET_FROM: f64 = 814_582_800.0;

	/// Central European time: +02:00 from `CEST_FROM` to `CET_FROM`, else
	/// +01:00.
	fn berlin(at: f64) -> i64 {
		if (CEST_FROM..CET_FROM).contains(&at) {
			7200
		} else {
			3600
		}
	}

	fn resolve(text: &str, current: f64) -> Result<f64, String> {
		let request = parse(text).unwrap_or_else(|| panic!("{text:?} was refused"));
		request.absolute_time(current, berlin)
	}

	fn write(text: &str, current: f64) -> String {
		let at = resolve(text, current).unwrap_or_else(|error| panic!("{text:?}: {error}"));
		format_local(at, berlin)
	}

	fn refusal(text: &str, current: f64) -> String {
		resolve(text, current)
			.map(|at| format_local(at, berlin))
			.expect_err(&format!("{text:?} was written"))
	}

	#[test]
	fn a_date_keeps_the_controls_local_time_of_day() {
		assert_eq!(write("2026-10-05", SEPT_25_17H_CEST), "2026-10-05T17:00:00+02:00");
		// Across the change to winter time the wall clock stays at 17:00.
		assert_eq!(write("2026-12-24", SEPT_25_17H_CEST), "2026-12-24T17:00:00+01:00");
		assert_eq!(write("2024-02-29", SEPT_25_17H_CEST), "2024-02-29T17:00:00+01:00");
	}

	#[test]
	fn a_local_time_skipped_by_daylight_saving_is_refused() {
		let skipped = refusal("2026-03-29T02:30", SEPT_25_17H_CEST);
		assert!(skipped.contains("2026-03-29T02:30:00 does not exist"), "{skipped}");
		// A day whose kept time of day (02:30) falls in the skipped hour.
		let kept = refusal("2026-03-29", SEPT_25_17H_CEST - 14.5 * 3600.0);
		assert!(kept.contains("2026-03-29T02:30:00 does not exist"), "{kept}");
		assert_eq!(write("2026-03-29T01:59:59", 0.0), "2026-03-29T01:59:59+01:00");
		assert_eq!(write("2026-03-29T03:00", 0.0), "2026-03-29T03:00:00+02:00");
	}

	#[test]
	fn a_local_time_repeated_as_clocks_go_back_is_refused_naming_both_offsets() {
		let repeated = refusal("2026-10-25T02:30", SEPT_25_17H_CEST);
		assert!(
			repeated.contains("2026-10-25T02:30:00 occurs twice")
				&& repeated.contains("add +02:00 for the first or +01:00 for the second"),
			"{repeated}"
		);
		assert_eq!(write("2026-10-25T02:30+02:00", 0.0), "2026-10-25T02:30:00+02:00");
		assert_eq!(write("2026-10-25T02:30+01:00", 0.0), "2026-10-25T02:30:00+01:00");
		assert_eq!(write("2026-10-25T01:59:59", 0.0), "2026-10-25T01:59:59+02:00");
		assert_eq!(write("2026-10-25T03:00", 0.0), "2026-10-25T03:00:00+01:00");
	}

	#[test]
	fn a_date_time_without_offset_is_local_wall_clock() {
		assert_eq!(write("2026-10-05T09:30", SEPT_25_17H_CEST), "2026-10-05T09:30:00+02:00");
		assert_eq!(write("2026-12-21T09:30:15", SEPT_25_17H_CEST), "2026-12-21T09:30:15+01:00");
		assert_eq!(write("2026-12-21 23:59:59.5", SEPT_25_17H_CEST), "2026-12-21T23:59:59+01:00");
	}

	#[test]
	fn a_date_time_with_offset_is_that_instant() {
		assert_eq!(write("2026-10-05T07:30Z", SEPT_25_17H_CEST), "2026-10-05T09:30:00+02:00");
		assert_eq!(write("2026-10-05T09:30:00-04:00", 0.0), "2026-10-05T15:30:00+02:00");
		assert_eq!(write("2026-10-05T07:30:00.000Z", 0.0), "2026-10-05T09:30:00+02:00");
		assert_eq!(parse("2001-01-01T00:00:00Z"), Some(DateRequest::Instant(0.0)));
	}

	#[test]
	fn the_form_the_tree_prints_is_accepted_back() {
		assert_eq!(write("2026-09-28 04:00:00 +0000", 0.0), "2026-09-28T06:00:00+02:00");
		assert_eq!(write("2026-09-28 04:00:00 -0400", 0.0), "2026-09-28T10:00:00+02:00");
		assert_eq!(write("2026-09-28T04:00+0530", 0.0), "2026-09-28T00:30:00+02:00");
	}

	#[test]
	fn the_date_a_refusal_quotes_is_accepted_back() {
		for at in [SEPT_25_17H_CEST, CET_FROM, CET_FROM - 1.0, -86_400.0 * 400.0] {
			let rendered = format_local(at, berlin);
			assert_eq!(write(&rendered, SEPT_25_17H_CEST), rendered);
		}
	}

	#[test]
	fn anything_else_is_refused() {
		for text in [
			"",
			"10/05/2026",
			"05.10.2026",
			"October 5, 2026",
			"2026-10-5",
			"2026-13-01",
			"2026-02-29",
			"2026-09-31",
			"2026-10-05T",
			"2026-10-05T9:30",
			"2026-10-05T24:00",
			"2026-10-05T09:60",
			"2026-10-05T09:30:60",
			"2026-10-05T09:30:00.",
			"2026-10-05T09:30.5",
			"2026-10-05T09:30+2",
			"2026-10-05T09:30+020",
			"2026-10-05T09:30:00  +0000",
			"2026-10-05T09:30:00+24:00",
			"2026-10-05x09:30",
			"20261005",
			"tomorrow",
		] {
			assert_eq!(parse(text), None, "{text:?} was accepted");
		}
	}
}
