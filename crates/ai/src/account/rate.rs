//! Independent request-rate windows and retry timing.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use im::OrdMap;
use omp_core::Str;

/// Identifies one independently enforced rate window.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RateWindowId(pub Str);

impl RateWindowId {
	/// Creates a rate-window identifier.
	pub fn new(value: impl Into<Str>) -> Self {
		Self(value.into())
	}

	/// Borrows the stable window identifier.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

/// One independently timestamped provider observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Sample<T> {
	/// Observed value.
	pub value:       T,
	/// Time at which the value was observed.
	pub observed_at: SystemTime,
}

/// A partial observation of one rate window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateObservation {
	/// Window being updated.
	pub window:      RateWindowId,
	/// Maximum units in the window, when reported.
	pub limit:       Option<u64>,
	/// Remaining units in the window, when reported.
	pub remaining:   Option<u64>,
	/// Absolute provider reset time, when reported.
	pub reset_at:    Option<SystemTime>,
	/// Explicit temporary retry barrier, usually from `Retry-After`.
	pub retry_at:    Option<SystemTime>,
	/// Time at which this receipt was observed.
	pub observed_at: SystemTime,
}

/// Merged state for one rate window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateWindow {
	/// Most recent limit sample.
	pub limit:     Option<Sample<u64>>,
	/// Most recent remaining-capacity sample.
	pub remaining: Option<Sample<u64>>,
	/// Most recent reset sample.
	pub reset_at:  Option<Sample<SystemTime>>,
	/// Most recent explicit retry barrier.
	pub retry_at:  Option<Sample<SystemTime>>,
	/// Every partial receipt applied to the window, in arrival order.
	pub receipts:  Vec<RateObservation>,
}

impl RateWindow {
	const fn new() -> Self {
		Self {
			limit:     None,
			remaining: None,
			reset_at:  None,
			retry_at:  None,
			receipts:  Vec::new(),
		}
	}

	fn apply(&mut self, observation: RateObservation) {
		merge_sample(&mut self.limit, observation.limit, observation.observed_at);
		merge_sample(&mut self.remaining, observation.remaining, observation.observed_at);
		merge_sample(&mut self.reset_at, observation.reset_at, observation.observed_at);
		merge_sample(&mut self.retry_at, observation.retry_at, observation.observed_at);
		self.receipts.push(observation);
	}

	/// Computes availability without mutating or discarding historical receipts.
	pub fn availability(&self, now: SystemTime) -> RateAvailability {
		let retry = self
			.retry_at
			.and_then(|sample| (sample.value > now).then_some(sample.value));
		let exhausted_until = if self.remaining.is_some_and(|sample| sample.value == 0) {
			match self.reset_at.map(|sample| sample.value) {
				Some(reset_at) if reset_at > now => Some(Ok(reset_at)),
				Some(_) => None,
				None => Some(Err(())),
			}
		} else {
			None
		};
		match (retry, exhausted_until) {
			(Some(retry), Some(Ok(reset))) => RateAvailability::Delayed { until: retry.max(reset) },
			(Some(until), _) | (None, Some(Ok(until))) => RateAvailability::Delayed { until },
			(None, Some(Err(()))) => RateAvailability::ExhaustedUnknownReset,
			(None, None) => RateAvailability::Available,
		}
	}
}

fn merge_sample<T: Copy>(slot: &mut Option<Sample<T>>, value: Option<T>, observed_at: SystemTime) {
	let Some(value) = value else { return };
	if slot
		.as_ref()
		.is_none_or(|current| observed_at >= current.observed_at)
	{
		*slot = Some(Sample { value, observed_at });
	}
}

/// Current admission state across all rate windows.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RateAvailability {
	/// No active window blocks an attempt.
	Available,
	/// At least one window blocks attempts until this deterministic latest
	/// reset.
	Delayed {
		/// Latest rate-window reset that permits another attempt.
		until: SystemTime,
	},
	/// Capacity is exhausted and the provider supplied no reset.
	ExhaustedUnknownReset,
}

/// Independent rate state for one account.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RateState {
	windows: OrdMap<RateWindowId, RateWindow>,
}

impl RateState {
	/// Applies a partial observation without clearing fields omitted by the
	/// provider.
	pub fn apply(&mut self, observation: RateObservation) {
		self
			.windows
			.entry(observation.window.clone())
			.or_insert_with(RateWindow::new)
			.apply(observation);
	}

	/// Records a rate-classified 429 without modifying quota state.
	pub fn record_429(
		&mut self,
		window: RateWindowId,
		retry_at: Option<SystemTime>,
		observed_at: SystemTime,
	) {
		self.apply(RateObservation {
			window,
			limit: None,
			remaining: Some(0),
			reset_at: retry_at,
			retry_at,
			observed_at,
		});
	}

	/// Returns a window by identifier.
	pub fn window(&self, id: &RateWindowId) -> Option<&RateWindow> {
		self.windows.get(id)
	}

	/// Iterates over windows in stable identifier order.
	pub fn windows(&self) -> impl ExactSizeIterator<Item = (&RateWindowId, &RateWindow)> {
		self.windows.iter()
	}

	/// Clears selected windows, or every window when the selection is empty.
	pub fn clear(&mut self, scopes: &[Str]) {
		if scopes.is_empty() {
			self.windows.clear();
		} else {
			for scope in scopes {
				self.windows.remove(&RateWindowId::new(scope.clone()));
			}
		}
	}

	/// Computes aggregate availability; the latest active reset wins
	/// deterministically.
	pub fn availability(&self, now: SystemTime) -> RateAvailability {
		let mut until = None;
		for window in self.windows.values() {
			match window.availability(now) {
				RateAvailability::Available => {},
				RateAvailability::Delayed { until: candidate } => {
					until = Some(until.map_or(candidate, |current: SystemTime| current.max(candidate)));
				},
				RateAvailability::ExhaustedUnknownReset => {
					return RateAvailability::ExhaustedUnknownReset;
				},
			}
		}
		until.map_or(RateAvailability::Available, |until| RateAvailability::Delayed { until })
	}
}

/// Syntax accepted for a retry/reset hint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryAfterInput<'a> {
	/// RFC `Retry-After`: delta-seconds or IMF-fixdate.
	Header(&'a str),
	/// Provider-specific relative seconds.
	DelaySeconds(&'a str),
	/// Provider-specific Unix epoch seconds.
	UnixSeconds(&'a str),
	/// Provider-specific Unix epoch milliseconds.
	UnixMilliseconds(&'a str),
	/// Already parsed absolute time.
	Absolute(SystemTime),
}

/// Provenance of a parsed retry time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryAfterSource {
	/// RFC delta-seconds.
	HeaderDelta,
	/// RFC IMF-fixdate.
	HeaderDate,
	/// Provider-specific relative seconds.
	DelaySeconds,
	/// Provider-specific Unix seconds.
	UnixSeconds,
	/// Provider-specific Unix milliseconds.
	UnixMilliseconds,
	/// Typed absolute input.
	Absolute,
}

/// A successfully parsed retry time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParsedRetryAfter {
	/// Absolute retry time.
	pub until:  SystemTime,
	/// Input syntax that produced the time.
	pub source: RetryAfterSource,
}

/// Classifies deterministic retry-hint parse failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetryAfterParseErrorKind {
	/// Input was empty.
	Empty,
	/// Input was neither a supported integer nor an IMF-fixdate.
	InvalidSyntax,
	/// Date fields were outside their valid ranges.
	InvalidDate,
	/// The value exceeded `SystemTime` arithmetic bounds.
	OutOfRange,
}

/// Error parsing one retry timing input.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("invalid retry timing ({syntax:?}): {kind:?}")]
pub struct RetryAfterParseError {
	/// Syntax attempted.
	pub syntax: RetryAfterSource,
	/// Failure classification.
	pub kind:   RetryAfterParseErrorKind,
}

/// Result of parsing several independent retry timing inputs.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RetryAfterParse {
	/// Conservative latest successfully parsed retry time.
	pub selected: Option<ParsedRetryAfter>,
	/// Failures retained as evidence instead of discarding the partial receipt.
	pub rejected: Vec<RetryAfterParseError>,
}

/// Parses one retry timing input relative to `now`.
pub fn parse_retry_after(
	input: RetryAfterInput<'_>,
	now: SystemTime,
) -> Result<ParsedRetryAfter, RetryAfterParseError> {
	match input {
		RetryAfterInput::Absolute(until) => {
			Ok(ParsedRetryAfter { until, source: RetryAfterSource::Absolute })
		},
		RetryAfterInput::DelaySeconds(raw) => parse_delay(raw, now, RetryAfterSource::DelaySeconds),
		RetryAfterInput::UnixSeconds(raw) => parse_epoch(raw, 1_000, RetryAfterSource::UnixSeconds),
		RetryAfterInput::UnixMilliseconds(raw) => {
			parse_epoch(raw, 1, RetryAfterSource::UnixMilliseconds)
		},
		RetryAfterInput::Header(raw) => {
			let raw = raw.trim();
			if raw.is_empty() {
				return Err(RetryAfterParseError {
					syntax: RetryAfterSource::HeaderDelta,
					kind:   RetryAfterParseErrorKind::Empty,
				});
			}
			if raw.bytes().all(|byte| byte.is_ascii_digit()) {
				parse_delay(raw, now, RetryAfterSource::HeaderDelta)
			} else {
				parse_http_date(raw)
					.map(|until| ParsedRetryAfter { until, source: RetryAfterSource::HeaderDate })
			}
		},
	}
}

/// Parses all supplied hints and selects the latest valid reset conservatively.
pub fn parse_retry_after_inputs<'a>(
	inputs: impl IntoIterator<Item = RetryAfterInput<'a>>,
	now: SystemTime,
) -> RetryAfterParse {
	let mut parsed = RetryAfterParse::default();
	for input in inputs {
		match parse_retry_after(input, now) {
			Ok(candidate) => {
				if parsed
					.selected
					.is_none_or(|current| candidate.until > current.until)
				{
					parsed.selected = Some(candidate);
				}
			},
			Err(error) => parsed.rejected.push(error),
		}
	}
	parsed
}

fn parse_delay(
	raw: &str,
	now: SystemTime,
	source: RetryAfterSource,
) -> Result<ParsedRetryAfter, RetryAfterParseError> {
	let seconds = parse_u64(raw, source)?;
	let until = now
		.checked_add(Duration::from_secs(seconds))
		.ok_or(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::OutOfRange,
		})?;
	Ok(ParsedRetryAfter { until, source })
}

fn parse_epoch(
	raw: &str,
	millis_per_unit: u64,
	source: RetryAfterSource,
) -> Result<ParsedRetryAfter, RetryAfterParseError> {
	let value = parse_u64(raw, source)?;
	let millis = value
		.checked_mul(millis_per_unit)
		.ok_or(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::OutOfRange,
		})?;
	let until = UNIX_EPOCH
		.checked_add(Duration::from_millis(millis))
		.ok_or(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::OutOfRange,
		})?;
	Ok(ParsedRetryAfter { until, source })
}

fn parse_u64(raw: &str, source: RetryAfterSource) -> Result<u64, RetryAfterParseError> {
	let raw = raw.trim();
	if raw.is_empty() {
		return Err(RetryAfterParseError { syntax: source, kind: RetryAfterParseErrorKind::Empty });
	}
	if !raw.bytes().all(|byte| byte.is_ascii_digit()) {
		return Err(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::InvalidSyntax,
		});
	}
	raw.parse().map_err(|_| RetryAfterParseError {
		syntax: source,
		kind:   RetryAfterParseErrorKind::OutOfRange,
	})
}

fn parse_http_date(raw: &str) -> Result<SystemTime, RetryAfterParseError> {
	let source = RetryAfterSource::HeaderDate;
	let bytes = raw.as_bytes();
	if bytes.len() != 29
		|| bytes[3] != b','
		|| bytes[4] != b' '
		|| bytes[7] != b' '
		|| bytes[11] != b' '
		|| bytes[16] != b' '
		|| bytes[19] != b':'
		|| bytes[22] != b':'
		|| &bytes[25..] != b" GMT"
	{
		return Err(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::InvalidSyntax,
		});
	}
	let weekday = match &bytes[..3] {
		b"Sun" => 0_i64,
		b"Mon" => 1,
		b"Tue" => 2,
		b"Wed" => 3,
		b"Thu" => 4,
		b"Fri" => 5,
		b"Sat" => 6,
		_ => {
			return Err(RetryAfterParseError {
				syntax: source,
				kind:   RetryAfterParseErrorKind::InvalidDate,
			});
		},
	};
	let day = parse_digits(&bytes[5..7], source)? as u32;
	let month = match &bytes[8..11] {
		b"Jan" => 1,
		b"Feb" => 2,
		b"Mar" => 3,
		b"Apr" => 4,
		b"May" => 5,
		b"Jun" => 6,
		b"Jul" => 7,
		b"Aug" => 8,
		b"Sep" => 9,
		b"Oct" => 10,
		b"Nov" => 11,
		b"Dec" => 12,
		_ => {
			return Err(RetryAfterParseError {
				syntax: source,
				kind:   RetryAfterParseErrorKind::InvalidDate,
			});
		},
	};
	let year = parse_digits(&bytes[12..16], source)? as i64;
	let hour = parse_digits(&bytes[17..19], source)? as u32;
	let minute = parse_digits(&bytes[20..22], source)? as u32;
	let second = parse_digits(&bytes[23..25], source)? as u32;
	let days_in_month = match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if is_leap_year(year) => 29,
		2 => 28,
		_ => 0,
	};
	if year < 1970 || day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
		return Err(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::InvalidDate,
		});
	}
	let days = days_from_civil(year, month, day);
	if (days + 4).rem_euclid(7) != weekday {
		return Err(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::InvalidDate,
		});
	}
	let seconds = days
		.checked_mul(86_400)
		.and_then(|value| {
			value.checked_add(i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second))
		})
		.and_then(|value| u64::try_from(value).ok())
		.ok_or(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::OutOfRange,
		})?;
	UNIX_EPOCH
		.checked_add(Duration::from_secs(seconds))
		.ok_or(RetryAfterParseError { syntax: source, kind: RetryAfterParseErrorKind::OutOfRange })
}

fn parse_digits(bytes: &[u8], source: RetryAfterSource) -> Result<u64, RetryAfterParseError> {
	if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
		return Err(RetryAfterParseError {
			syntax: source,
			kind:   RetryAfterParseErrorKind::InvalidSyntax,
		});
	}
	bytes
		.iter()
		.try_fold(0_u64, |value, byte| {
			value
				.checked_mul(10)
				.and_then(|value| value.checked_add(u64::from(byte - b'0')))
		})
		.ok_or(RetryAfterParseError { syntax: source, kind: RetryAfterParseErrorKind::OutOfRange })
}

const fn is_leap_year(year: i64) -> bool {
	year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
	let adjusted_year = year - i64::from(month <= 2);
	let era = if adjusted_year >= 0 {
		adjusted_year
	} else {
		adjusted_year - 399
	} / 400;
	let year_of_era = adjusted_year - era * 400;
	let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
	let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
}
