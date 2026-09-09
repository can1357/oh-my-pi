//! Verified local tiny-model catalog and atomic installer.

use std::{cell::Cell, collections::BTreeMap, fs};

use miette::{IntoDiagnostic as _, miette};
use omp_ai::local::{
	ArtifactStore, LocalCancellation, SystemArtifactFetcher,
	artifact::ArtifactCacheState,
	tiny_catalog::{MEMORY_MODELS, TITLE_MODELS, TinyModelSpec},
};
use serde_json::json;

use crate::{
	cli::{TinyModelsArgs, TinyModelsCommand},
	progress_reporter::ProgressReporter,
};

/// Lists, verifies, or installs title and Mnemopi-only embedding assets.
pub async fn run(args: TinyModelsArgs) -> miette::Result<()> {
	let root = args.cache_dir.unwrap_or(
		omp_core::dirs::data_dir(None)
			.into_diagnostic()?
			.join("models"),
	);
	fs::create_dir_all(&root).into_diagnostic()?;
	let store = ArtifactStore::open(&root).into_diagnostic()?;
	let models = unique_models();
	match args
		.command
		.unwrap_or(TinyModelsCommand::List { json: false })
	{
		TinyModelsCommand::List { json } => list(&store, &models, json),
		TinyModelsCommand::Verify { model, json } => verify(&store, &models, model.as_deref(), json),
		TinyModelsCommand::Download { model, json, quiet } => {
			download(&store, &models, &model, json, quiet).await
		},
	}
}

fn unique_models() -> BTreeMap<&'static str, &'static TinyModelSpec> {
	TITLE_MODELS
		.iter()
		.chain(MEMORY_MODELS.iter())
		.map(|model| (model.id, model))
		.collect()
}

fn list(
	store: &ArtifactStore,
	models: &BTreeMap<&str, &TinyModelSpec>,
	json_output: bool,
) -> miette::Result<()> {
	let cancel = LocalCancellation::new();
	let rows = models
		.values()
		.map(|model| row(store, model, &cancel))
		.collect::<miette::Result<Vec<_>>>()?;
	if json_output {
		println!("{}", serde_json::to_string_pretty(&rows).into_diagnostic()?);
	} else {
		for row in rows {
			println!(
				"{:<14} {:<10} {}",
				row["id"].as_str().unwrap_or_default(),
				row["status"].as_str().unwrap_or_default(),
				row["description"].as_str().unwrap_or_default(),
			);
		}
	}
	Ok(())
}

fn verify(
	store: &ArtifactStore,
	models: &BTreeMap<&str, &TinyModelSpec>,
	selected: Option<&str>,
	json_output: bool,
) -> miette::Result<()> {
	let cancel = LocalCancellation::new();
	let selected = select(models, selected)?;
	let mut rows = Vec::with_capacity(selected.len());
	let mut invalid = false;
	for model in selected {
		let row = row(store, model, &cancel)?;
		invalid |= row["status"] != "ready";
		rows.push(row);
	}
	if json_output {
		println!("{}", serde_json::to_string_pretty(&rows).into_diagnostic()?);
	} else {
		for row in rows {
			println!("{} {}", row["id"].as_str().unwrap_or_default(), row["status"]);
		}
	}
	if invalid {
		return Err(miette!("one or more local model artifacts are not verified"));
	}
	Ok(())
}

async fn download(
	store: &ArtifactStore,
	models: &BTreeMap<&str, &TinyModelSpec>,
	selected: &str,
	json_output: bool,
	quiet: bool,
) -> miette::Result<()> {
	let selected = select(models, (selected != "all").then_some(selected))?;
	let fetcher = SystemArtifactFetcher::new();
	let cancel = LocalCancellation::new();
	let mut rows = Vec::with_capacity(selected.len());
	for model in selected {
		let manifest = model.manifest().into_diagnostic()?;
		let total = manifest.total_bytes().into_diagnostic()?;
		let progress = ProgressReporter::bounded(
			total,
			format!("downloading {}", model.id),
			quiet || json_output,
		);
		let prior = Cell::new(0_u64);
		store
			.acquire(&manifest, &fetcher, &cancel, |update| {
				let current = update.downloaded_bytes;
				progress.advance(current.saturating_sub(prior.replace(current)));
			})
			.await
			.into_diagnostic()?;
		progress.finish();
		rows.push(row(store, model, &cancel)?);
	}
	if json_output {
		println!("{}", serde_json::to_string_pretty(&rows).into_diagnostic()?);
	} else {
		for row in rows {
			println!("installed {}", row["id"].as_str().unwrap_or_default());
		}
	}
	Ok(())
}

fn select<'a>(
	models: &'a BTreeMap<&str, &'a TinyModelSpec>,
	selected: Option<&str>,
) -> miette::Result<Vec<&'a TinyModelSpec>> {
	match selected {
		None => Ok(models.values().copied().collect()),
		Some(id) => models
			.get(id)
			.copied()
			.map(|model| vec![model])
			.ok_or_else(|| miette!("unknown tiny model `{id}`")),
	}
}

fn row(
	store: &ArtifactStore,
	model: &TinyModelSpec,
	cancel: &LocalCancellation,
) -> miette::Result<serde_json::Value> {
	let manifest = model.manifest().into_diagnostic()?;
	let ArtifactCacheState { status, cached_bytes, total_bytes, .. } = store
		.inspect_manifest(&manifest, cancel)
		.into_diagnostic()?;
	Ok(json!({
		"id": model.id,
		"label": model.label,
		"description": model.description,
		"family": model.family,
		"status": status,
		"cachedBytes": cached_bytes,
		"totalBytes": total_bytes,
		"title": TITLE_MODELS.iter().any(|candidate| candidate.id == model.id),
		"memory": MEMORY_MODELS.iter().any(|candidate| candidate.id == model.id),
	}))
}
