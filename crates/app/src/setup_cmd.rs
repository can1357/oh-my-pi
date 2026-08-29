//! Standalone onboarding, embedded-Python, and speech-asset setup.

use std::fs;
#[cfg(feature = "local")]
use std::{cell::Cell, io, io::IsTerminal as _, path::Path, str::FromStr as _};

use miette::{IntoDiagnostic as _, miette};
use omp_catalog::snapshot;
#[cfg(feature = "local")]
use omp_chat_ui::ListRow;
#[cfg(feature = "local")]
use omp_core::Str;
#[cfg(feature = "local")]
use omp_inference::local::{
	ArtifactStore, LocalCancellation, SystemArtifactFetcher,
	artifact::ArtifactCacheStatus,
	speech_catalog::{STT_PRESETS, SpeechArtifactManifests, SpeechCatalog, SttPreset},
};
use serde_json::json;

use crate::{
	cli::{SetupArgs, SetupCommand},
	wizard,
};
#[cfg(feature = "local")]
use crate::{pickers, progress_reporter::ProgressReporter};

/// Executes one standalone setup flow.
pub async fn run(args: SetupArgs) -> miette::Result<()> {
	let data_dir = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	fs::create_dir_all(&data_dir).into_diagnostic()?;
	match args.command.unwrap_or(SetupCommand::Wizard) {
		SetupCommand::Wizard => {
			let catalog =
				snapshot::Catalog::try_embedded().map_err(|error| miette!(error.to_string()))?;
			wizard::run(&data_dir, catalog).await?;
			Ok(())
		},
		SetupCommand::Python { json } => python(json),
		SetupCommand::Speech { model, check, json, quiet } => {
			#[cfg(feature = "local")]
			{
				speech(&data_dir, model, check, json, quiet).await
			}
			#[cfg(not(feature = "local"))]
			{
				let _ = (model, check, json, quiet);
				Err(miette!(
					"speech setup is unavailable in this build; local speech features are disabled"
				))
			}
		},
	}
}

fn python(json_output: bool) -> miette::Result<()> {
	let engine = omp_py::Engine::builder().init().into_diagnostic()?;
	let distributions = omp_py::frozen_distributions();
	if json_output {
		println!(
			"{}",
			serde_json::to_string_pretty(&json!({
				"ready": true,
				"sitePackages": engine.site_packages(),
				"frozenDistributions": distributions,
			}))
			.into_diagnostic()?
		);
	} else {
		println!(
			"embedded Python ready: {} frozen distribution(s), site-packages {}",
			distributions.len(),
			engine.site_packages().display(),
		);
	}
	Ok(())
}

#[cfg(feature = "local")]
async fn speech(
	data_dir: &Path,
	mut model: Option<String>,
	check: bool,
	json_output: bool,
	quiet: bool,
) -> miette::Result<()> {
	let root = data_dir.join("models");
	fs::create_dir_all(&root).into_diagnostic()?;
	let store = ArtifactStore::open(&root).into_diagnostic()?;
	let manifests = SpeechArtifactManifests::curated().into_diagnostic()?;
	let cancel = LocalCancellation::new();
	let snapshot = SpeechCatalog
		.snapshot(&store, &manifests, &cancel)
		.into_diagnostic()?;
	if check {
		let ready = snapshot
			.speech_to_text
			.models
			.iter()
			.all(|entry| entry.cache.status == ArtifactCacheStatus::Ready)
			&& snapshot
				.text_to_speech
				.models
				.iter()
				.all(|entry| entry.cache.status == ArtifactCacheStatus::Ready);
		if json_output {
			println!("{}", serde_json::to_string_pretty(&snapshot).into_diagnostic()?);
		} else {
			for entry in &snapshot.speech_to_text.models {
				println!("stt {:<10} {}", entry.value, entry.cache.status);
			}
			for entry in &snapshot.text_to_speech.models {
				println!("tts {:<10} {}", entry.value, entry.cache.status);
			}
		}
		return ready
			.then_some(())
			.ok_or_else(|| miette!("one or more speech assets are missing"));
	}
	if model.is_none() {
		if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
			return Err(miette!("speech setup requires MODEL when standard I/O is not a terminal"));
		}
		let mut rows = snapshot
			.speech_to_text
			.models
			.iter()
			.map(|entry| ListRow {
				key:    entry.value.to_string().into(),
				label:  entry.label.clone(),
				detail: Str::from(format!("{} ({})", entry.description, entry.cache.status)),
			})
			.collect::<Vec<_>>();
		rows.push(ListRow {
			key:    Str::new_static("kokoro"),
			label:  Str::new_static("Kokoro-82M"),
			detail: Str::new_static("Local text-to-speech model and curated voices"),
		});
		model = pickers::run_list("Select speech model", &rows)
			.await
			.into_diagnostic()?
			.map(|index| rows[index].key.to_string());
	}
	let Some(model) = model else { return Ok(()) };
	let manifest = if model == "kokoro" {
		manifests.kokoro_manifest()
	} else {
		let preset =
			SttPreset::from_str(&model).map_err(|_| miette!("unknown speech model `{model}`"))?;
		if !STT_PRESETS.contains(&preset) {
			return Err(miette!("unknown speech model `{model}`"));
		}
		manifests.stt_manifest(preset)
	};
	let total = manifest.total_bytes().into_diagnostic()?;
	let progress =
		ProgressReporter::bounded(total, format!("downloading {model}"), quiet || json_output);
	let prior = Cell::new(0_u64);
	store
		.acquire(manifest, &SystemArtifactFetcher::new(), &cancel, |update| {
			let current = update.downloaded_bytes;
			progress.advance(current.saturating_sub(prior.replace(current)));
		})
		.await
		.into_diagnostic()?;
	progress.finish();
	if json_output {
		println!("{}", json!({ "model": model, "status": "ready" }));
	} else {
		println!("installed speech model {model}");
	}
	Ok(())
}
