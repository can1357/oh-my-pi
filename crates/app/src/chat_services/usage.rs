//! `/usage` feed: durable quota windows plus one fresh refresh per stored
//! account (the same sources as `omp usage`), collapsed into one card per
//! provider for the dashboard and rendered as the classic per-account
//! detail report.

use std::{
	collections::BTreeMap,
	fmt::Write as _,
	fs,
	path::Path,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_ai::{
	account::AccountRecord,
	answer::{
		UsageQuantity, UsageReport as ProviderUsageReport, UsageUnit,
		UsageWindow as ProviderUsageWindow,
	},
};
use omp_catalog::{ModelKey, ProviderId, RouteId, snapshot::Catalog};
use omp_chat::{
	overlays::services::{
		AccountIdentity, ActiveAccountUsage, ActiveUsageRequest, Pending, ResetAccountRow,
		ServiceError, ServiceResult, UsageAccount, UsageReport, UsageStatus, UsageWindow,
	},
	status_band::UsageWindow as StatusUsageWindow,
};
use omp_core::Str;
use serde_json::Value;

use super::ServiceState;
use crate::usage_cmd::{self, QuotaSnapshot};

/// Fraction at or above which a window is exhausted.
const EXHAUSTED: f64 = 1.0;
/// Fraction at or above which a window warns.
const WARNING: f64 = 0.8;
/// Fraction at or below which a window is untouched.
const IDLE: f64 = 0.005;
const NO_ACTIVITY: &str = "Usage history unavailable (this host keeps no per-day cost telemetry).";

/// Starts the quota fetch on the runtime; the receiver settles with the
/// dashboard report.
pub fn fetch(state: &ServiceState) -> ServiceResult<Pending<UsageReport>> {
	let (tx, rx) = flume::bounded(1);
	let data_dir = state.data_dir.clone();
	let catalog = state.catalog.clone();
	state.runtime.spawn(async move {
		let result = build(&data_dir, catalog.as_deref()).await;
		let _ = tx.send(result);
	});
	Ok(rx)
}

/// Starts one exact active-account status usage fetch on the application
/// runtime. Route and account selection are memory-only; credential and
/// provider work begins only after the pending receiver has been returned.
pub fn active_account(
	state: &ServiceState,
	request: ActiveUsageRequest,
) -> ServiceResult<Pending<Option<ActiveAccountUsage>>> {
	let stack = state
		.stack
		.as_ref()
		.ok_or(ServiceError::Unavailable("active account usage (remote gateway)"))?;
	let catalog = state
		.catalog
		.as_deref()
		.ok_or(ServiceError::Unavailable("provider catalog (remote gateway)"))?;
	let provider = ProviderId::from(request.provider.as_str());
	let Some(route) = active_route(catalog, &provider, request.model.as_str()) else {
		return Ok(ready_active(Ok(None)));
	};
	let Some(account) = stack
		.auth_control
		.accounts(Some(&provider))
		.into_iter()
		.find(|record| record.enabled && record.routes.contains(&route))
	else {
		return Ok(ready_active(Ok(None)));
	};

	let data_dir = state.data_dir.clone();
	let (tx, rx) = flume::bounded(1);
	state.runtime.spawn(async move {
		let result = fetch_active(data_dir.as_path(), request, provider, account).await;
		let _ = tx.send(result);
	});
	Ok(rx)
}

fn ready_active(
	result: ServiceResult<Option<ActiveAccountUsage>>,
) -> Pending<Option<ActiveAccountUsage>> {
	let (tx, rx) = flume::bounded(1);
	let _ = tx.send(result);
	rx
}

fn active_route(catalog: &Catalog, provider: &ProviderId<str>, model: &str) -> Option<RouteId> {
	let unqualified = model
		.strip_prefix(provider.as_str())
		.and_then(|suffix| suffix.strip_prefix('/'))
		.unwrap_or(model);
	let spec = catalog
		.model_for_provider(provider, ModelKey::from_ref(unqualified))
		.or_else(|| catalog.model_for_provider(provider, ModelKey::from_ref(model)))
		.or_else(|| catalog.resolve_alias(unqualified))
		.or_else(|| catalog.resolve_alias(model))?;
	spec
		.routes
		.iter()
		.find(|route| {
			catalog
				.route(route)
				.is_some_and(|definition| &definition.provider == provider)
		})
		.cloned()
}

async fn fetch_active(
	data_dir: &Path,
	request: ActiveUsageRequest,
	provider: ProviderId,
	account: AccountRecord,
) -> ServiceResult<Option<ActiveAccountUsage>> {
	let quota = usage_cmd::collect_quota(data_dir, Some(&provider), Some(&account.account))
		.await
		.map_err(ServiceError::failed)?;
	if let Some(report) = quota
		.reports
		.into_iter()
		.find(|report| report.provider == provider && report.account == account.account)
	{
		return Ok(Some(snapshot_from_report(request, &account, report)));
	}
	if let Some(snapshot) = snapshot_from_rows(request, &account, &quota.rows) {
		return Ok(Some(snapshot));
	}
	if quota.refresh_errors.is_empty() {
		Ok(None)
	} else {
		Err(ServiceError::Failed(Str::new(quota.refresh_errors.join("; "))))
	}
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum WindowClass {
	FiveHour,
	Daily,
	SevenDay,
	Monthly,
}

struct DisplayCandidate {
	id:          Str,
	class:       WindowClass,
	percent:     f64,
	reset_after: Option<Duration>,
}

struct UsageGroup {
	model:      Option<Str>,
	tier:       Option<Str>,
	priority:   u8,
	candidates: Vec<DisplayCandidate>,
}

#[derive(Default)]
struct NormalizedUsage {
	tier:      Option<Str>,
	five_hour: Option<StatusUsageWindow>,
	daily:     Option<StatusUsageWindow>,
	seven_day: Option<StatusUsageWindow>,
	monthly:   Option<StatusUsageWindow>,
}

fn snapshot_from_report(
	request: ActiveUsageRequest,
	account: &AccountRecord,
	report: ProviderUsageReport,
) -> ActiveAccountUsage {
	let normalized = normalize_windows(
		request.provider.as_str(),
		request.model.as_str(),
		report.plan.as_ref(),
		&report.windows,
	);
	ActiveAccountUsage {
		identity: AccountIdentity {
			provider:            request.provider.clone(),
			account:             account.account.as_inner().clone(),
			principal:           report
				.principal
				.map(|principal| principal.into_inner())
				.or_else(|| Some(account.principal.as_inner().clone())),
			provider_account_id: report.account_meta.provider_account_id,
			email:               report.account_meta.email,
			project_id:          report.account_meta.project_id.or_else(|| {
				account
					.routing
					.project
					.as_ref()
					.map(|id| id.as_inner().clone())
			}),
			organization_id:     report.account_meta.organization_id.or_else(|| {
				account
					.routing
					.organization
					.as_ref()
					.map(|id| id.as_inner().clone())
			}),
		},
		request,
		tier: normalized.tier,
		five_hour: normalized.five_hour,
		daily: normalized.daily,
		seven_day: normalized.seven_day,
		monthly: normalized.monthly,
	}
}

fn snapshot_from_rows(
	request: ActiveUsageRequest,
	account: &AccountRecord,
	rows: &[Value],
) -> Option<ActiveAccountUsage> {
	let now = SystemTime::now();
	let mut normalized = NormalizedUsage::default();
	let mut monthly_priority = u8::MAX;
	for row in rows {
		let id = row["window"].as_str().unwrap_or_default();
		let label = row["label"].as_str();
		let Some(class) = classify_window(request.provider.as_str(), id, label, None) else {
			continue;
		};
		let Some(percent) = fraction(row).filter(|value| value.is_finite()) else {
			continue;
		};
		let percent = percent * 100.0;
		let resets_at = row["resetAtMs"]
			.as_u64()
			.and_then(|millis| UNIX_EPOCH.checked_add(Duration::from_millis(millis)));
		let window = StatusUsageWindow { percent, reset_after: rounded_reset(resets_at, now, class) };
		set_window(&mut normalized, &mut monthly_priority, class, id, window);
	}
	if normalized.five_hour.is_none()
		&& normalized.daily.is_none()
		&& normalized.seven_day.is_none()
		&& normalized.monthly.is_none()
	{
		return None;
	}
	Some(ActiveAccountUsage {
		identity: AccountIdentity {
			provider:            request.provider.clone(),
			account:             account.account.as_inner().clone(),
			principal:           Some(account.principal.as_inner().clone()),
			provider_account_id: None,
			email:               None,
			project_id:          account
				.routing
				.project
				.as_ref()
				.map(|id| id.as_inner().clone()),
			organization_id:     account
				.routing
				.organization
				.as_ref()
				.map(|id| id.as_inner().clone()),
		},
		request,
		tier: normalized.tier,
		five_hour: normalized.five_hour,
		daily: normalized.daily,
		seven_day: normalized.seven_day,
		monthly: normalized.monthly,
	})
}

fn normalize_windows(
	provider: &str,
	active_model: &str,
	plan: Option<&Str>,
	windows: &[ProviderUsageWindow],
) -> NormalizedUsage {
	let now = SystemTime::now();
	let mut groups: Vec<UsageGroup> = Vec::new();
	for window in windows {
		let Some(class) =
			classify_window(provider, window.id.as_str(), window.label.as_deref(), window.duration)
		else {
			continue;
		};
		let Some(percent) = used_fraction(window).map(|fraction| fraction * 100.0) else {
			continue;
		};
		let Some((model, scoped_tier)) = window_scope(provider, active_model, window) else {
			continue;
		};
		let tier = scoped_tier.or_else(|| plan.cloned());
		let priority = if model.is_some() {
			u8::from(tier.is_some())
		} else if tier.is_some() {
			3
		} else {
			2
		};
		let candidate = DisplayCandidate {
			id: window.id.clone(),
			class,
			percent,
			reset_after: rounded_reset(window.resets_at, now, class),
		};
		if let Some(group) = groups
			.iter_mut()
			.find(|group| group.model == model && group.tier == tier)
		{
			group.candidates.push(candidate);
		} else {
			groups.push(UsageGroup { model, tier, priority, candidates: vec![candidate] });
		}
	}
	let Some(group) = groups.into_iter().min_by_key(|group| group.priority) else {
		return NormalizedUsage::default();
	};
	let mut normalized = NormalizedUsage { tier: group.tier, ..NormalizedUsage::default() };
	let mut monthly_priority = u8::MAX;
	for candidate in group.candidates {
		set_window(
			&mut normalized,
			&mut monthly_priority,
			candidate.class,
			candidate.id.as_str(),
			StatusUsageWindow { percent: candidate.percent, reset_after: candidate.reset_after },
		);
	}
	normalized
}

fn set_window(
	normalized: &mut NormalizedUsage,
	monthly_priority: &mut u8,
	class: WindowClass,
	id: &str,
	window: StatusUsageWindow,
) {
	match class {
		WindowClass::FiveHour if normalized.five_hour.is_none() => {
			normalized.five_hour = Some(window);
		},
		WindowClass::Daily if normalized.daily.is_none() => normalized.daily = Some(window),
		WindowClass::SevenDay if normalized.seven_day.is_none() => {
			normalized.seven_day = Some(window);
		},
		WindowClass::Monthly => {
			let priority = cursor_monthly_priority(id);
			if priority < *monthly_priority {
				normalized.monthly = Some(window);
				*monthly_priority = priority;
			}
		},
		WindowClass::FiveHour | WindowClass::Daily | WindowClass::SevenDay => {},
	}
}

fn classify_window(
	provider: &str,
	id: &str,
	label: Option<&str>,
	duration: Option<Duration>,
) -> Option<WindowClass> {
	let id = id.to_ascii_lowercase();
	let label = label.unwrap_or_default().to_ascii_lowercase();
	if has_window_token(&id, "5h")
		|| duration.is_some_and(|duration| duration_near(duration, Duration::from_secs(5 * 60 * 60)))
	{
		return Some(WindowClass::FiveHour);
	}
	if ["daily", "24h", "1d"]
		.into_iter()
		.any(|name| has_window_token(&id, name) || has_window_token(&label, name))
		|| duration.is_some_and(|duration| duration_near(duration, Duration::from_secs(24 * 60 * 60)))
	{
		return Some(WindowClass::Daily);
	}
	if has_window_token(&id, "7d")
		|| has_window_token(&label, "7d")
		|| duration
			.is_some_and(|duration| duration_near(duration, Duration::from_secs(7 * 24 * 60 * 60)))
	{
		return Some(WindowClass::SevenDay);
	}
	if matches!(provider, "cursor" | "opencode-go")
		&& ((provider == "cursor" && id.starts_with("cursor:usd:individual-"))
			|| has_window_token(&id, "monthly")
			|| has_window_token(&id, "30d")
			|| duration.is_some_and(|duration| {
				duration_near(duration, Duration::from_secs(30 * 24 * 60 * 60))
			})) {
		return Some(WindowClass::Monthly);
	}
	None
}

fn has_window_token(value: &str, token: &str) -> bool {
	value == token
		|| value
			.split(|character: char| !character.is_ascii_alphanumeric())
			.any(|part| part == token)
}

fn duration_near(actual: Duration, expected: Duration) -> bool {
	actual.abs_diff(expected) <= Duration::from_secs(60)
}

fn window_scope(
	provider: &str,
	active_model: &str,
	window: &ProviderUsageWindow,
) -> Option<(Option<Str>, Option<Str>)> {
	let active_model = active_model
		.strip_prefix(provider)
		.and_then(|suffix| suffix.strip_prefix('/'))
		.unwrap_or(active_model);
	let note_model = window
		.notes
		.iter()
		.find_map(|note| note.as_str().strip_prefix("model:"))
		.map(str::trim)
		.filter(|model| !model.is_empty());
	let scope = window
		.scope
		.as_deref()
		.map(str::trim)
		.filter(|scope| !scope.is_empty());
	let structured_model = scope.and_then(|scope| scope_field(scope, "model"));
	let structured_tier = scope.and_then(|scope| scope_field(scope, "tier"));
	let model = note_model.or(structured_model);
	if let Some(model) = model {
		if !same_model(model, active_model) {
			return None;
		}
		let tier = structured_tier
			.map(Str::new)
			.or_else(|| tier_scope(scope).map(Str::new));
		return Some((Some(Str::new(active_model)), tier));
	}
	let Some(scope) = scope else {
		return Some((None, None));
	};
	if matches!(scope, "shared" | "account" | "default") {
		return Some((None, None));
	}
	if same_model(scope, active_model) {
		return Some((Some(Str::new(active_model)), None));
	}
	if provider == "anthropic"
		&& active_model
			.to_ascii_lowercase()
			.contains(&scope.to_ascii_lowercase())
	{
		return Some((Some(Str::new(active_model)), Some(Str::new(scope))));
	}
	Some((None, Some(Str::new(scope))))
}

fn scope_field<'a>(scope: &'a str, key: &str) -> Option<&'a str> {
	scope
		.split(';')
		.find_map(|field| field.trim().strip_prefix(key)?.strip_prefix('='))
		.map(str::trim)
		.filter(|value| !value.is_empty())
}

fn tier_scope(scope: Option<&str>) -> Option<&str> {
	scope.filter(|scope| !matches!(*scope, "shared" | "account" | "default"))
}

fn same_model(candidate: &str, active: &str) -> bool {
	candidate.eq_ignore_ascii_case(active)
		|| candidate
			.rsplit_once('/')
			.is_some_and(|(_, tail)| tail.eq_ignore_ascii_case(active))
		|| active
			.rsplit_once('/')
			.is_some_and(|(_, tail)| candidate.eq_ignore_ascii_case(tail))
}

fn used_fraction(window: &ProviderUsageWindow) -> Option<f64> {
	let consumed = window.amount.consumed.map(quantity_value)?;
	let fraction = match window.amount.limit.map(quantity_value) {
		Some(limit) if limit > 0.0 => consumed / limit,
		_ => match window.amount.remaining.map(quantity_value) {
			Some(remaining) if consumed + remaining > 0.0 => consumed / (consumed + remaining),
			_ if window.amount.unit == UsageUnit::Percent => consumed / 100.0,
			_ => return None,
		},
	};
	(fraction.is_finite() && fraction >= 0.0).then_some(fraction)
}

fn quantity_value(quantity: UsageQuantity) -> f64 {
	quantity.units as f64 / 10_f64.powi(i32::from(quantity.decimal_exponent))
}

fn rounded_reset(
	resets_at: Option<SystemTime>,
	now: SystemTime,
	class: WindowClass,
) -> Option<Duration> {
	let remaining = resets_at?.duration_since(now).unwrap_or_default();
	let unit = match class {
		WindowClass::FiveHour | WindowClass::Daily => 60,
		WindowClass::SevenDay | WindowClass::Monthly => 60 * 60,
	};
	let rounded = remaining
		.as_secs()
		.saturating_add(unit / 2)
		.checked_div(unit)?
		.saturating_mul(unit);
	Some(Duration::from_secs(rounded))
}

fn cursor_monthly_priority(id: &str) -> u8 {
	match id {
		"cursor:usd:individual-auto" => 0,
		"cursor:usd:individual-plan" | "cursor:usd:individual-overall" => 1,
		id if id.starts_with("cursor:usd:individual-") => 2,
		_ => 3,
	}
}

/// Fetches selectable saved Codex-reset accounts for the retained modal.
pub fn reset_accounts(state: &ServiceState) -> ServiceResult<Pending<Vec<ResetAccountRow>>> {
	let (tx, rx) = flume::bounded(1);
	let data_dir = state.data_dir.clone();
	state.runtime.spawn(async move {
		let result =
			usage_cmd::collect_quota(&data_dir, Some(&ProviderId::from("openai-codex")), None)
				.await
				.map(|snapshot| {
					snapshot
						.reports
						.into_iter()
						.enumerate()
						.map(|(index, report)| {
							let label = report
								.account_meta
								.email
								.as_ref()
								.or(report.account_meta.provider_account_id.as_ref())
								.map_or_else(
									|| usage_cmd::mask(report.account.as_str()),
									ToString::to_string,
								);
							ResetAccountRow {
								target:    report.account.to_string().into(),
								label:     label.into(),
								available: report.reset_credits.as_ref().map_or(0, |credits| {
									u32::try_from(credits.available).unwrap_or(u32::MAX)
								}),
								active:    index == 0,
							}
						})
						.collect()
				})
				.map_err(ServiceError::failed);
		let _ = tx.send(result);
	});
	Ok(rx)
}

/// `/usage reset [account|active]`: lists or spends saved Codex resets.
/// The redemption is a short network call; the actor blocks on it the
/// same way `omp usage` does.
pub fn reset(state: &ServiceState, target: &str) -> ServiceResult<Str> {
	let data_dir = state.data_dir.clone();
	let target = target.to_owned();
	let runtime = state.runtime.clone();
	let on_worker = tokio::runtime::Handle::try_current()
		.is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
	let outcome = if on_worker {
		tokio::task::block_in_place(|| runtime.block_on(usage_cmd::reset_usage(&data_dir, &target)))
	} else {
		let (tx, rx) = flume::bounded(1);
		runtime.spawn(async move {
			let _ = tx.send(usage_cmd::reset_usage(&data_dir, &target).await);
		});
		rx.recv().map_err(|_| {
			ServiceError::Failed(Str::new_static("usage reset task ended without a result"))
		})?
	};
	outcome.map_err(ServiceError::failed)
}

async fn build(data_dir: &Path, catalog: Option<&Catalog>) -> ServiceResult<UsageReport> {
	fs::create_dir_all(data_dir).map_err(ServiceError::failed)?;
	let snapshot = usage_cmd::collect_quota(data_dir, None, None)
		.await
		.map_err(ServiceError::failed)?;
	let now_ms = unix_ms(SystemTime::now()).unwrap_or_default();
	Ok(UsageReport {
		checked_at_ms: Some(
			snapshot
				.rows
				.iter()
				.filter_map(|row| row["observedAtMs"].as_u64())
				.max()
				.unwrap_or(now_ms),
		),
		accounts:      cards(&snapshot, catalog, now_ms),
		activity:      Vec::new(),
		activity_note: Some(Str::new_static(NO_ACTIVITY)),
		detail:        detail(&snapshot),
	})
}

fn unix_ms(time: SystemTime) -> Option<u64> {
	time
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
}

fn fraction(row: &Value) -> Option<f64> {
	let consumed = row["consumed"].as_f64()?;
	let limit = row["limit"].as_f64()?;
	(limit > 0.0).then(|| (consumed / limit).max(0.0))
}

/// Window health from its consumed fraction.
fn status(fraction: Option<f64>) -> UsageStatus {
	match fraction {
		None => UsageStatus::Unknown,
		Some(value) if value >= EXHAUSTED => UsageStatus::Exhausted,
		Some(value) if value >= WARNING => UsageStatus::Warning,
		Some(value) if value <= IDLE => UsageStatus::Idle,
		Some(_) => UsageStatus::Ok,
	}
}

/// One provider's quota buckets while folding rows.
#[derive(Default)]
struct ProviderFold {
	accounts: Vec<Str>,
	/// Window id → (label, per-account observations).
	windows:  BTreeMap<Str, (Str, Vec<(Option<f64>, Option<u64>)>)>,
}

/// One card per provider: each window bucket shows the mean used fraction
/// across accounts with the most-used account's reset countdown.
fn cards(snapshot: &QuotaSnapshot, catalog: Option<&Catalog>, now_ms: u64) -> Vec<UsageAccount> {
	let mut folds: BTreeMap<Str, ProviderFold> = BTreeMap::new();
	for row in &snapshot.rows {
		let Some(provider) = row["provider"].as_str() else {
			continue;
		};
		let fold = folds.entry(Str::new(provider)).or_default();
		let account = Str::new(row["account"].as_str().unwrap_or("********"));
		if !fold.accounts.contains(&account) {
			fold.accounts.push(account);
		}
		let window = Str::new(row["window"].as_str().unwrap_or("default"));
		let label = row["label"]
			.as_str()
			.map_or_else(|| window.clone(), Str::new);
		fold
			.windows
			.entry(window)
			.or_insert_with(|| (label, Vec::new()))
			.1
			.push((fraction(row), row["resetAtMs"].as_u64()));
	}
	// Refresh failures are keyed by provider in their message prefix.
	for error in &snapshot.refresh_errors {
		if let Some(provider) = error
			.strip_prefix("usage refresh failed for ")
			.and_then(|rest| rest.split(" / ").next())
		{
			folds.entry(Str::new(provider)).or_default();
		}
	}
	folds
		.into_iter()
		.map(|(provider, fold)| {
			let mut windows = fold
				.windows
				.into_iter()
				.map(|(_, (label, observations))| {
					let known = observations
						.iter()
						.filter_map(|(fraction, _)| *fraction)
						.collect::<Vec<_>>();
					#[allow(clippy::cast_precision_loss, reason = "account counts are tiny")]
					let mean = (!known.is_empty()).then(|| known.iter().sum::<f64>() / known.len() as f64);
					let worst = observations
						.iter()
						.max_by(|a, b| a.0.unwrap_or(-1.0).total_cmp(&b.0.unwrap_or(-1.0)))
						.and_then(|(_, reset)| *reset)
						.filter(|reset| *reset > now_ms)
						.map(|reset| Duration::from_millis(reset - now_ms));
					UsageWindow {
						label,
						fraction: mean.unwrap_or(0.0),
						resets_in: worst,
						status: status(mean),
					}
				})
				.collect::<Vec<_>>();
			windows.sort_by(|a, b| b.fraction.total_cmp(&a.fraction));
			let errors = snapshot
				.refresh_errors
				.iter()
				.filter(|error| {
					error
						.strip_prefix("usage refresh failed for ")
						.is_some_and(|rest| rest.starts_with(provider.as_str()))
				})
				.map(String::as_str)
				.collect::<Vec<_>>();
			let title = catalog
				.and_then(|catalog| catalog.provider(&ProviderId::from(provider.as_str())))
				.map_or_else(|| provider.clone(), |definition| definition.name.clone());
			UsageAccount {
				provider,
				title,
				accounts: fold.accounts,
				windows,
				error: (!errors.is_empty()).then(|| Str::new(errors.join("; "))),
			}
		})
		.collect()
}

/// Classic per-account markdown report.
fn detail(snapshot: &QuotaSnapshot) -> Str {
	let mut out = String::from("**Usage**\n\n");
	if snapshot.rows.is_empty() {
		out.push_str("No provider quota observations recorded.\n");
	}
	let mut previous: Option<&str> = None;
	for row in &snapshot.rows {
		let provider = row["provider"].as_str().unwrap_or("unknown");
		if previous != Some(provider) {
			if previous.is_some() {
				out.push('\n');
			}
			let _ = writeln!(out, "### {provider}\n");
			previous = Some(provider);
		}
		let account = row["account"].as_str().unwrap_or("********");
		let window = row["label"]
			.as_str()
			.or_else(|| row["window"].as_str())
			.unwrap_or("default");
		let consumed = row["consumed"]
			.as_f64()
			.map_or_else(|| "—".to_owned(), format_number);
		let limit = row["limit"]
			.as_f64()
			.map_or_else(|| "—".to_owned(), format_number);
		let _ = write!(out, "- `{account}` · {window}: {consumed} / {limit}");
		if let Some(fraction) = fraction(row) {
			let _ = write!(out, " ({}% used)", (fraction * 100.0).round());
		}
		if let Some(reset) = row["resetAtMs"].as_u64()
			&& let Some(now) = unix_ms(SystemTime::now())
			&& reset > now
		{
			let _ = write!(out, " · resets in {}", omp_chat::notices::format_duration(reset - now));
		}
		if row["fresh"].as_bool() != Some(true) {
			out.push_str(" · stale");
		}
		out.push('\n');
	}
	for report in &snapshot.reports {
		if let Some(credits) = &report.reset_credits {
			let _ = writeln!(
				out,
				"\n`{}` saved resets: {} available",
				usage_cmd::mask(report.account.as_str()),
				credits.available
			);
		}
		for note in &report.notes {
			let _ = writeln!(out, "\n> {note}");
		}
	}
	if !snapshot.refresh_errors.is_empty() {
		out.push_str("\n**Refresh errors**\n\n");
		for error in &snapshot.refresh_errors {
			let _ = writeln!(out, "- {error}");
		}
	}
	Str::from(out)
}

fn format_number(value: f64) -> String {
	if value.fract() == 0.0 {
		format!("{value:.0}")
	} else {
		format!("{value:.2}")
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn snapshot() -> QuotaSnapshot {
		QuotaSnapshot {
			rows:           vec![
				json!({"provider": "openai-codex", "account": "abcd…wxyz", "window": "primary", "label": "5h", "consumed": 40.0, "limit": 100.0, "resetAtMs": 1_800_000_060_000_u64, "observedAtMs": 1_800_000_000_000_u64, "fresh": true}),
				json!({"provider": "openai-codex", "account": "efgh…stuv", "window": "primary", "label": "5h", "consumed": 100.0, "limit": 100.0, "resetAtMs": 1_800_000_120_000_u64, "observedAtMs": 1_800_000_000_000_u64, "fresh": true}),
				json!({"provider": "anthropic", "account": "ijkl…mnop", "window": "weekly", "consumed": 0.0, "limit": 50.0, "observedAtMs": 1_799_999_000_000_u64}),
			],
			reports:        Vec::new(),
			refresh_errors: vec!["usage refresh failed for anthropic / ijkl…mnop: boom".to_owned()],
		}
	}

	#[test]
	fn cards_average_accounts_and_take_the_worst_reset() {
		let cards = cards(&snapshot(), None, 1_800_000_000_000);
		let codex = cards
			.iter()
			.find(|card| card.provider.as_str() == "openai-codex")
			.unwrap();
		assert_eq!(codex.accounts.len(), 2);
		assert_eq!(codex.windows.len(), 1);
		let window = &codex.windows[0];
		assert_eq!(window.label.as_str(), "5h");
		assert!((window.fraction - 0.7).abs() < 1e-9);
		assert_eq!(window.resets_in, Some(Duration::from_secs(120)));
		assert_eq!(window.status, UsageStatus::Ok);
		let anthropic = cards
			.iter()
			.find(|card| card.provider.as_str() == "anthropic")
			.unwrap();
		assert_eq!(anthropic.windows[0].status, UsageStatus::Idle);
		assert!(anthropic.error.as_deref().unwrap().contains("boom"));
	}

	#[test]
	fn status_thresholds_match_the_dashboard_contract() {
		assert_eq!(status(None), UsageStatus::Unknown);
		assert_eq!(status(Some(1.0)), UsageStatus::Exhausted);
		assert_eq!(status(Some(0.8)), UsageStatus::Warning);
		assert_eq!(status(Some(0.005)), UsageStatus::Idle);
		assert_eq!(status(Some(0.3)), UsageStatus::Ok);
	}

	#[test]
	fn detail_groups_rows_by_provider() {
		let text = detail(&snapshot());
		assert!(text.starts_with("**Usage**"));
		assert!(text.contains("### openai-codex"));
		assert!(text.contains("`abcd…wxyz` · 5h: 40 / 100 (40% used)"));
		assert!(text.contains("· stale"), "{text}");
		assert!(text.contains("**Refresh errors**"));
	}
}
