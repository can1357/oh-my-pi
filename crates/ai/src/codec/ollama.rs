//! Typed Ollama `/api/chat` and `/api/tags` wire shapes and sans-I/O decoding.

use bytes::Bytes;
use omp_catalog::{
	ClassId, OperationBits, OperationKind, ProviderId, RouteId, ThinkingEffort, WireModelId,
	discover::DiscoveredModel,
};
use omp_core::{Str, encoding::base64, sf};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

use crate::{
	answer::{AnswerBody, Embedding, EmbeddingBatch},
	body::BodySource,
	call::{
		ChatRequest, ContentPart, EmbedRequest, EmbeddingInput, MediaInput, Message, OperationCall,
		ProviderProof, ReasoningRequest, Role, Setting, StructuredOutput, ToolChoice,
		ToolResultContent, TruncationPolicy,
	},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawCompletion,
		RawEvent, RequestHeader, RequestMethod, SizeBounds, ToolInputKind, UnvalidatedToolCall,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

const MAX_REQUEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FRAME_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// Native Ollama chat codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct OllamaCodec;

/// Typed Ollama request reasoning control.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OllamaThink<'a> {
	/// Disable reasoning.
	Disabled(bool),
	/// Select a named effort accepted by the endpoint.
	Effort(&'a str),
}

/// Typed Ollama runtime options.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct OllamaOptions {
	/// Maximum generated tokens.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub num_predict: Option<u64>,
	/// Sampling temperature.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub temperature: Option<f32>,
	/// Nucleus probability.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub top_p:       Option<f32>,
	/// Top-k candidate bound.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub top_k:       Option<u32>,
	/// Deterministic seed.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub seed:        Option<u64>,
	/// Stop sequences.
	#[serde(skip_serializing_if = "slice_is_empty")]
	pub stop:        Box<[Str]>,
}

const fn slice_is_empty<T>(value: &[T]) -> bool {
	value.is_empty()
}

#[derive(Serialize)]
struct OllamaChatRequest<'a> {
	model:       &'a str,
	messages:    Vec<OllamaRequestMessage<'a>>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	tools:       Vec<OllamaTool<'a>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	think:       Option<OllamaThink<'a>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_choice: Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	format:      Option<OllamaFormat<'a>>,
	#[serde(skip_serializing_if = "options_are_empty")]
	options:     OllamaOptions,
	stream:      bool,
}

fn options_are_empty(options: &OllamaOptions) -> bool {
	options.num_predict.is_none()
		&& options.temperature.is_none()
		&& options.top_p.is_none()
		&& options.top_k.is_none()
		&& options.seed.is_none()
		&& options.stop.is_empty()
}
#[derive(Serialize)]
#[serde(untagged)]
enum OllamaFormat<'a> {
	Json(&'static str),
	Schema(&'a Value),
}

#[derive(Serialize)]
struct OllamaRequestMessage<'a> {
	role:       &'static str,
	content:    String,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	images:     Vec<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	thinking:   Option<String>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	tool_calls: Vec<OllamaRequestToolCall<'a>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_name:  Option<&'a str>,
}

#[derive(Serialize)]
struct OllamaRequestToolCall<'a> {
	#[serde(rename = "type")]
	kind:     &'static str,
	function: OllamaRequestFunction<'a>,
}

#[derive(Serialize)]
struct OllamaRequestFunction<'a> {
	name:      &'a str,
	arguments: &'a Value,
}

#[derive(Serialize)]
struct OllamaTool<'a> {
	#[serde(rename = "type")]
	kind:     &'static str,
	function: OllamaToolFunction<'a>,
}

#[derive(Serialize)]
struct OllamaToolFunction<'a> {
	name:        &'a str,
	#[serde(skip_serializing_if = "Option::is_none")]
	description: Option<&'a str>,
	parameters:  &'a Value,
}

/// One typed Ollama NDJSON response record.
#[derive(Clone, Debug, Deserialize)]
pub struct OllamaChunk {
	/// Assistant delta, if this record carries output.
	#[serde(default)]
	pub message:           Option<OllamaResponseMessage>,
	/// Terminal-record marker.
	#[serde(default)]
	pub done:              bool,
	/// Provider terminal reason.
	#[serde(default)]
	pub done_reason:       Option<Str>,
	/// Prompt token count.
	#[serde(default)]
	pub prompt_eval_count: Option<u64>,
	/// Generated token count.
	#[serde(default)]
	pub eval_count:        Option<u64>,
	/// Typed provider error payload.
	#[serde(default)]
	pub error:             Option<Str>,
}

/// Typed assistant delta in an Ollama response record.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct OllamaResponseMessage {
	/// Wire role, normally `assistant`.
	#[serde(default)]
	pub role:       Option<Str>,
	/// Visible text delta.
	#[serde(default)]
	pub content:    Str,
	/// Reasoning delta.
	#[serde(default)]
	pub thinking:   Str,
	/// Complete tool calls emitted in this record.
	#[serde(default)]
	pub tool_calls: Vec<OllamaResponseToolCall>,
}

/// Typed Ollama response tool call.
#[derive(Clone, Debug, Deserialize)]
pub struct OllamaResponseToolCall {
	/// Wire discriminator.
	#[serde(rename = "type", default)]
	pub kind:     Option<Str>,
	/// Function payload; absence is a protocol error.
	#[serde(default)]
	pub function: Option<OllamaResponseFunction>,
}

/// Typed Ollama response function payload.
#[derive(Clone, Debug, Deserialize)]
pub struct OllamaResponseFunction {
	/// Optional provider-local call index.
	#[serde(default)]
	pub index:     Option<u32>,
	/// Function name; an empty value is invalid.
	#[serde(default)]
	pub name:      Str,
	/// Intrinsically opaque JSON arguments.
	#[serde(default)]
	pub arguments: Option<Box<RawValue>>,
}

/// Typed response from Ollama's `/api/tags` discovery endpoint.
#[derive(Clone, Debug, Deserialize)]
pub struct OllamaTagsResponse {
	/// Discovered model rows.
	#[serde(default)]
	pub models: Vec<OllamaModel>,
}

/// One typed model row returned by Ollama discovery.
#[derive(Clone, Debug, Deserialize)]
pub struct OllamaModel {
	/// Display and fallback wire name.
	pub name:    Str,
	/// Preferred wire model identifier.
	#[serde(default)]
	pub model:   Option<Str>,
	/// Optional structural details.
	#[serde(default)]
	pub details: Option<OllamaModelDetails>,
}

/// Typed structural details for one discovered Ollama model.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct OllamaModelDetails {
	/// Provider-reported model family.
	#[serde(default)]
	pub family:             Option<Str>,
	/// Additional provider-reported families.
	#[serde(default)]
	pub families:           Vec<Str>,
	/// Provider-reported parameter-size label.
	#[serde(default)]
	pub parameter_size:     Option<Str>,
	/// Provider-reported quantization label.
	#[serde(default)]
	pub quantization_level: Option<Str>,
}

/// Decodes a complete, bounded Ollama discovery body without network access.
#[derive(Serialize)]
struct OllamaEmbedRequest<'a> {
	model:      &'a str,
	input:      Vec<OllamaEmbedInput<'a>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	dimensions: Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	truncate:   Option<bool>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum OllamaEmbedInput<'a> {
	Text(&'a str),
	Tokens(&'a [u32]),
}

#[derive(Deserialize)]
struct OllamaEmbedResponse {
	embeddings:        Vec<Vec<f32>>,
	#[serde(default)]
	prompt_eval_count: Option<u64>,
}
/// Decodes a complete, bounded Ollama discovery body without network access.
pub fn decode_tags(bytes: &[u8]) -> Result<OllamaTagsResponse, Error> {
	serde_json::from_slice(bytes)
		.map_err(|_| protocol_error("ollama_tags_invalid_json", ErrorPhase::Discovery))
}

impl Codec for OllamaCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		match operation {
			OperationCall::Chat(request) => encode_chat(context, request),
			OperationCall::Embed(request) => encode_embed(context, request),
			OperationCall::DiscoverModels(_) => Ok(EncodedRequest {
				operation:   OperationKind::DiscoverModels,
				method:      RequestMethod::Get,
				uri:         join_uri(context.route.endpoint.base_url.as_str(), "/api/tags"),
				headers:     Box::new([]),
				body:        BodySource::Bytes(Bytes::new()),
				framing:     FramingProtocol::Raw,
				bounds:      SizeBounds {
					request_body: 0,
					frame:        MAX_RESPONSE_BYTES,
					response:     MAX_RESPONSE_BYTES,
				},
				sealed_body: None,
				adjustments: Vec::new(),
			}),
			_ => Err(capability_error("ollama_operation_not_supported")),
		}
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		Ok(Box::new(OllamaDecoder::new(context)))
	}
}

fn encode_embed(
	context: &EncodeContext<'_>,
	request: &EmbedRequest,
) -> Result<EncodedRequest, Error> {
	let target = context
		.target
		.ok_or_else(|| invalid_request("ollama_wire_target_missing"))?;
	if !matches!(request.normalize, Setting::Unset) {
		return Err(capability_error("ollama_embed_normalize_unsupported"));
	}
	let dimensions = match request.dimensions {
		Setting::Unset => None,
		Setting::Require(value) | Setting::Prefer(value) => Some(value),
	};
	let input = request
		.inputs
		.iter()
		.map(|input| match input {
			EmbeddingInput::Text(text) => OllamaEmbedInput::Text(text.as_str()),
			EmbeddingInput::Tokens(tokens) => OllamaEmbedInput::Tokens(tokens),
		})
		.collect();
	let truncate = match request.truncation {
		TruncationPolicy::Reject => Some(false),
		TruncationPolicy::End => Some(true),
		TruncationPolicy::Start => {
			return Err(capability_error("ollama_embed_start_truncation_unsupported"));
		},
	};
	let wire = OllamaEmbedRequest { model: target.wire_model.as_str(), input, dimensions, truncate };
	let body = serde_json::to_vec(&wire)
		.map(Bytes::from)
		.map_err(|_| protocol_error("ollama_embed_request_serialization", ErrorPhase::Encoding))?;
	if body.len() as u64 > MAX_REQUEST_BYTES {
		return Err(invalid_request("ollama_request_body_too_large"));
	}
	Ok(EncodedRequest::new(
		OperationKind::Embed,
		RequestMethod::Post,
		join_uri(context.route.endpoint.base_url.as_str(), "/api/embed"),
		vec![RequestHeader { name: sf!("content-type"), value: sf!("application/json") }]
			.into_boxed_slice(),
		BodySource::Bytes(body),
		FramingProtocol::Raw,
		SizeBounds {
			request_body: MAX_REQUEST_BYTES,
			frame:        MAX_RESPONSE_BYTES,
			response:     MAX_RESPONSE_BYTES,
		},
	))
}
fn encode_chat(
	context: &EncodeContext<'_>,
	request: &ChatRequest,
) -> Result<EncodedRequest, Error> {
	if !request.hosted_tools.is_empty() {
		return Err(capability_error("ollama_hosted_tools_unsupported"));
	}
	let format = match &request.output {
		Setting::Unset => None,
		Setting::Require(StructuredOutput::JsonObject)
		| Setting::Prefer(StructuredOutput::JsonObject) => Some(OllamaFormat::Json("json")),
		Setting::Require(StructuredOutput::JsonSchema { schema, .. })
		| Setting::Prefer(StructuredOutput::JsonSchema { schema, .. }) => {
			Some(OllamaFormat::Schema(schema.as_value()))
		},
		Setting::Require(_) | Setting::Prefer(_) => {
			return Err(capability_error("ollama_output_grammar_unsupported"));
		},
	};
	if !matches!(request.verbosity, Setting::Unset) {
		return Err(capability_error("ollama_verbosity_unsupported"));
	}
	if !matches!(request.cache_retention, Setting::Unset) {
		return Err(capability_error("ollama_cache_retention_unsupported"));
	}
	if !matches!(request.service_tier, Setting::Unset) {
		return Err(capability_error("ollama_service_tier_unsupported"));
	}
	if request.top_logprobs.is_some() {
		return Err(capability_error("ollama_logprobs_unsupported"));
	}
	if !request.safety.is_empty() {
		return Err(capability_error("ollama_safety_settings_unsupported"));
	}
	if request.sampling.presence_penalty.is_some() || request.sampling.frequency_penalty.is_some() {
		return Err(capability_error("ollama_penalties_unsupported"));
	}
	let target = context
		.target
		.ok_or_else(|| invalid_request("ollama_wire_target_missing"))?;
	if context.policy.structured.sampling_params == Some(false)
		&& (request.sampling.temperature.is_some() || request.sampling.top_p.is_some())
	{
		return Err(capability_error("ollama_sampling_unsupported_by_policy"));
	}

	let named_tool = match &request.tool_choice {
		Setting::Require(ToolChoice::Named(name)) | Setting::Prefer(ToolChoice::Named(name)) => {
			Some(name.as_str())
		},
		_ => None,
	};
	let tools = request
		.tools
		.iter()
		.filter(|tool| named_tool.is_none_or(|name| tool.name.as_str() == name))
		.map(|tool| {
			if tool.input.grammar().is_some() {
				return Err(capability_error("ollama_tool_grammar_unsupported"));
			}
			let (parameters, strict) = tool.input.wire_schema();
			if strict {
				return Err(capability_error("ollama_strict_tool_schema_unsupported"));
			}
			Ok(OllamaTool {
				kind:     "function",
				function: OllamaToolFunction {
					name:        tool.name.as_str(),
					description: tool.description.as_ref().map(Str::as_str),
					parameters:  parameters.as_value(),
				},
			})
		})
		.collect::<Result<Vec<_>, Error>>()?;
	if named_tool.is_some() && tools.is_empty() {
		return Err(invalid_request("ollama_named_tool_missing"));
	}

	let messages = request
		.messages
		.iter()
		.map(|message| encode_message(context, message))
		.collect::<Result<Vec<_>, _>>()?;
	let think = encode_think(context, &request.reasoning)?;
	let tool_choice = match &request.tool_choice {
		Setting::Unset | Setting::Require(ToolChoice::Auto) | Setting::Prefer(ToolChoice::Auto) => {
			None
		},
		Setting::Require(ToolChoice::Disabled) | Setting::Prefer(ToolChoice::Disabled) => {
			Some("none")
		},
		Setting::Require(ToolChoice::Required | ToolChoice::Named(_))
		| Setting::Prefer(ToolChoice::Required | ToolChoice::Named(_)) => Some("required"),
	};
	let options = OllamaOptions {
		num_predict: request.max_output_tokens,
		temperature: request
			.sampling
			.temperature
			.filter(|_| context.policy.structured.sampling_params != Some(false)),
		top_p:       request
			.sampling
			.top_p
			.filter(|_| context.policy.structured.sampling_params != Some(false)),
		top_k:       request.sampling.top_k,
		seed:        request.sampling.seed,
		stop:        request.sampling.stop.iter().cloned().collect(),
	};
	let wire = OllamaChatRequest {
		model: target.wire_model.as_str(),
		messages,
		tools,
		think,
		tool_choice,
		format,
		options,
		stream: true,
	};
	let body = serde_json::to_vec(&wire)
		.map(Bytes::from)
		.map_err(|_| protocol_error("ollama_request_serialization", ErrorPhase::Encoding))?;
	if body.len() as u64 > MAX_REQUEST_BYTES {
		return Err(invalid_request("ollama_request_body_too_large"));
	}
	Ok(EncodedRequest {
		operation:   OperationKind::Chat,
		method:      RequestMethod::Post,
		uri:         join_uri(context.route.endpoint.base_url.as_str(), "/api/chat"),
		headers:     vec![RequestHeader {
			name:  sf!("content-type"),
			value: sf!("application/json"),
		}]
		.into_boxed_slice(),
		body:        BodySource::Bytes(body),
		framing:     FramingProtocol::Ndjson,
		bounds:      SizeBounds {
			request_body: MAX_REQUEST_BYTES,
			frame:        MAX_FRAME_BYTES,
			response:     MAX_RESPONSE_BYTES,
		},
		sealed_body: None,
		adjustments: Vec::new(),
	})
}

fn encode_think<'a>(
	context: &'a EncodeContext<'_>,
	setting: &Setting<ReasoningRequest>,
) -> Result<Option<OllamaThink<'a>>, Error> {
	if matches!(setting, Setting::Unset) {
		return Ok(None);
	}
	let selection = context
		.thinking_selection
		.ok_or_else(|| capability_error("ollama_thinking_selection_missing"))?;
	if selection.suppress_when_off {
		return Ok(None);
	}
	if selection.effort == ThinkingEffort::Off {
		return Ok(Some(OllamaThink::Disabled(false)));
	}
	let default = match selection.effort {
		ThinkingEffort::Off => "off",
		ThinkingEffort::Minimal => "minimal",
		ThinkingEffort::Low => "low",
		ThinkingEffort::Medium => "medium",
		ThinkingEffort::High => "high",
		ThinkingEffort::XHigh => "xhigh",
		ThinkingEffort::Max => "max",
	};
	let wire = selection
		.native_effort
		.as_ref()
		.map_or(default, Str::as_str);
	Ok(Some(OllamaThink::Effort(wire)))
}

fn encode_message<'a>(
	context: &EncodeContext<'_>,
	message: &'a Message,
) -> Result<OllamaRequestMessage<'a>, Error> {
	if message.name.is_some() && message.role != Role::Tool {
		return Err(capability_error("ollama_message_name_unsupported"));
	}
	let role = match message.role {
		Role::System => "system",
		Role::User => "user",
		Role::Assistant => "assistant",
		Role::Tool => "tool",
		Role::Developer => "system",
	};
	let mut content = String::new();
	let mut thinking = String::new();
	let mut images = Vec::new();
	let mut tool_calls = Vec::new();
	let mut tool_name = message.name.as_ref().map(Str::as_str);
	for part in message.content.iter() {
		match part {
			ContentPart::Text { text, proof } => {
				reject_proof(context, proof.as_ref())?;
				content.push_str(text.as_str());
			},
			ContentPart::Reasoning { text, proof } => {
				reject_proof(context, proof.as_ref())?;
				if message.role != Role::Assistant {
					return Err(invalid_request("ollama_reasoning_role_invalid"));
				}
				thinking.push_str(text.as_str());
			},
			ContentPart::Image(MediaInput::Bytes { data, .. }) => {
				images.push(base64::encode(data).into_string());
			},
			ContentPart::Image(_) => {
				return Err(capability_error("ollama_image_source_requires_staging"));
			},
			ContentPart::Audio(_) | ContentPart::Document(_) => {
				return Err(capability_error("ollama_media_type_unsupported"));
			},
			ContentPart::ToolCall { name, arguments, proof, .. } => {
				reject_proof(context, proof.as_ref())?;
				if message.role != Role::Assistant {
					return Err(invalid_request("ollama_tool_call_role_invalid"));
				}
				tool_calls.push(OllamaRequestToolCall {
					kind:     "function",
					function: OllamaRequestFunction {
						name:      name.as_str(),
						arguments: arguments.as_value(),
					},
				});
			},
			ContentPart::ToolResult { name, content: result, .. } => {
				if message.role != Role::Tool || message.content.len() != 1 || result.len() != 1 {
					return Err(capability_error("ollama_tool_result_shape_unsupported"));
				}
				tool_name = name.as_ref().map(Str::as_str).or(tool_name);
				match &result[0] {
					ToolResultContent::Text(text) => content.push_str(text.as_str()),
					ToolResultContent::Json(json) => {
						content.push_str(&serde_json::to_string(json.as_value()).map_err(|_| {
							protocol_error("ollama_tool_result_serialization", ErrorPhase::Encoding)
						})?);
					},
					ToolResultContent::Image(_) | ToolResultContent::Document(_) => {
						return Err(capability_error("ollama_tool_result_media_unsupported"));
					},
				}
			},
			ContentPart::CachePoint(_) => {
				return Err(capability_error("ollama_cache_point_unsupported"));
			},
		}
	}
	Ok(OllamaRequestMessage {
		role,
		content,
		images,
		thinking: (!thinking.is_empty()).then_some(thinking),
		tool_calls,
		tool_name,
	})
}

fn reject_proof(context: &EncodeContext<'_>, proof: Option<&ProviderProof>) -> Result<(), Error> {
	if let Some(proof) = proof {
		let target = context
			.target
			.ok_or_else(|| invalid_request("ollama_wire_target_missing"))?;
		if proof.provider != context.route.provider || proof.codec != target.codec {
			return Err(invalid_request("ollama_provider_proof_scope_mismatch"));
		}
		return Err(capability_error("ollama_provider_proof_unsupported"));
	}
	Ok(())
}

fn join_uri(base: &str, path: &str) -> Str {
	let base = base.trim_end_matches('/');
	let base = base.strip_suffix("/api").unwrap_or(base);
	sf!("{base}{path}")
}

struct OllamaDecoder {
	request_id: Str,
	provider:   ProviderId,
	route:      RouteId,
	operation:  OperationKind,
	open:       Option<(u32, BlockKind)>,
	next_index: u32,
	blocks:     u32,
	completed:  bool,
	has_tools:  bool,
	usage:      Usage,
}

impl OllamaDecoder {
	fn new(context: &DecodeContext<'_>) -> Self {
		Self {
			request_id: Str::new(context.request_id.as_str()),
			provider:   context.provider.clone(),
			route:      context.route.clone(),
			operation:  context.operation,
			open:       None,
			next_index: 0,
			blocks:     0,
			completed:  false,
			has_tools:  false,
			usage:      Usage::default(),
		}
	}

	fn push_chunk(&mut self, bytes: &[u8], emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.completed || bytes.is_empty() {
			return Ok(());
		}
		let chunk: OllamaChunk = serde_json::from_slice(bytes)
			.map_err(|_| protocol_error("ollama_ndjson_invalid_json", ErrorPhase::Streaming))?;
		if chunk.error.is_some() {
			self.completed = true;
			emit(RawEvent::Failure(provider_error("ollama_upstream_error")));
			return Ok(());
		}
		if let Some(message) = chunk.message {
			if !message.thinking.is_empty() {
				self.append(BlockKind::Thinking, message.thinking, emit);
			}
			if !message.content.is_empty() {
				self.append(BlockKind::Text, message.content, emit);
			}
			for call in message.tool_calls {
				self.tool_call(call, emit)?;
			}
		}
		if chunk.done {
			self.completed = true;
			if chunk
				.done_reason
				.as_ref()
				.is_some_and(|reason| reason.as_str() == "load")
			{
				emit(RawEvent::Failure(provider_error("ollama_load_without_generation")));
				return Ok(());
			}
			self.usage = Usage {
				input_tokens: chunk.prompt_eval_count.unwrap_or(0),
				output_tokens: chunk.eval_count.unwrap_or(0),
				source: UsageSource::Provider,
				..Usage::default()
			};
			emit(RawEvent::Chat(ChatEvent::Usage(UsageUpdate {
				usage:        self.usage,
				final_update: true,
			})));
			let reason = if self.has_tools {
				FinishReason::ToolCalls
			} else {
				match chunk.done_reason.as_ref().map(Str::as_str) {
					Some("length") => FinishReason::Length,
					Some("tool_calls") => FinishReason::ToolCalls,
					Some("stop") | None => FinishReason::Stop,
					Some(other) => FinishReason::Other(Str::new(other)),
				}
			};
			emit(RawEvent::Completion(RawCompletion {
				reason,
				blocks: self.blocks,
				usage: self.usage,
			}));
		}
		Ok(())
	}

	fn append(&mut self, kind: BlockKind, text: Str, emit: &mut dyn FnMut(RawEvent)) {
		let index = match self.open {
			Some((index, open_kind)) if open_kind == kind => index,
			_ => {
				let index = self.next_index;
				self.next_index += 1;
				self.blocks += 1;
				self.open = Some((index, kind));
				emit(RawEvent::Chat(ChatEvent::BlockStarted { index, kind }));
				index
			},
		};
		let event = match kind {
			BlockKind::Thinking => ChatEvent::ThinkingDelta { index, text },
			_ => ChatEvent::TextDelta { index, text },
		};
		emit(RawEvent::Chat(event));
	}

	fn tool_call(
		&mut self,
		call: OllamaResponseToolCall,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		self.open = None;
		let function = call.function.ok_or_else(|| {
			protocol_error("ollama_tool_call_missing_function", ErrorPhase::Streaming)
		})?;
		if function.name.is_empty() {
			return Err(protocol_error("ollama_tool_call_missing_name", ErrorPhase::Streaming));
		}
		let index = self.next_index;
		self.next_index += 1;
		self.blocks += 1;
		self.has_tools = true;
		let id = ToolCallId::new(format!("ollama-{}-{index}", self.request_id));
		let arguments = match function.arguments {
			Some(raw) if raw.get().starts_with('"') => {
				let text: Str = serde_json::from_str(raw.get()).map_err(|_| {
					protocol_error("ollama_tool_arguments_invalid_string", ErrorPhase::Streaming)
				})?;
				Bytes::copy_from_slice(text.as_bytes())
			},
			Some(raw) => Bytes::copy_from_slice(raw.get().as_bytes()),
			None => Bytes::from_static(b"{}"),
		};
		emit(RawEvent::Chat(ChatEvent::ToolCallStarted {
			index,
			id: id.clone(),
			name: function.name.clone(),
		}));
		emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta { index, bytes: arguments.clone() }));
		emit(RawEvent::ToolCallComplete {
			index,
			call: UnvalidatedToolCall {
				id,
				name: function.name,
				input_kind: ToolInputKind::Json,
				arguments,
			},
		});
		Ok(())
	}
}
impl Decoder for OllamaDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		match frame {
			Frame::Ndjson(bytes) if self.operation == OperationKind::Chat => {
				self.push_chunk(&bytes, emit)
			},
			Frame::Raw(bytes) if self.operation == OperationKind::Embed => {
				let response: OllamaEmbedResponse = serde_json::from_slice(&bytes)
					.map_err(|_| protocol_error("ollama_embed_invalid_json", ErrorPhase::Streaming))?;
				let dimensions = response
					.embeddings
					.first()
					.map_or(0, |values| values.len() as u32);
				if response
					.embeddings
					.iter()
					.any(|values| values.len() as u32 != dimensions)
				{
					return Err(protocol_error(
						"ollama_embed_dimension_mismatch",
						ErrorPhase::Streaming,
					));
				}
				let embeddings = response
					.embeddings
					.into_iter()
					.enumerate()
					.map(|(index, values)| Embedding { index: index as u32, values })
					.collect();
				self.completed = true;
				emit(RawEvent::Answer(AnswerBody::Embeddings(EmbeddingBatch {
					dimensions,
					embeddings,
					usage: Usage {
						input_tokens: response.prompt_eval_count.unwrap_or(0),
						source: UsageSource::Provider,
						..Usage::default()
					},
				})));
				Ok(())
			},
			Frame::Raw(bytes) if self.operation == OperationKind::DiscoverModels => {
				let tags = decode_tags(&bytes)?;
				let rows = tags
					.models
					.into_iter()
					.map(|model| {
						let wire_model = model.model.unwrap_or_else(|| model.name.clone());
						DiscoveredModel {
							provider:              self.provider.clone(),
							route:                 self.route.clone(),
							wire_model:            WireModelId::new(wire_model),
							aliases:               Box::new([]),
							display_name:          Some(model.name),
							extended_context_mode: None,
							declared_class:        model
								.details
								.and_then(|details| details.family)
								.map(ClassId::new),
							declared_operations:   OperationBits::empty(),
							declared_capabilities: None,
							declared_limits:       None,
							declared_pricing:      Box::new([]),
							availability:          None,
							source:                sf!("ollama:/api/tags"),
							observed_at_ms:        None,
							updated_at_ms:         None,
							deprecated:            None,
						}
					})
					.collect();
				self.completed = true;
				emit(RawEvent::DiscoveredModels { rows, next_cursor: None });
				Ok(())
			},
			_ => Err(protocol_error("ollama_unexpected_frame", ErrorPhase::Streaming)),
		}
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if !self.completed && self.operation == OperationKind::Chat {
			self.completed = true;
			emit(RawEvent::Failure(provider_error("ollama_stream_ended_before_done")));
		}
		Ok(())
	}
}

fn invalid_request(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn capability_error(reason: &'static str) -> Error {
	let mut error = invalid_request(reason);
	error.kind = ErrorKind::CapabilityMismatch;
	error
}

fn protocol_error(reason: &'static str, phase: ErrorPhase) -> Error {
	Error::new(ErrorKind::Protocol, phase, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn provider_error(code: &'static str) -> Error {
	Error::new(
		ErrorKind::Protocol,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(Str::new(code))
	.detail(ErrorDetail::protocol(ReasonId(Str::new(code))))
}

#[cfg(test)]
mod tests {
	use super::*;
	fn decoder() -> OllamaDecoder {
		OllamaDecoder {
			request_id: sf!("fixture"),
			provider:   ProviderId::new("ollama-cloud"),
			route:      RouteId::new("ollama-cloud"),
			operation:  OperationKind::Chat,
			open:       None,
			next_index: 0,
			blocks:     0,
			completed:  false,
			has_tools:  false,
			usage:      Usage::default(),
		}
	}

	#[test]
	fn cloud_stream_decodes_incrementally_and_completes_once() {
		let mut decoder = decoder();
		let mut events = Vec::new();
		for line in include_bytes!(
			"../../../../fixtures/llm-oracle/agent-protocols/ollama/cloud_stream.ndjson"
		)
		.split(|byte| *byte == b'\n')
		.filter(|line| !line.is_empty())
		{
			decoder
				.push_chunk(line, &mut |event| events.push(event))
				.expect("fixture record");
		}
		assert_eq!(
			events
				.iter()
				.filter(|event| matches!(event, RawEvent::Completion(_)))
				.count(),
			1
		);
		assert!(events.iter().any(|event| matches!(event, RawEvent::ToolCallComplete { call, .. } if call.name.as_str() == "weather" && call.arguments.as_ref() == br#"{"city":"Paris"}"#)));
		assert!(events.iter().any(|event| matches!(event, RawEvent::Completion(RawCompletion { reason: FinishReason::ToolCalls, usage, .. }) if usage.input_tokens == 21 && usage.output_tokens == 8)));
	}

	#[test]
	fn terminal_and_error_records_are_terminal() {
		let mut decoder = decoder();
		let mut events = Vec::new();
		decoder.push_chunk(br#"{"message":{"content":""},"done":true,"done_reason":"length","prompt_eval_count":2,"eval_count":4}"#, &mut |event| events.push(event)).expect("terminal record");
		decoder
			.push_chunk(br#"{"error":"must be ignored"}"#, &mut |event| events.push(event))
			.expect("post terminal record");
		assert_eq!(
			events
				.iter()
				.filter(|event| matches!(event, RawEvent::Completion(_) | RawEvent::Failure(_)))
				.count(),
			1
		);
	}

	#[test]
	fn malformed_and_incomplete_streams_fail_typed() {
		let mut decoder = decoder();
		assert!(decoder.push_chunk(b"{not-json", &mut |_| {}).is_err());
		let mut events = Vec::new();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("finish emits failure");
		assert!(
			matches!(events.as_slice(), [RawEvent::Failure(error)] if error.code.as_ref().is_some_and(|code| code.as_str() == "ollama_stream_ended_before_done"))
		);
	}

	#[test]
	fn discovery_shape_is_typed() {
		let fixture = include_bytes!(
			"../../../../fixtures/llm-oracle/agent-protocols/ollama/auth_discovery.json"
		);
		#[derive(Deserialize)]
		struct Fixture {
			response: OllamaTagsResponse,
		}
		let parsed: Fixture = serde_json::from_slice(fixture).expect("typed discovery fixture");
		assert_eq!(parsed.response.models[0].model.as_ref().map(Str::as_str), Some("qwen3:8b"));
		assert_eq!(
			parsed.response.models[0]
				.details
				.as_ref()
				.and_then(|detail| detail.family.as_ref())
				.map(Str::as_str),
			Some("qwen3")
		);
	}
}
