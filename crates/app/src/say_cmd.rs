//! Standalone Kokoro sentence synthesis with speaker or atomic WAV output.

use std::{cell::Cell, fs, path::Path, sync::Arc, time::Duration};

use miette::{IntoDiagnostic as _, miette};
use omp_ai::local::{
	ArtifactStore, LocalCancellation, MemoryPool, SystemArtifactFetcher,
	speech_catalog::{DEFAULT_KOKORO_VOICE, SpeechArtifactManifests},
	tts::{KokoroAdapter, KokoroConfig, KokoroDevice, SynthesisOptions},
};
use omp_audio::audio::PlaybackStream;
use omp_core::Str;

use crate::{cli::SayArgs, progress_reporter::ProgressReporter};

/// Synthesizes text with one verified Kokoro model/voice.
pub async fn run(args: SayArgs) -> miette::Result<()> {
	if !args.speed.is_finite() || args.speed <= 0.0 {
		return Err(miette!("--speed must be a finite positive number"));
	}
	let data_dir = omp_core::dirs::data_dir(args.data_dir).into_diagnostic()?;
	let text = match (args.text, args.file) {
		(Some(text), None) => text,
		(None, Some(path)) => Str::from(fs::read_to_string(path).into_diagnostic()?),
		(None, None) => return Err(miette!("provide text or --file PATH")),
		(Some(_), Some(_)) => return Err(miette!("text and --file cannot be used together")),
	};
	if text.trim().is_empty() {
		return Err(miette!("speech input is empty"));
	}
	let model = args.model.as_deref().unwrap_or("kokoro");
	if model != "kokoro" {
		return Err(miette!("unknown local TTS model `{model}`; available: kokoro"));
	}
	let root = data_dir.join("models");
	fs::create_dir_all(&root).into_diagnostic()?;
	let store = ArtifactStore::open(&root).into_diagnostic()?;
	let artifacts = SpeechArtifactManifests::curated().into_diagnostic()?;
	let cancel = LocalCancellation::new();
	let manifest = artifacts.kokoro_manifest();
	let total = manifest.total_bytes().into_diagnostic()?;
	let progress = ProgressReporter::bounded(total, "downloading kokoro".to_owned(), false);
	let prior = Cell::new(0_u64);
	store
		.acquire(manifest, &SystemArtifactFetcher::new(), &cancel, |update| {
			let current = update.downloaded_bytes;
			progress.advance(current.saturating_sub(prior.replace(current)));
		})
		.await
		.into_diagnostic()?;
	progress.finish();
	let config = KokoroConfig::from_verified_artifacts(
		&store,
		&artifacts,
		device(),
		Duration::from_secs(60),
		&cancel,
	)
	.into_diagnostic()?;
	let memory = Arc::new(MemoryPool::new(config.resident_bytes));
	let adapter = KokoroAdapter::new(config, memory).into_diagnostic()?;
	let voice = args
		.voice
		.unwrap_or_else(|| DEFAULT_KOKORO_VOICE.to_string());
	let options = SynthesisOptions {
		speed:           args.speed,
		max_chunk_chars: args.max_chunk_chars,
		deterministic:   args.deterministic,
	};
	if let Some(path) = args.output {
		let output = adapter
			.synthesize(text.as_str(), &voice, options, &cancel)
			.into_diagnostic()?;
		write_wav_atomic(&path, output.sample_rate, &output.samples)?;
		println!("wrote {} samples to {}", output.samples.len(), path.display());
		return Ok(());
	}
	let mut playback = PlaybackStream::start(24_000).into_diagnostic()?;
	let writer = playback.writer().into_diagnostic()?;
	let mut playback_error = None;
	let receipt = adapter
		.synthesize_streaming(text.as_str(), &voice, options, &cancel, |chunk, _| {
			match writer.write(chunk) {
				Ok(()) => true,
				Err(error) => {
					playback_error = Some(error);
					false
				},
			}
		})
		.into_diagnostic()?;
	if let Some(error) = playback_error {
		return Err(error).into_diagnostic();
	}
	playback.drain().await.into_diagnostic()?;
	println!("played {} samples in {} chunk(s)", receipt.samples, receipt.chunks);
	Ok(())
}

const fn device() -> KokoroDevice {
	#[cfg(target_os = "macos")]
	{
		KokoroDevice::Metal
	}
	#[cfg(not(target_os = "macos"))]
	{
		KokoroDevice::Cpu
	}
}

fn write_wav_atomic(path: &Path, sample_rate: u32, samples: &[f32]) -> miette::Result<()> {
	let wav = omp_audio::wav::encode_wav(samples, sample_rate).into_diagnostic()?;
	if let Some(parent) = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
	{
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	let temporary = path.with_extension(format!("wav.tmp-{}", std::process::id()));
	fs::write(&temporary, wav).into_diagnostic()?;
	fs::rename(&temporary, path).into_diagnostic()?;
	Ok(())
}
