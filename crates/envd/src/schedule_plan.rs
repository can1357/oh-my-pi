//! Pure occurrence and budget planning for daemon-owned durable schedules.
//!
//! The daemon owns clocks, storage, and delivery.  Keeping the arithmetic here
//! makes restart recovery deterministic and independently testable.

use std::{fs, path::Path, time::Duration};

use omp_core::Str;
use thiserror::Error;

use crate::schedules::{ScheduleBudget, Trigger};

/// Bounded number of cron instants inspected while finding the next match.
const MAX_CRON_STEPS: usize = 366 * 24 * 60 * 60;
/// Maximum individual occurrences replayed by backfill recovery.
pub const MAX_BACKFILL_RECOVERY: usize = 32;

/// Failure to interpret a durable trigger.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PlannerError {
	/// The cron expression is not a supported five- or six-field expression.
	#[error("invalid cron expression: {0}")]
	InvalidCron(Str),
	/// The timezone cannot be resolved without an IANA timezone provider.
	#[error("unsupported schedule timezone: {0}")]
	UnsupportedTimezone(Str),
	/// An interval cannot be represented in epoch milliseconds.
	#[error("schedule duration exceeds epoch range")]
	DurationOverflow,
}

/// Spend already committed inside a schedule's rolling budget window.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BudgetUsage {
	/// Receipt cost in millionths of one US dollar.
	pub cost_micros: u64,
	/// Provider requests charged to the schedule.
	pub requests:    u64,
}

/// Conservative pre-delivery reservation supplied by the delivery owner.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BudgetReservation {
	/// Maximum expected receipt cost for this firing.
	pub cost_micros: u64,
	/// Maximum provider request count for this firing.
	pub requests:    u64,
}

/// Returns whether a reservation fits both per-firing and rolling limits.
pub fn budget_allows(
	budget: ScheduleBudget,
	used: BudgetUsage,
	reservation: BudgetReservation,
) -> bool {
	budget
		.max_usd_per_firing_micros
		.is_none_or(|limit| reservation.cost_micros <= limit)
		&& budget
			.max_requests_per_firing
			.is_none_or(|limit| reservation.requests <= limit)
		&& budget
			.max_usd_per_window_micros
			.is_none_or(|limit| used.cost_micros.saturating_add(reservation.cost_micros) <= limit)
}

/// Returns the first trigger occurrence strictly later than `after_ms`.
///
/// `anchor_ms` is the durable declaration time for unaligned intervals and
/// idle triggers. Cron supports UTC and numeric fixed offsets here; an envd
/// timezone provider may resolve richer IANA zones before calling this helper.
pub fn next_occurrence(
	trigger: &Trigger,
	schedule_id: &str,
	anchor_ms: u64,
	after_ms: u64,
) -> Result<Option<u64>, PlannerError> {
	match trigger {
		Trigger::At { epoch_ms } => Ok((*epoch_ms > after_ms).then_some(*epoch_ms)),
		Trigger::AfterIdle { idle } => Ok(Some(
			anchor_ms
				.checked_add(duration_ms(*idle)?)
				.ok_or(PlannerError::DurationOverflow)?,
		)
		.filter(|instant| *instant > after_ms)),
		Trigger::Every { interval, jitter, align } => {
			let interval = duration_ms(*interval)?;
			if interval == 0 {
				return Ok(None);
			}
			let origin = if *align { 0 } else { anchor_ms };
			let elapsed = after_ms.saturating_sub(origin);
			let mut ordinal = elapsed / interval + 1;
			loop {
				let base = origin
					.checked_add(
						ordinal
							.checked_mul(interval)
							.ok_or(PlannerError::DurationOverflow)?,
					)
					.ok_or(PlannerError::DurationOverflow)?;
				let spread = duration_ms(*jitter)?;
				let instant = base
					.checked_add(deterministic_jitter(schedule_id, ordinal, spread))
					.ok_or(PlannerError::DurationOverflow)?;
				if instant > after_ms {
					return Ok(Some(instant));
				}
				ordinal = ordinal
					.checked_add(1)
					.ok_or(PlannerError::DurationOverflow)?;
			}
		},
		Trigger::Cron { expr, timezone } => next_cron(expr, timezone, after_ms),
	}
}

fn duration_ms(duration: Duration) -> Result<u64, PlannerError> {
	u64::try_from(duration.as_millis()).map_err(|_| PlannerError::DurationOverflow)
}

fn deterministic_jitter(id: &str, ordinal: u64, maximum: u64) -> u64 {
	if maximum == 0 {
		return 0;
	}
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for byte in id.bytes().chain(ordinal.to_le_bytes()) {
		hash ^= u64::from(byte);
		hash = hash.wrapping_mul(0x100_0000_01b3);
	}
	hash % maximum.saturating_add(1)
}
fn next_cron(expr: &str, timezone: &str, after_ms: u64) -> Result<Option<u64>, PlannerError> {
	let cron = Cron::parse(expr)?;
	let zone = Zone::load(timezone)?;
	let quantum = if cron.has_seconds { 1_000 } else { 60_000 };
	let mut instant = after_ms
		.checked_div(quantum)
		.and_then(|value| value.checked_add(1))
		.and_then(|value| value.checked_mul(quantum))
		.ok_or(PlannerError::DurationOverflow)?;
	for _ in 0..MAX_CRON_STEPS {
		let local_seconds = i64::try_from(instant / 1_000)
			.map_err(|_| PlannerError::DurationOverflow)?
			.saturating_add(i64::from(zone.offset_at(instant / 1_000)));
		if cron.matches(Civil::from_unix_seconds(local_seconds)) {
			return Ok(Some(instant));
		}
		instant = instant
			.checked_add(quantum)
			.ok_or(PlannerError::DurationOverflow)?;
	}
	Ok(None)
}

enum Zone {
	Fixed(i32),
	Transitions { instants: Vec<i64>, indexes: Vec<u8>, offsets: Vec<i32> },
}

impl Zone {
	fn load(timezone: &str) -> Result<Self, PlannerError> {
		if matches!(timezone, "UTC" | "Etc/UTC" | "Z" | "GMT") {
			return Ok(Self::Fixed(0));
		}
		let value = timezone.strip_prefix("UTC").unwrap_or(timezone);
		if let Some((sign, rest)) = match value.as_bytes().first() {
			Some(b'+') => Some((1, &value[1..])),
			Some(b'-') => Some((-1, &value[1..])),
			_ => None,
		} {
			let (hours, minutes) = rest.split_once(':').unwrap_or((rest, "0"));
			let hours = hours
				.parse::<i32>()
				.map_err(|_| PlannerError::UnsupportedTimezone(Str::from(timezone)))?;
			let minutes = minutes
				.parse::<i32>()
				.map_err(|_| PlannerError::UnsupportedTimezone(Str::from(timezone)))?;
			if hours > 23 || minutes > 59 {
				return Err(PlannerError::UnsupportedTimezone(Str::from(timezone)));
			}
			return Ok(Self::Fixed(sign * (hours * 3_600 + minutes * 60)));
		}
		if timezone.is_empty()
			|| timezone.starts_with('/')
			|| timezone
				.split('/')
				.any(|part| matches!(part, "" | "." | ".."))
		{
			return Err(PlannerError::UnsupportedTimezone(Str::from(timezone)));
		}
		let bytes = ["/usr/share/zoneinfo", "/usr/share/lib/zoneinfo"]
			.into_iter()
			.find_map(|root| fs::read(Path::new(root).join(timezone)).ok())
			.ok_or_else(|| PlannerError::UnsupportedTimezone(Str::from(timezone)))?;
		parse_tzif(&bytes).ok_or_else(|| PlannerError::UnsupportedTimezone(Str::from(timezone)))
	}

	fn offset_at(&self, epoch_seconds: u64) -> i32 {
		match self {
			Self::Fixed(offset) => *offset,
			Self::Transitions { instants, indexes, offsets } => {
				let instant = i64::try_from(epoch_seconds).unwrap_or(i64::MAX);
				let position = instants.partition_point(|transition| *transition <= instant);
				let index = if position == 0 {
					0
				} else {
					usize::from(indexes[position - 1])
				};
				offsets.get(index).copied().unwrap_or(0)
			},
		}
	}
}

fn parse_tzif(bytes: &[u8]) -> Option<Zone> {
	let first = TzifHeader::parse(bytes.get(..44)?)?;
	let (header, body, wide) = if matches!(bytes.get(4).copied(), Some(b'2' | b'3' | b'4')) {
		let second = 44_usize.checked_add(first.block_len(false)?)?;
		let header = TzifHeader::parse(bytes.get(second..second.checked_add(44)?)?)?;
		(header, second.checked_add(44)?, true)
	} else {
		(first, 44, false)
	};
	let time_width = if wide { 8 } else { 4 };
	let times_end = body.checked_add(header.time_count.checked_mul(time_width)?)?;
	let indexes_end = times_end.checked_add(header.time_count)?;
	let types_end = indexes_end.checked_add(header.type_count.checked_mul(6)?)?;
	let times = bytes.get(body..times_end)?;
	let indexes = bytes.get(times_end..indexes_end)?.to_vec();
	let types = bytes.get(indexes_end..types_end)?;
	let mut instants = Vec::with_capacity(header.time_count);
	for chunk in times.chunks_exact(time_width) {
		let instant = if wide {
			i64::from_be_bytes(chunk.try_into().ok()?)
		} else {
			i64::from(i32::from_be_bytes(chunk.try_into().ok()?))
		};
		instants.push(instant);
	}
	let mut offsets = Vec::with_capacity(header.type_count);
	for chunk in types.chunks_exact(6) {
		offsets.push(i32::from_be_bytes(chunk[..4].try_into().ok()?));
	}
	if offsets.is_empty()
		|| indexes
			.iter()
			.any(|index| usize::from(*index) >= offsets.len())
	{
		return None;
	}
	Some(Zone::Transitions { instants, indexes, offsets })
}

#[derive(Clone, Copy)]
struct TzifHeader {
	gmt_count:  usize,
	std_count:  usize,
	leap_count: usize,
	time_count: usize,
	type_count: usize,
	char_count: usize,
}

impl TzifHeader {
	fn parse(bytes: &[u8]) -> Option<Self> {
		if bytes.get(..4)? != b"TZif" {
			return None;
		}
		let count = |offset: usize| {
			u32::from_be_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?)
				.try_into()
				.ok()
		};
		Some(Self {
			gmt_count:  count(20)?,
			std_count:  count(24)?,
			leap_count: count(28)?,
			time_count: count(32)?,
			type_count: count(36)?,
			char_count: count(40)?,
		})
	}

	fn block_len(self, wide: bool) -> Option<usize> {
		let time_width = if wide { 8 } else { 4 };
		let leap_width = if wide { 12 } else { 8 };
		self
			.time_count
			.checked_mul(time_width)?
			.checked_add(self.time_count)?
			.checked_add(self.type_count.checked_mul(6)?)?
			.checked_add(self.char_count)?
			.checked_add(self.leap_count.checked_mul(leap_width)?)?
			.checked_add(self.std_count)?
			.checked_add(self.gmt_count)
	}
}

#[derive(Clone)]
struct Cron {
	seconds:     Field,
	minutes:     Field,
	hours:       Field,
	days:        Field,
	months:      Field,
	weekdays:    Field,
	has_seconds: bool,
}

impl Cron {
	fn parse(expr: &str) -> Result<Self, PlannerError> {
		let fields: Vec<_> = expr.split_whitespace().collect();
		let (has_seconds, fields) = match fields.len() {
			5 => (false, fields),
			6 => (true, fields),
			_ => return Err(PlannerError::InvalidCron(Str::from(expr))),
		};
		let at = |index: usize| fields[index];
		let offset = usize::from(has_seconds);
		Ok(Self {
			seconds: if has_seconds {
				Field::parse(at(0), 0, 59)?
			} else {
				Field::only(0)
			},
			minutes: Field::parse(at(offset), 0, 59)?,
			hours: Field::parse(at(offset + 1), 0, 23)?,
			days: Field::parse(at(offset + 2), 1, 31)?,
			months: Field::parse(at(offset + 3), 1, 12)?,
			weekdays: Field::parse(at(offset + 4), 0, 7)?,
			has_seconds,
		})
	}

	fn matches(&self, value: Civil) -> bool {
		let day_matches = self.days.contains(value.day);
		let weekday_matches =
			self.weekdays.contains(value.weekday) || (value.weekday == 0 && self.weekdays.contains(7));
		let calendar_matches = match (self.days.any, self.weekdays.any) {
			(true, true) => true,
			(true, false) => weekday_matches,
			(false, true) => day_matches,
			(false, false) => day_matches || weekday_matches,
		};
		self.seconds.contains(value.second)
			&& self.minutes.contains(value.minute)
			&& self.hours.contains(value.hour)
			&& self.months.contains(value.month)
			&& calendar_matches
	}
}

#[derive(Clone)]
struct Field {
	bits: u64,
	any:  bool,
}

impl Field {
	const fn only(value: u8) -> Self {
		Self { bits: 1_u64 << value, any: false }
	}

	fn parse(source: &str, minimum: u8, maximum: u8) -> Result<Self, PlannerError> {
		let mut bits = 0_u64;
		for part in source.split(',') {
			let (range, step) = part
				.split_once('/')
				.map_or((part, 1), |(range, step)| (range, step.parse::<u8>().unwrap_or(0)));
			if step == 0 {
				return Err(PlannerError::InvalidCron(Str::from(source)));
			}
			let (start, end) = if range == "*" {
				(minimum, maximum)
			} else if let Some((start, end)) = range.split_once('-') {
				(parse_field_value(start, minimum, maximum)?, parse_field_value(end, minimum, maximum)?)
			} else {
				let value = parse_field_value(range, minimum, maximum)?;
				(value, value)
			};
			if start > end {
				return Err(PlannerError::InvalidCron(Str::from(source)));
			}
			for value in (start..=end).step_by(usize::from(step)) {
				bits |= 1_u64 << value;
			}
		}
		if bits == 0 {
			return Err(PlannerError::InvalidCron(Str::from(source)));
		}
		Ok(Self { bits, any: source.starts_with('*') })
	}

	const fn contains(&self, value: u8) -> bool {
		self.bits & (1_u64 << value) != 0
	}
}

fn parse_field_value(source: &str, minimum: u8, maximum: u8) -> Result<u8, PlannerError> {
	let value = source
		.parse::<u8>()
		.map_err(|_| PlannerError::InvalidCron(Str::from(source)))?;
	if value < minimum || value > maximum {
		return Err(PlannerError::InvalidCron(Str::from(source)));
	}
	Ok(value)
}

#[derive(Clone, Copy)]
struct Civil {
	month:   u8,
	day:     u8,
	hour:    u8,
	minute:  u8,
	second:  u8,
	weekday: u8,
}

impl Civil {
	fn from_unix_seconds(seconds: i64) -> Self {
		let days = seconds.div_euclid(86_400);
		let day_seconds = seconds.rem_euclid(86_400);
		let z = days + 719_468;
		let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
		let doe = z - era * 146_097;
		let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
		let year = yoe + era * 400;
		let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
		let mp = (5 * doy + 2) / 153;
		let day = doy - (153 * mp + 2) / 5 + 1;
		let month = mp + if mp < 10 { 3 } else { -9 };
		let _year = year + i64::from(month <= 2);
		Self {
			month:   u8::try_from(month).unwrap_or(1),
			day:     u8::try_from(day).unwrap_or(1),
			hour:    u8::try_from(day_seconds / 3_600).unwrap_or(0),
			minute:  u8::try_from(day_seconds % 3_600 / 60).unwrap_or(0),
			second:  u8::try_from(day_seconds % 60).unwrap_or(0),
			weekday: u8::try_from((days + 4).rem_euclid(7)).unwrap_or(0),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn aligned_interval_and_jitter_are_restart_stable() {
		let trigger = Trigger::Every {
			interval: Duration::from_secs(60),
			jitter:   Duration::from_secs(5),
			align:    true,
		};
		let first = next_occurrence(&trigger, "a", 12_345, 60_000).unwrap();
		assert_eq!(first, next_occurrence(&trigger, "a", 99_999, 60_000).unwrap());
		assert!(first.unwrap() > 60_000);
	}

	#[test]
	fn cron_five_field_matches_utc_minute() {
		let trigger = Trigger::Cron { expr: Str::from("0 12 * * *"), timezone: Str::from("UTC") };
		assert_eq!(next_occurrence(&trigger, "a", 0, 0).unwrap(), Some(43_200_000));
	}
	#[test]
	fn cron_resolves_iana_timezone_transitions() {
		let trigger = Trigger::Cron {
			expr:     Str::from("0 0 * * *"),
			timezone: Str::from("America/New_York"),
		};
		assert_eq!(
			next_occurrence(&trigger, "a", 0, 1_704_067_200_000).unwrap(),
			Some(1_704_085_200_000),
		);
	}

	#[test]
	fn budget_reserves_before_delivery() {
		let budget = ScheduleBudget {
			max_usd_per_firing_micros: Some(100),
			max_usd_per_window_micros: Some(1_000),
			window:                    Duration::from_secs(60),
			max_requests_per_firing:   Some(2),
		};
		assert!(budget_allows(
			budget,
			BudgetUsage { cost_micros: 850, requests: 3 },
			BudgetReservation { cost_micros: 100, requests: 2 },
		));
		assert!(!budget_allows(
			budget,
			BudgetUsage { cost_micros: 950, requests: 3 },
			BudgetReservation { cost_micros: 100, requests: 2 },
		));
	}
}
