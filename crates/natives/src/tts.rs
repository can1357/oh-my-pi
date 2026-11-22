//! Phonon on-device text-to-speech exposed to JavaScript.
//!
//! [`PhononTts`] owns one loaded [`ptts`] model. The local TTS worker
//! (`packages/coding-agent/src/tts/tts-worker.ts`) loads it from the checkpoint
//! directory the TypeScript downloader filled, then synthesizes one speakable
//! segment per call on libuv's pool, so generation never blocks the JS thread.

use std::{collections::HashMap, sync::Arc};

use napi::{Error, Result, Status, bindgen_prelude::Float32Array};
use napi_derive::napi;
use parking_lot::Mutex;
use ptts::{
	checkpoint::{Checkpoint, ResolveOptions},
	comp::{GainConfig, LimiterConfig, ModuleConfig},
	preprocess::Lang,
	synth::{DeviceKind, Quant, SpeechOptions, Synth},
};

use crate::task::{self, Promise};

/// Conditioner that stretches (positive) or compresses (negative) predicted
/// durations; the checkpoint's only speaking-rate control.
const DURATION_DELTA: &str = "duration_delta";

/// Make-up gain: Phonon peaks around -7 dBFS, well below the rest of the
/// speech stack. The limiter keeps the boosted peaks off full scale.
const MAKEUP_GAIN_DB: f32 = 4.0;
const LIMITER_HEADROOM_DB: f32 = 1.0;
const LIMITER_LOOKAHEAD_MS: f32 = 5.0;
const LIMITER_RELEASE_MS: f32 = 50.0;

/// Request options for [`PhononTts::synthesize`].
#[napi(object)]
pub struct PhononSpeechOptions {
	/// Registered voice name (a `voices/<name>.safetensors` stem); omit for the
	/// checkpoint's default voice.
	pub voice:          Option<String>,
	/// `duration_delta` conditioner: negative speaks faster, positive slower.
	/// Omit for the model's natural rate (0).
	pub duration_delta: Option<f64>,
}

/// A loaded model and the `duration_delta` its conditioners were last baked
/// with. Rebaking clears the primed voice cache, so it only runs on change.
struct Model {
	synth:          Synth,
	duration_delta: f64,
}

/// One loaded Phonon checkpoint, English normalization, CPU inference.
#[napi]
pub struct PhononTts {
	model:       Arc<Mutex<Model>>,
	sample_rate: u32,
	voices:      Vec<String>,
}

fn tts_error(context: &str, error: impl std::fmt::Display) -> Error {
	Error::new(Status::GenericFailure, format!("{context}: {error}"))
}

fn load_model(model_dir: &str) -> Result<PhononTts> {
	let checkpoint =
		Checkpoint::resolve(model_dir, ResolveOptions { quant: Quant::Q80, weights: None })
			.map_err(|error| tts_error("resolve Phonon checkpoint", error))?;
	let mut synth = checkpoint
		.builder(Lang::En)
		.device(DeviceKind::Cpu)
		.post_process([
			ModuleConfig::Gain(GainConfig { gain_db: MAKEUP_GAIN_DB }),
			ModuleConfig::Limiter(LimiterConfig {
				lookahead_ms: LIMITER_LOOKAHEAD_MS,
				headroom_db:  LIMITER_HEADROOM_DB,
				release_ms:   LIMITER_RELEASE_MS,
			}),
		])
		.build()
		.map_err(|error| tts_error("load Phonon model", error))?;
	checkpoint.register_voices(&mut synth);
	let sample_rate = synth.sample_rate();
	let voices = synth.voices();
	Ok(PhononTts {
		model: Arc::new(Mutex::new(Model { synth, duration_delta: 0.0 })),
		sample_rate,
		voices,
	})
}

#[napi]
impl PhononTts {
	/// Load the checkpoint in `modelDir`: `config.json`, `tokenizer.json`,
	/// `model.q8.gguf`, and voice embeddings under `voices/` (registered by
	/// file stem) plus `default-voice.safetensors` (registered as `default`).
	///
	/// # Errors
	/// Rejects when a required file is missing or the weights fail to load.
	#[napi]
	#[allow(clippy::use_self, reason = "napi return types must name the exported class")]
	pub fn load(model_dir: String) -> Promise<PhononTts> {
		task::blocking("tts.load", (), move |_| load_model(&model_dir))
	}

	/// PCM sample rate of every synthesized buffer, in Hz.
	#[napi(getter)]
	pub const fn sample_rate(&self) -> u32 {
		self.sample_rate
	}

	/// Registered voice names, sorted.
	#[napi(getter)]
	pub fn voices(&self) -> Vec<String> {
		self.voices.clone()
	}

	/// Synthesize `text` as mono `f32` PCM at [`Self::sample_rate`].
	/// Requests run one at a time; a concurrent call waits for the previous one.
	///
	/// # Errors
	/// Rejects for an unregistered voice, a `durationDelta` the conditioner
	/// rejects, or a generation failure.
	#[napi]
	pub fn synthesize(
		&self,
		text: String,
		options: Option<PhononSpeechOptions>,
	) -> Promise<Float32Array> {
		let model = Arc::clone(&self.model);
		let (voice, duration_delta) = options
			.map_or((None, 0.0), |options| (options.voice, options.duration_delta.unwrap_or(0.0)));
		task::blocking("tts.synthesize", (), move |_| {
			let mut model = model.lock();
			if model.duration_delta.to_bits() != duration_delta.to_bits() {
				let conditions =
					HashMap::from([(DURATION_DELTA.to_string(), duration_delta.to_string())]);
				model
					.synth
					.set_conditions(conditions)
					.map_err(|error| tts_error("set Phonon speaking rate", error))?;
				model.duration_delta = duration_delta;
			}
			let mut request = SpeechOptions::default();
			if let Some(voice) = voice {
				request = request.voice(voice);
			}
			let pcm = model
				.synth
				.say_with(&text, &request)
				.map_err(|error| tts_error("Phonon synthesis", error))?;
			Ok(Float32Array::new(pcm))
		})
	}
}
