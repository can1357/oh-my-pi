//! Account quota windows kept separate from request-rate throttling.

use std::time::SystemTime;

use im::OrdMap;
use omp_core::Str;

use super::rate::Sample;

/// Identifies one independently reset quota window.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct QuotaWindowId(pub Str);

impl QuotaWindowId {
	/// Creates a quota-window identifier.
	pub fn new(value: impl Into<Str>) -> Self {
		Self(value.into())
	}

	/// Borrows the stable window identifier.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}

	/// Returns the structured meter scope carried by a provider window id.
	///
	/// Scoped provider windows use `provider:scope:window`; historical
	/// two-segment ids have no scope and remain shared for block compatibility.
	pub fn scope(&self) -> Option<&str> {
		let mut parts = self.as_str().split(':');
		let _provider = parts.next()?;
		let scope = parts.next()?;
		parts.next().is_some().then_some(scope)
	}
}

#[allow(
	missing_docs,
	reason = "strum generates the public string-conversion method in this private module"
)]
mod quota_provenance {
	use strum::{Display, EnumString, IntoStaticStr};

	/// Provenance of a quota measurement.
	#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
	#[strum(serialize_all = "snake_case", const_into_str)]
	pub enum QuotaProvenance {
		/// A usage or quota endpoint reported the value.
		Provider,
		/// Response headers reported the value.
		Header,
		/// A structured provider error reported exhaustion.
		Error,
		/// The runtime derived the value from accepted usage.
		Measured,
	}
}

#[doc(inline)]
pub use quota_provenance::QuotaProvenance;

/// A partial receipt for one account quota window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuotaObservation {
	/// Window being updated.
	pub window:      QuotaWindowId,
	/// Amount consumed, when reported.
	pub consumed:    Option<u64>,
	/// Amount remaining, when reported.
	pub remaining:   Option<u64>,
	/// Total allowance, when reported.
	pub limit:       Option<u64>,
	/// Absolute reset time, when reported.
	pub reset_at:    Option<SystemTime>,
	/// Whether structured evidence explicitly says the quota is exhausted.
	pub exhausted:   Option<bool>,
	/// Evidence provenance.
	pub provenance:  QuotaProvenance,
	/// Time at which the receipt was observed.
	pub observed_at: SystemTime,
}

/// Merged state for one quota window.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuotaWindow {
	/// Most recent consumed-value sample.
	pub consumed:  Option<Sample<u64>>,
	/// Most recent remaining-value sample.
	pub remaining: Option<Sample<u64>>,
	/// Most recent limit sample.
	pub limit:     Option<Sample<u64>>,
	/// Most recent reset sample.
	pub reset_at:  Option<Sample<SystemTime>>,
	/// Most recent explicit exhaustion sample.
	pub exhausted: Option<Sample<bool>>,
	/// Every partial receipt, retained in arrival order.
	pub receipts:  Vec<QuotaObservation>,
}

impl QuotaWindow {
	const fn new() -> Self {
		Self {
			consumed:  None,
			remaining: None,
			limit:     None,
			reset_at:  None,
			exhausted: None,
			receipts:  Vec::new(),
		}
	}

	fn apply(&mut self, observation: QuotaObservation) {
		merge_sample(&mut self.consumed, observation.consumed, observation.observed_at);
		merge_sample(&mut self.remaining, observation.remaining, observation.observed_at);
		merge_sample(&mut self.limit, observation.limit, observation.observed_at);
		merge_sample(&mut self.reset_at, observation.reset_at, observation.observed_at);
		merge_sample(&mut self.exhausted, observation.exhausted, observation.observed_at);
		self.receipts.push(observation);
	}

	/// Computes availability at a supplied deterministic clock instant.
	pub fn availability(&self, now: SystemTime) -> QuotaAvailability {
		let exhausted = match (self.exhausted, self.remaining) {
			(Some(explicit), Some(remaining)) if explicit.observed_at >= remaining.observed_at => {
				explicit.value
			},
			(_, Some(remaining)) => remaining.value == 0,
			(Some(explicit), None) => explicit.value,
			(None, None) => false,
		};
		if !exhausted {
			return QuotaAvailability::Available;
		}
		match self.reset_at.map(|sample| sample.value) {
			Some(reset_at) if reset_at > now => QuotaAvailability::Exhausted { reset_at },
			Some(_) => QuotaAvailability::Available,
			None => QuotaAvailability::ExhaustedUnknownReset,
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

/// Current quota eligibility across all account windows.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuotaAvailability {
	/// No current window is exhausted.
	Available,
	/// At least one window is exhausted until this deterministic latest reset.
	Exhausted {
		/// Deterministic time at which the exhausted window becomes available.
		reset_at: SystemTime,
	},
	/// A window is exhausted without a reported reset.
	ExhaustedUnknownReset,
}

/// Quota state for one account, independent of request-rate state.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct QuotaState {
	windows: OrdMap<QuotaWindowId, QuotaWindow>,
}

impl QuotaState {
	/// Applies a partial receipt without clearing omitted measurements.
	pub fn apply(&mut self, observation: QuotaObservation) {
		self
			.windows
			.entry(observation.window.clone())
			.or_insert_with(QuotaWindow::new)
			.apply(observation);
	}

	/// Records a quota-classified 429 without modifying rate state.
	pub fn record_429(
		&mut self,
		window: QuotaWindowId,
		reset_at: Option<SystemTime>,
		observed_at: SystemTime,
	) {
		self.apply(QuotaObservation {
			window,
			consumed: None,
			remaining: Some(0),
			limit: None,
			reset_at,
			exhausted: Some(true),
			provenance: QuotaProvenance::Error,
			observed_at,
		});
	}

	/// Returns a window by identifier.
	pub fn window(&self, id: &QuotaWindowId) -> Option<&QuotaWindow> {
		self.windows.get(id)
	}

	/// Iterates over windows in stable identifier order.
	pub fn windows(&self) -> impl ExactSizeIterator<Item = (&QuotaWindowId, &QuotaWindow)> {
		self.windows.iter()
	}

	/// Computes aggregate availability; the latest active reset wins
	/// deterministically.
	pub fn availability(&self, now: SystemTime) -> QuotaAvailability {
		self.availability_scoped(now, None)
	}

	/// Computes availability for one request meter.
	///
	/// Unscoped historical windows remain binding for every meter so blocks
	/// restored from older snapshots retain their provider-wide meaning.
	pub fn availability_scoped(&self, now: SystemTime, scope: Option<&str>) -> QuotaAvailability {
		let mut reset_at = None;
		for (id, window) in &self.windows {
			if scope.is_some_and(|scope| id.scope().is_some_and(|window| window != scope)) {
				continue;
			}
			match window.availability(now) {
				QuotaAvailability::Available => {},
				QuotaAvailability::Exhausted { reset_at: candidate } => {
					reset_at =
						Some(reset_at.map_or(candidate, |current: SystemTime| current.max(candidate)));
				},
				QuotaAvailability::ExhaustedUnknownReset => {
					return QuotaAvailability::ExhaustedUnknownReset;
				},
			}
		}
		reset_at
			.map_or(QuotaAvailability::Available, |reset_at| QuotaAvailability::Exhausted { reset_at })
	}

	/// Returns the smallest current known remaining amount for deterministic
	/// ranking.
	///
	/// A sample observed before an elapsed reset belongs to the previous quota
	/// window and is unknown.
	pub fn minimum_remaining(&self, now: SystemTime) -> Option<u64> {
		self.minimum_remaining_scoped(now, None)
	}

	/// Returns the smallest current remainder in one request meter.
	///
	/// A meter-specific report takes precedence over historical shared windows.
	/// A secondary-only scoped report is incomplete and therefore returns no
	/// ranking value instead of receiving an uncapped priority boost.
	pub fn minimum_remaining_scoped(&self, now: SystemTime, scope: Option<&str>) -> Option<u64> {
		let has_scoped =
			scope.is_some_and(|scope| self.windows.keys().any(|id| id.scope() == Some(scope)));
		if has_scoped && scope.is_some() {
			let mut primary = false;
			let mut secondary = false;
			for id in self.windows.keys().filter(|id| id.scope() == scope) {
				primary |= id.as_str().ends_with(":primary");
				secondary |= id.as_str().ends_with(":secondary");
			}
			if secondary && !primary {
				return None;
			}
		}
		self
			.windows
			.iter()
			.filter(|(id, _)| {
				scope.is_none()
					|| if has_scoped {
						id.scope() == scope
					} else {
						id.scope().is_none()
					}
			})
			.filter_map(|(_, window)| {
				let remaining = window.remaining?;
				if window
					.reset_at
					.is_some_and(|reset| reset.value <= now && remaining.observed_at < reset.value)
				{
					None
				} else {
					Some(remaining.value)
				}
			})
			.min()
	}

	/// Reports whether any current known remaining/limit pair is below the
	/// configured percentage. Unknown or reset-stale pairs do not fail closed.
	pub fn below_remaining_percent(&self, now: SystemTime, percent: u8) -> bool {
		self.below_remaining_percent_scoped(now, percent, None)
	}

	/// Reports whether one request meter is below the configured percentage.
	pub fn below_remaining_percent_scoped(
		&self,
		now: SystemTime,
		percent: u8,
		scope: Option<&str>,
	) -> bool {
		let percent = u128::from(percent.min(100));
		self.windows.iter().any(|(id, window)| {
			if scope.is_some_and(|scope| id.scope().is_some_and(|window| window != scope)) {
				return false;
			}
			let (Some(remaining), Some(limit)) = (window.remaining, window.limit) else {
				return false;
			};
			if limit.value == 0
				|| window
					.reset_at
					.is_some_and(|reset| reset.value <= now && remaining.observed_at < reset.value)
			{
				return false;
			}
			u128::from(remaining.value) * 100 < u128::from(limit.value) * percent
		})
	}
}

#[cfg(test)]
mod tests {
	use std::time;

	use super::*;

	#[test]
	fn reserve_preflight_uses_only_current_known_remaining_fraction() {
		let now = SystemTime::UNIX_EPOCH + time::Duration::from_secs(100);
		let mut quota = QuotaState::default();
		quota.apply(QuotaObservation {
			window:      QuotaWindowId::new("monthly"),
			consumed:    Some(91),
			remaining:   Some(9),
			limit:       Some(100),
			reset_at:    Some(now + time::Duration::from_secs(60)),
			exhausted:   Some(false),
			provenance:  QuotaProvenance::Provider,
			observed_at: now,
		});
		assert!(quota.below_remaining_percent(now, 10));
		assert!(!quota.below_remaining_percent(now, 9));
		assert!(!quota.below_remaining_percent(now + std::time::Duration::from_secs(61), 10));
	}
	#[test]
	fn scoped_spark_ranking_does_not_boost_a_secondary_only_report() {
		let now = SystemTime::UNIX_EPOCH + time::Duration::from_secs(100);
		let observation = |window: &'static str, remaining| QuotaObservation {
			window:      QuotaWindowId::new(window),
			consumed:    Some(100 - remaining),
			remaining:   Some(remaining),
			limit:       Some(100),
			reset_at:    Some(now + time::Duration::from_secs(300)),
			exhausted:   Some(false),
			provenance:  QuotaProvenance::Provider,
			observed_at: now,
		};
		let mut quota = QuotaState::default();
		quota.apply(observation("openai-codex:secondary", 80));
		quota.apply(observation("openai-codex:spark:secondary", 90));

		let incomplete = quota.minimum_remaining_scoped(now, Some("spark"));
		assert_eq!(
			incomplete,
			None,
			"secondary-only Spark ranking value={incomplete:?}, windows={:?}",
			quota
				.windows()
				.map(|(id, _)| id.as_str())
				.collect::<Vec<_>>()
		);
		let chat = quota.minimum_remaining_scoped(now, Some("chat"));
		assert_eq!(chat, Some(80), "legacy chat ranking value={chat:?}");

		quota.apply(observation("openai-codex:spark:primary", 20));
		let complete = quota.minimum_remaining_scoped(now, Some("spark"));
		assert_eq!(complete, Some(20), "complete Spark ranking value={complete:?}");
		let mut legacy = QuotaState::default();
		legacy.record_429(
			QuotaWindowId::new("openai-codex:primary"),
			Some(now + time::Duration::from_secs(60)),
			now,
		);
		let availability = legacy.availability_scoped(now, Some("spark"));
		assert_eq!(
			availability,
			QuotaAvailability::Exhausted { reset_at: now + time::Duration::from_secs(60) },
			"legacy shared availability={availability:?}"
		);
	}
}
