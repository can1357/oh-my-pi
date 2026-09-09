//! Durable quota-history CLI over the inference-owned account state store.

use std::{
	fmt::Write as _,
	fs,
	path::Path,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use miette::{IntoDiagnostic as _, miette};
use omp_ai::{
	account::AccountStateStore,
	answer::{UsageQuantity, UsageReport},
	call::{UsageRequest, UsageScope},
	id::AccountId,
};
use omp_catalog::ProviderId;
use omp_core::Str;
use serde_json::{Value, json};

use crate::cli::UsageArgs;

/// Renders durable quota snapshots, client attribution, or explicitly
/// invalidates them.
pub async fn run(args: UsageArgs) -> miette::Result<()> {
	if args.account.is_some() && args.provider.is_some() {
		return Err(miette!("--account and --provider are mutually exclusive"));
	}
	let data_dir = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	fs::create_dir_all(&data_dir).into_diagnostic()?;
	let store = AccountStateStore::open(data_dir.join("credentials.db")).into_diagnostic()?;
	let provider = args.provider.map(ProviderId::from);
	let account = args.account.map(AccountId::from);
	if args.invalidate {
		let removed = store
			.invalidate_usage(provider.as_deref(), account.as_deref())
			.into_diagnostic()?;
		if args.json {
			println!("{}", json!({ "invalidatedReceipts": removed }));
		} else {
			println!("invalidated {removed} durable usage receipt(s)");
		}
		return Ok(());
	}

	let snapshot = collect_quota(&data_dir, provider.as_ref(), account.as_ref()).await?;
	for error in &snapshot.refresh_errors {
		eprintln!("{error}");
	}
	if args.json {
		println!("{}", serde_json::to_string_pretty(&snapshot.rows).into_diagnostic()?);
		return Ok(());
	}
	if snapshot.rows.is_empty() {
		println!("no quota observations");
		return Ok(());
	}
	for row in snapshot.rows {
		print_row(&row);
	}
	Ok(())
}

/// Durable quota rows merged with one fresh refresh per account.
pub(crate) struct QuotaSnapshot {
	/// One JSON row per `(provider, account, window)`: `provider`,
	/// `account` (masked), `window`, `label`, `consumed`, `limit`,
	/// `remaining`, `resetAtMs`, `observedAtMs`, `fresh`.
	pub(crate) rows:           Vec<Value>,
	/// Fresh provider reports, one per refreshed account.
	pub(crate) reports:        Vec<UsageReport>,
	/// Refresh failures, one line per account.
	pub(crate) refresh_errors: Vec<String>,
}

/// Loads durable quota windows and refreshes every stored account with a
/// 20 s deadline each (the chat `/usage` dashboard and the CLI share it).
pub(crate) async fn collect_quota(
	data_dir: &Path,
	provider: Option<&ProviderId>,
	account: Option<&AccountId>,
) -> miette::Result<QuotaSnapshot> {
	let store = AccountStateStore::open(data_dir.join("credentials.db")).into_diagnostic()?;
	let records = store.load_accounts().into_diagnostic()?;
	let mut rows = Vec::new();
	for record in &records {
		if provider.is_some_and(|value| value != &record.provider)
			|| account.is_some_and(|value| value != &record.account)
		{
			continue;
		}
		let state = store.load_account(&record.account).into_diagnostic()?;
		for (window_id, window) in state.quota.windows() {
			let trend = window
				.receipts
				.iter()
				.filter_map(|receipt| {
					receipt
						.consumed
						.zip(receipt.limit)
						.and_then(|(consumed, limit)| {
							(limit != 0).then_some((consumed as f64 / limit as f64).clamp(0.0, 1.0))
						})
				})
				.collect::<Vec<_>>();
			rows.push(json!({
				"provider": record.provider.as_str(),
				"account": mask(record.account.as_str()),
				"window": window_id.as_str(),
				"consumed": window.consumed.map(|sample| sample.value),
				"remaining": window.remaining.map(|sample| sample.value),
				"limit": window.limit.map(|sample| sample.value),
				"resetAtMs": window.reset_at.and_then(|sample| unix_millis(sample.value)),
				"observedAtMs": window.receipts.last().and_then(|receipt| unix_millis(receipt.observed_at)),
				"historySamples": window.receipts.len(),
				"trend": trend,
			}));
		}
	}
	let manager = omp_driver::registry::production_usage_manager(data_dir)
		.await
		.into_diagnostic()?;
	let mut reports = Vec::new();
	let mut refresh_errors = Vec::new();
	for record in &records {
		if provider.is_some_and(|value| value != &record.provider)
			|| account.is_some_and(|value| value != &record.account)
		{
			continue;
		}
		let Some(route) = record.routes.iter().next() else {
			continue;
		};
		let request = UsageRequest {
			provider:    Some(record.provider.clone()),
			account:     Some(record.account.clone()),
			scope:       UsageScope::All,
			allow_stale: false,
		};
		match manager
			.execute(
				&record.provider,
				route,
				&request,
				Instant::now().checked_add(Duration::from_secs(20)),
			)
			.await
		{
			Ok(report) => {
				merge_fresh(&mut rows, &report);
				reports.push(report);
			},
			Err(error) => refresh_errors.push(format!(
				"usage refresh failed for {} / {}: {error}",
				record.provider.as_str(),
				mask(record.account.as_str())
			)),
		}
	}
	Ok(QuotaSnapshot { rows, reports, refresh_errors })
}

/// Renders the latest provider quota windows.
pub async fn render_report(data_dir: &Path) -> miette::Result<Str> {
	fs::create_dir_all(data_dir).into_diagnostic()?;
	let quota = collect_quota(data_dir, None, None).await?;
	let mut rendered = String::from("**Usage**\n\n");
	if quota.rows.is_empty() {
		rendered.push_str("No provider quota observations recorded.\n");
	} else {
		for row in &quota.rows {
			let provider = row["provider"].as_str().unwrap_or("unknown");
			let consumed = row["consumed"]
				.as_f64()
				.map(format_number)
				.unwrap_or_else(|| "—".to_owned());
			let limit = row["limit"]
				.as_f64()
				.map(format_number)
				.unwrap_or_else(|| "—".to_owned());
			let _ = writeln!(rendered, "- `{provider}`: {consumed} / {limit}");
		}
	}
	Ok(Str::from(rendered))
}

/// Lists or spends saved Codex rate-limit resets.
pub async fn reset_usage(data_dir: &Path, target: &str) -> miette::Result<Str> {
	let codex_provider = ProviderId::from("openai-codex");
	let quota = collect_quota(data_dir, Some(&codex_provider), None).await?;
	if quota.reports.is_empty() {
		return Ok(Str::new_static("No Codex accounts found. Use /login to add one."));
	}
	let accounts = quota
		.reports
		.iter()
		.map(|report| {
			let label = report
				.account_meta
				.email
				.as_ref()
				.or(report.account_meta.provider_account_id.as_ref())
				.map_or_else(|| mask(report.account.as_str()), ToString::to_string);
			let available = report
				.reset_credits
				.as_ref()
				.map_or(0, |credits| credits.available);
			(label, available, report.account.clone())
		})
		.collect::<Vec<_>>();
	let target = target.trim();
	if target.is_empty() {
		let mut rendered = String::from("Saved Codex rate-limit resets:");
		for (index, (label, available, _)) in accounts.iter().enumerate() {
			let active = if index == 0 { " (active)" } else { "" };
			let _ = write!(rendered, "\n- {label}: {available} available{active}");
		}
		rendered
			.push_str("\n\nSpend one with `/usage reset <account email>` or `/usage reset active`.");
		return Ok(Str::from(rendered));
	}
	let selected = if target.eq_ignore_ascii_case("active") {
		accounts.first()
	} else {
		accounts.iter().find(|(label, _, account)| {
			label.eq_ignore_ascii_case(target) || account.as_str().eq_ignore_ascii_case(target)
		})
	};
	let Some((label, available, selected_account)) = selected else {
		return Ok(Str::from(format!("No Codex account matches \"{target}\".")));
	};
	if *available == 0 {
		return Ok(Str::from(format!("{label}: no saved resets to spend.")));
	}
	let redeemed = omp_driver::registry::redeem_codex_reset(data_dir, selected_account)
		.await
		.into_diagnostic()?
		.ok_or_else(|| miette!("Codex reset redemption is unavailable"))?;
	if redeemed {
		Ok(Str::from(format!(
			"Reset applied for {label} — your rate-limit window has been refreshed.",
		)))
	} else {
		Ok(Str::from(format!("{label}: nothing to reset right now — no credit was spent.",)))
	}
}

fn format_number(value: f64) -> String {
	if value.fract() == 0.0 {
		format!("{value:.0}")
	} else {
		format!("{value:.2}")
	}
}

fn merge_fresh(rows: &mut Vec<Value>, report: &UsageReport) {
	let provider = report.provider.as_str();
	let account = mask(report.account.as_str());
	for window in &report.windows {
		let consumed = window.amount.consumed.map(quantity_value);
		let remaining = window.amount.remaining.map(quantity_value);
		let limit = window.amount.limit.map(quantity_value);
		let existing = rows.iter_mut().find(|row| {
			row["provider"].as_str() == Some(provider)
				&& row["account"].as_str() == Some(account.as_str())
				&& row["window"].as_str() == Some(window.id.as_str())
		});
		if let Some(row) = existing {
			row["consumed"] = json!(consumed);
			row["label"] = json!(window.label.as_deref());
			row["remaining"] = json!(remaining);
			row["limit"] = json!(limit);
			row["resetAtMs"] = json!(window.resets_at.and_then(unix_millis));
			row["observedAtMs"] = json!(unix_millis(window.observed_at));
			row["fresh"] = json!(true);
		} else {
			rows.push(json!({
				"provider": provider,
				"account": account,
				"window": window.id.as_str(),
				"label": window.label.as_deref(),
				"consumed": consumed,
				"remaining": remaining,
				"limit": limit,
				"resetAtMs": window.resets_at.and_then(unix_millis),
				"observedAtMs": unix_millis(window.observed_at),
				"historySamples": 0,
				"trend": [],
				"fresh": true,
			}));
		}
	}
}

fn quantity_value(quantity: UsageQuantity) -> f64 {
	quantity.units as f64 / 10_f64.powi(i32::from(quantity.decimal_exponent))
}

/// Masks an account id to its first and last four characters.
pub(crate) fn mask(value: &str) -> String {
	if value.len() <= 8 {
		return "********".to_owned();
	}
	format!("{}…{}", &value[..4], &value[value.len() - 4..])
}

fn unix_millis(time: SystemTime) -> Option<u64> {
	time
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn print_row(row: &Value) {
	let consumed_value = row["consumed"].as_f64();
	let consumed = consumed_value.map_or("?".to_owned(), |value| value.to_string());
	let limit_value = row["limit"].as_f64();
	let limit = limit_value.map_or("?".to_owned(), |value| value.to_string());
	let fraction = consumed_value
		.zip(limit_value)
		.and_then(|(used, total)| (total != 0.0).then_some(used / total));
	let bar = quota_bar(fraction);
	let trend = row["trend"]
		.as_array()
		.map_or_else(String::new, |samples| trend_bar(samples));
	println!(
		"{:<18} {:<12} {:<20} {bar} {consumed}/{limit} ({} sample(s)) {trend}",
		row["provider"].as_str().unwrap_or("unknown"),
		row["account"].as_str().unwrap_or("********"),
		row["window"].as_str().unwrap_or("unknown"),
		row["historySamples"].as_u64().unwrap_or_default(),
	);
}

fn quota_bar(fraction: Option<f64>) -> String {
	const WIDTH: usize = 20;
	let Some(fraction) = fraction else {
		return "·".repeat(WIDTH);
	};
	let filled = (fraction.clamp(0.0, 1.0) * WIDTH as f64).round() as usize;
	format!("{}{}", "█".repeat(filled), "░".repeat(WIDTH - filled))
}

fn trend_bar(samples: &[Value]) -> String {
	const LEVELS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
	samples
		.iter()
		.rev()
		.take(48)
		.rev()
		.filter_map(Value::as_f64)
		.map(|fraction| {
			let index = (fraction.clamp(0.0, 1.0) * LEVELS.len() as f64)
				.floor()
				.min((LEVELS.len() - 1) as f64) as usize;
			LEVELS[index]
		})
		.collect()
}
