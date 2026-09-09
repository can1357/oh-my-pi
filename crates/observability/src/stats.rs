//! Provider usage-window and broker-fleet aggregation.

use std::{
	collections::{BTreeMap, BTreeSet, btree_map::Entry},
	fs, io,
	path::{Path, PathBuf},
};

use omp_core::Str;
use serde::Deserialize;
use thiserror::Error;
/// Explicit local-analytics consent. Derived counters are inert unless enabled.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LocalAnalyticsConsent {
	/// Do not ingest or aggregate user-derived facts.
	#[default]
	Disabled,
	/// Permit local, prompt-free derived counters.
	Enabled,
}

/// One durable Snapcompact savings fact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapcompactSavingsRecord {
	/// Observation time in epoch milliseconds.
	pub ts:           u64,
	/// Durable journal path identifying the source session.
	pub session:      Str,
	/// Serving provider.
	pub provider:     Str,
	/// Serving model.
	pub model:        Str,
	/// Tool call whose historical result was rasterized.
	pub tool_call_id: Str,
	/// Estimated tokens kept off the provider wire.
	pub saved_tokens: u64,
}

/// One UTC-day savings bucket.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SnapcompactDailySavings {
	/// UTC day start in epoch milliseconds.
	pub day_ms:       u64,
	/// Deduplicated token savings.
	pub saved_tokens: u64,
	/// Distinct `(session, tool-call)` savings facts.
	pub hits:         u64,
}

/// Aggregate Snapcompact savings and normalized project choices.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SnapcompactSavingsStats {
	/// Total token savings across selected facts.
	pub saved_tokens: u64,
	/// Deduplicated fact count.
	pub hits:         u64,
	/// Chronological UTC-day series, including no synthetic empty days.
	pub daily:        Vec<SnapcompactDailySavings>,
	/// Canonical logical project roots present in the facts.
	pub projects:     Vec<PathBuf>,
}

/// Savings journal read failure. Malformed individual lines are ignored.
#[derive(Debug, Error)]
pub enum SnapcompactStatsError {
	/// Journal I/O failed.
	#[error("failed to read Snapcompact savings journal")]
	Io(#[from] io::Error),
}

const DAY_MS: u64 = 24 * 60 * 60 * 1_000;

/// Reads append-only Snapcompact facts. A missing journal is an empty input.
pub fn read_snapcompact_savings(
	path: &Path,
) -> Result<Vec<SnapcompactSavingsRecord>, SnapcompactStatsError> {
	let text = match fs::read_to_string(path) {
		Ok(text) => text,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
		Err(error) => return Err(error.into()),
	};
	Ok(text
		.lines()
		.filter_map(|line| serde_json::from_str(line).ok())
		.collect())
}

/// Collapses conventional worktree paths to their logical project root.
///
/// Temporary/internal execution roots have no dashboard signal and return
/// `None`.
pub fn normalize_project_path(path: &Path) -> Option<PathBuf> {
	let clean = path.to_string_lossy().replace('\\', "/");
	let clean = clean.trim_end_matches('/');
	if clean.is_empty()
		|| clean == "/tmp"
		|| clean.starts_with("/tmp/")
		|| clean.starts_with("/var/folders/")
		|| clean.contains("/.omp/wt/")
		|| clean.contains("/omp-bash-exec/")
		|| clean.contains("/pi-bash-exec/")
	{
		return None;
	}
	for marker in ["/.wt/", "/.worktrees/", "-wt/", "-worktrees/", ".wt/"] {
		if let Some(index) = clean.find(marker) {
			let root = &clean[..index];
			if !root.is_empty() {
				return Some(PathBuf::from(root));
			}
		}
	}
	Some(PathBuf::from(clean))
}

/// Aggregates daily, deduplicated Snapcompact savings.
///
/// `projects_by_session` is sourced from durable session metadata. Raw prompt
/// text is neither accepted nor retained. Disabled consent produces an empty
/// result without inspecting facts.
pub fn aggregate_snapcompact_savings(
	consent: LocalAnalyticsConsent,
	records: &[SnapcompactSavingsRecord],
	projects_by_session: &BTreeMap<Str, PathBuf>,
	cutoff_ms: Option<u64>,
	selected_project: Option<&Path>,
) -> SnapcompactSavingsStats {
	if consent == LocalAnalyticsConsent::Disabled {
		return SnapcompactSavingsStats::default();
	}
	let selected_project = selected_project.and_then(normalize_project_path);
	let mut seen = BTreeSet::new();
	let mut buckets = BTreeMap::<u64, SnapcompactDailySavings>::new();
	let mut projects = BTreeSet::new();
	let mut stats = SnapcompactSavingsStats::default();
	for record in records {
		if record.saved_tokens == 0 || cutoff_ms.is_some_and(|cutoff| record.ts < cutoff) {
			continue;
		}
		let key = (record.session.clone(), record.tool_call_id.clone());
		if !seen.insert(key) {
			continue;
		}
		let project = projects_by_session
			.get(&record.session)
			.and_then(|path| normalize_project_path(path));
		if let Some(project) = &project {
			projects.insert(project.clone());
		}
		if let Some(selected) = &selected_project
			&& project
				.as_deref()
				.is_none_or(|project| !same_or_descendant(project, selected))
		{
			continue;
		}
		stats.saved_tokens = stats.saved_tokens.saturating_add(record.saved_tokens);
		stats.hits = stats.hits.saturating_add(1);
		let day_ms = record.ts / DAY_MS * DAY_MS;
		let bucket = buckets
			.entry(day_ms)
			.or_insert(SnapcompactDailySavings { day_ms, ..SnapcompactDailySavings::default() });
		bucket.saved_tokens = bucket.saved_tokens.saturating_add(record.saved_tokens);
		bucket.hits = bucket.hits.saturating_add(1);
	}
	stats.daily = buckets.into_values().collect();
	stats.projects = projects.into_iter().collect();
	stats
}

fn same_or_descendant(candidate: &Path, parent: &Path) -> bool {
	candidate == parent || candidate.starts_with(parent)
}

/// Token buckets reported for one provider by one broker client.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ClientProviderUsage {
	/// Provider identifier.
	pub provider:           Str,
	/// Non-cached input tokens.
	pub input_tokens:       u64,
	/// Output tokens.
	pub output_tokens:      u64,
	/// Cache-read input tokens.
	pub cache_read_tokens:  u64,
	/// Cache-write input tokens.
	pub cache_write_tokens: u64,
}

impl ClientProviderUsage {
	/// Returns the full token burn represented by all billable buckets.
	pub const fn total_tokens(&self) -> u64 {
		self
			.input_tokens
			.saturating_add(self.output_tokens)
			.saturating_add(self.cache_read_tokens)
			.saturating_add(self.cache_write_tokens)
	}
}

/// Per-provider usage reported by one client connected to the auth broker.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ClientUsageClientSummary {
	/// Provider token buckets observed by this client.
	pub providers: Vec<ClientProviderUsage>,
}

/// Sums broker client token burn by provider across the whole reporting fleet.
///
/// `None` means no client reported provider usage, allowing callers to fall
/// back to local telemetry rather than interpreting missing broker data as
/// zero burn.
pub fn sum_fleet_tokens(clients: &[ClientUsageClientSummary]) -> Option<BTreeMap<Str, u64>> {
	let mut totals = BTreeMap::new();
	for provider in clients.iter().flat_map(|client| &client.providers) {
		let total = totals.entry(provider.provider.clone()).or_insert(0_u64);
		*total = total.saturating_add(provider.total_tokens());
	}
	(!totals.is_empty()).then_some(totals)
}

/// One provider usage-window observation retained for stats aggregation.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindowSnapshot {
	/// Provider identifier.
	pub provider:      Str,
	/// Stable credential identity key.
	pub account_key:   Str,
	/// Stable provider-defined limit identifier.
	pub limit_id:      Str,
	/// Human-readable limit label.
	pub label:         Str,
	/// Human-readable duration or reset-window label.
	pub window_label:  Option<Str>,
	/// Used fraction at this observation, when reported.
	pub used_fraction: Option<f64>,
	/// Observation timestamp in epoch milliseconds.
	pub observed_at:   u64,
	/// Provider-authoritative reset timestamp in epoch milliseconds.
	pub resets_at:     Option<u64>,
	/// Explicit quota-exhaustion evidence.
	pub exhausted:     bool,
}
#[derive(Clone, Debug, PartialEq)]
/// Derived reset, exhaustion, and capacity signals for one provider usage
/// limit.
pub struct UsageWindowAnalytics {
	/// Number of reset cycles derived independently within each account.
	pub resets:             u64,
	/// Number of reset-cycle transitions into explicit quota exhaustion.
	pub exhaustion_count:   u64,
	/// Timestamped maximum used fraction for each bounded chronological bucket.
	pub peak_curve:         Vec<(u64, f64)>,
	/// Estimated provider tokens purchased by one full usage window.
	pub estimated_capacity: Option<u64>,
	/// Account count required to keep peak concurrent demand below 90%.
	pub ideal_accounts:     u64,
}

const RESET_DROP_THRESHOLD: f64 = 0.05;
const MIN_EXTRAPOLATION_FRACTION: f64 = 0.1;
const TARGET_PEAK_UTILIZATION: f64 = 0.9;

/// Derives bounded quota analytics from one stable limit's observations.
///
/// `provider_tokens` must cover the same observation interval as the snapshots.
pub fn analyze_usage_window(
	group: &UsageWindowGroup<'_>,
	provider_tokens: u64,
	curve_points: usize,
) -> UsageWindowAnalytics {
	let mut snapshots = group.snapshots.clone();
	snapshots.sort_by_key(|snapshot| snapshot.observed_at);

	let mut accounts = BTreeMap::<Str, Vec<&UsageWindowSnapshot>>::new();
	for snapshot in &snapshots {
		accounts
			.entry(snapshot.account_key.clone())
			.or_default()
			.push(snapshot);
	}

	let mut resets = 0_u64;
	let mut exhaustion_count = 0_u64;
	let mut fraction_consumed = 0.0_f64;
	for account in accounts.values_mut() {
		account.sort_by_key(|snapshot| snapshot.observed_at);
		let mut previous_fraction = None;
		let mut previous_reset = None;
		let mut previously_exhausted = false;
		for snapshot in account {
			let reset_timestamp_changed = matches!((previous_reset, snapshot.resets_at), (Some(previous), Some(current)) if previous != current);
			let mut fraction_reset = false;
			if let Some(fraction) = snapshot.used_fraction.filter(|value| value.is_finite()) {
				if let Some(previous) = previous_fraction {
					let delta = fraction - previous;
					if delta > 0.0 {
						fraction_consumed += delta;
					} else if delta < -RESET_DROP_THRESHOLD {
						fraction_reset = true;
					}
				}
				previous_fraction = Some(fraction);
			}
			let reset = reset_timestamp_changed || fraction_reset;
			if reset {
				resets = resets.saturating_add(1);
			}
			if snapshot.exhausted && (!previously_exhausted || reset) {
				exhaustion_count = exhaustion_count.saturating_add(1);
			}
			previously_exhausted = snapshot.exhausted;
			previous_reset = snapshot.resets_at.or(previous_reset);
		}
	}

	let points = curve_points.max(1);
	let bucket = snapshots.len().div_ceil(points).max(1);
	let peak_curve = snapshots
		.chunks(bucket)
		.filter_map(|chunk| {
			let peak = chunk
				.iter()
				.filter_map(|snapshot| snapshot.used_fraction)
				.filter(|fraction| fraction.is_finite())
				.reduce(f64::max)?;
			Some((chunk.last()?.observed_at, peak))
		})
		.collect();

	let mut events = snapshots
		.iter()
		.filter_map(|snapshot| {
			snapshot
				.used_fraction
				.filter(|fraction| fraction.is_finite())
				.map(|fraction| (snapshot.observed_at, snapshot.account_key.clone(), fraction))
		})
		.collect::<Vec<_>>();
	events.sort_by_key(|event| event.0);
	let mut current = BTreeMap::<Str, f64>::new();
	let mut concurrent = 0.0_f64;
	let mut peak = 0.0_f64;
	for (_, account, fraction) in events {
		concurrent += fraction - current.insert(account, fraction).unwrap_or_default();
		peak = peak.max(concurrent);
	}

	let estimated_capacity = (provider_tokens > 0
		&& fraction_consumed >= MIN_EXTRAPOLATION_FRACTION)
		.then(|| (provider_tokens as f64 / fraction_consumed).round() as u64);
	let ideal_accounts = ((peak / TARGET_PEAK_UTILIZATION).ceil() as u64).max(1);
	UsageWindowAnalytics { resets, exhaustion_count, peak_curve, estimated_capacity, ideal_accounts }
}

/// Stable grouping key for one provider-defined usage limit.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct UsageWindowKey {
	/// Provider identifier.
	pub provider: Str,
	/// Stable provider-defined limit identifier.
	pub limit_id: Str,
}

/// Observations belonging to one provider-defined usage limit.
#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindowGroup<'a> {
	/// Stable provider and limit identity.
	pub key:       UsageWindowKey,
	/// Latest display label observed for the limit.
	pub label:     Str,
	/// Observations in input order.
	pub snapshots: Vec<&'a UsageWindowSnapshot>,
}

/// Groups usage observations by `(provider, limit_id)` in stable key order.
///
/// Duration labels are presentation metadata and deliberately never enter the
/// key: two distinct provider limits may share the same daily or weekly label.
pub fn group_usage_windows_by_limit_id(
	snapshots: &[UsageWindowSnapshot],
) -> Vec<UsageWindowGroup<'_>> {
	let mut groups = BTreeMap::<UsageWindowKey, (Str, Vec<&UsageWindowSnapshot>)>::new();
	for snapshot in snapshots {
		let key = UsageWindowKey {
			provider: snapshot.provider.clone(),
			limit_id: snapshot.limit_id.clone(),
		};
		let label = display_label(snapshot);
		match groups.entry(key) {
			Entry::Vacant(entry) => {
				entry.insert((label, vec![snapshot]));
			},
			Entry::Occupied(mut entry) => {
				let (current_label, group_snapshots) = entry.get_mut();
				*current_label = label;
				group_snapshots.push(snapshot);
			},
		}
	}
	groups
		.into_iter()
		.map(|(key, (label, snapshots))| UsageWindowGroup { key, label, snapshots })
		.collect()
}

fn display_label(snapshot: &UsageWindowSnapshot) -> Str {
	let Some(window) = snapshot.window_label.as_deref() else {
		return snapshot.label.clone();
	};
	if contains_ascii_case_insensitive(snapshot.label.as_str(), window) {
		return snapshot.label.clone();
	}
	Str::from(format!("{} · {window}", snapshot.label))
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
	needle.is_empty()
		|| haystack
			.as_bytes()
			.windows(needle.len())
			.any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn provider(provider: &str, buckets: [u64; 4]) -> ClientProviderUsage {
		ClientProviderUsage {
			provider:           provider.into(),
			input_tokens:       buckets[0],
			output_tokens:      buckets[1],
			cache_read_tokens:  buckets[2],
			cache_write_tokens: buckets[3],
		}
	}

	#[test]
	fn sums_every_token_bucket_across_broker_clients() {
		let clients = [
			ClientUsageClientSummary {
				providers: vec![provider("anthropic", [10, 2, 3, 4]), provider("openai", [7, 1, 0, 0])],
			},
			ClientUsageClientSummary { providers: vec![provider("anthropic", [20, 5, 6, 7])] },
		];
		let totals = sum_fleet_tokens(&clients).expect("fleet usage");
		assert_eq!(totals.get("anthropic"), Some(&57));
		assert_eq!(totals.get("openai"), Some(&8));
		assert_eq!(sum_fleet_tokens(&[]), None);
	}

	#[test]
	fn distinct_limit_ids_never_merge_when_duration_labels_match() {
		let snapshots = [
			UsageWindowSnapshot {
				provider:      "anthropic".into(),
				account_key:   "account-a".into(),
				limit_id:      "anthropic:7d".into(),
				label:         "Claude 7 Day".into(),
				window_label:  Some("7 Day".into()),
				used_fraction: Some(0.2),
				observed_at:   0,
				resets_at:     None,
				exhausted:     false,
			},
			UsageWindowSnapshot {
				provider:      "anthropic".into(),
				account_key:   "account-a".into(),
				limit_id:      "anthropic:7d:fable".into(),
				label:         "Claude 7 Day (Fable)".into(),
				window_label:  Some("7 Day".into()),
				used_fraction: Some(0.6),
				observed_at:   0,
				resets_at:     None,
				exhausted:     false,
			},
		];
		let groups = group_usage_windows_by_limit_id(&snapshots);
		assert_eq!(groups.len(), 2);
		assert_eq!(groups[0].key.limit_id.as_str(), "anthropic:7d");
		assert_eq!(groups[1].key.limit_id.as_str(), "anthropic:7d:fable");
		assert_eq!(groups[0].snapshots.len(), 1);
		assert_eq!(groups[1].snapshots.len(), 1);
	}

	fn snapshot(account: &str, observed_at: u64, used_fraction: f64) -> UsageWindowSnapshot {
		UsageWindowSnapshot {
			provider: "anthropic".into(),
			account_key: account.into(),
			limit_id: "weekly".into(),
			label: "Weekly".into(),
			window_label: None,
			used_fraction: Some(used_fraction),
			observed_at,
			resets_at: None,
			exhausted: false,
		}
	}

	#[test]
	fn account_resets_ignore_jitter_and_capacity_tracks_consumed_demand() {
		let mut snapshots = vec![
			snapshot("account-a", 0, 0.20),
			snapshot("account-b", 1, 0.80),
			snapshot("account-a", 2, 0.18),
			snapshot("account-b", 3, 0.10),
			snapshot("account-a", 4, 0.38),
		];
		snapshots[1].exhausted = true;
		snapshots[3].exhausted = true;
		let group = group_usage_windows_by_limit_id(&snapshots).remove(0);
		let analytics = analyze_usage_window(&group, 2_000, 100);
		assert_eq!(analytics.resets, 1);
		assert_eq!(analytics.exhaustion_count, 2);
		assert_eq!(analytics.estimated_capacity, Some(10_000));
		assert_eq!(analytics.ideal_accounts, 2);
	}

	#[test]
	fn capacity_requires_meaningful_consumption_and_account_switch_is_not_reset() {
		let snapshots = vec![
			snapshot("account-a", 0, 0.90),
			snapshot("account-b", 1, 0.01),
			snapshot("account-a", 2, 0.95),
		];
		let group = group_usage_windows_by_limit_id(&snapshots).remove(0);
		let analytics = analyze_usage_window(&group, 1_000, 100);
		assert_eq!(analytics.resets, 0);
		assert_eq!(analytics.estimated_capacity, None);
		assert_eq!(analytics.ideal_accounts, 2);
	}
}
