//! Amazon Bedrock `ConverseStream` request lowering and event projection.

use std::{
	collections::{BTreeMap, BTreeSet},
	str,
	sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use omp_catalog::{
	Availability, ChatCapabilities, ClassId, DiscoveredModel, ModalityBits, ModelAvailability,
	ModelCapabilities, OperationBits, OperationKind, PromptCacheMode, ReasoningEffort,
	ThinkingEffort, ThinkingMode, WireModelId,
};
use omp_core::{Str, encoding::base64, sf};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value, value::RawValue};
use url::Url;

use crate::{
	body::BodySource,
	call::{
		CacheRetention, ChatRequest, ContentPart, MediaInput, Message, OpaqueJson, OperationCall,
		ProviderProof, ReasoningVisibility, Role, Setting, ToolChoice, ToolResultContent,
	},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
		ProviderMetadataEvent, ProviderStateEvent, ProviderTelemetryEvent, RawCompletion, RawEvent,
		RequestHeader, RequestMethod, SafetyAction, SafetyConfidence, SafetyFinding,
		SafetyFindingKind, SafetyStrength, SizeBounds, ToolInputKind, UnvalidatedToolCall,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{EventStreamMessage, Frame, FramingProtocol},
};

/// Reserved tool declaration used only when historical tool blocks require a
/// `toolConfig`.
pub const NO_TOOLS_SENTINEL_NAME: &str = "__no_tools__";

/// Bedrock Guardrail stream trace level.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardrailTraceMode {
	/// Do not request trace details.
	Disabled,
	/// Request the standard guardrail trace.
	Enabled,
	/// Request the complete guardrail trace.
	EnabledFull,
}

/// Bedrock Guardrail streaming assessment mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardrailStreamMode {
	/// Assess each stream segment synchronously.
	Sync,
	/// Allow asynchronous stream assessment.
	Async,
}

/// Typed Bedrock Guardrail configuration applied before `SigV4` credential
/// middleware.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct BedrockGuardrail {
	/// Guardrail identifier or ARN.
	#[serde(alias = "guardrailIdentifier")]
	pub identifier:  Str,
	/// Immutable or named guardrail version.
	#[serde(default = "draft_guardrail_version", alias = "guardrailVersion")]
	pub version:     Str,
	/// Requested trace detail; absent preserves Bedrock's default.
	#[serde(default, alias = "guardrailTrace", skip_serializing_if = "Option::is_none")]
	pub trace:       Option<GuardrailTraceMode>,
	/// Streaming assessment mode; absent preserves Bedrock's default.
	#[serde(default, alias = "streamProcessingMode", skip_serializing_if = "Option::is_none")]
	pub stream_mode: Option<GuardrailStreamMode>,
}
fn draft_guardrail_version() -> Str {
	sf!("DRAFT")
}

/// Bedrock-specific lowering options supplied by registry construction, never
/// by an untyped bag.
#[derive(Clone, Debug)]
pub struct BedrockOptions {
	/// Optional typed Guardrail configuration.
	pub guardrail:          Option<BedrockGuardrail>,
	/// Bedrock invocation-log attribution tags.
	pub request_metadata:   BTreeMap<Str, Str>,
	/// Maximum encoded request body.
	pub max_request_bytes:  u64,
	/// Maximum CRC-validated `EventStream` payload.
	pub max_frame_bytes:    u64,
	/// Maximum aggregate response bytes.
	pub max_response_bytes: u64,
}

impl Default for BedrockOptions {
	fn default() -> Self {
		Self {
			guardrail:          None,
			request_metadata:   BTreeMap::new(),
			max_request_bytes:  16 * 1024 * 1024,
			max_frame_bytes:    16 * 1024 * 1024,
			max_response_bytes: 128 * 1024 * 1024,
		}
	}
}

/// Sans-I/O Amazon Bedrock `ConverseStream` codec.
#[derive(Clone, Debug, Default)]
pub struct BedrockConverseCodec {
	options:        Arc<BedrockOptions>,
	ambient_region: Option<Str>,
}

impl BedrockConverseCodec {
	/// Constructs a codec with typed route/model policy options.
	pub fn new(options: BedrockOptions) -> Self {
		Self { options: Arc::new(options), ambient_region: None }
	}

	/// Installs the ambient AWS region resolved during route construction.
	pub fn with_ambient_region(mut self, region: Option<Str>) -> Self {
		self.ambient_region = region;
		self
	}

	/// Borrows the immutable lowering options.
	pub fn options(&self) -> &BedrockOptions {
		&self.options
	}
}

impl Codec for BedrockConverseCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		match operation {
			OperationCall::Chat(request) => {
				let body = encode_converse_request(request, context, &self.options)?;
				let target = context.target.ok_or_else(|| {
					encoding_error(ErrorKind::ProviderContractMismatch, "bedrock.target.missing")
				})?;
				let region = resolve_bedrock_runtime_region(
					context,
					target.wire_model.as_str(),
					self.options.guardrail.as_ref(),
					self.ambient_region.as_deref(),
				);
				let uri = converse_stream_uri(
					target.endpoint.base_url.as_str(),
					target.wire_model.as_str(),
					region.as_str(),
				)?;
				Ok(EncodedRequest::new(
					OperationKind::Chat,
					RequestMethod::Post,
					Str::new(uri),
					vec![
						RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
						RequestHeader {
							name:  sf!("accept"),
							value: sf!("application/vnd.amazon.eventstream"),
						},
						RequestHeader {
							name:  sf!("user-agent"),
							value: Str::new_static(omp_core::USER_AGENT),
						},
					]
					.into_boxed_slice(),
					BodySource::Bytes(body),
					FramingProtocol::AwsEventStream,
					SizeBounds {
						request_body: self.options.max_request_bytes,
						frame:        self.options.max_frame_bytes,
						response:     self.options.max_response_bytes,
					},
				))
			},
			OperationCall::DiscoverModels(request) => {
				if request.cursor.is_some() {
					return Err(encoding_error(
						ErrorKind::InvalidRequest,
						"bedrock.discovery.cursor_unsupported",
					));
				}
				Ok(EncodedRequest::new(
					OperationKind::DiscoverModels,
					RequestMethod::Get,
					bedrock_discovery_uri(context, &self.options, self.ambient_region.as_deref())?,
					vec![RequestHeader { name: sf!("accept"), value: sf!("application/json") }]
						.into_boxed_slice(),
					BodySource::Bytes(Bytes::new()),
					FramingProtocol::Raw,
					SizeBounds {
						request_body: 0,
						frame:        self.options.max_response_bytes,
						response:     self.options.max_response_bytes,
					},
				))
			},
			_ => Err(encoding_error(
				ErrorKind::ProviderContractMismatch,
				"bedrock.operation.unsupported",
			)),
		}
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		match context.operation {
			OperationKind::Chat => Ok(Box::new(BedrockDecoder::new(context))),
			OperationKind::DiscoverModels => Ok(Box::new(BedrockDiscoveryDecoder::new(context)?)),
			_ => Err(encoding_error(
				ErrorKind::ProviderContractMismatch,
				"bedrock.operation.unsupported",
			)),
		}
	}
}

#[derive(Clone)]
struct WireJson(Arc<Value>);

impl From<&OpaqueJson> for WireJson {
	fn from(value: &OpaqueJson) -> Self {
		Self(value.0.clone())
	}
}

impl Serialize for WireJson {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		self.0.serialize(serializer)
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConverseStreamRequest {
	messages: Vec<WireMessage>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	system: Vec<SystemBlock>,
	#[serde(skip_serializing_if = "Option::is_none")]
	inference_config: Option<InferenceConfig>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_config: Option<ToolConfig>,
	#[serde(skip_serializing_if = "Option::is_none")]
	guardrail_config: Option<GuardrailConfig>,
	#[serde(skip_serializing_if = "Option::is_none")]
	additional_model_request_fields: Option<AdditionalModelRequestFields>,
	#[serde(skip_serializing_if = "Option::is_none")]
	request_metadata: Option<Value>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	additional_model_response_field_paths: Vec<&'static str>,
}

#[derive(Serialize)]
struct WireMessage {
	role:    &'static str,
	content: Vec<WireContentBlock>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum SystemBlock {
	Text {
		text: Str,
	},
	CachePoint {
		#[serde(rename = "cachePoint")]
		cache_point: CachePoint,
	},
}

#[derive(Serialize)]
#[serde(untagged)]
enum WireContentBlock {
	Text {
		text: Str,
	},
	Reasoning {
		#[serde(rename = "reasoningContent")]
		reasoning_content: ReasoningContent,
	},
	Image {
		image: ImageBlock,
	},
	Document {
		document: DocumentBlock,
	},
	ToolUse {
		#[serde(rename = "toolUse")]
		tool_use: ToolUseBlock,
	},
	ToolResult {
		#[serde(rename = "toolResult")]
		tool_result: ToolResultBlock,
	},
	CachePoint {
		#[serde(rename = "cachePoint")]
		cache_point: CachePoint,
	},
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReasoningContent {
	reasoning_text: ReasoningText,
}

#[derive(Serialize)]
struct ReasoningText {
	text:      Str,
	#[serde(skip_serializing_if = "Option::is_none")]
	signature: Option<Str>,
}

#[derive(Serialize)]
struct ImageBlock {
	format: Str,
	source: MediaSource,
}

#[derive(Serialize)]
struct DocumentBlock {
	format: Str,
	name:   Str,
	source: MediaSource,
}

#[derive(Serialize)]
#[serde(untagged)]
enum MediaSource {
	Bytes {
		bytes: String,
	},
	S3 {
		#[serde(rename = "s3Location")]
		s3_location: S3Location,
	},
}

#[derive(Serialize)]
struct S3Location {
	uri: Str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolUseBlock {
	tool_use_id: Str,
	name:        Str,
	input:       WireJson,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolResultBlock {
	tool_use_id: Str,
	content:     Vec<WireToolResultContent>,
	status:      &'static str,
}

#[derive(Serialize)]
#[serde(untagged)]
enum WireToolResultContent {
	Text { text: Str },
	Json { json: WireJson },
	Image { image: ImageBlock },
	Document { document: DocumentBlock },
}

#[derive(Serialize)]
struct CachePoint {
	#[serde(rename = "type")]
	kind: &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	ttl:  Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InferenceConfig {
	#[serde(skip_serializing_if = "Option::is_none")]
	max_tokens:     Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	temperature:    Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	top_p:          Option<f32>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	stop_sequences: Vec<Str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolConfig {
	tools:       Vec<ToolSpecEnvelope>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_choice: Option<ToolChoiceEnvelope>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpecEnvelope {
	tool_spec: ToolSpec,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpec {
	name:         Str,
	#[serde(skip_serializing_if = "Option::is_none")]
	description:  Option<Str>,
	input_schema: InputSchema,
}

#[derive(Serialize)]
struct InputSchema {
	json: WireJson,
}

#[derive(Serialize)]
#[serde(untagged)]
enum ToolChoiceEnvelope {
	Auto { auto: EmptyObject },
	Any { any: EmptyObject },
	Tool { tool: NamedToolChoice },
}

#[derive(Clone, Copy, Serialize)]
struct EmptyObject {}

#[derive(Serialize)]
struct NamedToolChoice {
	name: Str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GuardrailConfig {
	guardrail_identifier:   Str,
	guardrail_version:      Str,
	#[serde(skip_serializing_if = "Option::is_none")]
	trace:                  Option<GuardrailTraceMode>,
	#[serde(skip_serializing_if = "Option::is_none")]
	stream_processing_mode: Option<GuardrailStreamMode>,
}

#[derive(Serialize)]
struct AdditionalModelRequestFields {
	#[serde(skip_serializing_if = "Option::is_none")]
	thinking:       Option<ThinkingConfig>,
	#[serde(skip_serializing_if = "Option::is_none")]
	output_config:  Option<OutputConfig>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning:      Option<ReasoningConfig>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	anthropic_beta: Vec<&'static str>,
}

#[derive(Serialize)]
struct ThinkingConfig {
	#[serde(rename = "type")]
	kind:          &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	budget_tokens: Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	display:       Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	block_binding: Option<ThinkingBlockBinding>,
}

#[derive(Serialize)]
struct ThinkingBlockBinding {
	prefix_mismatch_behavior: &'static str,
}

#[derive(Serialize)]
struct OutputConfig {
	effort: Str,
}

#[derive(Serialize)]
struct ReasoningConfig {
	effort: Str,
}

fn encode_converse_request(
	request: &ChatRequest,
	context: &EncodeContext<'_>,
	options: &BedrockOptions,
) -> Result<Bytes, Error> {
	if request.top_logprobs.is_some() {
		return Err(encoding_error(ErrorKind::CapabilityMismatch, "bedrock.logprobs.unsupported"));
	}
	if !request.hosted_tools.is_empty() {
		return Err(encoding_error(
			ErrorKind::CapabilityMismatch,
			"bedrock.hosted_tools.unsupported",
		));
	}
	if !request.safety.is_empty() {
		return Err(encoding_error(
			ErrorKind::CapabilityMismatch,
			"bedrock.safety_settings.unsupported",
		));
	}
	if !matches!(request.output, Setting::Unset) {
		return Err(encoding_error(
			ErrorKind::CapabilityMismatch,
			"bedrock.structured_output.unsupported",
		));
	}
	if !matches!(request.verbosity, Setting::Unset) {
		return Err(encoding_error(ErrorKind::CapabilityMismatch, "bedrock.verbosity.unsupported"));
	}
	if !matches!(request.service_tier, Setting::Unset) {
		return Err(encoding_error(
			ErrorKind::CapabilityMismatch,
			"bedrock.service_tier.unsupported",
		));
	}
	if request.sampling.top_k.is_some()
		|| request.sampling.seed.is_some()
		|| request.sampling.presence_penalty.is_some()
		|| request.sampling.frequency_penalty.is_some()
	{
		return Err(encoding_error(ErrorKind::CapabilityMismatch, "bedrock.sampling.unsupported"));
	}
	if !request.sampling.temperature.is_none_or(f32::is_finite)
		|| !request.sampling.top_p.is_none_or(f32::is_finite)
	{
		return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.sampling.not_finite"));
	}

	let mut messages = Vec::new();
	let mut system = Vec::new();
	let mut history_has_tools = false;
	let mut explicit_cache = false;
	let mut wire_tool_ids = BTreeMap::new();
	for message in request.messages.iter() {
		encode_message(
			message,
			context,
			&mut messages,
			&mut system,
			&mut history_has_tools,
			&mut wire_tool_ids,
			&mut explicit_cache,
		)?;
	}
	if !explicit_cache
		&& let Some(retention) = setting_value(&request.cache_retention)
		&& context.policy.cache.prompt_cache_mode == Some(PromptCacheMode::Explicit)
	{
		let mut remaining = context.policy.cache.maximum_checkpoints.unwrap_or(0).min(2);
		let long_retention = matches!(retention, CacheRetention::Long)
			&& context.policy.cache.supports_long_retention == Some(true);
		if remaining > 0
			&& let Some(message) = messages.last_mut()
			&& message.role == "user"
		{
			message
				.content
				.push(WireContentBlock::CachePoint { cache_point: cache_point(long_retention) });
			remaining -= 1;
		}
		if remaining > 0 && !system.is_empty() {
			system.push(SystemBlock::CachePoint { cache_point: cache_point(long_retention) });
		}
	}

	let inference_config = inference_config(request);
	let mut tool_config = tool_config(request, history_has_tools, context)?;
	let mut additional_model_request_fields = reasoning_config(request, context)?;
	let prefix_binding = context
		.thinking_policy
		.is_some_and(|policy| policy.prefix_binding == Some(true));
	if prefix_binding {
		let fields = additional_model_request_fields.get_or_insert(AdditionalModelRequestFields {
			thinking:       None,
			output_config:  None,
			reasoning:      None,
			anthropic_beta: Vec::new(),
		});
		let thinking = fields.thinking.get_or_insert(ThinkingConfig {
			kind:          "adaptive",
			budget_tokens: None,
			display:       None,
			block_binding: None,
		});
		thinking.block_binding =
			Some(ThinkingBlockBinding { prefix_mismatch_behavior: "drop_block" });
		if !fields
			.anthropic_beta
			.contains(&"thinking-binding-controls-2026-08-01")
		{
			fields
				.anthropic_beta
				.push("thinking-binding-controls-2026-08-01");
		}
	}
	// Converse rejects thinking together with a forced (`any`/`tool`) choice.
	// Prefix-bound models (Fable 5.1+) cannot
	// switch thinking off, so their forced choice downgrades to `auto`;
	// every other model drops thinking so the forced call proceeds.
	if additional_model_request_fields.is_some()
		&& let Some(config) = tool_config.as_mut()
		&& matches!(
			config.tool_choice,
			Some(ToolChoiceEnvelope::Any { .. } | ToolChoiceEnvelope::Tool { .. })
		) {
		if prefix_binding {
			config.tool_choice = Some(ToolChoiceEnvelope::Auto { auto: EmptyObject {} });
		} else {
			additional_model_request_fields = None;
		}
	}
	let guardrail_config = options.guardrail.as_ref().map(|guardrail| GuardrailConfig {
		guardrail_identifier:   guardrail.identifier.clone(),
		guardrail_version:      guardrail.version.clone(),
		trace:                  guardrail.trace,
		stream_processing_mode: guardrail.stream_mode,
	});
	let additional_model_response_field_paths = prefix_binding
		.then_some(vec!["/input_transformations"])
		.unwrap_or_default();
	let request_metadata = (!options.request_metadata.is_empty())
		.then(|| {
			let object = options
				.request_metadata
				.iter()
				.map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
				.collect();
			sanitize_request_metadata_value(Value::Object(object))
		})
		.flatten();
	let wire = ConverseStreamRequest {
		messages,
		system,
		inference_config,
		tool_config,
		guardrail_config,
		additional_model_request_fields,
		request_metadata,
		additional_model_response_field_paths,
	};
	serde_json::to_vec(&wire)
		.map(Bytes::from)
		.map_err(|_| encoding_error(ErrorKind::Protocol, "bedrock.request.serialization"))
}

fn encode_message(
	message: &Message,
	context: &EncodeContext<'_>,
	messages: &mut Vec<WireMessage>,
	system: &mut Vec<SystemBlock>,
	history_has_tools: &mut bool,
	wire_tool_ids: &mut BTreeMap<Str, Str>,
	explicit_cache: &mut bool,
) -> Result<(), Error> {
	if message.role == Role::System {
		for part in message.content.iter() {
			match part {
				ContentPart::Text { text, proof: None } if !text.trim().is_empty() => {
					system.push(SystemBlock::Text { text: text.clone() });
				},
				ContentPart::Text { proof: Some(proof), .. } => {
					proof_text(proof, context)?;
					return Err(encoding_error(
						ErrorKind::CapabilityMismatch,
						"bedrock.text.proof_unsupported",
					));
				},
				ContentPart::CachePoint(retention) => {
					*explicit_cache = true;
					system.push(SystemBlock::CachePoint {
						cache_point: cache_point(
							matches!(retention, CacheRetention::Long)
								&& context.policy.cache.supports_long_retention == Some(true),
						),
					});
				},
				ContentPart::Text { .. } => {},
				_ => {
					return Err(encoding_error(
						ErrorKind::CapabilityMismatch,
						"bedrock.system.non_text",
					));
				},
			}
		}
		return Ok(());
	}

	let role = match message.role {
		Role::Assistant => "assistant",
		Role::Developer | Role::User | Role::Tool => "user",
		Role::System => unreachable!("handled above"),
	};
	let mut content = Vec::new();
	for part in message.content.iter() {
		match part {
			ContentPart::Text { text, proof: None } if !text.trim().is_empty() => {
				content.push(WireContentBlock::Text { text: text.clone() });
			},
			ContentPart::Text { proof: Some(proof), .. } => {
				proof_text(proof, context)?;
				return Err(encoding_error(
					ErrorKind::CapabilityMismatch,
					"bedrock.text.proof_unsupported",
				));
			},
			ContentPart::Text { .. } => {},
			ContentPart::Reasoning { text, proof } if message.role == Role::Assistant => {
				if text.trim().is_empty() && proof.is_none() {
					continue;
				}
				if let Some(proof) = proof {
					content.push(WireContentBlock::Reasoning {
						reasoning_content: ReasoningContent {
							reasoning_text: ReasoningText {
								text:      text.clone(),
								signature: Some(proof_text(proof, context)?),
							},
						},
					});
				} else {
					content
						.push(WireContentBlock::Text { text: sf!("<thinking>\n{text}\n</thinking>") });
				}
			},
			ContentPart::Reasoning { .. } => {
				return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.reasoning.role"));
			},
			ContentPart::Image(media) if message.role == Role::User => {
				content.push(WireContentBlock::Image { image: image_block(media)? });
			},
			ContentPart::Document(media) if message.role == Role::User => {
				content.push(WireContentBlock::Document { document: document_block(media)? });
			},
			ContentPart::Audio(_) => {
				return Err(encoding_error(ErrorKind::CapabilityMismatch, "bedrock.audio.unsupported"));
			},
			ContentPart::Image(_) | ContentPart::Document(_) => {
				return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.media.role"));
			},
			ContentPart::ToolCall { call, name, arguments, proof }
				if message.role == Role::Assistant =>
			{
				*history_has_tools = true;
				let wire_id = proof
					.as_ref()
					.map_or_else(|| Ok(Str::new(call.as_str())), |proof| proof_text(proof, context))?;
				wire_tool_ids.insert(Str::new(call.as_str()), wire_id.clone());
				content.push(WireContentBlock::ToolUse {
					tool_use: ToolUseBlock {
						tool_use_id: wire_id,
						name:        wire_tool_name(name, context),
						input:       WireJson::from(arguments),
					},
				});
			},
			ContentPart::ToolCall { .. } => {
				return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.tool_call.role"));
			},
			ContentPart::ToolResult { call, content: result, is_error, .. }
				if matches!(message.role, Role::User | Role::Tool) =>
			{
				*history_has_tools = true;
				let result = result
					.iter()
					.map(tool_result_content)
					.collect::<Result<Vec<_>, _>>()?;
				content.push(WireContentBlock::ToolResult {
					tool_result: ToolResultBlock {
						tool_use_id: wire_tool_ids
							.get(call.as_str())
							.cloned()
							.unwrap_or_else(|| Str::new(call.as_str())),
						content:     if result.is_empty() {
							vec![WireToolResultContent::Text { text: Str::default() }]
						} else {
							result
						},
						status:      if *is_error { "error" } else { "success" },
					},
				});
			},
			ContentPart::ToolResult { .. } => {
				return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.tool_result.role"));
			},
			ContentPart::CachePoint(retention) => {
				*explicit_cache = true;
				content.push(WireContentBlock::CachePoint {
					cache_point: cache_point(
						matches!(retention, CacheRetention::Long)
							&& context.policy.cache.supports_long_retention == Some(true),
					),
				});
			},
		}
	}
	append_message(messages, role, content);
	Ok(())
}

fn append_message(
	messages: &mut Vec<WireMessage>,
	role: &'static str,
	mut content: Vec<WireContentBlock>,
) {
	if content.is_empty() {
		return;
	}
	if let Some(last) = messages.last_mut()
		&& last.role == role
	{
		last.content.append(&mut content);
	} else {
		messages.push(WireMessage { role, content });
	}
}

fn proof_text(proof: &ProviderProof, context: &EncodeContext<'_>) -> Result<Str, Error> {
	if proof.provider != context.route.provider || proof.codec != context.route.codec {
		return Err(encoding_error(ErrorKind::CodecMismatch, "bedrock.proof.scope_mismatch"));
	}
	str::from_utf8(&proof.value)
		.map(Str::new)
		.map_err(|_| encoding_error(ErrorKind::InvalidRequest, "bedrock.proof.not_utf8"))
}

fn image_block(media: &MediaInput) -> Result<ImageBlock, Error> {
	let (format, source) = media_source(media, MediaKind::Image)?;
	Ok(ImageBlock { format, source })
}

fn document_block(media: &MediaInput) -> Result<DocumentBlock, Error> {
	let (format, source) = media_source(media, MediaKind::Document)?;
	let name = match media {
		MediaInput::Remote { name: Some(name), .. } | MediaInput::Body { name: Some(name), .. } => {
			name.clone()
		},
		_ => sf!("document"),
	};
	Ok(DocumentBlock { format, name, source })
}

#[derive(Clone, Copy)]
enum MediaKind {
	Image,
	Document,
}

fn media_source(media: &MediaInput, kind: MediaKind) -> Result<(Str, MediaSource), Error> {
	match media {
		MediaInput::Bytes { media_type, data } => {
			let format = media_format(media_type.as_str(), kind)?;
			Ok((format, MediaSource::Bytes { bytes: base64::encode(data).into_string() }))
		},
		MediaInput::Remote { uri, media_type, .. } if uri.starts_with("s3://") => {
			let media_type = media_type.as_deref().ok_or_else(|| {
				encoding_error(ErrorKind::InvalidRequest, "bedrock.media.missing_type")
			})?;
			let format = media_format(media_type, kind)?;
			Ok((format, MediaSource::S3 { s3_location: S3Location { uri: uri.clone() } }))
		},
		MediaInput::Remote { .. } => {
			Err(encoding_error(ErrorKind::CapabilityMismatch, "bedrock.media.remote_not_s3"))
		},
		MediaInput::Stored(_) | MediaInput::Body { .. } => {
			Err(encoding_error(ErrorKind::StagingRequired, "bedrock.media.requires_staging"))
		},
	}
}

fn media_format(media_type: &str, kind: MediaKind) -> Result<Str, Error> {
	let format = match (kind, media_type) {
		(MediaKind::Image, "image/jpeg" | "image/jpg") => "jpeg",
		(MediaKind::Image, "image/png") => "png",
		(MediaKind::Image, "image/gif") => "gif",
		(MediaKind::Image, "image/webp") => "webp",
		(MediaKind::Document, "application/pdf") => "pdf",
		(MediaKind::Document, "text/plain") => "txt",
		(MediaKind::Document, "text/html") => "html",
		(MediaKind::Document, "text/csv") => "csv",
		(MediaKind::Document, "application/msword") => "doc",
		(
			MediaKind::Document,
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		) => "docx",
		(MediaKind::Document, "application/vnd.ms-excel") => "xls",
		(
			MediaKind::Document,
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		) => "xlsx",
		_ => {
			return Err(encoding_error(
				ErrorKind::CapabilityMismatch,
				"bedrock.media.type_unsupported",
			));
		},
	};
	Ok(sf!(format))
}

fn tool_result_content(content: &ToolResultContent) -> Result<WireToolResultContent, Error> {
	match content {
		ToolResultContent::Text(text) => Ok(WireToolResultContent::Text { text: text.clone() }),
		ToolResultContent::Json(json) => {
			Ok(WireToolResultContent::Json { json: WireJson::from(json) })
		},
		ToolResultContent::Image(media) => {
			Ok(WireToolResultContent::Image { image: image_block(media)? })
		},
		ToolResultContent::Document(media) => {
			Ok(WireToolResultContent::Document { document: document_block(media)? })
		},
	}
}

const fn cache_point(long_retention: bool) -> CachePoint {
	CachePoint { kind: "default", ttl: if long_retention { Some("1h") } else { None } }
}

const REQUEST_METADATA_MAX_ENTRIES: usize = 16;
const REQUEST_METADATA_MAX_LENGTH: usize = 256;

fn request_metadata_text_is_valid(text: &str, allow_empty: bool) -> bool {
	(allow_empty || !text.is_empty())
		&& text.chars().count() <= REQUEST_METADATA_MAX_LENGTH
		&& text.chars().all(|character| {
			character.is_ascii_alphanumeric()
				|| character.is_whitespace()
				|| matches!(character, ':' | '_' | '@' | '$' | '#' | '=' | '/' | '+' | ',' | '-' | '.')
		})
}

/// Applies Bedrock's invocation-log metadata limits after all request hooks.
///
/// Invalid siblings are dropped instead of failing an inference turn. A
/// non-object or empty result omits `requestMetadata` entirely.
pub(crate) fn sanitize_request_metadata_value(raw: Value) -> Option<Value> {
	let Value::Object(entries) = raw else {
		tracing::warn!("Bedrock requestMetadata dropped because it is not an object");
		return None;
	};
	let mut kept = serde_json::Map::new();
	let mut dropped = 0_usize;
	for (key, value) in entries {
		let Some(value) = value.as_str() else {
			dropped += 1;
			continue;
		};
		if kept.len() >= REQUEST_METADATA_MAX_ENTRIES
			|| !request_metadata_text_is_valid(&key, false)
			|| !request_metadata_text_is_valid(value, true)
		{
			dropped += 1;
			continue;
		}
		kept.insert(key, Value::String(value.to_owned()));
	}
	if dropped > 0 {
		tracing::warn!(dropped, "Bedrock requestMetadata entries dropped");
	}
	(!kept.is_empty()).then_some(Value::Object(kept))
}

fn inference_config(request: &ChatRequest) -> Option<InferenceConfig> {
	let config = InferenceConfig {
		max_tokens:     request.max_output_tokens,
		temperature:    request.sampling.temperature,
		top_p:          request.sampling.top_p,
		stop_sequences: request.sampling.stop.iter().cloned().collect(),
	};
	(config.max_tokens.is_some()
		|| config.temperature.is_some()
		|| config.top_p.is_some()
		|| !config.stop_sequences.is_empty())
	.then_some(config)
}

fn tool_config(
	request: &ChatRequest,
	history_has_tools: bool,
	context: &EncodeContext<'_>,
) -> Result<Option<ToolConfig>, Error> {
	if matches!(setting_value(&request.tool_choice), Some(ToolChoice::Disabled))
		&& !history_has_tools
	{
		return Ok(None);
	}
	if request.tools.is_empty() && !history_has_tools {
		return Ok(None);
	}
	let mut tools = Vec::with_capacity(request.tools.len());
	for tool in request.tools.iter() {
		let (parameters, strict) = tool.input.wire_schema();
		if strict {
			return Err(encoding_error(
				ErrorKind::CapabilityMismatch,
				"bedrock.tools.strict_unsupported",
			));
		}
		tools.push(ToolSpecEnvelope {
			tool_spec: ToolSpec {
				name:         wire_tool_name(&tool.name, context),
				description:  tool.description.clone(),
				input_schema: InputSchema { json: WireJson::from(parameters) },
			},
		});
	}
	let sentinel = tools.is_empty();
	if sentinel {
		let empty_schema = OpaqueJson::new(
			serde_json::from_str::<Value>(r#"{"type":"object","properties":{}}"#)
				.map_err(|_| encoding_error(ErrorKind::InternalInvariant, "bedrock.sentinel.schema"))?,
		);
		tools.push(ToolSpecEnvelope {
			tool_spec: ToolSpec {
				name:         sf!(NO_TOOLS_SENTINEL_NAME),
				description:  Some(sf!(
					"Placeholder required by Bedrock validation. Do not call; answer with text.",
				)),
				input_schema: InputSchema { json: WireJson::from(&empty_schema) },
			},
		});
	}
	let tool_choice = if sentinel {
		Some(ToolChoiceEnvelope::Auto { auto: EmptyObject {} })
	} else {
		match setting_value(&request.tool_choice) {
			None => None,
			Some(ToolChoice::Auto) => Some(ToolChoiceEnvelope::Auto { auto: EmptyObject {} }),
			Some(ToolChoice::Required) => {
				if context.policy.tool.forced_choice == Some(false) {
					return Err(encoding_error(
						ErrorKind::CapabilityMismatch,
						"bedrock.tool_choice.forced_unsupported",
					));
				}
				Some(ToolChoiceEnvelope::Any { any: EmptyObject {} })
			},
			Some(ToolChoice::Named(name)) => {
				if context.policy.tool.forced_choice == Some(false)
					|| context.policy.tool.named_choice == Some(false)
				{
					return Err(encoding_error(
						ErrorKind::CapabilityMismatch,
						"bedrock.tool_choice.named_unsupported",
					));
				}
				Some(ToolChoiceEnvelope::Tool {
					tool: NamedToolChoice { name: wire_tool_name(name, context) },
				})
			},
			Some(ToolChoice::Disabled) => None,
		}
	};
	Ok(Some(ToolConfig { tools, tool_choice }))
}

fn reasoning_config(
	request: &ChatRequest,
	context: &EncodeContext<'_>,
) -> Result<Option<AdditionalModelRequestFields>, Error> {
	let Some(reasoning) = setting_value(&request.reasoning) else {
		return Ok(None);
	};
	let policy = context.thinking_policy.ok_or_else(|| {
		encoding_error(ErrorKind::ProviderContractMismatch, "bedrock.thinking_policy.missing")
	})?;
	let selection = context.thinking_selection.ok_or_else(|| {
		encoding_error(ErrorKind::ProviderContractMismatch, "bedrock.thinking_selection.missing")
	})?;
	let requested = selection.effort;
	if !policy.supports(requested) {
		return Err(encoding_error(
			ErrorKind::CapabilityMismatch,
			"bedrock.thinking.effort_unsupported",
		));
	}
	if requested == ThinkingEffort::Off {
		return Ok(None);
	}
	let display = policy
		.supports_display
		.is_some_and(|supported| supported)
		.then_some(match reasoning.visibility {
			ReasoningVisibility::Hidden => "omitted",
			ReasoningVisibility::Summary | ReasoningVisibility::Visible => "summarized",
		});
	if reasoning
		.effort
		.is_some_and(|effort| thinking_effort(effort) != requested)
		|| reasoning
			.max_tokens
			.is_some_and(|budget| selection.budget != Some(budget))
	{
		return Err(encoding_error(
			ErrorKind::ProviderContractMismatch,
			"bedrock.thinking_selection.request_mismatch",
		));
	}
	let native_effort = selection
		.native_effort
		.clone()
		.unwrap_or_else(|| sf!(thinking_effort_name(requested)));
	let mode = if selection.budget.is_some() && policy.mode == ThinkingMode::AnthropicAdaptive {
		ThinkingMode::Budget
	} else {
		policy.mode
	};
	if mode == ThinkingMode::AnthropicAdaptive
		&& context.policy.reasoning.disable_adaptive == Some(true)
	{
		return Err(encoding_error(
			ErrorKind::ProviderContractMismatch,
			"bedrock.thinking_selection.adaptive_disabled",
		));
	}
	let fields = match mode {
		ThinkingMode::AnthropicAdaptive => AdditionalModelRequestFields {
			thinking:       Some(ThinkingConfig {
				kind: "adaptive",
				budget_tokens: None,
				display,
				block_binding: None,
			}),
			output_config:  Some(OutputConfig { effort: native_effort }),
			reasoning:      None,
			anthropic_beta: Vec::new(),
		},
		ThinkingMode::Budget | ThinkingMode::AnthropicBudgetEffort => {
			let budget = selection.budget.ok_or_else(|| {
				encoding_error(
					ErrorKind::ProviderContractMismatch,
					"bedrock.thinking_selection.budget_missing",
				)
			})?;
			let anthropic_beta = if context.policy.reasoning.interleaved_thinking == Some(true) {
				vec!["interleaved-thinking-2025-05-14"]
			} else {
				Vec::new()
			};
			AdditionalModelRequestFields {
				thinking: Some(ThinkingConfig {
					kind: "enabled",
					budget_tokens: Some(budget),
					display,
					block_binding: None,
				}),
				output_config: (mode == ThinkingMode::AnthropicBudgetEffort)
					.then_some(OutputConfig { effort: native_effort }),
				reasoning: None,
				anthropic_beta,
			}
		},
		ThinkingMode::Effort => AdditionalModelRequestFields {
			thinking:       None,
			output_config:  None,
			reasoning:      Some(ReasoningConfig { effort: native_effort }),
			anthropic_beta: Vec::new(),
		},
		ThinkingMode::GoogleLevel => {
			return Err(encoding_error(ErrorKind::CodecMismatch, "bedrock.thinking.mode_mismatch"));
		},
	};
	Ok(Some(fields))
}

const fn thinking_effort(effort: ReasoningEffort) -> ThinkingEffort {
	match effort {
		ReasoningEffort::Off => ThinkingEffort::Off,
		ReasoningEffort::Minimal => ThinkingEffort::Minimal,
		ReasoningEffort::Low => ThinkingEffort::Low,
		ReasoningEffort::Medium => ThinkingEffort::Medium,
		ReasoningEffort::High => ThinkingEffort::High,
		ReasoningEffort::Xhigh => ThinkingEffort::XHigh,
		ReasoningEffort::Max => ThinkingEffort::Max,
	}
}

const fn thinking_effort_name(effort: ThinkingEffort) -> &'static str {
	match effort {
		ThinkingEffort::Off => "off",
		ThinkingEffort::Minimal => "minimal",
		ThinkingEffort::Low => "low",
		ThinkingEffort::Medium => "medium",
		ThinkingEffort::High => "high",
		ThinkingEffort::XHigh => "xhigh",
		ThinkingEffort::Max => "max",
	}
}

fn wire_tool_name(name: &Str, context: &EncodeContext<'_>) -> Str {
	if context.policy.tool.escape_builtin_names == Some(true) {
		sf!("_{name}")
	} else {
		name.clone()
	}
}

const fn setting_value<T>(setting: &Setting<T>) -> Option<&T> {
	match setting {
		Setting::Unset => None,
		Setting::Require(value) | Setting::Prefer(value) => Some(value),
	}
}

fn resolve_bedrock_runtime_region(
	context: &EncodeContext<'_>,
	model: &str,
	guardrail: Option<&BedrockGuardrail>,
	configured_ambient: Option<&str>,
) -> Str {
	let ambient = context
		.account
		.and_then(|account| account.region.as_ref())
		.map(|region| region.as_str())
		.or(configured_ambient);
	resolve_bedrock_region(
		context.route.endpoint.region.as_deref(),
		ambient,
		context.route.endpoint.base_url.as_str(),
		model,
		guardrail,
	)
}

fn resolve_bedrock_region(
	explicit: Option<&str>,
	ambient: Option<&str>,
	base_url: &str,
	model: &str,
	guardrail: Option<&BedrockGuardrail>,
) -> Str {
	if let Some(region) = explicit {
		return Str::new(region);
	}
	if let Some(region) = super::anthropic::arn_region(model) {
		return Str::new(region);
	}
	let guardrail_region =
		guardrail.and_then(|guardrail| guardrail_arn_region(guardrail.identifier.as_str()));
	if let Some((geo, fallback)) = super::anthropic::inference_profile_geo(model) {
		if let Some(region) = ambient
			&& super::anthropic::region_serves_geo(region, geo)
		{
			return Str::new(region);
		}
		if let Some(region) = guardrail_region
			&& super::anthropic::region_serves_geo(region, geo)
		{
			return Str::new(region);
		}
		return sf!(fallback);
	}
	if let Some(region) = ambient {
		return Str::new(region);
	}
	if let Some(region) = guardrail_region {
		return Str::new(region);
	}
	super::anthropic::endpoint_region(base_url).map_or_else(|| sf!("us-east-1"), Str::new)
}

/// Extracts a region only from a Bedrock Guardrail ARN.
pub(crate) fn guardrail_arn_region(identifier: &str) -> Option<&str> {
	let region = super::anthropic::arn_region(identifier)?;
	identifier
		.splitn(6, ':')
		.nth(5)?
		.starts_with("guardrail/")
		.then_some(region)
}

fn bedrock_runtime_endpoint(base: &str, region: &str) -> String {
	let expanded = base
		.replace(REGION_PLACEHOLDER, region)
		.replace(LOCATION_PLACEHOLDER, region);
	let Ok(mut uri) = Url::parse(&expanded) else {
		return expanded;
	};
	let Some(host) = uri.host_str() else {
		return expanded;
	};
	let Some((prefix, _)) = host
		.strip_prefix("bedrock-runtime.")
		.map(|tail| ("bedrock-runtime", tail))
		.or_else(|| {
			host
				.strip_prefix("bedrock-runtime-fips.")
				.map(|tail| ("bedrock-runtime-fips", tail))
		})
	else {
		return expanded;
	};
	let suffix = if host.ends_with(".api.aws") {
		"api.aws"
	} else if host.ends_with(".amazonaws.com.cn") || region.starts_with("cn-") {
		"amazonaws.com.cn"
	} else {
		"amazonaws.com"
	};
	if uri
		.set_host(Some(&format!("{prefix}.{region}.{suffix}")))
		.is_err()
	{
		return expanded;
	}
	uri.to_string()
}

fn converse_stream_uri(base: &str, model: &str, region: &str) -> Result<String, Error> {
	let base = bedrock_runtime_endpoint(base, region);
	let mut endpoint = Url::parse(&base)
		.map_err(|_| encoding_error(ErrorKind::InvalidRequest, "bedrock.endpoint.invalid"))?;
	if !matches!(endpoint.scheme(), "http" | "https") {
		return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.endpoint.scheme"));
	}
	if endpoint.host_str().is_none() {
		return Err(encoding_error(ErrorKind::InvalidRequest, "bedrock.endpoint.host_missing"));
	}
	endpoint.set_query(None);
	endpoint.set_fragment(None);
	let base = endpoint.to_string();
	let mut uri = String::with_capacity(base.len() + model.len() + 32);
	uri.push_str(base.trim_end_matches('/'));
	uri.push_str("/model/");
	for byte in model.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
			uri.push(char::from(byte));
		} else {
			const HEX: &[u8; 16] = b"0123456789ABCDEF";
			uri.push('%');
			uri.push(char::from(HEX[usize::from(byte >> 4)]));
			uri.push(char::from(HEX[usize::from(byte & 0x0f)]));
		}
	}
	uri.push_str("/converse-stream");
	Ok(uri)
}

const REGION_PLACEHOLDER: &str = "{region}";
const LOCATION_PLACEHOLDER: &str = "{location}";

fn bedrock_discovery_uri(
	context: &EncodeContext<'_>,
	options: &BedrockOptions,
	ambient_region: Option<&str>,
) -> Result<Str, Error> {
	let base = context.route.endpoint.base_url.as_str();
	let region =
		resolve_bedrock_runtime_region(context, "", options.guardrail.as_ref(), ambient_region);
	bedrock_discovery_endpoint(base, region.as_str())
}

fn bedrock_discovery_endpoint(base: &str, region: &str) -> Result<Str, Error> {
	let expanded = bedrock_runtime_endpoint(base, region);
	let mut uri = Url::parse(&expanded).map_err(|_| {
		encoding_error(ErrorKind::InvalidRequest, "bedrock.discovery.endpoint_invalid")
	})?;
	let host = uri.host_str().ok_or_else(|| {
		encoding_error(ErrorKind::InvalidRequest, "bedrock.discovery.endpoint_host_missing")
	})?;
	let control_host = host
		.strip_prefix("bedrock-runtime")
		.map_or_else(|| host.to_owned(), |tail| format!("bedrock{tail}"));
	uri.set_host(Some(&control_host)).map_err(|_| {
		encoding_error(ErrorKind::InvalidRequest, "bedrock.discovery.endpoint_host_invalid")
	})?;
	uri.set_path("/foundation-models");
	uri.set_query(None);
	uri.set_fragment(None);
	Ok(Str::new(&uri))
}

struct BedrockDiscoveryDecoder {
	provider: omp_catalog::ProviderId,
	route:    omp_catalog::RouteId,
	done:     bool,
}

impl BedrockDiscoveryDecoder {
	fn new(context: &DecodeContext<'_>) -> Result<Self, Error> {
		if context.operation_call.kind() != OperationKind::DiscoverModels {
			return Err(encoding_error(
				ErrorKind::ProviderContractMismatch,
				"bedrock.discovery.operation_mismatch",
			));
		}
		Ok(Self {
			provider: context.provider.clone(),
			route:    context.route.clone(),
			done:     false,
		})
	}
}

impl Decoder for BedrockDiscoveryDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			return Err(stream_error(ErrorKind::Protocol, "bedrock.discovery.trailing_frame", true));
		}
		let Frame::Raw(payload) = frame else {
			return Err(stream_error(
				ErrorKind::Protocol,
				"bedrock.discovery.framing_mismatch",
				false,
			));
		};
		let response: FoundationModelsResponse = serde_json::from_slice(&payload).map_err(|_| {
			stream_error(ErrorKind::Protocol, "bedrock.discovery.invalid_response", false)
		})?;
		let rows = response
			.model_summaries
			.into_iter()
			.filter_map(|summary| summary.into_discovered(&self.provider, &self.route))
			.collect();
		emit(RawEvent::DiscoveredModels { rows, next_cursor: None });
		self.done = true;
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			Ok(())
		} else {
			Err(stream_error(ErrorKind::Protocol, "bedrock.discovery.response_missing", false))
		}
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundationModelsResponse {
	model_summaries: Vec<FoundationModelSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FoundationModelSummary {
	model_id:                     Str,
	#[serde(default)]
	model_name:                   Option<Str>,
	#[serde(default)]
	provider_name:                Option<Str>,
	#[serde(default)]
	input_modalities:             Box<[Str]>,
	#[serde(default)]
	output_modalities:            Box<[Str]>,
	#[serde(default)]
	response_streaming_supported: Option<bool>,
	#[serde(default)]
	inference_types_supported:    Box<[Str]>,
	#[serde(default)]
	model_lifecycle:              Option<FoundationModelLifecycle>,
}

#[derive(Deserialize)]
struct FoundationModelLifecycle {
	status: Str,
}

impl FoundationModelSummary {
	fn into_discovered(
		self,
		provider: &omp_catalog::ProviderId<str>,
		route: &omp_catalog::RouteId<str>,
	) -> Option<DiscoveredModel> {
		if self.model_id.is_empty() || !self.is_usable() {
			return None;
		}
		let declared_class = self
			.provider_name
			.filter(|name| !name.is_empty())
			.map(ClassId::from)
			.or_else(|| self.model_id.split(".").next().map(ClassId::from));
		let display_name = self
			.model_name
			.filter(|name| !name.is_empty())
			.or_else(|| Some(self.model_id.clone()));
		let mut modalities = ModalityBits::TEXT;
		if self
			.input_modalities
			.iter()
			.any(|modality| modality.as_str() == "IMAGE")
		{
			modalities |= ModalityBits::IMAGE;
		}
		let capabilities = ModelCapabilities {
			operations:    OperationBits::for_kind(OperationKind::Chat),
			chat:          Some(ChatCapabilities {
				roles:             Availability::Unknown,
				mid_session_roles: Availability::Unknown,
				tools:             Availability::Unknown,
				structured_output: Availability::Unknown,
				grammar:           Availability::Unknown,
				text_verbosity:    Availability::Unknown,
				reasoning:         Availability::Unknown,
				input_modalities:  Availability::Native(modalities),
				image_input:       Availability::Unknown,
				hosted_tools:      Availability::Unknown,
				prompt_caching:    Availability::Unknown,
				service_tiers:     Availability::Unknown,
				sampling:          Availability::Unknown,
				safety:            Availability::Unknown,
				determinism:       Availability::Unknown,
				server_state:      Availability::Unknown,
				logprobs:          Availability::Unknown,
			}),
			embeddings:    None,
			image:         None,
			video:         None,
			speech:        None,
			transcription: None,
			realtime:      None,
			search:        None,
			tokenization:  None,
		};
		Some(DiscoveredModel {
			provider: provider.to_owned(),
			route: route.to_owned(),
			wire_model: WireModelId::from(self.model_id),
			aliases: Box::new([]),
			display_name,
			declared_class,
			declared_operations: OperationBits::for_kind(OperationKind::Chat),
			declared_capabilities: Some(capabilities),
			declared_limits: None,
			declared_pricing: Box::new([]),
			extended_context_mode: None,
			availability: Some(ModelAvailability::Available),
			source: sf!("bedrock-list-foundation-models"),
			observed_at_ms: None,
			updated_at_ms: None,
			deprecated: Some(false),
		})
	}

	fn is_usable(&self) -> bool {
		let active = self
			.model_lifecycle
			.as_ref()
			.is_none_or(|lifecycle| lifecycle.status.as_str() == "ACTIVE");
		let streaming = self.response_streaming_supported.unwrap_or(true);
		let invocable = self.inference_types_supported.is_empty()
			|| self
				.inference_types_supported
				.iter()
				.any(|kind| kind.as_str() == "ON_DEMAND");
		let text_output = self.output_modalities.is_empty()
			|| self
				.output_modalities
				.iter()
				.any(|kind| kind.as_str() == "TEXT");
		active && streaming && invocable && text_output
	}
}
#[derive(Default)]
struct BedrockDecoder {
	parts:             BTreeMap<u32, DecodedPart>,
	ignored:           BTreeSet<u32>,
	usage:             Option<Usage>,
	stop:              Option<FinishReason>,
	blocks:            u32,
	sentinel_injected: bool,
	terminal:          bool,
	committed:         bool,
}

impl BedrockDecoder {
	fn new(context: &DecodeContext<'_>) -> Self {
		let sentinel_injected = match context.operation_call {
			OperationCall::Chat(request) => {
				request.tools.is_empty()
					&& request.messages.iter().any(|message| {
						message.content.iter().any(|part| {
							matches!(part, ContentPart::ToolCall { .. } | ContentPart::ToolResult { .. })
						})
					})
			},
			_ => false,
		};
		Self { sentinel_injected, ..Self::default() }
	}

	fn decode_message(
		&mut self,
		message: EventStreamMessage,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		if self.terminal {
			return Ok(());
		}
		let message_type = message.string_header(":message-type").unwrap_or("");
		if message_type == "exception" || message.string_header(":exception-type").is_some() {
			let code = message
				.string_header(":exception-type")
				.unwrap_or("unknownException");
			self.emit_exception(code, None, &message.payload, emit);
			return Ok(());
		}
		if message_type == "error" {
			let code = message
				.string_header(":error-code")
				.unwrap_or("unknownException");
			let header_message = message.string_header(":error-message");
			self.emit_exception(code, header_message, &message.payload, emit);
			return Ok(());
		}
		if message_type != "event" {
			return Err(stream_error(
				ErrorKind::Protocol,
				"bedrock.eventstream.message_type",
				self.committed,
			));
		}
		let kind = match message.string_header(":event-type").unwrap_or("") {
			"messageStart" => WireEventKind::MessageStart,
			"contentBlockStart" => WireEventKind::ContentBlockStart,
			"contentBlockDelta" => WireEventKind::ContentBlockDelta,
			"contentBlockStop" => WireEventKind::ContentBlockStop,
			"messageStop" => WireEventKind::MessageStop,
			"metadata" => WireEventKind::Metadata,
			// AWS may add event types independently of this client. Unknown
			// events carry no canonical semantics and are ignored like pi.
			_ => return Ok(()),
		};
		let event: WireEvent = serde_json::from_slice(&message.payload).map_err(|_| {
			stream_error(ErrorKind::Protocol, "bedrock.event.invalid_json", self.committed)
		})?;
		if !event.valid_for(kind) {
			return Err(stream_error(
				ErrorKind::ProviderContractMismatch,
				"bedrock.event.shape_mismatch",
				self.committed,
			));
		}
		self.project_event(event, emit)
	}

	fn emit_exception(
		&mut self,
		code: &str,
		header_message: Option<&str>,
		payload: &[u8],
		emit: &mut dyn FnMut(RawEvent),
	) {
		let exception = serde_json::from_slice::<WireException>(payload).unwrap_or_default();
		let payload_message = (!payload.is_empty())
			.then(|| str::from_utf8(payload).ok().map(Str::new))
			.flatten();
		let message = exception
			.message
			.or(exception.original_message)
			.or_else(|| header_message.map(Str::new))
			.or(payload_message)
			.unwrap_or_else(|| sf!("Bedrock stream exception"));
		let status = exception
			.original_status_code
			.and_then(|status| u16::try_from(status).ok());
		let error = aws_exception_error(code, message, status, self.committed);
		self.terminal = true;
		emit(RawEvent::Failure(error));
	}

	fn project_event(
		&mut self,
		mut event: WireEvent,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		if let Some(role) = event.role {
			if role != "assistant" {
				return Err(stream_error(
					ErrorKind::ProviderContractMismatch,
					"bedrock.message_start.role",
					self.committed,
				));
			}
			return Ok(());
		}
		if let (Some(index), Some(start)) = (event.content_block_index, event.start) {
			if let Some(tool) = start.tool_use {
				if self.sentinel_injected && tool.name == NO_TOOLS_SENTINEL_NAME {
					self.ignored.insert(index);
					return Ok(());
				}
				if tool.name.is_empty() || tool.tool_use_id.is_empty() {
					return Err(stream_error(
						ErrorKind::ProviderContractMismatch,
						"bedrock.tool_start.identity",
						self.committed,
					));
				}
				let id = ToolCallId::new(tool.tool_use_id.clone());
				self.parts.insert(index, DecodedPart::Tool {
					id:        id.clone(),
					name:      tool.name.clone(),
					arguments: Vec::new(),
				});
				self.blocks = self.blocks.max(index.saturating_add(1));
				self.committed = true;
				emit(RawEvent::Chat(ChatEvent::ToolCallStarted { index, id, name: tool.name }));
				emit(RawEvent::ProviderState(ProviderStateEvent::ToolCallProof {
					index,
					value: Bytes::copy_from_slice(tool.tool_use_id.as_bytes()),
				}));
			}
			return Ok(());
		}
		if let (Some(index), Some(delta)) = (event.content_block_index, event.delta) {
			if self.ignored.contains(&index) {
				return Ok(());
			}
			if let Some(text) = delta.text {
				self.ensure_part(index, BlockKind::Text, emit)?;
				if let Some(DecodedPart::Text(output)) = self.parts.get_mut(&index) {
					output.push_str(&text);
				}
				self.committed = true;
				emit(RawEvent::Chat(ChatEvent::TextDelta { index, text }));
			} else if let Some(tool) = delta.tool_use {
				let chunk = tool.input.unwrap_or_default();
				let Some(DecodedPart::Tool { arguments, .. }) = self.parts.get_mut(&index) else {
					return Err(stream_error(
						ErrorKind::ProviderContractMismatch,
						"bedrock.tool_delta.before_start",
						self.committed,
					));
				};
				arguments.extend_from_slice(chunk.as_bytes());
				self.committed = true;
				emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
					index,
					bytes: Bytes::copy_from_slice(chunk.as_bytes()),
				}));
			} else if let Some(reasoning) = delta.reasoning_content {
				self.ensure_part(index, BlockKind::Thinking, emit)?;
				let Some(DecodedPart::Thinking { text, signature }) = self.parts.get_mut(&index) else {
					return Err(stream_error(
						ErrorKind::ProviderContractMismatch,
						"bedrock.reasoning.state",
						self.committed,
					));
				};
				if let Some(chunk) = reasoning.text {
					text.push_str(&chunk);
					self.committed = true;
					emit(RawEvent::Chat(ChatEvent::ThinkingDelta { index, text: chunk }));
				}
				if let Some(chunk) = reasoning.signature {
					signature.extend_from_slice(chunk.as_bytes());
				}
			}
			return Ok(());
		}
		if let Some(index) = event.content_block_index {
			if self.ignored.remove(&index) {
				return Ok(());
			}
			if let Some(part) = self.parts.remove(&index) {
				match part {
					DecodedPart::Thinking { signature, .. } if !signature.is_empty() => {
						emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
							index,
							signature: Bytes::from(signature),
						}));
					},
					DecodedPart::Tool { id, name, arguments } => {
						let arguments = if arguments.is_empty() {
							Bytes::from_static(b"{}")
						} else {
							Bytes::from(arguments)
						};
						serde_json::from_slice::<Box<RawValue>>(&arguments).map_err(|_| {
							stream_error(
								ErrorKind::MalformedModelOutput,
								"bedrock.tool_arguments.incomplete_json",
								self.committed,
							)
						})?;
						emit(RawEvent::ToolCallComplete {
							index,
							call: UnvalidatedToolCall {
								id,
								name,
								input_kind: ToolInputKind::Json,
								arguments,
							},
						});
					},
					DecodedPart::Text(_) | DecodedPart::Thinking { .. } => {},
				}
			}
			return Ok(());
		}
		if let Some(fields) = event.additional_model_response_fields.take() {
			emit_input_transformations(fields, self.committed, emit)?;
		}
		if let Some(reason) = event.stop_reason {
			let explanation = match reason.as_str() {
				"guardrail_intervened" => Some("Response blocked by Amazon Bedrock guardrail."),
				"content_filtered" => Some("Response filtered by Amazon Bedrock content filters."),
				_ => None,
			};
			if let Some(explanation) = explanation {
				emit(RawEvent::Metadata(ProviderMetadataEvent::FinishMessage {
					candidate: 0,
					message:   Str::new_static(explanation),
				}));
			}
			self.stop = Some(map_stop(reason.as_str(), self.sentinel_injected)?);
			if self.usage.is_some() {
				self.complete(emit);
			}
			return Ok(());
		}
		if let Some(usage) = event.usage {
			let usage = usage.into_usage();
			self.usage = Some(usage);
			emit(RawEvent::Chat(ChatEvent::Usage(UsageUpdate { usage, final_update: true })));
		}
		if let Some(metrics) = event.metrics
			&& let Some(latency_ms) = metrics.latency_ms
		{
			emit(RawEvent::Telemetry(ProviderTelemetryEvent::ModelLatency(Duration::from_millis(
				latency_ms,
			))));
		}
		if let Some(trace) = event.trace.and_then(|trace| trace.guardrail) {
			emit(RawEvent::Telemetry(trace.into_telemetry()));
		}
		if self.stop.is_some() && self.usage.is_some() {
			self.complete(emit);
		}
		Ok(())
	}

	fn ensure_part(
		&mut self,
		index: u32,
		kind: BlockKind,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		if let Some(existing) = self.parts.get(&index) {
			let matching = matches!(
				(existing, kind),
				(DecodedPart::Text(_), BlockKind::Text)
					| (DecodedPart::Thinking { .. }, BlockKind::Thinking)
			);
			if matching {
				return Ok(());
			}
			return Err(stream_error(
				ErrorKind::ProviderContractMismatch,
				"bedrock.content_block.kind_changed",
				self.committed,
			));
		}
		let part = match kind {
			BlockKind::Text => DecodedPart::Text(String::new()),
			BlockKind::Thinking => {
				DecodedPart::Thinking { text: String::new(), signature: Vec::new() }
			},
			BlockKind::ToolCall | BlockKind::Artifact => {
				return Err(stream_error(
					ErrorKind::ProviderContractMismatch,
					"bedrock.content_block.invalid_implicit_kind",
					self.committed,
				));
			},
		};
		self.parts.insert(index, part);
		self.blocks = self.blocks.max(index.saturating_add(1));
		self.committed = true;
		emit(RawEvent::Chat(ChatEvent::BlockStarted { index, kind }));
		Ok(())
	}

	fn complete(&mut self, emit: &mut dyn FnMut(RawEvent)) {
		if self.terminal {
			return;
		}
		self.terminal = true;
		emit(RawEvent::Completion(RawCompletion {
			reason: self.stop.clone().unwrap_or(FinishReason::Stop),
			blocks: self.blocks,
			usage:  self.usage.unwrap_or_default(),
		}));
	}
}

impl Decoder for BedrockDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		match frame {
			Frame::EventStream(message) => self.decode_message(*message, emit),
			_ => Err(stream_error(ErrorKind::Protocol, "bedrock.frame.wrong_framing", self.committed)),
		}
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.terminal {
			return Ok(());
		}
		if self.stop.is_none() {
			return Err(stream_error(
				ErrorKind::StreamCorruption,
				"bedrock.stream.truncated",
				self.committed,
			));
		}
		self.complete(emit);
		Ok(())
	}
}

enum DecodedPart {
	Text(String),
	Thinking { text: String, signature: Vec<u8> },
	Tool { id: ToolCallId, name: Str, arguments: Vec<u8> },
}

#[derive(Clone, Copy)]
enum WireEventKind {
	MessageStart,
	ContentBlockStart,
	ContentBlockDelta,
	ContentBlockStop,
	MessageStop,
	Metadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEvent {
	role: Option<Str>,
	content_block_index: Option<u32>,
	start: Option<WireStart>,
	delta: Option<WireDelta>,
	stop_reason: Option<Str>,
	additional_model_response_fields: Option<Value>,
	usage: Option<WireUsage>,
	metrics: Option<WireMetrics>,
	trace: Option<WireTrace>,
}

impl WireEvent {
	const fn valid_for(&self, kind: WireEventKind) -> bool {
		match kind {
			WireEventKind::MessageStart => self.role.is_some(),
			WireEventKind::ContentBlockStart => {
				self.content_block_index.is_some() && self.start.is_some()
			},
			WireEventKind::ContentBlockDelta => {
				self.content_block_index.is_some() && self.delta.is_some()
			},
			WireEventKind::ContentBlockStop => {
				self.content_block_index.is_some() && self.start.is_none() && self.delta.is_none()
			},
			WireEventKind::MessageStop => self.stop_reason.is_some(),
			WireEventKind::Metadata => {
				self.usage.is_some() || self.metrics.is_some() || self.trace.is_some()
			},
		}
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireStart {
	tool_use: Option<WireToolStart>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireToolStart {
	#[serde(default)]
	tool_use_id: Str,
	#[serde(default)]
	name:        Str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDelta {
	text:              Option<Str>,
	tool_use:          Option<WireToolDelta>,
	reasoning_content: Option<WireReasoningDelta>,
}

#[derive(Deserialize)]
struct WireToolDelta {
	input: Option<Str>,
}

#[derive(Deserialize)]
struct WireReasoningDelta {
	text:      Option<Str>,
	signature: Option<Str>,
}

fn emit_input_transformations(
	fields: Value,
	committed: bool,
	emit: &mut dyn FnMut(RawEvent),
) -> Result<(), Error> {
	let Value::Object(mut fields) = fields else {
		return Ok(());
	};
	let Some(Value::Array(transformations)) = fields.remove("input_transformations") else {
		return Ok(());
	};
	for transformation in transformations {
		let Value::Object(object) = transformation else {
			continue;
		};
		let Some(kind) = object.get("type").and_then(Value::as_str).map(Str::new) else {
			continue;
		};
		let path = object.get("path").and_then(Value::as_str).map(Str::new);
		let reason = object.get("reason").and_then(Value::as_str).map(Str::new);
		let data = serde_json::to_vec(&object).map(Bytes::from).map_err(|_| {
			stream_error(ErrorKind::Protocol, "bedrock.input_transformation.serialization", committed)
		})?;
		emit(RawEvent::Metadata(ProviderMetadataEvent::InputTransformation {
			kind,
			path,
			reason,
			data,
		}));
	}
	Ok(())
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireUsage {
	#[serde(default)]
	#[serde(rename = "inputTokens")]
	input:       u64,
	#[serde(default, rename = "outputTokens")]
	output:      u64,
	#[serde(default, rename = "totalTokens")]
	total:       u64,
	#[serde(default, rename = "cacheReadInputTokens")]
	cache_read:  u64,
	#[serde(default, rename = "cacheWriteInputTokens")]
	cache_write: u64,
}

impl WireUsage {
	fn into_usage(self) -> Usage {
		let _total = if self.total == 0 {
			self.input.saturating_add(self.output)
		} else {
			self.total
		};
		Usage {
			input_tokens: self.input,
			output_tokens: self.output,
			cache_read_tokens: self.cache_read,
			cache_write_tokens: self.cache_write,
			source: UsageSource::Measured,
			..Usage::default()
		}
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireMetrics {
	latency_ms: Option<u64>,
}

#[derive(Deserialize)]
struct WireTrace {
	guardrail: Option<WireGuardrailTrace>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireGuardrailTrace {
	#[serde(default)]
	input_assessment:   BTreeMap<Str, WireAssessment>,
	#[serde(default)]
	output_assessments: BTreeMap<Str, Vec<WireAssessment>>,
	invocation_metrics: Option<WireGuardrailMetrics>,
}

impl WireGuardrailTrace {
	fn into_telemetry(self) -> ProviderTelemetryEvent {
		let mut findings = Vec::new();
		for (policy, assessment) in self.input_assessment {
			assessment.append_findings(Some(policy), &mut findings);
		}
		for (policy, assessments) in self.output_assessments {
			for assessment in assessments {
				assessment.append_findings(Some(policy.clone()), &mut findings);
			}
		}
		let action = if findings
			.iter()
			.any(|finding| finding.action == SafetyAction::Blocked)
		{
			SafetyAction::Blocked
		} else if findings.iter().any(|finding| finding.detected) {
			SafetyAction::Intervened
		} else {
			SafetyAction::None
		};
		ProviderTelemetryEvent::SafetyAssessment {
			action,
			findings: findings.into_boxed_slice(),
			guardrail_latency: self
				.invocation_metrics
				.and_then(|metrics| metrics.guardrail_processing_latency)
				.map(Duration::from_millis),
		}
	}
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireGuardrailMetrics {
	guardrail_processing_latency: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAssessment {
	#[serde(rename = "contentPolicy")]
	content:   Option<WireContentPolicy>,
	#[serde(rename = "topicPolicy")]
	topic:     Option<WireTopicPolicy>,
	#[serde(rename = "wordPolicy")]
	word:      Option<WireWordPolicy>,
	#[serde(rename = "sensitiveInformationPolicy")]
	sensitive: Option<WireSensitivePolicy>,
	#[serde(rename = "contextualGroundingPolicy")]
	grounding: Option<WireGroundingPolicy>,
}

impl WireAssessment {
	fn append_findings(self, policy: Option<Str>, findings: &mut Vec<SafetyFinding>) {
		if let Some(content) = self.content {
			for filter in content.filters {
				findings.push(SafetyFinding {
					kind:                 SafetyFindingKind::Content,
					label:                filter.kind,
					policy:               policy.clone(),
					action:               safety_action(filter.action.as_deref()),
					detected:             filter.detected,
					confidence:           safety_confidence(filter.confidence.as_deref()),
					strength:             safety_strength(filter.filter_strength.as_deref()),
					threshold_millionths: None,
					score_millionths:     None,
					matched:              None,
				});
			}
		}
		if let Some(topic) = self.topic {
			for topic in topic.topics {
				findings.push(SafetyFinding {
					kind:                 SafetyFindingKind::Topic,
					label:                topic.name,
					policy:               policy.clone(),
					action:               safety_action(topic.action.as_deref()),
					detected:             topic.detected,
					confidence:           None,
					strength:             None,
					threshold_millionths: None,
					score_millionths:     None,
					matched:              topic.kind,
				});
			}
		}
		if let Some(word) = self.word {
			for finding in word.custom_words.into_iter().chain(word.managed_word_lists) {
				findings.push(SafetyFinding {
					kind:                 SafetyFindingKind::Word,
					label:                finding.kind.unwrap_or_else(|| sf!("word")),
					policy:               policy.clone(),
					action:               safety_action(finding.action.as_deref()),
					detected:             finding.detected,
					confidence:           None,
					strength:             None,
					threshold_millionths: None,
					score_millionths:     None,
					matched:              finding.matched,
				});
			}
		}
		if let Some(sensitive) = self.sensitive {
			for finding in sensitive.pii_entities.into_iter().chain(sensitive.regexes) {
				findings.push(SafetyFinding {
					kind:                 SafetyFindingKind::SensitiveInformation,
					label:                finding
						.kind
						.or(finding.name)
						.unwrap_or_else(|| sf!("sensitive")),
					policy:               policy.clone(),
					action:               safety_action(finding.action.as_deref()),
					detected:             finding.detected,
					confidence:           None,
					strength:             None,
					threshold_millionths: None,
					score_millionths:     None,
					matched:              finding.matched,
				});
			}
		}
		if let Some(grounding) = self.grounding {
			for filter in grounding.filters {
				findings.push(SafetyFinding {
					kind:                 SafetyFindingKind::ContextualGrounding,
					label:                filter.kind,
					policy:               policy.clone(),
					action:               safety_action(filter.action.as_deref()),
					detected:             filter.detected,
					confidence:           None,
					strength:             None,
					threshold_millionths: millionths(filter.threshold),
					score_millionths:     millionths(filter.score),
					matched:              None,
				});
			}
		}
	}
}

#[derive(Default, Deserialize)]
struct WireContentPolicy {
	#[serde(default)]
	filters: Vec<WireContentFilter>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireContentFilter {
	#[serde(rename = "type")]
	kind:            Str,
	confidence:      Option<Str>,
	filter_strength: Option<Str>,
	action:          Option<Str>,
	#[serde(default)]
	detected:        bool,
}

#[derive(Default, Deserialize)]
struct WireTopicPolicy {
	#[serde(default)]
	topics: Vec<WireTopicFinding>,
}

#[derive(Deserialize)]
struct WireTopicFinding {
	name:     Str,
	#[serde(rename = "type")]
	kind:     Option<Str>,
	action:   Option<Str>,
	#[serde(default)]
	detected: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWordPolicy {
	#[serde(default)]
	custom_words:       Vec<WireWordFinding>,
	#[serde(default)]
	managed_word_lists: Vec<WireWordFinding>,
}

#[derive(Deserialize)]
struct WireWordFinding {
	#[serde(rename = "match")]
	matched:  Option<Str>,
	#[serde(rename = "type")]
	kind:     Option<Str>,
	action:   Option<Str>,
	#[serde(default)]
	detected: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireSensitivePolicy {
	#[serde(default)]
	pii_entities: Vec<WireSensitiveFinding>,
	#[serde(default)]
	regexes:      Vec<WireSensitiveFinding>,
}

#[derive(Deserialize)]
struct WireSensitiveFinding {
	#[serde(rename = "type")]
	kind:     Option<Str>,
	name:     Option<Str>,
	#[serde(rename = "match")]
	matched:  Option<Str>,
	action:   Option<Str>,
	#[serde(default)]
	detected: bool,
}

#[derive(Default, Deserialize)]
struct WireGroundingPolicy {
	#[serde(default)]
	filters: Vec<WireGroundingFinding>,
}

#[derive(Deserialize)]
struct WireGroundingFinding {
	#[serde(rename = "type")]
	kind:      Str,
	threshold: Option<f64>,
	score:     Option<f64>,
	action:    Option<Str>,
	#[serde(default)]
	detected:  bool,
}

fn safety_action(action: Option<&str>) -> SafetyAction {
	match action {
		Some("BLOCKED" | "blocked") => SafetyAction::Blocked,
		Some("NONE" | "none") | None => SafetyAction::None,
		Some(_) => SafetyAction::Intervened,
	}
}

fn safety_confidence(confidence: Option<&str>) -> Option<SafetyConfidence> {
	match confidence {
		Some("LOW" | "low") => Some(SafetyConfidence::Low),
		Some("MEDIUM" | "medium") => Some(SafetyConfidence::Medium),
		Some("HIGH" | "high") => Some(SafetyConfidence::High),
		_ => None,
	}
}

fn safety_strength(strength: Option<&str>) -> Option<SafetyStrength> {
	match strength {
		Some("LOW" | "low") => Some(SafetyStrength::Low),
		Some("MEDIUM" | "medium") => Some(SafetyStrength::Medium),
		Some("HIGH" | "high") => Some(SafetyStrength::High),
		_ => None,
	}
}

fn millionths(value: Option<f64>) -> Option<u32> {
	let value = value?;
	value
		.is_finite()
		.then(|| (value.clamp(0.0, 1.0) * 1_000_000.0).round() as u32)
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireException {
	#[serde(default, alias = "Message")]
	message:              Option<Str>,
	#[serde(default)]
	original_message:     Option<Str>,
	#[serde(default)]
	original_status_code: Option<u32>,
}

fn map_stop(reason: &str, sentinel_injected: bool) -> Result<FinishReason, Error> {
	let reason = match reason {
		"end_turn" | "stop_sequence" => FinishReason::Stop,
		"tool_use" if sentinel_injected => FinishReason::Stop,
		"tool_use" => FinishReason::ToolCalls,
		"max_tokens" | "model_context_window_exceeded" => FinishReason::Length,
		"content_filtered" | "guardrail_intervened" => FinishReason::ContentFilter,
		other if !other.is_empty() => FinishReason::Other(Str::new(other)),
		_ => {
			return Err(stream_error(
				ErrorKind::ProviderContractMismatch,
				"bedrock.stop_reason.empty",
				false,
			));
		},
	};
	Ok(reason)
}

fn aws_exception_error(code: &str, message: Str, status: Option<u16>, committed: bool) -> Error {
	let (kind, action) = match code {
		"accessDeniedException" | "AccessDeniedException" | "notAuthorized" => {
			(ErrorKind::Authentication, RetryAction::Never)
		},
		"throttlingException" | "ThrottlingException" => {
			(ErrorKind::RateLimited, RetryAction::SameRoute { after: Duration::ZERO })
		},
		"modelTimeoutException" | "ModelTimeoutException" => {
			(ErrorKind::DeadlineExceeded, RetryAction::SameRoute { after: Duration::ZERO })
		},
		"serviceUnavailableException"
		| "ServiceUnavailableException"
		| "internalServerException"
		| "InternalServerException"
		| "modelStreamErrorException"
		| "ModelStreamErrorException" => {
			(ErrorKind::ResourceExhausted, RetryAction::SameRoute { after: Duration::ZERO })
		},
		"validationException" | "ValidationException" => {
			(ErrorKind::InvalidRequest, RetryAction::Never)
		},
		_ => (ErrorKind::Protocol, RetryAction::Never),
	};
	let action = if committed {
		RetryAction::Never
	} else {
		action
	};
	Error::new(kind, ErrorPhase::Streaming, action, ExecutionReceipt::default())
		.status(status)
		.code(Str::new(code))
		.committed(committed)
		.detail(ErrorDetail::provider(bounded_message(message)))
}

fn bounded_message(message: Str) -> Str {
	const MAX_BYTES: usize = 1_024;
	if message.len() <= MAX_BYTES {
		return message;
	}
	let mut end = MAX_BYTES;
	while !message.is_char_boundary(end) {
		end -= 1;
	}
	Str::new(&message[..end])
}

fn encoding_error(kind: ErrorKind, reason: &'static str) -> Error {
	Error::new(kind, ErrorPhase::Encoding, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn stream_error(kind: ErrorKind, reason: &'static str, committed: bool) -> Error {
	Error::new(kind, ErrorPhase::Streaming, RetryAction::Never, ExecutionReceipt::default())
		.committed(committed)
		.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_catalog::{Catalog, CodecId, PolicyModel, ProviderId, WirePolicy, WireTarget};

	use super::*;
	use crate::{
		call::{NegotiationPolicy, ReasoningRequest, Sampling, ToolDefinition, ToolInputConstraint},
		id::RequestId,
		transport::{EventStreamDecoder, EventStreamHeader, EventStreamHeaderValue, FramingError},
	};

	fn encode_fixture(request: &ChatRequest, options: &BedrockOptions) -> Bytes {
		encode_fixture_with_thinking(request, options, ThinkingMode::Budget, false)
	}

	fn encode_fixture_with_thinking(
		request: &ChatRequest,
		options: &BedrockOptions,
		mode: ThinkingMode,
		interleaved: bool,
	) -> Bytes {
		encode_fixture_with_policy(request, options, mode, interleaved, |_| {})
	}

	fn encode_fixture_with_policy(
		request: &ChatRequest,
		options: &BedrockOptions,
		mode: ThinkingMode,
		interleaved: bool,
		configure: impl FnOnce(&mut WirePolicy),
	) -> Bytes {
		encode_fixture_full(request, options, mode, interleaved, false, configure)
	}

	fn encode_fixture_full(
		request: &ChatRequest,
		options: &BedrockOptions,
		mode: ThinkingMode,
		interleaved: bool,
		prefix_binding: bool,
		configure: impl FnOnce(&mut WirePolicy),
	) -> Bytes {
		let catalog = Catalog::embedded();
		let fixture_model = if mode == ThinkingMode::AnthropicAdaptive {
			"amazon-bedrock/eu.anthropic.claude-opus-4-7"
		} else {
			"amazon-bedrock/eu.anthropic.claude-sonnet-4-6"
		};
		let model = catalog
			.models()
			.iter()
			.find(|model| model.key.as_str() == fixture_model)
			.expect("exact embedded Bedrock fixture model");
		let route = model
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.codec.as_str() == "bedrock-converse")
			.expect("embedded Bedrock Converse route");
		let base_wire_model = model
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.expect("embedded Bedrock wire model")
			.1
			.clone();
		let mut policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("embedded Bedrock wire policy")
			.clone();
		policy.reasoning.interleaved_thinking = interleaved.then_some(true);
		configure(&mut policy);
		let mut explicit_thinking_policy = model
			.thinking
			.as_ref()
			.and_then(|id| catalog.thinking_policy(id))
			.cloned();
		if let Some(thinking) = &mut explicit_thinking_policy {
			thinking.mode = mode;
			if prefix_binding {
				thinking.prefix_binding = Some(true);
			}
			if setting_value(&request.reasoning).is_some() {
				thinking.supports_display = Some(true);
			}
		}
		let thinking_policy = explicit_thinking_policy.as_ref();
		let thinking_selection = setting_value(&request.reasoning).map(|reasoning| {
			let thinking_policy = thinking_policy.expect("fixture model thinking policy");
			let requested = reasoning.effort.map(thinking_effort);
			let mut selection = model
				.thinking_routing
				.resolve(thinking_policy, requested, &base_wire_model)
				.expect("fixture thinking selection resolves");
			if reasoning.max_tokens.is_some() {
				selection.budget = reasoning.max_tokens;
			}
			selection
		});
		let wire_model = thinking_selection
			.as_ref()
			.map_or_else(|| base_wire_model.clone(), |selection| selection.wire_model.clone());
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let policy_model = PolicyModel::from(model);
		let request_id = RequestId::new("bedrock-fixture");
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy_model: Some(&policy_model),
			policy: &policy,
			thinking_policy,
			thinking_selection: thinking_selection.as_ref(),
			..EncodeContext::default()
		};
		encode_converse_request(request, &context, options).expect("fixture request encodes")
	}

	fn base_request(messages: Vec<Message>) -> ChatRequest {
		ChatRequest {
			messages:          messages.into(),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		}
	}

	fn text_message(role: Role, text: &'static str) -> Message {
		Message {
			role,
			content: vec![ContentPart::Text { text: sf!(text), proof: None }].into(),
			name: None,
		}
	}

	fn assert_fixture(body: Bytes, fixture: &str) {
		let expected = match fixture {
			"plain" => {
				include_bytes!("../../../../fixtures/llm-oracle/bedrock/request-plain-text.json")
					.as_slice()
			},
			"adaptive" => include_bytes!(
				"../../../../fixtures/llm-oracle/bedrock/request-tools-adaptive-thinking.json"
			)
			.as_slice(),
			"cache" => include_bytes!(
				"../../../../fixtures/llm-oracle/bedrock/request-cache-no-tools-sentinel.json"
			)
			.as_slice(),
			"budget" => include_bytes!(
				"../../../../fixtures/llm-oracle/bedrock/request-budget-thinking-interleaved.json"
			)
			.as_slice(),
			_ => panic!("unknown fixture"),
		};
		assert_eq!(body.as_ref(), expected);
	}

	#[test]
	fn encodes_plain_request_exactly() {
		let mut request = base_request(vec![
			text_message(Role::System, "Answer concisely."),
			text_message(Role::User, "Hello, Bedrock."),
		]);
		request.max_output_tokens = Some(128);
		request.sampling.temperature = Some(0.2);
		request.sampling.top_p = Some(0.9);
		request.sampling.stop = vec![sf!("<END>")].into();
		assert_fixture(encode_fixture(&request, &BedrockOptions::default()), "plain");
	}

	#[test]
	fn developer_messages_demote_to_user_role() {
		let request = base_request(vec![
			text_message(Role::System, "System instruction."),
			text_message(Role::Developer, "Developer instruction."),
			text_message(Role::User, "Question."),
		]);
		let body: Value =
			serde_json::from_slice(&encode_fixture(&request, &BedrockOptions::default()))
				.expect("developer request is JSON");
		assert_eq!(body["system"], serde_json::json!([{"text":"System instruction."}]));
		assert_eq!(
			body["messages"],
			serde_json::json!([{
				"role": "user",
				"content": [
					{"text":"Developer instruction."},
					{"text":"Question."}
				]
			}]),
		);
	}

	#[test]
	fn encodes_tools_and_adaptive_thinking_exactly() {
		let mut request = base_request(vec![text_message(Role::User, "Calculate 2 + 2.")]);
		request.tools = vec![ToolDefinition {
			name:        sf!("calculator"),
			description: Some(sf!("Evaluate a mathematical expression.")),
			input: ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					serde_json::from_str(
						r#"{"type":"object","properties":{"expression":{"type":"string"}},"required":["expression"]}"#,
					)
					.expect("schema"),
				),
				strict: false,
			},
		}]
		.into();
		request.tool_choice = Setting::Require(ToolChoice::Auto);
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Summary,
			effort:              Some(ReasoningEffort::High),
			max_tokens:          None,
			preserve_signatures: true,
		});
		assert_fixture(
			encode_fixture_with_thinking(
				&request,
				&BedrockOptions::default(),
				ThinkingMode::AnthropicAdaptive,
				false,
			),
			"adaptive",
		);
	}

	#[test]
	fn encodes_effort_reasoning_without_dropping_output_cap() {
		let mut request = base_request(vec![text_message(Role::User, "Solve carefully.")]);
		request.max_output_tokens = Some(16);
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Summary,
			effort:              Some(ReasoningEffort::High),
			max_tokens:          None,
			preserve_signatures: true,
		});
		let body: Value = serde_json::from_slice(&encode_fixture_with_thinking(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Effort,
			false,
		))
		.expect("effort request is JSON");
		assert_eq!(
			body["additionalModelRequestFields"],
			serde_json::json!({"reasoning":{"effort":"high"}}),
		);
		assert_eq!(body["inferenceConfig"]["maxTokens"], 16);
		assert!(
			body["additionalModelRequestFields"]
				.get("thinking")
				.is_none()
		);
	}

	#[test]
	fn forced_tool_choice_with_thinking_downgrades_instead_of_failing() {
		// Converse rejects thinking + `any`/`tool`. Prefix-bound models keep thinking
		// and fall back to `auto`; every
		// other model keeps the forced choice and drops thinking.
		let mut request = base_request(vec![text_message(Role::User, "Calculate 2 + 2.")]);
		request.tools = vec![ToolDefinition {
			name:        sf!("calculator"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					serde_json::from_str(r#"{"type":"object","properties":{}}"#).expect("schema"),
				),
				strict:     false,
			},
		}]
		.into();
		request.tool_choice = Setting::Require(ToolChoice::Named(sf!("calculator")));
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Summary,
			effort:              Some(ReasoningEffort::High),
			max_tokens:          None,
			preserve_signatures: true,
		});

		let bound: Value = serde_json::from_slice(&encode_fixture_full(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::AnthropicAdaptive,
			false,
			true,
			|_| {},
		))
		.expect("prefix-bound request is JSON");
		assert_eq!(bound["toolConfig"]["toolChoice"], serde_json::json!({"auto": {}}));
		assert_eq!(bound["additionalModelRequestFields"]["thinking"]["type"], "adaptive");
		assert_eq!(
			bound["additionalModelRequestFields"]["thinking"]["block_binding"],
			serde_json::json!({"prefix_mismatch_behavior":"drop_block"}),
		);
		assert_eq!(
			bound["additionalModelRequestFields"]["anthropic_beta"],
			serde_json::json!(["thinking-binding-controls-2026-08-01"]),
		);
		assert_eq!(
			bound["additionalModelResponseFieldPaths"],
			serde_json::json!(["/input_transformations"]),
		);

		request.tool_choice = Setting::Require(ToolChoice::Required);
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Hidden,
			effort:              Some(ReasoningEffort::High),
			max_tokens:          Some(4_096),
			preserve_signatures: true,
		});
		let unbound: Value = serde_json::from_slice(&encode_fixture_with_thinking(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Budget,
			false,
		))
		.expect("budget request is JSON");
		assert_eq!(unbound["toolConfig"]["toolChoice"], serde_json::json!({"any": {}}));
		assert!(unbound.get("additionalModelRequestFields").is_none(), "{unbound}");
	}

	#[test]
	fn disabled_tool_choice_omits_live_tools_but_preserves_history_contract() {
		let mut request = base_request(vec![text_message(Role::User, "Answer without tools.")]);
		request.tools = vec![ToolDefinition {
			name:        sf!("lookup"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					serde_json::from_str(r#"{"type":"object","properties":{}}"#).expect("schema"),
				),
				strict:     false,
			},
		}]
		.into();
		request.tool_choice = Setting::Require(ToolChoice::Disabled);
		let without_history: Value =
			serde_json::from_slice(&encode_fixture(&request, &BedrockOptions::default()))
				.expect("disabled tool request is JSON");
		assert!(without_history.get("toolConfig").is_none());

		let call = ToolCallId::new("prior-call");
		request.messages = vec![
			Message {
				role:    Role::Assistant,
				content: vec![ContentPart::ToolCall {
					call:      call.clone(),
					name:      sf!("lookup"),
					arguments: OpaqueJson::new(serde_json::json!({})),
					proof:     None,
				}]
				.into(),
				name:    None,
			},
			Message {
				role:    Role::Tool,
				content: vec![ContentPart::ToolResult {
					call,
					name: Some(sf!("lookup")),
					content: vec![ToolResultContent::Text(sf!("done"))].into(),
					is_error: false,
				}]
				.into(),
				name:    None,
			},
		]
		.into();
		let with_history: Value =
			serde_json::from_slice(&encode_fixture(&request, &BedrockOptions::default()))
				.expect("history-bearing disabled tool request is JSON");
		assert_eq!(with_history["toolConfig"]["tools"][0]["toolSpec"]["name"], "lookup");
		assert!(with_history["toolConfig"].get("toolChoice").is_none());
	}

	#[test]
	fn encodes_cache_and_no_tools_sentinel_exactly() {
		let proof = ProviderProof {
			provider: ProviderId::new("amazon-bedrock"),
			codec:    CodecId::new("bedrock-converse"),
			value:    Bytes::from_static(b"synthetic-signature"),
		};
		let call = ToolCallId::new("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		let mut request = base_request(vec![
			text_message(Role::System, "Use prior tool results."),
			text_message(Role::User, "Find x."),
			Message {
				role:    Role::Assistant,
				content: vec![
					ContentPart::Reasoning { text: sf!("I should look it up."), proof: Some(proof) },
					ContentPart::ToolCall {
						call:      call.clone(),
						name:      sf!("lookup"),
						arguments: OpaqueJson::new(
							serde_json::from_str(r#"{"q":"x"}"#).expect("arguments"),
						),
						proof:     None,
					},
				]
				.into(),
				name:    None,
			},
			Message {
				role:    Role::Tool,
				content: vec![ContentPart::ToolResult {
					call,
					name: Some(sf!("lookup")),
					content: vec![ToolResultContent::Text(sf!("x is 4"))].into(),
					is_error: false,
				}]
				.into(),
				name:    None,
			},
			text_message(Role::User, "Continue without more tools."),
		]);
		request.cache_retention = Setting::Require(CacheRetention::Long);
		assert_fixture(
			encode_fixture_with_policy(
				&request,
				&BedrockOptions::default(),
				ThinkingMode::Budget,
				false,
				|policy| policy.cache.supports_long_retention = Some(true),
			),
			"cache",
		);
	}
	#[test]
	fn prompt_cache_mode_matches_pi_request_shape() {
		let mut request = base_request(vec![
			text_message(Role::System, "stable system"),
			text_message(Role::User, "cache me"),
		]);
		request.cache_retention = Setting::Require(CacheRetention::Short);

		let automatic = encode_fixture_with_policy(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Budget,
			false,
			|policy| {
				policy.cache.prompt_cache_mode = Some(PromptCacheMode::Automatic);
				policy.cache.maximum_checkpoints = Some(2);
			},
		);
		let automatic: Value =
			serde_json::from_slice(&automatic).expect("automatic cache request is JSON");
		assert!(!automatic.to_string().contains("cachePoint"));

		let explicit = encode_fixture_with_policy(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Budget,
			false,
			|policy| {
				policy.cache.prompt_cache_mode = Some(PromptCacheMode::Explicit);
				policy.cache.maximum_checkpoints = Some(2);
			},
		);
		let explicit: Value =
			serde_json::from_slice(&explicit).expect("explicit cache request is JSON");
		assert_eq!(
			explicit["messages"][0]["content"][1],
			serde_json::json!({"cachePoint":{"type":"default"}}),
		);
		assert_eq!(explicit["system"][1], serde_json::json!({"cachePoint":{"type":"default"}}),);
	}

	#[test]
	fn prompt_cache_does_not_reach_back_past_a_final_assistant_message() {
		let mut request = base_request(vec![
			text_message(Role::System, "stable system"),
			text_message(Role::User, "cache me"),
			text_message(Role::Assistant, "final answer"),
		]);
		request.cache_retention = Setting::Require(CacheRetention::Short);
		let body = encode_fixture_with_policy(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Budget,
			false,
			|policy| {
				policy.cache.prompt_cache_mode = Some(PromptCacheMode::Explicit);
				policy.cache.maximum_checkpoints = Some(2);
			},
		);
		let body: Value = serde_json::from_slice(&body).expect("cache request is JSON");
		assert_eq!(
			body["messages"][0],
			serde_json::json!({"role":"user","content":[{"text":"cache me"}]}),
		);
		assert_eq!(
			body["messages"][1],
			serde_json::json!({"role":"assistant","content":[{"text":"final answer"}]}),
		);
		assert_eq!(
			body["system"],
			serde_json::json!([
				{"text":"stable system"},
				{"cachePoint":{"type":"default"}}
			]),
		);
	}

	#[test]
	fn prompt_cache_maximum_checkpoints_matches_pi_request_shape() {
		let mut request = base_request(vec![
			text_message(Role::System, "stable system"),
			text_message(Role::User, "cache me"),
		]);
		request.cache_retention = Setting::Require(CacheRetention::Short);
		let body = encode_fixture_with_policy(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Budget,
			false,
			|policy| {
				policy.cache.prompt_cache_mode = Some(PromptCacheMode::Explicit);
				policy.cache.maximum_checkpoints = Some(1);
			},
		);
		let body: Value = serde_json::from_slice(&body).expect("cache request is JSON");
		assert_eq!(
			body["messages"][0]["content"][1],
			serde_json::json!({"cachePoint":{"type":"default"}}),
		);
		assert_eq!(body["system"], serde_json::json!([{"text":"stable system"}]));
	}

	#[test]
	fn supports_long_prompt_cache_retention_matches_pi_request_shape() {
		let mut request = base_request(vec![text_message(Role::User, "cache me")]);
		request.cache_retention = Setting::Require(CacheRetention::Long);
		let body = encode_fixture_with_policy(
			&request,
			&BedrockOptions::default(),
			ThinkingMode::Budget,
			false,
			|policy| {
				policy.cache.prompt_cache_mode = Some(PromptCacheMode::Explicit);
				policy.cache.maximum_checkpoints = Some(1);
				policy.cache.supports_long_retention = Some(true);
			},
		);
		let body: Value = serde_json::from_slice(&body).expect("long cache request is JSON");
		assert_eq!(
			body["messages"][0]["content"][1],
			serde_json::json!({"cachePoint":{"type":"default","ttl":"1h"}}),
		);
	}

	#[test]
	fn replay_demotes_unsigned_reasoning_and_preserves_signed_reasoning_content() {
		let proof = ProviderProof {
			provider: ProviderId::new("amazon-bedrock"),
			codec:    CodecId::new("bedrock-converse"),
			value:    Bytes::from_static(b"captured-signature"),
		};
		let request = base_request(vec![
			text_message(Role::User, "Plan the change."),
			Message {
				role:    Role::Assistant,
				content: vec![
					ContentPart::Reasoning { text: sf!("unsigned reasoning"), proof: None },
					ContentPart::Reasoning {
						text:  sf!("signed reasoning"),
						proof: Some(proof.clone()),
					},
					ContentPart::Reasoning { text: Str::default(), proof: Some(proof) },
				]
				.into(),
				name:    None,
			},
			text_message(Role::User, "Continue."),
		]);
		let body: Value =
			serde_json::from_slice(&encode_fixture(&request, &BedrockOptions::default()))
				.expect("encoded request is JSON");
		let blocks = body["messages"][1]["content"]
			.as_array()
			.expect("assistant content blocks");
		assert_eq!(
			blocks[0],
			serde_json::json!({"text":"<thinking>\nunsigned reasoning\n</thinking>"})
		);
		assert_eq!(
			blocks[1],
			serde_json::json!({
				"reasoningContent": {
					"reasoningText": {
						"text": "signed reasoning",
						"signature": "captured-signature"
					}
				}
			})
		);
		assert_eq!(
			blocks[2],
			serde_json::json!({
				"reasoningContent": {
					"reasoningText": {
						"text": "",
						"signature": "captured-signature"
					}
				}
			})
		);
		assert!(blocks.iter().all(|block| {
			block
				.get("reasoningContent")
				.is_none_or(|reasoning| reasoning["reasoningText"]["signature"].is_string())
		}));
	}

	#[test]
	fn encodes_budget_and_interleaved_thinking_exactly() {
		let mut request = base_request(vec![text_message(Role::User, "Solve carefully.")]);
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Hidden,
			effort:              Some(ReasoningEffort::High),
			max_tokens:          Some(4_096),
			preserve_signatures: true,
		});
		assert_fixture(
			encode_fixture_with_thinking(
				&request,
				&BedrockOptions::default(),
				ThinkingMode::Budget,
				true,
			),
			"budget",
		);
	}

	#[test]
	fn maps_guardrail_request_and_typed_trace() {
		let request = base_request(vec![text_message(Role::User, "Check this.")]);
		let options = BedrockOptions {
			guardrail: Some(BedrockGuardrail {
				identifier:  sf!("guardrail-1"),
				version:     sf!("7"),
				trace:       Some(GuardrailTraceMode::EnabledFull),
				stream_mode: Some(GuardrailStreamMode::Async),
			}),
			..BedrockOptions::default()
		};
		assert_eq!(
			encode_fixture(&request, &options).as_ref(),
			br#"{"messages":[{"role":"user","content":[{"text":"Check this."}]}],"guardrailConfig":{"guardrailIdentifier":"guardrail-1","guardrailVersion":"7","trace":"enabled_full","streamProcessingMode":"async"}}"#,
		);

		let event: WireEvent = serde_json::from_slice(
			br#"{"trace":{"guardrail":{"inputAssessment":{"prompt":{"contentPolicy":{"filters":[{"type":"VIOLENCE","confidence":"HIGH","filterStrength":"MEDIUM","action":"BLOCKED","detected":true}]}}},"invocationMetrics":{"guardrailProcessingLatency":7}}}}"#,
		)
		.expect("typed guardrail trace");
		let mut events = Vec::new();
		BedrockDecoder::default()
			.project_event(event, &mut |event| events.push(event))
			.expect("guardrail projection");
		assert!(matches!(
			events.as_slice(),
			[RawEvent::Telemetry(ProviderTelemetryEvent::SafetyAssessment {
				action: SafetyAction::Blocked,
				findings,
				guardrail_latency: Some(latency),
			})] if findings.len() == 1
				&& findings[0].label == "VIOLENCE"
				&& findings[0].confidence == Some(SafetyConfidence::High)
				&& findings[0].strength == Some(SafetyStrength::Medium)
				&& *latency == Duration::from_millis(7)
		));
	}
	#[test]
	fn guardrail_settings_default_only_derivable_fields() {
		let guardrail: BedrockGuardrail = serde_json::from_str(
			r#"{"identifier":"arn:aws:bedrock:eu-west-2:123456789012:guardrail/example"}"#,
		)
		.expect("typed guardrail settings");
		assert_eq!(guardrail.version, "DRAFT");
		assert_eq!(guardrail.trace, None);
		assert_eq!(guardrail.stream_mode, None);
		let request = base_request(vec![text_message(Role::User, "Check this.")]);
		let body: Value = serde_json::from_slice(&encode_fixture(&request, &BedrockOptions {
			guardrail: Some(guardrail),
			..BedrockOptions::default()
		}))
		.expect("guardrail request is JSON");
		assert_eq!(
			body["guardrailConfig"],
			serde_json::json!({
				"guardrailIdentifier":
					"arn:aws:bedrock:eu-west-2:123456789012:guardrail/example",
				"guardrailVersion": "DRAFT"
			}),
		);
	}

	#[test]
	fn request_metadata_is_sanitized_capped_and_omitted_when_empty() {
		let request = base_request(vec![text_message(Role::User, "attribute this")]);
		let mut request_metadata = BTreeMap::new();
		request_metadata.insert(sf!("bad*key"), sf!("dropped"));
		request_metadata.insert(sf!("long"), Str::new("x".repeat(257)));
		request_metadata.insert(sf!("good"), sf!("kept"));
		for index in 0..20 {
			request_metadata.insert(Str::new(format!("tag{index:02}")), sf!("value"));
		}
		let body: Value = serde_json::from_slice(&encode_fixture(&request, &BedrockOptions {
			request_metadata,
			..BedrockOptions::default()
		}))
		.expect("metadata request is JSON");
		let metadata = body["requestMetadata"]
			.as_object()
			.expect("valid metadata remains");
		assert_eq!(metadata.len(), 16);
		assert_eq!(metadata.get("good"), Some(&Value::String("kept".to_owned())));
		assert!(!metadata.contains_key("bad*key"));
		assert!(!metadata.contains_key("long"));

		let empty: Value =
			serde_json::from_slice(&encode_fixture(&request, &BedrockOptions::default()))
				.expect("plain request is JSON");
		assert!(empty.get("requestMetadata").is_none());
		assert_eq!(
			sanitize_request_metadata_value(serde_json::json!({
				"valid": "yes",
				"bad*key": "no",
				"nonString": 7
			})),
			Some(serde_json::json!({"valid":"yes"})),
		);
		assert_eq!(sanitize_request_metadata_value(serde_json::json!([])), None);
	}

	#[test]
	fn guardrail_arn_region_obeys_explicit_and_geo_precedence() {
		let guardrail = BedrockGuardrail {
			identifier:  sf!("arn:aws:bedrock:eu-west-2:123456789012:guardrail/example"),
			version:     sf!("7"),
			trace:       Some(GuardrailTraceMode::Enabled),
			stream_mode: Some(GuardrailStreamMode::Sync),
		};
		assert_eq!(
			guardrail_arn_region("arn:aws:bedrock:eu-west-2:123456789012:foundation-model/example"),
			None,
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				None,
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"openai.gpt-oss-20b-1:0",
				Some(&guardrail),
			),
			"eu-west-2",
		);
		assert_eq!(
			resolve_bedrock_region(
				Some("us-west-2"),
				None,
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"openai.gpt-oss-20b-1:0",
				Some(&guardrail),
			),
			"us-west-2",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("us-east-1"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"eu.anthropic.claude-opus-4-8",
				Some(&guardrail),
			),
			"eu-west-2",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("eu-central-1"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"eu.anthropic.claude-opus-4-8",
				Some(&guardrail),
			),
			"eu-central-1",
		);
		assert_eq!(
			bedrock_runtime_endpoint("https://bedrock-runtime.us-east-1.amazonaws.com", "eu-west-2",),
			"https://bedrock-runtime.eu-west-2.amazonaws.com/",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("us-east-1"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"au.anthropic.claude-opus-4-8",
				None,
			),
			"ap-southeast-2",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("ap-northeast-3"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"jp.anthropic.claude-opus-4-8",
				None,
			),
			"ap-northeast-3",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("eu-west-1"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"us-gov.anthropic.claude-opus-4-8",
				None,
			),
			"us-gov-west-1",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("eu-west-1"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/example",
				None,
			),
			"us-east-2",
		);
		assert_eq!(
			resolve_bedrock_region(
				None,
				Some("eu-central-1"),
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"global.anthropic.claude-opus-4-8",
				None,
			),
			"eu-central-1",
		);
		assert_eq!(
			bedrock_runtime_endpoint("https://bedrock-runtime.us-east-1.api.aws", "eu-west-2"),
			"https://bedrock-runtime.eu-west-2.api.aws/",
		);
		assert_eq!(
			bedrock_runtime_endpoint("https://bedrock-runtime.us-east-1.amazonaws.com", "cn-north-1",),
			"https://bedrock-runtime.cn-north-1.amazonaws.com.cn/",
		);
		assert_eq!(
			bedrock_runtime_endpoint("https://bedrock.proxy.example/base", "eu-west-2"),
			"https://bedrock.proxy.example/base",
		);
		assert_eq!(
			converse_stream_uri(
				"https://bedrock-runtime.us-east-1.amazonaws.com",
				"arn:aws:bedrock:us-east-2:123:application-inference-profile/example",
				"us-east-2",
			)
			.expect("valid Bedrock endpoint"),
			"https://bedrock-runtime.us-east-2.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aus-east-2%3A123%3Aapplication-inference-profile%2Fexample/converse-stream",
		);
		assert_eq!(
			converse_stream_uri(
				"https://proxy.example/runtime?stale=true#fragment",
				"model",
				"eu-west-2"
			)
			.expect("custom endpoint"),
			"https://proxy.example/runtime/model/model/converse-stream",
		);
		let error =
			converse_stream_uri("not a URL", "model", "us-east-1").expect_err("invalid endpoint");
		assert_eq!(error.kind, ErrorKind::InvalidRequest);
	}

	fn replay(bytes: &'static [u8], fragmented: bool) -> Vec<RawEvent> {
		let mut framer = EventStreamDecoder::new();
		let mut decoder = BedrockDecoder::default();
		let mut events = Vec::new();
		let pattern = [1_usize, 2, 5, 8, 13, 21, 34];
		let mut offset = 0;
		let mut step = 0;
		while offset < bytes.len() {
			let size = if fragmented {
				pattern[step % pattern.len()]
			} else {
				bytes.len()
			};
			let end = offset.saturating_add(size).min(bytes.len());
			for message in framer
				.push(Bytes::copy_from_slice(&bytes[offset..end]))
				.expect("valid EventStream frame")
			{
				decoder
					.push(Frame::EventStream(Box::new(message)), &mut |event| events.push(event))
					.expect("valid Converse event");
			}
			offset = end;
			step += 1;
		}
		assert!(framer.finish().expect("complete framing").is_empty());
		decoder
			.finish(&mut |event| events.push(event))
			.expect("complete Converse stream");
		events
	}

	#[test]
	fn replays_fragmented_twelve_frame_success_with_usage_and_metrics() {
		let events = replay(
			include_bytes!("../../../../fixtures/llm-oracle/bedrock/eventstream-success.bin"),
			true,
		);
		assert_eq!(events.len(), 14);
		assert!(matches!(
			&events[0],
			RawEvent::Chat(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Thinking })
		));
		assert!(matches!(
			&events[7],
			RawEvent::ProviderState(ProviderStateEvent::ToolCallProof { index: 2, value })
				if value.as_ref() == b"wire-tool-42"
		));
		assert!(matches!(
			&events[10],
			RawEvent::ToolCallComplete {
				index: 2,
				call: UnvalidatedToolCall { name, arguments, input_kind: ToolInputKind::Json, .. }
			} if name == "lookup" && arguments.as_ref() == br#"{"q":"x"}"#
		));
		assert!(matches!(
			&events[11],
			RawEvent::Chat(ChatEvent::Usage(UsageUpdate {
				usage:        Usage {
					input_tokens: 10,
					output_tokens: 4,
					cache_read_tokens: 3,
					cache_write_tokens: 2,
					..
				},
				final_update: true,
			}))
		));
		assert!(matches!(
			&events[12],
			RawEvent::Telemetry(ProviderTelemetryEvent::ModelLatency(duration))
				if *duration == Duration::from_millis(123)
		));
		assert!(matches!(
			&events[13],
			RawEvent::Completion(RawCompletion { reason: FinishReason::ToolCalls, blocks: 3, .. })
		));
	}

	#[test]
	fn sentinel_name_is_suppressed_only_when_this_request_injected_it() {
		let start = || WireEvent {
			role: None,
			content_block_index: Some(0),
			start: Some(WireStart {
				tool_use: Some(WireToolStart {
					tool_use_id: sf!("call-1"),
					name:        sf!(NO_TOOLS_SENTINEL_NAME),
				}),
			}),
			delta: None,
			stop_reason: None,
			additional_model_response_fields: None,
			usage: None,
			metrics: None,
			trace: None,
		};

		let mut legitimate = BedrockDecoder::default();
		let mut events = Vec::new();
		legitimate
			.project_event(start(), &mut |event| events.push(event))
			.expect("legitimate sentinel-named tool projects");
		assert!(matches!(
			events.first(),
			Some(RawEvent::Chat(ChatEvent::ToolCallStarted { name, .. }))
				if name == NO_TOOLS_SENTINEL_NAME
		));

		let mut injected = BedrockDecoder { sentinel_injected: true, ..BedrockDecoder::default() };
		events.clear();
		injected
			.project_event(start(), &mut |event| events.push(event))
			.expect("injected sentinel is ignored");
		assert!(events.is_empty());
	}

	#[test]
	fn response_semantics_project_transformations_and_distinct_stop_reasons() {
		let mut decoder = BedrockDecoder::default();
		let mut events = Vec::new();
		let event: WireEvent = serde_json::from_value(serde_json::json!({
			"stopReason": "guardrail_intervened",
			"additionalModelResponseFields": {
				"input_transformations": [
					{
						"type": "thinking",
						"path": "/messages/1/content/0",
						"reason": "prefix_binding_mismatch",
						"future": true
					},
					{"missing": "type"}
				]
			}
		}))
		.expect("message stop event");
		decoder
			.project_event(event, &mut |event| events.push(event))
			.expect("message stop projects");
		assert!(matches!(
			events.first(),
			Some(RawEvent::Metadata(ProviderMetadataEvent::InputTransformation {
				kind,
				path: Some(path),
				reason: Some(reason),
				data,
			})) if kind == "thinking"
				&& path == "/messages/1/content/0"
				&& reason == "prefix_binding_mismatch"
				&& serde_json::from_slice::<Value>(data)
					.expect("preserved transformation")["future"] == true
		));
		assert!(matches!(
			events.get(1),
			Some(RawEvent::Metadata(ProviderMetadataEvent::FinishMessage { message, .. }))
				if message == "Response blocked by Amazon Bedrock guardrail."
		));
		assert_eq!(decoder.stop, Some(FinishReason::ContentFilter));
		assert_eq!(
			map_stop("content_filtered", false).expect("known stop"),
			FinishReason::ContentFilter,
		);
		assert_eq!(map_stop("tool_use", false).expect("known stop"), FinishReason::ToolCalls);
		assert_eq!(map_stop("tool_use", true).expect("known stop"), FinishReason::Stop);
		assert_eq!(
			map_stop("future_reason", false).expect("forward-compatible stop"),
			FinishReason::Other(sf!("future_reason")),
		);
	}

	#[test]
	fn response_waits_for_usage_when_metrics_arrive_after_stop() {
		let mut decoder = BedrockDecoder::default();
		let mut events = Vec::new();
		for value in [
			serde_json::json!({"stopReason":"end_turn"}),
			serde_json::json!({"metrics":{"latencyMs":17}}),
		] {
			let event: WireEvent = serde_json::from_value(value).expect("response event");
			decoder
				.project_event(event, &mut |event| events.push(event))
				.expect("response event projects");
		}
		assert!(!decoder.terminal);
		assert!(matches!(
			events.as_slice(),
			[RawEvent::Telemetry(ProviderTelemetryEvent::ModelLatency(duration))]
				if *duration == Duration::from_millis(17)
		));
		let usage: WireEvent = serde_json::from_value(serde_json::json!({
			"usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}
		}))
		.expect("usage event");
		decoder
			.project_event(usage, &mut |event| events.push(event))
			.expect("usage projects");
		assert!(decoder.terminal);
		assert!(matches!(
			events.last(),
			Some(RawEvent::Completion(RawCompletion {
				reason: FinishReason::Stop,
				usage: Usage { input_tokens: 3, output_tokens: 2, .. },
				..
			}))
		));
	}

	#[test]
	fn unknown_stream_events_are_forward_compatible() {
		let message = EventStreamMessage {
			headers: vec![
				EventStreamHeader {
					name:  sf!(":message-type"),
					value: EventStreamHeaderValue::String(sf!("event")),
				},
				EventStreamHeader {
					name:  sf!(":event-type"),
					value: EventStreamHeaderValue::String(sf!("futureEvent")),
				},
			]
			.into_iter()
			.collect(),
			payload: Bytes::from_static(br#"{"future":"shape"}"#),
		};
		let mut events = Vec::new();
		BedrockDecoder::default()
			.push(Frame::EventStream(Box::new(message)), &mut |event| events.push(event))
			.expect("unknown AWS events are ignored");
		assert!(events.is_empty());
	}

	#[test]
	fn stream_retry_is_allowed_only_before_canonical_output_commits() {
		let before = aws_exception_error("throttlingException", sf!("slow down"), Some(429), false);
		assert!(matches!(before.action, RetryAction::SameRoute { .. }));
		assert!(!before.committed);

		let timeout =
			aws_exception_error("modelTimeoutException", sf!("model timed out"), Some(408), false);
		assert_eq!(timeout.kind, ErrorKind::DeadlineExceeded);
		assert!(matches!(timeout.action, RetryAction::SameRoute { .. }));

		let after = aws_exception_error("throttlingException", sf!("slow down"), Some(429), true);
		assert_eq!(after.action, RetryAction::Never);
		assert!(after.committed);
	}

	#[test]
	fn maps_all_stream_exceptions_to_structured_evidence() {
		let cases: &[(&[u8], ErrorKind, &str)] = &[
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/bedrock/eventstream-exception-access-denied.bin"
				),
				ErrorKind::Authentication,
				"synthetic access denied",
			),
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/bedrock/eventstream-exception-throttling.bin"
				),
				ErrorKind::RateLimited,
				"synthetic throttle",
			),
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/bedrock/eventstream-exception-service-unavailable.\
					 bin"
				),
				ErrorKind::ResourceExhausted,
				"synthetic capacity unavailable",
			),
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/bedrock/eventstream-exception-validation.bin"
				),
				ErrorKind::InvalidRequest,
				"synthetic validation failure",
			),
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/bedrock/\
					 eventstream-exception-error-header-throttling.bin"
				),
				ErrorKind::RateLimited,
				"synthetic retry later",
			),
		];
		for (bytes, expected_kind, expected_message) in cases {
			let events = replay(bytes, true);
			assert_eq!(events.len(), 1);
			let RawEvent::Failure(error) = &events[0] else {
				panic!("exception did not become a failure");
			};
			assert_eq!(error.kind, *expected_kind);
			assert!(!error.committed);
			assert!(matches!(
				error.detail_ref(),
				Some(ErrorDetail::Provider { sanitized_message }) if sanitized_message == expected_message
			));
		}
	}

	#[test]
	fn shared_eventstream_rejects_crc_and_truncation_fixtures() {
		let mut crc = EventStreamDecoder::new();
		assert!(matches!(
			crc.push(Bytes::from_static(include_bytes!(
				"../../../../fixtures/llm-oracle/bedrock/eventstream-invalid-crc.bin"
			))),
			Err(FramingError::CrcMismatch { .. })
		));

		let mut truncated = EventStreamDecoder::new();
		assert!(
			truncated
				.push(Bytes::from_static(include_bytes!(
					"../../../../fixtures/llm-oracle/bedrock/eventstream-truncated.bin"
				)))
				.expect("prefix is structurally valid")
				.is_empty()
		);
		assert!(matches!(
			truncated.finish(),
			Err(FramingError::UnexpectedEof { protocol: FramingProtocol::AwsEventStream, .. })
		));
	}

	#[test]
	fn discovery_targets_control_plane_and_projects_typed_rows() {
		assert_eq!(
			bedrock_discovery_endpoint("https://bedrock-runtime.{region}.amazonaws.com", "eu-west-1",)
				.expect("control-plane endpoint")
				.as_str(),
			"https://bedrock.eu-west-1.amazonaws.com/foundation-models",
		);
		let response: FoundationModelsResponse = serde_json::from_slice(
			br#"{"modelSummaries":[
				{"modelId":"anthropic.claude-3-5-sonnet-20241022-v2:0",
				 "modelName":"Claude 3.5 Sonnet v2","providerName":"Anthropic",
				 "inputModalities":["TEXT","IMAGE"],"outputModalities":["TEXT"],
				 "responseStreamingSupported":true,
				 "inferenceTypesSupported":["ON_DEMAND"],
				 "modelLifecycle":{"status":"ACTIVE"}},
				{"modelId":"amazon.titan-embed-text-v2:0","providerName":"Amazon",
				 "outputModalities":["EMBEDDING"],"responseStreamingSupported":false,
				 "modelLifecycle":{"status":"ACTIVE"}},
				{"modelId":"anthropic.claude-v2","providerName":"Anthropic",
				 "outputModalities":["TEXT"],"modelLifecycle":{"status":"LEGACY"}},
				{"modelId":"meta.llama-provisioned","providerName":"Meta",
				 "outputModalities":["TEXT"],"inferenceTypesSupported":["PROVISIONED"]},
				{"modelId":"amazon.nova-pro-v1:0"}
			]}"#,
		)
		.expect("typed ListFoundationModels response");
		let provider = ProviderId::new("amazon-bedrock");
		let route = omp_catalog::RouteId::new("amazon-bedrock/primary");
		let rows: Vec<_> = response
			.model_summaries
			.into_iter()
			.filter_map(|summary| summary.into_discovered(&provider, &route))
			.collect();
		assert_eq!(rows.len(), 2);
		assert_eq!(rows[0].wire_model.as_str(), "anthropic.claude-3-5-sonnet-20241022-v2:0",);
		assert_eq!(rows[0].display_name.as_ref().map(Str::as_str), Some("Claude 3.5 Sonnet v2"));
		assert_eq!(rows[0].declared_class.as_ref().map(ClassId::as_str), Some("Anthropic"));
		assert!(
			rows[0]
				.declared_operations
				.contains_kind(OperationKind::Chat)
		);
		assert!(matches!(
			rows[0]
				.declared_capabilities
				.as_ref()
				.and_then(|capabilities| capabilities.chat.as_ref())
				.map(|chat| &chat.input_modalities),
			Some(Availability::Native(modalities)) if modalities.contains(ModalityBits::IMAGE)
		));
		assert_eq!(rows[1].wire_model.as_str(), "amazon.nova-pro-v1:0");
		assert_eq!(rows[1].declared_class.as_ref().map(ClassId::as_str), Some("amazon"));
	}
}
