//! Codex quota-reset celebration detector.
//!
//! The host keeps the previous [`QuotaSnapshot`] of the active Codex
//! account between usage refreshes and compares it with the next one; a
//! detected [`CodexResetEvent`] opens the fireworks panel
//! ([`crate::overlays::fireworks`]).

use std::time::{Duration, SystemTime};

use omp_ai::{UsageQuantity, UsageReport, UsageWindow};
use omp_core::Str;

/// Weekly usage, its quota identity, and its scheduled reset deadline.
#[derive(Clone, Debug, PartialEq)]
pub struct SevenDay {
	/// Percent of the weekly quota consumed.
	pub percent:   f64,
	/// Provider-scheduled reset deadline of this window.
	pub resets_at: Option<SystemTime>,
	/// Quota tier the window belongs to (a model-specific slug such as
	/// `spark`); `None` for the shared account window.
	pub tier:      Option<Str>,
	/// Account plan (`plus`, `pro`, …).
	pub plan:      Option<Str>,
}

/// The active Codex account fields retained between status refreshes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QuotaSnapshot {
	/// When this usage report was observed, if supplied by the provider.
	pub observed_at:  Option<SystemTime>,
	/// Weekly usage window.
	pub seven_day:    Option<SevenDay>,
	/// Saved rate-limit resets available to the account.
	pub saved_resets: Option<u32>,
}

/// A detected Codex quota event that can trigger the fireworks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodexResetEvent {
	/// The provider cleared weekly usage before the scheduled deadline.
	UnscheduledWeeklyReset,
	/// The account banked new saved resets.
	SavedResetBanked {
		/// Resets added since the previous report.
		added:     u32,
		/// Resets available now.
		available: u32,
	},
}

/// Compares consecutive reports for one Codex account.
///
/// A saved-reset grant takes precedence when both changes arrive in the
/// same report. A verified decrease, or a prior positive balance becoming
/// unavailable, suppresses the weekly event because the user may have
/// redeemed a credit. Other weekly usage drops are celebrated only when the
/// provider advances the quota deadline before the previously scheduled
/// reset.
#[must_use]
pub fn detect_codex_reset(
	previous: &QuotaSnapshot,
	current: &QuotaSnapshot,
) -> Option<CodexResetEvent> {
	if let Some(previous_saved) = previous.saved_resets {
		match current.saved_resets {
			None => {
				if previous_saved > 0 {
					return None;
				}
			},
			Some(current_saved) => {
				if current_saved > previous_saved {
					return Some(CodexResetEvent::SavedResetBanked {
						added:     current_saved - previous_saved,
						available: current_saved,
					});
				}
				if current_saved < previous_saved {
					return None;
				}
			},
		}
	}

	let (Some(previous_week), Some(current_week)) = (&previous.seven_day, &current.seven_day) else {
		return None;
	};
	if previous_week.tier != current_week.tier || previous_week.plan != current_week.plan {
		return None;
	}
	let previous_percent = rounded_percent(previous_week.percent);
	let current_percent = rounded_percent(current_week.percent);
	if previous_percent == 0 || current_percent >= previous_percent {
		return None;
	}

	let scheduled = previous_week.resets_at?;
	let next = current_week.resets_at?;
	let observed = current.observed_at?;
	if next <= scheduled || observed >= scheduled {
		return None;
	}
	Some(CodexResetEvent::UnscheduledWeeklyReset)
}

/// `Math.round(Math.max(0, Math.min(100, percent)))`; a NaN percent
/// clamps to zero like JavaScript's `Math.max(0, NaN)` chain rounds to
/// `NaN`, which never equals another percent — treated here as no usage.
fn rounded_percent(percent: f64) -> u8 {
	if percent.is_nan() {
		return 0;
	}
	percent.clamp(0.0, 100.0).round() as u8
}

/// Seconds in the Codex weekly window; a window is weekly when its rounded
/// day count is seven.
const DAY: Duration = Duration::from_secs(86_400);

/// Whether a usage window is the account's weekly quota: a rolling duration
/// that rounds to seven days.
fn is_seven_day(window: &UsageWindow) -> bool {
	window.duration.is_some_and(|duration| {
		duration >= DAY && (duration.as_secs_f64() / DAY.as_secs_f64()).round() == 7.0
	})
}

fn quantity_percent(quantity: UsageQuantity) -> f64 {
	quantity.units as f64 / 10_f64.powi(i32::from(quantity.decimal_exponent))
}

/// Builds the retained snapshot from an `openai-codex` usage report.
///
/// The weekly window is the shared `7d` window when the provider reports
/// one, else the first tiered `7d` window; `tier` is the window's scope
/// slug (`None` for the shared bucket). Returns `None` for reports of other
/// providers, or without a weekly window and saved-reset count.
#[must_use]
pub fn snapshot_from_report(report: &UsageReport) -> Option<QuotaSnapshot> {
	if report.provider.as_str() != "openai-codex" {
		return None;
	}
	let mut seven_day: Option<SevenDay> = None;
	let mut observed_at = None;
	for window in report.windows.iter().filter(|window| is_seven_day(window)) {
		let Some(consumed) = window.amount.consumed else {
			continue;
		};
		let tier = window
			.scope
			.as_ref()
			.filter(|scope| scope.as_str() != "shared")
			.cloned();
		if seven_day
			.as_ref()
			.is_some_and(|week| week.tier.is_none() || tier.is_some())
		{
			continue;
		}
		seven_day = Some(SevenDay {
			percent: quantity_percent(consumed),
			resets_at: window.resets_at,
			tier,
			plan: report.plan.clone(),
		});
		observed_at = Some(window.observed_at);
	}
	let observed_at =
		observed_at.or_else(|| report.windows.first().map(|window| window.observed_at));
	let saved_resets = report
		.reset_credits
		.as_ref()
		.map(|credits| u32::try_from(credits.available).unwrap_or(u32::MAX));
	if seven_day.is_none() && saved_resets.is_none() {
		return None;
	}
	Some(QuotaSnapshot { observed_at, seven_day, saved_resets })
}

omp_con::var! {
	/// Celebrate unscheduled Codex weekly usage resets and newly banked saved
	/// resets with a top-third fireworks overlay that remains until Escape.
	pub static CL_CODEX_FIREWORKS = cl_codex_fireworks: bool {
		default: true,
		flags: archive | session,
		meta: {
			"ui.tab": "appearance",
			"ui.group": "Display",
			"ui.label": "Codex Reset Fireworks",
			"legacy.path": "tui.codexResetFireworks",
		},
	};
}

/// Builds the retained snapshot from the host's flattened quota card for
/// the active `openai-codex` account: the weekly window's fraction becomes
/// the percent, its countdown anchors on the report's check time, and the
/// check time is the observation instant. Saved resets, tier, and plan do
/// not survive the flattening, so only the weekly-reset event can fire from
/// this seam.
#[must_use]
pub fn snapshot_from_account(
	account: &crate::overlays::services::UsageAccount,
	checked_at_ms: Option<u64>,
) -> Option<QuotaSnapshot> {
	if account.provider.as_str() != "openai-codex" {
		return None;
	}
	let observed_at = checked_at_ms.map(|ms| SystemTime::UNIX_EPOCH + Duration::from_millis(ms));
	let week = account
		.windows
		.iter()
		.find(|window| matches!(window.label.as_str(), "7d" | "weekly" | "week"))?;
	Some(QuotaSnapshot {
		observed_at,
		seven_day: Some(SevenDay {
			percent:   week.fraction * 100.0,
			resets_at: match (observed_at, week.resets_in) {
				(Some(observed), Some(resets_in)) => Some(observed + resets_in),
				_ => None,
			},
			tier:      None,
			plan:      None,
		}),
		saved_resets: None,
	})
}

/// Periodic quota refresh for the active Codex account. At most one fetch
/// runs per five minutes; consecutive snapshots are compared.
#[derive(Default)]
pub struct QuotaWatch {
	fetched_at:  Option<Duration>,
	pending:     Option<crate::overlays::services::Pending<crate::overlays::services::UsageReport>>,
	previous:    Option<QuotaSnapshot>,
	/// Whether the service reported usage unavailable; no retries then.
	unavailable: bool,
}

impl QuotaWatch {
	/// Skips refreshes for five minutes after a fetch starts or settles.
	pub const REFRESH: Duration = Duration::from_secs(5 * 60);
	/// Poll cadence while a fetch is in flight.
	const SETTLE_POLL: Duration = Duration::from_millis(500);

	/// Advances the watch at `now`: starts a fetch when one is due for an
	/// `openai-codex` session, settles an in-flight one, and returns the
	/// celebration event a settled report triggers.
	pub fn poll(
		&mut self,
		services: &dyn crate::overlays::Services,
		provider: &str,
		now: Duration,
	) -> Option<CodexResetEvent> {
		if provider != "openai-codex" || self.unavailable {
			return None;
		}
		if let Some(pending) = &self.pending {
			let report = match pending.try_recv() {
				Ok(Ok(report)) => report,
				Ok(Err(_)) | Err(flume::TryRecvError::Disconnected) => {
					self.pending = None;
					return None;
				},
				Err(flume::TryRecvError::Empty) => return None,
			};
			self.pending = None;
			let current = report
				.accounts
				.iter()
				.find_map(|account| snapshot_from_account(account, report.checked_at_ms))?;
			let previous = self.previous.replace(current.clone());
			return detect_codex_reset(previous.as_ref()?, &current);
		}
		let due = self
			.fetched_at
			.is_none_or(|fetched| now.saturating_sub(fetched) >= Self::REFRESH);
		if !due {
			return None;
		}
		self.fetched_at = Some(now);
		match services.usage() {
			Ok(pending) => self.pending = Some(pending),
			Err(crate::overlays::services::ServiceError::Unavailable(_)) => self.unavailable = true,
			Err(_) => {},
		}
		None
	}

	/// Presentation-clock instant the watch next needs a poll.
	#[must_use]
	pub fn next_wake(&self, now: Duration, provider: &str) -> Option<Duration> {
		if provider != "openai-codex" || self.unavailable {
			return None;
		}
		if self.pending.is_some() {
			return Some(now + Self::SETTLE_POLL);
		}
		Some(
			self
				.fetched_at
				.map_or(now, |fetched| fetched + Self::REFRESH),
		)
	}
}

#[cfg(test)]
mod tests {
	use std::time::{Duration, SystemTime};

	use omp_ai::{
		AccountId, ProviderId, UsageAccountMetadata, UsageAmount, UsageQuantity, UsageReport,
		UsageResetCredits, UsageSource, UsageStatus, UsageUnit, UsageWindow, UsageWindowKind,
	};
	use omp_core::sf;

	use super::{
		CodexResetEvent, QuotaSnapshot, SevenDay, detect_codex_reset, snapshot_from_report,
	};

	fn at(millis: u64) -> SystemTime {
		SystemTime::UNIX_EPOCH + Duration::from_millis(millis)
	}

	fn week(percent: f64, resets_at: Option<u64>) -> SevenDay {
		SevenDay { percent, resets_at: resets_at.map(at), tier: None, plan: None }
	}

	fn snapshot(observed: Option<u64>, week: Option<SevenDay>, saved: Option<u32>) -> QuotaSnapshot {
		QuotaSnapshot { observed_at: observed.map(at), seven_day: week, saved_resets: saved }
	}

	#[test]
	fn detects_an_unscheduled_weekly_reset_and_prioritizes_newly_banked_resets() {
		let previous = snapshot(Some(1_000), Some(week(42.0, Some(10_000))), Some(0));
		assert_eq!(
			detect_codex_reset(
				&previous,
				&snapshot(Some(2_000), Some(week(2.0, Some(20_000))), Some(0)),
			),
			Some(CodexResetEvent::UnscheduledWeeklyReset)
		);
		assert_eq!(
			detect_codex_reset(
				&previous,
				&snapshot(Some(2_000), Some(week(0.0, Some(20_000))), Some(2)),
			),
			Some(CodexResetEvent::SavedResetBanked { added: 2, available: 2 })
		);
	}

	#[test]
	fn suppresses_an_early_weekly_drop_when_a_saved_reset_was_redeemed() {
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, Some(10_000))), Some(1)),
				&snapshot(Some(2_000), Some(week(0.0, Some(10_000))), Some(0)),
			),
			None
		);
		// A prior positive balance becoming unavailable also suppresses.
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, Some(10_000))), Some(1)),
				&snapshot(Some(2_000), Some(week(0.0, Some(20_000))), None),
			),
			None
		);
		// A prior zero balance becoming unavailable does not.
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, Some(10_000))), Some(0)),
				&snapshot(Some(2_000), Some(week(0.0, Some(20_000))), None),
			),
			Some(CodexResetEvent::UnscheduledWeeklyReset)
		);
	}

	#[test]
	fn suppresses_a_weekly_decrease_when_the_quota_deadline_did_not_advance() {
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, Some(10_000))), Some(0)),
				&snapshot(Some(2_000), Some(week(41.0, Some(10_000))), Some(0)),
			),
			None
		);
	}

	#[test]
	fn suppresses_a_weekly_transition_observed_at_its_scheduled_reset_deadline() {
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, Some(2_000))), None),
				&snapshot(Some(2_000), Some(week(0.0, Some(10_000))), None),
			),
			None
		);
	}

	#[test]
	fn requires_the_prior_weekly_reset_deadline_to_establish_that_a_reset_was_unscheduled() {
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, None)), None),
				&snapshot(Some(2_000), Some(week(0.0, None)), None),
			),
			None
		);
	}

	#[test]
	fn requires_the_provider_fetch_timestamp_to_establish_that_a_reset_was_early() {
		assert_eq!(
			detect_codex_reset(
				&snapshot(Some(1_000), Some(week(42.0, Some(10_000))), None),
				&snapshot(None, Some(week(0.0, Some(10_000))), None),
			),
			None
		);
	}

	#[test]
	fn suppresses_tier_or_plan_changes_and_rounds_percentages() {
		let mut previous = snapshot(Some(1_000), Some(week(42.0, Some(10_000))), None);
		let mut current = snapshot(Some(2_000), Some(week(0.0, Some(20_000))), None);
		current.seven_day.as_mut().unwrap().tier = Some(sf!("spark"));
		assert_eq!(detect_codex_reset(&previous, &current), None, "tier change");
		current.seven_day.as_mut().unwrap().tier = None;
		current.seven_day.as_mut().unwrap().plan = Some(sf!("pro"));
		assert_eq!(detect_codex_reset(&previous, &current), None, "plan change");
		previous.seven_day.as_mut().unwrap().plan = Some(sf!("pro"));
		assert_eq!(
			detect_codex_reset(&previous, &current),
			Some(CodexResetEvent::UnscheduledWeeklyReset)
		);
		// 0.4% rounds to zero: no prior usage to have been reset.
		previous.seven_day.as_mut().unwrap().percent = 0.4;
		assert_eq!(detect_codex_reset(&previous, &current), None, "rounded zero");
		// Rounding equalizes 42.4 and 41.6, so nothing dropped.
		previous.seven_day.as_mut().unwrap().percent = 42.4;
		current.seven_day.as_mut().unwrap().percent = 41.6;
		assert_eq!(detect_codex_reset(&previous, &current), None, "rounded equal");
		// Out-of-range values clamp before rounding.
		previous.seven_day.as_mut().unwrap().percent = 250.0;
		current.seven_day.as_mut().unwrap().percent = -5.0;
		assert_eq!(
			detect_codex_reset(&previous, &current),
			Some(CodexResetEvent::UnscheduledWeeklyReset),
			"clamped"
		);
	}

	fn window(id: &str, scope: &str, secs: u64, used: u64, resets_at: u64) -> UsageWindow {
		UsageWindow {
			id:          sf!("{id}"),
			kind:        UsageWindowKind::RateLimit,
			dimension:   sf!("percent"),
			label:       None,
			scope:       Some(sf!("{scope}")),
			amount:      UsageAmount {
				unit:      UsageUnit::Percent,
				consumed:  Some(UsageQuantity::new(used, 1)),
				remaining: None,
				limit:     Some(UsageQuantity::new(100, 0)),
			},
			status:      Some(UsageStatus::Ok),
			duration:    Some(Duration::from_secs(secs)),
			resets_at:   Some(at(resets_at)),
			reset_label: None,
			notes:       Box::default(),
			source:      UsageSource::Provider,
			observed_at: at(5_000),
		}
	}

	fn usage_report(provider: &str, windows: Vec<UsageWindow>, credits: Option<u64>) -> UsageReport {
		UsageReport {
			provider: ProviderId::from(provider),
			account: AccountId::from("acct"),
			principal: None,
			plan: Some(sf!("pro")),
			account_meta: UsageAccountMetadata::default(),
			source_label: None,
			notes: Box::default(),
			reset_credits: credits
				.map(|available| UsageResetCredits { available, credits: Box::default() }),
			windows,
		}
	}

	#[test]
	fn snapshot_prefers_the_shared_weekly_window_and_maps_credits() {
		let report = usage_report(
			"openai-codex",
			vec![
				window("openai-codex:primary", "shared", 18_000, 40, 6_000),
				window("openai-codex:spark:secondary", "spark", 604_800, 990, 7_000),
				window("openai-codex:secondary", "shared", 604_800, 425, 8_000),
			],
			Some(3),
		);
		let snapshot = snapshot_from_report(&report).expect("codex snapshot");
		let week = snapshot.seven_day.expect("weekly window");
		assert_eq!(week.percent, 42.5);
		assert_eq!(week.resets_at, Some(at(8_000)));
		assert_eq!(week.tier, None);
		assert_eq!(week.plan.as_deref(), Some("pro"));
		assert_eq!(snapshot.observed_at, Some(at(5_000)));
		assert_eq!(snapshot.saved_resets, Some(3));

		let tiered = usage_report(
			"openai-codex",
			vec![window("openai-codex:spark:secondary", "spark", 604_800, 10, 7_000)],
			None,
		);
		let week = snapshot_from_report(&tiered)
			.and_then(|snapshot| snapshot.seven_day)
			.expect("tiered weekly window");
		assert_eq!(week.tier.as_deref(), Some("spark"));

		assert_eq!(snapshot_from_report(&usage_report("anthropic", Vec::new(), Some(1))), None);
		assert_eq!(
			snapshot_from_report(&usage_report(
				"openai-codex",
				vec![window("openai-codex:primary", "shared", 18_000, 40, 6_000)],
				None,
			)),
			None,
			"no weekly window and no credits"
		);
	}
}
