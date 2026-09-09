//! Candle-backed local Whisper speech recognition.

use std::{
	path::PathBuf,
	str::FromStr as _,
	sync::{Arc, LazyLock},
	time::{Duration, Instant},
};

use candle_core::{Device, IndexOp, Tensor};
use candle_nn::{VarBuilder, ops::softmax};
use candle_transformers::models::whisper::{self, Config, audio, model::Whisper};
use omp_core::Str;
use parking_lot::Mutex;
use tokenizers::Tokenizer;

use super::{
	artifact::ArtifactStore,
	parakeet,
	parakeet::{ParakeetAdapter, ParakeetConfig},
	runtime::{
		LocalCancellation, LocalError, LocalErrorKind, LocalExecutionReceipt, LocalResult,
		LocalRuntime, MemoryPool,
	},
	speech_catalog::{DEFAULT_STT_PRESET, SpeechArtifactManifests, SttPreset},
};

const SAMPLE_RATE: usize = whisper::SAMPLE_RATE;
const WHISPER_WINDOW_SAMPLES: usize = whisper::N_SAMPLES;
const WHISPER_STRIDE_SAMPLES: usize = 5 * SAMPLE_RATE;
/// Process-wide serialization shared by Whisper and Parakeet recognizers.
pub(super) static STT_INFERENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Configuration for a verified Candle Whisper checkpoint.
#[derive(Clone, Debug)]
pub struct WhisperConfig {
	/// Path to the safetensors Whisper checkpoint.
	pub model_path:      PathBuf,
	/// Path to the Hugging Face model configuration.
	pub config_path:     PathBuf,
	/// Path to the Hugging Face tokenizer definition.
	pub tokenizer_path:  PathBuf,
	/// Whether Candle should use Metal when the platform supports it.
	pub use_gpu:         bool,
	/// Estimated resident bytes charged before loading.
	pub resident_bytes:  usize,
	/// Admission limit; currently must be one because Whisper access is
	/// serialized.
	pub max_concurrency: usize,
	/// Explicit idle-unload interval.
	pub idle_timeout:    Duration,
}

impl WhisperConfig {
	/// Verifies and binds one Whisper preset from the canonical speech manifest.
	pub fn from_verified_artifacts(
		store: &ArtifactStore,
		artifacts: &SpeechArtifactManifests,
		preset: SttPreset,
		use_gpu: bool,
		idle_timeout: Duration,
		cancel: &LocalCancellation,
	) -> LocalResult<Self> {
		if preset == SttPreset::Parakeet {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"Parakeet requires the Candle adapter",
			));
		}
		let paths = artifacts.verified_stt_paths(store, preset, cancel)?;
		let model_path = required_artifact_path(&paths, "model.safetensors")?;
		let config_path = required_artifact_path(&paths, "config.json")?;
		let tokenizer_path = required_artifact_path(&paths, "tokenizer.json")?;
		let resident_bytes = usize::try_from(
			artifacts
				.stt_manifest(preset)
				.total_bytes()
				.map_err(|_| LocalError::new(LocalErrorKind::Artifact, "invalid Whisper manifest"))?,
		)
		.map_err(|_| {
			LocalError::new(LocalErrorKind::Overloaded, "Whisper checkpoint exceeds address space")
		})?;
		Ok(Self {
			model_path,
			config_path,
			tokenizer_path,
			use_gpu,
			resident_bytes,
			max_concurrency: 1,
			idle_timeout,
		})
	}
}

fn required_artifact_path(paths: &[PathBuf], filename: &str) -> LocalResult<PathBuf> {
	paths
		.iter()
		.find(|path| path.file_name().is_some_and(|name| name == filename))
		.cloned()
		.ok_or_else(|| {
			LocalError::new(
				LocalErrorKind::Artifact,
				format!("Whisper manifest is missing {filename}"),
			)
		})
}

/// Resolves persisted preset ids, falling back to Parakeet for stale values.
pub fn resolve_stt_preset(id: Option<&str>) -> SttPreset {
	id.and_then(|id| SttPreset::from_str(id).ok())
		.unwrap_or(DEFAULT_STT_PRESET)
}

/// Controls one transcription.
#[derive(Clone, Debug, Default)]
pub struct TranscriptionOptions {
	/// Optional ISO-639-1 language code; absent enables detection.
	pub language:       Option<Str>,
	/// Translate recognized speech to English.
	pub translate:      bool,
	/// Include segment timestamps.
	pub timestamps:     bool,
	/// Optional initial decoder prompt.
	pub initial_prompt: Option<Str>,
	/// Maintained for request compatibility; Candle Whisper decodes greedily.
	pub temperature:    Option<f32>,
}

/// One timestamped transcription segment.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptionSegment {
	/// Recognized text.
	pub text:                  Str,
	/// Start offset from the audio beginning.
	pub start:                 Duration,
	/// End offset from the audio beginning.
	pub end:                   Duration,
	/// Model probability that the interval contains no speech.
	pub no_speech_probability: f32,
}

/// Complete transcription and local execution evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct Transcription {
	/// Concatenated recognized text.
	pub text:     Str,
	/// Timestamped segments, empty when timestamps were disabled.
	pub segments: Vec<TranscriptionSegment>,
	/// Detected or requested language.
	pub language: Option<Str>,
	/// Local runtime receipt.
	pub receipt:  LocalExecutionReceipt,
}

/// Shared lifecycle controls for all four STT presets.
#[derive(Clone, Copy, Debug)]
pub struct SttRuntimeOptions {
	/// CPU inference threads used by the Parakeet adapter.
	pub threads:      usize,
	/// Whether Whisper may use Metal on macOS.
	pub whisper_gpu:  bool,
	/// Idle interval before unloading a recognizer.
	pub idle_timeout: Duration,
}

/// Concrete adapter selected from the stable four-preset catalog.
#[derive(Clone)]
pub enum SpeechToTextAdapter {
	/// A Whisper fast, balanced, or turbo checkpoint.
	Whisper {
		/// Resolved stable preset.
		preset:  SttPreset,
		/// Candle Whisper adapter.
		adapter: WhisperAdapter,
	},
	/// Default Parakeet TDT recognizer.
	Parakeet(ParakeetAdapter),
}

impl SpeechToTextAdapter {
	/// Resolves stale persisted ids, verifies that preset's manifest, and
	/// constructs the matching native adapter.
	pub fn from_verified_artifacts(
		store: &ArtifactStore,
		artifacts: &SpeechArtifactManifests,
		selected_id: Option<&str>,
		options: SttRuntimeOptions,
		memory: Arc<MemoryPool>,
		cancel: &LocalCancellation,
	) -> LocalResult<Self> {
		let preset = resolve_stt_preset(selected_id);
		match preset {
			SttPreset::Parakeet => {
				let evidence = parakeet::availability();
				if !evidence.available {
					return Err(LocalError::new(LocalErrorKind::Unsupported, evidence.detail));
				}
				let config = ParakeetConfig::from_verified_artifacts(
					store,
					artifacts,
					options.threads,
					options.idle_timeout,
					cancel,
				)?;
				Ok(Self::Parakeet(ParakeetAdapter::new(config, memory)?))
			},
			SttPreset::Fast | SttPreset::Balanced | SttPreset::Turbo => {
				let config = WhisperConfig::from_verified_artifacts(
					store,
					artifacts,
					preset,
					options.whisper_gpu,
					options.idle_timeout,
					cancel,
				)?;
				Ok(Self::Whisper { preset, adapter: WhisperAdapter::new(config, memory)? })
			},
		}
	}

	/// Returns the resolved preset, including stale-id fallback.
	pub const fn preset(&self) -> SttPreset {
		match self {
			Self::Whisper { preset, .. } => *preset,
			Self::Parakeet(_) => SttPreset::Parakeet,
		}
	}

	/// Transcribes mono 16 kHz audio with the selected concrete engine.
	pub fn transcribe_mono_16khz(
		&self,
		samples: &[f32],
		options: &TranscriptionOptions,
		cancel: &LocalCancellation,
	) -> LocalResult<Transcription> {
		match self {
			Self::Whisper { adapter, .. } => adapter.transcribe_mono_16khz(samples, options, cancel),
			Self::Parakeet(adapter) => adapter.transcribe_mono_16khz(samples, options, cancel),
		}
	}

	/// Prewarms the resolved concrete recognizer.
	pub fn prewarm(&self, cancel: &LocalCancellation) -> LocalResult<LocalExecutionReceipt> {
		match self {
			Self::Whisper { adapter, .. } => adapter.prewarm(cancel),
			Self::Parakeet(adapter) => adapter.prewarm(cancel),
		}
	}

	/// Unloads the selected engine after its configured idle interval.
	pub fn unload_if_idle(&self, now: Instant) -> bool {
		match self {
			Self::Whisper { adapter, .. } => adapter.unload_if_idle(now),
			Self::Parakeet(adapter) => adapter.unload_if_idle(now),
		}
	}
}

struct WhisperEngine {
	model:               Whisper,
	config:              Config,
	tokenizer:           Tokenizer,
	device:              Device,
	mel_filters:         Vec<f32>,
	language_tokens:     Vec<(Str, u32)>,
	sot_token:           u32,
	transcribe_token:    u32,
	translate_token:     u32,
	eot_token:           u32,
	no_speech_token:     u32,
	no_timestamps_token: u32,
	suppress_tokens:     Tensor,
}

/// Lazy, bounded adapter over Candle Whisper.
#[derive(Clone)]
pub struct WhisperAdapter {
	runtime: LocalRuntime<WhisperEngine>,
}

impl WhisperAdapter {
	/// Creates a lazy adapter for a local checkpoint.
	pub fn new(config: WhisperConfig, memory: Arc<MemoryPool>) -> LocalResult<Self> {
		let resident_bytes = config.resident_bytes;
		let concurrency = config.max_concurrency;
		let idle = config.idle_timeout;
		let runtime = LocalRuntime::new(
			move || WhisperEngine::load(&config),
			memory,
			resident_bytes,
			concurrency,
			idle,
		)?;
		Ok(Self { runtime })
	}

	/// Transcribes mono 16 kHz floating-point PCM using Candle Whisper.
	pub fn transcribe_mono_16khz(
		&self,
		samples: &[f32],
		options: &TranscriptionOptions,
		cancel: &LocalCancellation,
	) -> LocalResult<Transcription> {
		if samples.is_empty() {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"transcription requires audio samples",
			));
		}
		if options
			.temperature
			.is_some_and(|temperature| !temperature.is_finite() || !(0.0..=1.0).contains(&temperature))
		{
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"transcription temperature must be in [0, 1]",
			));
		}
		let _serialized = STT_INFERENCE_LOCK.lock();
		let lease = self.runtime.acquire(cancel)?;
		let receipt = lease.receipt();
		let (text, segments, language) =
			lease.with_engine(|engine| transcribe_long_form(engine, samples, options, cancel))?;
		Ok(Transcription { text, segments, language, receipt })
	}

	/// Loads and validates the Whisper checkpoint ahead of first capture.
	pub fn prewarm(&self, cancel: &LocalCancellation) -> LocalResult<LocalExecutionReceipt> {
		self.runtime.prewarm(cancel)
	}

	/// Returns the blacklisted first-load failure, if loading has failed.
	pub fn load_failure(&self) -> Option<LocalError> {
		self.runtime.load_failure()
	}

	/// Clears the failure blacklist after explicit artifact/config repair.
	pub fn clear_load_failure(&self) -> bool {
		self.runtime.clear_load_failure()
	}

	/// Unloads the checkpoint when inactive for its configured interval.
	pub fn unload_if_idle(&self, now: Instant) -> bool {
		self.runtime.unload_if_idle(now)
	}

	/// Returns whether the Whisper checkpoint is resident.
	pub fn is_loaded(&self) -> bool {
		self.runtime.is_loaded()
	}
}

impl WhisperEngine {
	fn load(config: &WhisperConfig) -> LocalResult<Self> {
		let device = whisper_device(config.use_gpu)?;
		let config_text = std::fs::read_to_string(&config.config_path).map_err(|error| {
			LocalError::new(LocalErrorKind::Backend, format!("Whisper config load failed: {error}"))
		})?;
		let model_config: Config = serde_json::from_str(&config_text).map_err(|error| {
			LocalError::new(LocalErrorKind::Backend, format!("Whisper config parse failed: {error}"))
		})?;
		let tokenizer = Tokenizer::from_file(&config.tokenizer_path).map_err(|error| {
			LocalError::new(LocalErrorKind::Backend, format!("Whisper tokenizer load failed: {error}"))
		})?;
		// SAFETY: model_path is a verified, immutable safetensors artifact held by
		// the local artifact store for the lifetime of the loaded engine.
		let vb = unsafe {
			VarBuilder::from_mmaped_safetensors(
				&[config.model_path.as_path()],
				whisper::DTYPE,
				&device,
			)
		}
		.map_err(|error| {
			LocalError::new(LocalErrorKind::Backend, format!("Whisper load failed: {error}"))
		})?;
		let model = Whisper::load(&vb, model_config.clone()).map_err(|error| {
			LocalError::new(LocalErrorKind::Backend, format!("Whisper load failed: {error}"))
		})?;
		let token_id = |token: &str| whisper_token_id(&tokenizer, token);
		let sot_token = token_id(whisper::SOT_TOKEN)?;
		let transcribe_token = token_id(whisper::TRANSCRIBE_TOKEN)?;
		let translate_token = token_id(whisper::TRANSLATE_TOKEN)?;
		let eot_token = token_id(whisper::EOT_TOKEN)?;
		let no_timestamps_token = token_id(whisper::NO_TIMESTAMPS_TOKEN)?;
		let no_speech_token = whisper::NO_SPEECH_TOKENS
			.iter()
			.find_map(|token| token_id(token).ok())
			.ok_or_else(|| {
				LocalError::new(LocalErrorKind::Backend, "Whisper has no no-speech token")
			})?;
		let language_tokens = tokenizer
			.get_vocab(true)
			.into_iter()
			.filter_map(|(token, id)| {
				let code = token.strip_prefix("<|")?.strip_suffix("|>")?;
				(code.len() == 2 || code.len() == 3).then(|| (Str::new(code), id))
			})
			.collect::<Vec<_>>();
		if language_tokens.is_empty() {
			return Err(LocalError::new(
				LocalErrorKind::Backend,
				"Whisper tokenizer has no languages",
			));
		}
		let mut suppress = vec![0.0_f32; model_config.vocab_size];
		for token in &model_config.suppress_tokens {
			if let Some(value) = suppress.get_mut(*token as usize) {
				*value = f32::NEG_INFINITY;
			}
		}
		if let Some(value) = suppress.get_mut(no_timestamps_token as usize) {
			*value = f32::NEG_INFINITY;
		}
		let suppress_tokens = Tensor::new(suppress.as_slice(), &device).map_err(candle_error)?;
		Ok(Self {
			model,
			config: model_config.clone(),
			tokenizer,
			device,
			mel_filters: mel_filters(model_config.num_mel_bins),
			language_tokens,
			sot_token,
			transcribe_token,
			translate_token,
			eot_token,
			no_speech_token,
			no_timestamps_token,
			suppress_tokens,
		})
	}
}

fn whisper_device(use_gpu: bool) -> LocalResult<Device> {
	#[cfg(target_os = "macos")]
	if use_gpu {
		return Device::new_metal(0).map_err(candle_error);
	}
	let _ = use_gpu;
	Ok(Device::Cpu)
}

fn whisper_token_id(tokenizer: &Tokenizer, token: &str) -> LocalResult<u32> {
	tokenizer.token_to_id(token).ok_or_else(|| {
		LocalError::new(LocalErrorKind::Backend, format!("Whisper tokenizer lacks {token}"))
	})
}

fn candle_error(error: candle_core::Error) -> LocalError {
	LocalError::new(LocalErrorKind::Backend, format!("Whisper inference failed: {error}"))
}

fn transcribe_long_form(
	engine: &mut WhisperEngine,
	samples: &[f32],
	options: &TranscriptionOptions,
	cancel: &LocalCancellation,
) -> LocalResult<(Str, Vec<TranscriptionSegment>, Option<Str>)> {
	let mut text = String::new();
	let mut segments = Vec::new();
	let mut language = None;
	let mut start = 0_usize;
	while start < samples.len() {
		if cancel.is_cancelled() {
			return Err(LocalError::cancelled());
		}
		let end = start
			.saturating_add(WHISPER_WINDOW_SAMPLES)
			.min(samples.len());
		let skip = if start == 0 {
			Duration::ZERO
		} else {
			Duration::from_secs(5)
		};
		let (chunk_segments, detected) =
			transcribe_window(engine, &samples[start..end], options, cancel)?;
		if language.is_none() {
			language = detected;
		}
		let offset = Duration::from_secs_f64(start as f64 / SAMPLE_RATE as f64);
		for mut segment in chunk_segments {
			if segment.end <= skip {
				continue;
			}
			text.push_str(segment.text.as_str());
			if options.timestamps {
				segment.start = offset.saturating_add(segment.start);
				segment.end = offset.saturating_add(segment.end);
				segments.push(segment);
			}
		}
		if end == samples.len() {
			break;
		}
		start = start.saturating_add(WHISPER_WINDOW_SAMPLES - WHISPER_STRIDE_SAMPLES);
	}
	Ok((Str::new(text.trim()), segments, language))
}

fn transcribe_window(
	engine: &mut WhisperEngine,
	samples: &[f32],
	options: &TranscriptionOptions,
	cancel: &LocalCancellation,
) -> LocalResult<(Vec<TranscriptionSegment>, Option<Str>)> {
	if cancel.is_cancelled() {
		return Err(LocalError::cancelled());
	}
	let mel = audio::pcm_to_mel(&engine.config, samples, &engine.mel_filters);
	let frames = samples
		.len()
		.div_ceil(whisper::HOP_LENGTH)
		.clamp(1, whisper::N_FRAMES);
	let mel_frames = mel.len() / engine.config.num_mel_bins;
	let mel = Tensor::from_vec(mel, (1, engine.config.num_mel_bins, mel_frames), &engine.device)
		.map_err(candle_error)?;
	let mel = mel.narrow(2, 0, frames).map_err(candle_error)?;
	let language = match options.language.as_ref() {
		Some(language) => {
			whisper_token_id(&engine.tokenizer, &format!("<|{}|>", language.as_str()))?;
			Some(language.clone())
		},
		None => detect_language(engine, &mel, cancel)?,
	};
	let language_token = language
		.as_ref()
		.map(|language| whisper_token_id(&engine.tokenizer, &format!("<|{}|>", language.as_str())))
		.transpose()?;
	let decoded = greedy_decode(engine, &mel, language_token, options, cancel)?;
	let duration = Duration::from_secs_f64(samples.len() as f64 / SAMPLE_RATE as f64);
	Ok((segments_from_tokens(engine, decoded, duration)?, language))
}

fn detect_language(
	engine: &mut WhisperEngine,
	mel: &Tensor,
	cancel: &LocalCancellation,
) -> LocalResult<Option<Str>> {
	if cancel.is_cancelled() {
		return Err(LocalError::cancelled());
	}
	let audio_features = engine
		.model
		.encoder
		.forward(mel, true)
		.map_err(candle_error)?;
	let tokens = Tensor::new(&[engine.sot_token], &engine.device)
		.and_then(|tokens| tokens.unsqueeze(0))
		.map_err(candle_error)?;
	let ys = engine
		.model
		.decoder
		.forward(&tokens, &audio_features, true)
		.map_err(candle_error)?;
	let logits = engine
		.model
		.decoder
		.final_linear(&ys.i(..1).map_err(candle_error)?)
		.and_then(|logits| logits.i(0))
		.and_then(|logits| logits.i(0))
		.map_err(candle_error)?;
	let ids = engine
		.language_tokens
		.iter()
		.map(|(_, id)| *id)
		.collect::<Vec<_>>();
	let ids = Tensor::new(ids.as_slice(), &engine.device).map_err(candle_error)?;
	let probabilities = logits
		.index_select(&ids, 0)
		.and_then(|logits| softmax(&logits, 0))
		.and_then(|probabilities| probabilities.to_vec1::<f32>())
		.map_err(candle_error)?;
	let language = probabilities
		.iter()
		.enumerate()
		.max_by(|(_, left), (_, right)| left.total_cmp(right))
		.map(|(index, _)| engine.language_tokens[index].0.clone());
	Ok(language)
}

fn greedy_decode(
	engine: &mut WhisperEngine,
	mel: &Tensor,
	language_token: Option<u32>,
	options: &TranscriptionOptions,
	cancel: &LocalCancellation,
) -> LocalResult<DecodedWindow> {
	if cancel.is_cancelled() {
		return Err(LocalError::cancelled());
	}
	let audio_features = engine
		.model
		.encoder
		.forward(mel, true)
		.map_err(candle_error)?;
	let mut tokens = vec![engine.sot_token];
	if let Some(language_token) = language_token {
		tokens.push(language_token);
	}
	tokens.push(if options.translate {
		engine.translate_token
	} else {
		engine.transcribe_token
	});
	if let Some(prompt) = options.initial_prompt.as_ref() {
		let prompt = engine
			.tokenizer
			.encode(prompt.as_str(), false)
			.map_err(|error| {
				LocalError::new(
					LocalErrorKind::Backend,
					format!("Whisper prompt encode failed: {error}"),
				)
			})?;
		tokens.extend_from_slice(prompt.get_ids());
	}
	let prefix_len = tokens.len();
	let mut no_speech_probability = 0.0;
	for step in 0..(engine.config.max_target_positions / 2) {
		if cancel.is_cancelled() {
			return Err(LocalError::cancelled());
		}
		let input = Tensor::new(tokens.as_slice(), &engine.device)
			.and_then(|tokens| tokens.unsqueeze(0))
			.map_err(candle_error)?;
		let ys = engine
			.model
			.decoder
			.forward(&input, &audio_features, step == 0)
			.map_err(candle_error)?;
		if step == 0 {
			let logits = engine
				.model
				.decoder
				.final_linear(&ys.i(..1).map_err(candle_error)?)
				.and_then(|logits| logits.i(0))
				.and_then(|logits| logits.i(0))
				.map_err(candle_error)?;
			no_speech_probability = softmax(&logits, 0)
				.and_then(|probabilities| probabilities.i(engine.no_speech_token as usize))
				.and_then(|probability| probability.to_scalar::<f32>())
				.map_err(candle_error)?;
		}
		let (_, sequence_len, _) = ys.dims3().map_err(candle_error)?;
		let logits = engine
			.model
			.decoder
			.final_linear(&ys.i((..1, sequence_len - 1..)).map_err(candle_error)?)
			.and_then(|logits| logits.i(0))
			.and_then(|logits| logits.i(0))
			.map_err(candle_error)?
			.broadcast_add(&engine.suppress_tokens)
			.map_err(candle_error)?;
		let next = logits
			.to_vec1::<f32>()
			.map_err(candle_error)?
			.iter()
			.enumerate()
			.max_by(|(_, left), (_, right)| left.total_cmp(right))
			.map(|(index, _)| index as u32)
			.ok_or_else(|| LocalError::new(LocalErrorKind::Backend, "Whisper emitted no logits"))?;
		tokens.push(next);
		if next == engine.eot_token {
			break;
		}
	}
	Ok(DecodedWindow { tokens: tokens.split_off(prefix_len), no_speech_probability })
}

fn segments_from_tokens(
	engine: &WhisperEngine,
	decoded: DecodedWindow,
	duration: Duration,
) -> LocalResult<Vec<TranscriptionSegment>> {
	let timestamp_begin = engine.no_timestamps_token + 1;
	let mut segments = Vec::new();
	let mut text_tokens = Vec::new();
	let mut start = Duration::ZERO;
	for token in decoded.tokens {
		if token == engine.eot_token {
			break;
		}
		if token >= timestamp_begin {
			let end = Duration::from_millis((token - timestamp_begin) as u64 * 20);
			if !text_tokens.is_empty() {
				let text = decode_tokens(&engine.tokenizer, &text_tokens)?;
				if !text.is_empty() {
					segments.push(TranscriptionSegment {
						text: Str::new(text.trim()),
						start,
						end: end.min(duration),
						no_speech_probability: decoded.no_speech_probability,
					});
				}
				text_tokens.clear();
			}
			start = end.min(duration);
		} else {
			text_tokens.push(token);
		}
	}
	if !text_tokens.is_empty() {
		let text = decode_tokens(&engine.tokenizer, &text_tokens)?;
		if !text.is_empty() {
			segments.push(TranscriptionSegment {
				text: Str::new(text.trim()),
				start,
				end: duration,
				no_speech_probability: decoded.no_speech_probability,
			});
		}
	}
	Ok(segments)
}

fn decode_tokens(tokenizer: &Tokenizer, tokens: &[u32]) -> LocalResult<String> {
	tokenizer.decode(tokens, true).map_err(|error| {
		LocalError::new(LocalErrorKind::Backend, format!("Whisper text decode failed: {error}"))
	})
}

struct DecodedWindow {
	tokens:                Vec<u32>,
	no_speech_probability: f32,
}

/// Generates the Slaney-normalized filter bank used by Whisper's bundled mel
/// assets.
fn mel_filters(n_mels: usize) -> Vec<f32> {
	let mel = |hertz: f32| {
		if hertz >= 1_000.0 {
			15.0 + (hertz / 1_000.0).ln() / (6.4_f32.ln() / 27.0)
		} else {
			hertz / (200.0 / 3.0)
		}
	};
	let hertz = |mel: f32| {
		if mel >= 15.0 {
			1_000.0 * ((mel - 15.0) * 6.4_f32.ln() / 27.0).exp()
		} else {
			mel * (200.0 / 3.0)
		}
	};
	let min_mel = mel(0.0);
	let max_mel = mel(SAMPLE_RATE as f32 / 2.0);
	let points = (0..n_mels + 2)
		.map(|index| hertz(min_mel + (max_mel - min_mel) * index as f32 / (n_mels + 1) as f32))
		.collect::<Vec<_>>();
	let frequencies = (0..=whisper::N_FFT / 2)
		.map(|index| index as f32 * SAMPLE_RATE as f32 / whisper::N_FFT as f32)
		.collect::<Vec<_>>();
	let mut filters = vec![0.0; n_mels * frequencies.len()];
	for mel_index in 0..n_mels {
		let lower = points[mel_index];
		let center = points[mel_index + 1];
		let upper = points[mel_index + 2];
		let normalization = 2.0 / (upper - lower);
		for (frequency_index, frequency) in frequencies.iter().enumerate() {
			let lower_slope = (*frequency - lower) / (center - lower);
			let upper_slope = (upper - *frequency) / (upper - center);
			filters[mel_index * frequencies.len() + frequency_index] =
				lower_slope.min(upper_slope).max(0.0) * normalization;
		}
	}
	filters
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stale_presets_fall_back_to_parakeet() {
		assert_eq!(resolve_stt_preset(None), SttPreset::Parakeet);
		assert_eq!(resolve_stt_preset(Some("removed-model")), SttPreset::Parakeet);
		assert_eq!(resolve_stt_preset(Some("fast")), SttPreset::Fast);
	}

	#[test]
	fn whisper_long_form_window_is_thirty_seconds_with_five_second_stride() {
		assert_eq!(WHISPER_WINDOW_SAMPLES, 480_000);
		assert_eq!(WHISPER_STRIDE_SAMPLES, 80_000);
		assert_eq!(WHISPER_WINDOW_SAMPLES - WHISPER_STRIDE_SAMPLES, 400_000);
	}

	#[test]
	fn whisper_filter_shape_matches_model_inputs() {
		assert_eq!(mel_filters(80).len(), 80 * 201);
		assert_eq!(mel_filters(128).len(), 128 * 201);
	}
}
