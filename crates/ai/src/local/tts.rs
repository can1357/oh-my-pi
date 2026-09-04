//! Kokoro-82M-backed local speech synthesis.

/// Kokoro-82M model architecture and voice catalog.
pub mod kokoro;

use std::{
	collections::HashMap,
	fs,
	path::PathBuf,
	sync::{Arc, LazyLock},
	time::{Duration, Instant},
};

use candle_core::{DType, Device, IndexOp, Tensor};
use candle_nn::VarBuilder;
use omp_core::Str;
use parking_lot::Mutex;

use self::kokoro::{KModel, ModelConfig, SynthesisMode, catalog as kokoro_catalog};
use super::{
	artifact::ArtifactStore,
	runtime::{
		LocalCancellation, LocalError, LocalErrorKind, LocalExecutionReceipt, LocalResult,
		LocalRuntime, MemoryPool,
	},
	speech_catalog::SpeechArtifactManifests,
};
static TTS_INFERENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Accelerator requested for Kokoro.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KokoroDevice {
	/// Portable CPU execution.
	Cpu,
	/// Apple Metal execution.
	Metal,
}

/// Local files and lifecycle bounds for Kokoro-82M.
#[derive(Clone, Debug)]
pub struct KokoroConfig {
	/// Model JSON configuration path.
	pub config_path:     PathBuf,
	/// Model safetensors path.
	pub weights_path:    PathBuf,
	/// Voice-pack safetensors paths keyed by voice name.
	pub voices:          HashMap<Str, PathBuf>,
	/// Requested accelerator.
	pub device:          KokoroDevice,
	/// Estimated resident bytes charged before loading.
	pub resident_bytes:  usize,
	/// Admission limit; currently must be one because Kokoro access is
	/// serialized.
	pub max_concurrency: usize,
	/// Explicit idle-unload interval.
	pub idle_timeout:    Duration,
}

impl KokoroConfig {
	/// Verifies the canonical speech manifest and binds every engine path.
	///
	/// The manifest contains all twelve voices, so every later voice switch is
	/// a local tensor load and never an artifact download.
	pub fn from_verified_artifacts(
		store: &ArtifactStore,
		artifacts: &SpeechArtifactManifests,
		device: KokoroDevice,
		idle_timeout: Duration,
		cancel: &LocalCancellation,
	) -> LocalResult<Self> {
		let paths = artifacts.verified_kokoro_paths(store, cancel)?;
		let resident_bytes = usize::try_from(
			artifacts
				.kokoro_manifest()
				.total_bytes()
				.map_err(|_| LocalError::new(LocalErrorKind::Artifact, "invalid Kokoro manifest"))?,
		)
		.map_err(|_| {
			LocalError::new(LocalErrorKind::Overloaded, "Kokoro artifacts exceed address space")
		})?;
		let config_path = required_artifact(&paths, "config.json")?;
		let weights_path = required_artifact(&paths, "kokoro-v1_0.safetensors")?;
		let mut voices = HashMap::with_capacity(kokoro_catalog::VOICES.len());
		for voice in kokoro_catalog::VOICES {
			let filename = format!("{}.safetensors", voice.id);
			voices.insert(Str::new_static(voice.id), required_artifact(&paths, &filename)?);
		}
		Ok(Self {
			config_path,
			weights_path,
			voices,
			device,
			resident_bytes,
			max_concurrency: 1,
			idle_timeout,
		})
	}
}

/// Controls one synthesis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SynthesisOptions {
	/// Speaking-rate multiplier.
	pub speed:           f32,
	/// Maximum approximate characters per model pass.
	pub max_chunk_chars: usize,
	/// Removes decoder noise for repeatable output.
	pub deterministic:   bool,
}

impl Default for SynthesisOptions {
	fn default() -> Self {
		Self { speed: 1.0, max_chunk_chars: 400, deterministic: false }
	}
}

/// Complete mono PCM synthesis with evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct SynthesisOutput {
	/// Mono floating-point PCM samples.
	pub samples:     Vec<f32>,
	/// Sample rate declared by the model.
	pub sample_rate: u32,
	/// Local runtime receipt.
	pub receipt:     LocalExecutionReceipt,
}

/// Evidence returned after backpressured streaming synthesis.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamingSynthesisReceipt {
	/// Native sample rate of every emitted chunk.
	pub sample_rate: u32,
	/// Number of non-empty chunks emitted.
	pub chunks:      usize,
	/// Total number of mono samples emitted.
	pub samples:     usize,
	/// Serialized local-runtime execution evidence.
	pub receipt:     LocalExecutionReceipt,
}

/// One ordered line in a spoken dialog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpokenDialogTurn<'a> {
	/// Speakable text for this line.
	pub text:  &'a str,
	/// Optional voice override; absent and stale ids resolve to `af_heart`.
	pub voice: Option<&'a str>,
}

/// Aggregate evidence for an ordered, non-interleaved spoken dialog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpokenDialogReceipt {
	/// Number of dialog turns synthesized.
	pub turns:       usize,
	/// Number of PCM chunks emitted.
	pub chunks:      usize,
	/// Total number of mono samples emitted.
	pub samples:     usize,
	/// Native sample rate shared by all dialog turns.
	pub sample_rate: u32,
	/// Runtime evidence for the final serialized turn.
	pub receipt:     LocalExecutionReceipt,
}

struct KokoroEngine {
	model:       KModel,
	config:      ModelConfig,
	device:      Device,
	voices:      HashMap<Str, Tensor>,
	voice_paths: HashMap<Str, PathBuf>,
	g2p:         voice_g2p::G2P,
}

/// Lazy, bounded adapter over the workspace Kokoro engine.
#[derive(Clone)]
pub struct KokoroAdapter {
	runtime: LocalRuntime<KokoroEngine>,
}

impl KokoroAdapter {
	/// Creates a lazy adapter from local model and voice artifacts.
	pub fn new(config: KokoroConfig, memory: Arc<MemoryPool>) -> LocalResult<Self> {
		if kokoro_catalog::VOICES
			.iter()
			.any(|voice| !config.voices.contains_key(voice.id))
		{
			return Err(LocalError::new(
				LocalErrorKind::Artifact,
				"Kokoro artifact binding must include all registered voices",
			));
		}
		let resident = config.resident_bytes;
		let concurrency = config.max_concurrency;
		let idle = config.idle_timeout;
		let runtime = LocalRuntime::new(
			move || {
				let device = kokoro_device(config.device)?;
				let config_bytes = fs::read(&config.config_path).map_err(|error| {
					LocalError::new(
						LocalErrorKind::Artifact,
						format!("Kokoro config read failed: {error}"),
					)
				})?;
				let model_config: ModelConfig =
					serde_json::from_slice(&config_bytes).map_err(|error| {
						LocalError::new(
							LocalErrorKind::Artifact,
							format!("Kokoro config decode failed: {error}"),
						)
					})?;
				if model_config.sample_rate != kokoro_catalog::SAMPLE_RATE {
					return Err(LocalError::new(
						LocalErrorKind::Artifact,
						"Kokoro config declares an unexpected sample rate",
					));
				}
				// SAFETY: Candle owns each mapping for the lifetime of tensors built from it.
				let variables = unsafe {
					VarBuilder::from_mmaped_safetensors(&[&config.weights_path], DType::F32, &device)
				}
				.map_err(|error| {
					LocalError::new(LocalErrorKind::Backend, format!("Kokoro weights failed: {error}"))
				})?;
				let model = KModel::load(&model_config, variables).map_err(|error| {
					LocalError::new(LocalErrorKind::Backend, format!("Kokoro load failed: {error}"))
				})?;
				Ok(KokoroEngine {
					model,
					config: model_config,
					device,
					voices: HashMap::new(),
					voice_paths: config.voices.clone(),
					g2p: voice_g2p::G2P::new(),
				})
			},
			memory,
			resident,
			concurrency,
			idle,
		)?;
		Ok(Self { runtime })
	}

	/// Synthesizes text into one owned mono PCM buffer.
	pub fn synthesize(
		&self,
		text: &str,
		voice: &str,
		options: SynthesisOptions,
		cancel: &LocalCancellation,
	) -> LocalResult<SynthesisOutput> {
		let mut samples = Vec::new();
		let streamed =
			self.synthesize_streaming(text, voice, options, cancel, |chunk, _sample_rate| {
				samples.extend_from_slice(chunk);
				true
			})?;
		Ok(SynthesisOutput { samples, sample_rate: streamed.sample_rate, receipt: streamed.receipt })
	}

	/// Synthesizes chunk-by-chunk while holding the serialized model lease.
	///
	/// `on_chunk` is synchronous backpressure. Returning `false` stops
	/// synthesis with a cancellation result; already-delivered audio remains
	/// valid. A stale voice id resolves to `af_heart` before any local tensor
	/// access, matching the persisted-setting fallback.
	pub fn synthesize_streaming(
		&self,
		text: &str,
		voice: &str,
		options: SynthesisOptions,
		cancel: &LocalCancellation,
		on_chunk: impl FnMut(&[f32], u32) -> bool,
	) -> LocalResult<StreamingSynthesisReceipt> {
		let _serialized = TTS_INFERENCE_LOCK.lock();
		self.synthesize_streaming_locked(text, voice, options, cancel, on_chunk)
	}

	/// Synthesizes a complete dialog without allowing another synthesis to
	/// interleave between turns.
	pub fn synthesize_dialog(
		&self,
		turns: &[SpokenDialogTurn<'_>],
		options: SynthesisOptions,
		cancel: &LocalCancellation,
		mut on_chunk: impl FnMut(usize, &[f32], u32) -> bool,
	) -> LocalResult<SpokenDialogReceipt> {
		if turns.is_empty() {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"spoken dialog requires at least one turn",
			));
		}
		let _serialized = TTS_INFERENCE_LOCK.lock();
		let mut chunks = 0_usize;
		let mut samples = 0_usize;
		let mut final_receipt = None;
		for (turn_index, turn) in turns.iter().enumerate() {
			let synthesized = self.synthesize_streaming_locked(
				turn.text,
				turn.voice.unwrap_or(kokoro_catalog::DEFAULT_VOICE),
				options,
				cancel,
				|audio, sample_rate| on_chunk(turn_index, audio, sample_rate),
			)?;
			chunks = chunks.saturating_add(synthesized.chunks);
			samples = samples.saturating_add(synthesized.samples);
			final_receipt = Some(synthesized.receipt);
		}
		Ok(SpokenDialogReceipt {
			turns: turns.len(),
			chunks,
			samples,
			sample_rate: kokoro_catalog::SAMPLE_RATE,
			receipt: final_receipt.expect("non-empty dialog synthesized above"),
		})
	}

	fn synthesize_streaming_locked(
		&self,
		text: &str,
		voice: &str,
		options: SynthesisOptions,
		cancel: &LocalCancellation,
		mut on_chunk: impl FnMut(&[f32], u32) -> bool,
	) -> LocalResult<StreamingSynthesisReceipt> {
		validate_synthesis(text, options)?;
		let voice = kokoro_catalog::resolve_voice(Some(voice)).id;
		let lease = self.runtime.acquire(cancel)?;
		let receipt = lease.receipt();
		let mut chunks = 0_usize;
		let mut samples = 0_usize;
		let sample_rate = lease.with_engine(|engine| {
			let voice_tensor = load_voice(engine, voice)?;
			let sample_rate = engine.config.sample_rate;
			synthesize_text_streaming(engine, &voice_tensor, text, options, cancel, &mut |audio| {
				chunks += 1;
				samples = samples.saturating_add(audio.len());
				on_chunk(audio, sample_rate)
			})?;
			Ok(sample_rate)
		})?;
		Ok(StreamingSynthesisReceipt { sample_rate, chunks, samples, receipt })
	}

	/// Loads Kokoro and validates the model ahead of the first dialog.
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

	/// Unloads Kokoro when inactive for its configured interval.
	pub fn unload_if_idle(&self, now: Instant) -> bool {
		self.runtime.unload_if_idle(now)
	}

	/// Returns whether Kokoro is resident.
	pub fn is_loaded(&self) -> bool {
		self.runtime.is_loaded()
	}
}

fn required_artifact(paths: &[PathBuf], filename: &str) -> LocalResult<PathBuf> {
	paths
		.iter()
		.find(|path| {
			path
				.file_name()
				.is_some_and(|candidate| candidate == filename)
		})
		.cloned()
		.ok_or_else(|| {
			LocalError::new(LocalErrorKind::Artifact, "Kokoro manifest is missing a runtime file")
		})
}

fn load_voice(engine: &mut KokoroEngine, voice: &str) -> LocalResult<Tensor> {
	if !engine.voices.contains_key(voice) {
		let path = engine.voice_paths.get(voice).ok_or_else(|| {
			LocalError::new(LocalErrorKind::Artifact, "Kokoro manifest is missing a registered voice")
		})?;
		let tensors = candle_core::safetensors::load(path, &engine.device).map_err(|error| {
			LocalError::new(LocalErrorKind::Artifact, format!("Kokoro voice load failed: {error}"))
		})?;
		let tensor = tensors.into_values().next().ok_or_else(|| {
			LocalError::new(LocalErrorKind::Artifact, "Kokoro voice pack contains no tensors")
		})?;
		engine.voices.insert(Str::new(voice), tensor);
	}
	Ok(engine.voices.get(voice).expect("inserted above").clone())
}

fn kokoro_device(requested: KokoroDevice) -> LocalResult<Device> {
	match requested {
		KokoroDevice::Cpu => Ok(Device::Cpu),
		KokoroDevice::Metal => {
			#[cfg(target_os = "macos")]
			{
				Device::new_metal(0).map_err(|error| {
					LocalError::new(
						LocalErrorKind::Unsupported,
						format!("Metal is unavailable: {error}"),
					)
				})
			}
			#[cfg(not(target_os = "macos"))]
			{
				Err(LocalError::new(LocalErrorKind::Unsupported, "Metal requires macOS"))
			}
		},
	}
}

fn validate_synthesis(text: &str, options: SynthesisOptions) -> LocalResult<()> {
	if text.trim().is_empty() {
		return Err(LocalError::new(
			LocalErrorKind::InvalidInput,
			"speech synthesis requires non-empty text",
		));
	}
	if !options.speed.is_finite() || options.speed <= 0.0 || options.max_chunk_chars == 0 {
		return Err(LocalError::new(
			LocalErrorKind::InvalidInput,
			"synthesis speed and chunk size must be positive",
		));
	}
	Ok(())
}

fn synthesize_text_streaming(
	engine: &KokoroEngine,
	voice: &Tensor,
	text: &str,
	options: SynthesisOptions,
	cancel: &LocalCancellation,
	emit: &mut dyn FnMut(&[f32]) -> bool,
) -> LocalResult<()> {
	let mut emitted = false;
	for_each_text_chunk(text, options.max_chunk_chars, |chunk| {
		if cancel.is_cancelled() {
			return Err(LocalError::cancelled());
		}
		let phonemes = engine.g2p.convert(chunk).map_err(|error| {
			LocalError::new(LocalErrorKind::Backend, format!("Kokoro G2P failed: {error}"))
		})?;
		let mut encoded = [0_u8; 4];
		let token_ids: Vec<_> = phonemes
			.chars()
			.filter_map(|character| {
				engine
					.config
					.vocab
					.get(character.encode_utf8(&mut encoded))
					.copied()
			})
			.collect();
		if token_ids.is_empty() {
			return Ok(());
		}
		let pack_len = voice.dim(0).map_err(|error| {
			LocalError::new(LocalErrorKind::Artifact, format!("Kokoro voice shape failed: {error}"))
		})?;
		if pack_len == 0 {
			return Err(LocalError::new(LocalErrorKind::Artifact, "empty Kokoro voice pack"));
		}
		let style = voice
			.i((token_ids.len() - 1).min(pack_len - 1))
			.and_then(|tensor| tensor.squeeze(0))
			.and_then(|tensor| tensor.unsqueeze(0))
			.map_err(|error| {
				LocalError::new(LocalErrorKind::Artifact, format!("Kokoro voice style failed: {error}"))
			})?;
		let mode = if options.deterministic {
			SynthesisMode::Deterministic
		} else {
			SynthesisMode::Stochastic
		};
		let audio = engine
			.model
			.forward_with_mode(&token_ids, &style, options.speed, &engine.device, mode)
			.and_then(|tensor| tensor.to_vec1::<f32>())
			.map_err(|error| {
				LocalError::new(LocalErrorKind::Backend, format!("Kokoro inference failed: {error}"))
			})?;
		if audio.is_empty() {
			return Ok(());
		}
		emitted = true;
		if !emit(&audio) {
			return Err(LocalError::cancelled());
		}
		Ok(())
	})?;
	if !emitted {
		return Err(LocalError::new(LocalErrorKind::Backend, "text produced no supported phonemes"));
	}
	Ok(())
}

fn for_each_text_chunk<E>(
	text: &str,
	max_chars: usize,
	mut emit: impl FnMut(&str) -> Result<(), E>,
) -> Result<(), E> {
	let mut current = String::new();
	let mut count = 0;
	for word in text.split_whitespace() {
		let chars = word.chars().count();
		if count > 0 && count + 1 + chars > max_chars {
			emit(&current)?;
			current.clear();
			count = 0;
		}
		if chars > max_chars {
			for character in word.chars() {
				if count == max_chars {
					emit(&current)?;
					current.clear();
					count = 0;
				}
				current.push(character);
				count += 1;
			}
			continue;
		}
		if count > 0 {
			current.push(' ');
			count += 1;
		}
		current.push_str(word);
		count += chars;
	}
	if !current.trim().is_empty() {
		emit(current.trim())?;
	}
	Ok(())
}
