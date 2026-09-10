//! Compact duration values and RFC 3339 conversion for [`SystemTime`].

use std::{
	cmp::Ordering,
	fmt::{self, Display},
	hash::{Hash, Hasher},
	str::FromStr,
	time::{Duration as StdDuration, SystemTime, UNIX_EPOCH},
};

use strum::{Display, EnumString};

/// Formats a [`SystemTime`] as a UTC RFC 3339 timestamp with second precision.
///
/// Times before [`UNIX_EPOCH`] are clamped to the epoch, preserving the
/// formatter's historical behavior.
pub fn format_rfc3339(time: SystemTime) -> String {
	let seconds = time
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_secs();
	let days = i64::try_from(seconds / 86_400).unwrap_or(i64::MAX);
	let day_seconds = seconds % 86_400;
	let (year, month, day) = civil_from_days(days);
	let hour = day_seconds / 3_600;
	let minute = day_seconds % 3_600 / 60;
	let second = day_seconds % 60;
	format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Parses an RFC 3339 timestamp into a [`SystemTime`].
///
/// The timestamp must use a four-digit year and include seconds. `T` and `Z`
/// are accepted case-insensitively, the fractional second may contain one to
/// nine digits, and the time zone may be `Z` or a numeric `±HH:MM` offset.
/// Returns [`None`] for invalid dates, times, offsets, or syntax.
pub fn parse_rfc3339(value: &str) -> Option<SystemTime> {
	if value.len() < 20
		|| value.as_bytes().get(4) != Some(&b'-')
		|| value.as_bytes().get(7) != Some(&b'-')
		|| !matches!(value.as_bytes().get(10), Some(b'T' | b't'))
		|| value.as_bytes().get(13) != Some(&b':')
		|| value.as_bytes().get(16) != Some(&b':')
	{
		return None;
	}
	let year = parse_digits(value, 0, 4)? as i32;
	let month = parse_digits(value, 5, 2)? as u32;
	let day = parse_digits(value, 8, 2)? as u32;
	let hour = parse_digits(value, 11, 2)? as u32;
	let minute = parse_digits(value, 14, 2)? as u32;
	let second = parse_digits(value, 17, 2)? as u32;
	if !(1..=12).contains(&month)
		|| day == 0
		|| day > days_in_month(year, month)
		|| hour > 23
		|| minute > 59
		|| second > 59
	{
		return None;
	}
	let mut cursor = 19;
	let mut nanos = 0_u32;
	if value.as_bytes().get(cursor) == Some(&b'.') {
		cursor += 1;
		let start = cursor;
		while value.as_bytes().get(cursor).is_some_and(u8::is_ascii_digit) {
			cursor += 1;
		}
		let digits = cursor.checked_sub(start)?;
		if digits == 0 || digits > 9 {
			return None;
		}
		nanos = parse_digits(value, start, digits)? as u32;
		for _ in digits..9 {
			nanos *= 10;
		}
	}
	let offset = match value.as_bytes().get(cursor) {
		Some(b'Z' | b'z') if cursor + 1 == value.len() => 0_i64,
		Some(sign @ (b'+' | b'-'))
			if cursor + 6 == value.len() && value.as_bytes().get(cursor + 3) == Some(&b':') =>
		{
			let hours = parse_digits(value, cursor + 1, 2)? as i64;
			let minutes = parse_digits(value, cursor + 4, 2)? as i64;
			if hours > 23 || minutes > 59 {
				return None;
			}
			let seconds = hours * 3_600 + minutes * 60;
			if *sign == b'+' { seconds } else { -seconds }
		},
		_ => return None,
	};
	let local = days_from_civil(year, month, day)
		.checked_mul(86_400)?
		.checked_add(i64::from(hour * 3_600 + minute * 60 + second))?;
	let unix = local.checked_sub(offset)?;
	if unix >= 0 {
		UNIX_EPOCH.checked_add(StdDuration::new(unix as u64, nanos))
	} else if nanos == 0 {
		UNIX_EPOCH.checked_sub(StdDuration::from_secs(unix.unsigned_abs()))
	} else {
		UNIX_EPOCH.checked_sub(StdDuration::new(unix.unsigned_abs() - 1, 1_000_000_000 - nanos))
	}
}

fn parse_digits(value: &str, start: usize, count: usize) -> Option<u64> {
	value
		.get(start..start.checked_add(count)?)?
		.bytes()
		.try_fold(0_u64, |number, byte| {
			if byte.is_ascii_digit() {
				Some(number * 10 + u64::from(byte - b'0'))
			} else {
				None
			}
		})
}

const fn days_in_month(year: i32, month: u32) -> u32 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
		2 => 28,
		_ => 0,
	}
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
	let year = i64::from(year) - i64::from(month <= 2);
	let era = if year >= 0 { year } else { year - 399 } / 400;
	let year_of_era = year - era * 400;
	let month = i64::from(month);
	let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
	let days = days + 719_468;
	let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
	let day_of_era = days - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let mut year = year_of_era + era * 400;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_prime = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
	let month = month_prime + if month_prime < 10 { 3 } else { -9 };
	year += i64::from(month <= 2);
	(year, month, day)
}

/// The explicit unit carried by a [`Duration`].
#[derive(Debug, Clone, Copy, Display, EnumString, PartialEq, Eq, Hash)]
pub enum DurationUnit {
	/// Nanoseconds.
	#[strum(serialize = "ns")]
	Nanoseconds,
	/// Microseconds.
	#[strum(serialize = "us")]
	Microseconds,
	/// Milliseconds.
	#[strum(serialize = "ms")]
	Milliseconds,
	/// Seconds.
	#[strum(serialize = "s")]
	Seconds,
	/// Minutes.
	#[strum(serialize = "m")]
	Minutes,
	/// Hours.
	#[strum(serialize = "h")]
	Hours,
}

impl DurationUnit {
	const fn nanoseconds(self) -> u64 {
		match self {
			Self::Nanoseconds => 1,
			Self::Microseconds => 1_000,
			Self::Milliseconds => 1_000_000,
			Self::Seconds => 1_000_000_000,
			Self::Minutes => 60_000_000_000,
			Self::Hours => 3_600_000_000_000,
		}
	}
}

/// An error converting or parsing a [`Duration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DurationError {
	/// The text is not an unsigned integer followed by a supported unit.
	#[error("duration must be an integer followed by ns, us, ms, s, m, or h")]
	InvalidSyntax,
	/// The value cannot be represented by the destination duration type.
	#[error("duration is too large")]
	Overflow,
	/// The requested unit cannot represent the standard duration exactly.
	#[error("duration is not an exact multiple of the requested unit")]
	PrecisionLoss,
}

/// A non-negative time span that retains the unit in which it was specified.
///
/// Unlike a floating-seconds API, this type makes units explicit. Equality,
/// ordering, and hashing compare elapsed time, so `1s` and `1000ms` are equal
/// even though [`Duration::unit`] preserves their different spellings.
#[derive(Debug, Clone, Copy)]
pub struct Duration {
	value: u64,
	unit:  DurationUnit,
}

impl Duration {
	/// Creates a duration from an integer and an explicit unit.
	pub const fn new(value: u64, unit: DurationUnit) -> Self {
		Self { value, unit }
	}

	/// Returns the integer magnitude in this value's original unit.
	pub const fn value(self) -> u64 {
		self.value
	}

	/// Returns the unit in which this value was specified.
	pub const fn unit(self) -> DurationUnit {
		self.unit
	}

	/// Converts this value to a standard duration, returning an error on
	/// overflow.
	pub fn to_std(self) -> Result<StdDuration, DurationError> {
		let nanos = u128::from(self.value) * u128::from(self.unit.nanoseconds());
		let seconds = nanos / 1_000_000_000;
		let subsecond_nanos = (nanos % 1_000_000_000) as u32;
		let seconds = u64::try_from(seconds).map_err(|_| DurationError::Overflow)?;
		Ok(StdDuration::new(seconds, subsecond_nanos))
	}

	/// Converts a standard duration into an exact value in `unit`.
	///
	/// A duration with finer precision than `unit`, or a quotient larger than
	/// [`u64::MAX`], is refused rather than rounded.
	pub fn from_std(value: StdDuration, unit: DurationUnit) -> Result<Self, DurationError> {
		let nanos = value.as_nanos();
		let unit_nanos = u128::from(unit.nanoseconds());
		if !nanos.is_multiple_of(unit_nanos) {
			return Err(DurationError::PrecisionLoss);
		}
		let value = u64::try_from(nanos / unit_nanos).map_err(|_| DurationError::Overflow)?;
		Ok(Self::new(value, unit))
	}

	const fn total_nanoseconds(self) -> u128 {
		self.value as u128 * self.unit.nanoseconds() as u128
	}
}

impl FromStr for Duration {
	type Err = DurationError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let split = value
			.bytes()
			.position(|byte| !byte.is_ascii_digit())
			.ok_or(DurationError::InvalidSyntax)?;
		if split == 0 {
			return Err(DurationError::InvalidSyntax);
		}
		let magnitude = value[..split]
			.parse::<u64>()
			.map_err(|_| DurationError::Overflow)?;
		let unit = value[split..]
			.parse::<DurationUnit>()
			.map_err(|_| DurationError::InvalidSyntax)?;
		Ok(Self::new(magnitude, unit))
	}
}

impl Display for Duration {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}{}", self.value, self.unit)
	}
}

impl PartialEq for Duration {
	fn eq(&self, other: &Self) -> bool {
		self.total_nanoseconds() == other.total_nanoseconds()
	}
}

impl Eq for Duration {}

impl PartialOrd for Duration {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Duration {
	fn cmp(&self, other: &Self) -> Ordering {
		self.total_nanoseconds().cmp(&other.total_nanoseconds())
	}
}

impl Hash for Duration {
	fn hash<H: Hasher>(&self, state: &mut H) {
		self.total_nanoseconds().hash(state);
	}
}

#[cfg(test)]
mod tests {
	use std::time::{Duration as StdDuration, UNIX_EPOCH};

	use super::{Duration, DurationError, DurationUnit, format_rfc3339, parse_rfc3339};

	#[test]
	fn formats_utc_seconds() {
		assert_eq!(format_rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
		assert_eq!(
			format_rfc3339(UNIX_EPOCH + StdDuration::from_secs(1_709_208_245)),
			"2024-02-29T12:04:05Z"
		);
		assert_eq!(format_rfc3339(UNIX_EPOCH - StdDuration::from_secs(1)), "1970-01-01T00:00:00Z");
	}

	#[test]
	fn parses_fractional_seconds_and_offsets() {
		let expected = UNIX_EPOCH + StdDuration::new(1_700_098_592, 547_123_456);
		assert_eq!(parse_rfc3339("2023-11-16T01:36:32.547123456Z"), Some(expected));
		assert_eq!(parse_rfc3339("2023-11-16t04:06:32.547123456+02:30"), Some(expected));
		assert_eq!(parse_rfc3339("2023-11-15T19:36:32.547123456-06:00"), Some(expected));
		assert_eq!(
			parse_rfc3339("2023-11-16T01:36:32.5z"),
			Some(UNIX_EPOCH + StdDuration::new(1_700_098_592, 500_000_000))
		);
	}

	#[test]
	fn parses_pre_epoch_values() {
		assert_eq!(
			parse_rfc3339("1969-12-31T23:59:59Z"),
			Some(UNIX_EPOCH - StdDuration::from_secs(1))
		);
		assert_eq!(
			parse_rfc3339("1969-12-31T23:59:59.5Z"),
			Some(UNIX_EPOCH - StdDuration::from_millis(500))
		);
	}

	#[test]
	fn rejects_malformed_values() {
		for value in [
			"",
			"2023-11-16T01:36:32",
			"2023/11/16T01:36:32Z",
			"2023-13-16T01:36:32Z",
			"2023-02-29T01:36:32Z",
			"2024-02-30T01:36:32Z",
			"2023-11-16T24:00:00Z",
			"2023-11-16T01:60:00Z",
			"2023-11-16T01:36:60Z",
			"2023-11-16T01:36:32.Z",
			"2023-11-16T01:36:32.1234567890Z",
			"2023-11-16T01:36:32+24:00",
			"2023-11-16T01:36:32+00:60",
			"2023-11-16T01:36:32Ztrailing",
		] {
			assert_eq!(parse_rfc3339(value), None, "accepted {value:?}");
		}
	}

	#[test]
	fn duration_preserves_units_and_compares_elapsed_time() {
		let seconds = "1s".parse::<Duration>().unwrap();
		let milliseconds = "1000ms".parse::<Duration>().unwrap();
		assert_eq!(seconds, milliseconds);
		assert_eq!(milliseconds.value(), 1000);
		assert_eq!(milliseconds.unit(), DurationUnit::Milliseconds);
		assert_eq!(milliseconds.to_string(), "1000ms");
	}

	#[test]
	fn duration_std_conversion_checks_boundaries_and_precision() {
		assert_eq!(
			Duration::from_std(StdDuration::from_millis(1500), DurationUnit::Milliseconds),
			Ok(Duration::new(1500, DurationUnit::Milliseconds))
		);
		assert_eq!(
			Duration::from_std(StdDuration::from_millis(1500), DurationUnit::Seconds),
			Err(DurationError::PrecisionLoss)
		);
		assert_eq!(
			Duration::new(u64::MAX, DurationUnit::Hours).to_std(),
			Err(DurationError::Overflow)
		);
		assert_eq!(
			Duration::from_std(StdDuration::new(u64::MAX, 999_999_999), DurationUnit::Nanoseconds),
			Err(DurationError::Overflow)
		);
	}

	#[test]
	fn duration_rejects_implicit_or_malformed_units() {
		for value in ["", "1", "1.5s", "-1s", "ms", "1seconds", " 1s"] {
			assert!(matches!(value.parse::<Duration>(), Err(DurationError::InvalidSyntax)));
		}
	}
}
