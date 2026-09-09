//! Production speech synthesis for the chat vocalizer: local Kokoro (or the
//! configured provider) through the Environment's media bridge, decoded to
//! the mono `f32` contract `omp-audio` plays.

use std::{future::Future, pin::Pin, sync::Arc};

use omp_chat::notices::voice::{
	SpeechSynth, SpeechSynthFailure, SynthAudio, SynthConfig, SynthFormat, SynthRequest,
};
use omp_core::Str;
use omp_envd::search_backend::SearchBridgeHost;
use omp_proto::inference::v1 as inference_pb;

/// Sample rate requested from the synthesizer and handed to playback.
const SAMPLE_RATE_HZ: u32 = 24_000;

/// Synthesizes speech through the environment's inference facade.
pub struct EnvSpeechSynth {
	bridge:   Arc<SearchBridgeHost>,
	con:      Arc<omp_con::Ctx>,
	rewriter: Option<omp_driver::headless::kernel::SpeechRewriteClient>,
}

impl EnvSpeechSynth {
	/// Creates a synthesizer over the environment bridge. Model and voice are
	/// sampled when each utterance starts, so mid-utterance settings cannot
	/// splice different speakers into one playback stream.
	#[must_use]
	pub fn new(
		bridge: Arc<SearchBridgeHost>,
		con: Arc<omp_con::Ctx>,
		rewriter: Option<omp_driver::headless::kernel::SpeechRewriteClient>,
	) -> Self {
		Self { bridge, con, rewriter }
	}
}

impl SpeechSynth for EnvSpeechSynth {
	fn configuration(&self) -> SynthConfig {
		let voice = <&'static str>::from(super::settings::CL_SPEECH_VOICE.get(&self.con));
		let model = <&'static str>::from(super::settings::CL_TTS_MODEL.get(&self.con));
		SynthConfig {
			model:       Str::new_static(model),
			voice:       Str::new_static(voice),
			format:      SynthFormat::Pcm16,
			sample_rate: SAMPLE_RATE_HZ,
		}
	}

	fn synthesize(
		&self,
		request: SynthRequest,
	) -> Pin<Box<dyn Future<Output = Result<SynthAudio, SpeechSynthFailure>> + Send + '_>> {
		let wire = inference_pb::SpeakRequest {
			model:          request.config.model.to_string(),
			text:           request.text.to_string(),
			voice:          request.config.voice.to_string(),
			encoding:       inference_pb::AudioEncoding::Pcm16 as i32,
			sample_rate_hz: Some(request.config.sample_rate),
			speed:          None,
			instructions:   String::new(),
			clone:          None,
			props:          None,
		};
		Box::pin(async move {
			let audio = tokio::select! {
				biased;
				() = request.cancel.cancelled() => return Err(SpeechSynthFailure::Cancelled),
				audio = self.bridge.speak(wire) => audio.map_err(|error| {
					tracing::debug!(
						code = %error.code,
						kind = %error.kind,
						"vocalizer synthesis backend failed"
					);
					SpeechSynthFailure::Backend { code: error.code }
				})?,
			};
			if audio.len() % 2 != 0 {
				return Err(SpeechSynthFailure::MalformedAudio { bytes: audio.len() });
			}
			let samples = audio
				.chunks_exact(2)
				.map(|sample| {
					f32::from(i16::from_le_bytes([sample[0], sample[1]])) / f32::from(i16::MAX)
				})
				.collect();
			Ok(SynthAudio { sample_rate: request.config.sample_rate, samples })
		})
	}

	fn rewrite(
		&self,
		request: SynthRequest,
	) -> Pin<Box<dyn Future<Output = Result<Option<Str>, SpeechSynthFailure>> + Send + '_>> {
		Box::pin(async move {
			let Some(rewriter) = &self.rewriter else {
				return Ok(None);
			};
			rewriter
				.rewrite(omp_ai::realtime::rewrite::SPEECH_REWRITE_PROMPT, request.text, request.cancel)
				.await
				.map(Some)
				.map_err(|error| {
					tracing::debug!(%error, "vocalizer enhanced rewrite failed");
					match error {
						omp_driver::headless::kernel::SpeechRewriteClientError::Cancelled => {
							SpeechSynthFailure::Cancelled
						},
						omp_driver::headless::kernel::SpeechRewriteClientError::Timeout
						| omp_driver::headless::kernel::SpeechRewriteClientError::Inference { .. }
						| omp_driver::headless::kernel::SpeechRewriteClientError::EmptyOutput => {
							SpeechSynthFailure::Backend { code: Str::new_static("speech_rewrite_failed") }
						},
					}
				})
		})
	}
}
