//! Harness-owned dynamic devices for media generation.

use std::{
	fs::{self, OpenOptions},
	io::{self, Read as _},
	path::{Component, Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_stream::stream;
use async_trait::async_trait;
use bytes::Bytes;
use futures::Stream;
use omp_audio::audio::PlaybackStream;
use omp_core::{ArtifactUrl, Str, sf};
use omp_proto::{
	inference::v1::{self as inference_pb, generate_image_request},
	thread::v1::{self as thread_pb, blob},
};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, DocEffects, Effects, Ev, IncomingParams,
	InferenceEffects, LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec,
	ToolTerminal,
};
use omp_tools::{ask, read::image::sniff_metadata};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::{
	blobs::{BlobError, BlobHost},
	github_url::GithubCredentialBridge,
	media_tts::{SpeechConfig, SpeechInput, SpeechOutput, SpeechProducer},
	search_backend::SearchBridgeHost,
};

/// Production ask-dialog vocalizer over the application inference facade.
pub struct AskVocalizer {
	backend: Arc<SearchBridgeHost>,
}

#[async_trait]
/// Synthesizes and plays one complete dialog through local Kokoro by default.
#[async_trait]
impl omp_tools::ask::AskVocalizer for AskVocalizer {
	async fn speak(
		&self,
		lines: &[omp_tools::ask::SpokenLine],
		cancellation: CancellationToken,
	) -> Result<(), ask::Fault> {
		if cancellation.is_cancelled() || lines.is_empty() {
			return Ok(());
		}
		let mut text = String::new();
		for line in lines {
			if !text.is_empty() {
				text.push_str(". ");
			}
			text.push_str(line.text.as_str());
		}
		let request = inference_pb::SpeakRequest {
			model: "kokoro".to_owned(),
			text,
			voice: "af_heart".to_owned(),
			encoding: inference_pb::AudioEncoding::Pcm16 as i32,
			sample_rate_hz: Some(24_000),
			speed: None,
			instructions: String::new(),
			clone: None,
			props: None,
		};
		let audio = tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				return Err(omp_tools::ask::Fault::Presenter {
					message: sf!("ask speech was cancelled"),
				});
			},
			audio = self.backend.speak(request) => audio.map_err(|error| {
				omp_tools::ask::Fault::Presenter {
					message: sf!("ask speech backend failed ({})", error.kind),
				}
			})?,
		};
		if audio.len() % 2 != 0 {
			return Err(ask::Fault::Presenter {
				message: sf!("ask speech returned malformed PCM16 audio"),
			});
		}
		let samples = audio
			.chunks_exact(2)
			.map(|sample| f32::from(i16::from_le_bytes([sample[0], sample[1]])) / f32::from(i16::MAX))
			.collect::<Vec<_>>();
		let mut playback = PlaybackStream::start(24_000)
			.map_err(|error| ask::Fault::Presenter { message: Str::from(error.to_string()) })?;
		playback
			.writer()
			.and_then(|writer| writer.write_owned(samples))
			.map_err(|error| ask::Fault::Presenter { message: Str::from(error.to_string()) })?;
		tokio::select! {
			biased;
			() = cancellation.cancelled() => {
				let _ = playback.abort();
				Err(omp_tools::ask::Fault::Presenter {
					message: sf!("ask speech was cancelled"),
				})
			},
			result = playback.drain() => result.map_err(|error| {
				omp_tools::ask::Fault::Presenter { message: Str::from(error.to_string()) }
			}),
		}
	}
}

/// Creates the production ask-dialog vocalizer.
pub(crate) fn ask_vocalizer(
	backend: Arc<SearchBridgeHost>,
) -> Arc<dyn omp_tools::ask::AskVocalizer> {
	Arc::new(AskVocalizer { backend })
}
/// Largest `input_image` accepted for image-to-image generation (35 MiB).
const MAX_INPUT_IMAGE_BYTES: u64 = 35 * 1024 * 1024;
/// End-to-end image generation deadline, matching pi.
const IMAGE_TIMEOUT: Duration = Duration::from_secs(3 * 60);
/// Maximum generated image retained by the host.
const MAX_GENERATED_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// xAI's maximum reference-image count for one edit.
const MAX_XAI_EDIT_IMAGES: usize = 3;
/// Longest `text` accepted by `tts`, in characters.
const MAX_SPEECH_CHARS: usize = 15_000;
const MAX_INPUT_IMAGE_BASE64_BYTES: usize = ((MAX_INPUT_IMAGE_BYTES as usize + 2) / 3) * 4;

/// Image provider preference accepted by `image_gen`.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum ImageProvider {
	/// Select from configured, active-model, and built-in provider priorities.
	Auto,
	/// OpenAI hosted image generation.
	Openai,
	/// OpenAI hosted image generation through a ChatGPT/Codex subscription.
	#[serde(rename = "openai-codex")]
	#[strum(serialize = "openai-codex")]
	OpenaiCodex,
	/// Google Antigravity OAuth image generation.
	Antigravity,
	/// xAI Grok Imagine.
	Xai,
	/// OpenRouter chat-shaped image generation.
	Openrouter,
	/// Google Gemini native image generation.
	Gemini,
	/// DeepInfra's OpenAI-compatible image endpoint.
	Deepinfra,
}

/// Supported image aspect ratios.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub enum ImageAspectRatio {
	/// Square.
	#[serde(rename = "1:1")]
	OneOne,
	/// Portrait.
	#[serde(rename = "3:4")]
	ThreeFour,
	/// Landscape.
	#[serde(rename = "4:3")]
	FourThree,
	/// Tall portrait.
	#[serde(rename = "9:16")]
	NineSixteen,
	/// Wide landscape.
	#[serde(rename = "16:9")]
	SixteenNine,
	/// xAI-only landscape.
	#[serde(rename = "3:2")]
	ThreeTwo,
	/// xAI-only portrait.
	#[serde(rename = "2:3")]
	TwoThree,
}

/// Supported explicit generated-image dimensions.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
pub enum ImageSize {
	/// 1024×1024.
	#[serde(rename = "1024x1024")]
	Square,
	/// 1536×1024.
	#[serde(rename = "1536x1024")]
	Landscape,
	/// 1024×1536.
	#[serde(rename = "1024x1536")]
	Portrait,
}

/// Immutable session routing inputs for `image_gen`.
#[derive(Clone, Debug, Default)]
pub(crate) struct ImageConfig {
	/// Configured `providers.imageOrder` after dropping unknown names.
	pub(crate) provider_order: Vec<ImageProvider>,
	/// Active catalog selector, used when its provider can generate images.
	pub(crate) active_model:   Option<Str>,
}

/// One image-to-image input, provided either by contained path or inline data.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageInput {
	/// Workspace-relative input image path.
	pub path:      Option<Str>,
	/// Base64-encoded input image bytes.
	pub data:      Option<Str>,
	/// Optional MIME assertion checked against the sniffed bytes.
	pub mime_type: Option<Str>,
}

/// Media generation arguments. The published per-device schema exposes only
/// the fields belonging to that device.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaParams {
	/// Main image subject; required by `image_gen`.
	pub subject:      Option<Str>,
	/// What the image subject is doing.
	pub action:       Option<Str>,
	/// Image location or environment.
	pub scene:        Option<Str>,
	/// Camera angle and framing.
	pub composition:  Option<Str>,
	/// Lighting setup.
	pub lighting:     Option<Str>,
	/// Artistic style.
	pub style:        Option<Str>,
	/// Text to render in the image.
	pub text:         Option<Str>,
	/// Edits to apply to supplied images.
	pub changes:      Option<Vec<Str>>,
	/// Image aspect ratio such as `1:1` or `16:9`.
	pub aspect_ratio: Option<ImageAspectRatio>,
	/// Requested image dimensions.
	pub image_size:   Option<ImageSize>,
	/// Input images supplied by contained path or base64.
	pub input:        Option<Vec<ImageInput>>,
	/// Requested image provider.
	pub provider:     Option<ImageProvider>,
	/// Explicit provider voice ID.
	pub voice_id:     Option<Str>,
	/// BCP-47 speech language hint.
	pub language:     Option<Str>,
	/// Requested speech sample rate in hertz.
	pub sample_rate:  Option<u32>,
	/// Requested speech bit rate in bits per second.
	pub bit_rate:     Option<u32>,
	/// Workspace-relative file receiving generated bytes atomically. Required
	/// by `tts` and optional for `image_gen`.
	pub output_path:  Option<Str>,
}

/// A generated media artifact. Unavailable backends never fabricate one.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MediaPayload {
	/// Content-addressed artifact id.
	pub artifact_id: Str,
	/// Produced MIME type.
	pub media_type:  Str,
	/// Workspace-relative output path when file output was requested.
	pub output_path: Option<Str>,
	/// Durable bytes exposed to dynamic callers without erasing media typing.
	#[serde(default)]
	pub blob:        Option<omp_tool::BlobRef>,
	/// Exact byte length for generated speech.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub bytes:       Option<u64>,
	/// Voice identity selected by the serving backend.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub voice_id:    Option<Str>,
	/// Effective audio codec.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub codec:       Option<Str>,
	/// Effective media backend.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub backend:     Option<Str>,
	/// Effective provider model selector.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub model:       Option<Str>,
	/// Effective sample rate when known.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub sample_rate: Option<u32>,
}

/// Stable structured media backend failure.
#[derive(Clone, Debug, Deserialize, Eq, Error, PartialEq, Serialize)]
#[error("{code}: {message}")]
pub struct MediaFault {
	/// Machine-readable failure category.
	pub code:    Str,
	/// Backend that could not serve the request.
	pub backend: Str,
	/// Human-readable explanation.
	pub message: Str,
}

/// Image-generation state published while provider attempts are live.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImagePhase {
	/// The provider request is starting.
	Request,
	/// A failed provider is being replaced by the next eligible provider.
	Fallback,
}

/// Incremental media production state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MediaUpdate {
	/// One bounded provider attempt for image generation.
	Image {
		/// Attempt lifecycle phase.
		phase:    ImagePhase,
		/// Effective provider.
		provider: ImageProvider,
		/// Effective catalog model selector.
		model:    Str,
	},
	/// Cumulative audio received or synthesized so far.
	Audio {
		/// Number of producer chunks observed.
		chunks: u64,
		/// Cumulative encoded or PCM-projected bytes.
		bytes:  u64,
	},
}

#[derive(Clone, Copy)]
enum MediaKind {
	Image,
	Speech,
}

/// Dyn-mounted media generator.
pub struct MediaDevice {
	spec:    ToolSpec,
	kind:    MediaKind,
	backend: Arc<SearchBridgeHost>,
	image:   Option<ImageConfig>,
	speech:  Option<Arc<SpeechProducer>>,
	blobs:   BlobHost,
	root:    PathBuf,
}

/// Creates the `image_gen@4` dynamic device.
pub(crate) fn image_gen(
	backend: Arc<SearchBridgeHost>,
	config: ImageConfig,
	blobs: BlobHost,
	root: PathBuf,
) -> MediaDevice {
	media_device(
		"image_gen",
		"Generates images from a structured subject/action/scene/composition/lighting/style prompt. \
		 `input` accepts contained workspace paths or base64 PNG/JPEG/GIF/WebP images up to 35 MiB; \
		 `output_path` additionally writes the result atomically inside the workspace.",
		MediaKind::Image,
		4,
		backend,
		Some(config),
		None,
		blobs,
		root,
	)
}

/// Creates the `tts@4` dynamic device with default auto/local settings.
#[cfg(test)]
pub fn tts(backend: Arc<SearchBridgeHost>, blobs: BlobHost, root: PathBuf) -> MediaDevice {
	tts_with_config(
		backend,
		Arc::new(GithubCredentialBridge::new()),
		SpeechConfig::default(),
		blobs,
		root,
	)
}

/// Creates the `tts@4` dynamic device with session-derived provider and local
/// voice settings plus the production credential authority.
pub(crate) fn tts_with_config(
	backend: Arc<SearchBridgeHost>,
	credentials: Arc<GithubCredentialBridge>,
	config: SpeechConfig,
	blobs: BlobHost,
	root: PathBuf,
) -> MediaDevice {
	let speech = Arc::new(SpeechProducer::new(config, credentials));
	media_device(
		"tts",
		"Synthesizes speech with auto, local Kokoro, xAI, or DeepInfra selection. `text` is 1–15000 \
		 characters; `language` defaults to en; hosted `voice_id` is optional (xAI built-ins: ara, \
		 eve, leo, rex, sal; custom and DeepInfra model voices are accepted), while local synthesis \
		 uses `cl_tts_voice`. `output_path` selects WAV only when it ends in .wav and MP3 \
		 otherwise. Local synthesis always writes a sibling WAV. The audio is written atomically \
		 inside the workspace and retained as an artifact.",
		MediaKind::Speech,
		4,
		backend,
		None,
		Some(speech),
		blobs,
		root,
	)
}

fn media_device(
	name: &'static str,
	description: &'static str,
	kind: MediaKind,
	rev: u16,
	backend: Arc<SearchBridgeHost>,
	image: Option<ImageConfig>,
	speech: Option<Arc<SpeechProducer>>,
	blobs: BlobHost,
	root: PathBuf,
) -> MediaDevice {
	MediaDevice {
		spec: ToolSpec {
			name:            sf!(name),
			rev:             Rev { family: Default::default(), n: rev },
			description:     sf!(description),
			schema:          media_schema(kind),
			constraint:      Constraint::Schema {
				priority:       100,
				on_unsupported: omp_tool::Fallback::Unspecified,
			},
			effects:         Effects {
				documents: Some(DocEffects { read: true, write_globs: Arc::from([sf!("**")]) }),
				exec:      None,
				inference: Some(InferenceEffects { max_requests: 1, max_usd: Default::default() }),
				desktop:   None,
				subagents: 0,
			},
			projection_code: omp_tool::native_projection_code(
				env!("CARGO_PKG_NAME"),
				env!("CARGO_PKG_VERSION"),
				match kind {
					MediaKind::Image => include_bytes!("media_devices.rs"),
					MediaKind::Speech => include_bytes!("media_tts.rs"),
				},
			)
			.into_bytes(),
		},
		kind,
		backend,
		image,
		speech,
		blobs,
		root,
	}
}

fn media_schema(kind: MediaKind) -> Bytes {
	let schema = omp_tool::schema::<MediaParams>();
	let mut value: Value =
		serde_json::from_slice(&schema).expect("generated media schema must be valid JSON");
	let object = value
		.as_object_mut()
		.expect("media parameters use an object schema");
	let properties = object
		.get_mut("properties")
		.and_then(Value::as_object_mut)
		.expect("generated media schema has properties");
	let allowed: &[&str] = match kind {
		MediaKind::Image => &[
			"i",
			"notrunc",
			"subject",
			"action",
			"scene",
			"composition",
			"lighting",
			"style",
			"text",
			"changes",
			"aspect_ratio",
			"image_size",
			"input",
			"provider",
			"output_path",
		],
		MediaKind::Speech => {
			&["i", "notrunc", "text", "voice_id", "language", "output_path", "sample_rate", "bit_rate"]
		},
	};
	properties.retain(|name, _| allowed.contains(&name.as_str()));
	if matches!(kind, MediaKind::Speech)
		&& let Some(language) = properties
			.get_mut("language")
			.and_then(Value::as_object_mut)
	{
		language.insert("default".to_owned(), Value::String("en".to_owned()));
	}
	object.insert("required".to_owned(), match kind {
		MediaKind::Image => serde_json::json!(["i", "subject"]),
		MediaKind::Speech => serde_json::json!(["i", "text", "output_path"]),
	});
	Bytes::from(serde_json::to_vec(&value).expect("media schema serialization is infallible"))
}

impl MediaDevice {
	fn image_output(
		&self,
		output: Option<&OutputTarget>,
		attempt: &ImageAttempt,
		mut images: Vec<thread_pb::Blob>,
	) -> Result<MediaPayload, MediaFault> {
		let image = images.drain(..).next().ok_or_else(|| {
			media_fault("image_empty", "inference", "image generation returned no artifact")
		})?;
		finish_image(&self.blobs, output, attempt, &image)
	}

	fn speech_input(params: &MediaParams) -> SpeechInput {
		SpeechInput {
			text:        params.text.clone().expect("validated speech text"),
			voice_id:    params.voice_id.clone(),
			language:    params.language.clone().unwrap_or_else(|| sf!("en")),
			output_path: params
				.output_path
				.clone()
				.expect("validated speech output path"),
			sample_rate: params.sample_rate,
			bit_rate:    params.bit_rate,
		}
	}

	fn finish_speech(&self, speech: SpeechOutput) -> Result<MediaPayload, MediaFault> {
		let output = OutputTarget::resolve(&self.root, &speech.output_path)?;
		let id = self.blobs.put(&speech.audio).map_err(media_blob_fault)?;
		let output_path = Some(output.write(&speech.audio)?);
		let media_type = Str::new_static(speech.media_type);
		Ok(MediaPayload {
			artifact_id: Str::new(ArtifactUrl::from_digest(id.hash).as_str()),
			media_type: media_type.clone(),
			output_path,
			blob: Some(omp_tool::BlobRef {
				hash: Str::new(omp_core::Hash32::new(id.hash).to_hex().as_str()),
				media_type,
				byte_len: id.size,
			}),
			bytes: Some(id.size),
			voice_id: Some(speech.voice_id),
			codec: Some(Str::new_static(speech.codec)),
			backend: Some(Str::new_static(speech.backend)),
			model: None,
			sample_rate: speech.sample_rate,
		})
	}
}
/// Syntactic pre-commit checks for `image_gen`.
fn validate_image_params(params: &MediaParams) -> Result<(), MediaFault> {
	if params
		.subject
		.as_deref()
		.is_none_or(|subject| subject.trim().is_empty())
	{
		return Err(media_fault("invalid_media_request", "none", "subject must not be empty"));
	}
	if params.input.as_ref().is_some_and(|inputs| {
		inputs
			.iter()
			.any(|input| input.path.is_some() == input.data.is_some())
	}) {
		return Err(media_fault(
			"invalid_input_image",
			"filesystem",
			"each input image must provide exactly one of path or data",
		));
	}
	if params.provider == Some(ImageProvider::Xai)
		&& params
			.input
			.as_ref()
			.is_some_and(|inputs| inputs.len() > MAX_XAI_EDIT_IMAGES)
	{
		return Err(media_fault(
			"too_many_input_images",
			"xai",
			"xAI image edits accept at most three reference images",
		));
	}
	Ok(())
}

/// Syntactic pre-commit checks for `tts`: nonempty text of at most 15,000
/// characters and a required `output_path`.
fn validate_speech_params(params: &MediaParams) -> Result<(), MediaFault> {
	let text = params.text.as_deref().unwrap_or("");
	if text.trim().is_empty() {
		return Err(media_fault("invalid_media_request", "none", "text must not be empty"));
	}
	if text.encode_utf16().count() > MAX_SPEECH_CHARS {
		return Err(media_fault(
			"text_too_long",
			"none",
			"text must be at most 15000 characters; split longer passages into several calls",
		));
	}
	if params
		.output_path
		.as_deref()
		.is_none_or(|path| path.trim().is_empty())
	{
		return Err(media_fault(
			"output_path_required",
			"none",
			"output_path is required: tts writes the audio there atomically and also retains it as \
			 an artifact",
		));
	}
	Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ImageAttempt {
	provider: ImageProvider,
	model:    Str,
}

const AUTO_IMAGE_PROVIDER_ORDER: [ImageProvider; 7] = [
	ImageProvider::Openai,
	ImageProvider::OpenaiCodex,
	ImageProvider::Antigravity,
	ImageProvider::Xai,
	ImageProvider::Openrouter,
	ImageProvider::Gemini,
	ImageProvider::Deepinfra,
];

fn active_provider(model: Option<&str>) -> Option<ImageProvider> {
	match model?.split_once('/')?.0 {
		"openai" => Some(ImageProvider::Openai),
		"openai-codex" => Some(ImageProvider::OpenaiCodex),
		"google-antigravity" => Some(ImageProvider::Antigravity),
		"xai" | "xai-oauth" => Some(ImageProvider::Xai),
		"openrouter" => Some(ImageProvider::Openrouter),
		"deepinfra" => Some(ImageProvider::Deepinfra),
		"google" => Some(ImageProvider::Gemini),
		_ => None,
	}
}

fn image_model(provider: ImageProvider, active_model: Option<&Str>) -> Option<Str> {
	let active =
		active_model.filter(|model| active_provider(Some(model.as_str())) == Some(provider));
	if matches!(provider, ImageProvider::Openai) {
		return active.cloned();
	}
	if matches!(provider, ImageProvider::OpenaiCodex)
		&& let Some(active) = active
	{
		return Some(active.clone());
	}
	Some(sf!(match provider {
		ImageProvider::Auto => return None,
		ImageProvider::Antigravity => "google-antigravity/gemini-3-pro-image",
		ImageProvider::Deepinfra => "deepinfra/black-forest-labs/FLUX-2-pro",
		ImageProvider::Gemini => "google/gemini-3-pro-image-preview",
		ImageProvider::Openai => return None,
		ImageProvider::OpenaiCodex => "openai-codex/gpt-5.5",
		ImageProvider::Openrouter => "openrouter/google/gemini-3-pro-image-preview",
		ImageProvider::Xai => "xai/grok-imagine-image",
	}))
}

fn image_attempts(config: &ImageConfig, params: &MediaParams) -> Vec<ImageAttempt> {
	let mut providers = Vec::with_capacity(AUTO_IMAGE_PROVIDER_ORDER.len() + 2);
	let mut push = |provider| {
		if provider != ImageProvider::Auto && !providers.contains(&provider) {
			providers.push(provider);
		}
	};
	if let Some(provider) = params.provider {
		push(provider);
	}
	for &provider in &config.provider_order {
		push(provider);
	}
	if let Some(provider) = active_provider(config.active_model.as_deref()) {
		push(provider);
	}
	for provider in AUTO_IMAGE_PROVIDER_ORDER {
		push(provider);
	}

	let edit = params
		.input
		.as_ref()
		.is_some_and(|inputs| !inputs.is_empty());
	let mut attempts = Vec::new();
	for provider in providers {
		let supported = !matches!(
			(params.aspect_ratio, provider),
			(
				Some(ImageAspectRatio::ThreeTwo | ImageAspectRatio::TwoThree),
				ImageProvider::Antigravity
					| ImageProvider::Deepinfra
					| ImageProvider::Gemini
					| ImageProvider::Openai
					| ImageProvider::OpenaiCodex
					| ImageProvider::Openrouter
			)
		) && !(edit && provider == ImageProvider::Deepinfra)
			&& !(provider == ImageProvider::Xai
				&& params
					.input
					.as_ref()
					.is_some_and(|inputs| inputs.len() > MAX_XAI_EDIT_IMAGES));
		if !supported {
			continue;
		}
		if let Some(model) = image_model(provider, config.active_model.as_ref()) {
			attempts.push(ImageAttempt { provider, model });
		}
	}
	attempts
}

/// Builds the inference request for `image_gen`, loading the validated
/// `input_image` from the workspace.
fn image_request(
	root: &Path,
	params: &MediaParams,
) -> Result<inference_pb::GenerateImageRequest, MediaFault> {
	let prompt = assemble_image_prompt(params);
	let input_images = params
		.input
		.as_deref()
		.unwrap_or_default()
		.iter()
		.map(|input| load_image_input(root, input))
		.collect::<Result<Vec<_>, _>>()?;
	Ok(inference_pb::GenerateImageRequest {
		model: String::new(),
		prompt,
		n: 1,
		aspect_ratio: aspect_ratio(params.aspect_ratio),
		size: image_size(params.image_size).or_else(|| image_aspect_size(params.aspect_ratio)),
		quality: generate_image_request::Quality::Medium as i32,
		format: image_format(),
		background: generate_image_request::Background::Unspecified as i32,
		compression: None,
		seed: None,
		input_images,
		props: None,
	})
}

const fn image_size(value: Option<ImageSize>) -> Option<generate_image_request::ImageSize> {
	match value {
		None => None,
		Some(ImageSize::Square) => {
			Some(generate_image_request::ImageSize { width: 1024, height: 1024 })
		},
		Some(ImageSize::Landscape) => {
			Some(generate_image_request::ImageSize { width: 1536, height: 1024 })
		},
		Some(ImageSize::Portrait) => {
			Some(generate_image_request::ImageSize { width: 1024, height: 1536 })
		},
	}
}

const fn image_aspect_size(
	value: Option<ImageAspectRatio>,
) -> Option<generate_image_request::ImageSize> {
	match value {
		None => None,
		Some(ImageAspectRatio::OneOne) => image_size(Some(ImageSize::Square)),
		Some(
			ImageAspectRatio::ThreeFour | ImageAspectRatio::NineSixteen | ImageAspectRatio::TwoThree,
		) => image_size(Some(ImageSize::Portrait)),
		Some(
			ImageAspectRatio::FourThree | ImageAspectRatio::SixteenNine | ImageAspectRatio::ThreeTwo,
		) => image_size(Some(ImageSize::Landscape)),
	}
}

fn assemble_image_prompt(params: &MediaParams) -> String {
	fn without_terminal_punctuation(value: &str) -> &str {
		value.trim_end_matches(['.', '!', ',', ';', ':'])
	}

	let mut prompt = String::new();
	prompt.push_str(without_terminal_punctuation(
		params.subject.as_deref().expect("validated image subject"),
	));
	for detail in [params.action.as_deref(), params.scene.as_deref()]
		.into_iter()
		.flatten()
	{
		prompt.push_str(", ");
		prompt.push_str(without_terminal_punctuation(detail));
	}
	for detail in
		[params.composition.as_deref(), params.lighting.as_deref(), params.style.as_deref()]
			.into_iter()
			.flatten()
	{
		prompt.push_str(". ");
		prompt.push_str(without_terminal_punctuation(detail));
	}
	prompt.push('.');
	if let Some(text) = params.text.as_deref() {
		prompt.push_str("\n\nText: ");
		prompt.push_str(text);
	}
	if let Some(changes) = params
		.changes
		.as_deref()
		.filter(|changes| !changes.is_empty())
	{
		prompt.push_str("\n\nChanges:");
		for change in changes {
			prompt.push_str("\n- ");
			prompt.push_str(change);
		}
	}
	prompt
}

fn load_image_input(root: &Path, input: &ImageInput) -> Result<thread_pb::Blob, MediaFault> {
	let (image, asserted_mime) = if let Some(path) = input.path.as_deref() {
		(load_input_image(root, path)?, input.mime_type.as_deref())
	} else {
		let raw = input
			.data
			.as_deref()
			.expect("validated inline image")
			.trim();
		let (data, data_url_mime) = if let Some(rest) = raw.strip_prefix("data:") {
			let Some((mime, data)) = rest.split_once(";base64,") else {
				return Err(media_fault(
					"invalid_input_image",
					"input",
					"image data URL must use the base64 encoding",
				));
			};
			if !mime.starts_with("image/") {
				return Err(media_fault(
					"input_image_unsupported",
					"input",
					"image data URL must declare an image MIME type",
				));
			}
			(data, Some(mime))
		} else {
			(raw, input.mime_type.as_deref())
		};
		let Some(asserted_mime) = data_url_mime else {
			return Err(media_fault(
				"input_image_mime_required",
				"input",
				"mime_type is required with raw base64 image data",
			));
		};
		if data.is_empty() {
			return Err(media_fault("input_image_empty", "input", "image data is empty"));
		}
		if data.len() > MAX_INPUT_IMAGE_BASE64_BYTES {
			return Err(media_fault(
				"input_image_too_large",
				"input",
				"input image exceeds the 35 MiB limit",
			));
		}
		let bytes = omp_core::base64::decode(data.as_bytes())
			.into_vec()
			.map_err(|_| {
				media_fault("invalid_input_image", "input", "input image data is not valid base64")
			})?;
		(image_blob(bytes)?, Some(asserted_mime))
	};
	if asserted_mime.is_some_and(|asserted| asserted != image.mime) {
		return Err(media_fault(
			"input_image_mime_mismatch",
			"input",
			"input image MIME assertion does not match its bytes",
		));
	}
	Ok(image)
}

/// Retains a generated image as an artifact and, when requested, writes it to
/// the resolved output target.
fn finish_image(
	blobs: &BlobHost,
	output: Option<&OutputTarget>,
	attempt: &ImageAttempt,
	image: &thread_pb::Blob,
) -> Result<MediaPayload, MediaFault> {
	let (artifact_id, blob) = store_blob(blobs, image)?;
	let output_path = output
		.map(|target| {
			if image.inline.is_empty() {
				return Err(media_fault(
					"image_bytes_unavailable",
					"inference",
					"provider returned a reference-only image; output_path cannot be written",
				));
			}
			target.write(&image.inline)
		})
		.transpose()?;
	Ok(MediaPayload {
		artifact_id,
		media_type: Str::new(if image.mime.is_empty() {
			"image/png"
		} else {
			&image.mime
		}),
		output_path,
		blob,
		bytes: Some(if image.inline.is_empty() {
			image.size
		} else {
			u64::try_from(image.inline.len()).unwrap_or(u64::MAX)
		}),
		voice_id: None,
		codec: None,
		backend: Some(Str::new(<&'static str>::from(attempt.provider))),
		model: Some(attempt.model.clone()),
		sample_rate: None,
	})
}

/// Loads a workspace-contained `input_image`, enforcing the 35 MiB ceiling and
/// a recognized image signature.
fn load_input_image(root: &Path, authored: &str) -> Result<thread_pb::Blob, MediaFault> {
	let Some(relative) = workspace_relative(authored) else {
		return Err(media_fault(
			"invalid_input_image",
			"filesystem",
			"input_image must be workspace-relative and contained",
		));
	};
	let root = root.canonicalize().map_err(media_io_fault)?;
	let target = root.join(relative).canonicalize().map_err(|error| {
		if error.kind() == io::ErrorKind::NotFound {
			media_fault("input_image_missing", "filesystem", "input_image file not found")
		} else {
			media_io_fault(error)
		}
	})?;
	if !target.starts_with(&root) {
		return Err(media_fault(
			"invalid_input_image",
			"filesystem",
			"input_image escapes the workspace",
		));
	}
	let file = std::fs::File::open(&target).map_err(media_io_fault)?;
	let metadata = file.metadata().map_err(media_io_fault)?;
	if !metadata.is_file() {
		return Err(media_fault(
			"invalid_input_image",
			"filesystem",
			"input_image must be a regular file",
		));
	}
	if metadata.len() > MAX_INPUT_IMAGE_BYTES {
		return Err(media_fault(
			"input_image_too_large",
			"filesystem",
			"input_image exceeds the 35 MiB limit",
		));
	}
	let mut bytes =
		Vec::with_capacity(usize::try_from(metadata.len().min(MAX_INPUT_IMAGE_BYTES)).unwrap_or(0));
	file
		.take(MAX_INPUT_IMAGE_BYTES + 1)
		.read_to_end(&mut bytes)
		.map_err(media_io_fault)?;
	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_INPUT_IMAGE_BYTES {
		return Err(media_fault(
			"input_image_too_large",
			"filesystem",
			"input_image exceeds the 35 MiB limit",
		));
	}
	image_blob(bytes)
}

fn image_blob(bytes: Vec<u8>) -> Result<thread_pb::Blob, MediaFault> {
	if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_INPUT_IMAGE_BYTES {
		return Err(media_fault(
			"input_image_too_large",
			"input",
			"input image exceeds the 35 MiB limit",
		));
	}
	let kind = sniff_metadata(&bytes)
		.map(|metadata| metadata.kind)
		.ok_or_else(|| {
			media_fault(
				"input_image_unsupported",
				"filesystem",
				"input_image is not a PNG, JPEG, GIF, or WebP image",
			)
		})?;
	Ok(thread_pb::Blob {
		hash:   bytes::Bytes::copy_from_slice(omp_core::Hash32::sum(&bytes).as_bytes()),
		mime:   kind.media_type().to_owned(),
		size:   u64::try_from(bytes.len()).unwrap_or(u64::MAX),
		inline: bytes.into(),
		detail: blob::Detail::Original as i32,
	})
}

/// Returns the authored path when it is a nonempty relative path without
/// parent, root, or prefix components.
fn workspace_relative(authored: &str) -> Option<&Path> {
	let path = Path::new(authored);
	let contained = !path.as_os_str().is_empty()
		&& !path.components().any(|component| {
			matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
		});
	contained.then_some(path)
}

/// Workspace-contained `output_path` resolved before any provider call so an
/// unwritable destination never costs a generation.
#[derive(Debug)]
struct OutputTarget {
	authored:  Str,
	target:    PathBuf,
	temporary: PathBuf,
}

fn now_ms() -> u128 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
}

impl OutputTarget {
	fn resolve(root: &Path, authored: &str) -> Result<Self, MediaFault> {
		let Some(path) = workspace_relative(authored) else {
			return Err(media_fault(
				"invalid_output_path",
				"filesystem",
				"output_path must be workspace-relative and contained",
			));
		};
		let root = root.canonicalize().map_err(media_io_fault)?;
		let target = root.join(path);
		let parent = target.parent().ok_or_else(|| {
			media_fault("invalid_output_path", "filesystem", "output_path has no parent")
		})?;
		let canonical_parent = parent.canonicalize().map_err(media_io_fault)?;
		if !canonical_parent.starts_with(&root) {
			return Err(media_fault(
				"invalid_output_path",
				"filesystem",
				"output_path escapes the workspace",
			));
		}
		let file_name = target.file_name().ok_or_else(|| {
			media_fault("invalid_output_path", "filesystem", "output_path has no file name")
		})?;
		let temporary = canonical_parent.join(format!(
			".{}.omp-media-{}-{}",
			file_name.to_string_lossy(),
			std::process::id(),
			now_ms()
		));
		Ok(Self { authored: Str::new(authored), target: canonical_parent.join(file_name), temporary })
	}

	/// Writes `bytes` through a same-directory temporary file and an atomic
	/// rename, returning the authored path.
	fn write(&self, bytes: &[u8]) -> Result<Str, MediaFault> {
		let write_result = (|| -> io::Result<()> {
			use std::io::Write as _;
			let mut file = OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(&self.temporary)?;
			file.write_all(bytes)?;
			file.sync_all()?;
			fs::rename(&self.temporary, &self.target)
		})();
		if let Err(error) = write_result {
			let _ = fs::remove_file(&self.temporary);
			return Err(media_io_fault(error));
		}
		Ok(self.authored.clone())
	}
}

impl Tool for MediaDevice {
	type Fault = MediaFault;
	type Params = MediaParams;
	type Payload = MediaPayload;
	type Update = MediaUpdate;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<MediaUpdate, MediaPayload, MediaFault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<MediaParams>().await {
				Ok(params) => params,
				Err(error) => { yield media_param_event(error); return; },
			};
			let validation = match self.kind {
				MediaKind::Image => validate_image_params(&params),
				MediaKind::Speech => validate_speech_params(&params),
			};
			if let Err(fault) = validation {
				yield media_done(Err(fault));
				return;
			}
			if matches!(self.kind, MediaKind::Speech)
				&& let Err(fault) = OutputTarget::resolve(
					&self.root,
					params
						.output_path
						.as_deref()
						.expect("validated speech output path"),
				)
			{
				yield media_done(Err(fault));
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield media_commit_event(error);
				return;
			}
			match self.kind {
				MediaKind::Image => {
					let output = match params
						.output_path
						.as_deref()
						.map(|path| OutputTarget::resolve(&self.root, path))
						.transpose()
					{
						Ok(output) => output,
						Err(fault) => {
							yield media_done(Err(fault));
							return;
						},
					};
					let mut request = match image_request(&self.root, &params) {
						Ok(request) => request,
						Err(fault) => {
							yield media_done(Err(fault));
							return;
						},
					};
					let config = self.image.as_ref().expect("image devices carry routing config");
					let attempts = image_attempts(config, &params);
					if attempts.is_empty() {
						yield media_done(Err(media_fault(
							"image_route_unavailable",
							"routing",
							"no configured image provider can satisfy this request",
						)));
						return;
					}
					let deadline = tokio::time::sleep(IMAGE_TIMEOUT);
					tokio::pin!(deadline);
					let mut last_failure = None;
					for (index, attempt) in attempts.iter().enumerate() {
						request.model = attempt.model.to_string();
						yield Ev::Update(MediaUpdate::Image {
							phase: if index == 0 { ImagePhase::Request } else { ImagePhase::Fallback },
							provider: attempt.provider,
							model: attempt.model.clone(),
						});
						let generation = self.backend.generate_image(request.clone());
						tokio::pin!(generation);
						let result = tokio::select! {
							biased;
							interrupt = incoming.next_interrupt() => {
								match interrupt {
									Ok(interrupt) => yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
									Err(omp_tool::InterruptWaitError::Closed) => yield Ev::Aborted(Abort::InputDropped),
									Err(omp_tool::InterruptWaitError::Protocol(message)) => {
										yield Ev::Args(protocol_issue(message));
									},
								}
								return;
							},
							() = &mut deadline => {
								yield media_done(Err(media_fault(
									"image_timeout",
									"inference",
									"image generation exceeded the three minute deadline",
								)));
								return;
							},
							result = &mut generation => result,
						};
						match result {
							Ok(images) => {
								yield media_done(self.image_output(output.as_ref(), attempt, images));
								return;
							},
							Err(error) => last_failure = Some((attempt.provider, error)),
						}
					}
					yield media_done(Err(last_failure.map_or_else(
						|| media_fault(
							"image_all_providers_failed",
							"routing",
							"image generation failed for every eligible provider",
						),
						|(provider, error)| image_backend_fault(provider, error),
					)));
				},
				MediaKind::Speech => {
					let producer = self
						.speech
						.as_ref()
						.expect("speech devices carry a producer");
					let cancellation = CancellationToken::new();
					let (updates_tx, updates_rx) = flume::bounded(8);
					let mut synthesis = Box::pin(producer.synthesize(
						Self::speech_input(&params),
						cancellation.clone(),
						updates_tx,
					));
					let mut updates_open = true;
					loop {
						tokio::select! {
							biased;
							interrupt = incoming.next_interrupt() => {
								cancellation.cancel();
								match interrupt {
									Ok(interrupt) => yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
									Err(omp_tool::InterruptWaitError::Closed) => yield Ev::Aborted(Abort::InputDropped),
									Err(omp_tool::InterruptWaitError::Protocol(message)) => {
										yield Ev::Args(protocol_issue(message));
									},
								}
								return;
							},
							update = updates_rx.recv_async(), if updates_open => match update {
								Ok(update) => yield Ev::Update(MediaUpdate::Audio {
									chunks: update.chunks,
									bytes: update.bytes,
								}),
								Err(_) => updates_open = false,
							},
							result = &mut synthesis => {
								yield media_done(result.and_then(|speech| self.finish_speech(speech)));
								return;
							},
						}
					}
				},
			}
		}
	}

	fn prompt(&self, view: Result<&MediaPayload, &MediaFault>, _: &PromptCaps) -> Vec<Part> {
		match view {
			Ok(payload) if matches!(self.kind, MediaKind::Speech) => vec![Part::Json {
				json: Bytes::from(
					serde_json::to_vec(payload).expect("speech payload serialization is infallible"),
				),
			}],
			Ok(payload) => payload.blob.clone().map_or_else(
				|| {
					vec![Part::Text {
						text: Str::from(format!(
							"Generated {} artifact {}",
							payload.media_type, payload.artifact_id
						)),
					}]
				},
				|blob| vec![Part::Blob { blob, alt: None }],
			),
			Err(fault) => vec![Part::Json {
				json: Bytes::from(
					serde_json::to_vec(fault).expect("media fault serialization is infallible"),
				),
			}],
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		let supported = match self.kind {
			MediaKind::Image => matches!(from.n, 1 | 2 | 3),
			MediaKind::Speech => matches!(from.n, 1 | 2 | 3),
		};
		if !from.family.is_empty() || !supported {
			return None;
		}
		let mut arguments: Value = serde_json::from_slice(call.raw_args).ok()?;
		let object = arguments.as_object_mut()?;
		match self.kind {
			MediaKind::Image => {
				if let Some(prompt) = object.remove("prompt") {
					let subject = match prompt {
						Value::String(subject) => Value::String(subject),
						structured => Value::String(structured.to_string()),
					};
					object.insert("subject".to_owned(), subject);
				}
				if let Some(input) = object.remove("input_image") {
					object.insert(
						"input".to_owned(),
						Value::Array(vec![serde_json::json!({ "path": input })]),
					);
				}
				object.remove("format");
			},
			MediaKind::Speech => {
				object.remove("provider");
				object.remove("voice");
				object.remove("format");
			},
		}
		Some(LiftedCall {
			raw_args: Bytes::from(serde_json::to_vec(&arguments).ok()?),
			verdict:  Bytes::copy_from_slice(call.verdict),
		})
	}
}

/// Translates provider-neutral media vocabulary into the canonical inference
/// wire.
const fn aspect_ratio(value: Option<ImageAspectRatio>) -> i32 {
	match value {
		None | Some(ImageAspectRatio::OneOne) => 1,
		Some(ImageAspectRatio::SixteenNine) => 2,
		Some(ImageAspectRatio::NineSixteen) => 3,
		Some(ImageAspectRatio::FourThree) => 4,
		Some(ImageAspectRatio::ThreeFour) => 5,
		Some(ImageAspectRatio::ThreeTwo) => 6,
		Some(ImageAspectRatio::TwoThree) => 7,
	}
}

const fn image_format() -> i32 {
	generate_image_request::Format::Png as i32
}

fn store_blob(
	blobs: &BlobHost,
	blob: &thread_pb::Blob,
) -> Result<(Str, Option<omp_tool::BlobRef>), MediaFault> {
	if blob.inline.len() > MAX_GENERATED_IMAGE_BYTES
		|| blob.size > u64::try_from(MAX_GENERATED_IMAGE_BYTES).unwrap_or(u64::MAX)
	{
		return Err(media_fault(
			"generated_image_too_large",
			"inference",
			"generated image exceeds the 64 MiB host limit",
		));
	}
	if blob.inline.is_empty() {
		let hash = <[u8; 32]>::try_from(blob.hash.as_ref()).map_err(|_| {
			media_fault("invalid_image_artifact", "inference", "image artifact has no bytes or digest")
		})?;
		return Ok((Str::new(ArtifactUrl::from_digest(hash).as_str()), None));
	}
	let id = blobs.put(&blob.inline).map_err(media_blob_fault)?;
	let media_type = Str::new(if blob.mime.is_empty() {
		"image/png"
	} else {
		blob.mime.as_str()
	});
	Ok((
		Str::new(ArtifactUrl::from_digest(id.hash).as_str()),
		Some(omp_tool::BlobRef {
			hash: Str::new(omp_core::Hash32::new(id.hash).to_hex().as_str()),
			media_type,
			byte_len: id.size,
		}),
	))
}

fn media_fault(code: &'static str, backend: &'static str, message: &'static str) -> MediaFault {
	MediaFault {
		code:    Str::new_static(code),
		backend: Str::new_static(backend),
		message: Str::new_static(message),
	}
}

fn image_backend_fault(
	provider: ImageProvider,
	error: omp_tools::web_search::BackendError,
) -> MediaFault {
	MediaFault {
		code:    error.code,
		backend: Str::new(<&'static str>::from(provider)),
		message: sf!("the inference media request failed"),
	}
}

fn media_blob_fault(error: BlobError) -> MediaFault {
	MediaFault {
		code:    sf!("media_artifact_failed"),
		backend: sf!("blob"),
		message: Str::new(error.to_string()),
	}
}

fn media_io_fault(error: io::Error) -> MediaFault {
	MediaFault {
		code:    sf!("media_input_failed"),
		backend: sf!("filesystem"),
		message: Str::new(error.to_string()),
	}
}

const fn media_done(
	result: Result<MediaPayload, MediaFault>,
) -> Ev<MediaUpdate, MediaPayload, MediaFault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}
fn media_param_event(error: ParamError) -> Ev<MediaUpdate, MediaPayload, MediaFault> {
	map_param(error)
}
fn media_commit_event(error: CommitError) -> Ev<MediaUpdate, MediaPayload, MediaFault> {
	map_commit(error)
}
fn map_param<U, P, F>(error: ParamError) -> Ev<U, P, F> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn map_commit<U, P, F>(error: CommitError) -> Ev<U, P, F> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}
#[cfg(test)]
mod tests {
	use tempfile::tempdir;

	use super::*;

	fn media_params() -> MediaParams {
		MediaParams {
			subject:      None,
			action:       None,
			scene:        None,
			composition:  None,
			lighting:     None,
			style:        None,
			text:         None,
			changes:      None,
			aspect_ratio: None,
			image_size:   None,
			input:        None,
			provider:     None,
			voice_id:     None,
			language:     None,
			sample_rate:  None,
			bit_rate:     None,
			output_path:  None,
		}
	}

	#[test]
	fn tts_schema_and_runtime_require_bounded_text_and_output_path() {
		let root = tempdir().expect("root");
		let blobs = BlobHost::open(root.path().join("blobs")).expect("blobs");
		let backend = Arc::new(SearchBridgeHost::new(None));
		let device = tts(backend, blobs, root.path().to_path_buf());
		let schema: Value = serde_json::from_slice(&device.spec().schema).expect("tts schema");
		assert_eq!(schema["required"], serde_json::json!(["i", "text", "output_path"]));
		assert_eq!(
			schema["properties"]
				.as_object()
				.expect("TTS properties")
				.keys()
				.map(String::as_str)
				.collect::<std::collections::BTreeSet<_>>(),
			[
				"bit_rate",
				"i",
				"language",
				"notrunc",
				"output_path",
				"sample_rate",
				"text",
				"voice_id",
			]
				.into_iter()
				.collect()
		);

		let mut params = media_params();
		params.text = Some(Str::new("x".repeat(MAX_SPEECH_CHARS)));
		params.output_path = Some(sf!("speech.wav"));
		assert_eq!(validate_speech_params(&params), Ok(()));

		params.text = Some(Str::new("x".repeat(MAX_SPEECH_CHARS + 1)));
		assert_eq!(
			validate_speech_params(&params)
				.expect_err("overlong speech")
				.code,
			"text_too_long"
		);
		params.text = Some(sf!("hello"));
		params.output_path = None;
		assert_eq!(
			validate_speech_params(&params)
				.expect_err("missing output path")
				.code,
			"output_path_required"
		);
	}

	#[test]
	fn image_schema_and_request_preserve_structured_contract() {
		let root = tempdir().expect("root");
		let blobs = BlobHost::open(root.path().join("blobs")).expect("blobs");
		let backend = Arc::new(SearchBridgeHost::new(None));
		let device = image_gen(backend, ImageConfig::default(), blobs, root.path().to_path_buf());
		let schema: Value = serde_json::from_slice(&device.spec().schema).expect("image schema");
		assert_eq!(device.spec().name, "image_gen");
		assert_eq!(device.spec().rev.n, 4);
		assert_eq!(schema["required"], serde_json::json!(["i", "subject"]));
		assert_eq!(
			schema["properties"]
				.as_object()
				.expect("image properties")
				.keys()
				.map(String::as_str)
				.collect::<std::collections::BTreeSet<_>>(),
			[
				"action",
				"aspect_ratio",
				"changes",
				"composition",
				"i",
				"image_size",
				"input",
				"lighting",
				"notrunc",
				"output_path",
				"provider",
				"scene",
				"style",
				"subject",
				"text",
			]
			.into_iter()
			.collect()
		);

		let mut params = media_params();
		params.subject = Some(sf!("frog"));
		params.action = Some(sf!("jumping"));
		params.scene = Some(sf!("a pond"));
		params.composition = Some(sf!("wide shot"));
		params.changes = Some(vec![sf!("make the frog blue")]);
		params.aspect_ratio = Some(ImageAspectRatio::SixteenNine);
		params.image_size = Some(ImageSize::Landscape);
		params.input = Some(vec![ImageInput {
			path:      None,
			data:      Some(Str::new(omp_core::base64::encode(b"\x89PNG\r\n\x1a\n").into_string())),
			mime_type: Some(sf!("image/png")),
		}]);
		assert_eq!(validate_image_params(&params), Ok(()));
		let request = image_request(root.path(), &params).expect("image request");
		assert_eq!(
			request.prompt,
			"frog, jumping, a pond. wide shot.\n\nChanges:\n- make the frog blue"
		);
		assert_eq!(
			request.size,
			Some(generate_image_request::ImageSize { width: 1536, height: 1024 })
		);
		assert_eq!(request.input_images.len(), 1);
		assert_eq!(request.input_images[0].mime, "image/png");

		let data_url =
			format!("data:image/png;base64,{}", omp_core::base64::encode(b"\x89PNG\r\n\x1a\n"));
		let image = load_image_input(&root.path(), &ImageInput {
			path:      None,
			data:      Some(Str::new(data_url)),
			mime_type: None,
		})
		.expect("data URL image");
		assert_eq!(image.mime, "image/png");
		assert_eq!(
			load_image_input(&root.path(), &ImageInput {
				path:      None,
				data:      Some(
					Str::new(omp_core::base64::encode(b"\x89PNG\r\n\x1a\n").into_string(),)
				),
				mime_type: None,
			})
			.expect_err("raw base64 requires MIME")
			.code,
			"input_image_mime_required"
		);
	}

	#[test]
	fn image_provider_routing_follows_request_config_active_then_auto_order() {
		let mut params = media_params();
		params.subject = Some(sf!("frog"));
		params.provider = Some(ImageProvider::Gemini);
		let config = ImageConfig {
			provider_order: vec![ImageProvider::Deepinfra, ImageProvider::Gemini],
			active_model:   Some(sf!("xai/grok-4")),
		};
		let attempts = image_attempts(&config, &params);
		assert_eq!(
			attempts
				.iter()
				.map(|attempt| attempt.provider)
				.collect::<Vec<_>>(),
			vec![
				ImageProvider::Gemini,
				ImageProvider::Deepinfra,
				ImageProvider::Xai,
				ImageProvider::OpenaiCodex,
				ImageProvider::Antigravity,
				ImageProvider::Openrouter,
			]
		);

		params.input = Some(vec![ImageInput {
			path:      Some(sf!("source.png")),
			data:      None,
			mime_type: None,
		}]);
		params.aspect_ratio = Some(ImageAspectRatio::ThreeTwo);
		assert_eq!(image_attempts(&config, &params), vec![ImageAttempt {
			provider: ImageProvider::Xai,
			model:    sf!("xai/grok-imagine-image"),
		}]);
	}

	#[test]
	fn legacy_media_calls_lift_to_current_revisions() {
		let root = tempdir().expect("root");
		let blobs = BlobHost::open(root.path().join("blobs")).expect("blobs");
		let backend = Arc::new(SearchBridgeHost::new(None));
		let image = image_gen(
			Arc::clone(&backend),
			ImageConfig::default(),
			blobs.clone(),
			root.path().to_path_buf(),
		);
		let lifted = image
			.lift(&Rev { family: Str::default(), n: 2 }, RecordedCall {
				raw_args: br#"{"prompt":"frog","input_image":"frog.png","format":"png"}"#,
				verdict:  br#"{"kind":"ok","value":{}}"#,
			})
			.expect("legacy image lift");
		let arguments: Value = serde_json::from_slice(&lifted.raw_args).expect("lifted arguments");
		assert_eq!(arguments["subject"], "frog");
		assert_eq!(arguments["input"], serde_json::json!([{"path":"frog.png"}]));
		assert!(arguments.get("prompt").is_none());
		assert!(arguments.get("format").is_none());

		let speech = tts(backend, blobs, root.path().to_path_buf());
		let lifted = speech
			.lift(
				&Rev { family: Str::default(), n: 2 },
				RecordedCall {
					raw_args: br#"{"text":"hello","output_path":"hello.wav","provider":"local","voice":"old","format":"wav"}"#,
					verdict:  br#"{"kind":"ok","value":{}}"#,
				},
			)
			.expect("legacy speech lift");
		let arguments: Value = serde_json::from_slice(&lifted.raw_args).expect("lifted arguments");
		assert_eq!(arguments["text"], "hello");
		assert_eq!(arguments["output_path"], "hello.wav");
		assert!(arguments.get("provider").is_none());
		assert!(arguments.get("voice").is_none());
		assert!(arguments.get("format").is_none());
	}

	#[test]
	fn generated_image_round_trips_as_a_typed_blob_part() {
		let root = tempdir().expect("root");
		let blobs = BlobHost::open(root.path().join("blobs")).expect("blobs");
		let backend = Arc::new(SearchBridgeHost::new(None));
		let device =
			image_gen(backend, ImageConfig::default(), blobs.clone(), root.path().to_path_buf());
		let payload = finish_image(
			&blobs,
			None,
			&ImageAttempt {
				provider: ImageProvider::Gemini,
				model:    sf!("google/gemini-3-pro-image-preview"),
			},
			&thread_pb::Blob {
				hash:   Bytes::new(),
				mime:   "image/png".to_owned(),
				size:   3,
				inline: Bytes::from_static(b"png"),
				detail: blob::Detail::Original as i32,
			},
		)
		.expect("finish image");
		assert_eq!(payload.backend.as_deref(), Some("gemini"));
		assert_eq!(payload.model.as_deref(), Some("google/gemini-3-pro-image-preview"));
		assert_eq!(payload.bytes, Some(3));
		let parts = device.prompt(Ok(&payload), &PromptCaps {
			maximum_parts:      16,
			maximum_text_bytes: 1024,
			media:              true,
			dialect:            Default::default(),
			model_class:        Default::default(),
		});
		let [Part::Blob { blob, alt: None }] = parts.as_slice() else {
			panic!("image prompt must retain a typed blob")
		};
		assert_eq!(blob.media_type, "image/png");
		assert_eq!(blob.byte_len, 3);
		let hash = blob.hash.parse::<omp_core::Hash32>().expect("blob hash");
		assert_eq!(
			blobs
				.get(crate::blobs::BlobId { hash: hash.into_bytes(), size: blob.byte_len })
				.expect("round-trip blob"),
			Bytes::from_static(b"png")
		);
	}

	#[test]
	fn image_input_is_workspace_rooted_capped_and_mime_sniffed() {
		let root = tempdir().expect("root");
		fs::write(root.path().join("image.bin"), b"\x89PNG\r\n\x1a\n").expect("image");
		let image = load_input_image(root.path(), "image.bin").expect("sniff image");
		assert_eq!(image.mime, "image/png");
		assert_eq!(image.inline.as_ref(), b"\x89PNG\r\n\x1a\n");

		fs::write(root.path().join("text.png"), b"not an image").expect("text");
		assert_eq!(
			load_input_image(root.path(), "text.png")
				.expect_err("reject extension-only image")
				.code,
			"input_image_unsupported"
		);
		assert_eq!(
			load_input_image(root.path(), "../outside.png")
				.expect_err("reject parent traversal")
				.code,
			"invalid_input_image"
		);

		let oversized = std::fs::File::create(root.path().join("large.png")).expect("large image");
		oversized
			.set_len(MAX_INPUT_IMAGE_BYTES + 1)
			.expect("sparse oversized image");
		assert_eq!(
			load_input_image(root.path(), "large.png")
				.expect_err("reject oversized image")
				.code,
			"input_image_too_large"
		);
	}

	#[cfg(unix)]
	#[test]
	fn image_input_and_output_refuse_symlink_escape() {
		use std::os::unix::fs::symlink;

		let root = tempdir().expect("root");
		let outside = tempdir().expect("outside");
		fs::write(outside.path().join("image.png"), b"\x89PNG\r\n\x1a\n").expect("outside image");
		symlink(outside.path(), root.path().join("escape")).expect("symlink");
		assert_eq!(
			load_input_image(root.path(), "escape/image.png")
				.expect_err("input symlink escape")
				.code,
			"invalid_input_image"
		);
		assert_eq!(
			OutputTarget::resolve(root.path(), "escape/output.png")
				.expect_err("output symlink escape")
				.code,
			"invalid_output_path"
		);
	}

	#[test]
	fn output_target_atomically_replaces_only_the_contained_file() {
		let root = tempdir().expect("root");
		fs::create_dir(root.path().join("out")).expect("output directory");
		let target = OutputTarget::resolve(root.path(), "out/speech.wav").expect("target");
		assert_eq!(target.write(b"first").expect("first write"), "out/speech.wav");
		assert_eq!(fs::read(root.path().join("out/speech.wav")).expect("first read"), b"first");

		let replacement =
			OutputTarget::resolve(root.path(), "out/speech.wav").expect("replacement target");
		assert_eq!(replacement.write(b"second").expect("replacement write"), "out/speech.wav");
		assert_eq!(
			fs::read(root.path().join("out/speech.wav")).expect("replacement read"),
			b"second"
		);
	}
}
