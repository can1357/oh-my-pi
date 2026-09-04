//! Deterministic account-pool selection simulation and opt-in live benchmark.

use std::{collections::BTreeMap, sync, time::SystemTime};

use miette::{IntoDiagnostic as _, miette};
use omp_ai::account::{AccountPool, AccountSelectionRequest, AccountStateStore, RotationPolicy};
use omp_catalog::{ModelKey, snapshot::Catalog};
use omp_core::{Str, fast_hash64};
use serde_json::json;

use crate::{
	bench_cmd, cli,
	cli::{BenchArgs, DryBalanceArgs},
};

/// Simulates the canonical account pool and optionally benchmarks through its
/// normal credential/receipt path.
pub async fn run(args: DryBalanceArgs) -> miette::Result<()> {
	if args.count == 0 || args.concurrency == 0 {
		return Err(miette!("--count and --concurrency must be greater than zero"));
	}
	let data_dir = omp_core::dirs::data_dir(args.data_dir.clone()).into_diagnostic()?;
	let catalog = Catalog::try_embedded().map_err(|error| miette!(error.to_string()))?;
	let model = args
		.model
		.as_ref()
		.map_or_else(|| catalog.models().first(), |key| catalog.model(&ModelKey::from(key.clone())))
		.ok_or_else(|| miette!("model catalog is empty or the selected model is unknown"))?;
	let route = model
		.routes
		.first()
		.cloned()
		.ok_or_else(|| miette!("selected model has no eligible route"))?;
	let provider = catalog
		.route(&route)
		.map(|route| route.provider.clone())
		.ok_or_else(|| miette!("selected model route is absent from the catalog"))?;
	let pool = AccountPool::with_store(sync::Arc::new(
		AccountStateStore::open(data_dir.join("credentials.db")).into_diagnostic()?,
	))
	.into_diagnostic()?;
	let accounts = pool
		.accounts()
		.into_iter()
		.filter(|account| account.provider == provider && account.routes.contains(&route))
		.collect::<Vec<_>>();
	if accounts.is_empty() {
		return Err(miette!("provider `{}` has no eligible stored accounts", provider.as_str()));
	}
	let mut counts = BTreeMap::<String, u32>::new();
	let mut receipts = Vec::with_capacity(args.count as usize);
	for sample in 0..args.count {
		// Sample a fresh randomized session id for every attempt. Feed the same
		// distribution into the canonical pool by making the hashed
		// session bucket the preferred preceding account.
		let session_id = cli::turn_id();
		let bucket = fast_hash64(session_id.as_bytes()) as usize % accounts.len();
		let preferred = accounts[bucket].account.clone();
		let selection = pool
			.select(&AccountSelectionRequest {
				provider:           provider.clone(),
				route:              route.clone(),
				affinity:           None,
				previous_account:   Some(preferred),
				previous_principal: None,
				rotate:             false,
				rotation:           RotationPolicy::default(),
				now:                SystemTime::now(),
				quota_scope:        None,
			})
			.map_err(|error| miette!(error.to_string()))?;
		*counts
			.entry(selection.record.account.as_str().to_owned())
			.or_default() += 1;
		receipts.push(json!({
			"sample": sample,
			"sessionId": session_id,
			"account": mask(selection.record.account.as_str()),
			"candidateCount": selection.receipt.candidates.len(),
		}));
	}
	if args.json {
		println!(
			"{}",
			serde_json::to_string_pretty(&json!({
				"model": model.key,
				"provider": provider,
				"route": route,
				"counts": counts.into_iter().map(|(account, count)| (mask(&account), count)).collect::<BTreeMap<_, _>>(),
				"receipts": receipts,
			}))
			.into_diagnostic()?
		);
	} else {
		for (account, count) in counts {
			println!("{} {count}", mask(&account));
		}
	}
	if args.bench {
		bench_cmd::run(BenchArgs {
			model:         model.key.as_str().into(),
			data_dir:      args.data_dir,
			runs:          Some(args.count),
			max_tokens:    Some(512),
			prompt:        Some(Str::new_static("Reply with the word ready.")),
			profile:       crate::cli::BenchProfile::Chat,
			prefill_bytes: None,
			par:           args.concurrency,
			json:          args.json,
		})
		.await?;
	}
	Ok(())
}

fn mask(value: &str) -> String {
	let chars = value.chars().collect::<Vec<_>>();
	if chars.len() <= 8 {
		return "********".to_owned();
	}
	format!(
		"{}…{}",
		chars[..4].iter().collect::<String>(),
		chars[chars.len() - 4..].iter().collect::<String>(),
	)
}
