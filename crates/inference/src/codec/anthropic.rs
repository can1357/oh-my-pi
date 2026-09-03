//! Typed Anthropic Messages projection and incremental event decoding.
use std::str;

use bytes::{Bytes, BytesMut};
use omp_catalog::{
	CodecId, OperationKind, ProviderId, ServiceTier, ThinkingEffort, ThinkingSelection,
};
use omp_core::{Str, encoding::base64, sf};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, value::RawValue};
use strum::IntoStaticStr;

use super::{
	Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
	ProviderMetadataEvent, ProviderStateEvent, RawCompletion, RawEvent, RequestHeader,
	RequestMethod, SizeBounds, ToolInputKind, UnvalidatedToolCall,
};
use crate::{
	answer::{AnswerBody, TokenCount, TokenizerProvenance},
	auth::AuthScheme,
	body::BodySource,
	call::{
		CacheRetention, ChatRequest, ContentPart as CanonicalPart, CountTokensRequest, HostedTool,
		MediaInput, OperationCall, ProviderProof, ReasoningRequest, ReasoningVisibility, Role,
		Setting, StructuredOutput, ToolChoice, ToolDefinition, ToolResultContent,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{EventStreamMessage, Frame, FramingProtocol},
};

/// Version sent in direct Messages headers.
pub const DIRECT_VERSION: &str = "2023-06-01";
/// Version embedded in Vertex `rawPredict` request bodies.
pub const VERTEX_VERSION: &str = "vertex-2023-10-16";
/// Version embedded in Bedrock Anthropic request bodies.
pub const BEDROCK_VERSION: &str = "bedrock-2023-05-31";
/// Direct Messages endpoint.
pub const DIRECT_PATH: &str = "/v1/messages";

/// OAuth beta required by Anthropic's Claude Code inference endpoint.
///
/// Kept here because catalog header profiles are route-wide and cannot vary by
/// the resolved credential kind. These values are required by Anthropic's
/// Claude Code inference endpoint.
const CLAUDE_CODE_OAUTH_BETA: &str = "oauth-2025-04-20";
/// User-Agent emitted by Cowork's Claude desktop inference entrypoint.
const CLAUDE_CODE_USER_AGENT: &str = "claude-cli/2.1.258 (external, claude-desktop)";
/// Identity instruction prepended to OAuth Anthropic system blocks.
const CLAUDE_CODE_SYSTEM_INSTRUCTION: &str =
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/// Prefix isolating custom OAuth tools from Anthropic built-ins.
const CLAUDE_CODE_TOOL_PREFIX: &str = "_";
/// Claude Code's per-request output-token ceiling.
const CLAUDE_CODE_MAX_OUTPUT_TOKENS: u64 = 64_000;

/// Anthropic Messages hosting envelope.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
pub enum AnthropicAdapter {
	/// Anthropic's direct Messages API.
	#[strum(serialize = "2023-06-01")]
	Direct,
	/// Anthropic Messages hosted by Google Vertex `rawPredict`.
	#[strum(serialize = "vertex-2023-10-16")]
	Vertex,
	/// Anthropic Messages hosted by Amazon Bedrock `InvokeModel`.
	#[strum(serialize = "bedrock-2023-05-31")]
	Bedrock,
}

/// Stateless codec for direct, Vertex, or Bedrock-hosted Anthropic Messages.
#[derive(Clone, Debug)]
pub struct AnthropicCodec {
	adapter: AnthropicAdapter,
	betas:   BetaSet,
}

impl AnthropicCodec {
	/// Constructs the direct Anthropic Messages codec.
	pub const fn direct() -> Self {
		Self { adapter: AnthropicAdapter::Direct, betas: BetaSet(Vec::new()) }
	}

	/// Constructs the Vertex `rawPredict` Anthropic Messages codec.
	pub const fn vertex() -> Self {
		Self { adapter: AnthropicAdapter::Vertex, betas: BetaSet(Vec::new()) }
	}

	/// Constructs the Bedrock native Anthropic Messages codec, not Bedrock
	/// Converse.
	pub const fn bedrock() -> Self {
		Self { adapter: AnthropicAdapter::Bedrock, betas: BetaSet(Vec::new()) }
	}

	/// Adds stable-deduplicated protocol betas configured by the selected route.
	pub fn with_betas(mut self, betas: impl IntoIterator<Item = Str>) -> Self {
		for beta in betas {
			self.betas.insert(beta);
		}
		self
	}
}
/// One ordered, stable-deduplicated Anthropic beta list.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BetaSet(Vec<Str>);

impl BetaSet {
	/// Adds a beta exactly once while retaining first-seen order.
	pub fn insert(&mut self, beta: impl Into<Str>) {
		let beta = beta.into();
		if !self.0.iter().any(|existing| existing == &beta) {
			self.0.push(beta);
		}
	}

	/// Extends the set in source order.
	pub fn extend<'a>(&mut self, betas: impl IntoIterator<Item = &'a str>) {
		for beta in betas {
			self.insert(Str::new(beta));
		}
	}

	/// Borrows the ordered unique values.
	pub fn as_slice(&self) -> &[Str] {
		&self.0
	}

	/// Produces the direct API's comma-separated header value.
	pub fn header_value(&self) -> Str {
		let mut value = String::new();
		for (index, beta) in self.0.iter().enumerate() {
			if index != 0 {
				value.push(',');
			}
			value.push_str(beta);
		}
		Str::new(value)
	}
}

/// Cache-control type accepted by Anthropic prompt cache markers.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheControlKind {
	/// Temporary cache policy.
	Ephemeral,
}

/// Cache-control retention accepted by Anthropic prompt cache markers.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CacheTtl {
	/// Cache marker with short retention.
	#[serde(rename = "5m")]
	FiveMinutes,
	/// Cache marker with long retention.
	#[serde(rename = "1h")]
	OneHour,
}

/// Prompt-cache directive accepted on cacheable Anthropic objects.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CacheControl {
	/// Cache directive type.
	#[serde(rename = "type")]
	pub kind:  CacheControlKind,
	/// Requested retention (`5m` or `1h`).
	pub ttl:   CacheTtl,
	/// Optional provider cache scope.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub scope: Option<Str>,
}

impl CacheTtl {
	/// Maps canonical retention buckets to wire representation.
	#[inline]
	const fn from_retention(retention: CacheRetention) -> Self {
		match retention {
			CacheRetention::Long => Self::OneHour,
			CacheRetention::Request | CacheRetention::Session | CacheRetention::Short => {
				Self::FiveMinutes
			},
		}
	}
}

/// Typed inline or uploaded Anthropic media source.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MediaSource {
	/// Base64-encoded immutable media bytes.
	Base64 {
		/// Media MIME type.
		media_type: Str,
		/// Base64-encoded payload.
		data:       Str,
	},
	/// Anthropic Files API object.
	File {
		/// File identifier.
		file_id: Str,
	},
	/// URL-backed media when enabled by route policy.
	Url {
		/// Media URL.
		url: Str,
	},
}
/// A typed Anthropic Messages content block.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
	/// Plain text.
	Text {
		/// Text body.
		text:          Str,
		/// Ephemeral prompt cache control.
		#[serde(skip_serializing_if = "Option::is_none")]
		cache_control: Option<CacheControl>,
	},
	/// Signed reasoning history.
	Thinking {
		/// Thought text.
		thinking:  Str,
		/// Provider-issued cryptographic signature.
		signature: Str,
	},
	/// Opaque redacted reasoning history.
	RedactedThinking {
		/// Redacted thought blob.
		data: Str,
	},
	/// Image input.
	Image {
		/// Media source description.
		source:        MediaSource,
		/// Ephemeral prompt cache control.
		#[serde(skip_serializing_if = "Option::is_none")]
		cache_control: Option<CacheControl>,
	},
	/// Document input.
	Document {
		/// Document media source.
		source:        MediaSource,
		/// Ephemeral prompt cache control.
		#[serde(skip_serializing_if = "Option::is_none")]
		cache_control: Option<CacheControl>,
	},
	/// Caller-executable tool invocation in assistant history.
	ToolUse {
		/// Tool call identifier.
		id:            Str,
		/// Tool name.
		name:          Str,
		/// Input JSON payload.
		input:         Value,
		/// Ephemeral prompt cache control.
		#[serde(skip_serializing_if = "Option::is_none")]
		cache_control: Option<CacheControl>,
	},
	/// Result of a caller-executable tool invocation.
	ToolResult {
		/// Matching tool invocation identifier.
		tool_use_id:   Str,
		/// Optional tool result identifier.
		#[serde(skip_serializing_if = "Option::is_none")]
		id:            Option<Str>,
		/// Whether tool execution produced an error.
		is_error:      bool,
		/// Nested result content, or the empty string for an empty successful
		/// result.
		content:       ToolResultWireContent,
		/// Ephemeral prompt cache control.
		#[serde(skip_serializing_if = "Option::is_none")]
		cache_control: Option<CacheControl>,
	},
	/// Provider-hosted tool invocation retained in replay history.
	ServerToolUse {
		/// Tool call identifier.
		id:    Str,
		/// Tool name.
		name:  Str,
		/// Input JSON payload.
		#[serde(skip_serializing_if = "Option::is_none")]
		input: Option<Value>,
	},
	/// Hosted web-search result retained in replay history.
	WebSearchToolResult {
		/// Tool use identifier.
		tool_use_id: Str,
		/// Result content.
		content:     Value,
	},
	/// Hosted tool-search result retained in replay history.
	ToolSearchToolResult {
		/// Tool use identifier.
		tool_use_id: Str,
		/// Result content.
		content:     Value,
	},
	/// Hosted web-fetch result retained in replay history.
	WebFetchToolResult {
		/// Tool use identifier.
		tool_use_id: Str,
		/// Result content.
		content:     Value,
	},
	/// Hosted code-execution result retained in replay history.
	CodeExecutionToolResult {
		/// Tool use identifier.
		tool_use_id: Str,
		/// Result content.
		content:     Value,
	},
	/// Hosted bash execution result retained in replay history.
	BashCodeExecutionToolResult {
		/// Tool use identifier.
		tool_use_id: Str,
		/// Result content.
		content:     Value,
	},
	/// Hosted text-editor execution result retained in replay history.
	TextEditorCodeExecutionToolResult {
		/// Tool use identifier.
		tool_use_id: Str,
		/// Result content.
		content:     Value,
	},
	/// Provider-recorded model fallback retained as assistant history.
	Fallback {
		/// Original requested model.
		from: Value,
		/// Fallback model selected.
		to:   Value,
	},
}
/// Tool-result wire content: nested blocks or a bare string.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ToolResultWireContent {
	/// Bare string form; the empty string encodes an empty successful result,
	/// which strict Anthropic-compatible endpoints require instead of `[]`.
	Text(Str),
	/// Nested result content blocks.
	Blocks(Vec<ContentBlock>),
}

/// One Anthropic message.
#[derive(Debug, Deserialize, Serialize)]
pub struct Message {
	/// `user` or `assistant`.
	pub role:    Str,
	/// Ordered typed blocks.
	pub content: Vec<ContentBlock>,
}

/// Caller-executable tool declaration.
#[derive(Debug, Deserialize, Serialize)]
pub struct ClientTool {
	/// Tool name.
	pub name:                  Str,
	/// Optional description.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description:           Option<Str>,
	/// Opaque JSON Schema.
	pub input_schema:          Value,
	/// Strict schema enforcement.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub strict:                Option<bool>,
	/// Permit partial argument streaming.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub eager_input_streaming: Option<bool>,
	/// Tool-level cache breakpoint.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cache_control:         Option<CacheControl>,
}

/// Provider-hosted tool declaration.
#[derive(Debug, Deserialize, Serialize)]
pub struct HostedToolDefinition {
	/// Versioned server-tool discriminator.
	#[serde(rename = "type")]
	pub kind:            Str,
	/// Stable server-tool name.
	pub name:            Str,
	/// Optional call bound.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub max_uses:        Option<u32>,
	/// Optional citation behavior.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub citations:       Option<CitationsConfig>,
	/// Domains eligible for results.
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub allowed_domains: Vec<Str>,
	/// Domains excluded from results.
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub blocked_domains: Vec<Str>,
	/// Server-tool cache breakpoint.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cache_control:   Option<CacheControl>,
}

/// Hosted-tool citation switch.
#[derive(Debug, Deserialize, Serialize)]
pub struct CitationsConfig {
	/// Whether provider citations are enabled.
	pub enabled: bool,
}

/// Anthropic tool declaration.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Tool {
	/// Caller-executable JSON-schema tool.
	Client(ClientTool),
	/// Provider-hosted tool.
	Hosted(HostedToolDefinition),
}

/// Anthropic thinking request.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Thinking {
	/// Budgeted extended thinking.
	Enabled {
		/// Maximum reasoning-token budget.
		budget_tokens: u64,
		/// Optional provider display mode.
		#[serde(skip_serializing_if = "Option::is_none")]
		display:       Option<Str>,
	},
	/// Explicitly disabled thinking.
	Disabled,
	/// Adaptive thinking.
	Adaptive {
		/// Optional provider display mode.
		#[serde(skip_serializing_if = "Option::is_none")]
		display: Option<Str>,
	},
}

/// Direct Messages request metadata.
#[derive(Debug, Deserialize, Serialize)]
pub struct Metadata {
	/// End-user identity used for abuse detection.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub user_id: Option<Str>,
	/// Non-secret caller trace correlation.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub trace:   Option<Str>,
}

/// Typed Anthropic context-management request.
#[derive(Debug, Deserialize, Serialize)]
pub struct ContextManagement {
	/// Ordered context edits.
	pub edits: Vec<ContextEdit>,
}

/// Typed Anthropic context edit.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContextEdit {
	/// Clears retained thinking according to a typed keep selector.
	#[serde(rename = "clear_thinking_20251015")]
	ClearThinking20251015 {
		/// Selector for the retained thinking blocks.
		keep: Str,
	},
}

/// Anthropic output controls.
#[derive(Debug, Deserialize, Serialize)]
pub struct OutputConfig {
	/// Qualitative reasoning effort.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub effort:      Option<Str>,
	/// Provider task budget.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub task_budget: Option<u64>,
	/// Typed native output-format payload, intentionally opaque.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub format:      Option<Box<RawValue>>,
}

/// Anthropic tool-choice control.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireToolChoice {
	/// Model decides automatically.
	Auto {
		/// Optional parallel-tool-call restriction.
		#[serde(skip_serializing_if = "Option::is_none")]
		disable_parallel_tool_use: Option<bool>,
	},
	/// Model must call any available tool.
	Any {
		/// Optional parallel-tool-call restriction.
		#[serde(skip_serializing_if = "Option::is_none")]
		disable_parallel_tool_use: Option<bool>,
	},
	/// Model must call the specified tool.
	Tool {
		/// Required tool name.
		name: Str,
		/// Optional parallel-tool-call restriction.
		#[serde(skip_serializing_if = "Option::is_none")]
		disable_parallel_tool_use: Option<bool>,
	},
	/// Model must not call any tool.
	None,
}

/// Typed Anthropic container selector.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Container {
	/// Existing container identifier.
	Id(Str),
	/// Structured container selector.
	State {
		/// Existing container identifier.
		id: Str,
	},
}

/// Fully typed Anthropic Messages body, including cloud envelope fields.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct MessagesRequest {
	/// Direct-API model; stripped by Vertex and Bedrock adapters.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub model:              Option<Str>,
	/// Conversation messages.
	pub messages:           Vec<Message>,
	/// System/developer blocks.
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub system:             Vec<ContentBlock>,
	/// Tool declarations.
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub tools:              Vec<Tool>,
	/// Direct Messages metadata.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub metadata:           Option<Metadata>,
	/// Maximum generated tokens.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub max_tokens:         Option<u64>,
	/// Thinking control.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub thinking:           Option<Thinking>,
	/// Typed context-management control.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub context_management: Option<ContextManagement>,
	/// Output control.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub output_config:      Option<OutputConfig>,
	/// Tool-choice control.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub tool_choice:        Option<WireToolChoice>,
	/// Sampling temperature.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub temperature:        Option<f32>,
	/// Nucleus probability.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub top_p:              Option<f32>,
	/// Candidate bound.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub top_k:              Option<u32>,
	/// Stop sequences.
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub stop_sequences:     Vec<Str>,
	/// Direct API service tier.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub service_tier:       Option<Str>,
	/// Fast-mode selector.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub speed:              Option<Str>,
	/// Provider container selector.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub container:          Option<Container>,
	/// Streaming response request; stripped by cloud adapters.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub stream:             bool,
	/// Vertex/Bedrock embedded protocol version.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub anthropic_version:  Option<Str>,
	/// Vertex/Bedrock embedded stable-deduplicated beta list.
	#[serde(skip_serializing_if = "Vec::is_empty", default)]
	pub anthropic_beta:     Vec<Str>,
}

/// Root fallback chain that Anthropic Messages cannot encode.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestFallback {
	/// Source selector.
	pub from: Str,
	/// Destination selector.
	pub to:   Str,
}

/// Typed request plus explicit unsupported root features.
#[derive(Debug)]
pub struct MessagesIntent {
	/// Typed Messages body.
	pub body:      MessagesRequest,
	/// Requested root fallback chain; non-empty is rejected before
	/// serialization.
	pub fallbacks: Vec<RequestFallback>,
	/// Explicit beta additions in caller order.
	pub betas:     BetaSet,
}

/// Complete adapter projection with direct headers kept separate from its body.
#[derive(Debug)]
pub struct ProjectedMessages {
	/// Adapter-projected body.
	pub body:                     Bytes,
	/// Direct protocol version header, absent for cloud envelopes.
	pub anthropic_version_header: Option<Str>,
	/// Direct comma-separated beta header, absent for cloud envelopes.
	pub anthropic_beta_header:    Option<Str>,
}

#[derive(Serialize)]
struct CountTokensBody {
	model:    Str,
	messages: Vec<Message>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	system:   Vec<ContentBlock>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	tools:    Vec<Tool>,
}

/// JSON Schema keys Anthropic's Messages validator accepts on every node.
///
/// Anthropic's Messages validator accepts only the following schema keys on
/// every node. Anything outside the kept sets draws an HTTP 400
/// `invalid_request_error` (e.g.
/// `For 'integer' type, property 'minimum' is not supported`) and is demoted
/// into the node's `description` so the constraint stays model-visible.
const SCHEMA_UNIVERSAL_KEEP: &[&str] = &[
	"$ref",
	"$defs",
	"$schema",
	"definitions",
	"type",
	"anyOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"nullable",
];
/// Keys additionally preserved on `type: "object"` nodes.
const SCHEMA_OBJECT_KEEP: &[&str] = &["properties", "required", "additionalProperties"];
/// Keys additionally preserved on `type: "array"` nodes; `minItems` survives
/// only when its value is 0 or 1.
const SCHEMA_ARRAY_KEEP: &[&str] = &["items", "prefixItems", "minItems"];
/// Keys additionally preserved on `type: "string"` nodes; `format` survives
/// only for [`SCHEMA_STRING_FORMATS`] values.
const SCHEMA_STRING_KEEP: &[&str] = &["format"];
/// String `format` values Anthropic accepts (SDK `SupportedStringFormats`).
const SCHEMA_STRING_FORMATS: &[&str] =
	&["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"];
/// Schema combinator keys: spilled at the `input_schema` root (Anthropic
/// rejects root combinators), kept when nested — except `oneOf`, which is
/// outside the supported subset and spills at every position.
const SCHEMA_COMBINATORS: &[&str] = &["anyOf", "allOf", "oneOf"];
/// Tools eligible for Anthropic strict tool use, by wire name.
///
/// Strict grammars carry provider-side compile cost, so only high-traffic
/// argument-heavy tools opt in; the allowlist uses the corresponding OMP tool
/// names.
const STRICT_TOOL_ALLOWLIST: &[&str] = &["bash", "shell", "python", "eval", "edit", "find", "glob"];
/// Maximum tools promoted to strict per request.
const MAX_STRICT_TOOLS: usize = 20;
/// Cross-tool budget of properties kept optional under strict.
const MAX_STRICT_OPTIONAL_PARAMETERS: usize = 24;
/// Cross-tool budget of union-typed nodes under strict.
const MAX_STRICT_UNION_PARAMETERS: usize = 16;
/// Keywords whose presence anywhere in the raw wire schema disqualifies a
/// tool from strict promotion.
///
/// Anthropic's strict grammar subset supports anyOf/type-array unions only:
/// `oneOf`/`allOf`/`$ref` compile unpredictably (rejections arrive as 400s),
/// and `patternProperties`/`propertyNames` describe open key sets that the
/// strict pipeline's injected `additionalProperties: false` would contradict.
const STRICT_INCOMPATIBLE_KEYWORDS: &[&str] =
	&["oneOf", "allOf", "$ref", "patternProperties", "propertyNames"];

fn type_array_includes(kinds: &[Value], name: &str) -> bool {
	kinds.iter().any(|kind| kind.as_str() == Some(name))
}

/// `minItems`/`maxItems` apply to arrays; Anthropic rejects them on
/// `type: "object"` nodes (including `minItems: 0`/`1`).
fn is_array_node(schema: &Map<String, Value>) -> bool {
	match schema.get("type") {
		Some(Value::String(kind)) if kind == "array" => return true,
		Some(Value::Array(kinds))
			if type_array_includes(kinds, "array") && !type_array_includes(kinds, "object") =>
		{
			return true;
		},
		_ => {},
	}
	schema.contains_key("items") || schema.get("prefixItems").is_some_and(Value::is_array)
}

fn is_object_node(schema: &Map<String, Value>) -> bool {
	if is_array_node(schema) {
		return false;
	}
	match schema.get("type") {
		Some(Value::String(kind)) if kind == "object" => return true,
		Some(Value::Array(kinds)) if type_array_includes(kinds, "object") => return true,
		_ => {},
	}
	schema.get("properties").is_some_and(Value::is_object)
}

/// Principal non-null scalar type steering the per-type keep set; `"null"` is
/// ignored so nullable variants normalize as their underlying type.
fn effective_scalar_type(schema: &Map<String, Value>) -> Option<&str> {
	match schema.get("type") {
		Some(Value::String(kind)) => return Some(kind),
		Some(Value::Array(kinds)) => {
			for kind in kinds {
				if let Some(name) = kind.as_str()
					&& name != "null"
				{
					return Some(name);
				}
			}
		},
		_ => {},
	}
	if schema.get("properties").is_some_and(Value::is_object) {
		return Some("object");
	}
	if schema.contains_key("items") || schema.get("prefixItems").is_some_and(Value::is_array) {
		return Some("array");
	}
	None
}

fn per_type_keep(scalar_type: Option<&str>) -> &'static [&'static str] {
	match scalar_type {
		Some("object") => SCHEMA_OBJECT_KEEP,
		Some("array") => SCHEMA_ARRAY_KEEP,
		Some("string") => SCHEMA_STRING_KEEP,
		_ => &[],
	}
}

/// Demotes dropped keywords into the node `description` as `{key: value, …}`
/// so the constraint stays model-visible after the wire schema loses it.
fn spill_into_description(node: &mut Map<String, Value>, spill: &[(&str, String)]) {
	if spill.is_empty() {
		return;
	}
	let mut text = String::new();
	if let Some(existing) = node.get("description").and_then(Value::as_str)
		&& !existing.is_empty()
	{
		text.push_str(existing);
		text.push_str("\n\n");
	}
	text.push('{');
	for (index, (key, rendered)) in spill.iter().enumerate() {
		if index > 0 {
			text.push_str(", ");
		}
		text.push_str(key);
		text.push_str(": ");
		text.push_str(rendered);
	}
	text.push('}');
	node.insert("description".into(), Value::String(text));
}

/// Normalizes one JSON Schema node for Anthropic tool `input_schema`.
///
/// Keeps universal keys everywhere (root combinators excepted — Anthropic
/// rejects `anyOf`/`allOf`/`oneOf` at the schema root), keeps per-type keys
/// additively, and spills everything else into `description`. Object nodes
/// default to `additionalProperties: false`; explicit open maps are preserved
/// so the strict pass demotes them to non-strict instead of fabricating a
/// closed object.
fn normalize_tool_schema(schema: &Value, is_root: bool) -> Value {
	let object = match schema {
		Value::Array(entries) => {
			return Value::Array(
				entries
					.iter()
					.map(|entry| normalize_tool_schema(entry, false))
					.collect(),
			);
		},
		Value::Object(object) => object,
		other => return other.clone(),
	};
	let scalar_type = effective_scalar_type(object);
	let keep = per_type_keep(scalar_type);
	let mut result = Map::with_capacity(object.len());
	let mut spill: Vec<(&str, String)> = Vec::new();
	for (key, value) in object {
		let root_combinator = is_root && SCHEMA_COMBINATORS.contains(&key.as_str());
		if !root_combinator
			&& (SCHEMA_UNIVERSAL_KEEP.contains(&key.as_str()) || keep.contains(&key.as_str()))
		{
			result.insert(key.clone(), value.clone());
		} else if let Ok(rendered) = serde_json::to_string(value) {
			spill.push((key, rendered));
		}
	}
	match scalar_type {
		Some("string") => {
			if result
				.get("format")
				.and_then(Value::as_str)
				.is_some_and(|format| !SCHEMA_STRING_FORMATS.contains(&format))
				&& let Some(format) = result.remove("format")
				&& let Ok(rendered) = serde_json::to_string(&format)
			{
				spill.push(("format", rendered));
			}
		},
		Some("array") => {
			if result
				.get("minItems")
				.is_some_and(|value| !value.as_f64().is_some_and(|n| n == 0.0 || n == 1.0))
				&& let Some(min_items) = result.remove("minItems")
				&& let Ok(rendered) = serde_json::to_string(&min_items)
			{
				spill.push(("minItems", rendered));
			}
		},
		Some("object") => {
			result
				.entry("additionalProperties")
				.or_insert(Value::Bool(false));
		},
		_ => {},
	}
	if let Some(Value::Object(properties)) = result.get_mut("properties") {
		*properties = properties
			.iter()
			.map(|(name, property)| (name.clone(), normalize_tool_schema(property, false)))
			.collect();
	}
	if let Some(additional) = result.get_mut("additionalProperties")
		&& additional.is_object()
	{
		let normalized = normalize_tool_schema(additional, false);
		*additional = match &normalized {
			Value::Object(map) if map.is_empty() => Value::Bool(true),
			_ => normalized,
		};
	}
	if let Some(items) = result.get_mut("items")
		&& (items.is_array() || items.is_object())
	{
		*items = normalize_tool_schema(items, false);
	}
	if let Some(prefix_items) = result.get_mut("prefixItems")
		&& prefix_items.is_array()
	{
		*prefix_items = normalize_tool_schema(prefix_items, false);
	}
	for key in SCHEMA_COMBINATORS {
		if let Some(variants) = result.get_mut(*key)
			&& variants.is_array()
		{
			*variants = normalize_tool_schema(variants, false);
		}
	}
	for key in ["$defs", "definitions"] {
		if let Some(Value::Object(definitions)) = result.get_mut(key) {
			*definitions = definitions
				.iter()
				.map(|(name, definition)| (name.clone(), normalize_tool_schema(definition, false)))
				.collect();
		}
	}
	spill_into_description(&mut result, &spill);
	Value::Object(result)
}

/// Remaining and consumed cross-tool strict-schema allowances.
struct StrictBudget {
	optional_remaining: usize,
	union_remaining:    usize,
	optional_used:      usize,
	union_used:         usize,
}

fn has_union_type(schema: &Map<String, Value>) -> bool {
	schema.get("type").is_some_and(Value::is_array)
		|| schema.get("anyOf").is_some_and(Value::is_array)
}

fn has_null_variant(schema: &Map<String, Value>) -> bool {
	if let Some(Value::Array(kinds)) = schema.get("type")
		&& type_array_includes(kinds, "null")
	{
		return true;
	}
	matches!(
		schema.get("anyOf"),
		Some(Value::Array(variants))
			if variants
				.iter()
				.any(|variant| variant.get("type").and_then(Value::as_str) == Some("null"))
	)
}

/// Widens a schema to accept `null`, reusing an existing union shape when one
/// exists and otherwise spending union budget on an `anyOf` wrapper.
fn make_nullable(schema: Value, budget: &mut StrictBudget) -> Option<Value> {
	let schema = match schema {
		Value::Object(mut object) => {
			if has_null_variant(&object) {
				return Some(Value::Object(object));
			}
			if let Some(Value::Array(variants)) = object.get_mut("anyOf") {
				variants.push(serde_json::json!({"type": "null"}));
				return Some(Value::Object(object));
			}
			if let Some(Value::Array(kinds)) = object.get_mut("type") {
				kinds.push(Value::String("null".into()));
				return Some(Value::Object(object));
			}
			Value::Object(object)
		},
		other => other,
	};
	if budget.union_remaining == 0 {
		return None;
	}
	budget.union_remaining -= 1;
	budget.union_used += 1;
	Some(serde_json::json!({"anyOf": [schema, {"type": "null"}]}))
}

/// Keys marking a node as an actual schema rather than bare annotations.
const SCHEMA_DEFINING_KEYS: &[&str] = &[
	"type",
	"properties",
	"additionalProperties",
	"items",
	"prefixItems",
	"enum",
	"const",
	"$ref",
	"anyOf",
	"allOf",
	"oneOf",
	"$defs",
	"definitions",
];

/// Rewrites one base-normalized node into Anthropic's strict subset, or
/// returns `None` when it cannot ride a strict declaration (open maps,
/// annotation-only nodes, exhausted budgets). Optional properties stay
/// optional while budget lasts, then become required-but-nullable.
fn normalize_strict_node(schema: &Value, budget: &mut StrictBudget) -> Option<Value> {
	let object = match schema {
		Value::Array(entries) => {
			let mut result = Vec::with_capacity(entries.len());
			for entry in entries {
				result.push(normalize_strict_node(entry, budget)?);
			}
			return Some(Value::Array(result));
		},
		Value::Object(object) => object,
		other => return Some(other.clone()),
	};
	if !SCHEMA_DEFINING_KEYS
		.iter()
		.any(|key| object.contains_key(*key))
	{
		return None;
	}
	// Strict tool use only supports closed objects; open maps stay on the
	// non-strict plan instead of fabricating a closed object.
	if is_object_node(object) && object.get("additionalProperties") != Some(&Value::Bool(false)) {
		return None;
	}
	if has_union_type(object) {
		if budget.union_remaining == 0 {
			return None;
		}
		budget.union_remaining -= 1;
		budget.union_used += 1;
	}
	let mut result = object.clone();
	if let Some(Value::Object(properties)) = object.get("properties") {
		let originally_required: Vec<&str> = object
			.get("required")
			.and_then(Value::as_array)
			.map(|entries| entries.iter().filter_map(Value::as_str).collect())
			.unwrap_or_default();
		let mut normalized = Map::with_capacity(properties.len());
		let mut required = Vec::with_capacity(properties.len());
		for (name, property) in properties {
			let property = normalize_strict_node(property, budget)?;
			if originally_required.contains(&name.as_str()) {
				normalized.insert(name.clone(), property);
				required.push(Value::String(name.clone()));
				continue;
			}
			if budget.optional_remaining > 0 {
				budget.optional_remaining -= 1;
				budget.optional_used += 1;
				normalized.insert(name.clone(), property);
				continue;
			}
			normalized.insert(name.clone(), make_nullable(property, budget)?);
			required.push(Value::String(name.clone()));
		}
		result.insert("properties".into(), Value::Object(normalized));
		result.insert("required".into(), Value::Array(required));
	}
	if let Some(items) = object.get("items")
		&& (items.is_array() || items.is_object())
	{
		result.insert("items".into(), normalize_strict_node(items, budget)?);
	}
	if let Some(prefix_items) = object.get("prefixItems")
		&& prefix_items.is_array()
	{
		result.insert("prefixItems".into(), normalize_strict_node(prefix_items, budget)?);
	}
	for key in SCHEMA_COMBINATORS {
		if let Some(variants) = object.get(*key)
			&& variants.is_array()
		{
			result.insert((*key).into(), normalize_strict_node(variants, budget)?);
		}
	}
	for key in ["$defs", "definitions"] {
		if let Some(Value::Object(definitions)) = object.get(key) {
			let mut normalized = Map::with_capacity(definitions.len());
			for (name, definition) in definitions {
				normalized.insert(name.clone(), normalize_strict_node(definition, budget)?);
			}
			result.insert(key.into(), Value::Object(normalized));
		}
	}
	Some(Value::Object(result))
}

/// Detects strict-disqualifying keywords anywhere in the raw wire schema; the
/// base normalizer spills several of them into descriptions, erasing the
/// evidence, so this runs before normalization.
fn has_strict_incompatible_keyword(schema: &Value) -> bool {
	match schema {
		Value::Array(entries) => entries.iter().any(has_strict_incompatible_keyword),
		Value::Object(object) => {
			STRICT_INCOMPATIBLE_KEYWORDS
				.iter()
				.any(|key| object.contains_key(*key))
				|| object.values().any(has_strict_incompatible_keyword)
		},
		_ => false,
	}
}

/// One planned tool `input_schema` and its strict promotion.
struct ToolSchemaPlan {
	input_schema: Value,
	strict:       bool,
}

/// Plans every client tool's wire schema: the base whitelist normalization
/// for all tools, then strict promotion for allowlisted strict-declared tools
/// whose schemas fit Anthropic's strict subset within cross-tool budgets.
fn plan_tool_schemas(tools: &[ToolDefinition]) -> Vec<ToolSchemaPlan> {
	let mut plans: Vec<ToolSchemaPlan> = tools
		.iter()
		.map(|tool| ToolSchemaPlan {
			input_schema: normalize_tool_schema(tool.input.wire_schema().0.as_value(), true),
			strict:       false,
		})
		.collect();
	let mut strict_tools = 0_usize;
	let mut optional_used = 0_usize;
	let mut union_used = 0_usize;
	for (index, tool) in tools.iter().enumerate() {
		if strict_tools >= MAX_STRICT_TOOLS {
			break;
		}
		let (parameters, declared_strict) = tool.input.wire_schema();
		if !declared_strict
			|| !STRICT_TOOL_ALLOWLIST.contains(&tool.name.as_str())
			|| has_strict_incompatible_keyword(parameters.as_value())
		{
			continue;
		}
		let mut budget = StrictBudget {
			optional_remaining: MAX_STRICT_OPTIONAL_PARAMETERS - optional_used,
			union_remaining:    MAX_STRICT_UNION_PARAMETERS - union_used,
			optional_used:      0,
			union_used:         0,
		};
		let Some(normalized @ Value::Object(_)) =
			normalize_strict_node(&plans[index].input_schema, &mut budget)
		else {
			continue;
		};
		plans[index] = ToolSchemaPlan { input_schema: normalized, strict: true };
		strict_tools += 1;
		optional_used += budget.optional_used;
		union_used += budget.union_used;
	}
	plans
}

fn lower_count_tokens(
	model: Str,
	provider: &ProviderId<str>,
	codec: &CodecId<str>,
	request: &CountTokensRequest,
	claude_code_oauth: bool,
) -> Result<Bytes, Error> {
	let mut body = CountTokensBody {
		model,
		messages: Vec::new(),
		system: Vec::new(),
		tools: Vec::with_capacity(request.tools.len()),
	};
	for message in request.messages.iter() {
		let blocks = lower_parts(&message.content, None, provider, codec)?;
		match message.role {
			Role::System | Role::Developer => body.system.extend(blocks),
			Role::User | Role::Tool => append_message(&mut body.messages, "user", blocks),
			Role::Assistant => append_message(&mut body.messages, "assistant", blocks),
		}
	}
	if claude_code_oauth {
		prepend_claude_code_identity(&mut body.system);
	}
	for (tool, plan) in request.tools.iter().zip(plan_tool_schemas(&request.tools)) {
		body.tools.push(Tool::Client(ClientTool {
			name:                  if claude_code_oauth {
				claude_code_tool_name(&tool.name)
			} else {
				tool.name.clone()
			},
			description:           tool.description.clone(),
			input_schema:          plan.input_schema,
			strict:                plan.strict.then_some(true),
			eager_input_streaming: None,
			cache_control:         None,
		}));
	}
	serde_json::to_vec(&body)
		.map(Bytes::from)
		.map_err(|_| encoding_error("anthropic.count_tokens.serialize"))
}

/// Serializes a typed request through the selected Anthropic envelope.
pub fn project(
	mut intent: MessagesIntent,
	adapter: AnthropicAdapter,
) -> Result<ProjectedMessages, Error> {
	if !intent.fallbacks.is_empty() {
		return Err(unsupported_fallbacks());
	}
	match adapter {
		AnthropicAdapter::Direct => {
			if intent.body.model.is_none() {
				return Err(encoding_error("anthropic.model.required"));
			}
			intent.body.anthropic_version = None;
			intent.body.anthropic_beta.clear();
			let beta = (!intent.betas.as_slice().is_empty()).then(|| intent.betas.header_value());
			serialize_body(&intent.body).map(|body| ProjectedMessages {
				body,
				anthropic_version_header: Some(sf!(DIRECT_VERSION)),
				anthropic_beta_header: beta,
			})
		},
		AnthropicAdapter::Vertex | AnthropicAdapter::Bedrock => {
			intent.body.model = None;
			intent.body.stream = false;
			intent.body.anthropic_version = Some(sf!(<&'static str>::from(adapter)));
			intent.body.anthropic_beta = intent.betas.0;
			serialize_body(&intent.body).map(|body| ProjectedMessages {
				body,
				anthropic_version_header: None,
				anthropic_beta_header: None,
			})
		},
	}
}

fn is_claude_code_oauth(context: &EncodeContext<'_>, adapter: AnthropicAdapter) -> bool {
	adapter == AnthropicAdapter::Direct && context.auth_scheme == Some(AuthScheme::OAuth)
}

fn prepend_claude_code_identity(system: &mut Vec<ContentBlock>) {
	system.retain(|block| {
		!matches!(
			block,
			ContentBlock::Text { text, .. } if text.as_str() == CLAUDE_CODE_SYSTEM_INSTRUCTION
		)
	});
	system.insert(0, ContentBlock::Text {
		text:          sf!(CLAUDE_CODE_SYSTEM_INSTRUCTION),
		cache_control: None,
	});
}

fn is_anthropic_builtin_tool(name: &str) -> bool {
	["web_search", "code_execution", "text_editor", "computer"]
		.into_iter()
		.any(|builtin| name.eq_ignore_ascii_case(builtin))
}

fn claude_code_tool_name(name: &str) -> Str {
	if is_anthropic_builtin_tool(name) {
		Str::new(name)
	} else {
		let mut prefixed = String::with_capacity(CLAUDE_CODE_TOOL_PREFIX.len() + name.len());
		prefixed.push_str(CLAUDE_CODE_TOOL_PREFIX);
		prefixed.push_str(name);
		Str::new(prefixed)
	}
}

fn strip_claude_code_tool_prefix(name: Str) -> Str {
	name
		.strip_prefix(CLAUDE_CODE_TOOL_PREFIX)
		.map_or(name, Str::new)
}

fn apply_claude_code_fingerprint(body: &mut MessagesRequest, context: &EncodeContext<'_>) {
	prepend_claude_code_identity(&mut body.system);
	for tool in &mut body.tools {
		if let Tool::Client(tool) = tool {
			tool.name = claude_code_tool_name(&tool.name);
		}
	}
	for message in &mut body.messages {
		for block in &mut message.content {
			if let ContentBlock::ToolUse { name, .. } = block {
				*name = claude_code_tool_name(name);
			}
		}
	}
	if let Some(WireToolChoice::Tool { name, .. }) = &mut body.tool_choice {
		*name = claude_code_tool_name(name);
	}
	let mut ceiling = CLAUDE_CODE_MAX_OUTPUT_TOKENS;
	if let Some(limit) = context
		.policy_model
		.and_then(|model| model.limits.maximum_output_tokens)
	{
		ceiling = ceiling.min(limit);
	}
	if let Some(limit) = context.route.capability_limits.maximum_output_tokens {
		ceiling = ceiling.min(limit);
	}
	body.max_tokens = Some(body.max_tokens.unwrap_or(ceiling).min(ceiling));
}

fn serialize_body(body: &MessagesRequest) -> Result<Bytes, Error> {
	serde_json::to_vec(body)
		.map(Bytes::from)
		.map_err(|_| encoding_error("anthropic.request.serialize"))
}

/// Lowers the canonical chat vocabulary into the typed Messages body.
pub fn lower_chat(
	model: Str,
	provider: &ProviderId<str>,
	codec: &CodecId<str>,
	thinking_selection: Option<&ThinkingSelection>,
	request: &ChatRequest,
) -> Result<MessagesRequest, Error> {
	if !matches!(request.reasoning, Setting::Unset) && thinking_selection.is_none() {
		return Err(capability_error("anthropic.thinking.selection_required"));
	}
	if request.sampling.seed.is_some() {
		return Err(capability_error("anthropic.sampling.seed_unsupported"));
	}
	if request.sampling.presence_penalty.is_some() || request.sampling.frequency_penalty.is_some() {
		return Err(capability_error("anthropic.sampling.penalties_unsupported"));
	}
	if request.top_logprobs.is_some() {
		return Err(capability_error("anthropic.logprobs_unsupported"));
	}
	if !request.safety.is_empty() {
		return Err(capability_error("anthropic.safety_settings_unsupported"));
	}
	if !matches!(request.verbosity, Setting::Unset) {
		return Err(capability_error("anthropic.verbosity_unsupported"));
	}
	let cache = cache_control(&request.cache_retention);
	let mut body = MessagesRequest {
		model: Some(model),
		max_tokens: request.max_output_tokens,
		temperature: request.sampling.temperature,
		top_p: request.sampling.top_p,
		top_k: request.sampling.top_k,
		stop_sequences: request.sampling.stop.iter().cloned().collect(),
		stream: true,
		..MessagesRequest::default()
	};
	for message in request.messages.iter() {
		let blocks = lower_parts(&message.content, cache.clone(), provider, codec)?;
		match message.role {
			Role::System | Role::Developer => body.system.extend(blocks),
			Role::User | Role::Tool => append_message(&mut body.messages, "user", blocks),
			Role::Assistant => append_message(&mut body.messages, "assistant", blocks),
		}
	}
	for (tool, plan) in request.tools.iter().zip(plan_tool_schemas(&request.tools)) {
		body.tools.push(Tool::Client(ClientTool {
			name:                  tool.name.clone(),
			description:           tool.description.clone(),
			input_schema:          plan.input_schema,
			strict:                plan.strict.then_some(true),
			eager_input_streaming: None,
			cache_control:         cache.clone(),
		}));
	}
	for tool in request.hosted_tools.iter() {
		match tool {
			HostedTool::WebSearch { allowed_domains, blocked_domains, recency_days } => {
				if recency_days.is_some() {
					return Err(capability_error("anthropic.web_search.recency_unsupported"));
				}
				body.tools.push(Tool::Hosted(HostedToolDefinition {
					kind:            sf!("web_search_20250305"),
					name:            sf!("web_search"),
					max_uses:        None,
					citations:       None,
					allowed_domains: allowed_domains.iter().cloned().collect(),
					blocked_domains: blocked_domains.iter().cloned().collect(),
					cache_control:   cache.clone(),
				}));
			},
			HostedTool::CodeExecution => body.tools.push(Tool::Hosted(HostedToolDefinition {
				kind:            sf!("code_execution_20250522"),
				name:            sf!("code_execution"),
				max_uses:        None,
				citations:       None,
				allowed_domains: Vec::new(),
				blocked_domains: Vec::new(),
				cache_control:   cache.clone(),
			})),
			HostedTool::Retrieval { .. } => {
				return Err(capability_error("anthropic.hosted_retrieval.unsupported"));
			},
		}
	}
	body.tool_choice = lower_tool_choice(&request.tool_choice);
	body.thinking = lower_thinking(thinking_selection, &request.reasoning);
	if let Some(budget) = thinking_selection.and_then(|selection| selection.budget) {
		body.max_tokens = Some(
			body
				.max_tokens
				.unwrap_or(0)
				.max(budget.saturating_add(1024)),
		);
	}
	body.output_config = lower_output_config(thinking_selection, &request.output)?;
	if let Some(tier) = setting_value(&request.service_tier) {
		lower_service_tier(&mut body, tier)?;
	}
	Ok(body)
}
fn lower_service_tier(body: &mut MessagesRequest, tier: &ServiceTier) -> Result<(), Error> {
	if tier.name.is_empty() {
		return Err(capability_error("anthropic.service_tier.empty"));
	}
	if tier.priority > 0 {
		body.speed = Some(tier.name.clone());
	} else {
		body.service_tier = Some(tier.name.clone());
	}
	Ok(())
}

fn append_message(messages: &mut Vec<Message>, role: &'static str, mut blocks: Vec<ContentBlock>) {
	if let Some(last) = messages.last_mut().filter(|last| last.role == role) {
		last.content.append(&mut blocks);
	} else {
		messages.push(Message { role: sf!(role), content: blocks });
	}
}

fn lower_parts(
	parts: &[CanonicalPart],
	cache: Option<CacheControl>,
	provider: &ProviderId<str>,
	codec: &CodecId<str>,
) -> Result<Vec<ContentBlock>, Error> {
	let mut blocks = Vec::with_capacity(parts.len());
	for part in parts {
		let block = match part {
			CanonicalPart::Text { text, proof } => {
				if let Some(proof) = proof {
					validate_proof(proof, provider, codec)?;
					if text.is_empty() {
						replay_history_block(proof)?
					} else {
						return Err(capability_error("anthropic.text.proof_unrepresentable"));
					}
				} else {
					ContentBlock::Text { text: text.clone(), cache_control: cache.clone() }
				}
			},
			CanonicalPart::Reasoning { text, proof } => ContentBlock::Thinking {
				thinking:  text.clone(),
				signature: proof_signature(proof.as_ref(), provider, codec)?,
			},
			CanonicalPart::Image(media) => ContentBlock::Image {
				source:        media_source(media)?,
				cache_control: cache.clone(),
			},
			CanonicalPart::Document(media) => ContentBlock::Document {
				source:        media_source(media)?,
				cache_control: cache.clone(),
			},
			CanonicalPart::Audio(_) => return Err(capability_error("anthropic.audio.unsupported")),
			CanonicalPart::ToolCall { call, name, arguments, proof } => {
				if let Some(proof) = proof {
					validate_proof(proof, provider, codec)?;
					return Err(capability_error("anthropic.tool_call.proof_unrepresentable"));
				}
				ContentBlock::ToolUse {
					id:            Str::new(call.as_str()),
					name:          name.clone(),
					input:         arguments.as_value().clone(),
					cache_control: cache.clone(),
				}
			},
			CanonicalPart::ToolResult { call, name: _, content, is_error } => {
				let blocks = lower_tool_result(content)?;
				// An empty block array is valid for the official API, but strict
				// Anthropic-compatible endpoints reject it (Z.AI GLM: 400 code
				// 1213); the empty-string form is accepted by both.
				let content = if blocks.is_empty() && !*is_error {
					ToolResultWireContent::Text(Str::default())
				} else {
					ToolResultWireContent::Blocks(blocks)
				};
				ContentBlock::ToolResult {
					tool_use_id: Str::new(call.as_str()),
					id: None,
					is_error: *is_error,
					content,
					cache_control: cache.clone(),
				}
			},
			CanonicalPart::CachePoint(retention) => {
				let marker = CacheControl {
					kind:  CacheControlKind::Ephemeral,
					ttl:   match *retention {
						CacheRetention::Long => CacheTtl::OneHour,
						_ => CacheTtl::FiveMinutes,
					},
					scope: None,
				};
				let previous = blocks
					.last_mut()
					.ok_or_else(|| encoding_error("anthropic.cache_point.orphan"))?;
				apply_cache(previous, marker)?;
				continue;
			},
		};
		blocks.push(block);
	}
	Ok(blocks)
}

fn replay_history_block(proof: &ProviderProof) -> Result<ContentBlock, Error> {
	let block: ContentBlock = serde_json::from_slice(&proof.value)
		.map_err(|_| encoding_error("anthropic.history.proof_invalid"))?;
	if matches!(
		&block,
		ContentBlock::ServerToolUse { .. }
			| ContentBlock::WebSearchToolResult { .. }
			| ContentBlock::ToolSearchToolResult { .. }
			| ContentBlock::WebFetchToolResult { .. }
			| ContentBlock::CodeExecutionToolResult { .. }
			| ContentBlock::BashCodeExecutionToolResult { .. }
			| ContentBlock::TextEditorCodeExecutionToolResult { .. }
			| ContentBlock::Fallback { .. }
	) {
		Ok(block)
	} else {
		Err(encoding_error("anthropic.history.proof_kind"))
	}
}

fn lower_tool_result(content: &[ToolResultContent]) -> Result<Vec<ContentBlock>, Error> {
	let mut blocks = Vec::with_capacity(content.len());
	for part in content {
		blocks.push(match part {
			ToolResultContent::Text(text) => {
				ContentBlock::Text { text: text.clone(), cache_control: None }
			},
			ToolResultContent::Json(json) => ContentBlock::Text {
				text:          Str::new(
					serde_json::to_string(json.as_value())
						.map_err(|_| encoding_error("anthropic.tool_result"))?,
				),
				cache_control: None,
			},
			ToolResultContent::Image(media) => {
				ContentBlock::Image { source: media_source(media)?, cache_control: None }
			},
			ToolResultContent::Document(media) => {
				ContentBlock::Document { source: media_source(media)?, cache_control: None }
			},
		});
	}
	Ok(blocks)
}
fn media_source(media: &MediaInput) -> Result<MediaSource, Error> {
	Ok(match media {
		MediaInput::Stored(reference) => MediaSource::File { file_id: reference.id.clone() },
		MediaInput::Remote { uri, .. } => MediaSource::Url { url: uri.clone() },
		MediaInput::Bytes { media_type, data } => {
			let encoded: String = base64::encode(data).map(char::from).collect();
			MediaSource::Base64 { media_type: media_type.clone(), data: Str::new(encoded) }
		},
		MediaInput::Body { .. } => {
			return Err(capability_error("anthropic.media.body_requires_staging"));
		},
	})
}

fn validate_proof(
	proof: &ProviderProof,
	provider: &ProviderId<str>,
	codec: &CodecId<str>,
) -> Result<(), Error> {
	if &proof.provider == provider && &proof.codec == codec {
		Ok(())
	} else {
		Err(capability_error("anthropic.proof.scope_mismatch"))
	}
}

fn proof_signature(
	proof: Option<&ProviderProof>,
	provider: &ProviderId<str>,
	codec: &CodecId<str>,
) -> Result<Str, Error> {
	let proof = proof.ok_or_else(|| capability_error("anthropic.reasoning.proof_required"))?;
	validate_proof(proof, provider, codec)?;
	let signature =
		str::from_utf8(&proof.value).map_err(|_| encoding_error("anthropic.reasoning.proof_utf8"))?;
	Ok(Str::new(signature))
}

fn apply_cache(block: &mut ContentBlock, marker: CacheControl) -> Result<(), Error> {
	match block {
		ContentBlock::Text { cache_control, .. }
		| ContentBlock::Image { cache_control, .. }
		| ContentBlock::Document { cache_control, .. }
		| ContentBlock::ToolUse { cache_control, .. }
		| ContentBlock::ToolResult { cache_control, .. } => {
			*cache_control = Some(marker);
			Ok(())
		},
		_ => Err(capability_error("anthropic.cache_point.block_unsupported")),
	}
}

fn cache_control(setting: &Setting<CacheRetention>) -> Option<CacheControl> {
	setting_value(setting).map(|retention| CacheControl {
		kind:  CacheControlKind::Ephemeral,
		ttl:   CacheTtl::from_retention(*retention),
		scope: None,
	})
}

fn lower_tool_choice(setting: &Setting<ToolChoice>) -> Option<WireToolChoice> {
	setting_value(setting).map(|choice| match choice {
		ToolChoice::Disabled => WireToolChoice::None,
		ToolChoice::Auto => WireToolChoice::Auto { disable_parallel_tool_use: None },
		ToolChoice::Required => WireToolChoice::Any { disable_parallel_tool_use: None },
		ToolChoice::Named(name) => {
			WireToolChoice::Tool { name: name.clone(), disable_parallel_tool_use: None }
		},
	})
}

fn lower_thinking(
	selection: Option<&ThinkingSelection>,
	request: &Setting<ReasoningRequest>,
) -> Option<Thinking> {
	let selection = selection?;
	if selection.effort == ThinkingEffort::Off {
		return (!selection.suppress_when_off).then_some(Thinking::Disabled);
	}
	let display = setting_value(request).and_then(|reasoning| {
		(reasoning.visibility != ReasoningVisibility::Visible)
			.then(|| sf!(<&'static str>::from(reasoning.visibility)))
	});
	if let Some(tokens) = selection.budget {
		Some(Thinking::Enabled { budget_tokens: tokens, display })
	} else {
		Some(Thinking::Adaptive { display })
	}
}

#[derive(Clone, Copy, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
enum AnthropicThinkingEffort {
	Low,
	Minimal,
	Medium,
	High,
	Max,
}

const fn anthropic_thinking_effort(effort: ThinkingEffort) -> AnthropicThinkingEffort {
	match effort {
		ThinkingEffort::Off | ThinkingEffort::Low => AnthropicThinkingEffort::Low,
		ThinkingEffort::Minimal => AnthropicThinkingEffort::Minimal,
		ThinkingEffort::Medium => AnthropicThinkingEffort::Medium,
		ThinkingEffort::High | ThinkingEffort::XHigh => AnthropicThinkingEffort::High,
		ThinkingEffort::Max => AnthropicThinkingEffort::Max,
	}
}

fn lower_output_config(
	selection: Option<&ThinkingSelection>,
	output: &Setting<StructuredOutput>,
) -> Result<Option<OutputConfig>, Error> {
	let effort =
		selection.and_then(|selection| {
			if selection.effort == ThinkingEffort::Off && selection.suppress_when_off {
				return None;
			}
			Some(selection.native_effort.clone().unwrap_or_else(|| {
				sf!(<&'static str>::from(anthropic_thinking_effort(selection.effort)))
			}))
		});
	let format = match setting_value(output) {
		None => None,
		Some(StructuredOutput::JsonObject) => Some(
			serde_json::value::to_raw_value(&JsonObjectFormat { kind: "json" })
				.map_err(|_| encoding_error("anthropic.output.format"))?,
		),
		Some(StructuredOutput::JsonSchema { name, schema, strict }) => Some(
			serde_json::value::to_raw_value(&JsonSchemaFormat {
				kind: "json_schema",
				name,
				schema: schema.as_value(),
				strict: *strict,
			})
			.map_err(|_| encoding_error("anthropic.output.schema"))?,
		),
		Some(StructuredOutput::Regex(_) | StructuredOutput::Lark(_) | StructuredOutput::Ebnf(_)) => {
			return Err(capability_error("anthropic.output.grammar_unsupported"));
		},
	};
	if effort.is_none() && format.is_none() {
		return Ok(None);
	}
	Ok(Some(OutputConfig { effort, task_budget: None, format }))
}

#[derive(Serialize)]
struct JsonObjectFormat<'a> {
	#[serde(rename = "type")]
	kind: &'a str,
}

#[derive(Serialize)]
struct JsonSchemaFormat<'a> {
	#[serde(rename = "type")]
	kind:   &'a str,
	name:   &'a Str,
	schema: &'a Value,
	strict: bool,
}

const fn setting_value<T>(setting: &Setting<T>) -> Option<&T> {
	match setting {
		Setting::Require(value) | Setting::Prefer(value) => Some(value),
		Setting::Unset => None,
	}
}

fn count_tokens_uri(base: &str) -> Str {
	let base = base.trim_end_matches('/');
	let suffix = if base.ends_with("/v1") {
		"/messages/count_tokens"
	} else {
		"/v1/messages/count_tokens"
	};
	let mut uri = String::with_capacity(base.len() + suffix.len());
	uri.push_str(base);
	uri.push_str(suffix);
	Str::new(uri)
}

fn encoded_count_tokens(
	context: &EncodeContext<'_>,
	adapter: AnthropicAdapter,
	betas: &BetaSet,
	request: &CountTokensRequest,
) -> Result<EncodedRequest, Error> {
	if adapter != AnthropicAdapter::Direct {
		return Err(capability_error("anthropic.count_tokens.cloud_adapter_unsupported"));
	}
	let target = context
		.target
		.ok_or_else(|| encoding_error("anthropic.target.required"))?;
	let claude_code_oauth = is_claude_code_oauth(context, adapter);
	let body = lower_count_tokens(
		Str::new(target.wire_model.as_str()),
		&context.route.provider,
		&target.codec,
		request,
		claude_code_oauth,
	)?;
	let mut headers = vec![
		RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
		RequestHeader { name: sf!("anthropic-version"), value: sf!(DIRECT_VERSION) },
	];
	let mut merged_betas = betas.clone();
	if claude_code_oauth {
		merged_betas.insert(sf!(CLAUDE_CODE_OAUTH_BETA));
		headers.push(RequestHeader { name: sf!("user-agent"), value: sf!(CLAUDE_CODE_USER_AGENT) });
	}
	if !merged_betas.as_slice().is_empty() {
		headers
			.push(RequestHeader { name: sf!("anthropic-beta"), value: merged_betas.header_value() });
	}
	Ok(EncodedRequest {
		operation:   OperationKind::CountTokens,
		method:      RequestMethod::Post,
		uri:         count_tokens_uri(target.endpoint.base_url.as_str()),
		headers:     headers.into_boxed_slice(),
		body:        BodySource::Bytes(body),
		framing:     FramingProtocol::Raw,
		bounds:      SizeBounds {
			request_body: 32 * 1024 * 1024,
			frame:        1024 * 1024,
			response:     1024 * 1024,
		},
		sealed_body: None,
	})
}

impl Codec for AnthropicCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		if let OperationCall::CountTokens(request) = operation {
			return encoded_count_tokens(context, self.adapter, &self.betas, request);
		}
		let OperationCall::Chat(request) = operation else {
			return Err(capability_error("anthropic.operation.unsupported"));
		};
		let target = context
			.target
			.ok_or_else(|| encoding_error("anthropic.target.required"))?;
		let mut body = lower_chat(
			Str::new(target.wire_model.as_str()),
			&context.route.provider,
			&target.codec,
			context.thinking_selection,
			request,
		)?;
		let claude_code_oauth = is_claude_code_oauth(context, self.adapter);
		let mut betas = self.betas.clone();
		if claude_code_oauth {
			apply_claude_code_fingerprint(&mut body, context);
			betas.insert(sf!(CLAUDE_CODE_OAUTH_BETA));
		}
		let projected = project(MessagesIntent { body, fallbacks: Vec::new(), betas }, self.adapter)?;
		let mut headers =
			vec![RequestHeader { name: sf!("content-type"), value: sf!("application/json") }];
		if claude_code_oauth {
			headers
				.push(RequestHeader { name: sf!("user-agent"), value: sf!(CLAUDE_CODE_USER_AGENT) });
		}
		if let Some(version) = projected.anthropic_version_header {
			headers.push(RequestHeader { name: sf!("anthropic-version"), value: version });
		}
		if let Some(beta) = projected.anthropic_beta_header {
			headers.push(RequestHeader { name: sf!("anthropic-beta"), value: beta });
		}
		let uri = match self.adapter {
			AnthropicAdapter::Direct => direct_uri(target.endpoint.base_url.as_str()),
			AnthropicAdapter::Vertex | AnthropicAdapter::Bedrock => target.endpoint.base_url.clone(),
		};
		let framing = match self.adapter {
			AnthropicAdapter::Bedrock => FramingProtocol::AwsEventStream,
			AnthropicAdapter::Direct | AnthropicAdapter::Vertex => FramingProtocol::Sse,
		};
		Ok(EncodedRequest {
			operation: OperationKind::Chat,
			method: RequestMethod::Post,
			uri,
			headers: headers.into_boxed_slice(),
			body: BodySource::Bytes(projected.body),
			framing,
			bounds: SizeBounds {
				request_body: 32 * 1024 * 1024,
				frame:        16 * 1024 * 1024,
				response:     256 * 1024 * 1024,
			},
			sealed_body: None,
		})
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		match context.operation {
			OperationKind::CountTokens if self.adapter == AnthropicAdapter::Direct => {
				let target = context
					.target
					.ok_or_else(|| encoding_error("anthropic.count_tokens.target.required"))?;
				Ok(Box::new(CountTokensDecoder {
					done:       false,
					wire_model: Str::new(target.wire_model.as_str()),
				}))
			},
			OperationKind::Chat => Ok(Box::new(AnthropicWireDecoder {
				adapter:           self.adapter,
				claude_code_oauth: self.adapter == AnthropicAdapter::Direct
					&& context.auth_scheme == Some(AuthScheme::OAuth),
				inner:             AnthropicDecoder::new(),
				signature_cursor:  0,
				citation_cursor:   0,
				history_cursor:    0,
			})),
			_ => Err(capability_error("anthropic.decoder.operation_unsupported")),
		}
	}
}

pub(super) fn direct_uri(base: &str) -> Str {
	let base = base.trim_end_matches('/');
	let suffix = if base.ends_with("/v1") {
		"/messages"
	} else {
		DIRECT_PATH
	};
	let mut uri = String::with_capacity(base.len() + suffix.len());
	uri.push_str(base);
	uri.push_str(suffix);
	Str::new(uri)
}

/// Builds a Vertex Anthropic `streamRawPredict` endpoint.
pub fn vertex_endpoint(project: &str, location: &str, model: &str) -> Result<Str, Error> {
	if project.is_empty() || location.is_empty() || model.is_empty() {
		return Err(encoding_error("anthropic.vertex.endpoint.empty"));
	}
	if !valid_region(location) {
		return Err(encoding_error("anthropic.vertex.location.invalid"));
	}
	let host = if location == "global" {
		"https://aiplatform.googleapis.com".to_owned()
	} else {
		format!("https://{location}-aiplatform.googleapis.com")
	};
	Ok(sf!(
		"{host}/v1/projects/{}/locations/{}/publishers/anthropic/models/{}:streamRawPredict",
		path_segment(project),
		path_segment(location),
		path_segment(model),
	))
}

/// Resolves the AWS signing region for a Bedrock Anthropic model.
pub fn resolve_bedrock_region(explicit: &str, model: &str, base_url: &str) -> Str {
	if let Some(region) = arn_region(model) {
		return Str::new(region);
	}
	if let Some((geo, fallback)) = inference_profile_geo(model) {
		if !explicit.is_empty() && region_serves_geo(explicit, geo) {
			return Str::new(explicit);
		}
		return sf!(fallback);
	}
	if !explicit.is_empty() {
		return Str::new(explicit);
	}
	if let Some(region) = endpoint_region(base_url) {
		return Str::new(region);
	}
	sf!("us-east-1")
}

/// Builds a Bedrock `InvokeModelWithResponseStream` endpoint for Anthropic
/// Messages.
pub fn bedrock_endpoint(base_url: &str, region: &str, model: &str) -> Result<Str, Error> {
	if model.is_empty() {
		return Err(encoding_error("anthropic.bedrock.model.empty"));
	}
	let region = resolve_bedrock_region(region, model, base_url);
	if !valid_region(&region) {
		return Err(encoding_error("anthropic.bedrock.region.invalid"));
	}
	let base = if base_url.is_empty() {
		let suffix = if region.starts_with("cn-") {
			"amazonaws.com.cn"
		} else {
			"amazonaws.com"
		};
		format!("https://bedrock-runtime.{region}.{suffix}")
	} else {
		base_url.trim_end_matches('/').to_owned()
	};
	Ok(sf!("{base}/model/{}/invoke-with-response-stream", path_segment(model)))
}

fn valid_region(value: &str) -> bool {
	value
		.bytes()
		.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn path_segment(value: &str) -> String {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut encoded = String::with_capacity(value.len());
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
			encoded.push(char::from(byte));
		} else {
			encoded.push('%');
			encoded.push(char::from(HEX[(byte >> 4) as usize]));
			encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
		}
	}
	encoded
}
#[derive(Debug)]
struct CountTokensDecoder {
	done:       bool,
	wire_model: Str,
}

impl Decoder for CountTokensDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			return Ok(());
		}
		let Frame::Raw(body) = frame else {
			return Err(protocol_error("anthropic.count_tokens.frame", false));
		};
		#[derive(Deserialize)]
		struct Response {
			input_tokens: u64,
		}
		let response: Response = serde_json::from_slice(&body)
			.map_err(|_| protocol_error("anthropic.count_tokens.response", false))?;
		self.done = true;
		emit(RawEvent::Answer(AnswerBody::Tokens(TokenCount {
			tokens:     response.input_tokens,
			provenance: TokenizerProvenance {
				tokenizer: sf!("anthropic-messages-count-tokens"),
				revision:  self.wire_model.clone(),
				exact:     true,
			},
		})));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			Ok(())
		} else {
			Err(protocol_error("anthropic.count_tokens.truncated", false))
		}
	}
}

/// Extracts the signing region from a Bedrock ARN.
pub(crate) fn arn_region(model: &str) -> Option<&str> {
	let mut fields = model.split(':');
	(fields.next()? == "arn").then_some(())?;
	let partition = fields.next()?;
	if !partition.starts_with("aws") || fields.next()? != "bedrock" {
		return None;
	}
	let region = fields.next()?;
	(!region.is_empty()).then_some(region)
}

/// Returns a cross-region inference profile's geo and canonical fallback.
pub(crate) fn inference_profile_geo(model: &str) -> Option<(&str, &'static str)> {
	let (prefix, _) = model.split_once('.')?;
	match prefix {
		"us" => Some(("us", "us-east-1")),
		"us-gov" => Some(("us-gov", "us-gov-west-1")),
		"eu" => Some(("eu", "eu-west-1")),
		"apac" => Some(("apac", "ap-southeast-1")),
		"au" => Some(("au", "ap-southeast-2")),
		"jp" => Some(("jp", "ap-northeast-1")),
		_ => None,
	}
}

/// Reports whether an AWS region serves a Bedrock inference-profile geo.
pub(crate) fn region_serves_geo(region: &str, geo: &str) -> bool {
	match geo {
		"us-gov" => region.starts_with("us-gov-"),
		"us" => region.starts_with("us-") && !region.starts_with("us-gov-"),
		"eu" => region.starts_with("eu-"),
		"apac" => region.starts_with("ap-"),
		"au" => matches!(region, "ap-southeast-2" | "ap-southeast-4"),
		"jp" => matches!(region, "ap-northeast-1" | "ap-northeast-3"),
		_ => false,
	}
}

/// Extracts a concrete region from a Bedrock runtime endpoint.
pub(crate) fn endpoint_region(base_url: &str) -> Option<&str> {
	let host = base_url
		.strip_prefix("https://")
		.or_else(|| base_url.strip_prefix("http://"))?
		.split(['/', ':'])
		.next()?;
	host
		.strip_prefix("bedrock-runtime.")
		.or_else(|| host.strip_prefix("bedrock-runtime-fips."))?
		.strip_suffix(".amazonaws.com")
		.or_else(|| {
			host
				.strip_prefix("bedrock-runtime.")?
				.strip_suffix(".amazonaws.com.cn")
		})
}
#[derive(Debug)]
struct AnthropicWireDecoder {
	adapter:           AnthropicAdapter,
	claude_code_oauth: bool,
	inner:             AnthropicDecoder,
	signature_cursor:  usize,
	citation_cursor:   usize,
	history_cursor:    usize,
}

impl Decoder for AnthropicWireDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let data = match (self.adapter, frame) {
			(AnthropicAdapter::Direct | AnthropicAdapter::Vertex, Frame::Sse(event)) => event.data,
			(AnthropicAdapter::Bedrock, Frame::EventStream(message)) => {
				match bedrock_payload(&message)? {
					Some(data) => data,
					None => return Ok(()),
				}
			},
			_ => return Err(protocol_error("anthropic.frame.kind", false)),
		};
		let events = match self.inner.push_data(&data) {
			Ok(events) => events,
			Err(error) => {
				emit(RawEvent::Failure(error));
				return Ok(());
			},
		};
		for event in events {
			emit_anthropic_event(event, self.claude_code_oauth, emit)?;
		}
		while let Some((index, signature)) = self.inner.outcome.signatures.get(self.signature_cursor)
		{
			emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
				index:     *index,
				signature: Bytes::copy_from_slice(signature.as_bytes()),
			}));
			self.signature_cursor += 1;
		}
		while let Some(citation) = self.inner.outcome.citations.get(self.citation_cursor) {
			let data = serde_json::to_vec(citation)
				.map(Bytes::from)
				.map_err(|_| protocol_error("anthropic.citation.serialize", true))?;
			emit(RawEvent::Metadata(ProviderMetadataEvent::Citations { candidate: 0, data }));
			self.citation_cursor += 1;
		}
		while let Some((index, block)) = self.inner.outcome.server_blocks.get(self.history_cursor) {
			let data = serde_json::to_vec(block)
				.map(Bytes::from)
				.map_err(|_| protocol_error("anthropic.history.serialize", true))?;
			emit(RawEvent::ProviderState(ProviderStateEvent::HistoryBlock { index: *index, data }));
			self.history_cursor += 1;
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let events = match self.inner.finish() {
			Ok(events) => events,
			Err(error) => {
				emit(RawEvent::Failure(error));
				return Ok(());
			},
		};
		for event in events {
			emit_anthropic_event(event, self.claude_code_oauth, emit)?;
		}
		Ok(())
	}

	fn is_complete(&self) -> bool {
		self.inner.completed
	}
}

fn emit_anthropic_event(
	mut event: AnthropicEvent,
	claude_code_oauth: bool,
	emit: &mut dyn FnMut(RawEvent),
) -> Result<(), Error> {
	if claude_code_oauth {
		match &mut event {
			AnthropicEvent::Chat(ChatEvent::ToolCallStarted { name, .. }) => {
				*name = strip_claude_code_tool_prefix(name.clone());
			},
			AnthropicEvent::Chat(ChatEvent::ToolCallReady { call, .. }) => {
				call.name = strip_claude_code_tool_prefix(call.name.clone());
			},
			AnthropicEvent::ToolCallComplete { name, .. } => {
				*name = strip_claude_code_tool_prefix(name.clone());
			},
			AnthropicEvent::Completion(_) | AnthropicEvent::Chat(_) => {},
		}
	}
	match event {
		AnthropicEvent::Completion(completion) => emit(RawEvent::Completion(*completion)),
		AnthropicEvent::Chat(ChatEvent::ToolCallReady { index, call }) => {
			let arguments = serde_json::to_vec(call.arguments.as_value())
				.map(Bytes::from)
				.map_err(|_| protocol_error("anthropic.tool.arguments.serialize", true))?;
			emit(RawEvent::ToolCallComplete {
				index,
				call: UnvalidatedToolCall {
					id: call.id,
					name: call.name,
					input_kind: ToolInputKind::Json,
					arguments,
				},
			});
		},
		AnthropicEvent::Chat(other) => emit(RawEvent::Chat(other)),
		AnthropicEvent::ToolCallComplete { index, id, name, arguments } => {
			emit(RawEvent::ToolCallComplete {
				index,
				call: UnvalidatedToolCall { id, name, input_kind: ToolInputKind::Json, arguments },
			});
		},
	}
	Ok(())
}

#[derive(Deserialize)]
struct BedrockChunk {
	bytes: Str,
}

#[derive(Deserialize)]
struct BedrockException {
	#[serde(default)]
	message: Str,
}

fn bedrock_payload(message: &EventStreamMessage) -> Result<Option<Bytes>, Error> {
	let message_type = message.string_header(":message-type").unwrap_or("event");
	if message_type == "exception" || message_type == "error" {
		let exception = message
			.string_header(":exception-type")
			.or_else(|| message.string_header(":error-code"))
			.unwrap_or("api_error");
		let body = serde_json::from_slice::<BedrockException>(&message.payload)
			.unwrap_or(BedrockException { message: Default::default() });
		return Err(provider_error(
			sf!(match exception {
				"accessDeniedException" | "AccessDeniedException" | "notAuthorized" => {
					"authentication_error"
				},
				"throttlingException" | "ThrottlingException" | "modelTimeoutException" => {
					"rate_limit_error"
				},
				"serviceUnavailableException"
				| "ServiceUnavailableException"
				| "internalServerException"
				| "InternalServerException"
				| "modelStreamErrorException"
				| "ModelStreamErrorException" => "overloaded_error",
				_ => "api_error",
			}),
			body.message,
			false,
		));
	}
	if message.string_header(":event-type") != Some("chunk") {
		return Ok(None);
	}
	let chunk: BedrockChunk = serde_json::from_slice(&message.payload)
		.map_err(|_| protocol_error("anthropic.bedrock.chunk", false))?;
	let bytes = base64::decode(chunk.bytes.as_bytes())
		.into_vec()
		.map(Bytes::from)
		.map_err(|_| protocol_error("anthropic.bedrock.base64", false))?;
	Ok(Some(bytes))
}
/// Provider-specific decoded metadata retained beside canonical events.
#[derive(Debug, Default)]
pub struct AnthropicOutcome {
	/// Wire model identifier from `message_start`.
	pub model:         Option<Str>,
	/// Stop sequence, when one caused termination.
	pub stop_sequence: Option<Str>,
	/// Provider container identifier.
	pub container_id:  Option<Str>,
	/// Service tier reported by the provider.
	pub service_tier:  Option<Str>,
	/// Applied context-management edit kinds.
	pub context_edits: Vec<Str>,
	/// Reasoning signatures ordered by block index.
	pub signatures:    Vec<(u32, Str)>,
	/// Citation payloads retained as opaque provider records.
	pub citations:     Vec<Value>,
	/// Hosted server-tool blocks retained for canonical history replay.
	pub server_blocks: Vec<(u32, ContentBlock)>,
	/// Final merged usage.
	pub usage:         Usage,
}

#[derive(Debug)]
pub(crate) enum AnthropicEvent {
	Chat(ChatEvent),
	ToolCallComplete { index: u32, id: ToolCallId, name: Str, arguments: Bytes },
	Completion(Box<RawCompletion>),
}

impl From<ChatEvent> for AnthropicEvent {
	fn from(event: ChatEvent) -> Self {
		Self::Chat(event)
	}
}

impl From<RawCompletion> for AnthropicEvent {
	fn from(completion: RawCompletion) -> Self {
		Self::Completion(Box::new(completion))
	}
}

#[derive(Default)]
struct EventBuffer(Vec<AnthropicEvent>);

impl EventBuffer {
	fn push(&mut self, event: impl Into<AnthropicEvent>) {
		self.0.push(event.into());
	}
}

#[derive(Debug)]
enum BlockState {
	Text,
	Thinking { signature: String },
	Tool { id: Str, name: Str, arguments: BytesMut },
	ServerTool { history: usize, arguments: BytesMut },
	Server,
}

/// Incremental decoder for typed Anthropic SSE data payloads.
#[derive(Debug, Default)]
pub(crate) struct AnthropicDecoder {
	blocks:           Vec<Option<BlockState>>,
	outcome:          AnthropicOutcome,
	stop_reason:      Option<Str>,
	completed:        bool,
	canonical_blocks: u32,
}

impl AnthropicDecoder {
	/// Constructs an empty decoder.
	pub(crate) fn new() -> Self {
		Self::default()
	}

	/// Borrows provider metadata accumulated during decoding.
	#[cfg(test)]
	pub(crate) const fn outcome(&self) -> &AnthropicOutcome {
		&self.outcome
	}

	/// Decodes one complete SSE `data` payload into canonical events.
	pub(crate) fn push_data(&mut self, data: &[u8]) -> Result<Vec<AnthropicEvent>, Error> {
		if data.is_empty() || data == b"[DONE]" {
			return Ok(Vec::new());
		}
		let incoming: Incoming = match serde_json::from_slice(data) {
			Ok(incoming) => incoming,
			Err(error) if error.is_eof() && self.accepts_truncated_tool_delta(data) => {
				return Ok(Vec::new());
			},
			Err(_) => return Err(protocol_error("anthropic.sse.json", self.completed)),
		};
		if self.completed {
			return if matches!(incoming, Incoming::MessageStop) {
				Ok(Vec::new())
			} else {
				Err(protocol_error("anthropic.sse.after_terminal", true))
			};
		}
		self.decode(incoming)
	}

	/// Finishes the stream, rejecting a response that omitted `message_stop`.
	pub(crate) fn finish(&self) -> Result<Vec<AnthropicEvent>, Error> {
		if self.completed {
			Ok(Vec::new())
		} else {
			Err(protocol_error("anthropic.sse.truncated", self.canonical_blocks != 0))
		}
	}

	fn accepts_truncated_tool_delta(&self, data: &[u8]) -> bool {
		const EVENT: &[u8] = br#"{"type":"content_block_delta""#;
		const DELTA: &[u8] = br#""type":"input_json_delta""#;
		data.starts_with(EVENT)
			&& data.windows(DELTA.len()).any(|window| window == DELTA)
			&& self
				.blocks
				.iter()
				.any(|block| matches!(block, Some(BlockState::Tool { .. })))
	}

	fn decode(&mut self, incoming: Incoming) -> Result<Vec<AnthropicEvent>, Error> {
		let mut events = EventBuffer::default();
		match incoming {
			Incoming::MessageStart { message } => {
				self.outcome.model = message.model;
				self.outcome.container_id = message.container.map(|container| container.id);
				self.outcome.service_tier = message.service_tier;
				if let Some(context) = message.context_management {
					self
						.outcome
						.context_edits
						.extend(context.applied_edits.into_iter().map(|edit| match edit {
							IncomingAppliedEdit::ClearThinking20251015 => {
								sf!("clear_thinking_20251015")
							},
						}));
				}
				if let Some(usage) = message.usage {
					merge_usage(&mut self.outcome.usage, usage);
				}
			},
			Incoming::ContentBlockStart { index, content_block } => {
				self.ensure_block(index);
				match content_block {
					IncomingBlock::Text { text } => {
						self.canonical_blocks = self.canonical_blocks.saturating_add(1);
						self.blocks[index as usize] = Some(BlockState::Text);
						events.push(ChatEvent::BlockStarted { index, kind: BlockKind::Text });
						if !text.is_empty() {
							events.push(ChatEvent::TextDelta { index, text });
						}
					},
					IncomingBlock::Thinking { thinking, signature } => {
						self.canonical_blocks = self.canonical_blocks.saturating_add(1);
						self.blocks[index as usize] =
							Some(BlockState::Thinking { signature: signature.to_string() });
						events.push(ChatEvent::BlockStarted { index, kind: BlockKind::Thinking });
						if !thinking.is_empty() {
							events.push(ChatEvent::ThinkingDelta { index, text: thinking });
						}
					},
					IncomingBlock::RedactedThinking { data } => {
						self.canonical_blocks = self.canonical_blocks.saturating_add(1);
						self.outcome.signatures.push((index, data));
						self.blocks[index as usize] =
							Some(BlockState::Thinking { signature: String::new() });
						events.push(ChatEvent::BlockStarted { index, kind: BlockKind::Thinking });
					},
					IncomingBlock::ToolUse { id, name, input } => {
						self.canonical_blocks = self.canonical_blocks.saturating_add(1);
						let encoded = serde_json::to_vec(&input)
							.map_err(|_| protocol_error("anthropic.tool.arguments", true))?;
						let arguments = if encoded == b"{}" {
							BytesMut::new()
						} else {
							BytesMut::from(encoded.as_slice())
						};
						self.blocks[index as usize] =
							Some(BlockState::Tool { id: id.clone(), name: name.clone(), arguments });
						events.push(ChatEvent::BlockStarted { index, kind: BlockKind::ToolCall });
						events.push(ChatEvent::ToolCallStarted { index, id: ToolCallId::new(id), name });
					},
					IncomingBlock::ServerToolUse { id, name, input } => {
						let arguments = input
							.as_ref()
							.filter(|value| !matches!(value, Value::Object(object) if object.is_empty()))
							.map(serde_json::to_vec)
							.transpose()
							.map_err(|_| protocol_error("anthropic.server_tool.arguments", true))?
							.map_or_else(BytesMut::new, |bytes| BytesMut::from(bytes.as_slice()));
						let history = self.outcome.server_blocks.len();
						self
							.outcome
							.server_blocks
							.push((index, ContentBlock::ServerToolUse { id, name, input }));
						self.blocks[index as usize] = Some(BlockState::ServerTool { history, arguments });
					},
					IncomingBlock::WebSearchToolResult { tool_use_id, content } => {
						self
							.outcome
							.server_blocks
							.push((index, ContentBlock::WebSearchToolResult { tool_use_id, content }));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
					IncomingBlock::ToolSearchToolResult { tool_use_id, content } => {
						self
							.outcome
							.server_blocks
							.push((index, ContentBlock::ToolSearchToolResult { tool_use_id, content }));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
					IncomingBlock::WebFetchToolResult { tool_use_id, content } => {
						self
							.outcome
							.server_blocks
							.push((index, ContentBlock::WebFetchToolResult { tool_use_id, content }));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
					IncomingBlock::CodeExecutionToolResult { tool_use_id, content } => {
						self
							.outcome
							.server_blocks
							.push((index, ContentBlock::CodeExecutionToolResult { tool_use_id, content }));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
					IncomingBlock::BashCodeExecutionToolResult { tool_use_id, content } => {
						self.outcome.server_blocks.push((
							index,
							ContentBlock::BashCodeExecutionToolResult { tool_use_id, content },
						));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
					IncomingBlock::TextEditorCodeExecutionToolResult { tool_use_id, content } => {
						self.outcome.server_blocks.push((
							index,
							ContentBlock::TextEditorCodeExecutionToolResult { tool_use_id, content },
						));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
					IncomingBlock::Fallback { from, to } => {
						self
							.outcome
							.server_blocks
							.push((index, ContentBlock::Fallback { from, to }));
						self.blocks[index as usize] = Some(BlockState::Server);
					},
				}
			},
			Incoming::ContentBlockDelta { index, delta } => match delta {
				IncomingDelta::Text { text } => events.push(ChatEvent::TextDelta { index, text }),
				IncomingDelta::Thinking { thinking } => {
					events.push(ChatEvent::ThinkingDelta { index, text: thinking });
				},
				IncomingDelta::Signature { signature } => {
					if let Some(Some(BlockState::Thinking { signature: target })) =
						self.blocks.get_mut(index as usize)
					{
						target.push_str(&signature);
					} else {
						return Err(protocol_error("anthropic.signature.block", true));
					}
				},
				IncomingDelta::InputJson { partial_json } => {
					let bytes = Bytes::copy_from_slice(partial_json.as_bytes());
					match self.blocks.get_mut(index as usize) {
						Some(Some(BlockState::Tool { arguments, .. })) => {
							arguments.extend_from_slice(&bytes);
							events.push(ChatEvent::ToolArgumentsDelta { index, bytes });
						},
						Some(Some(BlockState::ServerTool { arguments, .. })) => {
							arguments.extend_from_slice(&bytes);
						},
						_ => return Err(protocol_error("anthropic.tool_delta.block", true)),
					}
				},
				IncomingDelta::Citation { citation } => self.outcome.citations.push(citation),
			},
			Incoming::ContentBlockStop { index } => {
				let state = self
					.blocks
					.get_mut(index as usize)
					.and_then(Option::take)
					.ok_or_else(|| protocol_error("anthropic.block.stop", true))?;
				match state {
					BlockState::Tool { id, name, arguments } => {
						events.push(AnthropicEvent::ToolCallComplete {
							index,
							id: ToolCallId::new(id),
							name,
							arguments: if arguments.is_empty() {
								Bytes::from_static(b"{}")
							} else {
								arguments.freeze()
							},
						});
					},
					BlockState::ServerTool { history, arguments } if !arguments.is_empty() => {
						let input = serde_json::from_slice(&arguments)
							.map_err(|_| protocol_error("anthropic.server_tool.arguments", true))?;
						let Some((_, ContentBlock::ServerToolUse { input: target, .. })) =
							self.outcome.server_blocks.get_mut(history)
						else {
							return Err(protocol_error("anthropic.server_tool.history", true));
						};
						*target = Some(input);
					},
					BlockState::Thinking { signature } if !signature.is_empty() => {
						self.outcome.signatures.push((index, Str::new(signature)));
					},
					BlockState::Text
					| BlockState::Thinking { .. }
					| BlockState::ServerTool { .. }
					| BlockState::Server => {},
				}
			},
			Incoming::MessageDelta { delta, usage } => {
				if let Some(reason) = delta.stop_reason {
					self.stop_reason = Some(reason);
				}
				self.outcome.stop_sequence = delta.stop_sequence;
				if let Some(usage) = usage {
					merge_usage(&mut self.outcome.usage, usage);
					events.push(ChatEvent::Usage(UsageUpdate {
						usage:        self.outcome.usage,
						final_update: false,
					}));
				}
			},
			Incoming::MessageStop => {
				self.completed = true;
				events.push(RawCompletion {
					reason: finish_reason(self.stop_reason.as_deref()),
					blocks: self.canonical_blocks,
					usage:  self.outcome.usage,
				});
			},
			Incoming::Error { error } => {
				return Err(provider_error(error.kind, error.message, self.canonical_blocks != 0));
			},
			Incoming::Ping => {},
		}
		Ok(events.0)
	}

	fn ensure_block(&mut self, index: u32) {
		let needed = index as usize + 1;
		if self.blocks.len() < needed {
			self.blocks.resize_with(needed, || None);
		}
	}
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Incoming {
	MessageStart {
		message: IncomingMessage,
	},
	ContentBlockStart {
		index:         u32,
		content_block: IncomingBlock,
	},
	ContentBlockDelta {
		index: u32,
		delta: IncomingDelta,
	},
	ContentBlockStop {
		index: u32,
	},
	MessageDelta {
		delta: IncomingMessageDelta,
		#[serde(default)]
		usage: Option<IncomingUsage>,
	},
	MessageStop,
	Error {
		error: IncomingError,
	},
	Ping,
}

#[derive(Debug, Deserialize)]
struct IncomingMessage {
	#[serde(default)]
	model:              Option<Str>,
	#[serde(default)]
	usage:              Option<IncomingUsage>,
	#[serde(default)]
	container:          Option<IncomingContainer>,
	#[serde(default)]
	service_tier:       Option<Str>,
	#[serde(default)]
	context_management: Option<IncomingContextManagement>,
}

#[derive(Debug, Deserialize)]
struct IncomingContainer {
	id: Str,
}

#[derive(Debug, Deserialize)]
struct IncomingContextManagement {
	applied_edits: Vec<IncomingAppliedEdit>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum IncomingAppliedEdit {
	#[serde(rename = "clear_thinking_20251015")]
	ClearThinking20251015,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IncomingBlock {
	Text {
		#[serde(default)]
		text: Str,
	},
	Thinking {
		#[serde(default)]
		thinking:  Str,
		#[serde(default)]
		signature: Str,
	},
	RedactedThinking {
		data: Str,
	},
	ToolUse {
		id:    Str,
		name:  Str,
		input: Value,
	},
	ServerToolUse {
		id:    Str,
		name:  Str,
		#[serde(default)]
		input: Option<Value>,
	},
	WebSearchToolResult {
		tool_use_id: Str,
		content:     Value,
	},
	ToolSearchToolResult {
		tool_use_id: Str,
		content:     Value,
	},
	WebFetchToolResult {
		tool_use_id: Str,
		content:     Value,
	},
	CodeExecutionToolResult {
		tool_use_id: Str,
		content:     Value,
	},
	BashCodeExecutionToolResult {
		tool_use_id: Str,
		content:     Value,
	},
	TextEditorCodeExecutionToolResult {
		tool_use_id: Str,
		content:     Value,
	},
	Fallback {
		from: Value,
		to:   Value,
	},
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum IncomingDelta {
	#[serde(rename = "text_delta")]
	Text { text: Str },
	#[serde(rename = "thinking_delta")]
	Thinking { thinking: Str },
	#[serde(rename = "signature_delta")]
	Signature { signature: Str },
	#[serde(rename = "input_json_delta")]
	InputJson { partial_json: Str },
	#[serde(rename = "citation_delta")]
	Citation { citation: Value },
}

#[derive(Debug, Default, Deserialize)]
struct IncomingMessageDelta {
	#[serde(default)]
	stop_reason:   Option<Str>,
	#[serde(default)]
	stop_sequence: Option<Str>,
}

#[derive(Debug, Default, Deserialize)]
struct IncomingUsage {
	#[serde(default)]
	input_tokens:                Option<u64>,
	#[serde(default)]
	output_tokens:               Option<u64>,
	#[serde(default)]
	cache_read_input_tokens:     Option<u64>,
	#[serde(default)]
	cache_creation_input_tokens: Option<u64>,
	#[serde(default)]
	server_tool_use:             Option<ServerToolUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct ServerToolUsage {
	#[serde(default)]
	web_search_requests: u32,
	#[serde(default)]
	web_fetch_requests:  u32,
}

#[derive(Debug, Deserialize)]
struct IncomingError {
	#[serde(rename = "type")]
	kind:    Str,
	message: Str,
}

const fn merge_usage(target: &mut Usage, incoming: IncomingUsage) {
	if let Some(value) = incoming.input_tokens {
		target.input_tokens = value;
	}
	if let Some(value) = incoming.output_tokens {
		target.output_tokens = value;
	}
	if let Some(value) = incoming.cache_read_input_tokens {
		target.cache_read_tokens = value;
	}
	if let Some(value) = incoming.cache_creation_input_tokens {
		target.cache_write_tokens = value;
	}
	if let Some(server) = incoming.server_tool_use {
		target.search_calls = server
			.web_search_requests
			.saturating_add(server.web_fetch_requests);
	}
	target.source = UsageSource::Provider;
}

fn finish_reason(reason: Option<&str>) -> FinishReason {
	match reason {
		None | Some("end_turn" | "stop_sequence" | "stop") => FinishReason::Stop,
		Some("max_tokens" | "model_context_window_exceeded") => FinishReason::Length,
		Some("tool_use") => FinishReason::ToolCalls,
		Some(other) => FinishReason::Other(Str::new(other)),
	}
}

fn unsupported_fallbacks() -> Error {
	Error::planning(
		ErrorKind::CapabilityMismatch,
		ErrorDetail::capability(
			sf!("request.fallbacks"),
			ReasonId(sf!("anthropic.messages.root_fallbacks_unrepresentable")),
		),
		ExecutionReceipt::default(),
	)
}

fn capability_error(reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::CapabilityMismatch,
		ErrorDetail::capability(sf!(reason), ReasonId(sf!(reason))),
		ExecutionReceipt::default(),
	)
}

fn encoding_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn protocol_error(reason: &'static str, committed: bool) -> Error {
	Error::new(
		ErrorKind::StreamCorruption,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.committed(committed)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn provider_error(kind: Str, _message: Str, committed: bool) -> Error {
	use std::time::Duration;
	let (error_kind, status, action) = match kind.as_str() {
		"authentication_error" => (
			ErrorKind::Authentication,
			Some(401),
			if committed {
				RetryAction::Never
			} else {
				RetryAction::RefreshCredential
			},
		),
		"permission_error" => (
			ErrorKind::Authorization,
			Some(403),
			if committed {
				RetryAction::Never
			} else {
				RetryAction::RotateAccount
			},
		),
		// Transient throttle: short backoff on the same credential; the retry
		// layer refuses once output has committed.
		"rate_limit_error" => (ErrorKind::RateLimited, Some(429), RetryAction::SameRoute {
			after: Duration::from_secs(30),
		}),
		// Provider overload clears on its own; a oneshot replay is safe.
		"overloaded_error" => (ErrorKind::ResourceExhausted, Some(529), RetryAction::SameRoute {
			after: Duration::from_millis(500),
		}),
		"invalid_request_error" => (ErrorKind::InvalidRequest, Some(400), RetryAction::Never),
		_ => (ErrorKind::Protocol, None, RetryAction::Never),
	};
	Error::new(error_kind, ErrorPhase::Streaming, action, ExecutionReceipt::default())
		.status(status)
		.code(kind)
		.committed(committed)
}

/// Classifies a non-success direct Anthropic HTTP response without retaining
/// its message.
pub fn classify_http_error(status: u16, body: &[u8]) -> Error {
	#[derive(Deserialize)]
	struct Envelope {
		error: IncomingError,
	}
	if let Ok(envelope) = serde_json::from_slice::<Envelope>(body) {
		provider_error(envelope.error.kind, envelope.error.message, false).status(Some(status))
	} else {
		protocol_error("anthropic.http.error_envelope", false).status(Some(status))
	}
}

/// Classifies a non-success Vertex RPC error envelope.
pub fn classify_vertex_error(status: u16, body: &[u8]) -> Error {
	#[derive(Deserialize)]
	struct Envelope {
		error: Option<VertexError>,
	}
	#[derive(Deserialize)]
	struct VertexError {
		#[serde(default)]
		status:  Str,
		#[serde(default)]
		message: Str,
	}
	let parsed = serde_json::from_slice::<Envelope>(body)
		.ok()
		.and_then(|envelope| envelope.error);
	let rpc = parsed.as_ref().map_or("", |error| error.status.as_str());
	let message = parsed.as_ref().map_or("", |error| error.message.as_str());
	let safety = contains_ascii_case_insensitive(message.as_bytes(), b"safety")
		|| contains_ascii_case_insensitive(message.as_bytes(), b"content policy");
	let kind = if safety {
		ErrorKind::ContentFilter
	} else {
		match rpc {
			"UNAUTHENTICATED" => ErrorKind::Authentication,
			"PERMISSION_DENIED" => ErrorKind::Authorization,
			"RESOURCE_EXHAUSTED" => ErrorKind::RateLimited,
			"UNAVAILABLE" => ErrorKind::ResourceExhausted,
			_ => match status {
				401 => ErrorKind::Authentication,
				403 => ErrorKind::Authorization,
				429 => ErrorKind::RateLimited,
				503 => ErrorKind::ResourceExhausted,
				_ => ErrorKind::Protocol,
			},
		}
	};
	Error::new(kind, ErrorPhase::Handshake, RetryAction::Never, ExecutionReceipt::default())
		.status(Some(status))
		.optional_code((!rpc.is_empty()).then(|| Str::new(rpc)))
}
fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
	haystack.windows(needle.len()).any(|window| {
		window
			.iter()
			.zip(needle)
			.all(|(left, right)| left.eq_ignore_ascii_case(right))
	})
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::UNIX_EPOCH};

	use http::{HeaderName, HeaderValue, Request};
	use omp_catalog::{Catalog, WireTarget};
	use omp_core::SecretString;

	use super::*;
	use crate::{
		auth::{
			AuthScheme as AuthAuthScheme, AuthSpec, BearerScheme, CredentialKind, CredentialLease,
			HeaderPlacement, KeyPlacement, LeaseMeta,
		},
		call::{
			ContentPart as CanonicalContentPart, Message as CanonicalMessage, NegotiationPolicy,
			OpaqueJson, Sampling, ToolDefinition, ToolInputConstraint,
		},
		id::{AccountId, PrincipalId, RequestId},
		transport::{EventStreamDecoder, SseEvent},
	};

	fn canonical_chat(system: &[&str]) -> ChatRequest {
		let mut messages = Vec::with_capacity(system.len() + 1);
		messages.extend(system.iter().map(|text| CanonicalMessage {
			role:    Role::System,
			content: Arc::from([CanonicalContentPart::Text { text: Str::new(*text), proof: None }]),
			name:    None,
		}));
		messages.push(CanonicalMessage {
			role:    Role::User,
			content: Arc::from([CanonicalContentPart::Text { text: sf!("hello"), proof: None }]),
			name:    None,
		});
		ChatRequest {
			messages:          messages.into(),
			tools:             Arc::from([
				ToolDefinition {
					name:        sf!("read"),
					description: Some(sf!("Read a file")),
					input:       ToolInputConstraint::JsonSchema {
						parameters: OpaqueJson::new(serde_json::json!({
							"type": "object",
							"properties": {},
						})),
						strict:     true,
					},
				},
				ToolDefinition {
					name:        sf!("web_search"),
					description: Some(sf!("Search the web")),
					input:       ToolInputConstraint::JsonSchema {
						parameters: OpaqueJson::new(serde_json::json!({
							"type": "object",
							"properties": {},
						})),
						strict:     true,
					},
				},
			]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Require(ToolChoice::Named(sf!("read"))),
			output:            Setting::Unset,
			reasoning:         Setting::Unset,
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling::default(),
			max_output_tokens: Some(100_000),
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
		}
	}

	fn encoded_anthropic(kind: CredentialKind, system: &[&str]) -> EncodedRequest {
		let catalog = Catalog::embedded();
		let model = catalog
			.models()
			.iter()
			.find(|model| {
				model.routes.iter().any(|id| {
					catalog.route(id).is_some_and(|route| {
						route.provider.as_str() == "anthropic" && route.codec.as_str() == "anthropic"
					})
				})
			})
			.expect("embedded Anthropic model");
		let route = model
			.routes
			.iter()
			.filter_map(|id| catalog.route(id))
			.find(|route| {
				route.provider.as_str() == "anthropic" && route.codec.as_str() == "anthropic"
			})
			.expect("embedded Anthropic route");
		let wire_model = model
			.wire_ids
			.iter()
			.find(|(id, _)| id == &route.id)
			.expect("Anthropic wire model")
			.1
			.clone();
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("Anthropic wire policy");
		let request_id = RequestId::new("anthropic-oauth-fingerprint");
		let context = EncodeContext {
			request_id: &request_id,
			auth_scheme: Some(match kind {
				CredentialKind::Bearer => AuthAuthScheme::OAuth,
				CredentialKind::ApiKey => AuthAuthScheme::ApiKey,
				_ => panic!("unsupported test credential kind"),
			}),
			route,
			target: Some(&target),
			policy,
			..EncodeContext::default()
		};
		let mut codec = AnthropicCodec::direct().with_betas([sf!("route-beta")]);
		if kind == CredentialKind::Bearer {
			codec = codec.with_betas([sf!(CLAUDE_CODE_OAUTH_BETA)]);
		}
		codec
			.encode(&context, &OperationCall::Chat(Arc::new(canonical_chat(system))))
			.expect("Anthropic request encodes")
	}

	fn finalize_auth(encoded: &EncodedRequest, kind: CredentialKind) -> Request<Bytes> {
		let body = match &encoded.body {
			BodySource::Bytes(body) => body.clone(),
			_ => panic!("Anthropic body must be bytes"),
		};
		let mut request = Request::builder()
			.method("POST")
			.uri(encoded.uri.as_str())
			.body(body)
			.expect("HTTP request");
		for header in &encoded.headers {
			request.headers_mut().insert(
				HeaderName::from_bytes(header.name.as_bytes()).expect("header name"),
				HeaderValue::from_str(&header.value).expect("header value"),
			);
		}
		let meta = LeaseMeta {
			account:    AccountId::new("anthropic-test"),
			principal:  PrincipalId::new("anthropic-test"),
			generation: 1,
			expires_at: None,
		};
		let (lease, auth) = match kind {
			CredentialKind::Bearer => (
				CredentialLease::bearer(meta, SecretString::from("oauth-token".to_owned())),
				AuthSpec::Bearer {
					sources:   Vec::new(),
					placement: KeyPlacement::Header(HeaderPlacement::bearer()),
					scheme:    BearerScheme::OAuth,
				},
			),
			CredentialKind::ApiKey => (
				CredentialLease::api_key(meta, SecretString::from("api-key".to_owned())),
				AuthSpec::ApiKey {
					sources:   Vec::new(),
					placement: KeyPlacement::Header(HeaderPlacement {
						name:   sf!("x-api-key"),
						prefix: Str::empty(),
					}),
				},
			),
			_ => panic!("unsupported test credential kind"),
		};
		lease
			.prepare(&auth, UNIX_EPOCH)
			.expect("credentials prepare")
			.finalize_buffered(&mut request)
			.expect("credentials finalize");
		request
	}

	#[test]
	fn oauth_lease_applies_claude_code_fingerprint_and_bearer_auth() {
		let encoded = encoded_anthropic(CredentialKind::Bearer, &["caller system"]);
		let request = finalize_auth(&encoded, CredentialKind::Bearer);
		assert_eq!(request.headers()["user-agent"], CLAUDE_CODE_USER_AGENT,);
		assert_eq!(request.headers()["anthropic-beta"], "route-beta,oauth-2025-04-20",);
		assert_eq!(request.headers()["authorization"], "Bearer oauth-token");
		assert!(!request.headers().contains_key("x-api-key"));
		let body: MessagesRequest = serde_json::from_slice(request.body()).expect("request body");
		assert!(matches!(
			body.system.first(),
			Some(ContentBlock::Text { text, .. })
				if text.as_str() == CLAUDE_CODE_SYSTEM_INSTRUCTION
		));
		assert_eq!(body.max_tokens, Some(CLAUDE_CODE_MAX_OUTPUT_TOKENS));
		assert!(matches!(
			body.tools.first(),
			Some(Tool::Client(tool)) if tool.name.as_str() == "_read"
		));
		assert!(matches!(
			body.tools.get(1),
			Some(Tool::Client(tool)) if tool.name.as_str() == "web_search"
		));
		assert!(matches!(
			body.tool_choice,
			Some(WireToolChoice::Tool { name, .. }) if name.as_str() == "_read"
		));
	}

	#[test]
	fn api_key_lease_preserves_legacy_anthropic_shape() {
		let encoded = encoded_anthropic(CredentialKind::ApiKey, &["caller system"]);
		let request = finalize_auth(&encoded, CredentialKind::ApiKey);
		assert_eq!(request.headers()["x-api-key"], "api-key");
		assert!(!request.headers().contains_key("authorization"));
		assert!(!request.headers().contains_key("user-agent"));
		assert_eq!(request.headers()["anthropic-beta"], "route-beta");
		let body: MessagesRequest = serde_json::from_slice(request.body()).expect("request body");
		assert!(!body.system.iter().any(|block| matches!(
			block,
			ContentBlock::Text { text, .. }
				if text.as_str() == CLAUDE_CODE_SYSTEM_INSTRUCTION
		)));
		assert_eq!(body.max_tokens, Some(100_000));
		assert!(matches!(
			body.tools.first(),
			Some(Tool::Client(tool)) if tool.name.as_str() == "read"
		));
		assert!(matches!(
			body.tool_choice,
			Some(WireToolChoice::Tool { name, .. }) if name.as_str() == "read"
		));
	}

	#[test]
	fn oauth_identity_is_first_and_never_duplicated() {
		let encoded = encoded_anthropic(CredentialKind::Bearer, &[
			CLAUDE_CODE_SYSTEM_INSTRUCTION,
			"caller system",
		]);
		let request = finalize_auth(&encoded, CredentialKind::Bearer);
		let body: MessagesRequest = serde_json::from_slice(request.body()).expect("request body");
		let identity_count = body
			.system
			.iter()
			.filter(|block| {
				matches!(
					block,
					ContentBlock::Text { text, .. }
						if text.as_str() == CLAUDE_CODE_SYSTEM_INSTRUCTION
				)
			})
			.count();
		assert_eq!(identity_count, 1);
		assert!(matches!(
			body.system.first(),
			Some(ContentBlock::Text { text, .. })
				if text.as_str() == CLAUDE_CODE_SYSTEM_INSTRUCTION
		));
		assert!(matches!(
			body.system.get(1),
			Some(ContentBlock::Text { text, .. }) if text.as_str() == "caller system"
		));
	}

	#[derive(Deserialize)]
	struct AdapterFixture {
		wire_body: MessagesRequest,
	}

	#[test]
	fn typed_adapter_fixtures_cover_direct_vertex_and_bedrock_envelopes() {
		let fixtures = [
			include_bytes!(
				"../../../../fixtures/llm-oracle/anthropic/adapters/direct-messages.encoder.json"
			)
			.as_slice(),
			include_bytes!(
				"../../../../fixtures/llm-oracle/anthropic/adapters/vertex-raw-predict.encoder.json"
			)
			.as_slice(),
			include_bytes!(
				"../../../../fixtures/llm-oracle/anthropic/adapters/bedrock-anthropic.encoder.json"
			)
			.as_slice(),
		];
		for (index, fixture) in fixtures.into_iter().enumerate() {
			let fixture: AdapterFixture = serde_json::from_slice(fixture).unwrap();
			assert!(!fixture.wire_body.messages.is_empty());
			if index == 0 {
				assert!(fixture.wire_body.model.is_some());
				assert!(fixture.wire_body.stream);
				assert!(fixture.wire_body.anthropic_version.is_none());
			} else {
				assert!(fixture.wire_body.model.is_none());
				assert!(!fixture.wire_body.stream);
				assert_eq!(fixture.wire_body.anthropic_beta.len(), 12);
				assert_eq!(
					fixture.wire_body.anthropic_version.as_deref(),
					Some(if index == 1 {
						VERTEX_VERSION
					} else {
						BEDROCK_VERSION
					}),
				);
			}
		}
	}

	#[test]
	fn adapters_strip_only_cloud_fields_and_deduplicate_betas() {
		let mut betas = BetaSet::default();
		betas.extend(["one", "two", "one"]);
		let direct = project(
			MessagesIntent {
				body:      MessagesRequest {
					model: Some(sf!("model")),
					stream: true,
					..MessagesRequest::default()
				},
				fallbacks: Vec::new(),
				betas:     betas.clone(),
			},
			AnthropicAdapter::Direct,
		)
		.unwrap();
		let direct_body: MessagesRequest = serde_json::from_slice(&direct.body).unwrap();
		assert_eq!(direct_body.model.as_deref(), Some("model"));
		assert!(direct_body.stream);
		assert_eq!(direct.anthropic_version_header.as_deref(), Some(DIRECT_VERSION));
		assert_eq!(direct.anthropic_beta_header.as_deref(), Some("one,two"));

		for (adapter, version) in
			[(AnthropicAdapter::Vertex, VERTEX_VERSION), (AnthropicAdapter::Bedrock, BEDROCK_VERSION)]
		{
			let cloud = project(
				MessagesIntent {
					body:      MessagesRequest {
						model: Some(sf!("model")),
						stream: true,
						..MessagesRequest::default()
					},
					fallbacks: Vec::new(),
					betas:     betas.clone(),
				},
				adapter,
			)
			.unwrap();
			let cloud_body: MessagesRequest = serde_json::from_slice(&cloud.body).unwrap();
			assert!(cloud_body.model.is_none());
			assert!(!cloud_body.stream);
			assert_eq!(cloud_body.anthropic_version.as_deref(), Some(version));
			assert_eq!(cloud_body.anthropic_beta, [sf!("one"), sf!("two")]);
			assert!(cloud.anthropic_version_header.is_none());
			assert!(cloud.anthropic_beta_header.is_none());
		}
	}

	#[test]
	fn empty_tool_result_oracle_round_trips_string_and_block_content_verbatim() {
		let fixture: AdapterFixture = serde_json::from_slice(include_bytes!(
			"../../../../fixtures/llm-oracle/anthropic/requests/empty-tool-result.encoder.json"
		))
		.unwrap();
		let content = &fixture.wire_body.messages[0].content;
		assert!(matches!(
			&content[0],
			ContentBlock::ToolResult { is_error: false, content: ToolResultWireContent::Text(text), .. }
				if text.is_empty()
		));
		assert!(matches!(
			&content[1],
			ContentBlock::ToolResult { is_error: true, content: ToolResultWireContent::Blocks(blocks), .. }
				if blocks.is_empty()
		));
		assert!(matches!(
			&content[2],
			ContentBlock::ToolResult { is_error: false, content: ToolResultWireContent::Blocks(blocks), .. }
				if blocks.len() == 1
		));
		let encoded = serde_json::to_string(&fixture.wire_body.messages[0]).unwrap();
		assert!(
			encoded.contains(r#""tool_use_id":"toolu_empty_success","is_error":false,"content":"""#)
		);
		assert!(
			encoded.contains(r#""tool_use_id":"toolu_empty_error","is_error":true,"content":[]"#)
		);
	}

	#[test]
	fn root_schema_combinators_spill_into_the_description() {
		// Mirrors the real shell tool schema: root `allOf`, `minLength` on
		// `command`, and `minimum` on `timeout_ms` — the exact keywords the
		// live Messages validator rejects with 400s such as
		// `tools.N.custom: For 'integer' type, property 'minimum' is not
		// supported`.
		let request = ChatRequest {
			tools: Arc::from([ToolDefinition {
				name:        sf!("shell"),
				description: Some(sf!("Run a shell command")),
				input:       ToolInputConstraint::JsonSchema {
					parameters: OpaqueJson::new(serde_json::json!({
						"type": "object",
						"description": "Complete arguments.",
						"properties": {
							"command": {"type": "string", "minLength": 1},
							"timeout_ms": {"type": "integer", "minimum": 0},
							"name": {"anyOf": [{"type": "string"}, {"type": "null"}]}
						},
						"allOf": [{
							"if": {"properties": {"async": {"const": true}}, "required": ["async"]},
							"then": {"required": ["name"]}
						}]
					})),
					strict:     true,
				},
			}]),
			tool_choice: Setting::Unset,
			..canonical_chat(&[])
		};
		let body = lower_chat(
			sf!("claude-opus-5"),
			ProviderId::from_ref("anthropic"),
			CodecId::from_ref("anthropic"),
			None,
			&request,
		)
		.expect("chat lowers");
		let Tool::Client(tool) = &body.tools[0] else {
			panic!("client tool expected");
		};
		let schema = tool.input_schema.as_object().expect("object schema");
		assert!(!schema.contains_key("allOf"));
		let description = schema["description"].as_str().expect("description");
		assert!(description.starts_with("Complete arguments.\n\n{allOf: [{\"if\""));
		assert!(schema["properties"]["name"].get("anyOf").is_some());
		assert_eq!(schema["additionalProperties"], Value::Bool(false));
		// Declared strict, but the root `allOf` in the raw schema disqualifies
		// strict promotion; the flag stays off the wire entirely.
		assert!(tool.strict.is_none());
		let serialized = serde_json::to_string(&body.tools[0]).expect("tool serializes");
		assert!(!serialized.contains(r#""minimum""#));
		assert!(!serialized.contains(r#""minLength""#));
		assert!(!serialized.contains(r#""strict""#));
		assert!(serialized.contains(r#"{minLength: 1}"#));
		assert!(serialized.contains(r#"{minimum: 0}"#));
	}

	#[test]
	fn unsupported_keywords_spill_into_property_descriptions() {
		// Anthropic 400: `tools.N.custom: For 'integer' type, property
		// 'minimum' is not supported`. Constraint keywords outside the
		// whitelist demote into the property description instead of reaching
		// the wire.
		let normalized = normalize_tool_schema(
			&serde_json::json!({
				"type": "object",
				"properties": {
					"limit": {
						"type": "integer",
						"minimum": 1,
						"maximum": 10,
						"description": "max results"
					},
					"pattern": {"type": "string", "pattern": "^x", "format": "regex"},
					"when": {"type": "string", "format": "date-time"}
				},
				"required": ["limit"]
			}),
			true,
		);
		let limit = &normalized["properties"]["limit"];
		assert!(limit.get("minimum").is_none());
		assert!(limit.get("maximum").is_none());
		assert_eq!(
			limit["description"].as_str().expect("description"),
			"max results\n\n{minimum: 1, maximum: 10}"
		);
		let pattern = &normalized["properties"]["pattern"];
		assert!(pattern.get("pattern").is_none());
		assert_eq!(
			pattern["description"].as_str().expect("description"),
			"{pattern: \"^x\", format: \"regex\"}"
		);
		assert_eq!(normalized["properties"]["when"]["format"], "date-time");
		assert_eq!(normalized["additionalProperties"], Value::Bool(false));
	}

	#[test]
	fn strict_promotion_is_allowlisted_and_falls_back_on_open_maps() {
		let closed = OpaqueJson::new(serde_json::json!({
			"type": "object",
			"properties": {
				"command": {"type": "string"},
				"timeout": {"type": "integer"}
			},
			"required": ["command"]
		}));
		let tools: Arc<[ToolDefinition]> = Arc::from([
			ToolDefinition {
				name:        sf!("bash"),
				description: None,
				input:       ToolInputConstraint::JsonSchema {
					parameters: closed.clone(),
					strict:     true,
				},
			},
			ToolDefinition {
				name:        sf!("todo"),
				description: None,
				input:       ToolInputConstraint::JsonSchema {
					parameters: closed.clone(),
					strict:     true,
				},
			},
			ToolDefinition {
				name:        sf!("edit"),
				description: None,
				input:       ToolInputConstraint::JsonSchema {
					parameters: OpaqueJson::new(serde_json::json!({
						"type": "object",
						"properties": {"data": {"type": "object", "additionalProperties": true}},
						"required": ["data"]
					})),
					strict:     true,
				},
			},
		]);
		let plans = plan_tool_schemas(&tools);
		// Allowlisted, closed object: promoted; the optional `timeout`
		// property stays optional within the optional budget.
		assert!(plans[0].strict);
		assert_eq!(plans[0].input_schema["required"], serde_json::json!(["command"]));
		assert!(
			plans[0].input_schema["properties"]["timeout"]
				.get("anyOf")
				.is_none()
		);
		// Not allowlisted: base plan only.
		assert!(!plans[1].strict);
		// Explicit open map inside an allowlisted tool demotes to non-strict
		// instead of fabricating a closed object.
		assert!(!plans[2].strict);
		assert_eq!(
			plans[2].input_schema["properties"]["data"]["additionalProperties"],
			Value::Bool(true)
		);
	}

	#[test]
	fn strict_optional_budget_exhaustion_makes_remaining_properties_nullable() {
		let mut properties = Map::new();
		for index in 0..26 {
			properties.insert(format!("p{index:02}"), serde_json::json!({"type": "string"}));
		}
		let schema = serde_json::json!({"type": "object", "properties": properties});
		let tools: Arc<[ToolDefinition]> = Arc::from([ToolDefinition {
			name:        sf!("bash"),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(schema),
				strict:     true,
			},
		}]);
		let plans = plan_tool_schemas(&tools);
		assert!(plans[0].strict);
		let required = plans[0].input_schema["required"]
			.as_array()
			.expect("required");
		assert_eq!(required.len(), 2);
		assert_eq!(required[0], "p24");
		let nullable = &plans[0].input_schema["properties"]["p24"];
		assert!(
			nullable["anyOf"]
				.as_array()
				.expect("anyOf wrapper")
				.iter()
				.any(|variant| variant["type"] == "null")
		);
	}

	#[test]
	fn empty_successful_tool_results_lower_to_the_empty_string_not_an_empty_array() {
		let provider = ProviderId::new("anthropic");
		let codec = CodecId::new("anthropic");
		let blocks = lower_parts(
			&[
				CanonicalPart::ToolResult {
					call:     ToolCallId::new("toolu_empty_success"),
					name:     None,
					content:  Vec::new().into(),
					is_error: false,
				},
				CanonicalPart::ToolResult {
					call:     ToolCallId::new("toolu_empty_error"),
					name:     None,
					content:  Vec::new().into(),
					is_error: true,
				},
				CanonicalPart::ToolResult {
					call:     ToolCallId::new("toolu_text"),
					name:     None,
					content:  vec![ToolResultContent::Text(sf!("ok"))].into(),
					is_error: false,
				},
			],
			None,
			&provider,
			&codec,
		)
		.expect("tool results lower");
		assert_eq!(
			serde_json::to_string(&blocks[0]).unwrap(),
			r#"{"type":"tool_result","tool_use_id":"toolu_empty_success","is_error":false,"content":""}"#
		);
		assert_eq!(
			serde_json::to_string(&blocks[1]).unwrap(),
			r#"{"type":"tool_result","tool_use_id":"toolu_empty_error","is_error":true,"content":[]}"#
		);
		assert_eq!(
			serde_json::to_string(&blocks[2]).unwrap(),
			r#"{"type":"tool_result","tool_use_id":"toolu_text","is_error":false,"content":[{"type":"text","text":"ok"}]}"#
		);
	}

	#[test]
	fn thinking_start_content_is_preserved_as_a_leading_delta() {
		let mut decoder = AnthropicDecoder::new();
		let mut events = Vec::new();
		for data in [
			br#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"Summary prefix"}}"#.as_slice(),
			br#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" summary tail"}}"#.as_slice(),
			br#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_tail"}}"#.as_slice(),
			br#"{"type":"content_block_stop","index":0}"#.as_slice(),
		] {
			events.extend(decoder.push_data(data).expect("thinking stream decodes"));
		}
		let deltas: Vec<&str> = events
			.iter()
			.filter_map(|event| match event {
				AnthropicEvent::Chat(ChatEvent::ThinkingDelta { text, .. }) => Some(text.as_str()),
				_ => None,
			})
			.collect();
		assert_eq!(deltas, ["Summary prefix", " summary tail"]);
		assert_eq!(decoder.outcome().signatures, vec![(0, sf!("sig_tail"))]);
	}

	#[test]
	fn immutable_anthropic_thinking_bad_request_is_terminal_without_fallback() {
		// Anthropic rejects a mutated latest assistant message containing signed
		// or redacted thinking with a deterministic 400. That failure must never
		// enter same-route retries or route fallback.
		let error = classify_http_error(
			400,
			br#"{"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0.type: Expected `thinking` or `redacted_thinking`, but found `text`. The latest assistant message cannot be modified when thinking is enabled."}}"#,
		);
		assert_eq!(error.kind, ErrorKind::InvalidRequest);
		assert_eq!(error.status, Some(400));
		assert_eq!(error.action, RetryAction::Never);
	}

	#[test]
	fn root_fallbacks_fail_with_typed_capability_evidence() {
		let error = project(
			MessagesIntent {
				body:      MessagesRequest::default(),
				fallbacks: vec![RequestFallback { from: sf!("a"), to: sf!("b") }],
				betas:     BetaSet::default(),
			},
			AnthropicAdapter::Direct,
		)
		.unwrap_err();
		assert_eq!(error.kind, ErrorKind::CapabilityMismatch);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Capability { feature, .. }) if feature == "request.fallbacks"
		));
	}

	#[test]
	fn endpoint_projection_matches_oracles() {
		assert_eq!(
			vertex_endpoint("oracle-project", "us-east5", "claude:sonnet/4").unwrap(),
			"https://us-east5-aiplatform.googleapis.com/v1/projects/oracle-project/locations/us-east5/publishers/anthropic/models/claude%3Asonnet%2F4:streamRawPredict",
		);
		assert_eq!(
			bedrock_endpoint("", "us-east-1", "anthropic.claude-v2:1").unwrap(),
			"https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v2%3A1/invoke-with-response-stream",
		);
		assert_eq!(
			resolve_bedrock_region("us-east-1", "eu.anthropic.claude-sonnet-4-6-v1:0", ""),
			"eu-west-1",
		);
		assert_eq!(
			resolve_bedrock_region(
				"",
				"anthropic.claude-v2",
				"https://bedrock-runtime.ap-southeast-2.amazonaws.com"
			),
			"ap-southeast-2",
		);
	}

	#[test]
	fn direct_and_vertex_errors_are_typed() {
		let direct = classify_http_error(
			429,
			br#"{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}"#,
		);
		assert_eq!(direct.kind, ErrorKind::RateLimited);
		assert_eq!(direct.status, Some(429));

		let vertex = classify_vertex_error(
			401,
			br#"{"error":{"status":"UNAUTHENTICATED","message":"expired"}}"#,
		);
		assert_eq!(vertex.kind, ErrorKind::Authentication);
		assert_eq!(vertex.code.as_deref(), Some("UNAUTHENTICATED"));

		let safety = classify_vertex_error(
			400,
			br#"{"error":{"status":"INVALID_ARGUMENT","message":"blocked by safety policy"}}"#,
		);
		assert_eq!(safety.kind, ErrorKind::ContentFilter);
	}

	#[test]
	fn sse_oracles_decode_incrementally_with_usage_and_terminal_rules() {
		let mut thinking = AnthropicDecoder::new();
		let mut fallback = AnthropicDecoder::new();
		replay_sse(
			include_bytes!("../../../../fixtures/llm-oracle/anthropic/legacy/stream.fallback.sse"),
			|data| {
				fallback.push_data(data).unwrap();
			},
		);
		assert_eq!(fallback.outcome().usage, Usage {
			input_tokens: 5,
			output_tokens: 1,
			source: UsageSource::Provider,
			..Usage::default()
		});
		let mut thinking_events = Vec::new();
		replay_sse(
			include_bytes!(
				"../../../../fixtures/llm-oracle/anthropic/legacy/stream.thinking_tool_usage.sse"
			),
			|data| {
				thinking_events.extend(thinking.push_data(data).unwrap());
			},
		);
		assert_eq!(thinking.outcome().usage, Usage {
			input_tokens: 11,
			output_tokens: 18,
			cache_read_tokens: 7,
			cache_write_tokens: 3,
			source: UsageSource::Provider,
			..Usage::default()
		});
		assert!(thinking.finish().unwrap().is_empty());
		assert!(
			thinking_events
				.iter()
				.any(|event| matches!(event, AnthropicEvent::ToolCallComplete { .. }))
		);

		let mut server = AnthropicDecoder::new();
		let mut server_events = Vec::new();
		replay_sse(
			include_bytes!(
				"../../../../fixtures/llm-oracle/anthropic/legacy/stream.server_tools_citations.sse"
			),
			|data| {
				server_events.extend(server.push_data(data).unwrap());
			},
		);
		assert_eq!(server.outcome().usage, Usage {
			input_tokens: 12,
			output_tokens: 9,
			cache_read_tokens: 4,
			cache_write_tokens: 3,
			search_calls: 2,
			source: UsageSource::Provider,
			..Usage::default()
		});
		assert_eq!(server.outcome().citations.len(), 1);
		assert_eq!(server.outcome().server_blocks.len(), 2);
		assert_eq!(server.outcome().stop_sequence.as_deref(), Some("END"));
		assert_eq!(
			server_events
				.iter()
				.filter(|event| matches!(event, AnthropicEvent::Completion(_)))
				.count(),
			1
		);
		assert!(server.finish().unwrap().is_empty());
		assert_eq!(
			server.push_data(br#"{"type":"ping"}"#).unwrap_err().kind,
			ErrorKind::StreamCorruption
		);
		assert_eq!(
			server.push_data(br#"{"type":"ping""#).unwrap_err().kind,
			ErrorKind::StreamCorruption
		);

		let mut tool_search = AnthropicDecoder::new();
		for data in [
			br#"{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_search","name":"tool_search_tool_regex"}}"#.as_slice(),
			br#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"pattern\":\"read\"}"}}"#.as_slice(),
			br#"{"type":"content_block_stop","index":0}"#.as_slice(),
			br#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_search_tool_result","tool_use_id":"srvtoolu_search","content":{"type":"tool_search_tool_search_result","tool_references":[{"type":"tool_reference","tool_name":"_read"}]}}}"#.as_slice(),
			br#"{"type":"content_block_stop","index":1}"#.as_slice(),
		] {
			tool_search
				.push_data(data)
				.expect("tool-search server history decodes");
		}
		assert!(matches!(
			&tool_search.outcome().server_blocks[0].1,
			ContentBlock::ServerToolUse {
				name,
				input: Some(input),
				..
			} if name.as_str() == "tool_search_tool_regex" && input == &serde_json::json!({"pattern":"read"})
		));
		assert!(matches!(
			&tool_search.outcome().server_blocks[1].1,
			ContentBlock::ToolSearchToolResult { tool_use_id, .. }
				if tool_use_id.as_str() == "srvtoolu_search"
		));

		let mut truncated = AnthropicDecoder::new();
		replay_sse(
			include_bytes!(
				"../../../../fixtures/llm-oracle/anthropic/legacy/stream.truncated_tool.sse"
			),
			|data| {
				truncated.push_data(data).unwrap();
			},
		);
		assert_eq!(truncated.finish().unwrap_err().kind, ErrorKind::StreamCorruption);
	}
	#[test]
	fn repairable_tool_arguments_remain_raw_until_recovery() {
		let mut decoder = AnthropicDecoder::new();
		let mut events = Vec::new();
		for data in [
			br#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"read","input":{}}}"#.as_slice(),
			br#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{'path':'a.rs',}"}}"#.as_slice(),
			br#"{"type":"content_block_stop","index":0}"#.as_slice(),
		] {
			events.extend(decoder.push_data(data).expect("raw tool fragment is preserved"));
		}
		assert!(events.iter().any(|event| {
			matches!(
				event,
				AnthropicEvent::ToolCallComplete { arguments, .. }
					if arguments.as_ref() == b"{'path':'a.rs',}"
			)
		}));
	}

	#[test]
	fn message_stop_marks_the_wire_decoder_complete_without_waiting_for_eof() {
		let mut decoder = AnthropicWireDecoder {
			adapter:           AnthropicAdapter::Direct,
			claude_code_oauth: false,
			inner:             AnthropicDecoder::new(),
			signature_cursor:  0,
			citation_cursor:   0,
			history_cursor:    0,
		};
		let mut events = Vec::new();
		decoder
			.push(
				Frame::Sse(SseEvent {
					name: Some(sf!("message_stop")),
					data: Bytes::from_static(br#"{"type":"message_stop"}"#),
				}),
				&mut |event| events.push(event),
			)
			.expect("message_stop decodes");
		assert!(decoder.is_complete());
		assert!(
			events
				.iter()
				.any(|event| matches!(event, RawEvent::Completion(_)))
		);
	}

	#[test]
	fn opaque_tool_search_history_proof_replays_as_an_assistant_block() {
		let provider = ProviderId::new("anthropic");
		let codec = CodecId::new("anthropic-messages");
		let history = ContentBlock::ToolSearchToolResult {
			tool_use_id: "srvtoolu_search".into(),
			content:     serde_json::json!({
				"type": "tool_search_tool_search_result",
				"tool_references": [{"type": "tool_reference", "tool_name": "_read"}],
			}),
		};
		let proof = ProviderProof {
			provider: provider.clone(),
			codec:    codec.clone(),
			value:    Bytes::from(serde_json::to_vec(&history).expect("history serializes")),
		};
		let blocks = lower_parts(
			&[CanonicalPart::Text { text: Str::default(), proof: Some(proof) }],
			None,
			&provider,
			&codec,
		)
		.expect("same-provider opaque history replays");
		assert!(matches!(
			&blocks[0],
			ContentBlock::ToolSearchToolResult { tool_use_id, .. }
				if tool_use_id.as_str() == "srvtoolu_search"
		));
	}

	#[test]
	fn bedrock_binary_oracles_deframe_and_classify() {
		for (bytes, expects_failure) in [
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/anthropic/bedrock/eventstream.message-stop.bin"
				)
				.as_slice(),
				false,
			),
			(
				include_bytes!(
					"../../../../fixtures/llm-oracle/anthropic/bedrock/eventstream.service-unavailable.\
					 bin"
				)
				.as_slice(),
				true,
			),
		] {
			let mut framer = EventStreamDecoder::default();
			let frames = framer.push(Bytes::copy_from_slice(bytes)).unwrap();
			assert_eq!(frames.len(), 1);
			let result = bedrock_payload(&frames[0]);
			assert_eq!(result.is_err(), expects_failure);
		}
	}

	fn replay_sse(fixture: &[u8], mut decode: impl FnMut(&[u8])) {
		for record in fixture
			.split(|byte| *byte == b'\n')
			.filter(|line| line.starts_with(b"data: "))
		{
			decode(&record[6..]);
		}
	}

	#[test]
	fn count_tokens_response_is_exact_and_provenanced() {
		let mut decoder =
			CountTokensDecoder { done: false, wire_model: sf!("claude-sonnet-4-6") };
		let mut events = Vec::new();
		decoder
			.push(Frame::Raw(Bytes::from_static(br#"{"input_tokens":42}"#)), &mut |event| {
				events.push(event);
			})
			.unwrap();
		assert_eq!(events.len(), 1);
		match events.pop().unwrap() {
			RawEvent::Answer(AnswerBody::Tokens(count)) => {
				assert_eq!(count.tokens, 42);
				assert!(count.provenance.exact);
				assert_eq!(count.provenance.tokenizer, "anthropic-messages-count-tokens");
				assert_eq!(count.provenance.revision, "claude-sonnet-4-6");
			},
			_ => panic!("unexpected countTokens event"),
		}
		assert!(decoder.finish(&mut |_| {}).is_ok());
		let mut truncated =
			CountTokensDecoder { done: false, wire_model: sf!("claude-sonnet-4-6") };
		assert_eq!(truncated.finish(&mut |_| {}).unwrap_err().kind, ErrorKind::StreamCorruption);
	}

	#[test]
	fn wire_tool_choice_serialization_round_trips() {
		assert_eq!(serde_json::to_string(&WireToolChoice::None).unwrap(), r#"{"type":"none"}"#);
		assert_eq!(
			serde_json::to_string(&WireToolChoice::Auto { disable_parallel_tool_use: None }).unwrap(),
			r#"{"type":"auto"}"#
		);
		assert_eq!(
			serde_json::to_string(&WireToolChoice::Auto { disable_parallel_tool_use: Some(true) })
				.unwrap(),
			r#"{"type":"auto","disable_parallel_tool_use":true}"#
		);
		assert_eq!(
			serde_json::to_string(&WireToolChoice::Any { disable_parallel_tool_use: None }).unwrap(),
			r#"{"type":"any"}"#
		);
		assert_eq!(
			serde_json::to_string(&WireToolChoice::Tool {
				name: sf!("bash"),
				disable_parallel_tool_use: None,
			})
			.unwrap(),
			r#"{"type":"tool","name":"bash"}"#
		);

		let decoded: WireToolChoice =
			serde_json::from_str(r#"{"type":"tool","name":"eval","disable_parallel_tool_use":true}"#)
				.unwrap();
		assert_eq!(decoded, WireToolChoice::Tool {
			name: sf!("eval"),
			disable_parallel_tool_use: Some(true),
		});
	}

	#[test]
	fn transient_anthropic_failures_retry_same_route_and_denials_never_do() {
		use crate::error::RetryAction;
		// Anthropic reports transient failures (`overloaded_error`,
		// `rate_limit_error`) as resolved error envelopes; a oneshot caller must
		// retry them on the same credential instead of failing on the first blip.
		let overloaded = classify_http_error(
			529,
			br#"{"error":{"type":"overloaded_error","message":"Overloaded"}}"#,
		);
		assert_eq!(overloaded.kind, ErrorKind::ResourceExhausted);
		assert!(matches!(overloaded.action, RetryAction::SameRoute { .. }));
		assert!(!overloaded.committed);

		let throttled = classify_http_error(429, br#"{"error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}"#);
		assert_eq!(throttled.kind, ErrorKind::RateLimited);
		assert!(matches!(throttled.action, RetryAction::SameRoute { .. }));

		// Deterministic failures replay identically and must fail fast; the
		// immutable-thinking guard depends on 400s never entering a retry lane.
		let invalid = classify_http_error(
			400,
			br#"{"error":{"type":"invalid_request_error","message":"thinking blocks are immutable"}}"#,
		);
		assert_eq!(invalid.kind, ErrorKind::InvalidRequest);
		assert_eq!(invalid.action, RetryAction::Never);

		let unauthenticated = classify_http_error(
			401,
			br#"{"error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
		);
		assert_eq!(unauthenticated.kind, ErrorKind::Authentication);
		assert_eq!(unauthenticated.action, RetryAction::RefreshCredential);
		let forbidden = classify_http_error(
			403,
			br#"{"error":{"type":"permission_error","message":"account is not entitled"}}"#,
		);
		assert_eq!(forbidden.kind, ErrorKind::Authorization);
		assert_eq!(forbidden.action, RetryAction::RotateAccount);
		assert_eq!(
			provider_error(sf!("authentication_error"), sf!("expired"), true).action,
			RetryAction::Never,
		);
	}
}
