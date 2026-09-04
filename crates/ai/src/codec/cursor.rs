//! Cursor Agent Connect/protobuf request lowering and incremental event
//! projection.
//!
//! Bindings are generated into `OUT_DIR` from the verified checked-in schema.
//! The live `Run` endpoint is intentionally driven as a bidirectional Connect
//! stream even though the pinned descriptor declares the method unary;
//! descriptor tests make that observed drift explicit.

use std::{
	collections::{BTreeMap, BTreeSet},
	sync::Arc,
	time::Duration,
};

use bytes::{BufMut as _, Bytes, BytesMut};
use omp_catalog::{
	Availability, ChatCapabilities, DiscoveredModel, ExtendedContextMode, ModelCapabilities,
	OperationBits, OperationKind, ReasoningCapabilities, ReasoningFeatureBits, WireModelId,
};
use omp_core::{Str, sf};
use parking_lot::Mutex;
use prost::Message;
use prost_types::{
	FileDescriptorSet, ListValue as ProtoList, Struct as ProtoStruct, Value as ProtoValue,
	value::Kind as ProtoValueKind,
};

use self::wire::{
	agent_client_message, agent_server_message, ask_question_result, conversation_action,
	create_plan_result, cursor_rule_type, exa_fetch_request_response, exa_search_request_response,
	exec_client_control_message, exec_client_message, exec_server_control_message,
	exec_server_message, interaction_update, shell_result, shell_stream,
	switch_mode_request_response, tool_call, tool_call_delta, web_fetch_request_response,
	web_search_request_response,
};
use super::{
	Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
	ProviderControlEvent, ProviderStateEvent, RawCompletion, RawEvent, RequestHeader, RequestMethod,
	SizeBounds, ToolInputKind, UnvalidatedToolCall,
	connect::{ConnectErrorDiagnostic, parse_connect_end_stream},
};
use crate::{
	body::BodySource,
	call::{ChatRequest, ContentPart, OperationCall, Role, Setting},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::{RequestId, ToolCallId},
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{ConnectEnvelopeKind, Frame, FramingProtocol},
};

/// Prost bindings generated from the verified Cursor Agent schema.
pub mod wire {
	#![allow(
		missing_docs,
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
	include!(concat!(env!("OUT_DIR"), "/agent.v1.rs"));
}

/// SHA-256 of the checked-in source compiled by this crate.
pub const SCHEMA_SHA256: &str = "fc1ac3ed472676e6d863fe2238ab1529247b68d3ea21f33b3fae1abae481892c";
/// Repository commit from which the checked-in schema was recovered.
///
/// The checked-in copy additionally models the hosted `WebFetch` interaction
/// gate (`ToolCall.web_fetch_tool_call = 37`,
/// `InteractionQuery`/`InteractionResponse` field 9) observed on later Cursor
/// builds.
pub const SCHEMA_SOURCE_COMMIT: &str = "b6e01c8a3c836032823e13a404ceca2e968b6411";
/// Cursor's bidirectional Agent Connect method.
pub const RUN_PATH: &str = "/agent.v1.AgentService/Run";
/// Cursor's reconnect event-stream method.
pub const RUN_SSE_PATH: &str = "/agent.v1.AgentService/RunSSE";
/// Cursor's unary model-discovery method.
pub const DISCOVERY_PATH: &str = "/agent.v1.AgentService/GetUsableModels";
/// Cursor's non-secret client-version header value pinned by the protocol
/// fixtures.
pub const CLIENT_VERSION: &str = "cli-2026.07.23-e383d2b";
/// Maximum accepted protobuf payload size.
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

const CONNECT_END_STREAM: u8 = 0x02;

/// Encoded descriptor set for the exact schema used to generate [`wire`].
pub static FILE_DESCRIPTOR_SET: &[u8] =
	include_bytes!(concat!(env!("OUT_DIR"), "/cursor-agent-descriptor.bin"));

/// Decodes the generated binding descriptor for drift inspection.
pub fn descriptor_set() -> Result<FileDescriptorSet, prost::DecodeError> {
	FileDescriptorSet::decode(FILE_DESCRIPTOR_SET)
}

/// Stable Cursor codec failure class.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorErrorKind {
	/// Protobuf or Connect bytes violated the schema.
	Malformed,
	/// A complete stream ended without its required terminal signal.
	Truncated,
	/// Input arrived after terminal completion or cancellation.
	AfterTerminal,
	/// The caller cancelled decoding.
	Cancelled,
	/// Cursor rejected authentication.
	Authentication,
	/// Cursor returned a non-success status.
	Upstream,
	/// Cursor could not resolve the normalized model id.
	ModelNotFound,
	/// Cursor rejected the selected model under the account's plan.
	PlanGate,
	/// Cursor rejected a poisoned conversation before producing tokens.
	ResourceExhausted,
	/// Cursor reported a context-window overflow.
	ContextOverflow,
	/// A requested canonical shape has no lossless Cursor projection.
	Unsupported,
}

/// Secret-free typed Cursor codec error.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{reason}")]
pub struct CursorProtocolError {
	/// Stable error classification.
	pub kind:      CursorErrorKind,
	/// Sanitized protocol reason.
	pub reason:    Str,
	/// HTTP status when the failure came from a response handshake.
	pub status:    Option<u16>,
	/// Whether an ordinary canonical event had already been emitted.
	pub committed: bool,
	/// Typed Connect evidence retained separately from classification.
	diagnostic:    Option<ConnectErrorDiagnostic>,
}

impl CursorProtocolError {
	const fn new(kind: CursorErrorKind, reason: &'static str, committed: bool) -> Self {
		Self { kind, reason: sf!(reason), committed, status: None, diagnostic: None }
	}
}

/// Maps an HTTP response status into Cursor's secret-free error vocabulary.
pub const fn classify_http_status(status: u16) -> Option<CursorProtocolError> {
	let mut error = match status {
		200..=299 => return None,
		401 | 403 => CursorProtocolError::new(
			CursorErrorKind::Authentication,
			"Cursor authentication failed",
			false,
		),
		_ => CursorProtocolError::new(
			CursorErrorKind::Upstream,
			"Cursor Connect returned a non-success HTTP status",
			false,
		),
	};
	error.status = Some(status);
	Some(error)
}

/// Non-secret request-header profile selected by the operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorHeaderProfile {
	/// Bidirectional Connect/protobuf run.
	Run,
	/// Unary raw-protobuf discovery.
	Discovery,
}

/// Visits every public header required by the selected Cursor protocol profile.
pub fn for_each_public_header(
	profile: CursorHeaderProfile,
	mut visit: impl FnMut(&'static str, &'static str),
) {
	match profile {
		CursorHeaderProfile::Run => {
			visit("content-type", "application/connect+proto");
			visit("connect-protocol-version", "1");
			visit("te", "trailers");
		},
		CursorHeaderProfile::Discovery => {
			visit("content-type", "application/proto");
			visit("accept", "application/proto");
			visit("te", "trailers");
		},
	}
	visit("x-ghost-mode", "true");
	visit("x-cursor-client-version", CLIENT_VERSION);
	visit("x-cursor-client-type", "cli");
}

/// One caller-declared tool exposed through Cursor's MCP-compatible tool list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorToolDefinition {
	/// Canonical tool name.
	pub name:         Str,
	/// Optional human-readable description.
	pub description:  Option<Str>,
	/// Encoded `google.protobuf.Value` carrying the tool's JSON Schema.
	pub input_schema: Bytes,
}

/// Instruction role retained inside Cursor's serialized root prompt messages.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorPromptRole {
	/// System instruction.
	System,
	/// Developer instruction.
	Developer,
}

impl CursorPromptRole {
	const fn as_str(self) -> &'static str {
		match self {
			Self::System => "system",
			Self::Developer => "developer",
		}
	}
}

/// One typed Cursor root prompt message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorRootPrompt {
	/// Semantic instruction role.
	pub role: CursorPromptRole,
	/// Instruction text.
	pub text: Str,
}

/// Action carried by one Cursor Agent run request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CursorRunAction {
	/// Submit one user message.
	UserMessage {
		/// Stable message identity supplied by the caller.
		message_id: Str,
		/// Plain-text message body.
		text:       Str,
	},
	/// Resume from the supplied provider checkpoint.
	Resume,
	/// Cancel the active provider turn.
	Cancel,
}

/// Typed inputs for a Cursor `AgentRunRequest`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorRunRequest {
	/// Opaque selected wire model identity.
	pub model_id:        Str,
	/// Whether the catalog-selected Cursor max mode is enabled.
	pub max_mode:        bool,
	/// Optional provider conversation identity.
	pub conversation_id: Option<Str>,
	/// Serialized `ConversationStateStructure` from an authoritative checkpoint.
	pub checkpoint:      Option<Bytes>,
	/// Ordered system/developer prompt messages for a fresh session.
	pub root_prompts:    Box<[CursorRootPrompt]>,
	/// Caller tools projected through Cursor's MCP tool schema.
	pub tools:           Box<[CursorToolDefinition]>,
	/// Current action.
	pub action:          CursorRunAction,
}

/// Opaque authoritative Cursor session checkpoint bound by session middleware.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorSessionCheckpoint {
	/// Optional provider conversation identity.
	pub conversation_id: Option<Str>,
	/// Serialized `ConversationStateStructure`.
	pub state:           Bytes,
}

/// Typed request for Cursor's `RunSSE` reconnect method.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorReconnectRequest {
	/// Bidi request id issued by the original run stream.
	pub request_id: Str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CursorWireMode {
	Normalized,
	Discovered,
}

/// Encodes the Connect-framed body for Cursor's streaming `Run` method.
///
/// # Errors
/// Returns [`CursorProtocolError`] when the request state cannot be lowered
/// onto the wire schema.
pub fn encode_run_request(request: &CursorRunRequest) -> Result<Bytes, CursorProtocolError> {
	encode_run_request_for_wire_mode(request, CursorWireMode::Normalized)
}

fn encode_run_request_for_wire_mode(
	request: &CursorRunRequest,
	wire_mode: CursorWireMode,
) -> Result<Bytes, CursorProtocolError> {
	let state = request
		.checkpoint
		.as_ref()
		.map(|bytes| wire::ConversationStateStructure::decode(bytes.clone()))
		.transpose()
		.map_err(|_| {
			CursorProtocolError::new(
				CursorErrorKind::Malformed,
				"invalid Cursor session checkpoint",
				false,
			)
		})?
		.unwrap_or_else(|| wire::ConversationStateStructure {
			root_prompt_messages_json: request
				.root_prompts
				.iter()
				.map(encode_root_prompt)
				.collect(),
			..Default::default()
		});
	let request_context = cursor_request_context(&request.root_prompts);
	let action = match &request.action {
		CursorRunAction::UserMessage { message_id, text } => {
			conversation_action::Action::UserMessageAction(wire::UserMessageAction {
				user_message:                 Some(wire::UserMessage {
					text: text.as_str().to_owned(),
					message_id: message_id.as_str().to_owned(),
					..Default::default()
				}),
				request_context:              Some(request_context),
				send_to_interaction_listener: None,
			})
		},
		CursorRunAction::Resume => conversation_action::Action::ResumeAction(wire::ResumeAction {
			request_context: Some(request_context),
		}),
		CursorRunAction::Cancel => conversation_action::Action::CancelAction(wire::CancelAction {}),
	};
	let tools = request
		.tools
		.iter()
		.map(|tool| wire::McpToolDefinition {
			name:                tool.name.as_str().to_owned(),
			provider_identifier: "omp".to_owned(),
			tool_name:           tool.name.as_str().to_owned(),
			description:         tool
				.description
				.as_ref()
				.map_or_else(String::new, |value| value.as_str().to_owned()),
			input_schema:        tool.input_schema.clone(),
			input_schema_json:   None,
		})
		.collect();
	let wire_model = match wire_mode {
		CursorWireMode::Normalized => resolve_cursor_wire_model(request.model_id.as_str()),
		CursorWireMode::Discovered => {
			CursorWireModel { model_id: request.model_id.clone(), reasoning: None }
		},
	};
	let model = wire::ModelDetails {
		model_id: wire_model.model_id.as_str().to_owned(),
		display_model_id: wire_model.model_id.as_str().to_owned(),
		display_name: wire_model.model_id.as_str().to_owned(),
		max_mode: Some(request.max_mode),
		..Default::default()
	};
	let mut parameters = Vec::new();
	if let Some(value) = wire_model.reasoning {
		parameters.push(wire::RequestedModelModelParameterbytes {
			id:    "reasoning".to_owned(),
			value: value.as_str().to_owned(),
		});
	}
	parameters.extend(omp_catalog::cursor_model_parameters(wire_model.model_id.as_str()).map(
		|(id, value)| wire::RequestedModelModelParameterbytes {
			id:    id.to_owned(),
			value: value.to_owned(),
		},
	));
	let run = wire::AgentRunRequest {
		conversation_state: Some(state),
		action: Some(wire::ConversationAction { action: Some(action) }),
		model_details: Some(model),
		requested_model: Some(wire::RequestedModel {
			model_id: wire_model.model_id.as_str().to_owned(),
			max_mode: request.max_mode,
			parameters,
			..Default::default()
		}),
		mcp_tools: Some(wire::McpTools { mcp_tools: tools }),
		conversation_id: request
			.conversation_id
			.as_ref()
			.map(|id| id.as_str().to_owned()),
		..Default::default()
	};
	Ok(connect_message(&wire::AgentClientMessage {
		message: Some(agent_client_message::Message::RunRequest(run)),
	}))
}

/// Projects ordered system/developer prompts as global `requestContext.rules`
/// so Cursor's `AgentService` retains always-apply rules when it reconstructs
/// prompts server-side.
fn cursor_request_context(root_prompts: &[CursorRootPrompt]) -> wire::RequestContext {
	wire::RequestContext {
		rules: root_prompts
			.iter()
			.filter(|prompt| !prompt.text.is_empty())
			.enumerate()
			.map(|(index, prompt)| wire::CursorRule {
				full_path: format!("/omp/system-prompt/{index}.mdc"),
				content: prompt.text.as_str().to_owned(),
				r#type: Some(wire::CursorRuleType {
					r#type: Some(cursor_rule_type::Type::Global(wire::CursorRuleTypeGlobal::default())),
				}),
				source: wire::CursorRuleSource::User as i32,
				..Default::default()
			})
			.collect(),
		..Default::default()
	}
}

/// Wire lowering of a routed Cursor model id: base slug plus an optionally
/// split reasoning tier.
struct CursorWireModel {
	model_id:  Str,
	reasoning: Option<Str>,
}

/// Splits a routed Cursor model id into its wire base id and reasoning tier.
///
/// Cursor's `GetUsableModels` lists `OpenAI` reasoning models as per-effort
/// sibling slugs (`gpt-5.6-sol-high`); the Run endpoint rejects a sibling slug
/// as the wire `model_id` with `resource_exhausted` (error 528384). Mirror the
/// official client: strip a trailing effort tier — preserving the `-fast`
/// service lane — and emit it as a `reasoning` parameter. Non-OpenAI ids pass
/// through unchanged: Cursor-native ids carry no effort suffix and other
/// families need parameters the discovery schema does not expose.
fn resolve_cursor_wire_model(model_id: &str) -> CursorWireModel {
	let (stem, fast) = match model_id.strip_suffix("-fast") {
		Some(stem) => (stem, true),
		None => (model_id, false),
	};
	if let Some((base, tier)) = omp_catalog::cursor_openai_effort_suffix(stem) {
		let model_id = if fast {
			sf!("{base}-fast")
		} else {
			Str::new(base)
		};
		return CursorWireModel { model_id, reasoning: Some(Str::new_static(tier)) };
	}
	CursorWireModel { model_id: Str::new(model_id), reasoning: None }
}

fn serialized_fallback_wire_model(
	request: &CursorRunRequest,
	wire_mode: CursorWireMode,
	body: &Bytes,
) -> Option<Str> {
	if wire_mode != CursorWireMode::Normalized {
		return None;
	}
	let expected = resolve_cursor_wire_model(request.model_id.as_str());
	let effort = expected.reasoning.as_ref()?;
	if expected.model_id == request.model_id {
		return None;
	}
	let message = wire::AgentClientMessage::decode(body.slice(5..)).ok()?;
	let agent_client_message::Message::RunRequest(run) = message.message? else {
		return None;
	};
	let requested = run.requested_model?;
	let details = run.model_details?;
	let [parameter] = requested.parameters.as_slice() else {
		return None;
	};
	(requested.model_id == expected.model_id
		&& details.model_id == expected.model_id
		&& parameter.id == "reasoning"
		&& parameter.value == effort.as_str())
	.then(|| request.model_id.clone())
}

/// Encodes the request body for `RunSSE` reconnect.
pub fn encode_reconnect_request(request: &CursorReconnectRequest) -> Bytes {
	Bytes::from(
		wire::BidiRequestId { request_id: request.request_id.as_str().to_owned() }.encode_to_vec(),
	)
}

/// Encodes the unary model-discovery request body.
pub fn encode_discovery_request(custom_model_ids: &[Str]) -> Bytes {
	Bytes::from(
		wire::GetUsableModelsRequest {
			custom_model_ids: custom_model_ids
				.iter()
				.map(|id| id.as_str().to_owned())
				.collect(),
		}
		.encode_to_vec(),
	)
}

/// Adds a Connect data envelope around one protobuf message.
pub fn connect_message(message: &impl Message) -> Bytes {
	let payload_len = message.encoded_len();
	let mut bytes = BytesMut::with_capacity(payload_len + 5);
	bytes.put_u8(0);
	bytes.put_u32(u32::try_from(payload_len).expect("Cursor protobuf message exceeds u32 framing"));
	message.encode(&mut bytes).expect("BytesMut is growable");
	bytes.freeze()
}

fn encode_root_prompt(prompt: &CursorRootPrompt) -> Bytes {
	#[derive(serde::Serialize)]
	struct RootPrompt<'a> {
		role:    &'static str,
		content: &'a str,
	}

	Bytes::from(
		serde_json::to_vec(&RootPrompt {
			role:    prompt.role.as_str(),
			content: prompt.text.as_str(),
		})
		.expect("a borrowed string always serializes as JSON"),
	)
}
fn encode_json_value(value: &serde_json::Value) -> Result<Bytes, Error> {
	Ok(Bytes::from(protobuf_json_value(value)?.encode_to_vec()))
}

fn protobuf_json_value(value: &serde_json::Value) -> Result<ProtoValue, Error> {
	let kind = match value {
		serde_json::Value::Null => ProtoValueKind::NullValue(0),
		serde_json::Value::Bool(value) => ProtoValueKind::BoolValue(*value),
		serde_json::Value::Number(value) => ProtoValueKind::NumberValue(
			value
				.as_f64()
				.filter(|value| value.is_finite())
				.ok_or_else(|| encoding_error("cursor_tool_schema_number_not_representable"))?,
		),
		serde_json::Value::String(value) => ProtoValueKind::StringValue(value.clone()),
		serde_json::Value::Array(values) => ProtoValueKind::ListValue(ProtoList {
			values: values
				.iter()
				.map(protobuf_json_value)
				.collect::<Result<_, _>>()?,
		}),
		serde_json::Value::Object(fields) => ProtoValueKind::StructValue(ProtoStruct {
			fields: fields
				.iter()
				.map(|(name, value)| Ok((name.clone(), protobuf_json_value(value)?)))
				.collect::<Result<_, Error>>()?,
		}),
	};
	Ok(ProtoValue { kind: Some(kind) })
}

fn decode_json_value(bytes: &[u8]) -> Option<serde_json::Value> {
	let value = ProtoValue::decode(bytes).ok()?;
	protobuf_to_json(value)
}

fn protobuf_to_json(value: ProtoValue) -> Option<serde_json::Value> {
	Some(match value.kind {
		None | Some(ProtoValueKind::NullValue(_)) => serde_json::Value::Null,
		Some(ProtoValueKind::BoolValue(value)) => serde_json::Value::Bool(value),
		Some(ProtoValueKind::NumberValue(value)) => {
			// protobuf `Value` carries every number as a double; JSON tool
			// arguments distinguish 12 from 12.0, so whole in-range doubles
			// decode as integers (matching the JS decoder's output).
			const SAFE: f64 = 9_007_199_254_740_992.0; // 2^53
			if !value.is_finite() {
				serde_json::Value::Null
			} else if value.fract() == 0.0 && value.abs() <= SAFE {
				serde_json::Value::Number(serde_json::Number::from(value as i64))
			} else {
				serde_json::Value::Number(serde_json::Number::from_f64(value)?)
			}
		},
		Some(ProtoValueKind::StringValue(value)) => serde_json::Value::String(value),
		Some(ProtoValueKind::ListValue(value)) => serde_json::Value::Array(
			value
				.values
				.into_iter()
				.map(protobuf_to_json)
				.collect::<Option<_>>()?,
		),
		Some(ProtoValueKind::StructValue(value)) => serde_json::Value::Object(
			value
				.fields
				.into_iter()
				.map(|(name, value)| Some((name, protobuf_to_json(value)?)))
				.collect::<Option<_>>()?,
		),
	})
}

/// Non-secret model facts observed directly in Cursor discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorDiscoveredModel {
	/// Cursor model identity.
	pub id:        Str,
	/// Human-readable display name.
	pub name:      Str,
	/// Cursor aliases reported on the wire.
	pub aliases:   Box<[Str]>,
	/// Whether Cursor supplied thinking metadata.
	pub reasoning: bool,
	/// Whether Cursor advertises max mode.
	pub max_mode:  bool,
}

/// Decodes a raw protobuf or one Connect data envelope from model discovery.
pub fn decode_discovery_response(
	payload: &[u8],
) -> Result<Vec<CursorDiscoveredModel>, CursorProtocolError> {
	let protobuf = first_discovery_message(payload)?;
	let response = wire::GetUsableModelsResponse::decode(protobuf).map_err(|_| {
		CursorProtocolError::new(
			CursorErrorKind::Malformed,
			"malformed Cursor discovery protobuf",
			false,
		)
	})?;
	let mut models = BTreeMap::new();
	for model in response.models {
		let id = model.model_id.trim();
		if id.is_empty() {
			continue;
		}
		let name = if model.display_name.trim().is_empty() {
			id
		} else {
			model.display_name.trim()
		};
		models.insert(id.to_owned(), CursorDiscoveredModel {
			id:        Str::new(id),
			name:      Str::new(name),
			aliases:   model.aliases.into_iter().map(Str::new).collect(),
			reasoning: model.thinking_details.is_some(),
			max_mode:  model.max_mode.unwrap_or(false),
		});
	}
	Ok(models.into_values().collect())
}

fn first_discovery_message(payload: &[u8]) -> Result<&[u8], CursorProtocolError> {
	if payload
		.first()
		.copied()
		.is_some_and(|flags| flags & !0x03 == 0)
	{
		if payload.len() < 5 {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Truncated,
				"incomplete Cursor discovery frame header",
				false,
			));
		}
		let length =
			u32::from_be_bytes(payload[1..5].try_into().expect("fixed four-byte length")) as usize;
		let end = 5usize.checked_add(length).ok_or_else(|| {
			CursorProtocolError::new(
				CursorErrorKind::Malformed,
				"Cursor discovery frame length overflow",
				false,
			)
		})?;
		if end > payload.len() {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Truncated,
				"incomplete Cursor discovery frame payload",
				false,
			));
		}
		if payload[0] & CONNECT_END_STREAM != 0 {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Truncated,
				"Cursor discovery returned only an end-stream frame",
				false,
			));
		}
		return Ok(&payload[5..end]);
	}
	Ok(payload)
}

/// Cursor server-requested shell execution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorShellInvocation {
	/// Numeric correlation identifier.
	pub id:                u32,
	/// Optional attachable execution identity.
	pub exec_id:           Str,
	/// Canonical tool-call identity.
	pub call_id:           ToolCallId,
	/// Command text.
	pub command:           Str,
	/// Requested working directory.
	pub working_directory: Str,
	/// Soft timeout in milliseconds.
	pub timeout_ms:        u32,
	/// Whether Cursor expects incremental `ShellStream` frames.
	pub streaming:         bool,
}

/// Completed shell execution supplied back to Cursor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CursorShellCompletion {
	/// Process exited successfully.
	Exited {
		/// Captured standard output.
		stdout:                  Str,
		/// Captured standard error.
		stderr:                  Str,
		/// Local execution duration.
		local_execution_time_ms: u32,
	},
	/// Process exited unsuccessfully.
	Failed {
		/// Exit code.
		code:                    u32,
		/// Captured standard output.
		stdout:                  Str,
		/// Captured standard error.
		stderr:                  Str,
		/// Local execution duration.
		local_execution_time_ms: u32,
	},
	/// Caller policy rejected execution.
	Rejected {
		/// Sanitized policy reason.
		reason:      Str,
		/// Whether the command was read-only.
		is_readonly: bool,
	},
	/// Caller denied execution permission.
	PermissionDenied {
		/// Sanitized denial reason.
		reason:      Str,
		/// Whether the command was read-only.
		is_readonly: bool,
	},
	/// Execution exceeded the declared deadline.
	TimedOut {
		/// Applied timeout in milliseconds.
		timeout_ms: u32,
	},
}

/// Builds Cursor's initial shell-stream frame.
pub fn shell_start(invocation: &CursorShellInvocation) -> wire::AgentClientMessage {
	exec_message(
		invocation,
		exec_client_message::Message::ShellStream(wire::ShellStream {
			event: Some(shell_stream::Event::Start(wire::ShellStreamStart { sandbox_policy: None })),
		}),
		None,
	)
}

/// Builds one incremental shell stdout frame.
pub fn shell_stdout(invocation: &CursorShellInvocation, text: &str) -> wire::AgentClientMessage {
	exec_message(
		invocation,
		exec_client_message::Message::ShellStream(wire::ShellStream {
			event: Some(shell_stream::Event::Stdout(wire::ShellStreamStdout {
				data: text.to_owned(),
			})),
		}),
		None,
	)
}

/// Builds one incremental shell stderr frame.
pub fn shell_stderr(invocation: &CursorShellInvocation, text: &str) -> wire::AgentClientMessage {
	exec_message(
		invocation,
		exec_client_message::Message::ShellStream(wire::ShellStream {
			event: Some(shell_stream::Event::Stderr(wire::ShellStreamStderr {
				data: text.to_owned(),
			})),
		}),
		None,
	)
}

/// Builds the ordered terminal shell frames: optional diagnostic, exit, result,
/// close.
pub fn shell_completion_frames(
	invocation: &CursorShellInvocation,
	completion: &CursorShellCompletion,
) -> Vec<wire::AgentClientMessage> {
	let mut frames = Vec::with_capacity(4);
	if let CursorShellCompletion::TimedOut { timeout_ms } = completion {
		frames.push(shell_stderr(invocation, &format!("Command timed out after {timeout_ms}ms")));
	}
	if matches!(completion, CursorShellCompletion::Rejected { .. }) {
		frames.push(exec_message(
			invocation,
			exec_client_message::Message::ShellStream(wire::ShellStream {
				event: Some(shell_stream::Event::Rejected(shell_rejected(invocation, completion))),
			}),
			None,
		));
	}
	if matches!(completion, CursorShellCompletion::PermissionDenied { .. }) {
		frames.push(exec_message(
			invocation,
			exec_client_message::Message::ShellStream(wire::ShellStream {
				event: Some(shell_stream::Event::PermissionDenied(shell_denied(
					invocation, completion,
				))),
			}),
			None,
		));
	}
	let (code, aborted, local_ms) = match completion {
		CursorShellCompletion::Exited { local_execution_time_ms, .. } => {
			(0, false, Some(*local_execution_time_ms as i32))
		},
		CursorShellCompletion::Failed { code, local_execution_time_ms, .. } => {
			(*code, false, Some(*local_execution_time_ms as i32))
		},
		CursorShellCompletion::Rejected { .. } | CursorShellCompletion::PermissionDenied { .. } => {
			(1, false, None)
		},
		CursorShellCompletion::TimedOut { .. } => (1, true, None),
	};
	frames.push(exec_message(
		invocation,
		exec_client_message::Message::ShellStream(wire::ShellStream {
			event: Some(shell_stream::Event::Exit(wire::ShellStreamExit {
				code,
				cwd: invocation.working_directory.as_str().to_owned(),
				output_location: None,
				aborted,
				abort_reason: None,
				local_execution_time_ms: local_ms,
			})),
		}),
		local_ms,
	));
	frames.push(exec_message(invocation, shell_result(invocation, completion), local_ms));
	frames.push(wire::AgentClientMessage {
		message: Some(agent_client_message::Message::ExecClientControlMessage(
			wire::ExecClientControlMessage {
				message: Some(exec_client_control_message::Message::StreamClose(
					wire::ExecClientStreamClose { id: invocation.id },
				)),
			},
		)),
	});
	frames
}

fn exec_message(
	invocation: &CursorShellInvocation,
	message: exec_client_message::Message,
	local_execution_time_ms: Option<i32>,
) -> wire::AgentClientMessage {
	wire::AgentClientMessage {
		message: Some(agent_client_message::Message::ExecClientMessage(wire::ExecClientMessage {
			id: invocation.id,
			exec_id: invocation.exec_id.as_str().to_owned(),
			message: Some(message),
			local_execution_time_ms,
			..Default::default()
		})),
	}
}

fn shell_result(
	invocation: &CursorShellInvocation,
	completion: &CursorShellCompletion,
) -> exec_client_message::Message {
	let result = match completion {
		CursorShellCompletion::Exited { stdout, stderr, local_execution_time_ms } => {
			shell_result::Result::Success(wire::ShellSuccess {
				command: invocation.command.as_str().to_owned(),
				working_directory: invocation.working_directory.as_str().to_owned(),
				exit_code: 0,
				stdout: stdout.as_str().to_owned(),
				stderr: stderr.as_str().to_owned(),
				execution_time: *local_execution_time_ms as i32,
				local_execution_time_ms: Some(*local_execution_time_ms as i32),
				..Default::default()
			})
		},
		CursorShellCompletion::Failed { code, stdout, stderr, local_execution_time_ms } => {
			shell_result::Result::Failure(wire::ShellFailure {
				command: invocation.command.as_str().to_owned(),
				working_directory: invocation.working_directory.as_str().to_owned(),
				exit_code: *code as i32,
				stdout: stdout.as_str().to_owned(),
				stderr: stderr.as_str().to_owned(),
				execution_time: *local_execution_time_ms as i32,
				local_execution_time_ms: Some(*local_execution_time_ms as i32),
				..Default::default()
			})
		},
		CursorShellCompletion::Rejected { .. } => {
			shell_result::Result::Rejected(shell_rejected(invocation, completion))
		},
		CursorShellCompletion::PermissionDenied { .. } => {
			shell_result::Result::PermissionDenied(shell_denied(invocation, completion))
		},
		CursorShellCompletion::TimedOut { timeout_ms } => {
			shell_result::Result::Timeout(wire::ShellTimeout {
				command:           invocation.command.as_str().to_owned(),
				working_directory: invocation.working_directory.as_str().to_owned(),
				timeout_ms:        *timeout_ms as i32,
			})
		},
	};
	exec_client_message::Message::ShellResult(wire::ShellResult {
		result: Some(result),
		..Default::default()
	})
}

fn shell_rejected(
	invocation: &CursorShellInvocation,
	completion: &CursorShellCompletion,
) -> wire::ShellRejected {
	let CursorShellCompletion::Rejected { reason, is_readonly } = completion else {
		unreachable!("shell_rejected called with another completion")
	};
	wire::ShellRejected {
		command:           invocation.command.as_str().to_owned(),
		working_directory: invocation.working_directory.as_str().to_owned(),
		reason:            reason.as_str().to_owned(),
		is_readonly:       *is_readonly,
	}
}

fn shell_denied(
	invocation: &CursorShellInvocation,
	completion: &CursorShellCompletion,
) -> wire::ShellPermissionDenied {
	let CursorShellCompletion::PermissionDenied { reason, is_readonly } = completion else {
		unreachable!("shell_denied called with another completion")
	};
	wire::ShellPermissionDenied {
		command:           invocation.command.as_str().to_owned(),
		working_directory: invocation.working_directory.as_str().to_owned(),
		error:             reason.as_str().to_owned(),
		is_readonly:       *is_readonly,
	}
}

/// Provider-specific output that cannot be represented as generative chat text.
#[derive(Debug)]
pub enum CursorEvent {
	/// Canonical generative event.
	Chat(Box<ChatEvent>),
	/// Complete but not yet schema-validated tool arguments.
	ToolCallComplete {
		/// Canonical block index.
		index:     u32,
		/// Tool-call identity.
		id:        ToolCallId,
		/// Tool name.
		name:      Str,
		/// Exact assembled argument bytes.
		arguments: Bytes,
	},
	/// Cursor requested shell execution.
	ShellInvoke(CursorShellInvocation),
	/// Cursor requested one edit-owned materialization operation.
	WorkflowInvoke {
		/// Provider invocation identity.
		invocation: Str,
		/// Stable operation name consumed by the Cursor bridge.
		name:       Str,
		/// JSON operation arguments.
		arguments:  Bytes,
	},
	/// Cursor cancelled one outstanding execution.
	InvokeCancel {
		/// Numeric Cursor correlation identifier.
		id: u32,
	},
	/// Authoritative provider checkpoint for session resume.
	Checkpoint {
		/// Encoded `ConversationStateStructure`.
		data: Bytes,
	},
	/// Correlated Cursor interaction query answered by the codec.
	InteractionQuery {
		/// Query correlation identifier.
		id:    u32,
		/// Generated typed query payload; `None` for an unnamed variant that
		/// was approved on its raw wire field.
		query: Option<wire::interaction_query::Query>,
		/// Prepared Connect-framed `AgentClientMessage` answer for the client
		/// stream; `None` when silence is the only honest reply (VM setup).
		reply: Option<Bytes>,
	},
	/// Terminal chat facts awaiting final receipt accounting.
	Completion {
		/// Normalized provider finish reason.
		reason: FinishReason,
		/// Number of canonical blocks emitted.
		blocks: u32,
		/// Final provider-reported usage.
		usage:  Usage,
	},
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OpenKind {
	Text,
	Thinking,
	Tool,
}

#[derive(Debug)]
struct OpenBlock {
	index:               u32,
	kind:                OpenKind,
	tool_id:             ToolCallId,
	tool_name:           Str,
	arguments:           BytesMut,
	announced_arguments: Option<Bytes>,
	edit_path:           Option<Str>,
	edit_text:           String,
	edit_inner_id:       ToolCallId,
}

/// Stateful protobuf projector for one Cursor Agent attempt.
#[derive(Debug, Default)]
pub struct CursorDecoder {
	open:       Option<OpenBlock>,
	next_index: u32,
	blocks:     u32,
	usage:      Usage,
	saw_usage:  bool,
	saw_tool:   bool,
	committed:  bool,
	progress:   bool,
	terminal:   bool,
	turn_ended: bool,
	cancelled:  bool,
}

impl CursorDecoder {
	/// Decodes one complete `AgentServerMessage` protobuf payload.
	pub fn push_payload(&mut self, payload: Bytes) -> Result<Vec<CursorEvent>, CursorProtocolError> {
		if self.cancelled {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Cancelled,
				"Cursor decoder is cancelled",
				self.committed,
			));
		}
		if self.terminal {
			return Err(CursorProtocolError::new(
				CursorErrorKind::AfterTerminal,
				"Cursor payload arrived after terminal completion",
				self.committed,
			));
		}
		if payload.len() > MAX_MESSAGE_BYTES {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Malformed,
				"Cursor protobuf message exceeds codec bound",
				self.committed,
			));
		}
		let message = wire::AgentServerMessage::decode(payload.clone()).map_err(|_| {
			CursorProtocolError::new(
				CursorErrorKind::Malformed,
				"malformed Cursor AgentServerMessage",
				self.committed,
			)
		})?;
		let heartbeat = matches!(
			message.message.as_ref(),
			Some(agent_server_message::Message::InteractionUpdate(update))
				if matches!(
					update.message.as_ref(),
					Some(interaction_update::Message::Heartbeat(_))
				)
		);
		self.progress |= !heartbeat;
		self.project(message, &payload)
	}

	/// Applies a Connect end-stream payload without exposing it as protobuf.
	pub fn push_end_stream(
		&mut self,
		payload: &[u8],
	) -> Result<Vec<CursorEvent>, CursorProtocolError> {
		if self.cancelled {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Cancelled,
				"Cursor decoder is cancelled",
				self.committed,
			));
		}
		let diagnostic = parse_connect_end_stream(payload).map_err(|_| {
			CursorProtocolError::new(
				CursorErrorKind::Malformed,
				"malformed Cursor Connect end-stream payload",
				self.committed,
			)
		})?;
		if let Some(diagnostic) = diagnostic {
			let code = diagnostic.code.as_str();
			let resource_exhausted = code.eq_ignore_ascii_case("resource_exhausted")
				|| code.eq_ignore_ascii_case("resource-exhausted")
				|| code.eq_ignore_ascii_case("resource exhausted")
				|| code == "8";
			let kind = if matches!(code, "context_length_exceeded" | "context_overflow") {
				CursorErrorKind::ContextOverflow
			} else if code.eq_ignore_ascii_case("not_found")
				|| code.eq_ignore_ascii_case("not-found")
				|| code.eq_ignore_ascii_case("not found")
				|| code == "5"
			{
				CursorErrorKind::ModelNotFound
			} else if resource_exhausted && is_cursor_plan_gate(&diagnostic) {
				CursorErrorKind::PlanGate
			} else if resource_exhausted {
				CursorErrorKind::ResourceExhausted
			} else {
				CursorErrorKind::Upstream
			};
			let reason = match kind {
				CursorErrorKind::ModelNotFound => "cursor_model_not_found",
				CursorErrorKind::PlanGate => "cursor_plan_gate",
				_ => "cursor_connect_end_stream_error",
			};
			let mut error = CursorProtocolError::new(kind, reason, self.committed);
			error.diagnostic = Some(diagnostic);
			return Err(error);
		}
		self.terminal = true;
		Ok(Vec::new())
	}

	/// Marks local cancellation and prevents late provider frames from
	/// surfacing.
	pub fn cancel(&mut self) {
		self.cancelled = true;
		self.open = None;
	}

	/// Verifies that the attempt reached a protocol terminal.
	pub const fn finish(&mut self) -> Result<(), CursorProtocolError> {
		if self.cancelled || self.terminal {
			return Ok(());
		}
		Err(CursorProtocolError::new(
			CursorErrorKind::Truncated,
			"Cursor stream ended before terminal completion",
			self.committed,
		))
	}

	const fn saw_token_delta(&self) -> bool {
		self.saw_usage
	}

	const fn saw_server_progress(&self) -> bool {
		self.progress
	}

	const fn completed_turn(&self) -> bool {
		self.turn_ended
	}

	fn project(
		&mut self,
		message: wire::AgentServerMessage,
		payload: &[u8],
	) -> Result<Vec<CursorEvent>, CursorProtocolError> {
		match message.message {
			Some(agent_server_message::Message::InteractionUpdate(update)) => {
				self.project_interaction(update)
			},
			Some(agent_server_message::Message::ExecServerMessage(exec)) => {
				let events = self.project_exec(exec)?;
				self.committed |= !events.is_empty();
				Ok(events)
			},
			Some(agent_server_message::Message::ExecServerControlMessage(control)) => {
				let Some(exec_server_control_message::Message::Abort(abort)) = control.message else {
					return Ok(Vec::new());
				};
				self.committed = true;
				Ok(vec![CursorEvent::InvokeCancel { id: abort.id }])
			},
			Some(agent_server_message::Message::ConversationCheckpointUpdate(checkpoint)) => {
				self.committed = true;
				Ok(vec![CursorEvent::Checkpoint { data: Bytes::from(checkpoint.encode_to_vec()) }])
			},
			Some(agent_server_message::Message::InteractionQuery(query)) => {
				let events = project_interaction_query(query, payload);
				self.committed |= !events.is_empty();
				Ok(events)
			},
			Some(agent_server_message::Message::KvServerMessage(_)) | None => Ok(Vec::new()),
		}
	}

	fn project_interaction(
		&mut self,
		update: wire::InteractionUpdate,
	) -> Result<Vec<CursorEvent>, CursorProtocolError> {
		let mut events = Vec::with_capacity(3);
		match update.message {
			Some(interaction_update::Message::TextDelta(delta)) => {
				self.push_text(OpenKind::Text, delta.text, &mut events);
			},
			Some(interaction_update::Message::ThinkingDelta(delta)) => {
				self.push_text(OpenKind::Thinking, delta.text, &mut events);
			},
			Some(interaction_update::Message::ToolCallStarted(started)) => {
				self.start_tool(started.call_id, started.tool_call.as_ref(), &mut events);
			},
			Some(interaction_update::Message::PartialToolCall(partial)) => {
				let id = call_id(partial.call_id, partial.tool_call.as_ref());
				if !matches!(self.open.as_ref(), Some(open) if open.kind == OpenKind::Tool && open.tool_id == id)
				{
					self.start_tool(id.as_str().to_owned(), partial.tool_call.as_ref(), &mut events);
				}
				if let Some(open) = self.open.as_mut()
					&& !partial.args_text_delta.is_empty()
				{
					let snapshot = partial.args_text_delta.as_bytes();
					let chunk = snapshot
						.strip_prefix(open.arguments.as_ref())
						.unwrap_or(snapshot);
					if !chunk.is_empty() {
						open.arguments.extend_from_slice(chunk);
						events.push(CursorEvent::Chat(Box::new(ChatEvent::ToolArgumentsDelta {
							index: open.index,
							bytes: Bytes::copy_from_slice(chunk),
						})));
						self.committed = true;
					}
				}
			},
			Some(interaction_update::Message::ToolCallDelta(delta)) => {
				if let Some(open) = self.open.as_mut()
					&& let Some(tool_delta) = delta.tool_call_delta.as_ref()
					&& let Some(tool_call_delta::Delta::EditToolCallDelta(edit)) =
						tool_delta.delta.as_ref()
				{
					open.edit_text.push_str(&edit.stream_content_delta);
				}
			},
			Some(interaction_update::Message::ToolCallCompleted(completed)) => {
				let id = call_id(completed.call_id, completed.tool_call.as_ref());
				let completion_arguments = tool_arguments(completed.tool_call.as_ref());
				if let Some(open) = self.open.take() {
					if open.kind != OpenKind::Tool || (!id.as_str().is_empty() && open.tool_id != id) {
						self.open = Some(open);
						return Err(CursorProtocolError::new(
							CursorErrorKind::Malformed,
							"Cursor completed a different tool call",
							self.committed,
						));
					}
					let index = open.index;
					let id = open.tool_id.clone();
					let name = open.tool_name.clone();
					let arguments = open_tool_arguments(open, completion_arguments);
					events.push(CursorEvent::ToolCallComplete { index, id, name, arguments });
				}
			},
			Some(interaction_update::Message::TokenDelta(delta)) => {
				self.usage.output_tokens = self
					.usage
					.output_tokens
					.saturating_add(delta.tokens.max(0) as u64);
				self.usage.source = UsageSource::Provider;
				self.saw_usage = true;
			},
			Some(interaction_update::Message::TurnEnded(_)) => {
				if let Some(event) = self.flush_open_tool_call() {
					events.push(event);
				}
				if self.saw_usage {
					events.push(CursorEvent::Chat(Box::new(ChatEvent::Usage(UsageUpdate {
						usage:        self.usage,
						final_update: true,
					}))));
				}
				events.push(CursorEvent::Completion {
					reason: if self.saw_tool {
						FinishReason::ToolCalls
					} else {
						FinishReason::Stop
					},
					blocks: self.blocks,
					usage:  self.usage,
				});
				self.committed = true;
				self.terminal = true;
				self.turn_ended = true;
			},
			Some(
				interaction_update::Message::ThinkingCompleted(_)
				| interaction_update::Message::UserMessageAppended(_)
				| interaction_update::Message::Summary(_)
				| interaction_update::Message::SummaryStarted(_)
				| interaction_update::Message::SummaryCompleted(_)
				| interaction_update::Message::ShellOutputDelta(_)
				| interaction_update::Message::Heartbeat(_)
				| interaction_update::Message::StepStarted(_)
				| interaction_update::Message::StepCompleted(_),
			)
			| None => {},
		}
		Ok(events)
	}

	fn project_exec(
		&self,
		exec: wire::ExecServerMessage,
	) -> Result<Vec<CursorEvent>, CursorProtocolError> {
		let fallback_invocation = Str::new(exec.id.to_string());
		match exec.message {
			Some(exec_server_message::Message::ReadArgs(args))
				if self.edit_owns(args.tool_call_id.as_str()) =>
			{
				let invocation = if args.tool_call_id.is_empty() {
					fallback_invocation
				} else {
					Str::new(args.tool_call_id.as_str())
				};
				let path = cursor_edit_read_path(&args.path, args.offset, args.limit);
				let arguments = Bytes::from(
					serde_json::to_vec(&serde_json::json!({
						"path": path,
						"tool_call_id": args.tool_call_id,
					}))
					.expect("Cursor read arguments contain only strings"),
				);
				Ok(vec![CursorEvent::WorkflowInvoke { invocation, name: sf!("read"), arguments }])
			},
			Some(exec_server_message::Message::WriteArgs(args))
				if self.edit_owns(args.tool_call_id.as_str()) =>
			{
				let invocation = if args.tool_call_id.is_empty() {
					fallback_invocation
				} else {
					Str::new(args.tool_call_id.as_str())
				};
				let content = if args.file_text.is_empty() && !args.file_bytes.is_empty() {
					String::from_utf8_lossy(&args.file_bytes).into_owned()
				} else {
					args.file_text
				};
				let arguments = Bytes::from(
					serde_json::to_vec(&serde_json::json!({
						"path": args.path,
						"content": content,
						"tool_call_id": args.tool_call_id,
					}))
					.expect("Cursor write arguments contain only strings"),
				);
				Ok(vec![CursorEvent::WorkflowInvoke { invocation, name: sf!("write"), arguments }])
			},
			message => {
				Ok(vec![CursorEvent::ShellInvoke(shell_invocation(wire::ExecServerMessage {
					message,
					..exec
				})?)])
			},
		}
	}

	fn edit_owns(&self, tool_call_id: &str) -> bool {
		self.open.as_ref().is_some_and(|open| {
			open.edit_path.is_some()
				&& (open.tool_id.as_str() == tool_call_id
					|| open.edit_inner_id.as_str() == tool_call_id)
		})
	}

	fn push_text(&mut self, kind: OpenKind, text: String, events: &mut Vec<CursorEvent>) {
		let index = if let Some(open) = self.open.as_ref().filter(|open| open.kind == kind) {
			open.index
		} else {
			let index = self.start_block(kind, ToolCallId::default(), Str::default());
			events.push(CursorEvent::Chat(Box::new(ChatEvent::BlockStarted {
				index,
				kind: if kind == OpenKind::Text {
					BlockKind::Text
				} else {
					BlockKind::Thinking
				},
			})));
			self.committed = true;
			index
		};
		if text.is_empty() {
			return;
		}
		let text = Str::new(text);
		events.push(CursorEvent::Chat(Box::new(if kind == OpenKind::Text {
			ChatEvent::TextDelta { index, text }
		} else {
			ChatEvent::ThinkingDelta { index, text }
		})));
		self.committed = true;
	}

	fn start_tool(
		&mut self,
		call_id_text: String,
		tool: Option<&wire::ToolCall>,
		events: &mut Vec<CursorEvent>,
	) {
		let id = call_id(call_id_text, tool);
		let name = tool_name(tool);
		let announced_arguments = mcp_tool_arguments(tool);
		let (edit_path, edit_text) = edit_tool_state(tool);
		let edit_inner_id = ToolCallId::from(
			tool
				.and_then(|tool| tool.tool_call_id.as_deref())
				.unwrap_or_default(),
		);
		let index = self.start_block(OpenKind::Tool, id.clone(), name.clone());
		if let Some(open) = self.open.as_mut() {
			open.announced_arguments = announced_arguments;
			open.edit_path = edit_path;
			open.edit_text = edit_text;
			open.edit_inner_id = edit_inner_id;
		}
		self.saw_tool = true;
		events.push(CursorEvent::Chat(Box::new(ChatEvent::BlockStarted {
			index,
			kind: BlockKind::ToolCall,
		})));
		events.push(CursorEvent::Chat(Box::new(ChatEvent::ToolCallStarted { index, id, name })));
		self.committed = true;
	}

	fn flush_open_tool_call(&mut self) -> Option<CursorEvent> {
		let open = self.open.take()?;
		(open.kind == OpenKind::Tool).then(|| CursorEvent::ToolCallComplete {
			index:     open.index,
			id:        open.tool_id.clone(),
			name:      open.tool_name.clone(),
			arguments: open_tool_arguments(open, None),
		})
	}

	fn start_block(&mut self, kind: OpenKind, tool_id: ToolCallId, tool_name: Str) -> u32 {
		let index = self.next_index;
		self.next_index = self.next_index.saturating_add(1);
		self.blocks = self.blocks.saturating_add(1);
		self.open = Some(OpenBlock {
			index,
			kind,
			tool_id,
			tool_name,
			arguments: BytesMut::new(),
			announced_arguments: None,
			edit_path: None,
			edit_text: String::new(),
			edit_inner_id: ToolCallId::default(),
		});
		index
	}
}

fn is_cursor_plan_gate(diagnostic: &ConnectErrorDiagnostic) -> bool {
	diagnostic
		.details
		.iter()
		.any(|detail| cursor_plan_gate_evidence(&detail.evidence))
		|| diagnostic
			.fallback
			.as_ref()
			.is_some_and(cursor_plan_gate_evidence)
}

fn cursor_plan_gate_evidence(evidence: &serde_json::Value) -> bool {
	fn has_marker(value: &serde_json::Value) -> bool {
		let Some(object) = value.as_object() else {
			return false;
		};
		object.iter().any(|(name, value)| {
			if matches!(name.as_str(), "error" | "reason") {
				return value
					.as_str()
					.is_some_and(|value| value.eq_ignore_ascii_case("ERROR_RATE_LIMITED_CHANGEABLE"));
			}
			matches!(value, serde_json::Value::Object(_)) && has_marker(value)
				|| matches!(value, serde_json::Value::Array(_))
					&& value
						.as_array()
						.is_some_and(|values| values.iter().any(has_marker))
		})
	}

	fn has_plan_scope(value: &serde_json::Value) -> bool {
		let Some(object) = value.as_object() else {
			return false;
		};
		object.iter().any(|(name, value)| {
			if matches!(name.as_str(), "title" | "detail")
				&& let Some(text) = value.as_str()
			{
				return ["Named models unavailable", "Model unavailable on", "Free plans can only use"]
					.iter()
					.any(|prefix| starts_with_ascii_case_insensitive(text, prefix));
			}
			matches!(value, serde_json::Value::Object(_)) && has_plan_scope(value)
				|| matches!(value, serde_json::Value::Array(_))
					&& value
						.as_array()
						.is_some_and(|values| values.iter().any(has_plan_scope))
		})
	}

	has_marker(evidence) && has_plan_scope(evidence)
}

fn starts_with_ascii_case_insensitive(value: &str, prefix: &str) -> bool {
	value
		.get(..prefix.len())
		.is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
}

fn shell_invocation(
	exec: wire::ExecServerMessage,
) -> Result<CursorShellInvocation, CursorProtocolError> {
	let (args, streaming) = match exec.message {
		Some(exec_server_message::Message::ShellArgs(args)) => (args, false),
		Some(exec_server_message::Message::ShellStreamArgs(args)) => (args, true),
		_ => {
			return Err(CursorProtocolError::new(
				CursorErrorKind::Unsupported,
				"Cursor requested an unsupported exec operation",
				false,
			));
		},
	};
	Ok(CursorShellInvocation {
		id: exec.id,
		exec_id: Str::new(exec.exec_id),
		call_id: ToolCallId::from(args.tool_call_id),
		command: Str::new(args.command),
		working_directory: Str::new(args.working_directory),
		timeout_ms: args.timeout.max(0) as u32,
		streaming,
	})
}

fn cursor_edit_read_path(path: &str, offset: Option<i32>, limit: Option<u32>) -> String {
	let has_raw = path
		.split(':')
		.any(|component| component.eq_ignore_ascii_case("raw"));
	let mut output = if has_raw {
		path.to_owned()
	} else {
		format!("{path}:raw")
	};
	match (offset, limit) {
		(Some(offset), Some(limit)) => {
			output.push_str(&format!(":{}+{limit}", offset.max(1)));
		},
		(Some(offset), None) => output.push_str(&format!(":{}-", offset.max(1))),
		(None, Some(limit)) => output.push_str(&format!(":1+{limit}")),
		(None, None) => {},
	}
	output
}

fn mcp_tool_arguments(tool: Option<&wire::ToolCall>) -> Option<Bytes> {
	use tool_call::Tool;
	let Some(Tool::McpToolCall(call)) = tool.and_then(|tool| tool.tool.as_ref()) else {
		return None;
	};
	let args = call.args.as_ref()?;
	let fields = args
		.args
		.iter()
		.map(|(name, value)| (name.clone(), decode_mcp_arg_value(value)))
		.collect();
	serde_json::to_vec(&serde_json::Value::Object(fields))
		.ok()
		.map(Bytes::from)
}

fn tool_arguments(tool: Option<&wire::ToolCall>) -> Option<Bytes> {
	edit_tool_arguments(tool).or_else(|| mcp_tool_arguments(tool))
}

fn edit_tool_state(tool: Option<&wire::ToolCall>) -> (Option<Str>, String) {
	use tool_call::Tool;
	let Some(Tool::EditToolCall(call)) = tool.and_then(|tool| tool.tool.as_ref()) else {
		return (None, String::new());
	};
	let Some(args) = call.args.as_ref() else {
		return (Some(Str::default()), String::new());
	};
	(
		Some(Str::new(args.path.as_str())),
		args
			.stream_content
			.as_deref()
			.unwrap_or_default()
			.to_owned(),
	)
}

fn edit_tool_arguments(tool: Option<&wire::ToolCall>) -> Option<Bytes> {
	use tool_call::Tool;
	let Some(Tool::EditToolCall(call)) = tool.and_then(|tool| tool.tool.as_ref()) else {
		return None;
	};
	let args = call.args.as_ref()?;
	Some(edit_arguments(&args.path, args.stream_content.as_deref().unwrap_or_default()))
}

fn edit_open_arguments(open: &OpenBlock) -> Bytes {
	edit_arguments(open.edit_path.as_ref().map_or("", |path| path.as_str()), &open.edit_text)
}

fn edit_arguments(path: &str, stream_content: &str) -> Bytes {
	let mut arguments = serde_json::Map::new();
	if !path.is_empty() {
		arguments.insert("path".to_owned(), serde_json::Value::String(path.to_owned()));
	}
	if !stream_content.is_empty() {
		arguments
			.insert("stream_content".to_owned(), serde_json::Value::String(stream_content.to_owned()));
	}
	Bytes::from(
		serde_json::to_vec(&serde_json::Value::Object(arguments))
			.expect("Cursor edit arguments contain only strings"),
	)
}

fn open_tool_arguments(open: OpenBlock, completion: Option<Bytes>) -> Bytes {
	if open.edit_path.is_some() {
		return completion.unwrap_or_else(|| edit_open_arguments(&open));
	}
	if !open.arguments.is_empty() {
		if let Some(completion) = completion {
			return merge_mcp_arguments(&open.arguments, completion);
		}
		return open.arguments.freeze();
	}
	completion
		.or(open.announced_arguments)
		.unwrap_or_else(|| Bytes::from_static(b"{}"))
}

fn merge_mcp_arguments(streamed: &[u8], completion: Bytes) -> Bytes {
	let Ok(serde_json::Value::Object(mut merged)) =
		serde_json::from_slice::<serde_json::Value>(streamed)
	else {
		return completion;
	};
	let Ok(serde_json::Value::Object(completed)) =
		serde_json::from_slice::<serde_json::Value>(&completion)
	else {
		return completion;
	};
	for (name, value) in completed {
		let downgraded = value.is_string()
			&& matches!(
				merged.get(&name),
				Some(serde_json::Value::Object(_) | serde_json::Value::Array(_))
			);
		if !downgraded {
			merged.insert(name, value);
		}
	}
	Bytes::from(
		serde_json::to_vec(&serde_json::Value::Object(merged))
			.expect("serde_json::Value always serializes"),
	)
}

fn decode_mcp_arg_value(value: &[u8]) -> serde_json::Value {
	let value = decode_json_value(value)
		.or_else(|| serde_json::from_slice(value).ok())
		.unwrap_or_else(|| serde_json::Value::String(String::from_utf8_lossy(value).into_owned()));
	if let serde_json::Value::String(text) = value {
		match text.trim_start().as_bytes().first() {
			Some(b'{' | b'[' | b'"') => {
				serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text))
			},
			_ => serde_json::Value::String(text),
		}
	} else {
		value
	}
}

fn call_id(call_id: String, tool: Option<&wire::ToolCall>) -> ToolCallId {
	if call_id.is_empty() {
		ToolCallId::from(
			tool
				.and_then(|tool| tool.tool_call_id.as_deref())
				.unwrap_or_default(),
		)
	} else {
		ToolCallId::from(call_id)
	}
}

fn tool_name(tool: Option<&wire::ToolCall>) -> Str {
	use tool_call::Tool;
	let Some(tool) = tool.and_then(|tool| tool.tool.as_ref()) else {
		return Str::default();
	};
	let name = match tool {
		Tool::ShellToolCall(_) | Tool::PiBashToolCall(_) => "bash",
		Tool::DeleteToolCall(_) => "delete",
		Tool::GlobToolCall(_) => "glob",
		Tool::GrepToolCall(_) | Tool::PiGrepToolCall(_) => "grep",
		Tool::ReadToolCall(_) | Tool::PiReadToolCall(_) => "read",
		Tool::UpdateTodosToolCall(_) => "update_todos",
		Tool::ReadTodosToolCall(_) => "read_todos",
		Tool::EditToolCall(_) | Tool::PiEditToolCall(_) => "edit",
		Tool::LsToolCall(_) | Tool::PiLsToolCall(_) => "ls",
		Tool::ReadLintsToolCall(_) => "read_lints",
		Tool::McpToolCall(call) => {
			return call.args.as_ref().map_or_else(Str::default, |args| {
				Str::new(if args.tool_name.is_empty() {
					args.name.as_str()
				} else {
					args.tool_name.as_str()
				})
			});
		},
		Tool::SemSearchToolCall(_) => "sem_search",
		Tool::CreatePlanToolCall(_) => "create_plan",
		Tool::WebSearchToolCall(_) => "web_search",
		Tool::TaskToolCall(_) => "task",
		Tool::ListMcpResourcesToolCall(_) => "list_mcp_resources",
		Tool::ReadMcpResourceToolCall(_) => "read_mcp_resource",
		Tool::ApplyAgentDiffToolCall(_) => "apply_agent_diff",
		Tool::AskQuestionToolCall(_) => "ask_question",
		Tool::FetchToolCall(_) | Tool::WebFetchToolCall(_) => "fetch",
		Tool::SwitchModeToolCall(_) => "switch_mode",
		Tool::ExaSearchToolCall(_) => "exa_search",
		Tool::ExaFetchToolCall(_) => "exa_fetch",
		Tool::GenerateImageToolCall(_) => "generate_image",
		Tool::RecordScreenToolCall(_) => "record_screen",
		Tool::ComputerUseToolCall(_) => "computer_use",
		Tool::WriteShellStdinToolCall(_) => "write_shell_stdin",
		Tool::ReflectToolCall(_) => "reflect",
		Tool::SetupVmEnvironmentToolCall(_) => "setup_vm_environment",
		Tool::TruncatedToolCall(_) => "truncated",
		Tool::StartGrindExecutionToolCall(_) => "start_grind_execution",
		Tool::StartGrindPlanningToolCall(_) => "start_grind_planning",
		Tool::PiWriteToolCall(_) => "write",
		Tool::PiFindToolCall(_) => "find",
		Tool::ConnectScmToolCall(_) => "connect_scm",
		Tool::SearchConversationsToolCall(_) => "search_conversations",
	};
	sf!(name)
}

/// Rejection-reason suffix answered for interactive queries this client does
/// not implement.
pub const NOT_IMPLEMENTED_SUFFIX: &str = "not implemented by this client";

/// Field number of `AgentServerMessage.interaction_query`.
const INTERACTION_QUERY_FIELD: u32 = 7;
/// Field number of `AgentClientMessage.interaction_response`.
const INTERACTION_RESPONSE_FIELD: u32 = 6;

/// Projects one decoded `InteractionQuery` into its answered codec event.
///
/// `payload` is the raw `AgentServerMessage` protobuf: when the query variant
/// is not named by the schema, prost drops it into the void, so the raw bytes
/// are rescanned for the unnamed permission gate that must still be approved.
/// A query with no variant at all is dropped rather than answered blindly.
fn project_interaction_query(query: wire::InteractionQuery, payload: &[u8]) -> Vec<CursorEvent> {
	let id = query.id;
	if let Some(named) = query.query {
		let reply = interaction_query_response(id, &named).map(|response| {
			connect_message(&wire::AgentClientMessage {
				message: Some(agent_client_message::Message::InteractionResponse(response)),
			})
		});
		vec![CursorEvent::InteractionQuery { id, query: Some(named), reply }]
	} else {
		let Some(field) =
			raw_len_field(payload, INTERACTION_QUERY_FIELD).and_then(first_unknown_query_field)
		else {
			return Vec::new();
		};
		vec![CursorEvent::InteractionQuery {
			id,
			query: None,
			reply: Some(connect_raw_message(&unknown_interaction_query_response(id, field))),
		}]
	}
}

/// Builds the typed client answer for one named Cursor interaction query.
///
/// Network permission gates (hosted web search, Exa search/fetch, hosted
/// `WebFetch`) are approved so the Run stream is not stranded on heartbeats
/// until the idle watchdog aborts. Interactive queries (ask-question, mode
/// switch, plan creation) are rejected so the server can route around the
/// capability. VM setup returns `None`: its result oneof is success-only and
/// a fake `SetupVmEnvironmentSuccess` is worse than silence.
pub fn interaction_query_response(
	id: u32,
	query: &wire::interaction_query::Query,
) -> Option<wire::InteractionResponse> {
	use wire::{interaction_query::Query, interaction_response::Result as Reply};
	let result = match query {
		Query::WebSearchRequestQuery(_) => {
			Reply::WebSearchRequestResponse(wire::WebSearchRequestResponse {
				result: Some(web_search_request_response::Result::Approved(
					wire::WebSearchRequestResponseApproved {},
				)),
			})
		},
		Query::ExaSearchRequestQuery(_) => {
			Reply::ExaSearchRequestResponse(wire::ExaSearchRequestResponse {
				result: Some(exa_search_request_response::Result::Approved(
					wire::ExaSearchRequestResponseApproved {},
				)),
			})
		},
		Query::ExaFetchRequestQuery(_) => {
			Reply::ExaFetchRequestResponse(wire::ExaFetchRequestResponse {
				result: Some(exa_fetch_request_response::Result::Approved(
					wire::ExaFetchRequestResponseApproved {},
				)),
			})
		},
		Query::WebFetchRequestQuery(_) => {
			Reply::WebFetchRequestResponse(wire::WebFetchRequestResponse {
				result: Some(web_fetch_request_response::Result::Approved(
					wire::WebFetchRequestResponseApproved {},
				)),
			})
		},
		Query::AskQuestionInteractionQuery(_) => {
			Reply::AskQuestionInteractionResponse(wire::AskQuestionInteractionResponse {
				result: Some(wire::AskQuestionResult {
					result: Some(ask_question_result::Result::Rejected(wire::AskQuestionRejected {
						reason: format!("Interactive questions are {NOT_IMPLEMENTED_SUFFIX}"),
					})),
				}),
			})
		},
		Query::SwitchModeRequestQuery(_) => {
			Reply::SwitchModeRequestResponse(wire::SwitchModeRequestResponse {
				result: Some(switch_mode_request_response::Result::Rejected(
					wire::SwitchModeRequestResponseRejected {
						reason: format!("Mode switches are {NOT_IMPLEMENTED_SUFFIX}"),
					},
				)),
			})
		},
		Query::CreatePlanRequestQuery(_) => {
			Reply::CreatePlanRequestResponse(wire::CreatePlanRequestResponse {
				result: Some(wire::CreatePlanResult {
					plan_uri: String::new(),
					result:   Some(create_plan_result::Result::Error(wire::CreatePlanError {
						error: format!("Plan files are {NOT_IMPLEMENTED_SUFFIX}"),
					})),
				}),
			})
		},
		// The result oneof is success-only; do not invent a VM.
		Query::SetupVmEnvironmentArgs(_) => return None,
	};
	Some(wire::InteractionResponse { id, result: Some(result) })
}

/// Encodes the raw `approved {}` answer for an unnamed interaction-query
/// variant as one complete `AgentClientMessage`.
///
/// The reply mirrors the query's own field number inside the response oneof.
/// The embedded variant message (`approved` on field 1, empty payload) MUST
/// be length-prefixed: writing bare `0a 00` after the tag produces a frame
/// the server cannot decode, because the `0a` is read as the length.
pub fn unknown_interaction_query_response(id: u32, field: u32) -> Vec<u8> {
	use prost::encoding::{WireType, encode_key, encode_varint};
	let mut response = BytesMut::with_capacity(16);
	encode_key(1, WireType::Varint, &mut response);
	encode_varint(u64::from(id), &mut response);
	encode_key(field, WireType::LengthDelimited, &mut response);
	// `approved {}`: length 2, then field 1 with an empty LEN payload.
	response.put_slice(&[0x02, 0x0a, 0x00]);
	let mut client = BytesMut::with_capacity(response.len() + 4);
	encode_key(INTERACTION_RESPONSE_FIELD, WireType::LengthDelimited, &mut client);
	encode_varint(response.len() as u64, &mut client);
	client.put_slice(&response);
	client.to_vec()
}

/// Adds a Connect data envelope around already-encoded protobuf bytes.
fn connect_raw_message(payload: &[u8]) -> Bytes {
	let mut bytes = BytesMut::with_capacity(payload.len() + 5);
	bytes.put_u8(0);
	bytes
		.put_u32(u32::try_from(payload.len()).expect("Cursor protobuf message exceeds u32 framing"));
	bytes.put_slice(payload);
	bytes.freeze()
}

/// Returns the raw bytes of the first length-delimited `want` field in `buf`.
fn raw_len_field(mut buf: &[u8], want: u32) -> Option<&[u8]> {
	use prost::encoding::{DecodeContext, WireType, decode_key, decode_varint, skip_field};
	while !buf.is_empty() {
		let (field, wire_type) = decode_key(&mut buf).ok()?;
		if wire_type == WireType::LengthDelimited && field == want {
			let length = usize::try_from(decode_varint(&mut buf).ok()?).ok()?;
			return buf.get(..length);
		}
		skip_field(wire_type, field, &mut buf, DecodeContext::default()).ok()?;
	}
	None
}

/// Finds the unnamed permission-gate variant inside raw `InteractionQuery`
/// bytes: the first length-delimited field past the `id` scalar.
fn first_unknown_query_field(mut buf: &[u8]) -> Option<u32> {
	use prost::encoding::{DecodeContext, WireType, decode_key, skip_field};
	while !buf.is_empty() {
		let (field, wire_type) = decode_key(&mut buf).ok()?;
		if wire_type == WireType::LengthDelimited && field >= 2 {
			return Some(field);
		}
		skip_field(wire_type, field, &mut buf, DecodeContext::default()).ok()?;
	}
	None
}

/// Sans-I/O Cursor Agent codec registered under the catalog codec id `cursor`,
/// carrying discovered-model fallback and poisoned-conversation recovery state
/// across attempts.
#[derive(Clone, Debug, Default)]
pub struct CursorCodec {
	conversations: Arc<Mutex<CursorConversationRotations>>,
}

#[derive(Clone, Debug)]
struct CursorConversationAttempt {
	base:                Str,
	wire:                Str,
	seed:                Str,
	fallback_wire_model: Option<Str>,
}

#[derive(Debug, Default)]
struct CursorConversationRotations {
	// Deliberately retain only recovery routing facts. Provider checkpoints are
	// never migrated to a rotated id; the next encode rebuilds from the canonical
	// request and sends a user-message action.
	rotated:              BTreeMap<Str, Str>,
	successful_rotations: BTreeSet<Str>,
	pending:              BTreeMap<RequestId, CursorConversationAttempt>,
	fallbacks:            BTreeMap<Str, Str>,
}

impl CursorConversationRotations {
	fn resolve(&self, base: &Str) -> Str {
		self
			.rotated
			.get(base)
			.cloned()
			.unwrap_or_else(|| base.clone())
	}

	fn begin(
		&mut self,
		request: &RequestId<str>,
		base: &Str,
		discovered_model: &Str,
	) -> (Str, CursorWireMode) {
		let wire = self.resolve(base);
		let request_key = Str::new(request.as_str());
		let wire_mode = match self.fallbacks.remove(&request_key) {
			Some(model) if model == *discovered_model => CursorWireMode::Discovered,
			_ => CursorWireMode::Normalized,
		};
		self
			.pending
			.insert(RequestId::from(request), CursorConversationAttempt {
				base:                base.clone(),
				wire:                wire.clone(),
				seed:                request_key,
				fallback_wire_model: None,
			});
		(wire, wire_mode)
	}

	fn set_fallback_wire_model(&mut self, request: &RequestId<str>, model: Option<Str>) {
		if let Some(attempt) = self.pending.get_mut(request) {
			attempt.fallback_wire_model = model;
		}
	}

	fn take(&mut self, request: &RequestId<str>) -> Option<CursorConversationAttempt> {
		self.pending.remove(request)
	}

	fn schedule_fallback(&mut self, attempt: &CursorConversationAttempt) -> bool {
		let Some(model) = attempt.fallback_wire_model.as_ref() else {
			return false;
		};
		self.fallbacks.insert(attempt.seed.clone(), model.clone());
		true
	}

	fn rotate(&mut self, base: &Str, seed: &str) -> bool {
		if self.rotated.contains_key(base) && !self.rotation_reusable(base) {
			return false;
		}
		if let Some(current) = self.rotated.get(base) {
			self.successful_rotations.remove(current);
		}
		let rotated = sf!("cursor-rotated-{seed}");
		if self.rotated.get(base) == Some(&rotated) {
			return false;
		}
		self.rotated.insert(base.clone(), rotated);
		true
	}

	fn mark_clean(&mut self, attempt: &CursorConversationAttempt) {
		if attempt.wire == attempt.base {
			return;
		}
		if self.rotated.get(&attempt.base) == Some(&attempt.wire) {
			self.successful_rotations.insert(attempt.wire.clone());
		}
	}

	fn rotation_reusable(&self, base: &Str) -> bool {
		let Some(wire) = self.rotated.get(base) else {
			return false;
		};
		self.successful_rotations.contains(wire)
	}
}

impl CursorCodec {
	/// Constructs a Cursor codec with isolated conversation recovery state.
	pub fn new() -> Self {
		Self::default()
	}
}

impl Codec for CursorCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		match operation {
			OperationCall::Chat(request) => encode_chat_call(context, request, &self.conversations),
			OperationCall::DiscoverModels(request) => {
				if request.cursor.is_some() {
					return Err(encoding_error("cursor_discovery_has_no_pagination"));
				}
				let mut headers = Vec::with_capacity(6);
				for_each_public_header(CursorHeaderProfile::Discovery, |name, value| {
					headers.push(RequestHeader { name: sf!(name), value: sf!(value) });
				});
				Ok(EncodedRequest::new(
					OperationKind::DiscoverModels,
					RequestMethod::Post,
					endpoint_uri(context.route.endpoint.base_url.as_str(), DISCOVERY_PATH),
					headers.into_boxed_slice(),
					BodySource::bytes(encode_discovery_request(&[])),
					FramingProtocol::Raw,
					cursor_bounds(),
				))
			},
			_ => Err(encoding_error("cursor_operation_not_supported")),
		}
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if !matches!(context.operation, OperationKind::Chat | OperationKind::DiscoverModels) {
			return Err(encoding_error("cursor_operation_not_supported"));
		}
		let conversation = (context.operation == OperationKind::Chat)
			.then(|| self.conversations.lock().take(context.request_id))
			.flatten();
		Ok(Box::new(CursorWireDecoder {
			operation: context.operation,
			provider: context.provider.clone(),
			route: context.route.clone(),
			agent: CursorDecoder::default(),
			discovery_done: false,
			conversations: Arc::clone(&self.conversations),
			conversation,
		}))
	}
}

fn encode_chat_call(
	context: &EncodeContext<'_>,
	request: &ChatRequest,
	conversations: &Arc<Mutex<CursorConversationRotations>>,
) -> Result<EncodedRequest, Error> {
	reject_unprojected_chat_options(request, context.thinking_selection.is_some())?;
	let mut roots = Vec::new();
	let mut user = None;
	let target = context
		.target
		.ok_or_else(|| encoding_error("cursor_chat_requires_wire_target"))?;
	for message in request.messages.iter() {
		if message.name.is_some() {
			return Err(encoding_error("cursor_named_message_not_supported"));
		}
		let text = cursor_message_text(context, message.content.as_ref())?;
		match message.role {
			Role::System => roots.push(CursorRootPrompt { role: CursorPromptRole::System, text }),
			Role::Developer => {
				roots.push(CursorRootPrompt { role: CursorPromptRole::Developer, text });
			},
			Role::User if user.is_none() => user = Some(text),
			Role::User => return Err(encoding_error("cursor_requires_delta_or_checkpoint_context")),
			Role::Assistant | Role::Tool => {
				return Err(encoding_error("cursor_requires_provider_checkpoint_for_history"));
			},
		}
	}
	let user = user.ok_or_else(|| encoding_error("cursor_chat_requires_user_message"))?;
	let tools = request
		.tools
		.iter()
		.map(|tool| {
			let (parameters, _) = tool.input.wire_schema();
			Ok(CursorToolDefinition {
				name:         tool.name.clone(),
				description:  tool.description.clone(),
				input_schema: encode_json_value(parameters.as_value())?,
			})
		})
		.collect::<Result<Vec<_>, Error>>()?;
	let max_mode = match context.policy.context.extended_mode {
		Some(ExtendedContextMode::Standard) => false,
		Some(ExtendedContextMode::Extended) => true,
		None => return Err(encoding_error("cursor_extended_context_mode_unknown")),
	};
	let discovered_model = Str::new(target.wire_model.as_str());
	let base_conversation = context.session.map_or_else(
		|| Str::new(context.request_id.as_str()),
		|session| Str::new(session.conversation.as_str()),
	);
	let (wire_conversation, wire_mode) =
		conversations
			.lock()
			.begin(context.request_id, &base_conversation, &discovered_model);
	let run = CursorRunRequest {
		model_id: discovered_model,
		max_mode,
		conversation_id: Some(wire_conversation),
		checkpoint: None,
		root_prompts: roots.into_boxed_slice(),
		tools: tools.into_boxed_slice(),
		action: CursorRunAction::UserMessage {
			message_id: Str::new(context.request_id.as_str()),
			text:       user,
		},
	};
	let body = encode_run_request_for_wire_mode(&run, wire_mode).map_err(inference_error)?;
	let fallback_wire_model = serialized_fallback_wire_model(&run, wire_mode, &body);
	conversations
		.lock()
		.set_fallback_wire_model(context.request_id, fallback_wire_model);
	let mut headers = Vec::with_capacity(6);
	for_each_public_header(CursorHeaderProfile::Run, |name, value| {
		headers.push(RequestHeader { name: sf!(name), value: sf!(value) });
	});
	Ok(EncodedRequest::new(
		OperationKind::Chat,
		RequestMethod::Post,
		endpoint_uri(context.route.endpoint.base_url.as_str(), RUN_PATH),
		headers.into_boxed_slice(),
		BodySource::bytes(body),
		FramingProtocol::Connect,
		cursor_bounds(),
	))
}

fn cursor_message_text(context: &EncodeContext<'_>, content: &[ContentPart]) -> Result<Str, Error> {
	let mut text = String::new();
	for part in content {
		match part {
			ContentPart::Text { text: part, proof: None } => text.push_str(part.as_str()),
			ContentPart::Text { proof: Some(proof), .. }
			| ContentPart::Reasoning { proof: Some(proof), .. }
			| ContentPart::ToolCall { proof: Some(proof), .. } => {
				let target = context
					.target
					.ok_or_else(|| encoding_error("cursor_continuation_proof_requires_wire_target"))?;
				if proof.provider != context.route.provider || proof.codec != target.codec {
					return Err(encoding_error("provider_proof_scope_mismatch"));
				}
				return Err(encoding_error("cursor_continuation_proof_requires_checkpoint_reseed"));
			},
			ContentPart::Reasoning { .. }
			| ContentPart::Image(_)
			| ContentPart::Audio(_)
			| ContentPart::Document(_)
			| ContentPart::ToolCall { .. }
			| ContentPart::ToolResult { .. }
			| ContentPart::CachePoint(_) => {
				return Err(encoding_error("cursor_message_part_not_losslessly_projectable"));
			},
		}
	}
	Ok(Str::new(text))
}

fn reject_unprojected_chat_options(
	request: &ChatRequest,
	reasoning_projected_by_model: bool,
) -> Result<(), Error> {
	if !request.hosted_tools.is_empty()
		|| !matches!(request.tool_choice, Setting::Unset)
		|| !matches!(request.output, Setting::Unset)
		|| (!reasoning_projected_by_model && !matches!(request.reasoning, Setting::Unset))
		|| !matches!(request.verbosity, Setting::Unset)
		|| !matches!(request.cache_retention, Setting::Unset)
		|| !matches!(request.service_tier, Setting::Unset)
		|| request.sampling.temperature.is_some()
		|| request.sampling.top_p.is_some()
		|| request.sampling.top_k.is_some()
		|| request.sampling.seed.is_some()
		|| !request.sampling.stop.is_empty()
		|| request.sampling.presence_penalty.is_some()
		|| request.sampling.frequency_penalty.is_some()
		|| request.max_output_tokens.is_some()
		|| request.top_logprobs.is_some()
		|| !request.safety.is_empty()
	{
		return Err(encoding_error("cursor_chat_option_not_losslessly_projectable"));
	}
	Ok(())
}

fn endpoint_uri(base: &str, path: &str) -> Str {
	let mut uri = String::with_capacity(base.len() + path.len());
	uri.push_str(base.trim_end_matches('/'));
	uri.push_str(path);
	Str::new(uri)
}

const fn cursor_bounds() -> SizeBounds {
	SizeBounds {
		request_body: MAX_MESSAGE_BYTES as u64,
		frame:        MAX_MESSAGE_BYTES as u64,
		response:     256 * 1024 * 1024,
	}
}

struct CursorWireDecoder {
	operation:      OperationKind,
	provider:       omp_catalog::ProviderId,
	route:          omp_catalog::RouteId,
	agent:          CursorDecoder,
	discovery_done: bool,
	conversations:  Arc<Mutex<CursorConversationRotations>>,
	conversation:   Option<CursorConversationAttempt>,
}

impl Decoder for CursorWireDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		match self.operation {
			OperationKind::Chat => {
				let Frame::Connect(envelope) = frame else {
					return Err(self.attach(encoding_error("cursor_chat_expected_connect_frame")));
				};
				if envelope.is_compressed() {
					return Err(self.attach(encoding_error("cursor_compressed_connect_not_supported")));
				}
				let result = match envelope.kind {
					ConnectEnvelopeKind::Message => self.agent.push_payload(envelope.payload),
					ConnectEnvelopeKind::EndStream => self.agent.push_end_stream(&envelope.payload),
				};
				let events = match result {
					Ok(events) => events,
					Err(error) => {
						if let Some(event) = self.agent.flush_open_tool_call() {
							emit(cursor_raw_event(event));
						}
						let fallback = self.schedule_discovered_fallback(&error);
						self.rotate_poisoned_conversation(&error);
						let mut error = inference_error(error);
						if fallback {
							error.action = RetryAction::SameRoute { after: Duration::ZERO };
						}
						return Err(self.attach(error));
					},
				};
				for event in events {
					emit(cursor_raw_event(event));
				}
				Ok(())
			},
			OperationKind::DiscoverModels => {
				if self.discovery_done {
					return Err(self.attach(encoding_error("cursor_discovery_response_repeated")));
				}
				let bytes = match frame {
					Frame::Raw(bytes) => bytes,
					Frame::Connect(envelope)
						if envelope.kind == ConnectEnvelopeKind::Message && !envelope.is_compressed() =>
					{
						envelope.payload
					},
					_ => return Err(self.attach(encoding_error("cursor_discovery_expected_protobuf"))),
				};
				let models = decode_discovery_response(&bytes)
					.map_err(|error| self.attach(inference_error(error)))?;
				let rows = models
					.into_iter()
					.map(|model| DiscoveredModel {
						provider:              self.provider.clone(),
						route:                 self.route.clone(),
						wire_model:            WireModelId::new(model.id),
						aliases:               model
							.aliases
							.into_vec()
							.into_iter()
							.map(WireModelId::new)
							.collect(),
						display_name:          Some(model.name),
						declared_class:        None,
						declared_operations:   OperationBits::for_kind(OperationKind::Chat),
						declared_capabilities: Some(discovered_capabilities(model.reasoning)),
						declared_limits:       None,
						declared_pricing:      Box::new([]),
						extended_context_mode: Some(ExtendedContextMode::from_enabled(model.max_mode)),
						availability:          None,
						source:                sf!("cursor_get_usable_models"),
						observed_at_ms:        None,
						updated_at_ms:         None,
						deprecated:            None,
					})
					.collect();
				emit(RawEvent::DiscoveredModels { rows, next_cursor: None });
				self.discovery_done = true;
				Ok(())
			},
			_ => Err(self.attach(encoding_error("cursor_operation_not_supported"))),
		}
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		match self.operation {
			OperationKind::Chat => {
				let result = self.agent.finish();
				if result.is_err()
					&& let Some(event) = self.agent.flush_open_tool_call()
				{
					emit(cursor_raw_event(event));
				}
				result.map_err(|error| self.attach(inference_error(error)))?;
				if self.agent.completed_turn()
					&& let Some(attempt) = self.conversation.take()
				{
					self.conversations.lock().mark_clean(&attempt);
				}
				Ok(())
			},
			OperationKind::DiscoverModels if self.discovery_done => Ok(()),
			OperationKind::DiscoverModels => {
				Err(self.attach(encoding_error("cursor_discovery_response_missing")))
			},
			_ => Err(self.attach(encoding_error("cursor_operation_not_supported"))),
		}
	}
}

fn discovered_capabilities(reasoning: bool) -> ModelCapabilities {
	ModelCapabilities {
		operations:    OperationBits::for_kind(OperationKind::Chat),
		chat:          Some(ChatCapabilities {
			roles:             unknown_availability(),
			mid_session_roles: unknown_availability(),
			tools:             unknown_availability(),
			structured_output: unknown_availability(),
			grammar:           unknown_availability(),
			text_verbosity:    unknown_availability(),
			reasoning:         if reasoning {
				Availability::Native(ReasoningCapabilities {
					features:              ReasoningFeatureBits::VISIBLE,
					efforts:               Box::new([]),
					minimum_budget_tokens: None,
					maximum_budget_tokens: None,
				})
			} else {
				Availability::Unsupported
			},
			input_modalities:  unknown_availability(),
			image_input:       unknown_availability(),
			hosted_tools:      unknown_availability(),
			prompt_caching:    unknown_availability(),
			service_tiers:     unknown_availability(),
			sampling:          unknown_availability(),
			safety:            unknown_availability(),
			determinism:       unknown_availability(),
			server_state:      unknown_availability(),
			logprobs:          unknown_availability(),
		}),
		embeddings:    None,
		image:         None,
		video:         None,
		speech:        None,
		transcription: None,
		realtime:      None,
		search:        None,
		tokenization:  None,
	}
}

const fn unknown_availability<T>() -> Availability<T> {
	Availability::Unknown
}

impl CursorWireDecoder {
	fn attach(&self, error: Error) -> Error {
		error
			.provider(self.provider.clone())
			.route(self.route.clone())
	}

	fn schedule_discovered_fallback(&mut self, error: &CursorProtocolError) -> bool {
		if error.kind != CursorErrorKind::ModelNotFound
			|| error.committed
			|| self.agent.saw_server_progress()
		{
			return false;
		}
		let Some(attempt) = self.conversation.take() else {
			return false;
		};
		self.conversations.lock().schedule_fallback(&attempt)
	}

	fn rotate_poisoned_conversation(&mut self, error: &CursorProtocolError) {
		if error.kind != CursorErrorKind::ResourceExhausted || self.agent.saw_token_delta() {
			return;
		}
		let Some(attempt) = self.conversation.take() else {
			return;
		};
		self
			.conversations
			.lock()
			.rotate(&attempt.base, attempt.seed.as_str());
	}
}

fn cursor_raw_event(event: CursorEvent) -> RawEvent {
	match event {
		CursorEvent::Chat(event) => RawEvent::Chat(*event),
		CursorEvent::ToolCallComplete { index, id, name, arguments } => RawEvent::ToolCallComplete {
			index,
			call: UnvalidatedToolCall { id, name, input_kind: ToolInputKind::Json, arguments },
		},
		CursorEvent::ShellInvoke(invocation) => {
			RawEvent::Control(ProviderControlEvent::ShellInvoke {
				invocation: Str::new(invocation.id.to_string()),
				exec:       (!invocation.exec_id.is_empty()).then_some(invocation.exec_id),
				call:       invocation.call_id,
				command:    invocation.command,
				cwd:        (!invocation.working_directory.is_empty())
					.then_some(invocation.working_directory),
				timeout_ms: (invocation.timeout_ms != 0).then_some(invocation.timeout_ms as u64),
				streaming:  invocation.streaming,
			})
		},
		CursorEvent::WorkflowInvoke { invocation, name, arguments } => {
			RawEvent::Control(ProviderControlEvent::WorkflowAction {
				request_id: invocation,
				name,
				arguments,
				timeout_ms: None,
			})
		},
		CursorEvent::InvokeCancel { id } => {
			RawEvent::Control(ProviderControlEvent::Cancel { call: ToolCallId::from(id.to_string()) })
		},
		CursorEvent::Checkpoint { data } => {
			RawEvent::ProviderState(ProviderStateEvent::Checkpoint { id: None, data })
		},
		CursorEvent::InteractionQuery { id, query, reply } => {
			let kind = query
				.as_ref()
				.map_or_else(|| sf!("unknown"), |query| sf!(interaction_query_kind(query)));
			let payload = Bytes::from(wire::InteractionQuery { id, query }.encode_to_vec());
			RawEvent::Control(ProviderControlEvent::InteractionQuery { id, kind, payload, reply })
		},
		CursorEvent::Completion { reason, blocks, usage } => {
			RawEvent::Completion(RawCompletion { reason, blocks, usage })
		},
	}
}

const fn interaction_query_kind(query: &wire::interaction_query::Query) -> &'static str {
	use wire::interaction_query::Query;
	match query {
		Query::WebSearchRequestQuery(_) => "web_search",
		Query::WebFetchRequestQuery(_) => "web_fetch",
		Query::AskQuestionInteractionQuery(_) => "ask_question",
		Query::SwitchModeRequestQuery(_) => "switch_mode",
		Query::ExaSearchRequestQuery(_) => "exa_search",
		Query::ExaFetchRequestQuery(_) => "exa_fetch",
		Query::CreatePlanRequestQuery(_) => "create_plan",
		Query::SetupVmEnvironmentArgs(_) => "setup_vm_environment",
	}
}

fn inference_error(error: CursorProtocolError) -> Error {
	let (kind, action) = match error.kind {
		CursorErrorKind::Malformed | CursorErrorKind::Truncated | CursorErrorKind::AfterTerminal => {
			(ErrorKind::StreamCorruption, RetryAction::Never)
		},
		CursorErrorKind::Cancelled => (ErrorKind::Cancelled, RetryAction::Never),
		CursorErrorKind::Authentication => (ErrorKind::Authentication, RetryAction::Never),
		CursorErrorKind::Upstream => (ErrorKind::Protocol, RetryAction::Never),
		CursorErrorKind::ModelNotFound => (ErrorKind::TargetNotFound, RetryAction::Never),
		CursorErrorKind::PlanGate => (ErrorKind::Authorization, RetryAction::RotateAccount),
		CursorErrorKind::ResourceExhausted => {
			(ErrorKind::ResourceExhausted, RetryAction::SameRoute { after: Duration::from_secs(1) })
		},
		CursorErrorKind::ContextOverflow => (ErrorKind::ContextOverflow, RetryAction::Never),
		CursorErrorKind::Unsupported => (ErrorKind::CapabilityMismatch, RetryAction::Never),
	};
	let inference = Error::new(kind, ErrorPhase::Streaming, action, ExecutionReceipt::default())
		.status(error.status)
		.code(error.reason.clone())
		.committed(error.committed);
	if let Some(diagnostic) = error.diagnostic {
		inference.detail(ErrorDetail::Provider { sanitized_message: diagnostic.display_message() })
	} else {
		inference.detail(ErrorDetail::protocol(ReasonId(error.reason)))
	}
}

fn encoding_error(reason: &'static str) -> Error {
	let reason = sf!(reason);
	Error::new(
		ErrorKind::CapabilityMismatch,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(reason.clone())
	.detail(ErrorDetail::protocol(ReasonId(reason)))
}

#[cfg(test)]
mod tests {
	use std::{fs, sync::Arc};

	use omp_catalog::ThinkingEffort;
	use omp_core::encoding::hex;

	use super::*;
	use crate::{
		call::{
			Message as CallMessage, ReasoningRequest as CallReasoningRequest,
			ReasoningVisibility as CallReasoningVisibility,
		},
		transport::{ConnectDecoder as ConnectFramer, ConnectEnvelope as TransportConnectEnvelope},
	};

	const FIXTURES: &str =
		concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/llm-oracle/agent-protocols/cursor/");

	fn fixture(name: &str) -> Vec<u8> {
		fs::read(format!("{FIXTURES}{name}")).expect("Cursor oracle fixture")
	}

	fn empty_chat_request() -> ChatRequest {
		ChatRequest {
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
		}
	}

	fn encoded_run(model_id: &str, roots: Box<[CursorRootPrompt]>) -> wire::AgentRunRequest {
		let encoded = encode_run_request(&CursorRunRequest {
			model_id:        Str::new(model_id),
			max_mode:        false,
			conversation_id: None,
			checkpoint:      None,
			root_prompts:    roots,
			tools:           Box::new([]),
			action:          CursorRunAction::UserMessage {
				message_id: sf!("request"),
				text:       sf!("hello"),
			},
		})
		.expect("encoded Cursor request");
		let message =
			wire::AgentClientMessage::decode(encoded.slice(5..)).expect("framed Cursor request");
		let Some(agent_client_message::Message::RunRequest(run)) = message.message else {
			panic!("run request")
		};
		run
	}

	#[test]
	fn requested_model_splits_reasoning_tier_and_preserves_fast_lane() {
		for (routed, base, effort) in [
			("gpt-5.6-sol-minimal", "gpt-5.6-sol", "minimal"),
			("gpt-5.6-sol-low", "gpt-5.6-sol", "low"),
			("gpt-5.6-sol-medium", "gpt-5.6-sol", "medium"),
			("gpt-5.6-sol-high", "gpt-5.6-sol", "high"),
			("gpt-5.6-sol-xhigh", "gpt-5.6-sol", "xhigh"),
			("gpt-5.6-sol-max", "gpt-5.6-sol", "max"),
			("gpt-5.6-sol-high-fast", "gpt-5.6-sol-fast", "high"),
		] {
			let run = encoded_run(routed, Box::new([]));
			let requested = run.requested_model.expect("requested model");
			assert_eq!(requested.model_id, base, "{routed}");
			let details = run.model_details.expect("model details");
			assert_eq!(details.model_id, base, "{routed}");
			assert_eq!(details.display_model_id, base, "{routed}");
			assert_eq!(requested.parameters.len(), 1, "{routed}");
			assert_eq!(requested.parameters[0].id, "reasoning", "{routed}");
			assert_eq!(requested.parameters[0].value, effort, "{routed}");
		}
	}

	#[test]
	fn requested_model_does_not_split_non_openai_siblings() {
		let run = encoded_run("claude-fable-5-low", Box::new([]));
		let requested = run.requested_model.expect("requested model");
		assert_eq!(requested.model_id, "claude-fable-5-low");
		assert!(requested.parameters.is_empty());
		let off = encoded_run("gpt-5.6-sol-none", Box::new([]));
		let requested = off.requested_model.expect("requested model");
		assert_eq!(requested.model_id, "gpt-5.6-sol-none");
		assert!(requested.parameters.is_empty());
	}
	#[test]
	fn requested_model_pins_standard_composer_tier_from_catalog_data() {
		let run = encoded_run("composer-2.5", Box::new([]));
		let requested = run.requested_model.expect("requested model");
		assert_eq!(requested.model_id, "composer-2.5");
		assert_eq!(requested.parameters.len(), 1);
		assert_eq!(requested.parameters[0].id, "fast");
		assert_eq!(requested.parameters[0].value, "false");

		let fast = encoded_run("composer-2.5-fast", Box::new([]));
		let requested = fast.requested_model.expect("requested model");
		assert_eq!(requested.model_id, "composer-2.5-fast");
		assert!(requested.parameters.is_empty());
	}

	#[test]
	fn discovered_effort_fallback_requires_the_exact_serialized_payload() {
		let request = CursorRunRequest {
			model_id:        sf!("gpt-5.6-sol-medium"),
			max_mode:        false,
			conversation_id: Some(sf!("conversation")),
			checkpoint:      None,
			root_prompts:    Box::new([]),
			tools:           Box::new([]),
			action:          CursorRunAction::UserMessage {
				message_id: sf!("request"),
				text:       sf!("hello"),
			},
		};
		let normalized = encode_run_request_for_wire_mode(&request, CursorWireMode::Normalized)
			.expect("normalized request");
		assert_eq!(
			serialized_fallback_wire_model(&request, CursorWireMode::Normalized, &normalized),
			Some(sf!("gpt-5.6-sol-medium"))
		);

		let discovered = encode_run_request_for_wire_mode(&request, CursorWireMode::Discovered)
			.expect("discovered request");
		assert_eq!(
			serialized_fallback_wire_model(&request, CursorWireMode::Discovered, &discovered),
			None
		);
		let discovered_message =
			wire::AgentClientMessage::decode(discovered.slice(5..)).expect("discovered payload");
		let Some(agent_client_message::Message::RunRequest(discovered_run)) =
			discovered_message.message
		else {
			panic!("run request")
		};
		let requested = discovered_run.requested_model.expect("requested model");
		assert_eq!(requested.model_id, "gpt-5.6-sol-medium");
		assert!(requested.parameters.is_empty());
		assert_eq!(
			discovered_run
				.model_details
				.expect("model details")
				.model_id,
			"gpt-5.6-sol-medium"
		);

		let mut changed =
			wire::AgentClientMessage::decode(normalized.slice(5..)).expect("normalized payload");
		let Some(agent_client_message::Message::RunRequest(run)) = changed.message.as_mut() else {
			panic!("run request")
		};
		run.requested_model
			.as_mut()
			.expect("requested model")
			.model_id = "hook-selected-model".to_owned();
		let changed = connect_message(&changed);
		assert_eq!(
			serialized_fallback_wire_model(&request, CursorWireMode::Normalized, &changed),
			None,
			"fallback eligibility follows the final serialized model payload"
		);
		let mut changed =
			wire::AgentClientMessage::decode(normalized.slice(5..)).expect("normalized payload");
		let Some(agent_client_message::Message::RunRequest(run)) = changed.message.as_mut() else {
			panic!("run request")
		};
		run.requested_model
			.as_mut()
			.expect("requested model")
			.parameters[0]
			.value = "high".to_owned();
		assert_eq!(
			serialized_fallback_wire_model(
				&request,
				CursorWireMode::Normalized,
				&connect_message(&changed),
			),
			None,
			"fallback eligibility follows the final serialized reasoning parameters"
		);
	}

	#[test]
	fn discovered_effort_retry_gates_ignore_heartbeat_but_block_progress_side_effects_and_cancel() {
		fn decoder(
			conversations: &Arc<Mutex<CursorConversationRotations>>,
			request: &str,
		) -> CursorWireDecoder {
			let request = RequestId::from(request);
			let base = sf!("conversation");
			let model = sf!("gpt-5.6-sol-medium");
			let (_, mode) = conversations.lock().begin(&request, &base, &model);
			assert_eq!(mode, CursorWireMode::Normalized);
			conversations
				.lock()
				.set_fallback_wire_model(&request, Some(model));
			let conversation = conversations.lock().take(&request);
			CursorWireDecoder {
				operation: OperationKind::Chat,
				provider: omp_catalog::ProviderId::from("cursor"),
				route: omp_catalog::RouteId::from("cursor/primary"),
				agent: CursorDecoder::default(),
				discovery_done: false,
				conversations: Arc::clone(conversations),
				conversation,
			}
		}

		fn message(payload: Bytes) -> Frame {
			Frame::Connect(TransportConnectEnvelope {
				flags: 0,
				kind: ConnectEnvelopeKind::Message,
				payload,
			})
		}

		fn not_found() -> Frame {
			Frame::Connect(TransportConnectEnvelope {
				flags:   CONNECT_END_STREAM,
				kind:    ConnectEnvelopeKind::EndStream,
				payload: Bytes::from_static(br#"{"error":{"code":"not_found","message":"missing"}}"#),
			})
		}

		let conversations = Arc::new(Mutex::new(CursorConversationRotations::default()));
		let mut sink = |_event: RawEvent| {};
		assert_eq!(
			CursorDecoder::default()
				.push_end_stream(br#"{"error":{"code":"5","message":"missing"}}"#)
				.expect_err("gRPC status 5 is not_found")
				.kind,
			CursorErrorKind::ModelNotFound
		);
		let mut heartbeat_only = decoder(&conversations, "heartbeat");
		heartbeat_only
			.push(
				message(update(interaction_update::Message::Heartbeat(wire::HeartbeatUpdate {}))),
				&mut sink,
			)
			.expect("heartbeat is ignorable");
		let retry = heartbeat_only
			.push(not_found(), &mut sink)
			.expect_err("not_found schedules discovered fallback");
		assert_eq!(retry.kind, ErrorKind::TargetNotFound);
		assert_eq!(retry.action, RetryAction::SameRoute { after: Duration::ZERO });
		assert!(!retry.committed);
		let request = RequestId::from("heartbeat");
		let (_, mode) =
			conversations
				.lock()
				.begin(&request, &sf!("conversation"), &sf!("gpt-5.6-sol-medium"));
		assert_eq!(mode, CursorWireMode::Discovered);
		let fallback = conversations
			.lock()
			.take(&request)
			.expect("fallback attempt");
		assert!(
			!conversations.lock().schedule_fallback(&fallback),
			"discovered id is attempted at most once"
		);

		let progress = Arc::new(Mutex::new(CursorConversationRotations::default()));
		let mut progressed = decoder(&progress, "progress");
		progressed
			.push(
				message(update(interaction_update::Message::TextDelta(wire::TextDeltaUpdate {
					text: "partial".to_owned(),
				}))),
				&mut sink,
			)
			.expect("text progress");
		let error = progressed
			.push(not_found(), &mut sink)
			.expect_err("late not_found remains terminal");
		assert_eq!(error.action, RetryAction::Never);
		assert!(error.committed);

		let side_effects = Arc::new(Mutex::new(CursorConversationRotations::default()));
		let mut busy = decoder(&side_effects, "busy");
		let exec = wire::AgentServerMessage {
			message: Some(agent_server_message::Message::ExecServerMessage(wire::ExecServerMessage {
				id: 1,
				message: Some(exec_server_message::Message::ShellArgs(wire::ShellArgs {
					command: "printf busy".to_owned(),
					tool_call_id: "call-shell".to_owned(),
					..Default::default()
				})),
				..Default::default()
			})),
		};
		busy
			.push(message(Bytes::from(exec.encode_to_vec())), &mut sink)
			.expect("local workflow request marks the stream busy");
		let error = busy
			.push(not_found(), &mut sink)
			.expect_err("side effects forbid fallback");
		assert_eq!(error.action, RetryAction::Never);
		assert!(error.committed);

		let cancelled = Arc::new(Mutex::new(CursorConversationRotations::default()));
		let mut decoder = decoder(&cancelled, "cancelled");
		decoder.agent.cancel();
		let error = decoder
			.push(not_found(), &mut sink)
			.expect_err("cancel remains terminal");
		assert_eq!(error.kind, ErrorKind::Cancelled);
		assert_eq!(error.action, RetryAction::Never);
	}

	#[test]
	fn routed_chat_request_populates_agent_run_reasoning_parameters() {
		let target = omp_catalog::WireTarget {
			route:      omp_catalog::RouteId::from("cursor"),
			codec:      omp_catalog::CodecId::from("cursor"),
			endpoint:   omp_catalog::EndpointSpec {
				base_url:    sf!("https://api2.cursor.sh"),
				region:      None,
				api_version: None,
			},
			wire_model: WireModelId::new("gpt-5.6-terra-medium"),
		};
		let mut policy = omp_catalog::WirePolicy::baseline();
		policy.context.extended_mode = Some(ExtendedContextMode::Standard);
		let selection = omp_catalog::ThinkingSelection {
			effort:            ThinkingEffort::Medium,
			wire_effort:       ThinkingEffort::Medium,
			native_effort:     None,
			budget:            None,
			wire_model:        target.wire_model.clone(),
			reasoning_mode:    None,
			suppress_when_off: false,
			adaptive_tag_only: false,
		};
		let mut request = empty_chat_request();
		request.messages = Arc::from([CallMessage {
			role:    Role::User,
			content: Arc::from([ContentPart::Text { text: sf!("hello"), proof: None }]),
			name:    None,
		}]);
		request.reasoning = Setting::Require(CallReasoningRequest {
			visibility:          CallReasoningVisibility::Visible,
			effort:              Some(omp_catalog::ReasoningEffort::Medium),
			max_tokens:          None,
			preserve_signatures: false,
		});
		let context = EncodeContext {
			target: Some(&target),
			policy: &policy,
			thinking_selection: Some(&selection),
			..EncodeContext::default()
		};
		let encoded = encode_chat_call(
			&context,
			&request,
			&Arc::new(Mutex::new(CursorConversationRotations::default())),
		)
		.expect("encoded routed chat");
		let BodySource::Bytes(body) = encoded.body else {
			panic!("inline Cursor request")
		};
		let message =
			wire::AgentClientMessage::decode(body.slice(5..)).expect("framed Cursor request");
		let Some(agent_client_message::Message::RunRequest(run)) = message.message else {
			panic!("run request")
		};
		let requested = run.requested_model.expect("requested model");
		assert_eq!(requested.model_id, "gpt-5.6-terra");
		assert_eq!(requested.parameters.len(), 1);
		assert_eq!(requested.parameters[0].id, "reasoning");
		assert_eq!(requested.parameters[0].value, "medium");
		assert_eq!(run.model_details.expect("model details").model_id, "gpt-5.6-terra");
	}

	#[test]
	fn system_prompts_are_global_request_context_rules() {
		let run = encoded_run(
			"cursor-composer-2.5",
			vec![
				CursorRootPrompt { role: CursorPromptRole::System, text: sf!("first") },
				CursorRootPrompt { role: CursorPromptRole::Developer, text: Str::default() },
				CursorRootPrompt { role: CursorPromptRole::Developer, text: sf!("second") },
			]
			.into_boxed_slice(),
		);
		let Some(conversation_action::Action::UserMessageAction(action)) =
			run.action.and_then(|action| action.action)
		else {
			panic!("user action")
		};
		let rules = action.request_context.expect("request context").rules;
		assert_eq!(rules.len(), 2);
		assert_eq!(rules[0].full_path, "/omp/system-prompt/0.mdc");
		assert_eq!(rules[0].content, "first");
		assert_eq!(rules[0].source, wire::CursorRuleSource::User as i32);
		assert!(matches!(
			rules[0]
				.r#type
				.as_ref()
				.and_then(|kind| kind.r#type.as_ref()),
			Some(cursor_rule_type::Type::Global(_))
		));
		assert_eq!(rules[1].full_path, "/omp/system-prompt/1.mdc");
		assert_eq!(rules[1].content, "second");
	}

	#[test]
	fn model_routed_reasoning_is_not_rejected_as_unprojected() {
		let mut request = empty_chat_request();
		request.reasoning = Setting::Require(CallReasoningRequest {
			visibility:          CallReasoningVisibility::Visible,
			effort:              Some(omp_catalog::ReasoningEffort::High),
			max_tokens:          None,
			preserve_signatures: false,
		});

		assert!(reject_unprojected_chat_options(&request, true).is_ok());
		assert!(reject_unprojected_chat_options(&request, false).is_err());
	}
	#[test]
	fn mcp_arguments_decode_protobuf_json_values() {
		let expected = serde_json::json!({
			"path": "src/lib.rs",
			"range": { "start": 4, "end": 12 },
			"strict": true,
			"encoded": { "depth": 2 },
			"encoded_array": [1, 2],
			"quoted": "label",
			"numeric_string": "57785654",
			"exponent_string": "1e234567",
			"boolean_string": "true",
			"null_string": "null",
			"json_number": 57785654,
			"invalid_number": null,
			"infinite_number": null,
			"invalid_raw": "�"
		});
		let mut args: BTreeMap<String, Bytes> = expected
			.as_object()
			.expect("object")
			.iter()
			.map(|(name, value)| {
				(name.clone(), encode_json_value(value).expect("encoded protobuf JSON Value"))
			})
			.collect();
		args.insert(
			"encoded".to_owned(),
			encode_json_value(&serde_json::json!(r#"{"depth":2}"#))
				.expect("encoded protobuf JSON string"),
		);
		args.insert(
			"encoded_array".to_owned(),
			encode_json_value(&serde_json::json!("[1,2]"))
				.expect("encoded protobuf JSON array string"),
		);
		args.insert(
			"quoted".to_owned(),
			encode_json_value(&serde_json::json!(r#""label""#))
				.expect("encoded quoted protobuf JSON string"),
		);
		for (name, text) in [
			("numeric_string", "57785654"),
			("exponent_string", "1e234567"),
			("boolean_string", "true"),
			("null_string", "null"),
		] {
			args.insert(
				name.to_owned(),
				encode_json_value(&serde_json::Value::String(text.to_owned()))
					.expect("encoded opaque protobuf string"),
			);
		}
		args.insert(
			"json_number".to_owned(),
			encode_json_value(&serde_json::json!(57_785_654)).expect("encoded protobuf number"),
		);
		args.insert(
			"invalid_number".to_owned(),
			Bytes::from(
				ProtoValue { kind: Some(ProtoValueKind::NumberValue(f64::NAN)) }.encode_to_vec(),
			),
		);
		args.insert(
			"infinite_number".to_owned(),
			Bytes::from(
				ProtoValue { kind: Some(ProtoValueKind::NumberValue(f64::INFINITY)) }.encode_to_vec(),
			),
		);
		args.insert("invalid_raw".to_owned(), Bytes::from_static(b"\xff"));
		let tool = wire::ToolCall {
			tool: Some(tool_call::Tool::McpToolCall(wire::McpToolCall {
				args: Some(wire::McpArgs { args, ..wire::McpArgs::default() }),
				..wire::McpToolCall::default()
			})),
			..wire::ToolCall::default()
		};
		let decoded = mcp_tool_arguments(Some(&tool)).expect("MCP arguments");
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&decoded).expect("JSON object"),
			expected
		);
	}
	#[test]
	fn mcp_completion_merges_scalars_without_downgrading_streamed_structures() {
		let streamed = br#"{"tasks":[{"id":"one"}],"note":"old","streamed":true}"#;
		let completion =
			Bytes::from_static(br#"{"tasks":"raw fallback","note":"new","completion":12}"#);
		let merged = merge_mcp_arguments(streamed, completion);
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&merged).expect("merged JSON"),
			serde_json::json!({
				"tasks": [{ "id": "one" }],
				"note": "new",
				"streamed": true,
				"completion": 12
			})
		);
	}
	#[test]
	fn mcp_initial_delta_and_flush_arguments_are_preserved() {
		fn mcp_tool(city: &str) -> wire::ToolCall {
			let mut args = BTreeMap::new();
			args.insert(
				"city".to_owned(),
				encode_json_value(&serde_json::Value::String(city.to_owned())).expect("encoded city"),
			);
			wire::ToolCall {
				tool_call_id: Some("call-weather".to_owned()),
				tool:         Some(tool_call::Tool::McpToolCall(wire::McpToolCall {
					args: Some(wire::McpArgs {
						name: "get_weather".to_owned(),
						tool_call_id: "call-weather".to_owned(),
						tool_name: "get_weather".to_owned(),
						args,
						..Default::default()
					}),
					..Default::default()
				})),
			}
		}

		fn complete_arguments(events: Vec<CursorEvent>) -> Bytes {
			events
				.into_iter()
				.find_map(|event| match event {
					CursorEvent::ToolCallComplete { arguments, .. } => Some(arguments),
					_ => None,
				})
				.expect("completed MCP arguments")
		}

		let mut announced = CursorDecoder::default();
		announced
			.push_payload(update(interaction_update::Message::ToolCallStarted(
				wire::ToolCallStartedUpdate {
					call_id: "call-weather".to_owned(),
					tool_call: Some(mcp_tool("Paris")),
					..Default::default()
				},
			)))
			.expect("announced MCP call");
		let completed = announced
			.push_payload(update(interaction_update::Message::ToolCallCompleted(
				wire::ToolCallCompletedUpdate {
					call_id: "call-weather".to_owned(),
					tool_call: None,
					..Default::default()
				},
			)))
			.expect("completed announced MCP call");
		assert_eq!(complete_arguments(completed), Bytes::from_static(br#"{"city":"Paris"}"#));

		let mut streamed = CursorDecoder::default();
		streamed
			.push_payload(update(interaction_update::Message::ToolCallStarted(
				wire::ToolCallStartedUpdate {
					call_id: "call-weather".to_owned(),
					tool_call: Some(mcp_tool("Paris")),
					..Default::default()
				},
			)))
			.expect("started streamed MCP call");
		streamed
			.push_payload(update(interaction_update::Message::PartialToolCall(
				wire::PartialToolCallUpdate {
					call_id: "call-weather".to_owned(),
					args_text_delta: r#"{"city":"Berlin"}"#.to_owned(),
					..Default::default()
				},
			)))
			.expect("streamed exact argument snapshot");
		let completed = streamed
			.push_payload(update(interaction_update::Message::ToolCallCompleted(
				wire::ToolCallCompletedUpdate {
					call_id: "call-weather".to_owned(),
					tool_call: None,
					..Default::default()
				},
			)))
			.expect("completed streamed MCP call");
		assert_eq!(complete_arguments(completed), Bytes::from_static(br#"{"city":"Berlin"}"#));

		let mut flushed = CursorDecoder::default();
		flushed
			.push_payload(update(interaction_update::Message::ToolCallStarted(
				wire::ToolCallStartedUpdate {
					call_id: "call-weather".to_owned(),
					tool_call: Some(mcp_tool("Paris")),
					..Default::default()
				},
			)))
			.expect("started truncated MCP call");
		let flushed = flushed
			.push_payload(update(interaction_update::Message::TurnEnded(
				wire::TurnEndedUpdate::default(),
			)))
			.expect("terminal update flushes open MCP call");
		assert_eq!(complete_arguments(flushed), Bytes::from_static(br#"{"city":"Paris"}"#));
		let mut abrupt = CursorDecoder::default();
		abrupt
			.push_payload(update(interaction_update::Message::ToolCallStarted(
				wire::ToolCallStartedUpdate {
					call_id: "call-weather".to_owned(),
					tool_call: Some(mcp_tool("Paris")),
					..Default::default()
				},
			)))
			.expect("started abruptly truncated MCP call");
		let abrupt = abrupt
			.flush_open_tool_call()
			.expect("flushes abrupt MCP call");
		assert_eq!(complete_arguments(vec![abrupt]), Bytes::from_static(br#"{"city":"Paris"}"#));
	}

	#[test]
	fn native_edit_tool_call_opens_edit_and_collects_stream_content() {
		let tool = wire::ToolCall {
			tool_call_id: Some("edit-1".to_owned()),
			tool:         Some(tool_call::Tool::EditToolCall(wire::EditToolCall {
				args: Some(wire::EditArgs {
					path:           "/tmp/note.txt".to_owned(),
					stream_content: Some("orange".to_owned()),
				}),
				..Default::default()
			})),
		};
		let mut decoder = CursorDecoder::default();
		let started = decoder
			.push_payload(update(interaction_update::Message::ToolCallStarted(
				wire::ToolCallStartedUpdate {
					call_id: "call-edit".to_owned(),
					tool_call: Some(tool),
					..Default::default()
				},
			)))
			.expect("edit started");
		assert!(started.iter().any(|event| matches!(
			event,
			CursorEvent::Chat(event)
				if matches!(
					event.as_ref(),
					ChatEvent::ToolCallStarted { id, name, .. }
						if id.as_str() == "call-edit" && name.as_str() == "edit"
				)
		)));
		decoder
			.push_payload(update(interaction_update::Message::ToolCallDelta(Box::new(
				wire::ToolCallDeltaUpdate {
					call_id: "call-edit".to_owned(),
					tool_call_delta: Some(Box::new(wire::ToolCallDelta {
						delta: Some(tool_call_delta::Delta::EditToolCallDelta(wire::EditToolCallDelta {
							stream_content_delta: " peel".to_owned(),
						})),
					})),
					..Default::default()
				},
			))))
			.expect("edit delta");
		let completed = decoder
			.push_payload(update(interaction_update::Message::ToolCallCompleted(
				wire::ToolCallCompletedUpdate {
					call_id: "call-edit".to_owned(),
					tool_call: Some(wire::ToolCall {
						tool_call_id: Some("edit-1".to_owned()),
						tool:         Some(tool_call::Tool::EditToolCall(wire::EditToolCall {
							args: None,
							..Default::default()
						})),
					}),
					..Default::default()
				},
			)))
			.expect("edit completed");
		let arguments = completed
			.into_iter()
			.find_map(|event| match event {
				CursorEvent::ToolCallComplete { name, arguments, .. } if name.as_str() == "edit" => {
					Some(arguments)
				},
				_ => None,
			})
			.expect("complete edit");
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(&arguments).expect("edit JSON"),
			serde_json::json!({"path":"/tmp/note.txt","stream_content":"orange peel"})
		);
	}

	#[test]
	fn native_edit_materialization_read_is_raw_and_write_reuses_active_call() {
		let tool = wire::ToolCall {
			tool_call_id: Some("edit-inner".to_owned()),
			tool:         Some(tool_call::Tool::EditToolCall(wire::EditToolCall {
				args: Some(wire::EditArgs {
					path:           "/tmp/note.txt".to_owned(),
					stream_content: None,
				}),
				..Default::default()
			})),
		};
		let mut decoder = CursorDecoder::default();
		decoder
			.push_payload(update(interaction_update::Message::ToolCallStarted(
				wire::ToolCallStartedUpdate {
					call_id: "edit-envelope".to_owned(),
					tool_call: Some(tool),
					..Default::default()
				},
			)))
			.expect("edit started");
		let read = wire::AgentServerMessage {
			message: Some(agent_server_message::Message::ExecServerMessage(wire::ExecServerMessage {
				id: 7,
				message: Some(exec_server_message::Message::ReadArgs(wire::ReadArgs {
					path: "/tmp/note.txt".to_owned(),
					tool_call_id: "edit-inner".to_owned(),
					offset: Some(2),
					limit: Some(1),
					..Default::default()
				})),
				..Default::default()
			})),
		};
		let events = decoder
			.push_payload(Bytes::from(read.encode_to_vec()))
			.expect("materialization read");
		let CursorEvent::WorkflowInvoke { name, arguments, .. } = &events[0] else {
			panic!("read workflow")
		};
		assert_eq!(name.as_str(), "read");
		assert_eq!(
			serde_json::from_slice::<serde_json::Value>(arguments).expect("read JSON")["path"],
			"/tmp/note.txt:raw:2+1"
		);

		let write = wire::AgentServerMessage {
			message: Some(agent_server_message::Message::ExecServerMessage(wire::ExecServerMessage {
				id: 8,
				message: Some(exec_server_message::Message::WriteArgs(wire::WriteArgs {
					path: "/tmp/note.txt".to_owned(),
					file_text: "after".to_owned(),
					tool_call_id: "edit-inner".to_owned(),
					..Default::default()
				})),
				..Default::default()
			})),
		};
		let events = decoder
			.push_payload(Bytes::from(write.encode_to_vec()))
			.expect("materialization write");
		let CursorEvent::WorkflowInvoke { name, arguments, .. } = &events[0] else {
			panic!("write workflow")
		};
		assert_eq!(name.as_str(), "write");
		let arguments = serde_json::from_slice::<serde_json::Value>(arguments).expect("write JSON");
		assert_eq!(arguments["tool_call_id"], "edit-inner");
		assert_eq!(arguments["content"], "after");
	}

	fn update(message: interaction_update::Message) -> Bytes {
		Bytes::from(
			wire::AgentServerMessage {
				message: Some(agent_server_message::Message::InteractionUpdate(
					wire::InteractionUpdate { message: Some(message) },
				)),
			}
			.encode_to_vec(),
		)
	}

	#[test]
	fn descriptor_pins_service_drift_and_binding_numbers() {
		let descriptors = descriptor_set().expect("checked-in descriptor decodes");
		let file = descriptors
			.file
			.iter()
			.find(|file| file.package.as_deref() == Some("agent.v1"))
			.expect("agent.v1 descriptor");
		let service = file
			.service
			.iter()
			.find(|service| service.name.as_deref() == Some("AgentService"))
			.expect("AgentService descriptor");
		let run = service
			.method
			.iter()
			.find(|method| method.name.as_deref() == Some("Run"))
			.expect("Run method");
		assert_eq!(run.input_type.as_deref(), Some(".agent.v1.AgentClientMessage"));
		assert_eq!(run.output_type.as_deref(), Some(".agent.v1.AgentServerMessage"));
		assert!(!run.client_streaming.unwrap_or(false), "known source descriptor drift pin");
		assert!(!run.server_streaming.unwrap_or(false), "known source descriptor drift pin");

		let interaction = file
			.message_type
			.iter()
			.find(|message| message.name.as_deref() == Some("InteractionUpdate"))
			.expect("InteractionUpdate descriptor");
		let field = |name: &str| {
			interaction
				.field
				.iter()
				.find(|field| field.name.as_deref() == Some(name))
				.and_then(|field| field.number)
		};
		assert_eq!(field("text_delta"), Some(1));
		assert_eq!(field("partial_tool_call"), Some(7));
		assert_eq!(field("token_delta"), Some(8));
		assert_eq!(field("turn_ended"), Some(14));
		assert_eq!(field("tool_call_delta"), Some(15));

		let message_field = |message_name: &str, field_name: &str| {
			file
				.message_type
				.iter()
				.find(|message| message.name.as_deref() == Some(message_name))
				.expect("pinned message descriptor")
				.field
				.iter()
				.find(|field| field.name.as_deref() == Some(field_name))
				.and_then(|field| field.number)
		};
		assert_eq!(message_field("InteractionQuery", "web_fetch_request_query"), Some(9));
		assert_eq!(message_field("InteractionResponse", "web_fetch_request_response"), Some(9));
		assert_eq!(message_field("ToolCall", "web_fetch_tool_call"), Some(37));
		assert_eq!(message_field("McpToolDefinition", "input_schema"), Some(3));
		assert_eq!(message_field("McpToolDefinition", "input_schema_json"), Some(6));
		assert_eq!(message_field("AgentClientMessage", "interaction_response"), Some(6));
		assert_eq!(message_field("AgentServerMessage", "interaction_query"), Some(7));
	}

	#[test]
	fn interaction_queries_are_answered_with_length_prefixed_replies() {
		use wire::{interaction_query::Query, interaction_response::Result as Reply};

		#[derive(serde::Deserialize)]
		struct Fixture {
			cases: Vec<Case>,
		}
		#[derive(serde::Deserialize)]
		struct Case {
			query:           String,
			id:              u32,
			#[serde(default)]
			kind:            Option<String>,
			disposition:     String,
			#[serde(default)]
			reason:          Option<String>,
			#[serde(default)]
			query_frame_hex: Option<String>,
			#[serde(default)]
			reply_frame_hex: Option<String>,
		}

		fn server_query(id: u32, query: Option<Query>) -> Bytes {
			Bytes::from(
				wire::AgentServerMessage {
					message: Some(agent_server_message::Message::InteractionQuery(
						wire::InteractionQuery { id, query },
					)),
				}
				.encode_to_vec(),
			)
		}

		fn named_query(name: &str) -> Query {
			match name {
				"web_search_request_query" => {
					Query::WebSearchRequestQuery(wire::WebSearchRequestQuery::default())
				},
				"ask_question_interaction_query" => {
					Query::AskQuestionInteractionQuery(wire::AskQuestionInteractionQuery::default())
				},
				"switch_mode_request_query" => {
					Query::SwitchModeRequestQuery(wire::SwitchModeRequestQuery::default())
				},
				"exa_search_request_query" => {
					Query::ExaSearchRequestQuery(wire::ExaSearchRequestQuery::default())
				},
				"exa_fetch_request_query" => {
					Query::ExaFetchRequestQuery(wire::ExaFetchRequestQuery::default())
				},
				"create_plan_request_query" => {
					Query::CreatePlanRequestQuery(wire::CreatePlanRequestQuery::default())
				},
				"setup_vm_environment_args" => {
					Query::SetupVmEnvironmentArgs(wire::SetupVmEnvironmentArgs::default())
				},
				"web_fetch_request_query" => {
					Query::WebFetchRequestQuery(wire::WebFetchRequestQuery::default())
				},
				other => panic!("unpinned query case {other}"),
			}
		}

		fn decode_reply(reply: &Bytes) -> wire::AgentClientMessage {
			assert_eq!(reply[0], 0, "reply is an uncompressed Connect data envelope");
			let length = u32::from_be_bytes(reply[1..5].try_into().expect("length prefix")) as usize;
			assert_eq!(length + 5, reply.len(), "envelope length covers the full payload");
			wire::AgentClientMessage::decode(&reply[5..]).expect("reply frame decodes")
		}

		fn reply_response(reply: &Bytes) -> wire::InteractionResponse {
			let Some(agent_client_message::Message::InteractionResponse(response)) =
				decode_reply(reply).message
			else {
				panic!("reply is an interaction_response client message")
			};
			response
		}

		let fixture: Fixture = serde_json::from_slice(&fixture("interaction.queries.json"))
			.expect("typed interaction fixture");
		for case in fixture.cases {
			let events = match case.query.as_str() {
				"unknown" => {
					let payload =
						Bytes::from(decode_hex(case.query_frame_hex.as_deref().expect("raw query")));
					CursorDecoder::default()
						.push_payload(payload)
						.expect("unknown variant query")
				},
				"none" => {
					let events = CursorDecoder::default()
						.push_payload(server_query(case.id, None))
						.expect("bare query");
					assert!(events.is_empty(), "a variant-free query is dropped, not answered");
					continue;
				},
				name => CursorDecoder::default()
					.push_payload(server_query(case.id, Some(named_query(name))))
					.expect("named query"),
			};
			let [CursorEvent::InteractionQuery { id, query, reply }] = events.as_slice() else {
				panic!("exactly one interaction event for {}", case.query)
			};
			assert_eq!(*id, case.id);
			let kind = query
				.as_ref()
				.map_or_else(|| sf!("unknown"), |query| sf!(interaction_query_kind(query)));
			assert_eq!(Some(kind.as_str()), case.kind.as_deref());

			match case.disposition.as_str() {
				"approved" => {
					let response = reply_response(reply.as_ref().expect("approval reply"));
					assert_eq!(response.id, case.id);
					match response.result.expect("approval result") {
						Reply::WebSearchRequestResponse(wire::WebSearchRequestResponse {
							result: Some(web_search_request_response::Result::Approved(_)),
						})
						| Reply::ExaSearchRequestResponse(wire::ExaSearchRequestResponse {
							result: Some(exa_search_request_response::Result::Approved(_)),
						})
						| Reply::ExaFetchRequestResponse(wire::ExaFetchRequestResponse {
							result: Some(exa_fetch_request_response::Result::Approved(_)),
						})
						| Reply::WebFetchRequestResponse(wire::WebFetchRequestResponse {
							result: Some(web_fetch_request_response::Result::Approved(_)),
						}) => {},
						other => panic!("{} must be approved, got {other:?}", case.query),
					}
				},
				"rejected" => {
					let response = reply_response(reply.as_ref().expect("rejection reply"));
					let reason = match response.result.expect("rejection result") {
						Reply::AskQuestionInteractionResponse(response) => {
							let Some(ask_question_result::Result::Rejected(rejected)) =
								response.result.and_then(|result| result.result)
							else {
								panic!("ask-question reply must be rejected")
							};
							rejected.reason
						},
						Reply::SwitchModeRequestResponse(response) => {
							let Some(switch_mode_request_response::Result::Rejected(rejected)) =
								response.result
							else {
								panic!("switch-mode reply must be rejected")
							};
							rejected.reason
						},
						other => panic!("{} must be rejected, got {other:?}", case.query),
					};
					assert_eq!(Some(reason.as_str()), case.reason.as_deref());
				},
				"error" => {
					let response = reply_response(reply.as_ref().expect("error reply"));
					let Some(Reply::CreatePlanRequestResponse(wire::CreatePlanRequestResponse {
						result: Some(result),
					})) = response.result
					else {
						panic!("create-plan reply carries a result")
					};
					let Some(create_plan_result::Result::Error(error)) = result.result else {
						panic!("create-plan reply must be an error")
					};
					assert_eq!(Some(error.error.as_str()), case.reason.as_deref());
				},
				"unanswered" => {
					assert!(reply.is_none(), "no fake SetupVmEnvironmentSuccess is invented");
				},
				"approved_raw" => {
					let reply = reply.as_ref().expect("raw approval reply");
					let expected = decode_hex(case.reply_frame_hex.as_deref().expect("pinned bytes"));
					assert_eq!(
						reply.as_ref(),
						expected.as_slice(),
						"unknown-variant approval pins its LEN-prefixed wire shape"
					);
					// The frame stays decodable even though the mirrored field is
					// unknown to this schema.
					assert_eq!(reply_response(reply).id, case.id);
				},
				other => panic!("unpinned disposition {other}"),
			}
		}

		// The raw same-field fallback and the named field-9 decode agree: an
		// `approved {}` mirrored on field 9 decodes as the named WebFetch
		// approval under the regenerated schema, which also pins the LEN
		// prefix inside the raw payload.
		let raw = unknown_interaction_query_response(18, 9);
		let response = wire::InteractionResponse::decode(raw.as_slice().get(2..).expect("body"))
			.expect("raw reply decodes");
		assert_eq!(response.id, 18);
		assert!(
			matches!(
				response.result,
				Some(Reply::WebFetchRequestResponse(wire::WebFetchRequestResponse {
					result: Some(web_fetch_request_response::Result::Approved(_)),
				}))
			),
			"field-9 raw approval decodes as the named WebFetch approval"
		);
	}

	#[test]
	fn poisoned_conversation_rerotates_only_after_a_clean_rotated_turn() {
		fn wire_decoder(
			conversations: &Arc<Mutex<CursorConversationRotations>>,
			request: &str,
			base: &Str,
		) -> (CursorWireDecoder, Str) {
			let request = RequestId::from(request);
			let (wire_id, _) = conversations
				.lock()
				.begin(&request, base, &sf!("cursor-composer-2.5"));
			let conversation = conversations.lock().take(&request);
			(
				CursorWireDecoder {
					operation: OperationKind::Chat,
					provider: omp_catalog::ProviderId::from("cursor"),
					route: omp_catalog::RouteId::from("cursor/primary"),
					agent: CursorDecoder::default(),
					discovery_done: false,
					conversations: Arc::clone(conversations),
					conversation,
				},
				wire_id,
			)
		}

		fn end_stream(payload: &[u8]) -> Frame {
			Frame::Connect(TransportConnectEnvelope {
				flags:   CONNECT_END_STREAM,
				kind:    ConnectEnvelopeKind::EndStream,
				payload: Bytes::copy_from_slice(payload),
			})
		}

		fn message(payload: Bytes) -> Frame {
			Frame::Connect(TransportConnectEnvelope {
				flags: 0,
				kind: ConnectEnvelopeKind::Message,
				payload,
			})
		}

		const POISONED: &[u8] = br#"{"error":{"code":"resource_exhausted"}}"#;
		let conversations = Arc::new(Mutex::new(CursorConversationRotations::default()));
		let mut sink = |_event: RawEvent| {};
		let base = sf!("conversation-poisoned");

		let (mut first, wire_id) = wire_decoder(&conversations, "request-1", &base);
		assert_eq!(wire_id, base);
		let error = first
			.push(end_stream(POISONED), &mut sink)
			.expect_err("poisoned conversation fails");
		assert_eq!(error.kind, ErrorKind::ResourceExhausted);
		let rotated = conversations.lock().resolve(&base);
		assert_ne!(rotated, base);
		let rebuilt = encode_run_request(&CursorRunRequest {
			model_id:        sf!("cursor-composer-2.5"),
			max_mode:        false,
			conversation_id: Some(rotated.clone()),
			checkpoint:      None,
			root_prompts:    Box::new([]),
			tools:           Box::new([]),
			action:          CursorRunAction::UserMessage {
				message_id: sf!("resume-replay"),
				text:       sf!("Use the read tool."),
			},
		})
		.expect("fresh rotated retry");
		let rebuilt =
			wire::AgentClientMessage::decode(rebuilt.slice(5..)).expect("rotated run request");
		let Some(agent_client_message::Message::RunRequest(rebuilt)) = rebuilt.message else {
			panic!("run request")
		};
		assert!(
			rebuilt
				.conversation_state
				.as_ref()
				.is_some_and(|state| state.pending_tool_calls.is_empty()),
			"rotated retry never migrates poisoned pending tool checkpoints"
		);
		let Some(conversation_action::Action::UserMessageAction(action)) =
			rebuilt.action.and_then(|action| action.action)
		else {
			panic!("rotated resume retry must replay the last user turn")
		};
		assert_eq!(action.user_message.expect("replayed user message").text, "Use the read tool.");

		let (mut failed_rotation, wire_id) = wire_decoder(&conversations, "request-2", &base);
		assert_eq!(wire_id, rotated);
		failed_rotation
			.push(end_stream(POISONED), &mut sink)
			.expect_err("failed rotated turn remains terminal");
		assert_eq!(conversations.lock().resolve(&base), rotated);

		let (mut clean_rotation, wire_id) = wire_decoder(&conversations, "request-3", &base);
		assert_eq!(wire_id, rotated);
		clean_rotation
			.push(
				message(update(interaction_update::Message::TurnEnded(
					wire::TurnEndedUpdate::default(),
				))),
				&mut sink,
			)
			.expect("rotated turn ended");
		clean_rotation
			.push(end_stream(br"{}"), &mut sink)
			.expect("clean Connect end-stream");
		clean_rotation
			.finish(&mut sink)
			.expect("clean rotated completion");
		assert!(conversations.lock().rotation_reusable(&base));

		let (mut poisoned_again, wire_id) = wire_decoder(&conversations, "request-4", &base);
		assert_eq!(wire_id, rotated);
		poisoned_again
			.push(end_stream(POISONED), &mut sink)
			.expect_err("successful rotation may later become poisoned");
		let rerotated = conversations.lock().resolve(&base);
		assert_ne!(rerotated, rotated);

		let (mut trailer_rejected, wire_id) = wire_decoder(&conversations, "request-5", &base);
		assert_eq!(wire_id, rerotated);
		trailer_rejected
			.push(
				message(update(interaction_update::Message::TurnEnded(
					wire::TurnEndedUpdate::default(),
				))),
				&mut sink,
			)
			.expect("application turn ended");
		trailer_rejected
			.push(end_stream(POISONED), &mut sink)
			.expect_err("rejecting trailer invalidates application completion");
		assert_eq!(conversations.lock().resolve(&base), rerotated);

		let billed = sf!("conversation-billed");
		let (mut decoder, _) = wire_decoder(&conversations, "request-6", &billed);
		decoder
			.push(
				message(update(interaction_update::Message::TokenDelta(wire::TokenDeltaUpdate {
					tokens: 3,
				}))),
				&mut sink,
			)
			.expect("token delta projects");
		decoder
			.push(end_stream(POISONED), &mut sink)
			.expect_err("exhaustion after tokens still fails");
		assert_eq!(conversations.lock().resolve(&billed), billed);
	}

	#[test]
	fn discovery_replays_raw_and_connect_fixtures_without_model_heuristics() {
		#[derive(serde::Deserialize)]
		struct Expected {
			models: Vec<ExpectedModel>,
		}
		#[derive(serde::Deserialize)]
		struct ExpectedModel {
			id:        String,
			name:      String,
			reasoning: bool,
			max_mode:  bool,
		}

		let expected: Expected = serde_json::from_slice(&fixture("discovery.expected.json"))
			.expect("typed discovery expectation");
		let raw =
			decode_discovery_response(&fixture("discovery.response.raw.bin")).expect("raw discovery");
		let framed = decode_discovery_response(&fixture("discovery.response.connect.bin"))
			.expect("Connect discovery");
		assert_eq!(raw, framed);
		assert_eq!(raw.len(), expected.models.len());
		for (actual, expected) in raw.iter().zip(expected.models) {
			assert_eq!(actual.id.as_str(), expected.id);
			assert_eq!(actual.name.as_str(), expected.name);
			assert_eq!(actual.reasoning, expected.reasoning);
			assert_eq!(actual.max_mode, expected.max_mode);
			assert!(actual.aliases.is_empty());
		}
		assert_eq!(encode_discovery_request(&[]), Bytes::from(fixture("discovery.request.bin")));
	}

	#[test]
	fn recorded_tool_stream_projects_incrementally_and_authorizes_nothing() {
		let tool = wire::ToolCall {
			tool_call_id: Some("call-read".to_owned()),
			tool:         Some(tool_call::Tool::ReadToolCall(wire::ReadToolCall::default())),
		};
		let payloads = [
			update(interaction_update::Message::ThinkingDelta(wire::ThinkingDeltaUpdate {
				text: "Inspect first.".to_owned(),
			})),
			update(interaction_update::Message::ToolCallStarted(wire::ToolCallStartedUpdate {
				call_id: "call-read".to_owned(),
				tool_call: Some(tool.clone()),
				..Default::default()
			})),
			update(interaction_update::Message::PartialToolCall(wire::PartialToolCallUpdate {
				call_id: "call-read".to_owned(),
				tool_call: Some(tool.clone()),
				args_text_delta: "{\"pa".to_owned(),
				..Default::default()
			})),
			update(interaction_update::Message::PartialToolCall(wire::PartialToolCallUpdate {
				call_id: "call-read".to_owned(),
				tool_call: Some(tool),
				args_text_delta: r#"{"path":"package.json"}"#.to_owned(),
				..Default::default()
			})),
			update(interaction_update::Message::ToolCallCompleted(wire::ToolCallCompletedUpdate {
				call_id: "call-read".to_owned(),
				..Default::default()
			})),
			update(interaction_update::Message::TextDelta(wire::TextDeltaUpdate {
				text: "Done.".to_owned(),
			})),
			update(interaction_update::Message::TokenDelta(wire::TokenDeltaUpdate { tokens: 8 })),
			update(interaction_update::Message::TurnEnded(wire::TurnEndedUpdate {})),
		];
		let mut decoder = CursorDecoder::default();
		let events: Vec<_> = payloads
			.into_iter()
			.flat_map(|payload| decoder.push_payload(payload).expect("recorded protobuf"))
			.collect();
		assert!(events.iter().any(|event| matches!(
			event,
			CursorEvent::Chat(event)
				if matches!(
					event.as_ref(),
					ChatEvent::ThinkingDelta { text, .. } if text == "Inspect first."
				)
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			CursorEvent::ToolCallComplete { id, name, arguments, .. }
				if id.as_str() == "call-read"
					&& name == "read"
					&& arguments.as_ref() == br#"{"path":"package.json"}"#
		)));
		assert!(
			!events.iter().any(|event| matches!(
				event,
				CursorEvent::Chat(event)
					if matches!(event.as_ref(), ChatEvent::ToolCallReady { .. })
			)),
			"codec completion is not schema-validation authorization"
		);
		assert!(events.iter().any(|event| matches!(
			event,
			CursorEvent::Completion {
				reason: FinishReason::ToolCalls,
				usage,
				..
			} if usage.output_tokens == 8
		)));

		#[derive(serde::Deserialize)]
		#[serde(rename_all = "camelCase")]
		struct RecordedLine {
			frame:   String,
			payload: RecordedPayload,
		}
		#[derive(serde::Deserialize)]
		#[serde(rename_all = "camelCase")]
		struct RecordedPayload {
			thinking: Option<RecordedText>,
			tool_call_started: Option<RecordedTool>,
			tool_call_args_text_delta: Option<RecordedArgs>,
			tool_call_completed: Option<RecordedTool>,
			text_delta: Option<RecordedText>,
			usage: Option<RecordedUsage>,
			done: Option<RecordedDone>,
		}
		#[derive(serde::Deserialize)]
		struct RecordedText {
			text: String,
		}
		#[derive(serde::Deserialize)]
		struct RecordedTool {
			id:   String,
			name: String,
		}
		#[derive(serde::Deserialize)]
		#[serde(rename_all = "camelCase")]
		struct RecordedArgs {
			id:        String,
			args_text: String,
		}
		#[derive(serde::Deserialize)]
		struct RecordedUsage {
			#[serde(rename = "inputTokens")]
			input:  u64,
			#[serde(rename = "outputTokens")]
			output: u64,
			#[serde(rename = "cachedInputTokens")]
			cached: u64,
		}
		#[derive(serde::Deserialize)]
		#[serde(rename_all = "camelCase")]
		struct RecordedDone {
			stop_reason: String,
		}

		let stream = String::from_utf8(fixture("stream.tool_args.jsonl")).expect("UTF-8 JSONL");
		let records: Vec<RecordedLine> = stream
			.lines()
			.map(|line| serde_json::from_str(line).expect("typed Cursor stream record"))
			.collect();
		assert_eq!(records.len(), 8);
		assert!(
			records
				.iter()
				.all(|record| record.frame == "interaction_update")
		);
		assert_eq!(records[0].payload.thinking.as_ref().expect("thinking").text, "Inspect first.");
		assert_eq!(
			records[1]
				.payload
				.tool_call_started
				.as_ref()
				.expect("tool")
				.id,
			"call-read"
		);
		assert_eq!(
			records[1]
				.payload
				.tool_call_started
				.as_ref()
				.expect("tool")
				.name,
			"read"
		);
		assert_eq!(
			records[2]
				.payload
				.tool_call_args_text_delta
				.as_ref()
				.expect("args")
				.id,
			"call-read"
		);
		assert_eq!(
			records[2..=3]
				.iter()
				.map(|record| record
					.payload
					.tool_call_args_text_delta
					.as_ref()
					.expect("args")
					.args_text
					.as_str())
				.collect::<String>(),
			r#"{"path":"package.json"}"#
		);
		assert_eq!(
			records[4]
				.payload
				.tool_call_completed
				.as_ref()
				.expect("tool")
				.name,
			"read"
		);
		assert_eq!(records[5].payload.text_delta.as_ref().expect("text").text, "Done.");
		let usage = records[6].payload.usage.as_ref().expect("usage");
		assert_eq!((usage.input, usage.output, usage.cached), (21, 8, 13));
		assert_eq!(records[7].payload.done.as_ref().expect("done").stop_reason, "tool_use");
	}

	#[test]
	fn connect_terminal_malformed_overflow_and_late_frames_are_typed() {
		#[derive(serde::Deserialize)]
		struct TerminalCases {
			cases: Vec<TerminalCase>,
		}
		#[derive(serde::Deserialize)]
		struct TerminalCase {
			id: String,
			path: Option<String>,
			chunks_hex: Option<Vec<String>>,
			expected_payloads_hex: Option<Vec<String>>,
			expected_buffered_bytes: Option<usize>,
		}

		let cases: TerminalCases =
			serde_json::from_slice(&fixture("connect.terminal_expectations.json"))
				.expect("typed terminal fixture");
		for case in cases.cases {
			let chunks = case.chunks_hex.map_or_else(
				|| vec![fixture(case.path.as_deref().expect("path-backed terminal case"))],
				|hex| hex.into_iter().map(|chunk| decode_hex(&chunk)).collect(),
			);
			let mut framing = ConnectFramer::new();
			let mut envelopes = Vec::new();
			for chunk in chunks {
				envelopes.extend(framing.push(Bytes::from(chunk)).expect("framing fixture"));
			}
			if let Some(buffered) = case.expected_buffered_bytes {
				assert_eq!(framing.buffered_len(), buffered, "{}", case.id);
				continue;
			}
			let mut decoder = CursorDecoder::default();
			let mut messages = Vec::new();
			for envelope in envelopes {
				match envelope.kind {
					ConnectEnvelopeKind::Message => messages.push(envelope.payload),
					ConnectEnvelopeKind::EndStream => {
						let result = decoder.push_end_stream(&envelope.payload);
						if case.id == "error_end_stream" {
							assert_eq!(result.expect_err("error trailer").kind, CursorErrorKind::Upstream);
						} else {
							result.expect("normal trailer");
						}
					},
				}
			}
			let expected = case
				.expected_payloads_hex
				.unwrap_or_default()
				.into_iter()
				.map(|payload| Bytes::from(decode_hex(&payload)))
				.collect::<Vec<_>>();
			assert_eq!(messages, expected, "{}", case.id);
		}

		let mut malformed = CursorDecoder::default();
		assert_eq!(
			malformed
				.push_payload(Bytes::from_static(b"\xff"))
				.expect_err("malformed")
				.kind,
			CursorErrorKind::Malformed
		);
		assert_eq!(
			malformed
				.push_end_stream(br#"{"error":{"code":"context_length_exceeded"}}"#)
				.expect_err("overflow")
				.kind,
			CursorErrorKind::ContextOverflow
		);
		let resource = CursorDecoder::default()
			.push_end_stream(br#"{"error":{"code":"resource_exhausted"}}"#)
			.expect_err("resource exhaustion");
		assert_eq!(resource.kind, CursorErrorKind::ResourceExhausted);

		let mut rotations = CursorConversationRotations::default();
		let base = sf!("session-poisoned");
		assert_eq!(rotations.resolve(&base), base);
		assert!(rotations.rotate(&base, "request-one"));
		let rotated = rotations.resolve(&base);
		assert_ne!(rotated, base);
		assert!(!rotations.rotate(&base, "request-two"));
		assert_eq!(rotations.resolve(&base), rotated);

		let mut terminal = CursorDecoder::default();
		terminal
			.push_payload(update(interaction_update::Message::TurnEnded(wire::TurnEndedUpdate {})))
			.expect("turn end");
		assert_eq!(
			terminal
				.push_payload(update(interaction_update::Message::Heartbeat(wire::HeartbeatUpdate {},)))
				.expect_err("late frame")
				.kind,
			CursorErrorKind::AfterTerminal
		);
	}

	#[test]
	fn cursor_model_plan_gate_is_structured_and_codec_scoped() {
		fn classify(payload: &'static [u8]) -> Error {
			let mut decoder = CursorWireDecoder {
				operation:      OperationKind::Chat,
				provider:       omp_catalog::ProviderId::from("cursor"),
				route:          omp_catalog::RouteId::from("route"),
				agent:          CursorDecoder::default(),
				discovery_done: false,
				conversations:  Arc::new(Mutex::new(CursorConversationRotations::default())),
				conversation:   None,
			};
			let mut sink = |_event: RawEvent| {};
			decoder
				.push(
					Frame::Connect(TransportConnectEnvelope {
						flags:   CONNECT_END_STREAM,
						kind:    ConnectEnvelopeKind::EndStream,
						payload: Bytes::from_static(payload),
					}),
					&mut sink,
				)
				.expect_err("plan gate rejects the attempt")
		}

		const PLAN_GATE: &[u8] = br#"{"error":{"code":"resource_exhausted","message":"Error","details":[{"type":"google.rpc.ErrorInfo","value":{"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Named models unavailable","detail":"Free plans can only use Auto."}}}]}}"#;
		let cursor = classify(PLAN_GATE);
		assert_eq!(cursor.kind, ErrorKind::Authorization);
		assert_eq!(cursor.action, RetryAction::RotateAccount);
		assert_eq!(cursor.code.as_deref(), Some("cursor_plan_gate"));
		for payload in [
			br#"{"error":{"code":"resource_exhausted","details":[{"value":{"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Model unavailable on Start"}}}]}}"#
				.as_slice(),
			br#"{"error":{"code":"resource_exhausted","details":[{"value":{"reason":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"detail":"Free plans can only use Auto."}}}]}}"#
				.as_slice(),
		] {
			assert_eq!(classify(payload).code.as_deref(), Some("cursor_plan_gate"));
		}

		for payload in [
			br#"{"error":{"code":"resource_exhausted","message":"ERROR_RATE_LIMITED_CHANGEABLE: Named models unavailable"}}"#
				.as_slice(),
			br#"{"error":{"code":"resource_exhausted","details":[{"value":"{\"error\":\"ERROR_RATE_LIMITED_CHANGEABLE\",\"details\":{\"title\":\"Named models unavailable\"}}"}]}}"#
				.as_slice(),
			br#"{"error":{"code":"resource_exhausted","details":[{"value":{"error":"ERROR_RATE_LIMITED_CHANGEABLE","details":{"title":"Temporary capacity unavailable"}}}]}}"#
				.as_slice(),
		] {
			let error = classify(payload);
			assert_eq!(error.kind, ErrorKind::ResourceExhausted);
			assert_ne!(error.code.as_deref(), Some("cursor_plan_gate"));
		}
	}

	#[test]
	fn checkpoint_reconnect_cancel_and_shell_paths_remain_correlated() {
		let checkpoint = wire::ConversationStateStructure {
			pending_tool_calls: vec!["pending".to_owned()],
			self_summary_count: 3,
			..Default::default()
		};
		let server = wire::AgentServerMessage {
			message: Some(agent_server_message::Message::ConversationCheckpointUpdate(
				checkpoint.clone(),
			)),
		};
		let mut decoder = CursorDecoder::default();
		let events = decoder
			.push_payload(Bytes::from(server.encode_to_vec()))
			.expect("checkpoint");
		let CursorEvent::Checkpoint { data } = &events[0] else {
			panic!("checkpoint event")
		};
		assert_eq!(
			wire::ConversationStateStructure::decode(data.clone()).expect("checkpoint protobuf"),
			checkpoint
		);
		let reconnect =
			encode_reconnect_request(&CursorReconnectRequest { request_id: sf!("request-7") });
		assert_eq!(
			wire::BidiRequestId::decode(reconnect)
				.expect("reconnect request")
				.request_id,
			"request-7"
		);

		let abort = wire::AgentServerMessage {
			message: Some(agent_server_message::Message::ExecServerControlMessage(
				wire::ExecServerControlMessage {
					message: Some(exec_server_control_message::Message::Abort(wire::ExecServerAbort {
						id: 17,
					})),
				},
			)),
		};
		assert!(matches!(
			CursorDecoder::default()
				.push_payload(Bytes::from(abort.encode_to_vec()))
				.expect("abort")
				.as_slice(),
			[CursorEvent::InvokeCancel { id: 17 }]
		));

		#[derive(serde::Deserialize)]
		struct CancelFixture {
			input:    CancelInput,
			expected: CancelExpected,
		}
		#[derive(serde::Deserialize)]
		struct CancelInput {
			server_abort_id: u32,
		}
		#[derive(serde::Deserialize)]
		struct CancelExpected {
			executor_future_dropped: bool,
			no_completion_frames:    bool,
		}
		let cancel_fixture: CancelFixture =
			serde_json::from_slice(&fixture("connect.cancel.json")).expect("typed cancel fixture");
		assert_eq!(cancel_fixture.input.server_abort_id, 17);
		assert!(
			cancel_fixture.expected.executor_future_dropped
				&& cancel_fixture.expected.no_completion_frames
		);
		let mut cancelled = CursorDecoder::default();
		cancelled.cancel();
		assert_eq!(
			cancelled
				.push_payload(update(interaction_update::Message::Heartbeat(wire::HeartbeatUpdate {},)))
				.expect_err("cancel suppresses late frames")
				.kind,
			CursorErrorKind::Cancelled
		);
		cancelled.finish().expect("cancel is terminal");

		let invocation = CursorShellInvocation {
			id:                17,
			exec_id:           sf!("exec-17"),
			call_id:           ToolCallId::from("call-shell"),
			command:           sf!("printf colours"),
			working_directory: sf!("/work/project"),
			timeout_ms:        750,
			streaming:         true,
		};
		assert!(matches!(
			shell_start(&invocation).message,
			Some(agent_client_message::Message::ExecClientMessage(wire::ExecClientMessage {
				message: Some(exec_client_message::Message::ShellStream(wire::ShellStream {
					event: Some(shell_stream::Event::Start(_)),
				})),
				..
			}))
		));
		for (frame, expected) in [
			(shell_stdout(&invocation, "plain"), ("stdout", "plain")),
			(shell_stderr(&invocation, "warning\n"), ("stderr", "warning\n")),
			(
				shell_stdout(&invocation, "\u{1b}[31mred\u{1b}[0m\n"),
				("stdout", "\u{1b}[31mred\u{1b}[0m\n"),
			),
		] {
			let Some(agent_client_message::Message::ExecClientMessage(exec)) = frame.message else {
				panic!("shell output exec frame")
			};
			let Some(exec_client_message::Message::ShellStream(stream)) = exec.message else {
				panic!("shell stream frame")
			};
			let (channel, data) = match stream.event.expect("shell event") {
				shell_stream::Event::Stdout(stdout) => ("stdout", stdout.data),
				shell_stream::Event::Stderr(stderr) => ("stderr", stderr.data),
				_ => panic!("unexpected shell output event"),
			};
			assert_eq!((channel, data.as_str()), expected);
		}
		for completion in [
			CursorShellCompletion::Exited {
				stdout:                  sf!("committed output"),
				stderr:                  Str::default(),
				local_execution_time_ms: 41,
			},
			CursorShellCompletion::Failed {
				code:                    23,
				stdout:                  Str::default(),
				stderr:                  Str::default(),
				local_execution_time_ms: 41,
			},
			CursorShellCompletion::Rejected { reason: sf!("policy detail"), is_readonly: true },
			CursorShellCompletion::PermissionDenied {
				reason:      sf!("policy detail"),
				is_readonly: true,
			},
			CursorShellCompletion::TimedOut { timeout_ms: 750 },
		] {
			let frames = shell_completion_frames(&invocation, &completion);
			assert!(matches!(
				frames.last().and_then(|frame| frame.message.as_ref()),
				Some(agent_client_message::Message::ExecClientControlMessage(
					wire::ExecClientControlMessage {
						message: Some(exec_client_control_message::Message::StreamClose(
							wire::ExecClientStreamClose { id: 17 }
						)),
					}
				))
			));
		}
		#[derive(serde::Deserialize)]
		struct ShellFixture {
			case:    String,
			context: ShellContextFixture,
		}
		#[derive(serde::Deserialize)]
		struct ShellContextFixture {
			id:      u32,
			exec_id: String,
			command: String,
			cwd:     String,
		}
		let shell: ShellFixture = serde_json::from_slice(&fixture("connect.shell_stream.json"))
			.expect("typed shell fixture");
		assert_eq!(shell.case, "stream_order");
		assert_eq!(
			(
				shell.context.id,
				shell.context.exec_id.as_str(),
				shell.context.command.as_str(),
				shell.context.cwd.as_str()
			),
			(17, "exec-17", "printf colours", "/work/project")
		);

		#[derive(serde::Deserialize)]
		struct StatusFixture {
			cases: Vec<StatusCase>,
		}
		#[derive(serde::Deserialize)]
		struct StatusCase {
			outcome: String,
		}
		let statuses: StatusFixture =
			serde_json::from_slice(&fixture("connect.statuses.json")).expect("typed status fixture");
		assert_eq!(
			statuses
				.cases
				.into_iter()
				.map(|case| case.outcome)
				.collect::<Vec<_>>(),
			["exited", "failed", "rejected", "denied", "timeout"]
		);

		#[derive(serde::Deserialize)]
		struct DeadlineFixture {
			input:    DeadlineInput,
			expected: DeadlineExpected,
		}
		#[derive(serde::Deserialize)]
		struct DeadlineInput {
			timeout_ms: u32,
		}
		#[derive(serde::Deserialize)]
		struct DeadlineExpected {
			executor_future_dropped: bool,
			no_completion_frames:    bool,
		}
		let deadline: DeadlineFixture =
			serde_json::from_slice(&fixture("connect.deadline.json")).expect("typed deadline fixture");
		assert_eq!(deadline.input.timeout_ms, 1);
		assert!(deadline.expected.executor_future_dropped && deadline.expected.no_completion_frames);
	}

	#[test]
	fn request_headers_error_and_expectation_fixtures_are_typed() {
		#[derive(serde::Deserialize)]
		struct HeaderFixture {
			request: HeaderRequest,
		}
		#[derive(serde::Deserialize)]
		struct HeaderRequest {
			method:  String,
			url:     String,
			headers: BTreeMap<String, String>,
		}
		let headers: HeaderFixture =
			serde_json::from_slice(&fixture("chat.headers.json")).expect("typed header fixture");
		assert_eq!(headers.request.method, "POST");
		assert!(headers.request.url.ends_with(RUN_PATH));
		assert_eq!(headers.request.headers["x-cursor-client-version"], CLIENT_VERSION);
		assert_eq!(headers.request.headers["content-type"], "application/connect+proto");
		let mut public_headers = BTreeMap::new();
		for_each_public_header(CursorHeaderProfile::Run, |name, value| {
			public_headers.insert(name, value);
		});
		assert_eq!(public_headers.get("te"), Some(&"trailers"));

		#[derive(serde::Deserialize)]
		struct RequestFixture {
			canonical_intent: CanonicalIntent,
		}
		#[derive(serde::Deserialize)]
		struct CanonicalIntent {
			model: String,
			tools: Vec<FixtureTool>,
		}
		#[derive(serde::Deserialize)]
		struct FixtureTool {
			name: String,
		}
		let request: RequestFixture =
			serde_json::from_slice(&fixture("request.tool_call.json")).expect("typed request fixture");
		let input_schema = encode_json_value(&serde_json::json!({
			"type": "object",
			"properties": { "path": { "type": "string" } }
		}))
		.expect("protobuf JSON Value schema");
		let encoded = encode_run_request(&CursorRunRequest {
			model_id:        Str::new(request.canonical_intent.model.as_str()),
			max_mode:        false,
			conversation_id: None,
			checkpoint:      None,
			root_prompts:    Box::new([]),
			tools:           request
				.canonical_intent
				.tools
				.into_iter()
				.map(|tool| CursorToolDefinition {
					name:         Str::new(tool.name),
					description:  None,
					input_schema: input_schema.clone(),
				})
				.collect(),
			action:          CursorRunAction::UserMessage {
				message_id: sf!("request-fixture"),
				text:       sf!("Inspect package.json"),
			},
		})
		.expect("typed run request");
		let run = wire::AgentClientMessage::decode(encoded.slice(5..)).expect("framed run request");
		let Some(agent_client_message::Message::RunRequest(run)) = run.message else {
			panic!("run request")
		};
		assert_eq!(run.model_details.as_ref().expect("model").model_id, "cursor-composer-2.5");
		assert!(
			!run
				.model_details
				.as_ref()
				.expect("model")
				.max_mode
				.expect("explicit ordinary mode")
		);
		assert!(
			!run
				.requested_model
				.as_ref()
				.expect("requested model")
				.max_mode
		);
		assert_eq!(run.mcp_tools.as_ref().expect("tools").mcp_tools[0].name, "read");
		let tool = &run.mcp_tools.as_ref().expect("tools").mcp_tools[0];
		assert_eq!(
			ProtoValue::decode(tool.input_schema.clone()).expect("protobuf JSON Value"),
			ProtoValue::decode(input_schema).expect("expected protobuf JSON Value")
		);
		assert!(tool.input_schema_json.is_none());

		#[derive(serde::Deserialize)]
		struct ToolExpectation {
			outcome: ToolOutcome,
		}
		#[derive(serde::Deserialize)]
		struct ToolOutcome {
			text:       String,
			thinking:   String,
			tool_calls: Vec<ToolOutcomeCall>,
		}
		#[derive(serde::Deserialize)]
		struct ToolOutcomeCall {
			id:   String,
			name: String,
		}
		let expectation: ToolExpectation =
			serde_json::from_slice(&fixture("expected.tool_args.json"))
				.expect("typed tool expectation");
		assert_eq!(
			(expectation.outcome.text.as_str(), expectation.outcome.thinking.as_str()),
			("Done.", "Inspect first.")
		);
		assert_eq!(
			(
				expectation.outcome.tool_calls[0].id.as_str(),
				expectation.outcome.tool_calls[0].name.as_str()
			),
			("call-read", "read")
		);

		#[derive(serde::Deserialize)]
		struct DecodeContract {
			framing:          FramingContract,
			state_invariants: StateInvariants,
		}
		#[derive(serde::Deserialize)]
		struct FramingContract {
			header_bytes:          usize,
			data_flags:            u8,
			end_stream_mask:       u8,
			incremental_buffering: bool,
		}
		#[derive(serde::Deserialize)]
		struct StateInvariants {
			token_delta_is_additive_and_saturating: bool,
			turn_end_stop_reason:                   String,
		}
		let contract: DecodeContract =
			serde_json::from_slice(&fixture("connect.decode_contract.json"))
				.expect("typed decode contract");
		assert_eq!(
			(
				contract.framing.header_bytes,
				contract.framing.data_flags,
				contract.framing.end_stream_mask
			),
			(5, 0, 2)
		);
		assert!(
			contract.framing.incremental_buffering
				&& contract
					.state_invariants
					.token_delta_is_additive_and_saturating
		);
		assert!(
			contract
				.state_invariants
				.turn_end_stop_reason
				.contains("tool_use")
		);

		#[derive(serde::Deserialize)]
		struct ErrorFixture {
			cases: Vec<ErrorCase>,
		}
		#[derive(serde::Deserialize)]
		struct ErrorCase {
			input:    String,
			expected: ErrorExpected,
		}
		#[derive(serde::Deserialize)]
		struct ErrorExpected {
			error_kind: Option<String>,
		}
		let errors: ErrorFixture =
			serde_json::from_slice(&fixture("errors.json")).expect("typed error fixture");
		assert!(errors.cases.iter().any(|case| {
			case.input == "authentication_failure"
				&& case.expected.error_kind.as_deref() == Some("upstream")
		}));
		assert_eq!(
			classify_http_status(401)
				.expect("authentication status")
				.kind,
			CursorErrorKind::Authentication
		);
		assert_eq!(
			classify_http_status(500).expect("upstream status").kind,
			CursorErrorKind::Upstream
		);

		#[derive(serde::Deserialize)]
		struct DiscoveryHttpFixture {
			request: DiscoveryHttpRequest,
		}
		#[derive(serde::Deserialize)]
		struct DiscoveryHttpRequest {
			method:    String,
			url:       String,
			headers:   BTreeMap<String, String>,
			body_path: String,
		}
		let discovery: DiscoveryHttpFixture = serde_json::from_slice(&fixture("discovery.http.json"))
			.expect("typed discovery HTTP fixture");
		assert_eq!(discovery.request.method, "POST");
		assert!(discovery.request.url.ends_with(DISCOVERY_PATH));
		assert_eq!(discovery.request.headers["content-type"], "application/proto");
		assert_eq!(discovery.request.body_path, "discovery.request.bin");
	}

	fn decode_hex(input: &str) -> Vec<u8> {
		hex::decode(input).into_vec().expect("hex oracle fixture")
	}
}
