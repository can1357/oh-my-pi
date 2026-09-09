//! Devin Cascade protobuf request lowering, discovery, and stream decoding.

use std::{
	collections::BTreeMap,
	fmt,
	io::{Read as _, Write as _},
	str,
};

use bytes::Bytes;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use omp_core::{IntoStr, Str, encoding::base64, sf};
use prost::Message as _;
use prost_types::FileDescriptorSet;

use crate::{
	auth::CredentialApplyError,
	body::BodySource,
	call::{
		ChatRequest, ContentPart, MediaInput, Message, OperationCall, Role, Setting, ToolChoice,
		ToolResultContent,
	},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawCompletion,
		RawEvent, RequestHeader, RequestMethod, SealedBodyTemplate, SizeBounds, ToolInputKind,
		UnvalidatedToolCall, connect::parse_connect_end_stream,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{ConnectEnvelopeKind, Frame, FramingProtocol},
};

/// Encoded descriptor set for the verified Devin transitive schema closure.
pub static FILE_DESCRIPTOR_SET: &[u8] =
	include_bytes!(concat!(env!("OUT_DIR"), "/devin-descriptor.bin"));

/// Decodes the descriptor set used to generate the Devin bindings.
pub fn descriptor_set() -> Result<FileDescriptorSet, prost::DecodeError> {
	FileDescriptorSet::decode(FILE_DESCRIPTOR_SET)
}

const CHAT_PATH: &str = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DISCOVERY_PATH: &str = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEFAULT_STOP_PATTERNS: [&str; 5] =
	["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];
const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;
const DEFAULT_MAX_OUTPUT: u64 = 64_000;
const MAX_CONNECT_FRAME_BYTES: u64 = 16 * 1024 * 1024;

const SESSION_TOKEN_PREFIX: &str = "devin-session-token$";

pub(crate) enum DevinSealedBody {
	Chat(Bytes),
	Discovery(Bytes),
}

impl DevinSealedBody {
	pub(crate) fn bind(self, secret: &str) -> Result<Bytes, CredentialApplyError> {
		let token = secret.trim_start_matches(SESSION_TOKEN_PREFIX);
		if token.is_empty() {
			return Err(CredentialApplyError::InvalidSealedBody);
		}
		let api_key = format!("{SESSION_TOKEN_PREFIX}{token}");
		match self {
			Self::Chat(bytes) => {
				let mut request = GetChatMessageRequest::decode(bytes)
					.map_err(|_| CredentialApplyError::InvalidSealedBody)?;
				let metadata = request.metadata.get_or_insert_with(Metadata::default);
				metadata.api_key = api_key;
				metadata.user_jwt.clear();
				metadata.user_jwt.push_str(token);
				connect_gzip_message(&request.encode_to_vec())
					.map_err(|_| CredentialApplyError::InvalidSealedBody)
			},
			Self::Discovery(bytes) => {
				let mut request = GetCliModelConfigsRequest::decode(bytes)
					.map_err(|_| CredentialApplyError::InvalidSealedBody)?;
				request
					.metadata
					.get_or_insert_with(Metadata::default)
					.api_key = api_key;
				Ok(Bytes::from(request.encode_to_vec()))
			},
		}
	}
}

impl fmt::Debug for DevinSealedBody {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let kind = match self {
			Self::Chat(_) => "chat",
			Self::Discovery(_) => "discovery",
		};
		formatter
			.debug_struct("DevinSealedBody")
			.field("kind", &kind)
			.field("body", &"[REDACTED]")
			.finish()
	}
}
mod wire {
	#![allow(
		missing_docs,
		dead_code,
		clippy::pedantic,
		clippy::nursery,
		reason = "prost output is machine-generated and cannot follow handwritten documentation and \
		          style conventions"
	)]
	#![allow(
		clippy::allow_attributes_without_reason,
		reason = "prost emits compatibility allow attributes without Rust reason metadata"
	)]
	#![allow(
		clippy::large_enum_variant,
		reason = "prost maps protobuf oneofs directly to enums; boxing would change the generated \
		          Rust API"
	)]
	#![allow(
		clippy::enum_variant_names,
		reason = "prost maps protobuf enum variant names directly without stripping shared prefixes \
		          or suffixes"
	)]
	pub mod exa {
		pub mod analytics_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.analytics_pb.rs"));
		}
		pub mod api_server_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.api_server_pb.rs"));
		}
		pub mod auth_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.auth_pb.rs"));
		}
		pub mod auto_cascade_common_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.auto_cascade_common_pb.rs"));
		}
		pub mod bug_checker_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.bug_checker_pb.rs"));
		}
		pub mod cascade_plugins_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.cascade_plugins_pb.rs"));
		}
		pub mod chat_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.chat_pb.rs"));
		}
		pub mod code_edit {
			pub mod code_edit_pb {
				include!(concat!(env!("OUT_DIR"), "/exa.code_edit.code_edit_pb.rs"));
			}
		}
		pub mod codeium_common_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.codeium_common_pb.rs"));
		}
		pub mod context_module_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.context_module_pb.rs"));
		}
		pub mod cortex_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.cortex_pb.rs"));
		}
		pub mod diff_action_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.diff_action_pb.rs"));
		}
		pub mod index_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.index_pb.rs"));
		}
		pub mod knowledge_base_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.knowledge_base_pb.rs"));
		}
		pub mod language_server_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.language_server_pb.rs"));
		}
		pub mod opensearch_clients_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.opensearch_clients_pb.rs"));
		}
		pub mod prompt_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.prompt_pb.rs"));
		}
		pub mod reactive_component_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.reactive_component_pb.rs"));
		}
		pub mod trust_pb {
			include!(concat!(env!("OUT_DIR"), "/exa.trust_pb.rs"));
		}
	}
}

use wire::exa::{
	api_server_pb::{
		ChatMessageRequestType, GetChatMessageRequest, GetChatMessageResponse,
		GetCliModelConfigsRequest, GetCliModelConfigsResponse,
	},
	chat_pb::{
		CacheControlType, ChatMessagePrompt, ChatToolChoice, ChatToolDefinition, PromptCacheOptions,
		chat_tool_choice,
	},
	codeium_common_pb::{
		ChatMessageSource, ChatToolCall, CompletionConfiguration, ConversationalPlannerMode,
		ImageData, Metadata, StopReason,
	},
};

use crate::{call::ProviderProof, codec::ProviderStateEvent};

/// Non-secret identity fields sent by official Devin clients.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DevinClientMetadata {
	/// IDE product name.
	pub ide_name:          Str,
	/// IDE product version.
	pub ide_version:       Str,
	/// Extension product name.
	pub extension_name:    Str,
	/// Extension product version.
	pub extension_version: Str,
	/// Client locale.
	pub locale:            Str,
}

impl Default for DevinClientMetadata {
	fn default() -> Self {
		Self {
			ide_name:          sf!("windsurf"),
			ide_version:       sf!("3.2.23"),
			extension_name:    sf!("windsurf"),
			extension_version: sf!("1.48.2"),
			locale:            sf!("en"),
		}
	}
}

/// Typed non-secret identifiers for one Cascade turn and its retry lineage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CascadeSession {
	/// Stable conversation-side Cascade identity.
	pub cascade_id:        Str,
	/// Stable logical execution identity shared by transport reconnect attempts.
	pub execution_id:      Str,
	/// Zero-based reconnect attempt.
	pub reconnect_attempt: u32,
}

impl CascadeSession {
	/// Creates the first wire attempt for a logical Cascade turn.
	pub fn new(cascade_id: impl IntoStr, execution_id: impl IntoStr) -> Self {
		Self {
			cascade_id:        cascade_id.into_str(),
			execution_id:      execution_id.into_str(),
			reconnect_attempt: 0,
		}
	}

	/// Returns the typed reconnect state without changing logical identities.
	pub fn reconnect(&self) -> Self {
		Self { reconnect_attempt: self.reconnect_attempt.saturating_add(1), ..self.clone() }
	}
}

/// Evidence used to classify opaque Connect errors without inspecting model
/// names.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CascadeRequestEvidence {
	/// The request contained a cumulatively large read/tool result.
	pub cumulative_large_read_output: bool,
	/// Conservative encoded character estimate.
	pub estimated_chars:              u64,
}

/// Non-secret Devin model metadata decoded from `GetCliModelConfigs`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DevinDiscoveredModel {
	/// Provider-local model uid.
	pub id:                Str,
	/// Devin display label.
	pub name:              Str,
	/// Class derived from the schema-provided `model_family_uid`, when present.
	pub declared_class:    Option<Str>,
	/// Whether image input is supported.
	pub supports_images:   bool,
	/// Whether schema features advertise thinking.
	pub reasoning:         bool,
	/// Advertised or conservative context window.
	pub context_window:    u64,
	/// Advertised or conservative output limit.
	pub max_output_tokens: u64,
}

/// Stateless Devin Cascade codec.
#[derive(Clone, Debug, Default)]
pub struct DevinCodec {
	metadata: DevinClientMetadata,
}

impl DevinCodec {
	/// Constructs a codec with verified official client metadata.
	pub fn new() -> Self {
		Self::default()
	}

	/// Constructs a codec with route-approved non-secret client identity fields.
	pub const fn with_metadata(metadata: DevinClientMetadata) -> Self {
		Self { metadata }
	}

	/// Encodes a credential-free discovery request template.
	pub fn discovery_request(&self) -> Bytes {
		Bytes::from(
			GetCliModelConfigsRequest { metadata: Some(self.metadata_wire()) }.encode_to_vec(),
		)
	}

	#[cfg(test)]
	pub(crate) fn sealed_discovery_request(&self) -> SealedBodyTemplate {
		SealedBodyTemplate::Devin(DevinSealedBody::Discovery(self.discovery_request()))
	}

	/// Decodes and deterministically normalizes a Devin discovery payload.
	pub fn decode_discovery(payload: &[u8]) -> Result<Vec<DevinDiscoveredModel>, Error> {
		let response = GetCliModelConfigsResponse::decode(payload)
			.map_err(|_| protocol_error(ErrorPhase::Discovery, "devin.discovery.protobuf"))?;
		let mut models = BTreeMap::new();
		for config in response.client_model_configs {
			let id = config.model_uid.trim();
			if config.disabled || id.is_empty() {
				continue;
			}
			let features = config
				.model_info
				.as_ref()
				.and_then(|info| info.model_features.as_ref());
			let context_window = positive_i32(config.max_tokens).unwrap_or(DEFAULT_CONTEXT_WINDOW);
			let max_output_tokens = config
				.model_info
				.as_ref()
				.and_then(|info| positive_i32(info.max_output_tokens))
				.unwrap_or_else(|| context_window.min(DEFAULT_MAX_OUTPUT));
			let declared_class = config
				.model_info
				.as_ref()
				.map(|info| info.model_family_uid.trim())
				.filter(|class| !class.is_empty())
				.map(Str::new);
			let id = Str::new(id);
			let name = if config.label.trim().is_empty() {
				id.clone()
			} else {
				Str::new(config.label.trim())
			};
			models.insert(id.clone(), DevinDiscoveredModel {
				id,
				name,
				declared_class,
				supports_images: config.supports_images
					|| features.is_some_and(|feature| feature.supports_images),
				reasoning: features.is_some_and(|feature| feature.supports_thinking),
				context_window,
				max_output_tokens,
			});
		}
		Ok(models.into_values().collect())
	}

	fn metadata_wire(&self) -> Metadata {
		Metadata {
			ide_name: self.metadata.ide_name.to_string(),
			ide_version: self.metadata.ide_version.to_string(),
			extension_name: self.metadata.extension_name.to_string(),
			extension_version: self.metadata.extension_version.to_string(),
			locale: self.metadata.locale.to_string(),
			..Metadata::default()
		}
	}
}

impl Codec for DevinCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		match operation {
			OperationCall::Chat(request) => {
				let _ = wire_target(context)?;
				let mut session = CascadeSession::new(
					context.session.map_or_else(
						|| context.request_id.as_str(),
						|session| session.conversation.as_str(),
					),
					context
						.session
						.map_or_else(|| context.request_id.as_str(), |session| session.turn.as_str()),
				);
				session.reconnect_attempt = context.attempt.index();
				let request = self.encode_chat(context, request, &session)?;
				let uri = endpoint(&context.route.endpoint.base_url, CHAT_PATH);
				let template = Bytes::from(request.encode_to_vec());
				Ok(EncodedRequest {
					operation: omp_catalog::OperationKind::Chat,
					method: RequestMethod::Post,
					uri,
					headers: chat_headers(),
					body: BodySource::Bytes(connect_gzip_message(&template)?),
					framing: FramingProtocol::Connect,
					bounds: SizeBounds {
						request_body: 32 * 1024 * 1024,
						frame:        MAX_CONNECT_FRAME_BYTES,
						response:     256 * 1024 * 1024,
					},
					sealed_body: None,
					adjustments: Vec::new(),
				}
				.with_sealed_body(SealedBodyTemplate::Devin(DevinSealedBody::Chat(template))))
			},
			OperationCall::DiscoverModels(_) => {
				let template = self.discovery_request();
				Ok(EncodedRequest {
					operation:   omp_catalog::OperationKind::DiscoverModels,
					method:      RequestMethod::Post,
					uri:         endpoint(&context.route.endpoint.base_url, DISCOVERY_PATH),
					headers:     Box::new([
						RequestHeader { name: sf!("accept"), value: sf!("*/*") },
						RequestHeader { name: sf!("content-type"), value: sf!("application/proto") },
						RequestHeader { name: sf!("connect-protocol-version"), value: sf!("1") },
					]),
					body:        BodySource::Bytes(template.clone()),
					framing:     FramingProtocol::Raw,
					bounds:      SizeBounds {
						request_body: 1024 * 1024,
						frame:        32 * 1024 * 1024,
						response:     32 * 1024 * 1024,
					},
					sealed_body: None,
					adjustments: Vec::new(),
				}
				.with_sealed_body(SealedBodyTemplate::Devin(DevinSealedBody::Discovery(template))))
			},
			_ => Err(invalid_request("devin.operation.unsupported")),
		}
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		match context.operation {
			omp_catalog::OperationKind::Chat => Ok(Box::new(CascadeDecoder::default())),
			omp_catalog::OperationKind::DiscoverModels => Ok(Box::new(DiscoveryDecoder {
				provider:  context.provider.to_owned(),
				route:     context.route.to_owned(),
				completed: false,
			})),
			_ => Err(invalid_request("devin.operation.unsupported")),
		}
	}
}

impl DevinCodec {
	fn encode_chat(
		&self,
		context: &EncodeContext<'_>,
		request: &ChatRequest,
		session: &CascadeSession,
	) -> Result<GetChatMessageRequest, Error> {
		if !request.hosted_tools.is_empty() {
			return Err(invalid_request("devin.hosted_tools.unsupported"));
		}
		if !matches!(request.output, Setting::Unset) {
			return Err(invalid_request("devin.structured_output.unsupported"));
		}
		if !matches!(request.reasoning, Setting::Unset)
			|| !matches!(request.verbosity, Setting::Unset)
			|| !matches!(request.cache_retention, Setting::Unset)
			|| !matches!(request.service_tier, Setting::Unset)
			|| request.top_logprobs.is_some()
			|| !request.safety.is_empty()
		{
			return Err(invalid_request("devin.explicit_controls.unsupported"));
		}

		let mut system = String::new();
		let mut prompts = Vec::with_capacity(request.messages.len());
		for (index, message) in request.messages.iter().enumerate() {
			if matches!(message.role, Role::System | Role::Developer) {
				append_system(&mut system, message, context)?;
			} else {
				prompts.push(message_prompt(message, session, index, context)?);
			}
		}

		let mut stop_patterns = DEFAULT_STOP_PATTERNS
			.iter()
			.map(ToString::to_string)
			.collect::<Vec<_>>();
		stop_patterns.extend(request.sampling.stop.iter().map(ToString::to_string));
		let temperature = f64::from(request.sampling.temperature.unwrap_or(0.4));
		let top_p = f64::from(request.sampling.top_p.unwrap_or(1.0));
		let configuration = CompletionConfiguration {
			num_completions: 1,
			max_tokens: request.max_output_tokens.unwrap_or(DEFAULT_MAX_OUTPUT),
			max_newlines: 200,
			temperature,
			first_temperature: temperature,
			top_k: u64::from(request.sampling.top_k.unwrap_or(50).max(1)),
			top_p,
			stop_patterns,
			fim_eot_prob_threshold: 1.0,
			..CompletionConfiguration::default()
		};
		if request.sampling.presence_penalty.is_some()
			|| request.sampling.frequency_penalty.is_some()
			|| request.sampling.seed.is_some()
		{
			return Err(invalid_request("devin.sampling_controls.unsupported"));
		}

		let choice = match &request.tool_choice {
			Setting::Unset
			| Setting::Require(ToolChoice::Auto)
			| Setting::Prefer(ToolChoice::Auto) => chat_tool_choice::Choice::OptionName("auto".to_owned()),
			Setting::Require(ToolChoice::Named(name)) | Setting::Prefer(ToolChoice::Named(name)) => {
				chat_tool_choice::Choice::ToolName(name.to_string())
			},
			_ => return Err(invalid_request("devin.tool_choice.unsupported")),
		};
		let tools = request
			.tools
			.iter()
			.map(|tool| {
				let (parameters, strict) = tool.input.wire_schema();
				serde_json::to_string(parameters.as_value())
					.map(|schema| ChatToolDefinition {
						name: tool.name.to_string(),
						description: tool
							.description
							.as_ref()
							.map_or_else(String::new, ToString::to_string),
						json_schema_string: schema,
						strict,
						..ChatToolDefinition::default()
					})
					.map_err(|_| invalid_request("devin.tool_schema.serialization"))
			})
			.collect::<Result<Vec<_>, _>>()?;

		Ok(GetChatMessageRequest {
			metadata: Some(self.metadata_wire()),
			prompt: system,
			chat_message_prompts: prompts,
			chat_model_uid: wire_target(context)?.wire_model.as_str().to_owned(),
			request_type: ChatMessageRequestType::Cascade as i32,
			configuration: Some(configuration),
			tools,
			disable_parallel_tool_calls: !context.policy.tool.supports_parallel_calls.unwrap_or(false),
			tool_choice: Some(ChatToolChoice { choice: Some(choice) }),
			system_prompt_cache_options: Some(PromptCacheOptions {
				r#type: CacheControlType::Ephemeral as i32,
			}),
			cascade_id: session.cascade_id.to_string(),
			execution_id: session.execution_id.to_string(),
			planner_mode: ConversationalPlannerMode::Default as i32,
			..GetChatMessageRequest::default()
		})
	}
}

fn append_system(
	output: &mut String,
	message: &Message,
	context: &EncodeContext<'_>,
) -> Result<(), Error> {
	if !output.is_empty() {
		output.push_str("\n\n");
	}
	for part in message.content.iter() {
		match part {
			ContentPart::Text { text, proof } => {
				validate_proof(proof.as_ref(), context)?;
				if proof.is_some() {
					return Err(invalid_request("devin.text.proof_unrepresentable"));
				}
				output.push_str(text);
			},
			ContentPart::Reasoning { text, proof } => {
				validate_proof(proof.as_ref(), context)?;
				output.push_str(text);
			},
			_ => return Err(invalid_request("devin.system.non_text")),
		}
	}
	Ok(())
}

fn message_prompt(
	message: &Message,
	session: &CascadeSession,
	index: usize,
	context: &EncodeContext<'_>,
) -> Result<ChatMessagePrompt, Error> {
	let mut prompt = String::new();
	let mut thinking = String::new();
	let mut signature = String::new();
	let mut images = Vec::new();
	let mut tool_calls = Vec::new();
	let mut tool_call_id = String::new();
	let mut tool_result_is_error = false;
	for part in message.content.iter() {
		match part {
			ContentPart::Text { text, proof } => {
				validate_proof(proof.as_ref(), context)?;
				if proof.is_some() {
					return Err(invalid_request("devin.text.proof_unrepresentable"));
				}
				prompt.push_str(text);
			},
			ContentPart::Reasoning { text, proof } => {
				thinking.push_str(text);
				if let Some(proof) = proof {
					validate_proof(Some(proof), context)?;
					if !signature.is_empty() {
						return Err(invalid_request("devin.reasoning.multiple_proofs"));
					}
					signature.clear();
					signature.push_str(
						str::from_utf8(&proof.value)
							.map_err(|_| invalid_request("devin.reasoning.proof_utf8"))?,
					);
				}
			},
			ContentPart::Image(MediaInput::Bytes { media_type, data }) => images.push(ImageData {
				base64_data: base64::encode(data).into_string(),
				mime_type: media_type.to_string(),
				..ImageData::default()
			}),
			ContentPart::ToolCall { call, name, arguments, proof } => {
				if proof.is_some() {
					validate_proof(proof.as_ref(), context)?;
					return Err(invalid_request("devin.tool_call.proof_unsupported"));
				}
				tool_calls.push(ChatToolCall {
					id: call.to_string(),
					name: name.to_string(),
					arguments_json: serde_json::to_string(arguments.as_value())
						.map_err(|_| invalid_request("devin.tool_arguments.serialization"))?,
					..ChatToolCall::default()
				});
			},
			ContentPart::ToolResult { call, name, content, is_error } => {
				if name.is_some() {
					return Err(invalid_request("devin.tool_result.name_unrepresentable"));
				}
				if !tool_call_id.is_empty() {
					return Err(invalid_request("devin.tool_result.multiple_per_message"));
				}
				tool_call_id = call.to_string();
				tool_result_is_error = *is_error;
				append_tool_result(&mut prompt, &mut images, content)?;
			},
			ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Document(_) => {
				return Err(invalid_request("devin.media.requires_inline_image"));
			},
			ContentPart::CachePoint(_) => {
				return Err(invalid_request("devin.explicit_cache_point.unsupported"));
			},
		}
	}
	Ok(ChatMessagePrompt {
		message_id: format!("{}-{index}", session.cascade_id),
		source: match message.role {
			Role::User => ChatMessageSource::User as i32,
			Role::Assistant => ChatMessageSource::System as i32,
			Role::Tool => ChatMessageSource::Tool as i32,
			Role::System | Role::Developer => ChatMessageSource::SystemPrompt as i32,
		},
		prompt,
		tool_calls,
		tool_call_id,
		tool_result_is_error,
		images,
		thinking,
		signature,
		..ChatMessagePrompt::default()
	})
}

fn append_tool_result(
	text: &mut String,
	images: &mut Vec<ImageData>,
	content: &[ToolResultContent],
) -> Result<(), Error> {
	for (index, part) in content.iter().enumerate() {
		if index > 0 && !text.is_empty() {
			text.push('\n');
		}
		match part {
			ToolResultContent::Text(value) => text.push_str(value),
			ToolResultContent::Json(value) => text.push_str(
				&serde_json::to_string(value.as_value())
					.map_err(|_| invalid_request("devin.tool_result.serialization"))?,
			),
			ToolResultContent::Image(MediaInput::Bytes { media_type, data }) => {
				images.push(ImageData {
					base64_data: base64::encode(data).into_string(),
					mime_type: media_type.to_string(),
					..ImageData::default()
				});
			},
			_ => return Err(invalid_request("devin.tool_result.media_requires_inline_image")),
		}
	}
	Ok(())
}

fn validate_proof(proof: Option<&ProviderProof>, context: &EncodeContext<'_>) -> Result<(), Error> {
	if let Some(proof) = proof
		&& (proof.provider != context.route.provider || proof.codec != wire_target(context)?.codec)
	{
		return Err(invalid_request("devin.provider_proof.scope_mismatch"));
	}
	Ok(())
}

struct DiscoveryDecoder {
	provider:  omp_catalog::ProviderId,
	route:     omp_catalog::RouteId,
	completed: bool,
}

impl Decoder for DiscoveryDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.completed {
			return Err(protocol_error(ErrorPhase::Discovery, "devin.discovery.duplicate_response"));
		}
		let Frame::Raw(payload) = frame else {
			return Err(protocol_error(ErrorPhase::Discovery, "devin.discovery.frame.expected_raw"));
		};
		let rows = DevinCodec::decode_discovery(&payload)?
			.into_iter()
			.map(|row| omp_catalog::DiscoveredModel {
				provider:              self.provider.clone(),
				route:                 self.route.clone(),
				wire_model:            omp_catalog::WireModelId::from(row.id),
				aliases:               Box::new([]),
				display_name:          Some(row.name),
				declared_class:        row.declared_class.map(omp_catalog::ClassId::from),
				declared_operations:   omp_catalog::OperationBits::for_kind(
					omp_catalog::OperationKind::Chat,
				),
				declared_capabilities: None,
				declared_limits:       Some(omp_catalog::ModelLimits {
					context_window:        Some(row.context_window),
					maximum_input_tokens:  None,
					maximum_output_tokens: Some(row.max_output_tokens),
					maximum_batch:         None,
				}),
				declared_pricing:      Box::new([]),
				extended_context_mode: None,
				availability:          Some(omp_catalog::ModelAvailability::Available),
				source:                sf!("devin.get-cli-model-configs"),
				observed_at_ms:        None,
				updated_at_ms:         None,
				deprecated:            Some(false),
			})
			.collect();
		self.completed = true;
		emit(RawEvent::DiscoveredModels { rows, next_cursor: None });
		Ok(())
	}

	fn finish(&mut self, _: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.completed {
			Ok(())
		} else {
			Err(protocol_error(ErrorPhase::Discovery, "devin.discovery.empty_response"))
		}
	}
}
#[derive(Default)]
struct CascadeDecoder {
	next_index:     u32,
	text_index:     Option<u32>,
	thinking_index: Option<u32>,
	tools:          BTreeMap<String, ToolAssembly>,
	usage:          Usage,
	completed:      bool,
}

struct ToolAssembly {
	index:     u32,
	name:      Str,
	arguments: Vec<u8>,
}

impl Decoder for CascadeDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let Frame::Connect(envelope) = frame else {
			return Err(protocol_error(ErrorPhase::Streaming, "devin.frame.expected_connect"));
		};
		match envelope.kind {
			ConnectEnvelopeKind::Message => {
				let payload = if envelope.is_compressed() {
					gunzip(&envelope.payload)?
				} else {
					envelope.payload
				};
				let response = GetChatMessageResponse::decode(payload)
					.map_err(|_| protocol_error(ErrorPhase::Streaming, "devin.response.protobuf"))?;
				self.push_response(response, emit)
			},
			ConnectEnvelopeKind::EndStream => self.push_end_stream(&envelope.payload, emit),
		}
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.completed {
			Ok(())
		} else {
			Err(protocol_error(ErrorPhase::Streaming, "devin.stream.incomplete"))
		}
	}
}

impl CascadeDecoder {
	fn push_response(
		&mut self,
		response: GetChatMessageResponse,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		if self.completed {
			return Err(protocol_error(ErrorPhase::Streaming, "devin.stream.after_completion"));
		}
		if !response.delta_text.is_empty() {
			let index = *self.text_index.get_or_insert_with(|| {
				let index = self.next_index;
				self.next_index = self.next_index.saturating_add(1);
				emit(RawEvent::Chat(ChatEvent::BlockStarted { index, kind: BlockKind::Text }));
				index
			});
			emit(RawEvent::Chat(ChatEvent::TextDelta { index, text: response.delta_text.into() }));
		}
		if !response.delta_thinking.is_empty() {
			let index = *self.thinking_index.get_or_insert_with(|| {
				let index = self.next_index;
				self.next_index = self.next_index.saturating_add(1);
				emit(RawEvent::Chat(ChatEvent::BlockStarted { index, kind: BlockKind::Thinking }));
				index
			});
			emit(RawEvent::Chat(ChatEvent::ThinkingDelta {
				index,
				text: response.delta_thinking.into(),
			}));
			if !response.delta_signature.is_empty() {
				emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
					index,
					signature: Bytes::from(response.delta_signature),
				}));
			}
		}
		for call in response.delta_tool_calls {
			self.push_tool(call, emit);
		}
		if let Some(usage) = response.usage {
			self.usage = Usage {
				input_tokens: usage.input_tokens,
				output_tokens: usage.output_tokens,
				cache_read_tokens: usage.cache_read_tokens,
				cache_write_tokens: usage.cache_write_tokens,
				source: UsageSource::Provider,
				..Usage::default()
			};
			emit(RawEvent::Chat(ChatEvent::Usage(UsageUpdate {
				usage:        self.usage,
				final_update: response.stop_reason != StopReason::Unspecified as i32,
			})));
		}
		let stop = StopReason::try_from(response.stop_reason).unwrap_or(StopReason::Error);
		if stop != StopReason::Unspecified
			&& stop != StopReason::Incomplete
			&& stop != StopReason::Partial
		{
			self.complete(stop, emit);
		}
		Ok(())
	}

	fn push_tool(&mut self, call: ChatToolCall, emit: &mut dyn FnMut(RawEvent)) {
		let key = call.id;
		let state = self.tools.entry(key.clone()).or_insert_with(|| {
			let index = self.next_index;
			self.next_index = self.next_index.saturating_add(1);
			let name = Str::new(call.name.as_str());
			emit(RawEvent::Chat(ChatEvent::ToolCallStarted {
				index,
				id: ToolCallId::new(key.as_str()),
				name: name.clone(),
			}));
			ToolAssembly { index, name, arguments: Vec::new() }
		});
		if state.name.is_empty() && !call.name.is_empty() {
			state.name = call.name.into();
		}
		let incoming = call.arguments_json.as_bytes();
		let delta = if incoming.starts_with(&state.arguments) {
			&incoming[state.arguments.len()..]
		} else if state.arguments.starts_with(incoming) {
			&[]
		} else {
			incoming
		};
		if !delta.is_empty() {
			state.arguments.extend_from_slice(delta);
			emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
				index: state.index,
				bytes: Bytes::copy_from_slice(delta),
			}));
		}
	}

	fn complete(&mut self, stop: StopReason, emit: &mut dyn FnMut(RawEvent)) {
		for (wire_id, tool) in &self.tools {
			emit(RawEvent::ToolCallComplete {
				index: tool.index,
				call:  UnvalidatedToolCall {
					id:         ToolCallId::new(wire_id.as_str()),
					name:       tool.name.clone(),
					input_kind: ToolInputKind::Json,
					arguments:  Bytes::copy_from_slice(&tool.arguments),
				},
			});
		}
		let reason = if self.tools.is_empty() {
			match stop {
				StopReason::MaxTokens => FinishReason::Length,
				StopReason::ContentFilter => FinishReason::ContentFilter,
				StopReason::StopPattern => FinishReason::Stop,
				other => FinishReason::Other(Str::new(other.as_str_name())),
			}
		} else {
			FinishReason::ToolCalls
		};
		emit(RawEvent::Completion(RawCompletion {
			reason,
			blocks: self.next_index,
			usage: self.usage,
		}));
		self.completed = true;
	}

	fn push_end_stream(&self, payload: &[u8], emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if payload.is_empty() {
			return Ok(());
		}
		let diagnostic = parse_connect_end_stream(payload)
			.map_err(|_| protocol_error(ErrorPhase::Streaming, "devin.connect.end_stream"))?;
		if let Some(diagnostic) = diagnostic {
			let failure = protocol_error(ErrorPhase::Streaming, "devin.connect.provider_status")
				.code(diagnostic.code.clone())
				.detail(ErrorDetail::provider(
					diagnostic.display_message_with_prefix("Devin stream error"),
				))
				.committed(self.next_index != 0);
			emit(RawEvent::Failure(failure));
		}
		Ok(())
	}
}

/// Classifies a Connect status with explicit request evidence rather than
/// message heuristics.
pub fn classify_cascade_error(code: &str, evidence: CascadeRequestEvidence) -> Error {
	let context_overflow = code == "invalid_argument" && evidence.cumulative_large_read_output;
	let error = if context_overflow {
		Error::new(
			ErrorKind::ContextOverflow,
			ErrorPhase::Streaming,
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.detail(ErrorDetail::context(DEFAULT_CONTEXT_WINDOW, evidence.estimated_chars))
	} else {
		protocol_error(ErrorPhase::Streaming, "devin.connect.status")
	};
	error.code(Str::new(code))
}

fn connect_gzip_message(payload: &[u8]) -> Result<Bytes, Error> {
	let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
	encoder
		.write_all(payload)
		.map_err(|_| protocol_error(ErrorPhase::Encoding, "devin.gzip.encode"))?;
	let compressed = encoder
		.finish()
		.map_err(|_| protocol_error(ErrorPhase::Encoding, "devin.gzip.finish"))?;
	let length =
		u32::try_from(compressed.len()).map_err(|_| invalid_request("devin.request.too_large"))?;
	let mut framed = Vec::with_capacity(compressed.len() + 5);
	framed.push(1);
	framed.extend_from_slice(&length.to_be_bytes());
	framed.extend_from_slice(&compressed);
	Ok(Bytes::from(framed))
}

fn gunzip(payload: &[u8]) -> Result<Bytes, Error> {
	let mut decoder = GzDecoder::new(payload);
	let mut decoded = Vec::new();
	decoder
		.read_to_end(&mut decoded)
		.map_err(|_| protocol_error(ErrorPhase::Streaming, "devin.gzip.decode"))?;
	Ok(Bytes::from(decoded))
}

fn wire_target<'a>(context: &'a EncodeContext<'_>) -> Result<&'a omp_catalog::WireTarget, Error> {
	context
		.target
		.ok_or_else(|| invalid_request("devin.model_target.required"))
}

fn positive_i32(value: i32) -> Option<u64> {
	u64::try_from(value).ok().filter(|value| *value > 0)
}

fn chat_headers() -> Box<[RequestHeader]> {
	Box::new([
		RequestHeader { name: sf!("content-type"), value: sf!("application/connect+proto") },
		RequestHeader { name: sf!("connect-protocol-version"), value: sf!("1") },
		RequestHeader { name: sf!("connect-content-encoding"), value: sf!("gzip") },
		RequestHeader { name: sf!("accept-encoding"), value: sf!("identity") },
		RequestHeader { name: sf!("user-agent"), value: sf!("connect-go/1.18.1 (go1.26.3)") },
		RequestHeader { name: sf!("connect-accept-encoding"), value: sf!("gzip") },
	])
}

fn endpoint(base: &str, path: &str) -> Str {
	let mut uri = base.trim_end_matches('/').to_owned();
	uri.push_str(path);
	Str::new(uri)
}

fn invalid_request(reason: &'static str) -> Error {
	protocol_error_with_kind(ErrorKind::InvalidRequest, ErrorPhase::Encoding, reason)
}

fn protocol_error(phase: ErrorPhase, reason: &'static str) -> Error {
	protocol_error_with_kind(ErrorKind::Protocol, phase, reason)
}

fn protocol_error_with_kind(kind: ErrorKind, phase: ErrorPhase, reason: &'static str) -> Error {
	Error::new(kind, phase, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

/// RPC path used by credential middleware for model discovery.
pub const fn discovery_rpc_path() -> &'static str {
	DISCOVERY_PATH
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use serde::Deserialize;
	use wire::exa::codeium_common_pb::ModelUsageStats;

	use super::*;
	use crate::codec::ToolInputKind;

	#[derive(Deserialize)]
	#[serde(deny_unknown_fields, rename_all = "camelCase")]
	struct FixtureResponse {
		delta_tool_calls: Vec<FixtureTool>,
		stop_reason:      FixtureStopReason,
		usage:            Option<FixtureUsage>,
	}

	#[derive(Deserialize)]
	#[serde(deny_unknown_fields, rename_all = "camelCase")]
	struct FixtureTool {
		id:             String,
		name:           String,
		arguments_json: String,
	}

	#[derive(Deserialize)]
	#[serde(deny_unknown_fields, rename_all = "camelCase")]
	struct FixtureUsage {
		#[serde(rename = "inputTokens")]
		input:       String,
		#[serde(rename = "outputTokens")]
		output:      String,
		#[serde(rename = "cacheWriteTokens")]
		cache_write: String,
		#[serde(rename = "cacheReadTokens")]
		cache_read:  String,
	}

	#[derive(Deserialize)]
	enum FixtureStopReason {
		#[serde(rename = "STOP_REASON_UNSPECIFIED")]
		Unspecified,
		#[serde(rename = "STOP_REASON_FUNCTION_CALL")]
		FunctionCall,
	}

	#[test]
	fn replays_tool_argument_and_usage_fixture() {
		let fixture = include_str!(concat!(
			env!("CARGO_MANIFEST_DIR"),
			"/../../fixtures/llm-oracle/agent-protocols/devin/stream.tool_args_usage.jsonl"
		));
		let mut decoder = CascadeDecoder::default();
		let mut events = Vec::new();
		for line in fixture.lines() {
			let row: FixtureResponse = serde_json::from_str(line).expect("typed fixture row");
			let usage = row.usage.map(|usage| ModelUsageStats {
				input_tokens: usage.input.parse().expect("input tokens"),
				output_tokens: usage.output.parse().expect("output tokens"),
				cache_write_tokens: usage.cache_write.parse().expect("cache write tokens"),
				cache_read_tokens: usage.cache_read.parse().expect("cache read tokens"),
				..ModelUsageStats::default()
			});
			let response = GetChatMessageResponse {
				delta_tool_calls: row
					.delta_tool_calls
					.into_iter()
					.map(|call| ChatToolCall {
						id: call.id,
						name: call.name,
						arguments_json: call.arguments_json,
						..ChatToolCall::default()
					})
					.collect(),
				stop_reason: match row.stop_reason {
					FixtureStopReason::Unspecified => StopReason::Unspecified as i32,
					FixtureStopReason::FunctionCall => StopReason::FunctionCall as i32,
				},
				usage,
				..GetChatMessageResponse::default()
			};
			decoder
				.push_response(response, &mut |event| events.push(event))
				.expect("fixture response decodes");
		}

		let deltas = events
			.iter()
			.filter_map(|event| match event {
				RawEvent::Chat(ChatEvent::ToolArgumentsDelta { bytes, .. }) => Some(bytes.as_ref()),
				_ => None,
			})
			.flatten()
			.copied()
			.collect::<Vec<_>>();
		assert_eq!(deltas, br#"{"agent":"task","note":"initial","step":12}"#);
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::ToolCallComplete {
				call: UnvalidatedToolCall {
					input_kind: ToolInputKind::Json,
					arguments,
					..
				},
				..
			} if arguments.as_ref() == br#"{"agent":"task","note":"initial","step":12}"#
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Completion(RawCompletion {
				reason: FinishReason::ToolCalls,
				usage: Usage {
					input_tokens: 11,
					output_tokens: 7,
					cache_read_tokens: 5,
					cache_write_tokens: 0,
					..
				},
				..
			})
		)));
	}

	#[test]
	fn accepts_cumulative_tool_argument_chunks_without_reemitting_prefixes() {
		#[derive(Deserialize)]
		struct Modes {
			cumulative_chunks:       Vec<String>,
			expected_arguments_json: String,
		}
		let modes: Modes = serde_json::from_str(include_str!(concat!(
			env!("CARGO_MANIFEST_DIR"),
			"/../../fixtures/llm-oracle/agent-protocols/devin/stream.argument_modes.json"
		)))
		.expect("argument mode fixture");
		let mut decoder = CascadeDecoder::default();
		let mut events = Vec::new();
		for chunk in modes.cumulative_chunks {
			decoder.push_tool(
				ChatToolCall {
					id: "call-1".to_owned(),
					name: "task".to_owned(),
					arguments_json: chunk,
					..ChatToolCall::default()
				},
				&mut |event| events.push(event),
			);
		}
		let actual = events
			.iter()
			.filter_map(|event| match event {
				RawEvent::Chat(ChatEvent::ToolArgumentsDelta { bytes, .. }) => Some(bytes.as_ref()),
				_ => None,
			})
			.flatten()
			.copied()
			.collect::<Vec<_>>();
		assert_eq!(actual, modes.expected_arguments_json.as_bytes());
	}

	#[test]
	fn decodes_verified_discovery_fixture_deterministically() {
		let models = DevinCodec::decode_discovery(include_bytes!(concat!(
			env!("CARGO_MANIFEST_DIR"),
			"/../../fixtures/llm-oracle/agent-protocols/devin/discovery.response.bin"
		)))
		.expect("discovery fixture");
		assert_eq!(models.len(), 2);
		assert_eq!(models[0].id.as_str(), "claude_sonnet-4");
		assert!(models[0].supports_images);
		assert!(models[0].reasoning);
		assert_eq!(models[1].id.as_str(), "compact_model");
		assert!(!models[1].reasoning);
	}

	#[test]
	fn chat_connect_headers_describe_message_gzip_and_pin_frame_cap() {
		let headers = chat_headers()
			.into_vec()
			.into_iter()
			.map(|header| (header.name, header.value))
			.collect::<BTreeMap<_, _>>();
		assert_eq!(headers.get("content-type").map(Str::as_str), Some("application/connect+proto"));
		assert_eq!(headers.get("connect-protocol-version").map(Str::as_str), Some("1"));
		assert_eq!(headers.get("connect-content-encoding").map(Str::as_str), Some("gzip"));
		assert_eq!(headers.get("connect-accept-encoding").map(Str::as_str), Some("gzip"));
		assert_eq!(headers.get("accept-encoding").map(Str::as_str), Some("identity"));
		assert_eq!(headers.get("user-agent").map(Str::as_str), Some("connect-go/1.18.1 (go1.26.3)"));
		assert!(!headers.contains_key("content-encoding"));
		assert_eq!(MAX_CONNECT_FRAME_BYTES, 16 * 1024 * 1024);
	}

	#[test]
	fn supports_parallel_tool_calls_matches_pi_request_shape() {
		let target = omp_catalog::WireTarget {
			route:      omp_catalog::RouteId::from("devin"),
			codec:      omp_catalog::CodecId::from("devin"),
			endpoint:   omp_catalog::EndpointSpec {
				base_url:    sf!("https://api.devin.ai"),
				region:      None,
				api_version: None,
			},
			wire_model: omp_catalog::WireModelId::new("model"),
		};
		let request = ChatRequest {
			messages:          Arc::from([]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Default::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       Default::default(),
			forced_call:       None,
		};
		let session = CascadeSession::new("cascade", "execution");
		let mut policy = omp_catalog::WirePolicy::baseline();
		policy.tool.supports_parallel_calls = Some(true);
		let context =
			EncodeContext { target: Some(&target), policy: &policy, ..EncodeContext::default() };
		let encoded = DevinCodec::new()
			.encode_chat(&context, &request, &session)
			.expect("Devin chat request");
		assert!(!encoded.disable_parallel_tool_calls);

		policy.tool.supports_parallel_calls = Some(false);
		let context =
			EncodeContext { target: Some(&target), policy: &policy, ..EncodeContext::default() };
		let encoded = DevinCodec::new()
			.encode_chat(&context, &request, &session)
			.expect("Devin chat request");
		assert!(encoded.disable_parallel_tool_calls);
	}

	#[test]
	fn official_client_metadata_includes_the_wire_locale() {
		let metadata = DevinCodec::new().metadata_wire();
		assert_eq!(metadata.ide_name, "windsurf");
		assert_eq!(metadata.ide_version, "3.2.23");
		assert_eq!(metadata.extension_name, "windsurf");
		assert_eq!(metadata.extension_version, "1.48.2");
		assert_eq!(metadata.locale, "en");
	}

	#[test]
	fn context_overflow_requires_explicit_request_evidence() {
		let without = classify_cascade_error("invalid_argument", CascadeRequestEvidence::default());
		assert_eq!(without.kind, ErrorKind::Protocol);
		let with = classify_cascade_error("invalid_argument", CascadeRequestEvidence {
			cumulative_large_read_output: true,
			estimated_chars:              200_000,
		});
		assert_eq!(with.kind, ErrorKind::ContextOverflow);
		assert_eq!(with.action, RetryAction::Never);
	}
	fn decode_trailer_failure(payload: &[u8]) -> Error {
		let decoder = CascadeDecoder::default();
		let mut events = Vec::new();
		decoder
			.push_end_stream(payload, &mut |event| events.push(event))
			.expect("trailer decodes");
		let Some(RawEvent::Failure(error)) = events.pop() else {
			panic!("error trailer must emit one failure");
		};
		error
	}

	#[test]
	fn connect_trailer_preserves_structured_error_and_debug_info() {
		let error = decode_trailer_failure(
			br#"{"error":{"code":"invalid_argument","message":"Error","details":[{"type":"google.rpc.ErrorInfo","value":{"reason":"MODEL_UNAVAILABLE","domain":"devin"}},{"type":"google.rpc.DebugInfo","debug":{"detail":"field X rejected"}}]}}"#,
		);
		assert_eq!(error.kind, ErrorKind::Protocol);
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(error.code.as_deref(), Some("invalid_argument"));
		let Some(ErrorDetail::Provider { sanitized_message }) = error.detail_ref() else {
			panic!("display diagnostic must remain supplemental provider evidence");
		};
		assert!(sanitized_message.starts_with("Devin stream error invalid_argument: Error"));
		assert!(sanitized_message.contains("google.rpc.ErrorInfo"));
		assert!(sanitized_message.contains("MODEL_UNAVAILABLE"));
		assert!(sanitized_message.contains("google.rpc.DebugInfo"));
		assert!(sanitized_message.contains("field X rejected"));
	}

	#[test]
	fn connect_trailer_uses_fallback_detail_without_changing_classification() {
		let error = decode_trailer_failure(
			br#"{"error":{"code":"invalid_argument","message":"Error","details":{"opaque":"fallback evidence"}}}"#,
		);
		assert_eq!(error.kind, ErrorKind::Protocol);
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(error.code.as_deref(), Some("invalid_argument"));
		let Some(ErrorDetail::Provider { sanitized_message }) = error.detail_ref() else {
			panic!("fallback diagnostic must remain supplemental provider evidence");
		};
		assert!(sanitized_message.contains("fallback evidence"));
	}

	#[test]
	fn connect_trailer_diagnostic_cap_is_exact_and_does_not_reclassify() {
		let payload = serde_json::to_vec(&serde_json::json!({
			"error": {
				"code": "invalid_argument",
				"message": "Error",
				"details": [{"type": "google.rpc.DebugInfo", "debug": "x".repeat(4_000)}]
			}
		}))
		.expect("payload");
		let error = decode_trailer_failure(&payload);
		assert_eq!(error.kind, ErrorKind::Protocol);
		assert_eq!(error.action, RetryAction::Never);
		assert_eq!(error.code.as_deref(), Some("invalid_argument"));
		let Some(ErrorDetail::Provider { sanitized_message }) = error.detail_ref() else {
			panic!("bounded diagnostic must remain supplemental provider evidence");
		};
		assert_eq!(
			sanitized_message.chars().count(),
			crate::codec::connect::MAX_CONNECT_DIAGNOSTIC_CHARS
		);
		assert!(sanitized_message.ends_with('…'));
	}

	#[test]
	fn sealed_chat_binds_exact_metadata_and_normalizes_prefix_once() {
		let template = DevinSealedBody::Chat(Bytes::from(
			GetChatMessageRequest {
				metadata: Some(Metadata::default()),
				..GetChatMessageRequest::default()
			}
			.encode_to_vec(),
		));
		let bound = template
			.bind("devin-session-token$devin-session-token$jwt-value")
			.expect("sealed chat");
		assert_eq!(bound[0], 1);
		let payload = gunzip(&bound[5..]).expect("gzip");
		let request = GetChatMessageRequest::decode(payload).expect("protobuf");
		let metadata = request.metadata.expect("metadata");
		assert_eq!(metadata.api_key, "devin-session-token$jwt-value");
		assert_eq!(metadata.user_jwt, "jwt-value");
	}

	#[test]
	fn sealed_discovery_binds_api_key_without_user_jwt() {
		let codec = DevinCodec::new();
		let SealedBodyTemplate::Devin(template) = codec.sealed_discovery_request();
		let bound = template.bind("jwt-value").expect("sealed discovery");
		let request = GetCliModelConfigsRequest::decode(bound).expect("protobuf");
		let metadata = request.metadata.expect("metadata");
		assert_eq!(metadata.api_key, "devin-session-token$jwt-value");
		assert_eq!(metadata.user_jwt, "");
	}

	#[test]
	fn sealed_template_debug_is_redacted() {
		let secret = "must-never-appear";
		let template =
			SealedBodyTemplate::Devin(DevinSealedBody::Discovery(Bytes::from_static(b"template")));
		let debug = format!("{template:?}");
		assert!(!debug.contains(secret));
		assert!(!debug.contains("template"));
	}
}
