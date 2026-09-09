//! Pure-Rust Candle implementation of NVIDIA Parakeet TDT v3.
//!
//! The model format is the safetensors conversion published by
//! `mlx-community/parakeet-tdt-0.6b-v3`.  Its FastConformer encoder and TDT
//! transducer decoder are evaluated locally through Candle; no ONNX or native
//! runtime is involved.  Greedy TDT decoding exposes token-duration timing,
//! which is coalesced into one timestamped segment for each encoder chunk.

use std::{
	fs,
	path::PathBuf,
	sync::Arc,
	time::{Duration, Instant},
};

use candle_core::{DType, Device};
use candle_nn::VarBuilder;
use omp_core::Str;

use super::{
	artifact::ArtifactStore,
	runtime::{
		AvailabilityEvidence, LocalCancellation, LocalError, LocalErrorKind, LocalExecutionReceipt,
		LocalResult, LocalRuntime, MemoryPool,
	},
	speech_catalog::{SpeechArtifactManifests, SttPreset},
	stt::{STT_INFERENCE_LOCK, Transcription, TranscriptionOptions, TranscriptionSegment},
};

const SAMPLE_RATE: usize = 16_000;
const ENCODER_CHUNK_SAMPLES: usize = 30 * SAMPLE_RATE;

/// Verified files and lifecycle controls for Parakeet TDT v3.
#[derive(Clone, Debug)]
pub struct ParakeetConfig {
	/// Converted NeMo model configuration.
	pub config_path:     PathBuf,
	/// FastConformer, prediction, and joint-network safetensors.
	pub weights_path:    PathBuf,
	/// Indexed BPE vocabulary shipped alongside the conversion.
	pub vocab_path:      PathBuf,
	/// CPU worker count retained for the stable local-STT contract.
	pub threads:         usize,
	/// Estimated resident bytes charged before loading.
	pub resident_bytes:  usize,
	/// Admission limit; Candle inference is serialized.
	pub max_concurrency: usize,
	/// Explicit idle-unload interval.
	pub idle_timeout:    Duration,
}

impl ParakeetConfig {
	/// Verifies and binds the canonical Parakeet safetensors manifest.
	pub fn from_verified_artifacts(
		store: &ArtifactStore,
		artifacts: &SpeechArtifactManifests,
		threads: usize,
		idle_timeout: Duration,
		cancel: &LocalCancellation,
	) -> LocalResult<Self> {
		let paths = artifacts.verified_stt_paths(store, SttPreset::Parakeet, cancel)?;
		let resident_bytes = usize::try_from(
			artifacts
				.stt_manifest(SttPreset::Parakeet)
				.total_bytes()
				.map_err(|_| LocalError::new(LocalErrorKind::Artifact, "invalid Parakeet manifest"))?,
		)
		.map_err(|_| {
			LocalError::new(LocalErrorKind::Overloaded, "Parakeet artifacts exceed address space")
		})?;
		Ok(Self {
			config_path: required_path(&paths, "config.json")?,
			weights_path: required_path(&paths, "model.safetensors")?,
			vocab_path: required_path(&paths, "vocab.txt")?,
			threads,
			resident_bytes,
			max_concurrency: 1,
			idle_timeout,
		})
	}
}

/// Returns portable Candle support before a caller acquires artifacts.
pub fn availability() -> AvailabilityEvidence {
	AvailabilityEvidence::available("Parakeet uses the portable Candle backend")
}

struct ParakeetEngine {
	model: model::Model,
}

/// Lazy, serialized Candle adapter for NVIDIA Parakeet TDT v3.
#[derive(Clone)]
pub struct ParakeetAdapter {
	runtime: LocalRuntime<ParakeetEngine>,
}

impl ParakeetAdapter {
	/// Creates a lazy Candle-backed Parakeet recognizer.
	pub fn new(config: ParakeetConfig, memory: Arc<MemoryPool>) -> LocalResult<Self> {
		if config.threads == 0 {
			return Err(LocalError::new(
				LocalErrorKind::InvalidInput,
				"Parakeet thread count must be non-zero",
			));
		}
		let resident_bytes = config.resident_bytes;
		let max_concurrency = config.max_concurrency;
		let idle_timeout = config.idle_timeout;
		let runtime = LocalRuntime::new(
			move || load_engine(&config),
			memory,
			resident_bytes,
			max_concurrency,
			idle_timeout,
		)?;
		Ok(Self { runtime })
	}

	/// Transcribes mono 16 kHz floating-point PCM through Parakeet.
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
		let _serialized = STT_INFERENCE_LOCK.lock();
		let lease = self.runtime.acquire(cancel)?;
		let receipt = lease.receipt();
		let (text, segments, detected_language) = lease.with_engine(|engine| {
			let mut text = String::new();
			let mut segments = Vec::new();
			let mut detected_language = None;
			for (index, chunk) in samples.chunks(ENCODER_CHUNK_SAMPLES).enumerate() {
				if cancel.is_cancelled() {
					return Err(LocalError::cancelled());
				}
				let offset = index * ENCODER_CHUNK_SAMPLES;
				let tokens = engine
					.model
					.decode_samples(chunk, || cancel.is_cancelled())
					.map_err(|error| {
						if cancel.is_cancelled() {
							LocalError::cancelled()
						} else {
							LocalError::new(
								LocalErrorKind::Backend,
								format!("Parakeet inference failed: {error}"),
							)
						}
					})?;
				let (chunk_text, language) = detokenize(&tokens);
				if detected_language.is_none() {
					detected_language = language;
				}
				if !chunk_text.is_empty() {
					if !text.is_empty() {
						text.push(' ');
					}
					text.push_str(&chunk_text);
					if options.timestamps {
						let start = tokens
							.first()
							.map_or(offset as f64 / SAMPLE_RATE as f64, |token| {
								offset as f64 / SAMPLE_RATE as f64 + token.start
							});
						let end = tokens
							.last()
							.map_or((offset + chunk.len()) as f64 / SAMPLE_RATE as f64, |token| {
								offset as f64 / SAMPLE_RATE as f64 + token.end
							});
						segments.push(TranscriptionSegment {
							text:                  Str::new(&chunk_text),
							start:                 Duration::from_secs_f64(start),
							end:                   Duration::from_secs_f64(end.max(start)),
							no_speech_probability: 0.0,
						});
					}
				}
			}
			Ok((Str::new(text.trim()), segments, detected_language))
		})?;
		Ok(Transcription {
			text,
			segments,
			language: options.language.clone().or(detected_language),
			receipt,
		})
	}

	/// Loads and validates Parakeet ahead of first capture.
	pub fn prewarm(&self, cancel: &LocalCancellation) -> LocalResult<LocalExecutionReceipt> {
		self.runtime.prewarm(cancel)
	}

	/// Unloads Parakeet after its configured idle interval.
	pub fn unload_if_idle(&self, now: Instant) -> bool {
		self.runtime.unload_if_idle(now)
	}
}

fn load_engine(config: &ParakeetConfig) -> LocalResult<ParakeetEngine> {
	let config_bytes = fs::read(&config.config_path).map_err(|error| {
		LocalError::new(LocalErrorKind::Artifact, format!("Parakeet config read failed: {error}"))
	})?;
	let arguments = serde_json::from_slice::<model::TdtArgs>(&config_bytes).map_err(|error| {
		LocalError::new(LocalErrorKind::Artifact, format!("Parakeet config decode failed: {error}"))
	})?;
	if arguments.preprocessor.sample_rate != SAMPLE_RATE {
		return Err(LocalError::new(
			LocalErrorKind::Artifact,
			"Parakeet config declares an unsupported sample rate",
		));
	}
	let vocabulary = fs::read_to_string(&config.vocab_path).map_err(|error| {
		LocalError::new(LocalErrorKind::Artifact, format!("Parakeet vocabulary read failed: {error}"))
	})?;
	if vocabulary.lines().count() != arguments.joint.vocabulary.len() {
		return Err(LocalError::new(
			LocalErrorKind::Artifact,
			"Parakeet vocabulary does not match model config",
		));
	}
	let device = parakeet_device()?;
	let variables =
		unsafe { VarBuilder::from_mmaped_safetensors(&[&config.weights_path], DType::F32, &device) }
			.map_err(|error| {
				LocalError::new(LocalErrorKind::Artifact, format!("Parakeet weights failed: {error}"))
			})?;
	let model = model::Model::load(arguments, variables).map_err(|error| {
		LocalError::new(LocalErrorKind::Backend, format!("Parakeet load failed: {error}"))
	})?;
	Ok(ParakeetEngine { model })
}

fn parakeet_device() -> LocalResult<Device> {
	#[cfg(target_os = "macos")]
	{
		return Device::new_metal(0).map_err(|error| {
			LocalError::new(
				LocalErrorKind::Unsupported,
				format!("Parakeet Metal is unavailable: {error}"),
			)
		});
	}
	#[cfg(not(target_os = "macos"))]
	{
		Ok(Device::Cpu)
	}
}

fn detokenize(tokens: &[model::DecodedToken]) -> (String, Option<Str>) {
	let mut text = String::new();
	let mut language = None;
	for token in tokens {
		if let Some(code) = token
			.text
			.strip_prefix("<|")
			.and_then(|value| value.strip_suffix("|>"))
		{
			if code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_lowercase()) {
				language = Some(Str::new(code));
			}
			continue;
		}
		text.push_str(&token.text.replace('▁', " "));
	}
	(text.trim().to_owned(), language)
}

fn required_path(paths: &[PathBuf], filename: &str) -> LocalResult<PathBuf> {
	paths
		.iter()
		.find(|path| {
			path
				.file_name()
				.is_some_and(|candidate| candidate == filename)
		})
		.cloned()
		.ok_or_else(|| {
			LocalError::new(LocalErrorKind::Artifact, "Parakeet manifest is missing a runtime file")
		})
}

mod model {
	use candle_core::{D, Device, IndexOp, Result, Tensor};
	use candle_nn::VarBuilder;

	use super::{
		audio::{PreprocessArgs, get_logmel},
		conformer::{Conformer, ConformerArgs},
		rnnt::{JointArgs, JointNetwork, PredictArgs, PredictNetwork},
	};

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct GreedyConfig {
		#[serde(default)]
		max_symbols: Option<i64>,
	}

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct TdtDecodingArgs {
		model_type: String,
		durations:  Vec<usize>,
		#[serde(default)]
		greedy:     Option<GreedyConfig>,
	}

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct TdtArgs {
		pub preprocessor: PreprocessArgs,
		pub encoder:      ConformerArgs,
		pub decoder:      PredictArgs,
		pub joint:        JointArgs,
		pub decoding:     TdtDecodingArgs,
	}

	#[derive(Debug, Clone)]
	pub struct DecodedToken {
		pub text:  String,
		pub start: f64,
		pub end:   f64,
	}

	#[derive(Debug, Clone)]
	pub struct Model {
		preprocessor:  PreprocessArgs,
		encoder:       Conformer,
		decoder:       PredictNetwork,
		joint:         JointNetwork,
		vocabulary:    Vec<String>,
		durations:     Vec<usize>,
		max_symbols:   usize,
		frame_seconds: f64,
		device:        Device,
	}

	impl Model {
		pub fn load(args: TdtArgs, vb: VarBuilder) -> Result<Self> {
			if args.decoding.model_type != "tdt" || args.decoding.durations.is_empty() {
				return Err(candle_core::Error::Msg("Parakeet config is not a TDT model".to_owned()));
			}
			args.preprocessor.validate()?;
			let frame_seconds = args.encoder.subsampling_factor as f64
				* args.preprocessor.hop_length() as f64
				/ args.preprocessor.sample_rate as f64;
			let vocabulary = args.joint.vocabulary.clone();
			let encoder = Conformer::load(args.encoder, vb.pp("encoder"))?;
			let decoder = PredictNetwork::load(&args.decoder, vb.pp("decoder"))?;
			let joint = JointNetwork::load(&args.joint, vb.pp("joint"))?;
			let max_symbols = args
				.decoding
				.greedy
				.and_then(|greedy| greedy.max_symbols)
				.and_then(|count| usize::try_from(count).ok())
				.filter(|count| *count > 0)
				.unwrap_or(10);
			Ok(Self {
				preprocessor: args.preprocessor,
				encoder,
				decoder,
				joint,
				vocabulary,
				durations: args.decoding.durations,
				max_symbols,
				frame_seconds,
				device: vb.device().clone(),
			})
		}

		pub fn decode_samples(
			&mut self,
			samples: &[f32],
			cancelled: impl Fn() -> bool,
		) -> Result<Vec<DecodedToken>> {
			if cancelled() {
				return Err(candle_core::Error::Msg("Parakeet transcription cancelled".to_owned()));
			}
			let mel = get_logmel(samples, &self.preprocessor, &self.device)?;
			let (features, lengths) = self.encoder.forward(&mel, None)?;
			if cancelled() {
				return Err(candle_core::Error::Msg("Parakeet transcription cancelled".to_owned()));
			}
			let length = lengths
				.to_vec1::<i64>()?
				.first()
				.copied()
				.unwrap_or_default()
				.max(0) as usize;
			let features = features.narrow(0, 0, 1)?;
			let mut step = 0usize;
			let mut symbols = 0usize;
			let mut last = None;
			let mut hidden = None;
			let mut tokens = Vec::new();
			while step < length {
				if cancelled() {
					return Err(candle_core::Error::Msg("Parakeet transcription cancelled".to_owned()));
				}
				let (decoder_out, decoder_state) = match last {
					Some(token) => {
						let input = Tensor::from_vec(vec![token as i64], (1, 1), &self.device)?;
						self.decoder.forward(Some(&input), hidden.clone())?
					},
					None => self.decoder.forward(None, hidden.clone())?,
				};
				let encoder_frame = features.narrow(1, step, 1)?;
				let logits = self.joint.forward(&encoder_frame, &decoder_out)?;
				let vocab_size = self.vocabulary.len() + 1;
				let token_logits = logits.i((0, 0, 0, 0..vocab_size))?;
				let duration_logits = logits.i((0, 0, 0, vocab_size..))?;
				let token = token_logits.argmax(D::Minus1)?.to_vec0::<u32>()? as usize;
				let duration_index = (duration_logits.argmax(D::Minus1)?.to_vec0::<u32>()? as usize)
					.min(self.durations.len() - 1);
				let duration = self.durations[duration_index];
				if token != self.vocabulary.len() {
					if let Some(piece) = self.vocabulary.get(token) {
						tokens.push(DecodedToken {
							text:  piece.clone(),
							start: step as f64 * self.frame_seconds,
							end:   (step + duration.max(1)) as f64 * self.frame_seconds,
						});
					}
					last = Some(token);
					hidden = Some(decoder_state);
					symbols += 1;
				}
				if duration == 0 {
					if symbols >= self.max_symbols {
						step += 1;
						symbols = 0;
					}
				} else {
					step += duration;
					symbols = 0;
				}
			}
			Ok(tokens)
		}
	}
}

mod audio {
	use candle_core::{DType, Device, Result, Tensor};

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct PreprocessArgs {
		pub sample_rate:   usize,
		pub normalize:     String,
		pub window_size:   f64,
		pub window_stride: f64,
		pub window:        String,
		pub features:      usize,
		pub n_fft:         usize,
		pub dither:        f64,
		#[serde(default)]
		pub pad_to:        usize,
		#[serde(default)]
		pub pad_value:     f64,
		#[serde(default = "default_preemph")]
		pub preemph:       Option<f64>,
		#[serde(default = "default_mag_power")]
		pub mag_power:     f64,
	}

	fn default_preemph() -> Option<f64> {
		None
	}

	fn default_mag_power() -> f64 {
		2.0
	}

	impl PreprocessArgs {
		pub fn win_length(&self) -> usize {
			(self.window_size * self.sample_rate as f64) as usize
		}

		pub fn hop_length(&self) -> usize {
			(self.window_stride * self.sample_rate as f64) as usize
		}

		/// Validate that all fields have sensible values.
		/// Call after deserialization to catch invalid configs early.
		pub fn validate(&self) -> Result<()> {
			if self.sample_rate == 0 {
				return Err(candle_core::Error::Msg("sample_rate must be > 0".to_string()));
			}
			if self.window_size <= 0.0 {
				return Err(candle_core::Error::Msg("window_size must be > 0".to_string()));
			}
			if self.window_stride <= 0.0 {
				return Err(candle_core::Error::Msg("window_stride must be > 0".to_string()));
			}
			if self.n_fft == 0 || !self.n_fft.is_power_of_two() {
				return Err(candle_core::Error::Msg("n_fft must be a positive power of 2".to_string()));
			}
			if self.features == 0 {
				return Err(candle_core::Error::Msg("features must be > 0".to_string()));
			}
			Ok(())
		}
	}

	fn hz_to_mel(freq: f64) -> f64 {
		let f_sp = 200.0 / 3.0;
		let min_log_hz = 1000.0;
		let min_log_mel = min_log_hz / f_sp;
		let logstep = (6.4f64).ln() / 27.0;
		if freq < min_log_hz {
			freq / f_sp
		} else {
			min_log_mel + (freq / min_log_hz).ln() / logstep
		}
	}

	fn mel_to_hz(mel: f64) -> f64 {
		let f_sp = 200.0 / 3.0;
		let min_log_hz = 1000.0;
		let min_log_mel = min_log_hz / f_sp;
		let logstep = (6.4f64).ln() / 27.0;
		if mel < min_log_mel {
			f_sp * mel
		} else {
			min_log_hz * (logstep * (mel - min_log_mel)).exp()
		}
	}

	fn mel_filterbank(sr: usize, n_fft: usize, n_mels: usize) -> Vec<f32> {
		let fmin = 0.0;
		let fmax = sr as f64 / 2.0;
		let mel_min = hz_to_mel(fmin);
		let mel_max = hz_to_mel(fmax);

		let mut mel_points = Vec::with_capacity(n_mels + 2);
		for i in 0..(n_mels + 2) {
			let t = i as f64 / (n_mels + 1) as f64;
			mel_points.push(mel_min + (mel_max - mel_min) * t);
		}

		let hz_points: Vec<f64> = mel_points.into_iter().map(mel_to_hz).collect();
		let bins: Vec<usize> = hz_points
			.iter()
			.map(|&hz| ((n_fft + 1) as f64 * hz / sr as f64).floor() as usize)
			.collect();

		let n_fft_bins = n_fft / 2 + 1;
		let mut filters = vec![0f32; n_mels * n_fft_bins];
		for m in 0..n_mels {
			let f_m_minus = bins[m];
			let f_m = bins[m + 1];
			let f_m_plus = bins[m + 2];

			if f_m_minus == f_m || f_m == f_m_plus {
				continue;
			}

			for k in f_m_minus..f_m {
				if k < n_fft_bins {
					filters[m * n_fft_bins + k] =
						(k as f64 - f_m_minus as f64) as f32 / (f_m as f64 - f_m_minus as f64) as f32;
				}
			}
			for k in f_m..f_m_plus {
				if k < n_fft_bins {
					filters[m * n_fft_bins + k] =
						(f_m_plus as f64 - k as f64) as f32 / (f_m_plus as f64 - f_m as f64) as f32;
				}
			}
		}

		// Slaney-style normalization
		for m in 0..n_mels {
			let f_m_minus = hz_points[m];
			let f_m_plus = hz_points[m + 2];
			let enorm = 2.0 / (f_m_plus - f_m_minus).max(1e-6);
			for k in 0..n_fft_bins {
				filters[m * n_fft_bins + k] *= enorm as f32;
			}
		}

		filters
	}

	/// Compute the FFT of `inp`. Non-power-of-2 lengths are zero-padded to the
	/// next power of 2 so the recursive radix-2 path is always used (O(n log
	/// n)).
	fn fft(inp: &[f32]) -> Vec<f32> {
		let n = inp.len();
		if n == 0 {
			return vec![];
		}
		if n == 1 {
			return vec![inp[0], 0.0];
		}
		let n_padded = n.next_power_of_two();
		if n_padded != n {
			let mut padded = vec![0f32; n_padded];
			padded[..n].copy_from_slice(inp);
			return fft_radix2(&padded);
		}
		fft_radix2(inp)
	}

	/// Radix-2 Cooley-Tukey FFT. Input length MUST be a power of 2.
	fn fft_radix2(inp: &[f32]) -> Vec<f32> {
		let n = inp.len();
		debug_assert!(n.is_power_of_two(), "fft_radix2 requires power-of-2 length");
		if n == 1 {
			return vec![inp[0], 0.0];
		}
		let mut out = vec![0f32; n * 2];

		let mut even = Vec::with_capacity(n / 2);
		let mut odd = Vec::with_capacity(n / 2);

		for (i, &value) in inp.iter().enumerate() {
			if i % 2 == 0 {
				even.push(value);
			} else {
				odd.push(value);
			}
		}

		let even_fft = fft_radix2(&even);
		let odd_fft = fft_radix2(&odd);

		let two_pi = std::f32::consts::PI * 2.0;
		let n_t = n as f32;
		for k in 0..n / 2 {
			let k_t = k as f32;
			let theta = two_pi * k_t / n_t;
			let re = theta.cos();
			let im = -theta.sin();

			let re_odd = odd_fft[2 * k];
			let im_odd = odd_fft[2 * k + 1];

			out[2 * k] = even_fft[2 * k] + re * re_odd - im * im_odd;
			out[2 * k + 1] = even_fft[2 * k + 1] + re * im_odd + im * re_odd;

			out[2 * (k + n / 2)] = even_fft[2 * k] - re * re_odd + im * im_odd;
			out[2 * (k + n / 2) + 1] = even_fft[2 * k + 1] - re * im_odd - im * re_odd;
		}
		out
	}

	fn window_values(kind: &str, len: usize) -> Vec<f32> {
		match kind {
			// Periodic form: 2π·i/N (matches torch.hann_window(periodic=True) / NeMo)
			"hann" | "hanning" => (0..len)
				.map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / len as f32).cos())
				.collect(),
			"hamming" => (0..len)
				.map(|i| 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / len as f32).cos())
				.collect(),
			"blackman" => (0..len)
				.map(|i| {
					0.42 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / len as f32).cos()
						+ 0.08 * (4.0 * std::f32::consts::PI * i as f32 / len as f32).cos()
				})
				.collect(),
			"bartlett" => (0..len)
				.map(|i| {
					let v = (i as f32 - (len as f32 - 1.0) / 2.0).abs();
					1.0 - v / ((len as f32 - 1.0) / 2.0)
				})
				.collect(),
			_ => vec![1.0; len],
		}
	}

	fn reflect_pad(samples: &[f32], pad: usize) -> Vec<f32> {
		if samples.is_empty() || pad == 0 {
			return samples.to_vec();
		}
		if samples.len() < 2 {
			let mut out = Vec::with_capacity(samples.len() + 2 * pad);
			out.extend(std::iter::repeat_n(samples[0], pad));
			out.extend_from_slice(samples);
			out.extend(std::iter::repeat_n(samples[0], pad));
			return out;
		}
		let mut out = Vec::with_capacity(samples.len() + 2 * pad);
		let prefix = samples[1..=pad.min(samples.len() - 1)]
			.iter()
			.rev()
			.cloned();
		let suffix = samples[samples.len().saturating_sub(pad + 1)..samples.len() - 1]
			.iter()
			.rev()
			.cloned();
		out.extend(prefix);
		out.extend_from_slice(samples);
		out.extend(suffix);
		out
	}

	pub fn get_logmel(samples: &[f32], args: &PreprocessArgs, device: &Device) -> Result<Tensor> {
		let mut audio = samples.to_vec();
		if args.pad_to > 0 && audio.len() < args.pad_to {
			audio.resize(args.pad_to, args.pad_value as f32);
		}

		let _ = args.dither;
		if let Some(preemph) = args.preemph {
			let mut emphasized = Vec::with_capacity(audio.len());
			emphasized.push(audio[0]);
			for i in 1..audio.len() {
				emphasized.push(audio[i] - preemph as f32 * audio[i - 1]);
			}
			audio = emphasized;
		}
		let win_length = args.win_length();
		let hop_length = args.hop_length();
		let n_fft = args.n_fft;

		let window = window_values(&args.window, win_length);
		let pad = n_fft / 2;
		let padded = reflect_pad(&audio, pad);

		let frame_count = if padded.len() < win_length {
			0
		} else {
			(padded.len() - win_length + hop_length) / hop_length
		};

		let n_fft_bins = n_fft / 2 + 1;
		let filters = mel_filterbank(args.sample_rate, n_fft, args.features);

		let mut mel = vec![0f32; args.features * frame_count];
		for frame in 0..frame_count {
			let start = frame * hop_length;
			let mut frame_buf = vec![0f32; n_fft];
			let slice = &padded[start..start + win_length];
			for (i, &v) in slice.iter().enumerate() {
				frame_buf[i] = v * window[i];
			}

			let fft_out = fft(&frame_buf);
			let mut mags = vec![0f32; n_fft_bins];
			for k in 0..n_fft_bins {
				let re = fft_out[2 * k];
				let im = fft_out[2 * k + 1];
				let mut mag = re.hypot(im);
				if (args.mag_power - 1.0).abs() > f64::EPSILON {
					mag = mag.powf(args.mag_power as f32);
				}
				mags[k] = mag;
			}

			for mel_idx in 0..args.features {
				let mut sum = 0.0f32;
				let filter_offset = mel_idx * n_fft_bins;
				for k in 0..n_fft_bins {
					sum += filters[filter_offset + k] * mags[k];
				}
				mel[mel_idx * frame_count + frame] = (sum + 1e-5).ln();
			}
		}

		if args.normalize == "per_feature" {
			for mel_idx in 0..args.features {
				let offset = mel_idx * frame_count;
				let slice = &mel[offset..offset + frame_count];
				let mean = slice.iter().sum::<f32>() / frame_count.max(1) as f32;
				let var =
					slice.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / frame_count.max(1) as f32;
				let std = var.sqrt();
				for v in &mut mel[offset..offset + frame_count] {
					*v = (*v - mean) / (std + 1e-5);
				}
			}
		} else {
			let mean = mel.iter().sum::<f32>() / mel.len().max(1) as f32;
			let var = mel.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / mel.len().max(1) as f32;
			let std = var.sqrt();
			for v in &mut mel {
				*v = (*v - mean) / (std + 1e-5);
			}
		}

		// shape: (features, frames) -> (frames, features)
		let mut mel_t = vec![0f32; mel.len()];
		for mel_idx in 0..args.features {
			for frame in 0..frame_count {
				mel_t[frame * args.features + mel_idx] = mel[mel_idx * frame_count + frame];
			}
		}

		let mel_tensor = Tensor::from_vec(mel_t, (frame_count, args.features), device)?
			.to_dtype(DType::F32)?
			.unsqueeze(0)?;
		Ok(mel_tensor)
	}
}

#[allow(
	dead_code,
	reason = "the FastConformer cache path is retained for streaming-compatible model evaluation"
)]
mod cache {
	use candle_core::{Result, Tensor};

	pub trait CacheLike {
		fn offset(&self) -> usize;
		fn update_and_fetch_kv(&mut self, keys: Tensor, values: Tensor) -> Result<(Tensor, Tensor)>;
		fn update_and_fetch_conv(&mut self, x: &Tensor, padding: usize) -> Result<Tensor>;
	}

	#[derive(Debug, Clone, Default)]
	pub struct ConformerCache {
		pub keys:   Option<Tensor>,
		pub values: Option<Tensor>,
		pub conv:   Option<Tensor>,
		pub offset: usize,
	}

	impl ConformerCache {
		pub fn new() -> Self {
			Self { keys: None, values: None, conv: None, offset: 0 }
		}

		pub fn update_and_fetch_kv(
			&mut self,
			keys: Tensor,
			values: Tensor,
		) -> Result<(Tensor, Tensor)> {
			let (_, _, s, _) = keys.dims4()?;
			if let (Some(k), Some(v)) = (&self.keys, &self.values) {
				let new_k = Tensor::cat(&[k, &keys], 2)?;
				let new_v = Tensor::cat(&[v, &values], 2)?;
				self.keys = Some(new_k);
				self.values = Some(new_v);
			} else {
				self.keys = Some(keys);
				self.values = Some(values);
			}
			self.offset += s;
			Ok((self.keys.as_ref().unwrap().clone(), self.values.as_ref().unwrap().clone()))
		}

		pub fn update_and_fetch_conv(&mut self, x: &Tensor, padding: usize) -> Result<Tensor> {
			if padding == 0 {
				return Ok(x.clone());
			}
			let (_, s, _) = x.dims3()?;
			let device = x.device();
			let dtype = x.dtype();

			let conv_cache = if let Some(cache) = &self.conv {
				cache.clone()
			} else {
				Tensor::zeros((x.dims3()?.0, padding, x.dims3()?.2), dtype, device)?
			};

			let tokens_to_cache = padding.min(s);
			let cache_update = x.narrow(1, s - tokens_to_cache, tokens_to_cache)?;
			let new_cache = if tokens_to_cache < padding {
				let trimmed = conv_cache.narrow(1, tokens_to_cache, padding - tokens_to_cache)?;
				Tensor::cat(&[&trimmed, &cache_update], 1)?
			} else {
				cache_update
			};

			self.conv = Some(new_cache.clone());
			// Causal: prepend cached left context, no right-padding
			let result = Tensor::cat(&[&new_cache, x], 1)?;
			Ok(result)
		}
	}

	impl CacheLike for ConformerCache {
		fn offset(&self) -> usize {
			self.offset
		}

		fn update_and_fetch_kv(&mut self, keys: Tensor, values: Tensor) -> Result<(Tensor, Tensor)> {
			ConformerCache::update_and_fetch_kv(self, keys, values)
		}

		fn update_and_fetch_conv(&mut self, x: &Tensor, padding: usize) -> Result<Tensor> {
			ConformerCache::update_and_fetch_conv(self, x, padding)
		}
	}

	#[derive(Debug, Clone)]
	pub struct RotatingConformerCache {
		pub keys:        Option<Tensor>,
		pub values:      Option<Tensor>,
		pub conv:        Option<Tensor>,
		pub offset:      usize,
		capacity:        usize,
		cache_drop_size: usize,
	}

	impl RotatingConformerCache {
		pub fn new(capacity: usize, cache_drop_size: usize) -> Self {
			Self { keys: None, values: None, conv: None, offset: 0, capacity, cache_drop_size }
		}

		pub fn update_and_fetch_kv(
			&mut self,
			keys: Tensor,
			values: Tensor,
		) -> Result<(Tensor, Tensor)> {
			let (_, _, s, _) = keys.dims4()?;
			let drop = self.cache_drop_size.min(s);
			let to_cache = s.saturating_sub(drop).min(self.capacity);

			// Save previous cache state before mutation for building output
			let prev_keys = self.keys.clone();
			let prev_values = self.values.clone();

			let new_kv = if to_cache > 0 {
				let start = s - drop - to_cache;
				let k_chunk = keys.narrow(2, start, to_cache)?;
				let v_chunk = values.narrow(2, start, to_cache)?;
				if let (Some(k), Some(v)) = (&self.keys, &self.values) {
					let k_cat = Tensor::cat(&[k, &k_chunk], 2)?;
					let v_cat = Tensor::cat(&[v, &v_chunk], 2)?;
					let k_trim = if k_cat.dims4()?.2 > self.capacity {
						let start = k_cat.dims4()?.2 - self.capacity;
						k_cat.narrow(2, start, self.capacity)?
					} else {
						k_cat
					};
					let v_trim = if v_cat.dims4()?.2 > self.capacity {
						let start = v_cat.dims4()?.2 - self.capacity;
						v_cat.narrow(2, start, self.capacity)?
					} else {
						v_cat
					};
					(k_trim, v_trim)
				} else {
					(k_chunk, v_chunk)
				}
			} else {
				(
					self
						.keys
						.clone()
						.unwrap_or_else(|| keys.narrow(2, 0, 0).unwrap()),
					self
						.values
						.clone()
						.unwrap_or_else(|| values.narrow(2, 0, 0).unwrap()),
				)
			};

			self.keys = Some(new_kv.0);
			self.values = Some(new_kv.1);
			self.offset += to_cache;

			// Output: previous cache (before this update) + current input keys
			let k_out = if let Some(k) = &prev_keys {
				Tensor::cat(&[k, &keys], 2)?
			} else {
				keys
			};
			let v_out = if let Some(v) = &prev_values {
				Tensor::cat(&[v, &values], 2)?
			} else {
				values
			};

			Ok((k_out, v_out))
		}

		pub fn update_and_fetch_conv(&mut self, x: &Tensor, padding: usize) -> Result<Tensor> {
			if padding == 0 {
				return Ok(x.clone());
			}

			let (_, s, _) = x.dims3()?;
			let device = x.device();
			let dtype = x.dtype();

			let conv_cache = if let Some(cache) = &self.conv {
				cache.clone()
			} else {
				Tensor::zeros((x.dims3()?.0, padding, x.dims3()?.2), dtype, device)?
			};

			let mut new_cache = conv_cache;
			if s > self.cache_drop_size {
				let tokens_to_cache = padding.min(s - self.cache_drop_size);
				let cache_update = x.narrow(1, s - tokens_to_cache, tokens_to_cache)?;
				new_cache = if tokens_to_cache < padding {
					let trimmed = new_cache.narrow(1, tokens_to_cache, padding - tokens_to_cache)?;
					Tensor::cat(&[&trimmed, &cache_update], 1)?
				} else {
					cache_update
				};
			}

			self.conv = Some(new_cache.clone());
			// Causal: prepend cached left context, no right-padding
			let result = Tensor::cat(&[&new_cache, x], 1)?;
			Ok(result)
		}
	}

	impl CacheLike for RotatingConformerCache {
		fn offset(&self) -> usize {
			self.offset
		}

		fn update_and_fetch_kv(&mut self, keys: Tensor, values: Tensor) -> Result<(Tensor, Tensor)> {
			RotatingConformerCache::update_and_fetch_kv(self, keys, values)
		}

		fn update_and_fetch_conv(&mut self, x: &Tensor, padding: usize) -> Result<Tensor> {
			RotatingConformerCache::update_and_fetch_conv(self, x, padding)
		}
	}
}

mod attention {
	use candle_core::{D, DType, Device, Result, Tensor};
	use candle_nn::{Linear, Module, VarBuilder, ops::softmax_last_dim};

	use super::cache::CacheLike;

	#[derive(Debug, Clone)]
	pub struct MultiHeadAttention {
		q_proj:   Linear,
		k_proj:   Linear,
		v_proj:   Linear,
		out_proj: Linear,
		n_head:   usize,
		head_dim: usize,
	}

	impl MultiHeadAttention {
		pub fn load(n_head: usize, n_feat: usize, bias: bool, vb: VarBuilder) -> Result<Self> {
			let q_proj = if bias {
				candle_nn::linear(n_feat, n_feat, vb.pp("linear_q"))?
			} else {
				candle_nn::linear_no_bias(n_feat, n_feat, vb.pp("linear_q"))?
			};
			let k_proj = if bias {
				candle_nn::linear(n_feat, n_feat, vb.pp("linear_k"))?
			} else {
				candle_nn::linear_no_bias(n_feat, n_feat, vb.pp("linear_k"))?
			};
			let v_proj = if bias {
				candle_nn::linear(n_feat, n_feat, vb.pp("linear_v"))?
			} else {
				candle_nn::linear_no_bias(n_feat, n_feat, vb.pp("linear_v"))?
			};
			let out_proj = if bias {
				candle_nn::linear(n_feat, n_feat, vb.pp("linear_out"))?
			} else {
				candle_nn::linear_no_bias(n_feat, n_feat, vb.pp("linear_out"))?
			};
			Ok(Self { q_proj, k_proj, v_proj, out_proj, n_head, head_dim: n_feat / n_head })
		}

		pub fn forward(
			&self,
			q: &Tensor,
			k: &Tensor,
			v: &Tensor,
			mask: Option<&Tensor>,
			cache: Option<&mut dyn CacheLike>,
		) -> Result<Tensor> {
			let q = self.q_proj.forward(q)?;
			let k = self.k_proj.forward(k)?;
			let v = self.v_proj.forward(v)?;
			let (b, tq, _) = q.dims3()?;
			let (_, tk, _) = k.dims3()?;

			let q = q
				.reshape((b, tq, self.n_head, self.head_dim))?
				.transpose(1, 2)?;
			let mut k = k
				.reshape((b, tk, self.n_head, self.head_dim))?
				.transpose(1, 2)?;
			let mut v = v
				.reshape((b, tk, self.n_head, self.head_dim))?
				.transpose(1, 2)?;

			if let Some(cache) = cache {
				let (k_cached, v_cached) = cache.update_and_fetch_kv(k, v)?;
				k = k_cached;
				v = v_cached;
			}
			let v = v.contiguous()?;

			let scale = (self.head_dim as f64).powf(-0.5);
			let q = (&q * scale)?;
			let k_t = k.transpose(2, 3)?;
			let mut scores = q.matmul(&k_t)?;
			if let Some(mask) = mask {
				scores = scores.broadcast_add(mask)?;
			}
			let attn = softmax_last_dim(&scores)?;
			let out = attn.matmul(&v)?;
			let out = out
				.transpose(1, 2)?
				.reshape((b, tq, self.n_head * self.head_dim))?;
			self.out_proj.forward(&out)
		}
	}

	#[derive(Debug, Clone)]
	pub struct RelPositionMultiHeadAttention {
		inner:      MultiHeadAttention,
		linear_pos: Linear,
		pos_bias_u: Tensor,
		pos_bias_v: Tensor,
	}

	impl RelPositionMultiHeadAttention {
		pub fn load(n_head: usize, n_feat: usize, bias: bool, vb: VarBuilder) -> Result<Self> {
			let inner = MultiHeadAttention::load(n_head, n_feat, bias, vb.clone())?;
			let linear_pos = candle_nn::linear_no_bias(n_feat, n_feat, vb.pp("linear_pos"))?;
			let pos_bias_u = vb.get((n_head, n_feat / n_head), "pos_bias_u")?;
			let pos_bias_v = vb.get((n_head, n_feat / n_head), "pos_bias_v")?;
			Ok(Self { inner, linear_pos, pos_bias_u, pos_bias_v })
		}

		fn rel_shift(x: Tensor) -> Result<Tensor> {
			let (b, h, tq, pos_len) = x.dims4()?;
			let x = x.pad_with_zeros(D::Minus1, 1, 0)?;
			let x = x.reshape((b, h, pos_len + 1, tq))?;
			let x = x.narrow(2, 1, pos_len)?;
			x.reshape((b, h, tq, pos_len))
		}

		pub fn forward(
			&self,
			q: &Tensor,
			k: &Tensor,
			v: &Tensor,
			pos_emb: &Tensor,
			mask: Option<&Tensor>,
			cache: Option<&mut dyn CacheLike>,
		) -> Result<Tensor> {
			let q_proj = self.inner.q_proj.forward(q)?;
			let k_proj = self.inner.k_proj.forward(k)?;
			let v_proj = self.inner.v_proj.forward(v)?;
			let p_proj = self.linear_pos.forward(pos_emb)?;

			let (b, tq, _) = q_proj.dims3()?;
			let (_, tk, _) = k_proj.dims3()?;
			let (_, pos_len, _) = p_proj.dims3()?;

			let q = q_proj.reshape((b, tq, self.inner.n_head, self.inner.head_dim))?;
			let q_u = q
				.broadcast_add(&self.pos_bias_u.reshape((
					1,
					1,
					self.inner.n_head,
					self.inner.head_dim,
				))?)?
				.transpose(1, 2)?
				.contiguous()?;
			let q_v = q
				.broadcast_add(&self.pos_bias_v.reshape((
					1,
					1,
					self.inner.n_head,
					self.inner.head_dim,
				))?)?
				.transpose(1, 2)?
				.contiguous()?;

			let mut k = k_proj
				.reshape((b, tk, self.inner.n_head, self.inner.head_dim))?
				.transpose(1, 2)?;
			let mut v = v_proj
				.reshape((b, tk, self.inner.n_head, self.inner.head_dim))?
				.transpose(1, 2)?;
			let p = p_proj
				.reshape((b, pos_len, self.inner.n_head, self.inner.head_dim))?
				.transpose(1, 2)?;

			if let Some(cache) = cache {
				let (k_cached, v_cached) = cache.update_and_fetch_kv(k, v)?;
				k = k_cached;
				v = v_cached;
			}
			let v = v.contiguous()?;

			let scale = (self.inner.head_dim as f64).powf(-0.5);
			let k_t = k.transpose(2, 3)?.contiguous()?;
			let mut matrix_ac = q_u.matmul(&k_t)?;
			let matrix_bd = {
				let p_t = p.transpose(2, 3)?.contiguous()?;
				let bd = q_v.matmul(&p_t)?;
				Self::rel_shift(bd)?
			};
			let mut matrix_bd = matrix_bd;
			let k_len = k.dims4()?.2;
			if matrix_bd.dims4()?.3 > k_len {
				matrix_bd = matrix_bd.narrow(3, 0, k_len)?;
			}

			matrix_ac = (&matrix_ac * scale)?;
			matrix_bd = (&matrix_bd * scale)?;
			let mut scores = matrix_ac.broadcast_add(&matrix_bd)?;
			if let Some(mask) = mask {
				scores = scores.broadcast_add(mask)?;
			}

			let attn = softmax_last_dim(&scores)?;
			let out = attn.matmul(&v)?;
			let out =
				out.transpose(1, 2)?
					.reshape((b, tq, self.inner.n_head * self.inner.head_dim))?;
			self.inner.out_proj.forward(&out)
		}
	}

	#[derive(Debug, Clone)]
	pub struct RelPositionalEncoding {
		d_model: usize,
		max_len: usize,
		scale:   f64,
		pe:      Tensor,
	}

	impl RelPositionalEncoding {
		pub fn new(
			d_model: usize,
			max_len: usize,
			scale_input: bool,
			device: &Device,
		) -> Result<Self> {
			let scale = if scale_input {
				(d_model as f64).sqrt()
			} else {
				1.0
			};
			let pe = Self::build_pe(d_model, max_len, device)?;
			Ok(Self { d_model, max_len, scale, pe })
		}

		fn build_pe(d_model: usize, max_len: usize, device: &Device) -> Result<Tensor> {
			let len = 2 * max_len - 1;
			let mut data = vec![0f32; len * d_model];
			let mut div_term = Vec::with_capacity(d_model / 2);
			for i in 0..(d_model / 2) {
				let exp = -((10000.0f64).ln() / d_model as f64) * (2 * i) as f64;
				div_term.push(exp.exp() as f32);
			}
			for idx in 0..len {
				let position = (max_len - 1) as i32 - idx as i32;
				let pos_f = position as f32;
				for i in 0..(d_model / 2) {
					let v = pos_f * div_term[i];
					data[idx * d_model + 2 * i] = v.sin();
					data[idx * d_model + 2 * i + 1] = v.cos();
				}
			}
			Tensor::from_vec(data, (1, len, d_model), device)?.to_dtype(DType::F32)
		}

		pub fn forward(&mut self, x: &Tensor, offset: usize) -> Result<(Tensor, Tensor)> {
			let (_, seq_len, _) = x.dims3()?;
			let input_len = seq_len + offset;
			if input_len > self.max_len {
				self.max_len = input_len + 1;
				self.pe = Self::build_pe(self.d_model, self.max_len, x.device())?;
			}
			let x = (x * self.scale)?;
			let buffer_len = self.pe.dims3()?.1;
			let center = buffer_len / 2;
			let start_idx = center.saturating_sub(input_len - 1);
			let end_idx = (center + input_len).min(buffer_len);
			let pos_emb = self.pe.narrow(1, start_idx, end_idx - start_idx)?;
			Ok((x, pos_emb))
		}
	}
}

#[allow(
	dead_code,
	reason = "the FastConformer keeps configuration and cache entry points needed by its model port"
)]
mod conformer {
	use candle_core::{D, DType, ModuleT, Result, Tensor};
	use candle_nn::{
		BatchNorm, Conv1d, Conv1dConfig, Conv2d, Conv2dConfig, LayerNorm, Linear, Module, VarBuilder,
	};

	use super::{
		attention::{MultiHeadAttention, RelPositionMultiHeadAttention, RelPositionalEncoding},
		cache::{CacheLike, ConformerCache},
	};

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct ConformerArgs {
		pub feat_in: usize,
		pub n_layers: usize,
		pub d_model: usize,
		pub n_heads: usize,
		pub ff_expansion_factor: usize,
		pub subsampling_factor: usize,
		pub self_attention_model: String,
		pub subsampling: String,
		pub conv_kernel_size: usize,
		pub subsampling_conv_channels: usize,
		pub pos_emb_max_len: usize,
		#[serde(default)]
		pub causal_downsampling: bool,
		#[serde(default = "default_true")]
		pub use_bias: bool,
		#[serde(default)]
		pub xscaling: bool,
		#[serde(default)]
		pub pos_bias_u: Option<Vec<f32>>,
		#[serde(default)]
		pub pos_bias_v: Option<Vec<f32>>,
		#[serde(default = "default_subsampling_conv_chunking_factor")]
		pub subsampling_conv_chunking_factor: isize,
		#[serde(default)]
		pub att_context_size: Option<Vec<i64>>,
	}

	fn default_true() -> bool {
		true
	}

	fn default_subsampling_conv_chunking_factor() -> isize {
		1
	}

	/// Try to load a tensor from a VarBuilder, returning None if the tensor is
	/// not found. Unlike matching on error message strings, this treats any
	/// load failure for the specific tensor as "not present" -- the caller is
	/// expected to have a fallback path.
	fn try_get_tensor<S: Into<candle_core::Shape>>(
		vb: &VarBuilder,
		shape: S,
		name: &str,
	) -> Option<Tensor> {
		vb.get(shape, name).ok()
	}

	fn layer_norm(size: usize, vb: VarBuilder) -> Result<LayerNorm> {
		candle_nn::layer_norm(
			size,
			candle_nn::LayerNormConfig { eps: 1e-5, remove_mean: true, affine: true },
			vb,
		)
	}

	#[derive(Debug, Clone)]
	struct FeedForward {
		linear1: Linear,
		linear2: Linear,
	}

	impl FeedForward {
		fn load(d_model: usize, d_ff: usize, vb: VarBuilder) -> Result<Self> {
			fn load_linear_maybe_bias(
				in_dim: usize,
				out_dim: usize,
				vb: VarBuilder,
			) -> Result<Linear> {
				let weight = vb.get((out_dim, in_dim), "weight")?;
				let bias = try_get_tensor(&vb, (out_dim,), "bias");
				Ok(Linear::new(weight, bias))
			}

			let linear1 = load_linear_maybe_bias(d_model, d_ff, vb.pp("linear1"))?;
			let linear2 = load_linear_maybe_bias(d_ff, d_model, vb.pp("linear2"))?;
			Ok(Self { linear1, linear2 })
		}

		fn forward(&self, x: &Tensor) -> Result<Tensor> {
			let x = self.linear1.forward(x)?;
			let x = x.silu()?;
			self.linear2.forward(&x)
		}
	}

	#[derive(Debug, Clone)]
	struct Convolution {
		pointwise_conv1: Conv1d,
		depthwise_conv:  Conv1d,
		batch_norm:      BatchNorm,
		pointwise_conv2: Conv1d,
		padding:         usize,
		causal_padding:  usize,
	}

	impl Convolution {
		fn load(args: &ConformerArgs, vb: VarBuilder) -> Result<Self> {
			fn load_conv1d_weight(
				vb: &VarBuilder,
				name: &str,
				out_ch: usize,
				in_ch: usize,
				k: usize,
			) -> Result<Tensor> {
				if let Ok(weight) = vb.get((out_ch, in_ch, k), name) {
					return Ok(weight);
				}
				let weight = vb.get((out_ch, k, in_ch), name)?;
				weight.permute((0, 2, 1))
			}

			let padding = (args.conv_kernel_size - 1) / 2;
			let cfg_pw = Conv1dConfig {
				padding:        0,
				stride:         1,
				groups:         1,
				dilation:       1,
				cudnn_fwd_algo: None,
			};
			let cfg_dw = Conv1dConfig {
				padding:        0,
				stride:         1,
				groups:         args.d_model,
				dilation:       1,
				cudnn_fwd_algo: None,
			};
			let pw1_w =
				load_conv1d_weight(&vb, "pointwise_conv1.weight", args.d_model * 2, args.d_model, 1)?;
			let pw1_b = try_get_tensor(&vb, (args.d_model * 2,), "pointwise_conv1.bias");
			let pointwise_conv1 = Conv1d::new(pw1_w, pw1_b, cfg_pw);

			let dw_w = load_conv1d_weight(
				&vb,
				"depthwise_conv.weight",
				args.d_model,
				1,
				args.conv_kernel_size,
			)?;
			let dw_b = try_get_tensor(&vb, (args.d_model,), "depthwise_conv.bias");
			let depthwise_conv = Conv1d::new(dw_w, dw_b, cfg_dw);

			let batch_norm = candle_nn::batch_norm(args.d_model, 1e-5, vb.pp("batch_norm"))?;

			let pw2_w =
				load_conv1d_weight(&vb, "pointwise_conv2.weight", args.d_model, args.d_model, 1)?;
			let pw2_b = try_get_tensor(&vb, (args.d_model,), "pointwise_conv2.bias");
			let pointwise_conv2 = Conv1d::new(pw2_w, pw2_b, cfg_pw);

			let causal_padding = args.conv_kernel_size - 1;

			Ok(Self {
				pointwise_conv1,
				depthwise_conv,
				batch_norm,
				pointwise_conv2,
				padding,
				causal_padding,
			})
		}

		fn forward(&self, x: &Tensor, cache: Option<&mut dyn CacheLike>) -> Result<Tensor> {
			let mut x = x.transpose(1, 2)?; // (B, C, T)
			x = self.pointwise_conv1.forward(&x)?; // (B, 2C, T)
			x = x.transpose(1, 2)?; // (B, T, 2C)
			let (_, _, c2) = x.dims3()?;
			let c = c2 / 2;
			let a = x.narrow(2, 0, c)?;
			let b_part = x.narrow(2, c, c)?;
			let gate = candle_nn::ops::sigmoid(&b_part)?;
			let mut x = (&a * &gate)?;

			if let Some(cache) = cache {
				x = cache.update_and_fetch_conv(&x, self.causal_padding)?;
			} else if self.padding > 0 {
				x = x.pad_with_zeros(D::Minus2, self.padding, self.padding)?;
			}

			x = x.transpose(1, 2)?; // (B, C, T)
			x = self.depthwise_conv.forward(&x)?;
			x = self.batch_norm.forward_t(&x, false)?;
			x = x.silu()?;
			x = self.pointwise_conv2.forward(&x)?;
			x.transpose(1, 2)
		}
	}

	#[derive(Debug, Clone)]
	enum SelfAttention {
		RelPos { attn: RelPositionMultiHeadAttention, local_context: Option<(usize, usize)> },
		Normal(MultiHeadAttention),
	}

	#[derive(Debug, Clone)]
	struct ConformerBlock {
		norm_ff1:      LayerNorm,
		ff1:           FeedForward,
		norm_self_att: LayerNorm,
		self_attn:     SelfAttention,
		norm_conv:     LayerNorm,
		conv:          Convolution,
		norm_ff2:      LayerNorm,
		ff2:           FeedForward,
		norm_out:      LayerNorm,
	}

	fn build_local_attn_mask(
		q_len: usize,
		k_len: usize,
		offset: usize,
		left: usize,
		right: usize,
		device: &candle_core::Device,
	) -> Result<Tensor> {
		let mut data = vec![0f32; q_len * k_len];
		for i in 0..q_len {
			let center = i + offset;
			let start = center.saturating_sub(left);
			let end = (center + right).min(k_len.saturating_sub(1));
			for j in 0..k_len {
				if j < start || j > end {
					data[i * k_len + j] = f32::NEG_INFINITY;
				}
			}
		}
		Tensor::from_vec(data, (1, 1, q_len, k_len), device)
	}

	impl ConformerBlock {
		fn load(args: &ConformerArgs, vb: VarBuilder) -> Result<Self> {
			let ff_hidden_dim = args.d_model * args.ff_expansion_factor;
			let norm_ff1 = layer_norm(args.d_model, vb.pp("norm_feed_forward1"))?;
			let ff1 = FeedForward::load(args.d_model, ff_hidden_dim, vb.pp("feed_forward1"))?;

			let norm_self_att = layer_norm(args.d_model, vb.pp("norm_self_att"))?;
			let self_attn = match args.self_attention_model.as_str() {
				"rel_pos" | "rel_pos_local_attn" => SelfAttention::RelPos {
					attn:          RelPositionMultiHeadAttention::load(
						args.n_heads,
						args.d_model,
						args.use_bias,
						vb.pp("self_attn"),
					)?,
					local_context: if args.self_attention_model == "rel_pos_local_attn" {
						args.att_context_size.as_ref().and_then(|v| {
							if v.len() == 2 && v[0] >= 0 && v[1] >= 0 {
								Some((v[0] as usize, v[1] as usize))
							} else {
								None
							}
						})
					} else {
						None
					},
				},
				_ => SelfAttention::Normal(MultiHeadAttention::load(
					args.n_heads,
					args.d_model,
					true,
					vb.pp("self_attn"),
				)?),
			};

			let norm_conv = layer_norm(args.d_model, vb.pp("norm_conv"))?;
			let conv = Convolution::load(args, vb.pp("conv"))?;

			let norm_ff2 = layer_norm(args.d_model, vb.pp("norm_feed_forward2"))?;
			let ff2 = FeedForward::load(args.d_model, ff_hidden_dim, vb.pp("feed_forward2"))?;

			let norm_out = layer_norm(args.d_model, vb.pp("norm_out"))?;

			Ok(Self {
				norm_ff1,
				ff1,
				norm_self_att,
				self_attn,
				norm_conv,
				conv,
				norm_ff2,
				ff2,
				norm_out,
			})
		}

		fn set_attention_model(&mut self, name: &str, context_size: Option<(usize, usize)>) {
			if let SelfAttention::RelPos { local_context, .. } = &mut self.self_attn {
				if name == "rel_pos_local_attn" {
					*local_context = context_size;
				} else {
					*local_context = None;
				}
			}
		}

		fn forward(
			&self,
			x: &Tensor,
			pos_emb: Option<&Tensor>,
			mut cache: Option<&mut dyn CacheLike>,
		) -> Result<Tensor> {
			let mut x = x.clone();
			let ff1 = self.ff1.forward(&self.norm_ff1.forward(&x)?)?;
			x = (&x + &(&ff1 * 0.5)?)?;

			let x_norm = self.norm_self_att.forward(&x)?;
			let attn_out = if let Some(cache) = cache.as_deref_mut() {
				match &self.self_attn {
					SelfAttention::RelPos { attn, local_context } => {
						let pos_emb = pos_emb
							.ok_or_else(|| candle_core::Error::Msg("pos_emb required".to_string()))?;
						let mask = if let Some(&(left, right)) = local_context.as_ref() {
							let q_len = x_norm.dims3()?.1;
							let k_len = cache.offset() + q_len;
							let offset = k_len.saturating_sub(q_len);
							Some(build_local_attn_mask(q_len, k_len, offset, left, right, x.device())?)
						} else {
							None
						};
						attn.forward(&x_norm, &x_norm, &x_norm, pos_emb, mask.as_ref(), Some(cache))?
					},
					SelfAttention::Normal(attn) => {
						attn.forward(&x_norm, &x_norm, &x_norm, None, Some(cache))?
					},
				}
			} else {
				match &self.self_attn {
					SelfAttention::RelPos { attn, local_context } => {
						let pos_emb = pos_emb
							.ok_or_else(|| candle_core::Error::Msg("pos_emb required".to_string()))?;
						let mask = if let Some(&(left, right)) = local_context.as_ref() {
							let q_len = x_norm.dims3()?.1;
							Some(build_local_attn_mask(q_len, q_len, 0, left, right, x.device())?)
						} else {
							None
						};
						attn.forward(&x_norm, &x_norm, &x_norm, pos_emb, mask.as_ref(), None)?
					},
					SelfAttention::Normal(attn) => {
						attn.forward(&x_norm, &x_norm, &x_norm, None, None)?
					},
				}
			};

			x = (&x + &attn_out)?;
			let norm_x = self.norm_conv.forward(&x)?;
			let conv_out = self.conv.forward(&norm_x, cache)?;
			x = (&x + &conv_out)?;
			let ff2 = self.ff2.forward(&self.norm_ff2.forward(&x)?)?;
			x = (&x + &(&ff2 * 0.5)?)?;
			self.norm_out.forward(&x)
		}
	}

	#[derive(Debug, Clone)]
	struct DwStridingSubsampling {
		conv:         Vec<Conv2d>,
		out:          Linear,
		stride:       usize,
		kernel_size:  usize,
		padding:      usize,
		sampling_num: usize,
	}

	impl DwStridingSubsampling {
		fn load(args: &ConformerArgs, vb: VarBuilder) -> Result<Self> {
			fn try_load_conv2d_weight(
				vb: &VarBuilder,
				name: &str,
				out_ch: usize,
				in_ch: usize,
				k: usize,
			) -> Result<Tensor> {
				if let Ok(weight) = vb.get((out_ch, in_ch, k, k), name) {
					return Ok(weight);
				}
				let weight = vb.get((out_ch, k, k, in_ch), name)?;
				weight.permute((0, 3, 1, 2))
			}

			fn load_conv2d_weight(
				vb: &VarBuilder,
				primary: &str,
				alt: Option<&str>,
				out_ch: usize,
				in_ch: usize,
				k: usize,
			) -> Result<Tensor> {
				if let Ok(weight) = try_load_conv2d_weight(vb, primary, out_ch, in_ch, k) {
					return Ok(weight);
				}
				if let Some(alt) = alt {
					return try_load_conv2d_weight(vb, alt, out_ch, in_ch, k);
				}
				try_load_conv2d_weight(vb, primary, out_ch, in_ch, k)
			}

			fn load_conv_bias(
				vb: &VarBuilder,
				primary: &str,
				alt: Option<&str>,
				channels: usize,
			) -> Result<Tensor> {
				if let Ok(bias) = vb.get((channels,), primary) {
					return Ok(bias);
				}
				if let Some(alt) = alt {
					return vb.get((channels,), alt);
				}
				vb.get((channels,), primary)
			}

			let sampling_num = (args.subsampling_factor as f64).log2() as usize;
			let stride = 2;
			let kernel_size = 3;
			let padding = (kernel_size - 1) / 2;

			let mut conv = Vec::new();
			let mut in_channels = 1;
			let mut final_freq_dim = args.feat_in;
			for _ in 0..sampling_num {
				final_freq_dim = ((final_freq_dim + 2 * padding - kernel_size) / stride) + 1;
			}
			let cfg = Conv2dConfig { padding, stride, groups: 1, dilation: 1, cudnn_fwd_algo: None };
			let first_w = load_conv2d_weight(
				&vb,
				"conv.0.weight",
				None,
				args.subsampling_conv_channels,
				in_channels,
				kernel_size,
			)?;
			let first_b = load_conv_bias(&vb, "conv.0.bias", None, args.subsampling_conv_channels)?;
			conv.push(Conv2d::new(first_w, Some(first_b), cfg));
			in_channels = args.subsampling_conv_channels;

			for i in 0..(sampling_num - 1) {
				let dw_name = format!("conv.{}", 2 + i * 3);
				let dw_w = load_conv2d_weight(
					&vb,
					format!("{dw_name}.weight").as_str(),
					Some(dw_name.as_str()),
					in_channels,
					1,
					kernel_size,
				)?;
				let dw_b = load_conv_bias(
					&vb,
					format!("{dw_name}.bias").as_str(),
					Some(dw_name.as_str()),
					in_channels,
				)?;
				let dw_cfg = Conv2dConfig {
					padding,
					stride,
					groups: in_channels,
					dilation: 1,
					cudnn_fwd_algo: None,
				};
				conv.push(Conv2d::new(dw_w, Some(dw_b), dw_cfg));

				let pw_name = format!("conv.{}", 2 + i * 3 + 1);
				let pw_w = load_conv2d_weight(
					&vb,
					format!("{pw_name}.weight").as_str(),
					Some(pw_name.as_str()),
					args.subsampling_conv_channels,
					in_channels,
					1,
				)?;
				let pw_b = load_conv_bias(
					&vb,
					format!("{pw_name}.bias").as_str(),
					Some(pw_name.as_str()),
					args.subsampling_conv_channels,
				)?;
				let pw_cfg = Conv2dConfig {
					padding:        0,
					stride:         1,
					groups:         1,
					dilation:       1,
					cudnn_fwd_algo: None,
				};
				conv.push(Conv2d::new(pw_w, Some(pw_b), pw_cfg));
			}

			let out = candle_nn::linear(
				args.subsampling_conv_channels * final_freq_dim,
				args.d_model,
				vb.pp("out"),
			)?;

			Ok(Self { conv, out, stride, kernel_size, padding, sampling_num })
		}

		fn forward(&self, x: &Tensor, lengths: &Tensor) -> Result<(Tensor, Tensor)> {
			let mut lengths = lengths.to_dtype(DType::F32)?;
			for _ in 0..self.sampling_num {
				lengths = (&lengths + (2 * self.padding) as f64)?;
				lengths = (&lengths - self.kernel_size as f64)?;
				lengths = (&lengths / self.stride as f64)?;
				lengths = lengths.floor()?;
				lengths = (&lengths + 1.0)?;
			}
			lengths = lengths.to_dtype(DType::I64)?;

			let mut x = x.unsqueeze(1)?; // (B, 1, T, F)
			for (idx, conv) in self.conv.iter().enumerate() {
				x = conv.forward(&x)?;
				if idx == 0 || idx % 2 == 0 {
					x = x.relu()?;
				}
			}
			let x = x.transpose(1, 2)?; // (B, T, C, F)
			let (b, t, c, f) = x.dims4()?;
			let x = x.reshape((b, t, c * f))?;
			let x = self.out.forward(&x)?;
			Ok((x, lengths))
		}
	}

	#[derive(Debug, Clone)]
	enum PreEncode {
		Subsampling(DwStridingSubsampling),
		Linear(Linear),
	}

	#[derive(Debug, Clone)]
	pub struct Conformer {
		pub args:   ConformerArgs,
		pos_enc:    Option<RelPositionalEncoding>,
		pre_encode: PreEncode,
		layers:     Vec<ConformerBlock>,
	}

	impl Conformer {
		pub fn load(args: ConformerArgs, vb: VarBuilder) -> Result<Self> {
			let device = vb.device().clone();
			let pos_enc = match args.self_attention_model.as_str() {
				"rel_pos" | "rel_pos_local_attn" => Some(RelPositionalEncoding::new(
					args.d_model,
					args.pos_emb_max_len,
					args.xscaling,
					&device,
				)?),
				_ => None,
			};

			let pre_encode = if args.subsampling_factor > 1 {
				if args.subsampling == "dw_striding" && !args.causal_downsampling {
					PreEncode::Subsampling(DwStridingSubsampling::load(&args, vb.pp("pre_encode"))?)
				} else {
					return Err(candle_core::Error::Msg("unsupported subsampling type".to_string()));
				}
			} else {
				PreEncode::Linear(candle_nn::linear(args.feat_in, args.d_model, vb.pp("pre_encode"))?)
			};

			let mut layers = Vec::with_capacity(args.n_layers);
			for i in 0..args.n_layers {
				layers.push(ConformerBlock::load(&args, vb.pp(format!("layers.{i}")))?);
			}

			Ok(Self { args, pos_enc, pre_encode, layers })
		}

		pub fn set_attention_model(&mut self, name: &str, context_size: Option<(usize, usize)>) {
			if name == "rel_pos_local_attn" {
				for layer in &mut self.layers {
					layer.set_attention_model(name, context_size);
				}
			} else {
				for layer in &mut self.layers {
					layer.set_attention_model(name, None);
				}
			}
		}

		pub fn num_layers(&self) -> usize {
			self.layers.len()
		}

		pub fn forward(&mut self, x: &Tensor, lengths: Option<&Tensor>) -> Result<(Tensor, Tensor)> {
			self.forward_inner::<ConformerCache>(x, lengths, None)
		}

		pub fn forward_with_cache<C: CacheLike>(
			&mut self,
			x: &Tensor,
			lengths: Option<&Tensor>,
			cache: &mut [C],
		) -> Result<(Tensor, Tensor)> {
			self.forward_inner::<C>(x, lengths, Some(cache))
		}

		fn forward_inner<C: CacheLike>(
			&mut self,
			x: &Tensor,
			lengths: Option<&Tensor>,
			mut cache: Option<&mut [C]>,
		) -> Result<(Tensor, Tensor)> {
			let lengths = if let Some(lengths) = lengths {
				lengths.clone()
			} else {
				let b = x.dims3()?.0;
				let len = x.dims3()?.1 as i64;
				Tensor::from_vec(vec![len; b], (b,), x.device())?
			};

			let (mut x, out_lengths) = match &self.pre_encode {
				PreEncode::Subsampling(pre) => pre.forward(x, &lengths)?,
				PreEncode::Linear(linear) => (linear.forward(x)?, lengths),
			};

			let mut pos_emb = None;
			if let Some(pos_enc) = &mut self.pos_enc {
				let offset = cache
					.as_ref()
					.and_then(|c| c.first().map(|c| c.offset()))
					.unwrap_or(0);
				let (x_scaled, pos) = pos_enc.forward(&x, offset)?;
				x = x_scaled;
				pos_emb = Some(pos);
			}

			if let Some(cache) = cache.as_mut() {
				for (layer, cache) in self.layers.iter().zip(cache.iter_mut()) {
					x = layer.forward(&x, pos_emb.as_ref(), Some(cache))?;
				}
			} else {
				for layer in &self.layers {
					x = layer.forward(&x, pos_emb.as_ref(), None)?;
				}
			}

			Ok((x, out_lengths))
		}
	}
}

mod rnnt {
	use candle_core::{D, DType, Result, Tensor};
	use candle_nn::{Embedding, Linear, Module, VarBuilder};

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct PredictNetworkArgs {
		pub pred_hidden:     usize,
		pub pred_rnn_layers: usize,
		#[serde(default)]
		pub rnn_hidden_size: Option<i64>,
	}

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct JointNetworkArgs {
		pub joint_hidden:   usize,
		pub activation:     String,
		pub encoder_hidden: usize,
		pub pred_hidden:    usize,
	}

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct PredictArgs {
		pub blank_as_pad: bool,
		pub vocab_size:   usize,
		pub prednet:      PredictNetworkArgs,
	}

	#[derive(Debug, Clone, serde::Deserialize)]
	pub struct JointArgs {
		pub num_classes:       usize,
		pub vocabulary:        Vec<String>,
		pub jointnet:          JointNetworkArgs,
		#[serde(default)]
		pub num_extra_outputs: usize,
	}

	#[derive(Debug, Clone)]
	struct LstmLayer {
		w_ih: Tensor,
		w_hh: Tensor,
		b_ih: Tensor,
		b_hh: Tensor,
	}

	impl LstmLayer {
		fn load(
			input_size: usize,
			hidden_size: usize,
			layer_idx: usize,
			vb: VarBuilder,
		) -> Result<Self> {
			fn try_get_weight(
				vb: &VarBuilder,
				name: &str,
				out_dim: usize,
				in_dim: usize,
			) -> Option<Tensor> {
				if let Ok(w) = vb.get((out_dim, in_dim), name) {
					return Some(w);
				}
				if let Ok(w) = vb.get((in_dim, out_dim), name) {
					return w.t().ok();
				}
				None
			}

			fn load_weight(
				vb_layer: &VarBuilder,
				vb_root: &VarBuilder,
				vb_nemo: &VarBuilder,
				base: &str,
				layer_idx: usize,
				out_dim: usize,
				in_dim: usize,
			) -> Result<Tensor> {
				let layer_name = format!("{base}_l{layer_idx}");
				let nemo_name = match base {
					"weight_ih" => Some("Wx"),
					"weight_hh" => Some("Wh"),
					_ => None,
				};
				let candidates = [
					(vb_layer, base),
					(vb_layer, layer_name.as_str()),
					(vb_root, layer_name.as_str()),
					(vb_root, base),
				];
				for (vb, name) in candidates {
					if let Some(w) = try_get_weight(vb, name, out_dim, in_dim) {
						return Ok(w);
					}
				}
				if let Some(name) = nemo_name
					&& let Some(w) = try_get_weight(vb_nemo, name, out_dim, in_dim)
				{
					return Ok(w);
				}
				Err(candle_core::Error::Msg(format!("missing lstm weight {base} (layer {layer_idx})")))
			}

			fn load_bias(
				vb_layer: &VarBuilder,
				vb_root: &VarBuilder,
				vb_nemo: &VarBuilder,
				base: &str,
				layer_idx: usize,
				size: usize,
				alt: Option<&str>,
			) -> Result<Tensor> {
				let layer_name = format!("{base}_l{layer_idx}");
				let candidates = [
					(vb_layer, base),
					(vb_layer, layer_name.as_str()),
					(vb_root, layer_name.as_str()),
					(vb_root, base),
				];
				for (vb, name) in candidates {
					if let Ok(bias) = vb.get((size,), name) {
						return Ok(bias);
					}
				}
				if let Some(name) = alt
					&& let Ok(bias) = vb_nemo.get((size,), name)
				{
					return Ok(bias);
				}
				Tensor::zeros((size,), vb_root.dtype(), vb_root.device())
			}

			let vb_layer = vb.pp(format!("layer_{layer_idx}"));
			let vb_nemo = vb.pp("lstm").pp(format!("{layer_idx}"));
			let w_ih = load_weight(
				&vb_layer,
				&vb,
				&vb_nemo,
				"weight_ih",
				layer_idx,
				4 * hidden_size,
				input_size,
			)?;
			let w_hh = load_weight(
				&vb_layer,
				&vb,
				&vb_nemo,
				"weight_hh",
				layer_idx,
				4 * hidden_size,
				hidden_size,
			)?;
			let b_ih = load_bias(
				&vb_layer,
				&vb,
				&vb_nemo,
				"bias_ih",
				layer_idx,
				4 * hidden_size,
				Some("bias"),
			)?;
			let b_hh =
				load_bias(&vb_layer, &vb, &vb_nemo, "bias_hh", layer_idx, 4 * hidden_size, None)?;
			Ok(Self { w_ih, w_hh, b_ih, b_hh })
		}

		fn forward(&self, x: &Tensor, h: &Tensor, c: &Tensor) -> Result<(Tensor, Tensor)> {
			let gates = x.matmul(&self.w_ih.t()?)?.broadcast_add(&self.b_ih)?;
			let gates = gates
				.broadcast_add(&h.matmul(&self.w_hh.t()?)?)?
				.broadcast_add(&self.b_hh)?;
			let chunks = gates.chunk(4, D::Minus1)?;
			let i = candle_nn::ops::sigmoid(&chunks[0])?;
			let f = candle_nn::ops::sigmoid(&chunks[1])?;
			let g = chunks[2].tanh()?;
			let o = candle_nn::ops::sigmoid(&chunks[3])?;
			let c_next = ((&f * c)? + (&i * &g)?)?;
			let h_next = (&o * c_next.tanh()?)?;
			Ok((h_next, c_next))
		}
	}

	#[derive(Debug, Clone)]
	pub struct Lstm {
		layers:      Vec<LstmLayer>,
		hidden_size: usize,
		num_layers:  usize,
	}

	impl Lstm {
		pub fn load(
			input_size: usize,
			hidden_size: usize,
			num_layers: usize,
			batch_first: bool,
			vb: VarBuilder,
		) -> Result<Self> {
			if !batch_first {
				return Err(candle_core::Error::Msg("only batch_first=true is supported".to_string()));
			}
			let mut layers = Vec::with_capacity(num_layers);
			for i in 0..num_layers {
				let in_size = if i == 0 { input_size } else { hidden_size };
				layers.push(LstmLayer::load(in_size, hidden_size, i, vb.clone())?);
			}
			Ok(Self { layers, hidden_size, num_layers })
		}

		pub fn forward(
			&self,
			x: &Tensor,
			h_c: Option<(Tensor, Tensor)>,
		) -> Result<(Tensor, (Tensor, Tensor))> {
			let (b, t, _) = x.dims3()?;
			let device = x.device();
			let dtype = x.dtype();

			let mut h_layers: Vec<Tensor> = Vec::with_capacity(self.num_layers);
			let mut c_layers: Vec<Tensor> = Vec::with_capacity(self.num_layers);

			if let Some((h, c)) = h_c {
				for i in 0..self.num_layers {
					h_layers.push(h.narrow(0, i, 1)?.squeeze(0)?);
					c_layers.push(c.narrow(0, i, 1)?.squeeze(0)?);
				}
			} else {
				for _ in 0..self.num_layers {
					h_layers.push(Tensor::zeros((b, self.hidden_size), dtype, device)?);
					c_layers.push(Tensor::zeros((b, self.hidden_size), dtype, device)?);
				}
			}

			let mut outputs = x.clone();
			for layer_idx in 0..self.num_layers {
				let layer = &self.layers[layer_idx];
				let mut h_t = h_layers[layer_idx].clone();
				let mut c_t = c_layers[layer_idx].clone();

				let mut layer_outputs = Vec::with_capacity(t);
				for time_idx in 0..t {
					let x_t = outputs.narrow(1, time_idx, 1)?.squeeze(1)?;
					let (h_next, c_next) = layer.forward(&x_t, &h_t, &c_t)?;
					h_t = h_next;
					c_t = c_next;
					layer_outputs.push(h_t.clone());
				}
				outputs = Tensor::stack(&layer_outputs, 1)?;
				h_layers[layer_idx] = h_t;
				c_layers[layer_idx] = c_t;
			}

			let h = Tensor::stack(&h_layers, 0)?;
			let c = Tensor::stack(&c_layers, 0)?;
			Ok((outputs, (h, c)))
		}
	}

	#[derive(Debug, Clone)]
	pub struct PredictNetwork {
		pred_hidden: usize,
		embed:       Embedding,
		dec_rnn:     Lstm,
	}

	impl PredictNetwork {
		pub fn load(args: &PredictArgs, vb: VarBuilder) -> Result<Self> {
			let vocab = if args.blank_as_pad {
				args.vocab_size + 1
			} else {
				args.vocab_size
			};
			let pred_hidden = args.prednet.pred_hidden;
			let embed = candle_nn::embedding(vocab, pred_hidden, vb.pp("prediction").pp("embed"))?;
			let hidden_size = args
				.prednet
				.rnn_hidden_size
				.and_then(|v| if v > 0 { Some(v as usize) } else { None })
				.unwrap_or(pred_hidden);
			let dec_rnn = Lstm::load(
				pred_hidden,
				hidden_size,
				args.prednet.pred_rnn_layers,
				true,
				vb.pp("prediction").pp("dec_rnn"),
			)?;
			Ok(Self { pred_hidden, embed, dec_rnn })
		}

		pub fn forward(
			&self,
			y: Option<&Tensor>,
			h_c: Option<(Tensor, Tensor)>,
		) -> Result<(Tensor, (Tensor, Tensor))> {
			let device = if let Some(y) = y {
				y.device()
			} else if let Some((ref h, _)) = h_c {
				h.device()
			} else {
				self.embed.embeddings().device()
			};
			let embedded = if let Some(y) = y {
				self.embed.forward(y)?
			} else {
				let batch = if let Some((ref h, _)) = h_c {
					h.dims3()?.1
				} else {
					1
				};
				Tensor::zeros((batch, 1, self.pred_hidden), DType::F32, device)?
			};
			self.dec_rnn.forward(&embedded, h_c)
		}
	}

	#[derive(Debug, Clone)]
	pub struct JointNetwork {
		pred:       Linear,
		enc:        Linear,
		activation: String,
		out:        Linear,
	}

	impl JointNetwork {
		pub fn load(args: &JointArgs, vb: VarBuilder) -> Result<Self> {
			let num_classes = args.num_classes + 1 + args.num_extra_outputs;
			let pred = candle_nn::linear(
				args.jointnet.pred_hidden,
				args.jointnet.joint_hidden,
				vb.pp("pred"),
			)?;
			let enc = candle_nn::linear(
				args.jointnet.encoder_hidden,
				args.jointnet.joint_hidden,
				vb.pp("enc"),
			)?;
			let out =
				candle_nn::linear(args.jointnet.joint_hidden, num_classes, vb.pp("joint_net").pp(2))?;
			Ok(Self { pred, enc, activation: args.jointnet.activation.clone(), out })
		}

		pub fn forward(&self, enc: &Tensor, pred: &Tensor) -> Result<Tensor> {
			let enc = self.enc.forward(enc)?;
			let pred = self.pred.forward(pred)?;
			let enc = enc.unsqueeze(2)?;
			let pred = pred.unsqueeze(1)?;
			let mut x = enc.broadcast_add(&pred)?;
			x = match self.activation.as_str() {
				"relu" => x.relu()?,
				"sigmoid" => candle_nn::ops::sigmoid(&x)?,
				_ => x.tanh()?,
			};
			self.out.forward(&x)
		}
	}
}
