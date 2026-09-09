//! Real text-to-speech production for the dyn-mounted `tts` device.

use std::{sync::Arc, time::Duration};

use bytes::{Bytes, BytesMut};
use flume::Sender;
use futures::StreamExt as _;
use http::{HeaderMap, HeaderValue, header::USER_AGENT};
use omp_ai::auth::{CredentialLease, HeaderPlacement};
use omp_core::{Str, sf};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{github_url::GithubCredentialBridge, media_devices::MediaFault};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const XAI_TTS_URL: &str = "https://api.x.ai/v1/tts";
const DEEPINFRA_TTS_URL: &str = "https://api.deepinfra.com/v1/openai/audio/speech";
const DEEPINFRA_MODEL: &str = "hexgrad/Kokoro-82M";
const DEFAULT_XAI_VOICE: &str = "eve";
const DEFAULT_XAI_SAMPLE_RATE: u32 = 24_000;
const DEFAULT_XAI_BIT_RATE: u32 = 128_000;

/// Configured generated-speech backend preference.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SpeechPreference {
	/// Prefer local synthesis, except that credentialed MP3 requests use xAI.
	#[default]
	Auto,
	/// Require local Kokoro synthesis.
	Local,
	/// Require xAI hosted synthesis.
	Xai,
	/// Require DeepInfra hosted synthesis.
	Deepinfra,
}

/// Immutable session settings used by the speech producer.
#[derive(Clone, Debug)]
pub(crate) struct SpeechConfig {
	pub(crate) preference:  SpeechPreference,
	#[allow(dead_code, reason = "read by the local-tts backend when enabled")]
	pub(crate) local_model: Str,
	#[allow(dead_code, reason = "read by the local-tts backend when enabled")]
	pub(crate) local_voice: Str,
}

impl Default for SpeechConfig {
	fn default() -> Self {
		Self {
			preference:  SpeechPreference::Auto,
			local_model: sf!("kokoro"),
			local_voice: sf!("af_heart"),
		}
	}
}

/// One validated producer request. The output codec is derived from the path:
/// `.wav` requests WAV and every other suffix requests MP3.
#[derive(Clone, Debug)]
pub(crate) struct SpeechInput {
	pub(crate) text:        Str,
	pub(crate) voice_id:    Option<Str>,
	pub(crate) language:    Str,
	pub(crate) output_path: Str,
	pub(crate) sample_rate: Option<u32>,
	pub(crate) bit_rate:    Option<u32>,
}

/// Incremental encoded-byte accounting published by the tool element.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct SpeechProgress {
	pub(crate) chunks: u64,
	pub(crate) bytes:  u64,
}

/// Complete real synthesis output, before artifact retention and atomic write.
pub(crate) struct SpeechOutput {
	pub(crate) audio:       Bytes,
	pub(crate) output_path: Str,
	pub(crate) media_type:  &'static str,
	pub(crate) codec:       &'static str,
	pub(crate) backend:     &'static str,
	pub(crate) voice_id:    Str,
	pub(crate) sample_rate: Option<u32>,
}

/// Reusable producer shared by every invocation of one mounted TTS device.
pub(crate) struct SpeechProducer {
	config:      SpeechConfig,
	credentials: Arc<GithubCredentialBridge>,
	client:      omp_http::Client,
	#[cfg(feature = "local-tts")]
	local:       tokio::sync::OnceCell<Arc<omp_ai::local::tts::KokoroAdapter>>,
}

impl SpeechProducer {
	pub(crate) fn new(config: SpeechConfig, credentials: Arc<GithubCredentialBridge>) -> Self {
		Self {
			config,
			credentials,
			client: omp_http::no_redirect_client(),
			#[cfg(feature = "local-tts")]
			local: tokio::sync::OnceCell::new(),
		}
	}

	/// Selects a backend, performs one bounded cancellable synthesis, and emits
	/// progress without buffering duplicate snapshots.
	pub(crate) async fn synthesize(
		&self,
		input: SpeechInput,
		cancellation: CancellationToken,
		updates: Sender<SpeechProgress>,
	) -> Result<SpeechOutput, MediaFault> {
		let wants_mp3 = requested_codec(&input.output_path) == "mp3";
		let mut xai_lease = None;
		let backend = match self.config.preference {
			SpeechPreference::Local => Backend::Local,
			SpeechPreference::Xai => Backend::Xai,
			SpeechPreference::Deepinfra => Backend::Deepinfra,
			SpeechPreference::Auto if wants_mp3 => {
				xai_lease = self.xai_lease(&cancellation).await?;
				if xai_lease.is_some() {
					Backend::Xai
				} else {
					Backend::Local
				}
			},
			SpeechPreference::Auto => Backend::Local,
		};

		match backend {
			Backend::Local => {
				let deadline = tokio::time::timeout(
					REQUEST_TIMEOUT,
					self.synthesize_local(input, cancellation.clone(), updates),
				);
				match deadline.await {
					Ok(result) => result,
					Err(_) => {
						cancellation.cancel();
						Err(fault(
							"tts_timeout",
							"local",
							"speech synthesis exceeded the 60 second deadline",
						))
					},
				}
			},
			Backend::Xai => {
				let lease = match xai_lease {
					Some(lease) => lease,
					None => self.xai_lease(&cancellation).await?.ok_or_else(|| {
						fault(
							"tts_credentials_missing",
							"xai",
							"no usable xAI API-key or OAuth credential is configured",
						)
					})?,
				};
				self
					.synthesize_xai(input, lease, cancellation, updates)
					.await
			},
			Backend::Deepinfra => {
				let lease = self.require_lease("deepinfra", &cancellation).await?;
				self
					.synthesize_deepinfra(input, lease, cancellation, updates)
					.await
			},
		}
	}

	async fn lease(
		&self,
		provider: &'static str,
		cancellation: &CancellationToken,
	) -> Result<Option<CredentialLease>, MediaFault> {
		tokio::select! {
			biased;
			() = cancellation.cancelled() => Err(cancelled(provider)),
			lease = self.credentials.lease_for(provider) => lease.map_err(|_| fault(
				"tts_credentials_failed",
				provider,
				"the credential authority could not issue a speech-provider lease",
			)),
		}
	}

	async fn xai_lease(
		&self,
		cancellation: &CancellationToken,
	) -> Result<Option<CredentialLease>, MediaFault> {
		if let Some(lease) = self.lease("xai", cancellation).await? {
			return Ok(Some(lease));
		}
		self.lease("xai-oauth", cancellation).await
	}

	async fn require_lease(
		&self,
		provider: &'static str,
		cancellation: &CancellationToken,
	) -> Result<CredentialLease, MediaFault> {
		self.lease(provider, cancellation).await?.ok_or_else(|| {
			fault(
				"tts_credentials_missing",
				provider,
				"no usable credentials are configured for the selected speech provider",
			)
		})
	}

	async fn synthesize_xai(
		&self,
		input: SpeechInput,
		lease: CredentialLease,
		cancellation: CancellationToken,
		updates: Sender<SpeechProgress>,
	) -> Result<SpeechOutput, MediaFault> {
		let codec = requested_codec(&input.output_path);
		let voice = input
			.voice_id
			.clone()
			.unwrap_or_else(|| sf!(DEFAULT_XAI_VOICE));
		let sample_rate = input.sample_rate.unwrap_or(DEFAULT_XAI_SAMPLE_RATE);
		let bit_rate = input.bit_rate.unwrap_or(DEFAULT_XAI_BIT_RATE);
		let mut payload = json!({
			"text": input.text,
			"voice_id": voice,
			"language": input.language,
		});
		if codec != "mp3"
			|| sample_rate != DEFAULT_XAI_SAMPLE_RATE
			|| (codec == "mp3" && bit_rate != DEFAULT_XAI_BIT_RATE)
		{
			let mut format = json!({ "codec": codec });
			if sample_rate != 0 {
				format["sample_rate"] = Value::from(sample_rate);
			}
			if codec == "mp3" && bit_rate != 0 {
				format["bit_rate"] = Value::from(bit_rate);
			}
			payload["output_format"] = format;
		}
		let audio = self
			.post_audio(XAI_TTS_URL, "xai", payload, &lease, &cancellation, &updates)
			.await?;
		Ok(SpeechOutput {
			audio,
			output_path: input.output_path,
			media_type: if codec == "wav" {
				"audio/wav"
			} else {
				"audio/mpeg"
			},
			codec,
			backend: "xai",
			voice_id: voice,
			sample_rate: Some(sample_rate),
		})
	}

	async fn synthesize_deepinfra(
		&self,
		input: SpeechInput,
		lease: CredentialLease,
		cancellation: CancellationToken,
		updates: Sender<SpeechProgress>,
	) -> Result<SpeechOutput, MediaFault> {
		let codec = requested_codec(&input.output_path);
		let mut payload = json!({
			"model": DEEPINFRA_MODEL,
			"input": input.text,
			"response_format": codec,
		});
		if let Some(voice) = &input.voice_id {
			payload["voice"] = Value::String(voice.to_string());
		}
		let audio = self
			.post_audio(DEEPINFRA_TTS_URL, "deepinfra", payload, &lease, &cancellation, &updates)
			.await?;
		Ok(SpeechOutput {
			audio,
			output_path: input.output_path,
			media_type: if codec == "wav" {
				"audio/wav"
			} else {
				"audio/mpeg"
			},
			codec,
			backend: "deepinfra",
			voice_id: input.voice_id.unwrap_or_else(|| sf!("default")),
			sample_rate: None,
		})
	}

	async fn post_audio(
		&self,
		url: &'static str,
		provider: &'static str,
		payload: Value,
		lease: &CredentialLease,
		cancellation: &CancellationToken,
		updates: &Sender<SpeechProgress>,
	) -> Result<Bytes, MediaFault> {
		let mut headers = HeaderMap::new();
		headers.insert(USER_AGENT, HeaderValue::from_static("omp-tts-device"));
		lease
			.apply_header(&HeaderPlacement::bearer(), &mut headers)
			.map_err(|_| {
				fault(
					"tts_credentials_invalid",
					provider,
					"the selected credential cannot authorize a bearer speech request",
				)
			})?;
		let request = self.client.post(url).headers(headers).json(&payload);
		let operation = async {
			let response = request.send().await.map_err(|_| {
				fault("tts_transport_failed", provider, "the speech provider request failed")
			})?;
			let status = response.status();
			let media_response = response
				.headers()
				.get(http::header::CONTENT_TYPE)
				.and_then(|value| value.to_str().ok())
				.is_none_or(|value| {
					value.starts_with("audio/") || value.starts_with("application/octet-stream")
				});
			let mut stream = response.bytes_stream();
			let mut body = BytesMut::new();
			let mut chunks = 0_u64;
			while let Some(next) = stream.next().await {
				let chunk = next.map_err(|_| {
					fault("tts_transport_failed", provider, "the speech response stream failed")
				})?;
				if body.len().saturating_add(chunk.len()) > MAX_AUDIO_BYTES {
					return Err(fault(
						"tts_audio_too_large",
						provider,
						"the speech provider response exceeded the 64 MiB host limit",
					));
				}
				body.extend_from_slice(&chunk);
				chunks = chunks.saturating_add(1);
				if status.is_success() {
					let _ = updates.try_send(SpeechProgress {
						chunks,
						bytes: u64::try_from(body.len()).unwrap_or(u64::MAX),
					});
					tokio::task::yield_now().await;
				}
			}
			if !status.is_success() {
				let detail = String::from_utf8_lossy(&body);
				let summary = detail.chars().take(300).collect::<String>();
				let summary = omp_observability::redact::redact_sensitive_credentials(&summary);
				return Err(MediaFault {
					code:    sf!("tts_provider_http"),
					backend: Str::new_static(provider),
					message: Str::from(format!(
						"speech provider returned HTTP {}: {summary}",
						status.as_u16()
					)),
				});
			}
			if !media_response {
				return Err(fault(
					"tts_invalid_response",
					provider,
					"the speech provider returned a non-audio response",
				));
			}
			if body.is_empty() {
				return Err(fault(
					"tts_empty_audio",
					provider,
					"the speech provider returned an empty audio body",
				));
			}
			Ok(body.freeze())
		};
		tokio::select! {
			biased;
			() = cancellation.cancelled() => Err(cancelled(provider)),
			result = tokio::time::timeout(REQUEST_TIMEOUT, operation) => result.unwrap_or_else(|_| Err(fault(
				"tts_timeout",
				provider,
				"speech synthesis exceeded the 60 second deadline",
			))),
		}
	}

	#[cfg(feature = "local-tts")]
	async fn synthesize_local(
		&self,
		input: SpeechInput,
		cancellation: CancellationToken,
		updates: Sender<SpeechProgress>,
	) -> Result<SpeechOutput, MediaFault> {
		use omp_ai::local::{
			ArtifactStore, MemoryPool, SystemArtifactFetcher,
			speech_catalog::SpeechArtifactManifests,
			tts::{KokoroAdapter, KokoroConfig, KokoroDevice, SynthesisOptions},
		};

		if self.config.local_model != "kokoro" {
			return Err(fault(
				"tts_local_model_invalid",
				"local",
				"only the Kokoro local model is supported",
			));
		}
		let adapter = self
			.local
			.get_or_try_init(|| async {
				let data_dir = omp_core::dirs::data_dir(None).map_err(|_| {
					fault(
						"tts_local_data_unavailable",
						"local",
						"the local model data directory is unavailable",
					)
				})?;
				let root = data_dir.join("models");
				std::fs::create_dir_all(&root).map_err(|_| {
					fault(
						"tts_local_data_unavailable",
						"local",
						"the local model data directory cannot be created",
					)
				})?;
				let store = ArtifactStore::open(&root).map_err(|_| {
					fault(
						"tts_local_artifact_failed",
						"local",
						"the local model artifact store could not be opened",
					)
				})?;
				let artifacts = SpeechArtifactManifests::curated().map_err(|_| {
					fault(
						"tts_local_artifact_failed",
						"local",
						"the Kokoro artifact manifest is invalid",
					)
				})?;
				store
					.acquire(
						artifacts.kokoro_manifest(),
						&SystemArtifactFetcher::new(),
						&cancellation,
						|_| {},
					)
					.await
					.map_err(|_| {
						fault(
							"tts_local_artifact_failed",
							"local",
							"the Kokoro model artifacts could not be acquired",
						)
					})?;
				let config = KokoroConfig::from_verified_artifacts(
					&store,
					&artifacts,
					local_device(),
					Duration::from_secs(60),
					&cancellation,
				)
				.map_err(|_| {
					fault(
						"tts_local_artifact_failed",
						"local",
						"the Kokoro model artifacts failed verification",
					)
				})?;
				let memory = Arc::new(MemoryPool::new(config.resident_bytes));
				KokoroAdapter::new(config, memory)
					.map(Arc::new)
					.map_err(|_| {
						fault("tts_local_unavailable", "local", "the Kokoro synthesizer could not start")
					})
			})
			.await?
			.clone();
		let voice = self.config.local_voice.clone();
		let text = input.text.clone();
		let worker_cancel = cancellation.clone();
		let encoded = tokio::task::spawn_blocking(move || {
			let mut samples = Vec::new();
			let mut chunks = 0_u64;
			adapter
				.synthesize_streaming(
					&text,
					&voice,
					SynthesisOptions::default(),
					&worker_cancel,
					|chunk, sample_rate| {
						samples.extend_from_slice(chunk);
						chunks = chunks.saturating_add(1);
						let bytes = samples.len().saturating_mul(std::mem::size_of::<i16>());
						let _ = updates.try_send(SpeechProgress {
							chunks,
							bytes: u64::try_from(bytes).unwrap_or(u64::MAX),
						});
						let _ = sample_rate;
						!worker_cancel.is_cancelled()
					},
				)
				.map_err(|_| fault("tts_local_failed", "local", "Kokoro synthesis failed"))?;
			let audio = omp_audio::wav::encode_wav(&samples, 24_000)
				.map(Bytes::from)
				.map_err(|_| {
					fault("tts_local_encode_failed", "local", "Kokoro audio could not be encoded as WAV")
				})?;
			let _ = updates.try_send(SpeechProgress {
				chunks,
				bytes: u64::try_from(audio.len()).unwrap_or(u64::MAX),
			});
			Ok(audio)
		});
		let audio = tokio::select! {
			biased;
			() = cancellation.cancelled() => return Err(cancelled("local")),
			result = tokio::time::timeout(REQUEST_TIMEOUT, encoded) => match result {
				Ok(Ok(result)) => result?,
				Ok(Err(_)) => return Err(fault("tts_local_worker_failed", "local", "the Kokoro synthesis worker stopped unexpectedly")),
				Err(_) => {
					cancellation.cancel();
					return Err(fault("tts_timeout", "local", "speech synthesis exceeded the 60 second deadline"));
				},
			},
		};
		let output_path = local_wav_path(&input.output_path);
		Ok(SpeechOutput {
			audio,
			output_path,
			media_type: "audio/wav",
			codec: "wav",
			backend: "local",
			voice_id: sf!("{}/{}", self.config.local_model, self.config.local_voice),
			sample_rate: Some(24_000),
		})
	}

	#[cfg(not(feature = "local-tts"))]
	async fn synthesize_local(
		&self,
		_input: SpeechInput,
		_cancellation: CancellationToken,
		_updates: Sender<SpeechProgress>,
	) -> Result<SpeechOutput, MediaFault> {
		Err(fault(
			"tts_local_unavailable",
			"local",
			"local Kokoro synthesis is not built; enable the local-tts feature or select a hosted \
			 provider",
		))
	}
}

#[derive(Clone, Copy)]
enum Backend {
	Local,
	Xai,
	Deepinfra,
}

fn requested_codec(output_path: &str) -> &'static str {
	if output_path.to_ascii_lowercase().ends_with(".wav") {
		"wav"
	} else {
		"mp3"
	}
}

#[allow(dead_code, reason = "called by the local-tts backend when enabled")]
fn local_wav_path(output_path: &str) -> Str {
	if output_path.to_ascii_lowercase().ends_with(".wav") {
		return Str::new(output_path);
	}
	let path = std::path::Path::new(output_path);
	let mut wav = path.to_path_buf();
	wav.set_extension("wav");
	Str::new(wav.to_string_lossy())
}

#[cfg(feature = "local-tts")]
const fn local_device() -> omp_ai::local::tts::KokoroDevice {
	#[cfg(target_os = "macos")]
	{
		omp_ai::local::tts::KokoroDevice::Metal
	}
	#[cfg(not(target_os = "macos"))]
	{
		omp_ai::local::tts::KokoroDevice::Cpu
	}
}

fn fault(code: &'static str, backend: &'static str, message: &'static str) -> MediaFault {
	MediaFault {
		code:    Str::new_static(code),
		backend: Str::new_static(backend),
		message: Str::new_static(message),
	}
}

fn cancelled(backend: &'static str) -> MediaFault {
	fault("tts_cancelled", backend, "speech synthesis was cancelled")
}
