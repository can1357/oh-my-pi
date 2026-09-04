//! Typed `OpenAI` Responses wire shapes and sans-I/O event projection.

use std::{
	collections::{BTreeMap, BTreeSet},
	mem,
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use omp_core::{Str, encoding::base64, sf};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
	Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, ProviderStateEvent,
	RawCompletion, RawEvent, RequestMethod, SizeBounds, ToolInputKind, UnvalidatedToolCall,
	openai_chat,
	schema::{SchemaDialect, normalize_schema},
};
use crate::{
	answer::{Artifact, ArtifactBody, GenerationEvent, GenerationSummary, ImageArtifact},
	body::BodySource,
	call::{
		Background, ChatRequest, Dimensions, FREEFORM_INPUT_PROPERTY, ImageFormat, ImageQuality,
		ImageRequest, MediaInput, OpaqueJson, OperationCall, Setting, ToolInputConstraint,
	},
	catalog::{
		ModalityBits, OperationKind, ProviderId, ReasoningEffort, RouteId, ThinkingEffort,
		policy::{
			ApplyPatchWireKind, CacheControlFormat, ComputerUseConfigSupport, ComputerUseWireSupport,
			ImageEncodingFormat, ReasoningDisableMode,
		},
	},
	error::{Error, ErrorKind, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, ToolCall, UsageUpdate},
	id::{RequestId, ToolCallId},
	receipt::{Adjustment, Cost, FeatureId, ReasonId, Usage, UsageSource},
	session::StoredProviderStateEvent,
	transport::{Frame, FramingProtocol},
};

/// A typed metadata value accepted by the Responses API.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponsesMetadataValue {
	/// JSON null.
	Null,
	/// Boolean metadata.
	Bool(bool),
	/// Signed integer metadata.
	Integer(i64),
	/// Floating-point metadata.
	Number(f64),
	/// String metadata.
	String(Str),
	/// Array metadata.
	Array(Vec<Self>),
	/// Object metadata.
	Object(BTreeMap<Str, Self>),
}

/// Metadata object carried without interpreting application-owned keys.
pub type ResponsesMetadata = BTreeMap<Str, ResponsesMetadataValue>;

/// Responses message role.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesRole {
	/// System instruction.
	System,
	/// Developer instruction.
	Developer,
	/// User input.
	User,
	/// Assistant output.
	Assistant,
}

/// Input-item discriminator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesInputItemKind {
	/// Message item.
	Message,
	/// Function call.
	FunctionCall,
	/// Function result.
	FunctionCallOutput,
	/// Freeform custom-tool call.
	CustomToolCall,
	/// Freeform custom-tool result.
	CustomToolCallOutput,
	/// Computer-use call.
	ComputerCall,
	/// Computer-use result.
	ComputerCallOutput,
	/// Provider reasoning item.
	Reasoning,
	/// Provider item reference.
	ItemReference,
	/// Responses Lite additional-tool declaration.
	AdditionalTools,
}

/// Input-content discriminator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesContentKind {
	/// Text input.
	InputText,
	/// Image input.
	InputImage,
	/// File input.
	InputFile,
	/// Text output replay.
	OutputText,
	/// Refusal replay.
	Refusal,
}

/// Image quality selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesImageDetail {
	/// Let the provider choose.
	Auto,
	/// Low-resolution input.
	Low,
	/// High-resolution input.
	High,
	/// Preserve original image resolution where the route supports it.
	Original,
}

/// One typed message content entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesContent {
	/// Content discriminator.
	#[serde(rename = "type")]
	pub kind:                    ResponsesContentKind,
	/// Text or refusal content.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub text:                    Option<Str>,
	/// Data or remote image URL.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub image_url:               Option<Str>,
	/// Image detail, omitted to preserve the server default.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub detail:                  Option<ResponsesImageDetail>,
	/// Data URL carrying an inline file.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub file_data:               Option<Str>,
	/// Remote file URL.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub file_url:                Option<Str>,
	/// Original file name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub filename:                Option<Str>,
	/// Provider file identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub file_id:                 Option<Str>,
	/// Explicit `OpenAI` prompt-cache breakpoint.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt_cache_breakpoint: Option<ResponsesPromptCacheBreakpoint>,
}

impl ResponsesContent {
	/// Constructs a text input part.
	pub fn input_text(text: impl Into<Str>) -> Self {
		Self {
			kind:                    ResponsesContentKind::InputText,
			text:                    Some(text.into()),
			image_url:               None,
			detail:                  None,
			file_data:               None,
			file_url:                None,
			filename:                None,
			file_id:                 None,
			prompt_cache_breakpoint: None,
		}
	}
}

/// Message input content, preserving the API's string and typed-part shapes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponsesInputContent {
	/// Compact plain-text content.
	Text(Str),
	/// Typed multimodal content parts.
	Parts(Vec<ResponsesContent>),
}

impl Default for ResponsesInputContent {
	fn default() -> Self {
		Self::Parts(Vec::new())
	}
}

impl ResponsesInputContent {
	/// Returns whether no visible content is present.
	pub fn is_empty(&self) -> bool {
		match self {
			Self::Text(text) => text.is_empty(),
			Self::Parts(parts) => parts.is_empty(),
		}
	}

	/// Visits typed parts; compact text has no part list.
	pub fn parts(&self) -> Option<&[ResponsesContent]> {
		match self {
			Self::Text(_) => None,
			Self::Parts(parts) => Some(parts),
		}
	}

	/// Mutably visits typed parts; compact text has no part list.
	pub fn parts_mut(&mut self) -> Option<&mut [ResponsesContent]> {
		match self {
			Self::Text(_) => None,
			Self::Parts(parts) => Some(parts),
		}
	}
}

/// Explicit cache breakpoint attached to one stable content part.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesPromptCacheBreakpoint {
	/// Breakpoint selection mode.
	pub mode: Str,
}

/// Top-level explicit prompt-cache controls.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesPromptCacheOptions {
	/// Prompt-cache selection mode.
	pub mode: Str,
	/// Optional provider retention.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub ttl:  Option<Str>,
}

/// Prompt-cache marker attached to an individual input item.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesCacheControl {
	/// Cache-control kind, normally `ephemeral`.
	#[serde(rename = "type")]
	pub kind: Str,
}

/// Reasoning summary entry.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesSummaryPart {
	/// Summary entry kind.
	#[serde(rename = "type")]
	pub kind: Str,
	/// Summary text.
	pub text: Str,
}

/// A computer-use action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesComputerAction {
	/// Action discriminator such as `click`, `type`, or `screenshot`.
	#[serde(rename = "type")]
	pub kind:     Str,
	/// Horizontal coordinate when applicable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub x:        Option<i64>,
	/// Vertical coordinate when applicable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub y:        Option<i64>,
	/// Text entered by a typing action.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub text:     Option<Str>,
	/// Keyboard key names.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub keys:     Vec<Str>,
	/// Mouse button name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub button:   Option<Str>,
	/// Scroll distance on the x axis.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub scroll_x: Option<i64>,
	/// Scroll distance on the y axis.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub scroll_y: Option<i64>,
}

/// One pending or acknowledged computer safety check.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesSafetyCheck {
	/// Stable check identity.
	pub id:      Str,
	/// Provider safety code.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub code:    Option<Str>,
	/// Human-readable check message.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub message: Option<Str>,
}

/// Canonical computer-call arguments assembled for validation and execution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesComputerArguments {
	/// Ordered computer actions.
	pub actions:               Vec<ResponsesComputerAction>,
	/// Safety checks that must be acknowledged before execution.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub pending_safety_checks: Vec<ResponsesSafetyCheck>,
}

/// Computer screenshot result.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesComputerScreenshot {
	/// Output discriminator.
	#[serde(rename = "type")]
	pub kind:      Str,
	/// Data or remote image URL.
	pub image_url: Str,
}

/// One typed multimodal function/custom-tool output part.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponsesToolOutputPart {
	/// Text returned by the tool.
	InputText {
		/// Tool-result text.
		text: Str,
	},
	/// Image returned by the tool.
	InputImage {
		/// Requested image fidelity.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		detail:    Option<ResponsesImageDetail>,
		/// Inline data URI or replayable remote URL.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		image_url: Option<Str>,
		/// Provider-owned image identity.
		#[serde(default, skip_serializing_if = "Option::is_none")]
		file_id:   Option<Str>,
	},
}

/// Function/custom output or typed computer screenshot output.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponsesToolOutput {
	/// Textual tool output. Text-only results deliberately retain this compact
	/// wire shape.
	Text(Str),
	/// Ordered text and image tool output.
	Multimodal(Vec<ResponsesToolOutputPart>),
	/// Computer screenshot output.
	Computer(ResponsesComputerScreenshot),
}

/// One typed Responses input item.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResponsesInputItem {
	/// Optional item discriminator; ordinary input messages deliberately omit
	/// it.
	#[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
	pub kind: Option<ResponsesInputItemKind>,
	/// Provider item identity used only for native replay.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub id: Option<Str>,
	/// Message role.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub role: Option<ResponsesRole>,
	/// Message content.
	#[serde(default, skip_serializing_if = "ResponsesInputContent::is_empty")]
	pub content: ResponsesInputContent,
	/// Function or custom-tool name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name: Option<Str>,
	/// Stable call identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub call_id: Option<Str>,
	/// Function-call JSON arguments.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub arguments: Option<Str>,
	/// Freeform custom-tool input.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub input: Option<Str>,
	/// Tool output.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub output: Option<ResponsesToolOutput>,
	/// Reasoning summaries.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub summary: Vec<ResponsesSummaryPart>,
	/// Encrypted reasoning continuation payload.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub encrypted_content: Option<Str>,
	/// Computer actions.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub actions: Vec<ResponsesComputerAction>,
	/// Pending safety checks for a computer call.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub pending_safety_checks: Vec<ResponsesSafetyCheck>,
	/// Acknowledged safety checks for a computer result.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub acknowledged_safety_checks: Vec<ResponsesSafetyCheck>,
	/// Provider item status.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status: Option<Str>,
	/// Responses Lite additional tools.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub tools: Vec<ResponsesTool>,
	/// Per-item cache control.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_control: Option<ResponsesCacheControl>,
	/// Per-item metadata.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub metadata: ResponsesMetadata,
}

impl ResponsesInputItem {
	/// Constructs an ordinary message input with the wire `type` intentionally
	/// omitted.
	pub const fn message(role: ResponsesRole, content: Vec<ResponsesContent>) -> Self {
		Self {
			kind: None,
			id: None,
			role: Some(role),
			content: ResponsesInputContent::Parts(content),
			name: None,
			call_id: None,
			arguments: None,
			input: None,
			output: None,
			summary: Vec::new(),
			encrypted_content: None,
			actions: Vec::new(),
			pending_safety_checks: Vec::new(),
			acknowledged_safety_checks: Vec::new(),
			status: None,
			tools: Vec::new(),
			cache_control: None,
			metadata: BTreeMap::new(),
		}
	}
}

/// Responses tool discriminator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesToolKind {
	/// JSON-schema function tool.
	Function,
	/// Freeform custom tool.
	Custom,
	/// Computer-use tool.
	Computer,
	/// Hosted web search.
	WebSearch,
	/// Hosted file search.
	FileSearch,
	/// Hosted code interpreter.
	CodeInterpreter,
	/// Hosted image generation.
	ImageGeneration,
	/// Hosted MCP server.
	Mcp,
}

/// Custom tool input grammar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesCustomToolFormat {
	/// Format kind, for example `text` or `grammar`.
	#[serde(rename = "type")]
	pub kind:       Str,
	/// Grammar syntax when the kind is `grammar`.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub syntax:     Option<Str>,
	/// Grammar definition.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub definition: Option<Str>,
}

/// Hosted code-interpreter container selection.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesCodeContainer {
	/// Container selection kind.
	#[serde(rename = "type")]
	pub kind: Str,
}

/// A typed Responses tool declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesTool {
	/// Tool discriminator.
	#[serde(rename = "type")]
	pub kind:                ResponsesToolKind,
	/// Tool name for function and custom tools.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name:                Option<Str>,
	/// Tool description.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub description:         Option<Str>,
	/// Opaque function JSON Schema.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub parameters:          Option<Value>,
	/// Strict JSON-schema enforcement.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub strict:              Option<bool>,
	/// Freeform input format.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub format:              Option<ResponsesCustomToolFormat>,
	/// Computer viewport width.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub display_width:       Option<u32>,
	/// Computer viewport height.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub display_height:      Option<u32>,
	/// Computer environment label.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub environment:         Option<Str>,
	/// Hosted search context size.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub search_context_size: Option<Str>,
	/// Allowed search domains.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub allowed_domains:     Vec<Str>,
	/// Blocked search domains.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub blocked_domains:     Vec<Str>,
	/// File-search vector store identities.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub vector_store_ids:    Vec<Str>,
	/// Code-interpreter container policy.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub container:           Option<ResponsesCodeContainer>,
}

/// Tool-choice object type.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesNamedToolKind {
	/// Function tool.
	Function,
	/// Custom tool.
	Custom,
	/// Computer tool.
	Computer,
	/// Web-search tool.
	WebSearch,
	/// File-search tool.
	FileSearch,
	/// Code-interpreter tool.
	CodeInterpreter,
}

/// A named Responses tool choice.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesNamedToolChoice {
	/// Selected tool kind.
	#[serde(rename = "type")]
	pub kind: ResponsesNamedToolKind,
	/// Selected caller tool name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name: Option<Str>,
}

/// Responses tool-choice mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesToolChoiceMode {
	/// Model decides whether to call tools.
	Auto,
	/// Model must not call tools.
	None,
	/// Model must call at least one tool.
	Required,
}

/// Responses tool-choice value.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ResponsesToolChoice {
	/// `none`, `auto`, or `required`.
	Mode(ResponsesToolChoiceMode),
	/// Named or hosted tool selection.
	Named(ResponsesNamedToolChoice),
}

/// Responses reasoning effort.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesReasoningEffort {
	/// Disable reasoning.
	None,
	/// Minimal reasoning.
	Minimal,
	/// Low reasoning.
	Low,
	/// Medium reasoning.
	Medium,
	/// High reasoning.
	High,
	/// Extra-high reasoning.
	Xhigh,
}

/// Responses reasoning controls.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesReasoning {
	/// Effort selection.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub effort:  Option<ResponsesReasoningEffort>,
	/// Summary selection (`auto`, `concise`, or `detailed`); explicit null
	/// suppresses summaries.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub summary: Option<Option<Str>>,
	/// Provider reasoning mode.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub mode:    Option<Str>,
	/// Codex Responses Lite reasoning context.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub context: Option<Str>,
}

/// Responses text format kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesTextFormatKind {
	/// Plain text.
	Text,
	/// JSON object.
	JsonObject,
	/// JSON Schema.
	JsonSchema,
}

/// Structured text output configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesTextFormat {
	/// Format discriminator.
	#[serde(rename = "type")]
	pub kind:   ResponsesTextFormatKind,
	/// Schema name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name:   Option<Str>,
	/// Opaque output JSON Schema.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub schema: Option<Value>,
	/// Strict conformance.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub strict: Option<bool>,
}

/// Responses text controls.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesTextOptions {
	/// Output verbosity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub verbosity: Option<Str>,
	/// Structured output format.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub format:    Option<ResponsesTextFormat>,
}

/// Responses stream controls.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesStreamOptions {
	/// Disable provider-added stream obfuscation padding.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub include_obfuscation:        Option<bool>,
	/// Reasoning-summary delivery strategy.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reasoning_summary_delivery: Option<Str>,
}

/// Complete typed request body for `/v1/responses` and Codex Responses.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResponsesRequest {
	/// Opaque codec-facing wire model identifier.
	pub model:                  Str,
	/// Ordered input items.
	pub input:                  Vec<ResponsesInputItem>,
	/// Request streaming delivery.
	#[serde(default)]
	pub stream:                 bool,
	/// Store provider-side state.
	#[serde(default)]
	pub store:                  bool,
	/// Coalesced system instructions.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub instructions:           Option<Str>,
	/// Authoritative prior response identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub previous_response_id:   Option<Str>,
	/// Prompt-cache identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt_cache_key:       Option<Str>,
	/// Prompt-cache retention string.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt_cache_retention: Option<Str>,
	/// Explicit cache-breakpoint controls.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt_cache_options:   Option<ResponsesPromptCacheOptions>,
	/// Anthropic-compatible cache control accepted by compatible gateways.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cache_control:          Option<ResponsesCacheControl>,
	/// Requested native output inclusions.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub include:                Vec<Str>,
	/// Tool declarations.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub tools:                  Vec<ResponsesTool>,
	/// Responses Lite tool declarations moved into input.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub additional_tools:       Vec<ResponsesTool>,
	/// Tool selection.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub tool_choice:            Option<ResponsesToolChoice>,
	/// Whether tools may be called concurrently.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub parallel_tool_calls:    Option<bool>,
	/// Reasoning controls.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reasoning:              Option<ResponsesReasoning>,
	/// Text controls.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub text:                   Option<ResponsesTextOptions>,
	/// Temperature.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub temperature:            Option<f32>,
	/// Nucleus probability.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub top_p:                  Option<f32>,
	/// Presence penalty.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub presence_penalty:       Option<f32>,
	/// Frequency penalty.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub frequency_penalty:      Option<f32>,
	/// Maximum generated tokens.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub max_output_tokens:      Option<u64>,
	/// Service tier.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub service_tier:           Option<Str>,
	/// Request metadata.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub metadata:               ResponsesMetadata,
	/// Codex client fingerprint metadata.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub client_metadata:        Option<ResponsesMetadata>,
	/// Codex stream options.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub stream_options:         Option<ResponsesStreamOptions>,
}

/// Lossless continuation boundary selected by session planning.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResponsesContinuation {
	/// Authoritative response identity.
	pub response_id:     Str,
	/// Number of canonical input items committed into that response.
	pub committed_items: usize,
}

/// `OpenAI` Responses-specific typed options.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenAiResponsesOptions {
	/// Enable provider-side response storage and continuation.
	pub stateful:               bool,
	/// Authoritative continuation boundary.
	pub continuation:           Option<ResponsesContinuation>,
	/// Explicit native include entries.
	pub include:                Vec<Str>,
	/// Prompt-cache key.
	pub prompt_cache_key:       Option<Str>,
	/// Prompt-cache retention.
	pub prompt_cache_retention: Option<Str>,
	/// Parallel tool-call preference.
	pub parallel_tool_calls:    Option<bool>,
	/// Provider reasoning mode.
	pub reasoning_mode:         Option<Str>,
	/// Explicit reasoning summary selection; `Some(None)` sends JSON null.
	pub reasoning_summary:      Option<Option<Str>>,
	/// Provider reasoning-history scope.
	pub reasoning_context:      Option<Str>,
	/// Extra typed custom tools not expressible as canonical function tools.
	pub custom_tools:           Vec<ResponsesTool>,
	/// Native computer-use tool declaration.
	pub computer_tool:          Option<ResponsesTool>,
	/// Native continuation/replay items that carry provider proof.
	pub native_input:           Vec<ResponsesInputItem>,
	/// Request metadata.
	pub metadata:               ResponsesMetadata,
}

/// Explicit codec adjustment; every unsupported requested axis produces one.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResponsesAdjustment {
	/// A requested field has no Responses wire representation.
	Dropped {
		/// Canonical field omitted from the request.
		field:  Str,
		/// Reason the Responses wire format cannot represent the field.
		reason: Str,
	},
	/// A native representation was safely emulated.
	Emulated {
		/// Canonical field represented through an equivalent wire feature.
		field:  Str,
		/// Wire mechanism used for the emulation.
		method: Str,
	},
	/// Requested strict enforcement safely degraded to the original semantics.
	StrictFallback {
		/// Strict field omitted or set false.
		field:  Str,
		/// Typed capability or representation reason.
		reason: Str,
	},
}

/// An encoded Responses body and its exact adjustment evidence.
#[derive(Clone, Debug)]
pub struct EncodedResponses {
	/// Typed request body.
	pub request:     ResponsesRequest,
	/// Explicit omissions or emulations.
	pub adjustments: Vec<ResponsesAdjustment>,
}

/// Codec-local encoding failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResponsesEncodeError {
	/// Continuation proof belongs to a different codec.
	MismatchedProviderProof,
	/// A valid provider proof cannot be represented at this canonical position.
	UnreplayableProviderProof,
	/// Chat encoding requires a model-bearing wire target.
	MissingWireTarget,
	/// A replay item lacks required provider call identity.
	MissingCallIdentity,
	/// Stored media was not resolved before wire encoding.
	UnresolvedStoredMedia,
	/// A provider image file reference cannot be replayed without bytes or a
	/// URL.
	UnreplayableImageFileReference {
		/// Provider file identity that could not be replayed.
		file_id: Str,
	},
	/// A required output format is unsupported by Responses.
	UnsupportedOutputFormat,
	/// Route policy explicitly rejects native computer use.
	UnsupportedComputerUse,
	/// Route policy explicitly rejects the supplied computer-use configuration.
	UnsupportedComputerUseConfig,
	/// Compatible session binding contained malformed or contradictory provider
	/// state.
	MalformedServerState,
	/// Explicit codec continuation conflicts with authoritative session state.
	MismatchedServerState,
}

/// Responses output-item discriminator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsesOutputItemKind {
	/// Assistant message.
	Message,
	/// Reasoning item.
	Reasoning,
	/// Function call.
	FunctionCall,
	/// Custom tool call.
	CustomToolCall,
	/// Computer call.
	ComputerCall,
	/// Hosted web-search call.
	WebSearchCall,
	/// Hosted file-search call.
	FileSearchCall,
	/// Hosted code-interpreter call.
	CodeInterpreterCall,
	/// Hosted image-generation call.
	ImageGenerationCall,
	/// Hosted MCP call.
	McpCall,
	/// Local shell call.
	LocalShellCall,
}

/// Typed output item carried by stream events and terminal responses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesOutputItem {
	/// Item discriminator.
	#[serde(rename = "type")]
	pub kind:                  ResponsesOutputItemKind,
	/// Provider item identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub id:                    Option<Str>,
	/// Stable call identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub call_id:               Option<Str>,
	/// Tool name.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub name:                  Option<Str>,
	/// Function arguments.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub arguments:             Option<Str>,
	/// Custom-tool input.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub input:                 Option<Str>,
	/// Message content.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub content:               Vec<ResponsesContent>,
	/// Reasoning summaries.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub summary:               Vec<ResponsesSummaryPart>,
	/// Encrypted reasoning proof.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub encrypted_content:     Option<Str>,
	/// Computer actions.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub actions:               Vec<ResponsesComputerAction>,
	/// Pending computer safety checks.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub pending_safety_checks: Vec<ResponsesSafetyCheck>,
	/// Provider status.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub status:                Option<Str>,
	/// Image-generation base64 result.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub result:                Option<Str>,
}

/// Detailed token accounting from a Responses terminal event.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesUsage {
	/// Input tokens.
	#[serde(default)]
	pub input_tokens:          u64,
	/// Output tokens.
	#[serde(default)]
	pub output_tokens:         u64,
	/// Total tokens, retained for wire parity.
	#[serde(default)]
	pub total_tokens:          u64,
	/// Input-token details.
	#[serde(default)]
	pub input_tokens_details:  ResponsesInputTokenDetails,
	/// Output-token details.
	#[serde(default)]
	pub output_tokens_details: ResponsesOutputTokenDetails,
}

/// Responses input-token details.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesInputTokenDetails {
	/// Cached input tokens.
	#[serde(default)]
	pub cached_tokens: u64,
}

/// Responses output-token details.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesOutputTokenDetails {
	/// Reasoning tokens.
	#[serde(default)]
	pub reasoning_tokens: u64,
}

impl From<&ResponsesUsage> for Usage {
	fn from(value: &ResponsesUsage) -> Self {
		Self {
			input_tokens: value
				.input_tokens
				.saturating_sub(value.input_tokens_details.cached_tokens),
			output_tokens: value.output_tokens,
			reasoning_tokens: value.output_tokens_details.reasoning_tokens,
			cache_read_tokens: value.input_tokens_details.cached_tokens,
			source: UsageSource::Provider,
			..Self::default()
		}
	}
}

/// Structured provider error object.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesErrorObject {
	/// Stable provider error code.
	#[serde(default)]
	pub code:    Option<Str>,
	/// Provider error category.
	#[serde(rename = "type", default)]
	pub kind:    Option<Str>,
	/// Sanitized provider message.
	#[serde(default)]
	pub message: Option<Str>,
	/// Invalid request parameter.
	#[serde(default)]
	pub param:   Option<Str>,
}

/// Incomplete-response details.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesIncompleteDetails {
	/// Incomplete reason.
	pub reason: Str,
}

/// Provider status details attached to failed or incomplete responses.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResponsesStatusDetails {
	/// Structured nested error.
	#[serde(default)]
	pub error: Option<ResponsesErrorObject>,
}

/// Typed response envelope carried by lifecycle events.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesResponse {
	/// Authoritative response identity.
	#[serde(default)]
	pub id:                 Option<Str>,
	/// Wire model identity.
	#[serde(default)]
	pub model:              Option<Str>,
	/// Response status.
	#[serde(default)]
	pub status:             Option<Str>,
	/// Terminal error.
	#[serde(default)]
	pub error:              Option<ResponsesErrorObject>,
	/// Nested status details.
	#[serde(default)]
	pub status_details:     Option<ResponsesStatusDetails>,
	/// Incomplete details.
	#[serde(default)]
	pub incomplete_details: Option<ResponsesIncompleteDetails>,
	/// Terminal output items.
	#[serde(default)]
	pub output:             Vec<ResponsesOutputItem>,
	/// Terminal usage.
	#[serde(default)]
	pub usage:              Option<ResponsesUsage>,
	/// Applied service tier.
	#[serde(default)]
	pub service_tier:       Option<Str>,
}

/// Responses stream event discriminator.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ResponsesStreamEventKind {
	/// Response created.
	#[serde(rename = "response.created")]
	Created,
	/// Response queued.
	#[serde(rename = "response.queued")]
	Queued,
	/// Response in progress.
	#[serde(rename = "response.in_progress")]
	InProgress,
	/// Output item began.
	#[serde(rename = "response.output_item.added")]
	OutputItemAdded,
	/// Output item completed.
	#[serde(rename = "response.output_item.done")]
	OutputItemDone,
	/// Output text delta.
	#[serde(rename = "response.output_text.delta")]
	OutputTextDelta,
	/// Output refusal delta.
	#[serde(rename = "response.refusal.delta")]
	RefusalDelta,
	/// Output text completed.
	#[serde(rename = "response.output_text.done")]
	OutputTextDone,
	/// Refusal completed.
	#[serde(rename = "response.refusal.done")]
	RefusalDone,
	/// Reasoning summary delta.
	#[serde(rename = "response.reasoning_summary_text.delta")]
	ReasoningSummaryDelta,
	/// Raw reasoning delta.
	#[serde(rename = "response.reasoning_text.delta")]
	ReasoningDelta,
	/// Reasoning summary completed.
	#[serde(rename = "response.reasoning_summary_text.done")]
	ReasoningSummaryDone,
	/// Raw reasoning completed.
	#[serde(rename = "response.reasoning_text.done")]
	ReasoningDone,
	/// Function arguments delta.
	#[serde(rename = "response.function_call_arguments.delta")]
	FunctionArgumentsDelta,
	/// Function arguments completed.
	#[serde(rename = "response.function_call_arguments.done")]
	FunctionArgumentsDone,
	/// Custom-tool input delta.
	#[serde(rename = "response.custom_tool_call_input.delta")]
	CustomInputDelta,
	/// Custom-tool input completed.
	#[serde(rename = "response.custom_tool_call_input.done")]
	CustomInputDone,
	/// Partial generated image.
	#[serde(rename = "response.image_generation_call.partial_image")]
	PartialImage,
	/// Successful terminal response.
	#[serde(rename = "response.completed")]
	Completed,
	/// Incomplete terminal response.
	#[serde(rename = "response.incomplete")]
	Incomplete,
	/// Alternate terminal response used by Codex.
	#[serde(rename = "response.done")]
	Done,
	/// Failed terminal response.
	#[serde(rename = "response.failed")]
	Failed,
	/// Cancelled terminal response.
	#[serde(rename = "response.cancelled")]
	Cancelled,
	/// Hosted web-search lifecycle event.
	#[serde(rename = "response.web_search_call.in_progress")]
	WebSearchInProgress,
	/// Hosted web-search searching event.
	#[serde(rename = "response.web_search_call.searching")]
	WebSearchSearching,
	/// Hosted web-search completed event.
	#[serde(rename = "response.web_search_call.completed")]
	WebSearchCompleted,
	/// Top-level streamed error envelope.
	#[serde(rename = "error")]
	Error,
	/// Unknown forward-compatible provider event.
	#[serde(other)]
	Other,
}

/// One fully typed Responses stream event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponsesStreamEvent {
	/// Event discriminator.
	#[serde(rename = "type")]
	pub kind:              ResponsesStreamEventKind,
	/// Provider sequence number.
	#[serde(default)]
	pub sequence_number:   Option<u64>,
	/// Output index.
	#[serde(default)]
	pub output_index:      Option<u32>,
	/// Item identity for item-correlated deltas.
	#[serde(default)]
	pub item_id:           Option<Str>,
	/// Output item.
	#[serde(default)]
	pub item:              Option<ResponsesOutputItem>,
	/// Text or argument delta.
	#[serde(default)]
	pub delta:             Option<Str>,
	/// Authoritative completed text.
	#[serde(default)]
	pub text:              Option<Str>,
	/// Authoritative completed function arguments.
	#[serde(default)]
	pub arguments:         Option<Str>,
	/// Authoritative completed custom input.
	#[serde(default)]
	pub input:             Option<Str>,
	/// Partial image base64 payload.
	#[serde(default)]
	pub partial_image_b64: Option<Str>,
	/// Lifecycle response envelope.
	#[serde(default)]
	pub response:          Option<ResponsesResponse>,
	/// Top-level provider error code.
	#[serde(default)]
	pub code:              Option<Str>,
	/// Top-level provider error message.
	#[serde(default)]
	pub message:           Option<Str>,
	/// Top-level invalid parameter.
	#[serde(default)]
	pub param:             Option<Str>,
	/// Nested provider error envelope.
	#[serde(default)]
	pub error:             Option<ResponsesErrorObject>,
}

/// Structured continuation failure classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponsesContinuationFailure {
	/// The previous response identity is stale or unavailable.
	StalePreviousResponse,
	/// A referenced server item is stale or unavailable.
	StaleServerItem,
	/// The error is unrelated to continuation state.
	NotStale,
	/// The body was not a typed provider error envelope.
	Malformed,
}

/// Evidence surfaced by the decoder without leaking arbitrary response bodies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResponsesErrorEvidence {
	/// Stable provider code.
	pub code:         Option<Str>,
	/// Sanitized provider message.
	pub message:      Str,
	/// Continuation classification.
	pub continuation: ResponsesContinuationFailure,
}

/// Non-canonical state evidence preserved beside canonical chat events.
#[derive(Debug)]
pub enum ResponsesProjection {
	/// Canonical chat event.
	Canonical(ChatEvent),
	/// Terminal chat facts awaiting authoritative receipt accounting.
	Completion(Box<RawCompletion>),
	/// A provider tool call is complete but not yet schema-validated.
	ToolCallComplete {
		/// Output index.
		index:     u32,
		/// Stable call identity.
		id:        ToolCallId,
		/// Tool name.
		name:      Str,
		/// Complete arguments or freeform input bytes.
		arguments: Bytes,
		/// Whether this is a custom/freeform tool call.
		custom:    bool,
	},
	/// Stable output-item identity for continuation replay.
	OutputItem {
		/// Output index.
		index: u32,
		/// Provider item identity.
		id:    Str,
	},
	/// Encrypted reasoning proof for session continuation.
	ReasoningSignature {
		/// Output index.
		index:     u32,
		/// Provider item identity.
		item_id:   Option<Str>,
		/// Opaque encrypted content.
		signature: Bytes,
	},
	/// Provider-hosted tool lifecycle output.
	HostedTool {
		/// Output index.
		index:     u32,
		/// Hosted tool kind.
		kind:      ResponsesOutputItemKind,
		/// Whether the provider reported completion.
		completed: bool,
	},
	/// Authoritative continuation identity.
	Continuation {
		/// Response identity.
		response_id:  Str,
		/// Wire model identity.
		model:        Option<Str>,
		/// Applied service tier.
		service_tier: Option<Str>,
	},
	/// Terminal protocol/provider failure.
	Error(ResponsesErrorEvidence),
}

#[derive(Debug)]
enum OutputSlot {
	Text {
		item_id: Option<Str>,
		text:    BytesMut,
		emitted: bool,
	},
	Thinking {
		item_id:   Option<Str>,
		text:      BytesMut,
		encrypted: Bytes,
		emitted:   bool,
	},
	Tool {
		item_id:   Option<Str>,
		call_id:   ToolCallId,
		name:      Str,
		arguments: BytesMut,
		custom:    bool,
	},
	Computer {
		item_id:   Option<Str>,
		call_id:   ToolCallId,
		arguments: Bytes,
	},
	Hosted {
		kind:      ResponsesOutputItemKind,
		completed: bool,
	},
	Image {
		encoded: BytesMut,
	},
}

/// Incremental sans-I/O Responses event decoder.
#[derive(Debug, Default)]
pub struct OpenAiResponsesDecoder {
	response_id:               Option<Str>,
	model:                     Option<Str>,
	outputs:                   BTreeMap<u32, OutputSlot>,
	aliases:                   BTreeMap<Str, u32>,
	ended:                     BTreeSet<u32>,
	terminal:                  bool,
	next_index:                u32,
	saw_completed_hosted_tool: bool,
	saw_visible_output:        bool,
}

impl OpenAiResponsesDecoder {
	/// Decodes one complete SSE or WebSocket JSON payload.
	pub fn push_json(&mut self, payload: &[u8]) -> Vec<ResponsesProjection> {
		if self.terminal {
			return Vec::new();
		}
		let Ok(event) = serde_json::from_slice::<ResponsesStreamEvent>(payload) else {
			self.terminal = true;
			// Non-2xx bodies arrive as a bare `{"error":{…}}` envelope without a
			// stream event discriminator; preserve their code and message so
			// policy-bearing denials stay classifiable.
			#[derive(Deserialize)]
			struct ErrorEnvelope {
				error: ResponsesErrorObject,
			}
			if let Ok(envelope) = serde_json::from_slice::<ErrorEnvelope>(payload) {
				return vec![ResponsesProjection::Error(ResponsesErrorEvidence {
					code:         envelope.error.code.or(envelope.error.kind),
					message:      envelope
						.error
						.message
						.unwrap_or_else(|| sf!("Responses request failed")),
					continuation: ResponsesContinuationFailure::NotStale,
				})];
			}
			return vec![ResponsesProjection::Error(ResponsesErrorEvidence {
				code:         Some(sf!("invalid_responses_event")),
				message:      sf!("invalid Responses event"),
				continuation: ResponsesContinuationFailure::Malformed,
			})];
		};
		self.push_event(event)
	}

	/// Projects one already-decoded typed event.
	pub fn push_event(&mut self, event: ResponsesStreamEvent) -> Vec<ResponsesProjection> {
		if self.terminal {
			return Vec::new();
		}
		let mut out = Vec::new();
		match event.kind {
			ResponsesStreamEventKind::Created
			| ResponsesStreamEventKind::Queued
			| ResponsesStreamEventKind::InProgress => {
				self.capture_response(event.response.as_ref());
			},
			ResponsesStreamEventKind::OutputItemAdded => {
				let index = self.event_index(&event);
				if let Some(item) = event.item.as_ref() {
					self.add_item(index, item, &mut out);
				}
			},
			ResponsesStreamEventKind::OutputTextDelta | ResponsesStreamEventKind::RefusalDelta => {
				self.append_delta(&event, SlotClass::Text, &mut out);
			},
			ResponsesStreamEventKind::ReasoningSummaryDelta
			| ResponsesStreamEventKind::ReasoningDelta => {
				self.append_delta(&event, SlotClass::Thinking, &mut out);
			},
			ResponsesStreamEventKind::FunctionArgumentsDelta
			| ResponsesStreamEventKind::CustomInputDelta => {
				self.append_delta(&event, SlotClass::Tool, &mut out);
			},
			ResponsesStreamEventKind::OutputTextDone | ResponsesStreamEventKind::RefusalDone => {
				self.replace_done(&event, SlotClass::Text, &mut out);
			},
			ResponsesStreamEventKind::ReasoningSummaryDone
			| ResponsesStreamEventKind::ReasoningDone => {
				self.replace_done(&event, SlotClass::Thinking, &mut out);
			},
			ResponsesStreamEventKind::FunctionArgumentsDone
			| ResponsesStreamEventKind::CustomInputDone => {
				self.replace_done(&event, SlotClass::Tool, &mut out);
			},
			ResponsesStreamEventKind::PartialImage => {
				if let Some(index) = self.lookup_index(&event)
					&& let Some(OutputSlot::Image { encoded }) = self.outputs.get_mut(&index)
					&& let Some(delta) = event.partial_image_b64.or(event.delta)
				{
					encoded.extend_from_slice(delta.as_bytes());
				}
			},
			ResponsesStreamEventKind::OutputItemDone => {
				let index = self.event_index(&event);
				if let Some(item) = event.item.as_ref() {
					if !self.outputs.contains_key(&index) {
						self.add_item(index, item, &mut out);
					}
					self.complete_item(index, item, &mut out);
					if self.terminal {
						return out;
					}
				}
				self.end_slot(index, &mut out);
			},
			ResponsesStreamEventKind::Error => {
				self.terminal = true;
				let nested = event.error.as_ref();
				out.push(ResponsesProjection::Error(ResponsesErrorEvidence {
					code:         nested.and_then(|error| error.code.clone()).or(event.code),
					message:      nested
						.and_then(|error| error.message.clone())
						.or(event.message)
						.unwrap_or_else(|| sf!("Responses request failed")),
					continuation: ResponsesContinuationFailure::NotStale,
				}));
			},
			ResponsesStreamEventKind::WebSearchCompleted => {
				if let Some(index) = self.lookup_index(&event) {
					self.saw_completed_hosted_tool = true;
					out.push(ResponsesProjection::HostedTool {
						index,
						kind: ResponsesOutputItemKind::WebSearchCall,
						completed: true,
					});
				}
			},
			ResponsesStreamEventKind::Completed
			| ResponsesStreamEventKind::Incomplete
			| ResponsesStreamEventKind::Done => {
				let incomplete = event.kind == ResponsesStreamEventKind::Incomplete;
				self.finish_response(event.response.as_ref(), incomplete, &mut out);
			},
			ResponsesStreamEventKind::Failed | ResponsesStreamEventKind::Cancelled => {
				self.terminal = true;
				self.capture_response(event.response.as_ref());
				out.push(ResponsesProjection::Error(error_from_response(
					event.response.as_ref(),
					event.kind,
				)));
			},
			ResponsesStreamEventKind::WebSearchInProgress
			| ResponsesStreamEventKind::WebSearchSearching
			| ResponsesStreamEventKind::Other => {},
		}
		out
	}

	/// Finishes framing; a nonterminal stream is a protocol error.
	pub fn finish(&mut self) -> Vec<ResponsesProjection> {
		if self.terminal {
			return Vec::new();
		}
		self.terminal = true;
		vec![ResponsesProjection::Error(ResponsesErrorEvidence {
			code:         Some(sf!("premature_end")),
			message:      sf!("Responses stream ended before an authoritative terminal event",),
			continuation: ResponsesContinuationFailure::NotStale,
		})]
	}

	fn committed_output(&self) -> bool {
		self.outputs.values().any(|slot| match slot {
			OutputSlot::Text { text, .. } | OutputSlot::Thinking { text, .. } => !text.is_empty(),
			OutputSlot::Tool { .. } | OutputSlot::Computer { .. } => true,
			OutputSlot::Hosted { .. } | OutputSlot::Image { .. } => false,
		})
	}

	/// Returns whether an authoritative terminal event was received.
	pub const fn is_terminal(&self) -> bool {
		self.terminal
	}

	fn capture_response(&mut self, response: Option<&ResponsesResponse>) {
		if let Some(response) = response {
			if let Some(id) = &response.id {
				self.response_id = Some(id.clone());
			}
			if let Some(model) = &response.model {
				self.model = Some(model.clone());
			}
		}
	}

	fn event_index(&mut self, event: &ResponsesStreamEvent) -> u32 {
		if let Some(index) = event.output_index {
			self.next_index = self.next_index.max(index.saturating_add(1));
			index
		} else if let Some(index) = self.lookup_index(event) {
			index
		} else {
			let index = self.next_index;
			self.next_index = self.next_index.saturating_add(1);
			index
		}
	}

	fn lookup_index(&self, event: &ResponsesStreamEvent) -> Option<u32> {
		self.lookup_index_for(event, None)
	}

	fn lookup_index_for(
		&self,
		event: &ResponsesStreamEvent,
		class: Option<SlotClass>,
	) -> Option<u32> {
		event
			.output_index
			.or_else(|| {
				event
					.item_id
					.as_ref()
					.or_else(|| event.item.as_ref().and_then(|item| item.id.as_ref()))
					.or_else(|| event.item.as_ref().and_then(|item| item.call_id.as_ref()))
					.and_then(|id| {
						self.aliases.get(id).copied().or_else(|| {
							self.outputs.iter().find_map(|(index, slot)| {
								slot_item_id(slot)
									.is_some_and(|candidate| candidate == id.as_str())
									.then_some(*index)
							})
						})
					})
			})
			.or_else(|| {
				if event.item_id.is_some()
					|| event
						.item
						.as_ref()
						.is_some_and(|item| item.id.is_some() || item.call_id.is_some())
				{
					return None;
				}
				let mut candidates = self
					.outputs
					.iter()
					.filter(|(index, slot)| {
						!self.ended.contains(index)
							&& class.is_none_or(|class| slot_matches_class(slot, class))
					})
					.map(|(index, _)| *index);
				let only = candidates.next()?;
				candidates.next().is_none().then_some(only)
			})
	}

	fn add_item(
		&mut self,
		index: u32,
		item: &ResponsesOutputItem,
		out: &mut Vec<ResponsesProjection>,
	) {
		if matches!(
			item.kind,
			ResponsesOutputItemKind::FunctionCall
				| ResponsesOutputItemKind::CustomToolCall
				| ResponsesOutputItemKind::ComputerCall
		) && (item.call_id.is_none()
			|| (item.kind != ResponsesOutputItemKind::ComputerCall && item.name.is_none()))
		{
			self.terminal = true;
			out.push(ResponsesProjection::Error(ResponsesErrorEvidence {
				code:         Some(sf!("missing_tool_call_identity")),
				message:      sf!("Responses tool call omitted required identity"),
				continuation: ResponsesContinuationFailure::NotStale,
			}));
			return;
		}
		if let Some(id) = item.id.as_ref() {
			out.push(ResponsesProjection::OutputItem { index, id: id.clone() });
			self.aliases.insert(id.clone(), index);
		}
		if let Some(call_id) = item.call_id.as_ref() {
			self.aliases.insert(call_id.clone(), index);
			if let Some(bare) = call_id.strip_prefix("fc_") {
				self.aliases.insert(Str::new(bare), index);
			} else {
				self.aliases.insert(sf!("fc_{call_id}"), index);
			}
		}
		let slot = match item.kind {
			ResponsesOutputItemKind::Message => {
				OutputSlot::Text { item_id: item.id.clone(), text: BytesMut::new(), emitted: false }
			},
			ResponsesOutputItemKind::Reasoning => OutputSlot::Thinking {
				item_id:   item.id.clone(),
				text:      BytesMut::new(),
				encrypted: item
					.encrypted_content
					.as_ref()
					.map_or_else(Bytes::new, |value| Bytes::copy_from_slice(value.as_bytes())),
				emitted:   false,
			},
			ResponsesOutputItemKind::FunctionCall | ResponsesOutputItemKind::CustomToolCall => {
				let call_id = item.call_id.clone().unwrap_or_default();
				OutputSlot::Tool {
					item_id:   item.id.clone(),
					call_id:   ToolCallId::from(call_id),
					name:      item.name.clone().unwrap_or_default(),
					arguments: BytesMut::from(
						item
							.arguments
							.as_deref()
							.or(item.input.as_deref())
							.unwrap_or_default()
							.as_bytes(),
					),
					custom:    item.kind == ResponsesOutputItemKind::CustomToolCall,
				}
			},
			ResponsesOutputItemKind::ComputerCall => {
				let call_id = ToolCallId::from(item.call_id.clone().unwrap_or_default());
				let arguments = serde_json::to_vec(&ResponsesComputerArguments {
					actions:               item.actions.clone(),
					pending_safety_checks: item.pending_safety_checks.clone(),
				})
				.map_or_else(|_| Bytes::new(), Bytes::from);
				OutputSlot::Computer { item_id: item.id.clone(), call_id, arguments }
			},
			ResponsesOutputItemKind::ImageGenerationCall => {
				OutputSlot::Image { encoded: BytesMut::new() }
			},
			kind => {
				let completed = item
					.status
					.as_deref()
					.is_none_or(|status| status == "completed");
				if completed {
					self.saw_completed_hosted_tool = true;
				}
				out.push(ResponsesProjection::HostedTool { index, kind, completed });
				OutputSlot::Hosted { kind, completed }
			},
		};
		match &slot {
			OutputSlot::Text { .. } => {
				out.push(ResponsesProjection::Canonical(ChatEvent::BlockStarted {
					index,
					kind: BlockKind::Text,
				}));
			},
			OutputSlot::Thinking { .. } => {
				out.push(ResponsesProjection::Canonical(ChatEvent::BlockStarted {
					index,
					kind: BlockKind::Thinking,
				}));
			},
			OutputSlot::Tool { call_id, .. } | OutputSlot::Computer { call_id, .. } => {
				let name = match &slot {
					OutputSlot::Tool { name, .. } => name.clone(),
					OutputSlot::Computer { .. } => sf!("computer"),
					_ => unreachable!("tool arm only"),
				};
				out.push(ResponsesProjection::Canonical(ChatEvent::BlockStarted {
					index,
					kind: BlockKind::ToolCall,
				}));
				out.push(ResponsesProjection::Canonical(ChatEvent::ToolCallStarted {
					index,
					id: call_id.clone(),
					name,
				}));
			},
			OutputSlot::Hosted { .. } | OutputSlot::Image { .. } => {},
		}
		self.outputs.insert(index, slot);
	}

	fn append_delta(
		&mut self,
		event: &ResponsesStreamEvent,
		class: SlotClass,
		out: &mut Vec<ResponsesProjection>,
	) {
		let Some(index) = self.lookup_index_for(event, Some(class)) else {
			return;
		};
		if self.ended.contains(&index) {
			return;
		}
		let Some(delta) = event.delta.as_ref() else {
			return;
		};
		if delta.is_empty() {
			return;
		}
		match (self.outputs.get_mut(&index), class) {
			(Some(OutputSlot::Text { text, emitted, .. }), SlotClass::Text) => {
				text.extend_from_slice(delta.as_bytes());
				*emitted = true;
				self.saw_visible_output = true;
				out.push(ResponsesProjection::Canonical(ChatEvent::TextDelta {
					index,
					text: delta.clone(),
				}));
			},
			(Some(OutputSlot::Thinking { text, emitted, .. }), SlotClass::Thinking) => {
				text.extend_from_slice(delta.as_bytes());
				*emitted = true;
				out.push(ResponsesProjection::Canonical(ChatEvent::ThinkingDelta {
					index,
					text: delta.clone(),
				}));
			},
			(Some(OutputSlot::Tool { arguments, .. }), SlotClass::Tool) => {
				arguments.extend_from_slice(delta.as_bytes());
				self.saw_visible_output = true;
				out.push(ResponsesProjection::Canonical(ChatEvent::ToolArgumentsDelta {
					index,
					bytes: Bytes::copy_from_slice(delta.as_bytes()),
				}));
			},
			_ => {},
		}
	}

	fn replace_done(
		&mut self,
		event: &ResponsesStreamEvent,
		class: SlotClass,
		out: &mut Vec<ResponsesProjection>,
	) {
		let Some(index) = self.lookup_index_for(event, Some(class)) else {
			return;
		};
		let complete = match class {
			SlotClass::Text | SlotClass::Thinking => event.text.as_ref(),
			SlotClass::Tool => event.arguments.as_ref().or(event.input.as_ref()),
		};
		let Some(complete) = complete else {
			return;
		};
		self.reconcile_authoritative(index, class, complete, out);
	}

	fn reconcile_authoritative(
		&mut self,
		index: u32,
		class: SlotClass,
		complete: &str,
		out: &mut Vec<ResponsesProjection>,
	) {
		let prefix = match (self.outputs.get(&index), class) {
			(Some(OutputSlot::Text { text, .. }), SlotClass::Text)
			| (Some(OutputSlot::Thinking { text, .. }), SlotClass::Thinking)
			| (Some(OutputSlot::Tool { arguments: text, .. }), SlotClass::Tool) => text.as_ref(),
			_ => return,
		};
		if !complete.as_bytes().starts_with(prefix) {
			self.terminal = true;
			out.push(ResponsesProjection::Error(ResponsesErrorEvidence {
				code:         Some(sf!("authoritative_output_diverged")),
				message:      sf!("Responses authoritative output diverged from emitted prefix"),
				continuation: ResponsesContinuationFailure::Malformed,
			}));
			return;
		}
		let suffix = &complete[prefix.len()..];
		if suffix.is_empty() {
			return;
		}
		match (self.outputs.get_mut(&index), class) {
			(Some(OutputSlot::Text { text, emitted, .. }), SlotClass::Text) => {
				text.extend_from_slice(suffix.as_bytes());
				*emitted = true;
				self.saw_visible_output = true;
				out.push(ResponsesProjection::Canonical(ChatEvent::TextDelta {
					index,
					text: Str::new(suffix),
				}));
			},
			(Some(OutputSlot::Thinking { text, emitted, .. }), SlotClass::Thinking) => {
				text.extend_from_slice(suffix.as_bytes());
				*emitted = true;
				out.push(ResponsesProjection::Canonical(ChatEvent::ThinkingDelta {
					index,
					text: Str::new(suffix),
				}));
			},
			(Some(OutputSlot::Tool { arguments, .. }), SlotClass::Tool) => {
				arguments.extend_from_slice(suffix.as_bytes());
				self.saw_visible_output = true;
				out.push(ResponsesProjection::Canonical(ChatEvent::ToolArgumentsDelta {
					index,
					bytes: Bytes::copy_from_slice(suffix.as_bytes()),
				}));
			},
			_ => {},
		}
	}

	fn complete_item(
		&mut self,
		index: u32,
		item: &ResponsesOutputItem,
		out: &mut Vec<ResponsesProjection>,
	) {
		let authoritative = match self.outputs.get(&index) {
			Some(OutputSlot::Text { .. }) if !item.content.is_empty() => {
				let mut text = String::new();
				for part in &item.content {
					if let Some(value) = &part.text {
						text.push_str(value);
					}
				}
				Some((SlotClass::Text, Str::new(text)))
			},
			Some(OutputSlot::Thinking { .. }) if !item.summary.is_empty() => {
				let mut text = String::new();
				for (position, summary) in item.summary.iter().enumerate() {
					if position != 0 {
						text.push_str("\n\n");
					}
					text.push_str(summary.text.as_str());
				}
				Some((SlotClass::Thinking, Str::new(text)))
			},
			Some(OutputSlot::Tool { custom, .. }) => {
				let value = if *custom {
					item.input.as_ref()
				} else {
					item.arguments.as_ref()
				};
				value.cloned().map(|value| (SlotClass::Tool, value))
			},
			_ => None,
		};
		if let Some((class, complete)) = authoritative {
			self.reconcile_authoritative(index, class, &complete, out);
			if self.terminal {
				return;
			}
		}
		match self.outputs.get_mut(&index) {
			Some(OutputSlot::Text { item_id, .. }) => {
				if let Some(id) = &item.id {
					*item_id = Some(id.clone());
				}
			},
			Some(OutputSlot::Thinking { item_id, encrypted, .. }) => {
				if let Some(id) = &item.id {
					*item_id = Some(id.clone());
				}
				if let Some(value) = &item.encrypted_content {
					*encrypted = Bytes::copy_from_slice(value.as_bytes());
				}
			},
			Some(OutputSlot::Tool { item_id, call_id, name, .. }) => {
				if let Some(id) = &item.id {
					*item_id = Some(id.clone());
				}
				if let Some(id) = &item.call_id {
					*call_id = ToolCallId::from(id.clone());
				}
				if let Some(value) = &item.name {
					*name = value.clone();
				}
			},
			Some(OutputSlot::Computer { item_id, call_id, arguments }) => {
				if let Some(id) = &item.id {
					*item_id = Some(id.clone());
				}
				if let Some(id) = &item.call_id {
					*call_id = ToolCallId::from(id.clone());
				}
				*arguments = serde_json::to_vec(&ResponsesComputerArguments {
					actions:               item.actions.clone(),
					pending_safety_checks: item.pending_safety_checks.clone(),
				})
				.map_or_else(|_| Bytes::new(), Bytes::from);
			},
			Some(OutputSlot::Hosted { completed, .. }) => {
				*completed = item
					.status
					.as_deref()
					.is_none_or(|status| status == "completed");
			},
			Some(OutputSlot::Image { encoded }) => {
				if let Some(value) = &item.result {
					encoded.clear();
					encoded.extend_from_slice(value.as_bytes());
				}
			},
			None => {},
		}
	}

	fn end_slot(&mut self, index: u32, out: &mut Vec<ResponsesProjection>) {
		if !self.ended.insert(index) {
			return;
		}
		match self.outputs.get(&index) {
			Some(OutputSlot::Text { text, emitted: false, .. }) if !text.is_empty() => {
				out.push(ResponsesProjection::Canonical(ChatEvent::TextDelta {
					index,
					text: Str::from_utf8_lossy(text),
				}));
			},
			Some(OutputSlot::Thinking { item_id, text, encrypted, emitted }) => {
				if !*emitted && !text.is_empty() {
					out.push(ResponsesProjection::Canonical(ChatEvent::ThinkingDelta {
						index,
						text: Str::from_utf8_lossy(text),
					}));
				}
				out.push(ResponsesProjection::ReasoningSignature {
					index,
					item_id: item_id.clone(),
					signature: encrypted.clone(),
				});
			},
			Some(OutputSlot::Tool { call_id, name, arguments, custom, .. }) => {
				out.push(ResponsesProjection::ToolCallComplete {
					index,
					id: call_id.clone(),
					name: name.clone(),
					arguments: arguments.clone().freeze(),
					custom: *custom,
				});
			},
			Some(OutputSlot::Computer { call_id, arguments, .. }) => {
				out.push(ResponsesProjection::ToolCallComplete {
					index,
					id: call_id.clone(),
					name: sf!("computer"),
					arguments: arguments.clone(),
					custom: false,
				});
			},
			Some(OutputSlot::Hosted { kind, completed }) => {
				out.push(ResponsesProjection::HostedTool { index, kind: *kind, completed: *completed });
			},
			Some(OutputSlot::Image { encoded }) => {
				if let Ok(bytes) = base64::decode(encoded).into_vec() {
					let bytes = Bytes::from(bytes);
					out.push(ResponsesProjection::Canonical(ChatEvent::Artifact {
						index,
						artifact: Artifact {
							media_type: sf!("image/png"),
							size:       Some(bytes.len() as u64),
							digest:     None,
							body:       ArtifactBody::Bytes(bytes),
						},
					}));
				}
			},
			_ => {},
		}
	}

	fn finish_response(
		&mut self,
		response: Option<&ResponsesResponse>,
		incomplete: bool,
		out: &mut Vec<ResponsesProjection>,
	) {
		self.terminal = true;
		self.capture_response(response);
		if let Some(response) = response {
			for (index, item) in response
				.output
				.iter()
				.enumerate()
				.filter_map(|(i, item)| u32::try_from(i).ok().map(|i| (i, item)))
			{
				if !self.outputs.contains_key(&index) {
					self.add_item(index, item, out);
				}
				self.complete_item(index, item, out);
			}
		}
		let open = self
			.outputs
			.keys()
			.copied()
			.filter(|index| !self.ended.contains(index))
			.collect::<Vec<_>>();
		for index in open {
			self.end_slot(index, out);
		}
		if let Some(response) = response {
			if response
				.status
				.as_deref()
				.is_some_and(|status| matches!(status, "failed" | "cancelled"))
			{
				out.push(ResponsesProjection::Error(error_from_response(
					Some(response),
					ResponsesStreamEventKind::Failed,
				)));
				return;
			}
			if let Some(usage) = &response.usage {
				let mut usage = Usage::from(usage);
				usage.search_calls = u32::from(self.saw_completed_hosted_tool);
				out.push(ResponsesProjection::Canonical(ChatEvent::Usage(UsageUpdate {
					usage,
					final_update: true,
				})));
			}
		}
		if let Some(response_id) = self.response_id.clone() {
			out.push(ResponsesProjection::Continuation {
				response_id,
				model: self.model.clone(),
				service_tier: response.and_then(|value| value.service_tier.clone()),
			});
		}
		let reason = if incomplete {
			if response
				.and_then(|value| value.incomplete_details.as_ref())
				.is_some_and(|details| details.reason == "content_filter")
			{
				FinishReason::ContentFilter
			} else {
				FinishReason::Length
			}
		} else if self
			.outputs
			.values()
			.any(|slot| matches!(slot, OutputSlot::Tool { .. } | OutputSlot::Computer { .. }))
			|| (self.saw_completed_hosted_tool && !self.saw_visible_output)
		{
			FinishReason::ToolCalls
		} else {
			FinishReason::Stop
		};
		let mut usage = response
			.and_then(|value| value.usage.as_ref())
			.map_or_else(Usage::default, Usage::from);
		usage.search_calls = u32::from(self.saw_completed_hosted_tool);
		out.push(ResponsesProjection::Completion(Box::new(RawCompletion {
			reason,
			blocks: self.outputs.len().try_into().unwrap_or(u32::MAX),
			usage,
		})));
	}
}

#[derive(Clone, Copy)]
enum SlotClass {
	Text,
	Thinking,
	Tool,
}

fn slot_item_id(slot: &OutputSlot) -> Option<&str> {
	match slot {
		OutputSlot::Text { item_id, .. }
		| OutputSlot::Thinking { item_id, .. }
		| OutputSlot::Computer { item_id, .. } => item_id.as_deref(),
		OutputSlot::Tool { item_id, call_id, .. } => item_id.as_deref().or(Some(call_id.as_str())),
		OutputSlot::Hosted { .. } | OutputSlot::Image { .. } => None,
	}
}
const fn slot_matches_class(slot: &OutputSlot, class: SlotClass) -> bool {
	matches!(
		(slot, class),
		(OutputSlot::Text { .. }, SlotClass::Text)
			| (OutputSlot::Thinking { .. }, SlotClass::Thinking)
			| (OutputSlot::Tool { .. }, SlotClass::Tool)
	)
}

fn error_from_response(
	response: Option<&ResponsesResponse>,
	event: ResponsesStreamEventKind,
) -> ResponsesErrorEvidence {
	let error = response.and_then(|value| {
		value.error.as_ref().or_else(|| {
			value
				.status_details
				.as_ref()
				.and_then(|details| details.error.as_ref())
		})
	});
	let message = error
		.and_then(|value| value.message.clone())
		.or_else(|| {
			response.and_then(|value| {
				value
					.incomplete_details
					.as_ref()
					.map(|details| details.reason.clone())
			})
		})
		.unwrap_or_else(|| {
			Str::new(match event {
				ResponsesStreamEventKind::Cancelled => "caller cancelled",
				_ => "Responses request failed",
			})
		});
	ResponsesErrorEvidence {
		code: error.and_then(|value| value.code.clone()),
		message,
		continuation: ResponsesContinuationFailure::NotStale,
	}
}

/// Classifies an HTTP error using a typed error envelope and exact stale-state
/// evidence.
pub fn classify_continuation_error(status: u16, body: &[u8]) -> ResponsesErrorEvidence {
	#[derive(Deserialize)]
	struct Envelope {
		error: ResponsesErrorObject,
	}
	let Ok(envelope) = serde_json::from_slice::<Envelope>(body) else {
		return ResponsesErrorEvidence {
			code:         None,
			message:      Str::from_utf8_lossy(body),
			continuation: ResponsesContinuationFailure::Malformed,
		};
	};
	let code = envelope.error.code.clone();
	let message = envelope
		.error
		.message
		.clone()
		.unwrap_or_else(|| sf!("Responses request failed"));
	let stale_previous = matches!(status, 400 | 404)
		&& code.as_deref() == Some("previous_response_not_found")
		|| status == 404
			&& envelope.error.kind.as_deref() == Some("invalid_request_error")
			&& message.starts_with("previous_response_id '")
			&& message.ends_with("' was not found");
	let kind = if stale_previous {
		ResponsesContinuationFailure::StalePreviousResponse
	} else if status == 404
		&& envelope.error.kind.as_deref() == Some("invalid_request_error")
		&& message.starts_with("Item with id '")
		&& message.ends_with("' not found.")
	{
		ResponsesContinuationFailure::StaleServerItem
	} else {
		ResponsesContinuationFailure::NotStale
	};
	ResponsesErrorEvidence { code, message, continuation: kind }
}

/// Provider whose ChatGPT-account model-entitlement denials trigger account
/// rotation.
const CODEX_PROVIDER: &str = "openai-codex";
/// Exact denial sentence following the quoted model id.
const CODEX_CHATGPT_MODEL_DENIAL_SUFFIX: &[u8] =
	b" model is not supported when using Codex with a ChatGPT account.";
/// Upper bound on a matchable model identity.
const CODEX_CHATGPT_MODEL_MAX_LENGTH: usize = 256;

/// Model id quoted in Codex's exact ChatGPT-account entitlement denial.
///
/// The match is deliberately narrow: the full sentence, quoting, and terminal
/// period must be present, and the quoted identity must be bounded and
/// single-line, so a generic unsupported-model rejection or an unrelated
/// mention cannot trigger credential rotation.
pub fn codex_chatgpt_account_policy_model(message: &str) -> Option<&str> {
	let bytes = message.as_bytes();
	let mut cursor = 0;
	while let Some(position) =
		find_ascii_case_insensitive(&bytes[cursor..], CODEX_CHATGPT_MODEL_DENIAL_SUFFIX)
	{
		let close = cursor + position;
		cursor = close + 1;
		if close == 0 {
			continue;
		}
		let quote = bytes[close - 1];
		if !matches!(quote, b'\'' | b'"') {
			continue;
		}
		// Scan back to the matching opening quote; the quoted identity must not
		// span lines.
		let mut open = None;
		let mut index = close - 1;
		while index > 0 {
			index -= 1;
			let byte = bytes[index];
			if byte == quote {
				open = Some(index);
				break;
			}
			if matches!(byte, b'\r' | b'\n') {
				break;
			}
		}
		let Some(open) = open else { continue };
		// The sentence must start with a word-bounded "The " before the quote.
		if open < 4 || !bytes[open - 4..open].eq_ignore_ascii_case(b"The ") {
			continue;
		}
		if open >= 5 && (bytes[open - 5].is_ascii_alphanumeric() || bytes[open - 5] == b'_') {
			continue;
		}
		let model = &message[open + 1..close - 1];
		if codex_model_identity(model).is_some() {
			return Some(model);
		}
	}
	None
}

/// Whether the exact Codex ChatGPT-account entitlement denial names the
/// requested model on the Codex provider.
///
/// The denial sentence is provider-controlled input; a non-Codex provider or a
/// denial naming some other model must not burn sibling credentials.
pub fn is_codex_chatgpt_account_policy_denial(
	provider: &str,
	requested_model: Option<&str>,
	message: &str,
) -> bool {
	if provider != CODEX_PROVIDER {
		return false;
	}
	let Some(requested) = requested_model.and_then(codex_model_identity) else {
		return false;
	};
	codex_chatgpt_account_policy_model(message)
		.and_then(codex_model_identity)
		.is_some_and(|denied| denied.eq_ignore_ascii_case(requested))
}

/// Bare, bounded model identity used for entitlement-denial comparison.
fn codex_model_identity(model: &str) -> Option<&str> {
	let bare = model.rsplit('/').next().unwrap_or(model).trim();
	(!bare.is_empty() && bare.len() <= CODEX_CHATGPT_MODEL_MAX_LENGTH && !bare.contains('\0'))
		.then_some(bare)
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	if needle.is_empty() || haystack.len() < needle.len() {
		return None;
	}
	haystack
		.windows(needle.len())
		.position(|window| window.eq_ignore_ascii_case(needle))
}

/// Validates a completed function call syntactically without authorizing
/// execution.
pub fn syntactically_valid_function_call(arguments: &[u8]) -> Option<OpaqueJson> {
	serde_json::from_slice::<Value>(arguments)
		.ok()
		.map(OpaqueJson::new)
}

/// Converts a schema-validated complete call into the sole executable canonical
/// event.
pub const fn authorize_validated_tool_call(
	index: u32,
	id: ToolCallId,
	name: Str,
	arguments: OpaqueJson,
) -> ChatEvent {
	ChatEvent::ToolCallReady { index, call: ToolCall { id, name, arguments } }
}

/// Opaque provider proof payload owned by this codec.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ResponsesProviderProof {
	/// Proof format revision.
	pub version:             u8,
	/// Authoritative response identity, when this proof establishes a
	/// continuation.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub response_id:         Option<Str>,
	/// Stable output item identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub item_id:             Option<Str>,
	/// Stable wire call identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub call_id:             Option<Str>,
	/// Whether the call used the custom/freeform wire shape.
	#[serde(default)]
	pub custom_tool:         bool,
	/// Opaque encrypted reasoning continuation.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub encrypted_reasoning: Option<Str>,
	/// Native computer-use call, when applicable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub computer:            Option<ResponsesInputItem>,
}

/// Serializes typed codec proof bytes for storage in a canonical
/// `ProviderProof`.
pub fn encode_provider_proof(proof: &ResponsesProviderProof) -> Result<Bytes, serde_json::Error> {
	serde_json::to_vec(proof).map(Bytes::from)
}

/// Decodes typed codec proof bytes previously emitted by this codec.
pub fn decode_provider_proof(bytes: &[u8]) -> Result<ResponsesProviderProof, serde_json::Error> {
	serde_json::from_slice(bytes)
}

/// Position of a Responses input item within a tool-call/output batch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolBatchItemKind {
	/// Tool invocation (`function_call`, `custom_tool_call`, `computer_call`).
	Call,
	/// Tool result (`function_call_output` and siblings).
	Output,
	/// Assistant `message` item.
	AssistantMessage,
	/// Anything else; terminates a batch walk.
	Other,
}

/// Classifies a Responses input item for tool-call/output batch
/// normalization.
fn tool_batch_item_kind(item: &ResponsesInputItem) -> ToolBatchItemKind {
	match item.kind {
		Some(
			ResponsesInputItemKind::FunctionCall
			| ResponsesInputItemKind::CustomToolCall
			| ResponsesInputItemKind::ComputerCall,
		) => ToolBatchItemKind::Call,
		Some(
			ResponsesInputItemKind::FunctionCallOutput
			| ResponsesInputItemKind::CustomToolCallOutput
			| ResponsesInputItemKind::ComputerCallOutput,
		) => ToolBatchItemKind::Output,
		None | Some(ResponsesInputItemKind::Message)
			if item.role == Some(ResponsesRole::Assistant) =>
		{
			ToolBatchItemKind::AssistantMessage
		},
		_ => ToolBatchItemKind::Other,
	}
}

/// Relocates assistant `message` items wedged inside a tool-call →
/// tool-output batch to before the batch, yielding canonical
/// `message(s) → calls → outputs` order. Idempotent; content is unchanged.
///
/// `OpenAI`'s Responses API pairs tool outputs by `call_id` and tolerates any
/// item order, but stricter gateways (notably opencode-go's "Console Go")
/// reject a shape where an assistant message interrupts a `function_call` →
/// `function_call_output` run, 400ing with `No tool output found for tool
/// call …` (naming a random call of the batch on each retry). This arises
/// whenever a model streams a trailing text / demoted-thinking block *after*
/// its tool calls: block encoding preserves stream order, emitting the
/// message between the calls and the outputs appended afterward. Moving the
/// already-model-owned message ahead of its call batch keeps content
/// identical while satisfying the strict validator.
fn hoist_interleaved_tool_batch_messages(input: &mut Vec<ResponsesInputItem>) {
	let mut moved = BTreeSet::new();
	let mut insert_before: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
	for index in 0..input.len() {
		if tool_batch_item_kind(&input[index]) != ToolBatchItemKind::Output {
			continue;
		}
		// Only anchor on the first output of a run.
		if index > 0 && tool_batch_item_kind(&input[index - 1]) == ToolBatchItemKind::Output {
			continue;
		}
		// Walk back over the batch body (calls interleaved with assistant
		// messages).
		let mut start = index;
		let mut saw_call = false;
		let mut message_indexes = Vec::new();
		while start > 0 {
			match tool_batch_item_kind(&input[start - 1]) {
				ToolBatchItemKind::Call => saw_call = true,
				ToolBatchItemKind::AssistantMessage => message_indexes.push(start - 1),
				ToolBatchItemKind::Output | ToolBatchItemKind::Other => break,
			}
			start -= 1;
		}
		// Nothing to hoist unless a message actually sits among the calls.
		if !saw_call || message_indexes.is_empty() {
			continue;
		}
		message_indexes.reverse();
		let target = insert_before.entry(start).or_default();
		for message_index in message_indexes {
			moved.insert(message_index);
			target.push(message_index);
		}
	}
	if moved.is_empty() {
		return;
	}
	let mut slots: Vec<Option<ResponsesInputItem>> =
		mem::take(input).into_iter().map(Some).collect();
	for index in 0..slots.len() {
		if let Some(pending) = insert_before.get(&index) {
			for &message_index in pending {
				input.extend(slots[message_index].take());
			}
		}
		if moved.contains(&index) {
			continue;
		}
		input.extend(slots[index].take());
	}
}

/// Pure `OpenAI` Responses codec.
#[derive(Clone, Debug, Default)]
pub struct OpenAiResponsesCodec {
	options: OpenAiResponsesOptions,
}

impl OpenAiResponsesCodec {
	/// Constructs a codec with typed route/session options.
	pub const fn new(options: OpenAiResponsesOptions) -> Self {
		Self { options }
	}

	/// Borrows the configured typed options.
	pub const fn options(&self) -> &OpenAiResponsesOptions {
		&self.options
	}

	/// Encodes a canonical chat request into a typed Responses body.
	pub fn encode_chat(
		&self,
		context: &EncodeContext<'_>,
		request: &ChatRequest,
	) -> Result<EncodedResponses, ResponsesEncodeError> {
		use crate::call::{
			CacheRetention, ContentPart, HostedTool, ReasoningVisibility, Role, Setting,
			StructuredOutput, TextVerbosity, ToolChoice,
		};

		let target = context
			.target
			.ok_or(ResponsesEncodeError::MissingWireTarget)?;
		let supports_images =
			supports_tool_result_images(context) && context.policy.image.strip_input != Some(true);
		let supports_detail_original = context.policy.image.supports_detail_original == Some(true);
		let mut adjustments = Vec::new();
		let mut input = Vec::new();
		let mut instructions = Vec::new();
		let mut has_prompt_cache_breakpoint = false;
		let mut known_call_ids = BTreeSet::new();
		let mut continuation_id = self
			.options
			.continuation
			.as_ref()
			.map(|value| value.response_id.clone());
		if let Some(binding) = context.server_state {
			let state = binding
				.provider_state()
				.map_err(|_| ResponsesEncodeError::MalformedServerState)?;
			let mut state_continuation = None;
			let mut output_items = Vec::new();
			for event in state {
				match event {
					StoredProviderStateEvent::Continuation { handle } => {
						if state_continuation.replace(handle).is_some() {
							return Err(ResponsesEncodeError::MalformedServerState);
						}
					},
					StoredProviderStateEvent::OutputItem { id, .. } => {
						output_items.push(id);
					},
					StoredProviderStateEvent::ReasoningSignature { .. }
					| StoredProviderStateEvent::ToolCallProof { .. }
					| StoredProviderStateEvent::HistoryBlock { .. }
					| StoredProviderStateEvent::Checkpoint { .. } => {},
				}
			}
			if state_continuation.is_none() {
				for id in output_items {
					input.push(ResponsesInputItem {
						kind: Some(ResponsesInputItemKind::ItemReference),
						id: Some(id),
						role: None,
						content: ResponsesInputContent::default(),
						name: None,
						call_id: None,
						arguments: None,
						input: None,
						output: None,
						summary: Vec::new(),
						encrypted_content: None,
						actions: Vec::new(),
						pending_safety_checks: Vec::new(),
						acknowledged_safety_checks: Vec::new(),
						status: None,
						tools: Vec::new(),
						cache_control: None,
						metadata: BTreeMap::new(),
					});
				}
			}
			if let Some(handle) = state_continuation {
				if continuation_id
					.as_ref()
					.is_some_and(|configured| configured != &handle)
				{
					return Err(ResponsesEncodeError::MismatchedServerState);
				}
				continuation_id = Some(handle);
			}
		}
		let start = self.options.continuation.as_ref().map_or(0, |value| {
			if value.committed_items <= request.messages.len() {
				value.committed_items
			} else {
				adjustments.push(ResponsesAdjustment::Dropped {
					field:  sf!("previous_response_item_count"),
					reason: sf!("continuation boundary exceeds canonical history"),
				});
				0
			}
		});
		for message in request.messages.iter().skip(start) {
			if matches!(message.role, Role::System) {
				for part in message.content.iter() {
					if let ContentPart::Text { text, proof } = part {
						if proof.is_some() {
							return Err(ResponsesEncodeError::UnreplayableProviderProof);
						}
						instructions.push(text.as_str());
					}
				}
				continue;
			}
			let role = match message.role {
				Role::System => ResponsesRole::System,
				Role::Developer => ResponsesRole::Developer,
				Role::User | Role::Tool => ResponsesRole::User,
				Role::Assistant => ResponsesRole::Assistant,
			};
			let mut content = Vec::new();
			for part in message.content.iter() {
				match part {
					ContentPart::Text { text, proof } => {
						if let Some(proof) = proof {
							if proof.provider != context.route.provider || proof.codec != target.codec {
								return Err(ResponsesEncodeError::MismatchedProviderProof);
							}
							let decoded = decode_provider_proof(&proof.value)
								.map_err(|_| ResponsesEncodeError::MismatchedProviderProof)?;
							if let Some(response) = decoded.response_id {
								continuation_id.get_or_insert(response);
							}
							if !content.is_empty() {
								input.push(ResponsesInputItem::message(role, mem::take(&mut content)));
							}
							let mut item =
								ResponsesInputItem::message(role, vec![ResponsesContent::input_text(
									text.clone(),
								)]);
							item.id = decoded.item_id;
							input.push(item);
						} else {
							content.push(ResponsesContent::input_text(text.clone()));
						}
					},
					ContentPart::Reasoning { text, proof } => {
						if !content.is_empty() {
							input.push(ResponsesInputItem::message(role, mem::take(&mut content)));
						}
						// Policy-filtered reasoning history: some routes reject
						// replayed `type: "reasoning"` wrappers outright
						// (OpenRouter Anthropic). Routes that replay encrypted
						// reasoning (first-party xAI `/v1/responses`) leave this
						// unset so `reasoning.encrypted_content` from `include`
						// returns on later turns; the filter and include axes
						// are independent and must not be collapsed.
						if context.policy.reasoning.filter_history == Some(true) {
							continue;
						}
						let Some(proof) = proof else {
							if !text.is_empty() {
								adjustments.push(ResponsesAdjustment::Dropped {
									field:  sf!("reasoning_history"),
									reason: sf!("Responses reasoning replay requires provider proof",),
								});
							}
							continue;
						};
						if proof.provider != context.route.provider || proof.codec != target.codec {
							return Err(ResponsesEncodeError::MismatchedProviderProof);
						}
						let decoded = decode_provider_proof(&proof.value)
							.map_err(|_| ResponsesEncodeError::MismatchedProviderProof)?;
						if let Some(response) = decoded.response_id {
							continuation_id.get_or_insert(response);
						}
						input.push(ResponsesInputItem {
							kind: Some(ResponsesInputItemKind::Reasoning),
							id: decoded.item_id,
							role: None,
							content: ResponsesInputContent::default(),
							name: None,
							call_id: None,
							arguments: None,
							input: None,
							output: None,
							summary: if text.is_empty() {
								Vec::new()
							} else {
								vec![ResponsesSummaryPart { kind: sf!("summary_text"), text: text.clone() }]
							},
							encrypted_content: decoded.encrypted_reasoning,
							actions: Vec::new(),
							pending_safety_checks: Vec::new(),
							acknowledged_safety_checks: Vec::new(),
							status: None,
							tools: Vec::new(),
							cache_control: None,
							metadata: BTreeMap::new(),
						});
					},
					ContentPart::Image(media) => {
						if context.policy.image.strip_input != Some(true) {
							content.push(encode_media_content(media, true)?);
						}
					},
					ContentPart::Document(media) => content.push(encode_media_content(media, false)?),
					ContentPart::Audio(_) => {
						return Err(ResponsesEncodeError::UnsupportedOutputFormat);
					},
					ContentPart::ToolCall { call, name, arguments, proof } => {
						if !content.is_empty() {
							input.push(ResponsesInputItem::message(role, mem::take(&mut content)));
						}
						let decoded = if let Some(proof) = proof {
							if proof.provider != context.route.provider || proof.codec != target.codec {
								return Err(ResponsesEncodeError::MismatchedProviderProof);
							}
							Some(
								decode_provider_proof(&proof.value)
									.map_err(|_| ResponsesEncodeError::MismatchedProviderProof)?,
							)
						} else {
							None
						};
						if let Some(response) =
							decoded.as_ref().and_then(|value| value.response_id.clone())
						{
							continuation_id.get_or_insert(response);
						}
						if let Some(computer) = decoded.as_ref().and_then(|value| value.computer.clone())
						{
							if computer.call_id.is_none() {
								return Err(ResponsesEncodeError::MissingCallIdentity);
							}
							input.push(computer);
						} else {
							let custom = decoded.as_ref().is_some_and(|value| value.custom_tool);
							let call_id = decoded
								.as_ref()
								.and_then(|value| value.call_id.clone())
								.unwrap_or_else(|| Str::new(call.as_str()));
							let serialized = serde_json::to_string(arguments.as_value())
								.map_err(|_| ResponsesEncodeError::MissingCallIdentity)?;
							// Custom wire items carry raw freeform text; recovery
							// canonicalized it under the `input` property. History
							// recorded without that property replays the serialized
							// object verbatim.
							let custom_input = custom.then(|| {
								arguments
									.as_value()
									.get(FREEFORM_INPUT_PROPERTY)
									.and_then(serde_json::Value::as_str)
									.map_or_else(|| Str::new(serialized.as_str()), Str::new)
							});
							known_call_ids.insert(call_id.clone());
							input.push(ResponsesInputItem {
								kind: Some(if custom {
									ResponsesInputItemKind::CustomToolCall
								} else {
									ResponsesInputItemKind::FunctionCall
								}),
								id: decoded.and_then(|value| value.item_id),
								role: None,
								content: ResponsesInputContent::default(),
								name: Some(name.clone()),
								call_id: Some(call_id),
								arguments: (!custom).then(|| serialized.into()),
								input: custom_input,
								output: None,
								summary: Vec::new(),
								encrypted_content: None,
								actions: Vec::new(),
								pending_safety_checks: Vec::new(),
								acknowledged_safety_checks: Vec::new(),
								status: None,
								tools: Vec::new(),
								cache_control: None,
								metadata: BTreeMap::new(),
							});
						}
					},
					ContentPart::ToolResult { call, name, content: result, .. } => {
						if !content.is_empty() {
							input.push(ResponsesInputItem::message(role, mem::take(&mut content)));
						}
						let output =
							encode_tool_result_output(result, supports_images, supports_detail_original)?;
						let call_id = Str::new(call.as_str());
						if context.policy.tool.strict_responses_pairing == Some(true)
							&& !known_call_ids.contains(&call_id)
						{
							let tool = name.as_deref().unwrap_or("tool");
							let note = sf!(
								"[Orphan {tool} result; call_id={}]: {}",
								call.as_str(),
								orphan_tool_result_text(&output)
							);
							input.push(ResponsesInputItem::message(ResponsesRole::Assistant, vec![
								ResponsesContent::input_text(note),
							]));
							continue;
						}
						input.push(ResponsesInputItem {
							kind: Some(ResponsesInputItemKind::FunctionCallOutput),
							id: None,
							role: None,
							content: ResponsesInputContent::default(),
							name: None,
							call_id: Some(call_id),
							arguments: None,
							input: None,
							output: Some(output),
							summary: Vec::new(),
							encrypted_content: None,
							actions: Vec::new(),
							pending_safety_checks: Vec::new(),
							acknowledged_safety_checks: Vec::new(),
							status: None,
							tools: Vec::new(),
							cache_control: None,
							metadata: BTreeMap::new(),
						});
					},
					ContentPart::CachePoint(retention) => {
						if context.policy.cache.supports_breakpoints == Some(true) {
							let breakpoint = ResponsesPromptCacheBreakpoint { mode: sf!("explicit") };
							if let Some(last) = content.last_mut() {
								last.prompt_cache_breakpoint = Some(breakpoint);
								has_prompt_cache_breakpoint = true;
							} else if let Some(parts) =
								input.last_mut().and_then(|item| item.content.parts_mut())
								&& let Some(last) = parts.last_mut()
							{
								last.prompt_cache_breakpoint = Some(breakpoint);
								has_prompt_cache_breakpoint = true;
							}
						}
						let kind = match retention {
							CacheRetention::Request | CacheRetention::Session | CacheRetention::Short => {
								"ephemeral"
							},
							CacheRetention::Long => "persistent",
						};
						if !content.is_empty() {
							let mut item = ResponsesInputItem::message(role, mem::take(&mut content));
							item.cache_control = Some(ResponsesCacheControl { kind: Str::new(kind) });
							input.push(item);
						} else if let Some(item) = input.last_mut() {
							item.cache_control = Some(ResponsesCacheControl { kind: Str::new(kind) });
						}
					},
				}
			}
			if !content.is_empty() {
				input.push(ResponsesInputItem::message(role, content));
			}
		}
		for item in &self.options.native_input {
			let mut item = item.clone();
			if matches!(
				item.kind,
				Some(
					ResponsesInputItemKind::FunctionCallOutput
						| ResponsesInputItemKind::CustomToolCallOutput
				)
			) {
				normalize_replayed_tool_output(
					&mut item.output,
					supports_images,
					supports_detail_original,
				)?;
			}
			input.push(item);
		}
		hoist_interleaved_tool_batch_messages(&mut input);
		let instructions = if instructions.is_empty() {
			None
		} else {
			let joined = Str::new(instructions.join("\n\n"));
			if context.policy.role.supports_developer_role == Some(true) {
				let mut item = ResponsesInputItem::message(ResponsesRole::Developer, Vec::new());
				item.content = ResponsesInputContent::Text(joined);
				input.insert(0, item);
				None
			} else {
				Some(joined)
			}
		};

		let apply_patch = context.policy.tool.apply_patch;
		let flatten_root_unions = context.policy.tool.flatten_root_unions == Some(true);
		let reject_root_object_union = context.policy.tool.reject_root_object_union == Some(true);
		// Tools whose schemas still carry a root union the route rejects
		// (xAI exclusive-required `anyOf`) are quarantined: the request
		// proceeds without them, and a forced choice naming one is cleared
		// after tool-choice lowering.
		let mut quarantined_tools = Vec::new();
		let mut tools = request
			.tools
			.iter()
			.filter_map(|tool| {
				let freeform_patch = matches!(&tool.input, ToolInputConstraint::JsonSchema { .. })
					&& tool.name == "apply_patch"
					&& apply_patch == Some(ApplyPatchWireKind::Freeform);
				let (kind, parameters, strict, format) = match &tool.input {
					ToolInputConstraint::JsonSchema { parameters, strict } if !freeform_patch => {
						let mut schema = parameters.as_value().clone();
						if flatten_root_unions {
							if let Some(flattened) =
								openai_chat::flatten_exclusive_required_root_union(&schema)
							{
								schema = flattened;
							}
							if openai_chat::leftover_root_object_union(&schema) {
								quarantined_tools.push(tool.name.clone());
								return None;
							}
						}
						if reject_root_object_union && openai_chat::leftover_root_object_union(&schema) {
							quarantined_tools.push(tool.name.clone());
							return None;
						}
						let projection = normalize_schema(
							&schema,
							*strict,
							context.policy.tool.supports_strict_mode,
							SchemaDialect::OpenAiResponses,
						);
						if let Some(reason) = projection.fallback {
							adjustments.push(ResponsesAdjustment::StrictFallback {
								field:  sf!("tools.strict"),
								reason: sf!(reason.reason_id()),
							});
						}
						(ResponsesToolKind::Function, Some(projection.schema), projection.strict, None)
					},
					ToolInputConstraint::JsonSchema { .. } => {
						(ResponsesToolKind::Custom, None, None, None)
					},
					ToolInputConstraint::Grammar { grammar, .. } => (
						ResponsesToolKind::Custom,
						None,
						None,
						Some(ResponsesCustomToolFormat {
							kind:       sf!("grammar"),
							syntax:     Some(sf!(<&'static str>::from(grammar.syntax))),
							definition: Some(grammar.definition.clone()),
						}),
					),
				};
				Some(ResponsesTool {
					kind,
					name: Some(tool.name.clone()),
					description: tool.description.clone(),
					parameters,
					strict,
					format,
					display_width: None,
					display_height: None,
					environment: None,
					search_context_size: None,
					allowed_domains: Vec::new(),
					blocked_domains: Vec::new(),
					vector_store_ids: Vec::new(),
					container: None,
				})
			})
			.collect::<Vec<_>>();
		for custom in &self.options.custom_tools {
			let function_patch = custom.name.as_deref() == Some("apply_patch")
				&& apply_patch == Some(ApplyPatchWireKind::Function);
			if function_patch {
				continue;
			}
			if let Some(name) = &custom.name {
				tools.retain(|tool| tool.name.as_ref() != Some(name));
			}
			tools.push(custom.clone());
		}
		if let Some(computer) = &self.options.computer_tool {
			if context.policy.tool.computer_use == Some(ComputerUseWireSupport::Unsupported) {
				return Err(ResponsesEncodeError::UnsupportedComputerUse);
			}
			let configured = computer.display_width.is_some()
				|| computer.display_height.is_some()
				|| computer.environment.is_some();
			if configured
				&& context.policy.tool.computer_use_config
					== Some(ComputerUseConfigSupport::Unsupported)
			{
				return Err(ResponsesEncodeError::UnsupportedComputerUseConfig);
			}
			tools.push(computer.clone());
		}
		for hosted in request.hosted_tools.iter() {
			tools.push(match hosted {
				HostedTool::WebSearch { allowed_domains, blocked_domains, recency_days } => {
					if recency_days.is_some() {
						adjustments.push(ResponsesAdjustment::Dropped {
							field:  sf!("hosted_tools.web_search.recency_days"),
							reason: sf!("Responses web search has no exact recency-days field",),
						});
					}
					ResponsesTool {
						kind:                ResponsesToolKind::WebSearch,
						name:                None,
						description:         None,
						parameters:          None,
						strict:              None,
						format:              None,
						display_width:       None,
						display_height:      None,
						environment:         None,
						search_context_size: None,
						allowed_domains:     allowed_domains.to_vec(),
						blocked_domains:     blocked_domains.to_vec(),
						vector_store_ids:    Vec::new(),
						container:           None,
					}
				},
				HostedTool::CodeExecution => ResponsesTool {
					kind:                ResponsesToolKind::CodeInterpreter,
					name:                None,
					description:         None,
					parameters:          None,
					strict:              None,
					format:              None,
					display_width:       None,
					display_height:      None,
					environment:         None,
					search_context_size: None,
					allowed_domains:     Vec::new(),
					blocked_domains:     Vec::new(),
					vector_store_ids:    Vec::new(),
					container:           Some(ResponsesCodeContainer { kind: sf!("auto") }),
				},
				HostedTool::Retrieval { stores } => ResponsesTool {
					kind:                ResponsesToolKind::FileSearch,
					name:                None,
					description:         None,
					parameters:          None,
					strict:              None,
					format:              None,
					display_width:       None,
					display_height:      None,
					environment:         None,
					search_context_size: None,
					allowed_domains:     Vec::new(),
					blocked_domains:     Vec::new(),
					vector_store_ids:    stores.to_vec(),
					container:           None,
				},
			});
		}
		let tool_choice = match &request.tool_choice {
			Setting::Unset => None,
			Setting::Require(value) | Setting::Prefer(value) => Some(match value {
				ToolChoice::Disabled => ResponsesToolChoice::Mode(ResponsesToolChoiceMode::None),
				ToolChoice::Auto => ResponsesToolChoice::Mode(ResponsesToolChoiceMode::Auto),
				ToolChoice::Required => ResponsesToolChoice::Mode(ResponsesToolChoiceMode::Required),
				ToolChoice::Named(name) => {
					let kind = tools
						.iter()
						.find(|tool| tool.name.as_ref() == Some(name))
						.map_or(ResponsesNamedToolKind::Function, |tool| match tool.kind {
							ResponsesToolKind::Custom => ResponsesNamedToolKind::Custom,
							ResponsesToolKind::Computer => ResponsesNamedToolKind::Computer,
							_ => ResponsesNamedToolKind::Function,
						});
					ResponsesToolChoice::Named(ResponsesNamedToolChoice {
						kind,
						name: (kind != ResponsesNamedToolKind::Computer).then(|| name.clone()),
					})
				},
			}),
		};
		// A forced selection of a quarantined tool cannot be honored; the
		// request proceeds unforced rather than naming an undeclared tool.
		let tool_choice = match tool_choice {
			Some(ResponsesToolChoice::Named(named))
				if named
					.name
					.as_ref()
					.is_some_and(|name| quarantined_tools.iter().any(|tool| tool == name)) =>
			{
				None
			},
			other => other,
		};
		// Console Go's Responses route rejects tool-choice selectors for
		// DeepSeek V4 while thinking mode is active (#8244): policy-declared
		// hosts drop the selector — or just its forced/named form — while the
		// tool definitions themselves stay on the wire.
		let tool_choice = match tool_choice {
			Some(_) if context.policy.tool.supports_tool_choice == Some(false) => {
				adjustments.push(ResponsesAdjustment::Dropped {
					field:  sf!("tool_choice"),
					reason: sf!("route policy rejects tool-choice selectors"),
				});
				None
			},
			Some(
				ResponsesToolChoice::Mode(ResponsesToolChoiceMode::Required)
				| ResponsesToolChoice::Named(_),
			) if context.policy.tool.forced_choice == Some(false) => {
				adjustments.push(ResponsesAdjustment::Dropped {
					field:  sf!("tool_choice"),
					reason: sf!("route policy rejects forced tool choice"),
				});
				None
			},
			Some(ResponsesToolChoice::Named(named))
				if context.policy.tool.named_choice == Some(false) =>
			{
				tools.retain(|tool| tool.name.as_ref() == named.name.as_ref());
				(!tools.is_empty())
					.then_some(ResponsesToolChoice::Mode(ResponsesToolChoiceMode::Required))
			},
			other => other,
		};
		// Some DeepSeek reasoning gateways silently disable thinking whenever a
		// selector is present. `auto` is the provider default and can be omitted
		// without changing tool semantics; forced and named selectors remain
		// authoritative.
		let tool_choice = match tool_choice {
			Some(ResponsesToolChoice::Mode(ResponsesToolChoiceMode::Auto))
				if (context.policy.tool.disable_reasoning_on_choice == Some(true)
					|| context.policy.tool.disable_reasoning_on_forced_choice == Some(true))
					&& matches!(&request.reasoning, Setting::Require(_) | Setting::Prefer(_)) =>
			{
				None
			},
			other => other,
		};
		let reasoning = match &request.reasoning {
			Setting::Unset => None,
			Setting::Require(value) | Setting::Prefer(value)
				if context.policy.reasoning.supports_params != Some(false) =>
			{
				if value.max_tokens.is_some() {
					adjustments.push(ResponsesAdjustment::Dropped {
						field:  sf!("reasoning.max_tokens"),
						reason: sf!("Responses accepts qualitative effort only"),
					});
				}
				// The planner's selection is the canonical effort already
				// clamped to the catalog ladder; the raw request only
				// stands in when no plan exists (ADR 0022: one request).
				let effort = value.effort.map(|requested| {
					context
						.thinking_selection
						.map_or_else(|| ThinkingEffort::from(requested), |selection| selection.effort)
				});
				// `none` is a wire value only where the catalog spells it
				// (`reasoning-disable-mode "none-effort"` or an explicit
				// off spelling); gpt-5 400s on it. Elsewhere reasoning-off
				// sends no effort and no summary, exactly like pi.
				let suppressed_off =
					effort == Some(ThinkingEffort::Off) && !off_is_spelled_on_the_wire(context);
				// Routes without an effort dial (grok-build,
				// grok-code-fast, …) 400 when `reasoning.effort` is
				// present; policy omits the field while keeping the
				// reasoning object itself.
				let effort = if context.policy.reasoning.omit_effort == Some(true) || suppressed_off {
					None
				} else {
					effort.map(|effort| wire_reasoning_effort(context, effort))
				};
				// api.x.ai rejects `reasoning.summary` for SuperGrok and
				// the paid key alike; the wire omits the field instead of
				// filling `auto`.
				let summary =
					if context.policy.reasoning.supports_summary == Some(false) || suppressed_off {
						None
					} else {
						self
							.options
							.reasoning_summary
							.clone()
							.or_else(|| match value.visibility {
								ReasoningVisibility::Hidden => Some(None),
								ReasoningVisibility::Summary | ReasoningVisibility::Visible => {
									Some(Some(sf!("auto")))
								},
							})
					};
				// An all-omitted reasoning object carries no wire
				// information; no-dial routes send no `reasoning` at all.
				let mode = self.options.reasoning_mode.clone();
				let reasoning_context = self.options.reasoning_context.clone();
				(effort.is_some() || summary.is_some() || mode.is_some() || reasoning_context.is_some())
					.then(|| ResponsesReasoning { effort, summary, mode, context: reasoning_context })
			},
			Setting::Require(_) | Setting::Prefer(_) => None,
		};
		if context.policy.reasoning.requires_off_juice_instruction == Some(true)
			&& matches!(
				&request.reasoning,
				Setting::Require(value) | Setting::Prefer(value)
					if value.effort == Some(ReasoningEffort::Off)
			) {
			input.push(ResponsesInputItem::message(ResponsesRole::Developer, vec![
				ResponsesContent::input_text("# Juice: 0 !important"),
			]));
		}
		let text = {
			let verbosity = match &request.verbosity {
				Setting::Unset => None,
				Setting::Require(value) | Setting::Prefer(value) => Some(Str::new(match value {
					TextVerbosity::Low => "low",
					TextVerbosity::Medium => "medium",
					TextVerbosity::High => "high",
				})),
			};
			let format = match &request.output {
				Setting::Unset => None,
				Setting::Require(value) | Setting::Prefer(value) => Some(match value {
					StructuredOutput::JsonObject => ResponsesTextFormat {
						kind:   ResponsesTextFormatKind::JsonObject,
						name:   None,
						schema: None,
						strict: None,
					},
					StructuredOutput::JsonSchema { name, schema, strict } => {
						let projection = normalize_schema(
							schema.as_value(),
							*strict,
							context.policy.tool.supports_strict_mode,
							SchemaDialect::OpenAiResponses,
						);
						if let Some(reason) = projection.fallback {
							adjustments.push(ResponsesAdjustment::StrictFallback {
								field:  sf!("response_format.strict"),
								reason: sf!(reason.reason_id()),
							});
						}
						ResponsesTextFormat {
							kind:   ResponsesTextFormatKind::JsonSchema,
							name:   Some(name.clone()),
							schema: Some(projection.schema),
							strict: projection.strict,
						}
					},
					StructuredOutput::Regex(_)
					| StructuredOutput::Lark(_)
					| StructuredOutput::Ebnf(_) => return Err(ResponsesEncodeError::UnsupportedOutputFormat),
				}),
			};
			(verbosity.is_some() || format.is_some())
				.then_some(ResponsesTextOptions { verbosity, format })
		};
		let prompt_cache_retention =
			self
				.options
				.prompt_cache_retention
				.clone()
				.or_else(|| match &request.cache_retention {
					Setting::Require(CacheRetention::Long) | Setting::Prefer(CacheRetention::Long)
						if context.policy.cache.supports_long_retention == Some(true) =>
					{
						Some(sf!("24h"))
					},
					Setting::Unset | Setting::Require(_) | Setting::Prefer(_) => None,
				});
		let prompt_cache_options = has_prompt_cache_breakpoint.then(|| {
			let ttl = context
				.policy
				.cache
				.breakpoint_ttl
				.map(|ttl| Str::new(<&'static str>::from(ttl)));
			ResponsesPromptCacheOptions { mode: sf!("explicit"), ttl }
		});
		let cache_control = (context.policy.cache.control_format
			== Some(CacheControlFormat::Anthropic)
			&& !matches!(request.cache_retention, Setting::Unset))
		.then(|| ResponsesCacheControl { kind: sf!("ephemeral") });
		let prompt_cache_key = if context.route.capability_limits.disable_prompt_caching {
			None
		} else {
			context
				.affinity
				.prompt_cache
				.clone()
				.or_else(|| self.options.prompt_cache_key.clone())
		};
		let service_tier = match &request.service_tier {
			Setting::Unset => None,
			Setting::Require(value) | Setting::Prefer(value) => Some(value.name.clone()),
		};
		if request.sampling.top_k.is_some() {
			adjustments.push(ResponsesAdjustment::Dropped {
				field:  sf!("sampling.top_k"),
				reason: sf!("Responses has no top-k field"),
			});
		}
		if request.sampling.seed.is_some() {
			adjustments.push(ResponsesAdjustment::Dropped {
				field:  sf!("sampling.seed"),
				reason: sf!("Responses has no deterministic seed field"),
			});
		}
		if !request.sampling.stop.is_empty() {
			adjustments.push(ResponsesAdjustment::Dropped {
				field:  sf!("sampling.stop"),
				reason: sf!("Responses has no stop-sequence field"),
			});
		}
		if request.top_logprobs.is_some() {
			adjustments.push(ResponsesAdjustment::Dropped {
				field:  sf!("top_logprobs"),
				reason: sf!("Responses streaming projection does not expose logprobs"),
			});
		}
		if !request.safety.is_empty() {
			adjustments.push(ResponsesAdjustment::Dropped {
				field:  sf!("safety"),
				reason: sf!("Responses has no per-request safety thresholds"),
			});
		}
		// xAI `/v1/responses` rejects presence/frequency penalties for every
		// Grok model; policy-conformant lowering omits them so configured
		// penalties do not fail the route.
		let penalties_supported = context.policy.structured.penalties != Some(false)
			&& context.policy.structured.penalty_and_stop_params != Some(false);
		let include = {
			let mut values = self.options.include.clone();
			// Encrypted reasoning is requested when the request preserves
			// signatures or the route policy replays encrypted reasoning on
			// later turns (first-party OpenAI and xAI `/v1/responses`).
			let request_include = matches!(
				&request.reasoning,
				Setting::Require(value) | Setting::Prefer(value) if value.preserve_signatures
			);
			if (request_include || context.policy.reasoning.include_encrypted == Some(true))
				&& !values
					.iter()
					.any(|value| value == "reasoning.encrypted_content")
			{
				values.push(sf!("reasoning.encrypted_content"));
			}
			values
		};
		let max_output_tokens = request.max_output_tokens.or_else(|| {
			(context.policy.context.always_send_max_tokens == Some(true)).then(|| {
				context
					.policy_model
					.and_then(|model| model.limits.maximum_output_tokens)
					.or(context.route.capability_limits.maximum_output_tokens)
					.unwrap_or(128_000)
			})
		});
		let stream_options = (context.policy.streaming.supports_obfuscation_opt_out == Some(true))
			.then(|| ResponsesStreamOptions {
				include_obfuscation:        Some(false),
				reasoning_summary_delivery: None,
			});
		let previous_response_id = if self.options.stateful {
			continuation_id
		} else {
			if continuation_id.is_some() {
				adjustments.push(ResponsesAdjustment::Dropped {
					field:  sf!("previous_response_id"),
					reason: sf!("stateful Responses is disabled"),
				});
			}
			None
		};
		Ok(EncodedResponses {
			request: ResponsesRequest {
				model: Str::new(target.wire_model.as_str()),
				input,
				stream: true,
				store: self.options.stateful,
				instructions,
				previous_response_id,
				prompt_cache_key,
				prompt_cache_retention,
				prompt_cache_options,
				cache_control,
				include,
				tools,
				additional_tools: Vec::new(),
				tool_choice,
				parallel_tool_calls: self.options.parallel_tool_calls,
				reasoning,
				text,
				temperature: request.sampling.temperature,
				top_p: request.sampling.top_p,
				presence_penalty: penalties_supported
					.then_some(request.sampling.presence_penalty)
					.flatten(),
				frequency_penalty: penalties_supported
					.then_some(request.sampling.frequency_penalty)
					.flatten(),
				max_output_tokens,
				service_tier,
				metadata: self.options.metadata.clone(),
				client_metadata: None,
				stream_options,
			},
			adjustments,
		})
	}
}

/// Reports whether the catalog gives reasoning-off a wire spelling on this
/// route: `reasoning-disable-mode "none-effort"` or an explicit `off` entry in
/// either effort map, and never while the thinking policy suppresses the
/// control when off.
fn off_is_spelled_on_the_wire(context: &EncodeContext<'_>) -> bool {
	if context
		.thinking_selection
		.is_some_and(|selection| selection.suppress_when_off)
	{
		return false;
	}
	context.policy.reasoning.disable_mode == Some(ReasoningDisableMode::NoneEffort)
		|| context
			.thinking_selection
			.is_some_and(|selection| selection.native_effort.is_some())
		|| context
			.policy
			.reasoning
			.effort_map
			.contains_key(&ThinkingEffort::Off)
}

/// Maps a canonical effort through the route's native spelling override.
///
/// The planner's `ThinkingSelection` wins; the wire policy's `effort_map`
/// (xAI clamps `minimal` to `low`) applies otherwise. Unknown spellings fall
/// back to the canonical projection.
fn wire_reasoning_effort(
	context: &EncodeContext<'_>,
	effort: ThinkingEffort,
) -> ResponsesReasoningEffort {
	let canonical = match effort {
		ThinkingEffort::Off => ResponsesReasoningEffort::None,
		ThinkingEffort::Minimal => ResponsesReasoningEffort::Minimal,
		ThinkingEffort::Low => ResponsesReasoningEffort::Low,
		ThinkingEffort::Medium => ResponsesReasoningEffort::Medium,
		ThinkingEffort::High => ResponsesReasoningEffort::High,
		ThinkingEffort::XHigh | ThinkingEffort::Max => ResponsesReasoningEffort::Xhigh,
	};
	if let Some(native) = context
		.thinking_selection
		.and_then(|selection| selection.native_effort.as_deref())
	{
		return parse_reasoning_effort(native).unwrap_or(canonical);
	}
	context
		.policy
		.reasoning
		.effort_map
		.get(&effort)
		.and_then(|value| parse_reasoning_effort(value))
		.unwrap_or(canonical)
}

/// Parses a native effort spelling into the Responses wire vocabulary.
fn parse_reasoning_effort(value: &str) -> Option<ResponsesReasoningEffort> {
	match value {
		"none" => Some(ResponsesReasoningEffort::None),
		"minimal" => Some(ResponsesReasoningEffort::Minimal),
		"low" => Some(ResponsesReasoningEffort::Low),
		"medium" => Some(ResponsesReasoningEffort::Medium),
		"high" => Some(ResponsesReasoningEffort::High),
		"xhigh" => Some(ResponsesReasoningEffort::Xhigh),
		_ => None,
	}
}

fn supports_tool_result_images(context: &EncodeContext<'_>) -> bool {
	context.policy_model.map_or_else(
		|| !matches!(context.policy.image.encoding, Some(ImageEncodingFormat::None)),
		|model| {
			model
				.capabilities
				.chat
				.as_ref()
				.and_then(|chat| chat.input_modalities.constraints())
				.is_some_and(|modalities| modalities.contains(ModalityBits::IMAGE))
		},
	)
}

fn orphan_tool_result_text(output: &ResponsesToolOutput) -> Str {
	match output {
		ResponsesToolOutput::Text(text) => text.clone(),
		ResponsesToolOutput::Computer(_) => sf!("[computer screenshot omitted]"),
		ResponsesToolOutput::Multimodal(parts) => {
			let mut text = String::new();
			for part in parts {
				match part {
					ResponsesToolOutputPart::InputText { text: part } => text.push_str(part),
					ResponsesToolOutputPart::InputImage { .. } => {
						if !text.is_empty() {
							text.push('\n');
						}
						text.push_str("[image omitted]");
					},
				}
			}
			Str::new(text)
		},
	}
}

fn encode_tool_result_output(
	content: &[crate::call::ToolResultContent],
	supports_images: bool,
	supports_detail_original: bool,
) -> Result<ResponsesToolOutput, ResponsesEncodeError> {
	use crate::call::ToolResultContent;

	let has_images = content
		.iter()
		.any(|part| matches!(part, ToolResultContent::Image(_)));
	if !has_images || !supports_images {
		let mut output = String::new();
		let mut omitted_image = false;
		let mut first_text = true;
		for part in content {
			match part {
				ToolResultContent::Text(text) => {
					if !first_text {
						output.push('\n');
					}
					first_text = false;
					output.push_str(text);
				},
				ToolResultContent::Json(value) => {
					if !first_text {
						output.push('\n');
					}
					first_text = false;
					output.push_str(
						&serde_json::to_string(value.as_value())
							.map_err(|_| ResponsesEncodeError::MissingCallIdentity)?,
					);
				},
				ToolResultContent::Image(_) => omitted_image = true,
				ToolResultContent::Document(_) => {
					return Err(ResponsesEncodeError::UnsupportedOutputFormat);
				},
			}
		}
		if omitted_image {
			if !output.is_empty() {
				output.push('\n');
			}
			output.push_str("[image omitted: model does not support vision]");
		}
		return Ok(ResponsesToolOutput::Text(output.into()));
	}

	let mut output = Vec::with_capacity(content.len());
	for part in content {
		match part {
			ToolResultContent::Text(text) => {
				output.push(ResponsesToolOutputPart::InputText { text: text.clone() });
			},
			ToolResultContent::Json(value) => {
				let text = serde_json::to_string(value.as_value())
					.map_err(|_| ResponsesEncodeError::MissingCallIdentity)?;
				output.push(ResponsesToolOutputPart::InputText { text: text.into() });
			},
			ToolResultContent::Image(media) => {
				let encoded = encode_media_content(media, true)?;
				output.push(ResponsesToolOutputPart::InputImage {
					detail:    Some(clamp_image_detail(
						ResponsesImageDetail::Auto,
						supports_detail_original,
					)),
					image_url: encoded.image_url,
					file_id:   encoded.file_id,
				});
			},
			ToolResultContent::Document(_) => {
				return Err(ResponsesEncodeError::UnsupportedOutputFormat);
			},
		}
	}
	Ok(ResponsesToolOutput::Multimodal(output))
}

const fn clamp_image_detail(
	detail: ResponsesImageDetail,
	supports_detail_original: bool,
) -> ResponsesImageDetail {
	if matches!(detail, ResponsesImageDetail::Original) && !supports_detail_original {
		ResponsesImageDetail::Auto
	} else {
		detail
	}
}

fn normalize_replayed_tool_output(
	output: &mut Option<ResponsesToolOutput>,
	supports_images: bool,
	supports_detail_original: bool,
) -> Result<(), ResponsesEncodeError> {
	if output.is_none() {
		*output = Some(ResponsesToolOutput::Text(Str::empty()));
		return Ok(());
	}
	let Some(ResponsesToolOutput::Multimodal(parts)) = output else {
		return Ok(());
	};
	let mut has_images = false;
	for part in parts.iter_mut() {
		let ResponsesToolOutputPart::InputImage { detail, image_url, file_id } = part else {
			continue;
		};
		has_images = true;
		if let Some(value) = detail {
			*value = clamp_image_detail(*value, supports_detail_original);
		}
		let has_url = image_url.as_ref().is_some_and(|url| !url.trim().is_empty());
		if !has_url
			&& let Some(file_id) = file_id
				.as_ref()
				.filter(|file_id| !file_id.trim().is_empty())
		{
			return Err(ResponsesEncodeError::UnreplayableImageFileReference {
				file_id: file_id.clone(),
			});
		}
	}
	if !has_images || !supports_images {
		let mut text = String::new();
		let mut first = true;
		let mut omitted_image = false;
		for part in mem::take(parts) {
			match part {
				ResponsesToolOutputPart::InputText { text: part } => {
					if !first {
						text.push('\n');
					}
					first = false;
					text.push_str(&part);
				},
				ResponsesToolOutputPart::InputImage { .. } => omitted_image = true,
			}
		}
		if omitted_image {
			if !text.is_empty() {
				text.push('\n');
			}
			text.push_str("[image omitted: model does not support vision]");
		}
		*output = Some(ResponsesToolOutput::Text(text.into()));
	}
	Ok(())
}

fn encode_media_content(
	media: &MediaInput,
	image: bool,
) -> Result<ResponsesContent, ResponsesEncodeError> {
	use crate::call::MediaInput;
	let kind = if image {
		ResponsesContentKind::InputImage
	} else {
		ResponsesContentKind::InputFile
	};
	match media {
		MediaInput::Bytes { media_type, data } => {
			let encoded = base64::encode(data).into_string();
			let url = sf!("data:{media_type};base64,{encoded}");
			Ok(ResponsesContent {
				kind,
				text: None,
				image_url: image.then(|| url.clone()),
				detail: None,
				file_data: (!image).then_some(url),
				file_url: None,
				filename: None,
				file_id: None,
				prompt_cache_breakpoint: None,
			})
		},
		MediaInput::Remote { uri, name, .. } => Ok(ResponsesContent {
			kind,
			text: None,
			image_url: image.then(|| uri.clone()),
			detail: None,
			file_data: None,
			file_url: (!image).then(|| uri.clone()),
			filename: (!image).then(|| name.clone()).flatten(),
			file_id: None,
			prompt_cache_breakpoint: None,
		}),
		MediaInput::Stored(_) | MediaInput::Body { .. } => {
			Err(ResponsesEncodeError::UnresolvedStoredMedia)
		},
	}
}

#[derive(Serialize)]
struct HostedCheckpoint {
	index:     u32,
	kind:      ResponsesOutputItemKind,
	completed: bool,
}

#[derive(Serialize)]
struct ContinuationCheckpoint<'a> {
	response_id:  &'a Str,
	model:        Option<&'a Str>,
	service_tier: Option<&'a Str>,
}

struct ResponsesDecoderAdapter {
	inner: OpenAiResponsesDecoder,
	request_id: RequestId,
	provider: ProviderId,
	route: RouteId,
	wire_model: Option<Str>,
	thinking_close_max_retries: Option<u32>,
}

impl ResponsesDecoderAdapter {
	fn emit_projection(&self, projection: ResponsesProjection, emit: &mut dyn FnMut(RawEvent)) {
		match projection {
			ResponsesProjection::Canonical(event) => emit(RawEvent::Chat(event)),
			ResponsesProjection::Completion(completion) => {
				emit(RawEvent::Completion(*completion));
			},
			ResponsesProjection::ToolCallComplete { index, id, name, arguments, custom } => {
				emit(RawEvent::ToolCallComplete {
					index,
					call: UnvalidatedToolCall {
						id,
						name,
						input_kind: if custom {
							ToolInputKind::Freeform
						} else {
							ToolInputKind::Json
						},
						arguments,
					},
				});
			},
			ResponsesProjection::OutputItem { index, id } => {
				emit(RawEvent::ProviderState(ProviderStateEvent::OutputItem { index, id }));
			},
			ResponsesProjection::ReasoningSignature { index, item_id, signature } => {
				if let Some(id) = item_id {
					emit(RawEvent::ProviderState(ProviderStateEvent::OutputItem { index, id }));
				}
				emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
					index,
					signature,
				}));
			},
			ResponsesProjection::HostedTool { index, kind, completed } => {
				let data = serde_json::to_vec(&HostedCheckpoint { index, kind, completed })
					.map_or_else(|_| Bytes::new(), Bytes::from);
				emit(RawEvent::ProviderState(ProviderStateEvent::Checkpoint { id: None, data }));
			},
			ResponsesProjection::Continuation { response_id, model, service_tier } => {
				emit(RawEvent::ProviderState(ProviderStateEvent::Continuation {
					handle: response_id.clone(),
				}));
				let data = serde_json::to_vec(&ContinuationCheckpoint {
					response_id:  &response_id,
					model:        self.wire_model.as_ref().or(model.as_ref()),
					service_tier: service_tier.as_ref(),
				})
				.map_or_else(|_| Bytes::new(), Bytes::from);
				emit(RawEvent::ProviderState(ProviderStateEvent::Checkpoint {
					id: Some(response_id),
					data,
				}));
			},
			ResponsesProjection::Error(evidence) => {
				emit(RawEvent::Failure(self.error_from_evidence(evidence)));
			},
		}
	}

	fn error_from_evidence(&self, evidence: ResponsesErrorEvidence) -> Error {
		use crate::{
			error::{Error, ErrorKind, ErrorPhase, RetryAction},
			receipt::ExecutionReceipt,
		};
		let model_policy_denial = evidence.continuation == ResponsesContinuationFailure::NotStale
			&& is_codex_chatgpt_account_policy_denial(
				self.provider.as_str(),
				self.wire_model.as_deref(),
				evidence.message.as_str(),
			);
		let committed = self.inner.committed_output();
		let premature_end = evidence.code.as_deref() == Some("premature_end");
		let (kind, action) = if model_policy_denial {
			(
				ErrorKind::Authorization,
				if committed {
					RetryAction::Never
				} else {
					RetryAction::RotateAccount
				},
			)
		} else if premature_end && !committed {
			(ErrorKind::Protocol, RetryAction::SameRouteLimited {
				after:       Duration::ZERO,
				max_retries: self.thinking_close_max_retries.unwrap_or(1),
			})
		} else {
			match evidence.continuation {
				ResponsesContinuationFailure::StalePreviousResponse
				| ResponsesContinuationFailure::StaleServerItem => {
					(ErrorKind::SessionExpired, RetryAction::ReseedSession)
				},
				ResponsesContinuationFailure::Malformed => {
					(ErrorKind::StreamCorruption, RetryAction::Never)
				},
				ResponsesContinuationFailure::NotStale => classify_responses_provider_error(
					evidence.code.as_deref(),
					evidence.message.as_str(),
					committed,
				),
			}
		};
		let code = if model_policy_denial {
			Some(sf!("codex_chatgpt_account_model_policy"))
		} else {
			evidence.code
		};
		Error::new(
			kind,
			if committed {
				ErrorPhase::Streaming
			} else {
				ErrorPhase::Handshake
			},
			action,
			ExecutionReceipt::default(),
		)
		.provider(self.provider.clone())
		.route(self.route.clone())
		.request_id(self.request_id.clone())
		.optional_code(code)
		.committed(committed)
	}
}
fn classify_responses_provider_error(
	code: Option<&str>,
	message: &str,
	committed: bool,
) -> (ErrorKind, RetryAction) {
	let code = code.unwrap_or_default().to_ascii_lowercase();
	let message = message.to_ascii_lowercase();
	let action = |action| {
		if committed {
			RetryAction::Never
		} else {
			action
		}
	};
	if matches!(code.as_str(), "401" | "invalid_api_key" | "authentication_error" | "unauthorized")
		|| message.contains("invalid api key")
		|| message.contains("authentication")
	{
		(ErrorKind::Authentication, action(RetryAction::RefreshCredential))
	} else if matches!(code.as_str(), "403" | "permission_denied" | "authorization_error") {
		(ErrorKind::Authorization, action(RetryAction::RotateAccount))
	} else if matches!(code.as_str(), "429" | "rate_limit_exceeded" | "rate_limit_error") {
		(ErrorKind::RateLimited, action(RetryAction::SameRoute { after: Duration::from_secs(30) }))
	} else if matches!(
		code.as_str(),
		"500" | "502" | "503" | "529" | "server_error" | "internal_server_error" | "overloaded_error"
	) {
		(
			ErrorKind::ResourceExhausted,
			action(RetryAction::SameRoute { after: Duration::from_millis(500) }),
		)
	} else if matches!(code.as_str(), "context_length_exceeded" | "context_window_exceeded")
		|| message.contains("context length")
		|| message.contains("context window")
	{
		(ErrorKind::ContextOverflow, RetryAction::Never)
	} else if matches!(code.as_str(), "insufficient_quota" | "quota_exceeded") {
		(ErrorKind::QuotaExhausted, RetryAction::Never)
	} else if matches!(code.as_str(), "400" | "invalid_request_error" | "invalid_request") {
		(ErrorKind::InvalidRequest, RetryAction::Never)
	} else {
		(ErrorKind::Protocol, RetryAction::Never)
	}
}

impl Decoder for ResponsesDecoderAdapter {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		use crate::transport::{Frame, WebSocketMessage};
		let payload = match frame {
			Frame::Raw(payload) | Frame::Ndjson(payload) => payload,
			Frame::Sse(event) => event.data,
			Frame::WebSocket(WebSocketMessage::Text(payload) | WebSocketMessage::Binary(payload)) => {
				payload
			},
			Frame::WebSocket(
				WebSocketMessage::Close { .. } | WebSocketMessage::Ping(_) | WebSocketMessage::Pong(_),
			) => return Ok(()),
			Frame::Connect(_) | Frame::EventStream(_) => {
				return Err(self.error_from_evidence(ResponsesErrorEvidence {
					code:         Some(sf!("wrong_framing_protocol")),
					message:      sf!("Responses decoder received incompatible framing"),
					continuation: ResponsesContinuationFailure::Malformed,
				}));
			},
		};
		if payload.as_ref() == b"[DONE]" {
			return Ok(());
		}
		for projection in self.inner.push_json(&payload) {
			self.emit_projection(projection, emit);
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		for projection in self.inner.finish() {
			self.emit_projection(projection, emit);
		}
		Ok(())
	}
}

fn prompt_cache_session_header(
	header: Option<crate::catalog::policy::PromptCacheSessionHeader>,
	value: Option<Str>,
) -> Option<super::RequestHeader> {
	Some(super::RequestHeader { name: Str::new(<&'static str>::from(header?)), value: value? })
}

fn encoding_error(code: &'static str) -> Error {
	use crate::{
		error::{Error, ErrorKind, ErrorPhase, RetryAction},
		receipt::ExecutionReceipt,
	};
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(Str::new(code))
}

pub(super) fn responses_uri(base_url: &str) -> Str {
	openai_chat::join_uri(base_url, "/responses")
}

#[derive(Serialize)]
struct HostedImageRequest {
	model:        Str,
	input:        [ResponsesInputItem; 1],
	tools:        [HostedImageTool; 1],
	tool_choice:  HostedImageToolChoice,
	store:        bool,
	stream:       bool,
	instructions: &'static str,
}

#[derive(Serialize)]
struct HostedImageTool {
	#[serde(rename = "type")]
	kind:          &'static str,
	action:        &'static str,
	output_format: &'static str,
	#[serde(skip_serializing_if = "Option::is_none")]
	size:          Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	quality:       Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	background:    Option<&'static str>,
}

#[derive(Serialize)]
struct HostedImageToolChoice {
	#[serde(rename = "type")]
	kind: &'static str,
}

const fn selected<T: Copy>(setting: &Setting<T>) -> Option<T> {
	match setting {
		Setting::Require(value) | Setting::Prefer(value) => Some(*value),
		Setting::Unset => None,
	}
}

pub(super) fn hosted_image_body(
	context: &EncodeContext<'_>,
	request: &ImageRequest,
) -> Result<Bytes, Error> {
	let target = context
		.target
		.ok_or_else(|| encoding_error("missing_responses_image_wire_target"))?;
	if request.count != 1 {
		return Err(encoding_error("responses_image_count_unsupported"));
	}
	if request.mask.is_some()
		|| !request.safety.is_empty()
		|| request.seed.is_some()
		|| !matches!(request.style, Setting::Unset)
	{
		return Err(encoding_error("responses_image_option_unsupported"));
	}
	let mut content = Vec::with_capacity(request.references.len() + 1);
	content.push(ResponsesContent::input_text(request.prompt.clone()));
	for reference in request.references.iter() {
		content.push(
			encode_media_content(reference, true)
				.map_err(|_| encoding_error("unresolved_responses_image_reference"))?,
		);
	}
	let size = match selected(&request.dimensions) {
		None => None,
		Some(Dimensions { width: 1024, height: 1024 }) => Some("1024x1024"),
		Some(Dimensions { width: 1024, height: 1536 }) => Some("1024x1536"),
		Some(Dimensions { width: 1536, height: 1024 }) => Some("1536x1024"),
		Some(_) => return Err(encoding_error("responses_image_dimensions_unsupported")),
	};
	let quality = selected(&request.quality).map(|quality| match quality {
		ImageQuality::Draft => "low",
		ImageQuality::Standard => "medium",
		ImageQuality::High => "high",
	});
	let background = selected(&request.background).map(|background| match background {
		Background::Opaque => "opaque",
		Background::Transparent => "transparent",
		Background::Auto => "auto",
	});
	let output_format = match selected(&request.format).unwrap_or(ImageFormat::Png) {
		ImageFormat::Png => "png",
		ImageFormat::Jpeg => "jpeg",
		ImageFormat::Webp => "webp",
	};
	serde_json::to_vec(&HostedImageRequest {
		model:        Str::new(target.wire_model.as_str()),
		input:        [ResponsesInputItem::message(ResponsesRole::User, content)],
		tools:        [HostedImageTool {
			kind: "image_generation",
			action: if request.references.is_empty() {
				"generate"
			} else {
				"edit"
			},
			output_format,
			size,
			quality,
			background,
		}],
		tool_choice:  HostedImageToolChoice { kind: "image_generation" },
		store:        false,
		stream:       true,
		instructions: "Generate exactly one high-quality image matching the user's request.",
	})
	.map(Bytes::from)
	.map_err(|_| encoding_error("responses_image_request_serialization"))
}

struct HostedImageDecoder {
	inner:      ResponsesDecoderAdapter,
	dimensions: Dimensions,
	format:     ImageFormat,
	artifacts:  u32,
}

impl HostedImageDecoder {
	fn project(&mut self, event: RawEvent, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		match event {
			RawEvent::Chat(ChatEvent::Artifact { mut artifact, .. }) => {
				artifact.media_type = Str::new(match self.format {
					ImageFormat::Png => "image/png",
					ImageFormat::Jpeg => "image/jpeg",
					ImageFormat::Webp => "image/webp",
				});
				self.artifacts = self.artifacts.saturating_add(1);
				emit(RawEvent::ImageGeneration(GenerationEvent::Artifact(ImageArtifact {
					artifact,
					width: self.dimensions.width,
					height: self.dimensions.height,
					revised_prompt: None,
				})));
			},
			RawEvent::Completion(completion) => {
				if self.artifacts != 1 {
					return Err(encoding_error("responses_image_result_missing"));
				}
				emit(RawEvent::ImageGeneration(GenerationEvent::Completed(GenerationSummary {
					artifacts: self.artifacts,
					elapsed:   Duration::ZERO,
					usage:     completion.usage,
					cost:      Cost::default(),
				})));
			},
			RawEvent::Chat(_) => {},
			event => emit(event),
		}
		Ok(())
	}

	fn forward(
		&mut self,
		result: Result<(), Error>,
		events: Vec<RawEvent>,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		result?;
		for event in events {
			self.project(event, emit)?;
		}
		Ok(())
	}
}

impl Decoder for HostedImageDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let mut events = Vec::new();
		let result = self.inner.push(frame, &mut |event| events.push(event));
		self.forward(result, events, emit)
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let mut events = Vec::new();
		let result = self.inner.finish(&mut |event| events.push(event));
		self.forward(result, events, emit)
	}
}

fn responses_decoder(context: &DecodeContext<'_>) -> ResponsesDecoderAdapter {
	ResponsesDecoderAdapter {
		inner: OpenAiResponsesDecoder::default(),
		request_id: context.request_id.clone(),
		provider: context.provider.clone(),
		route: context.route.clone(),
		wire_model: context
			.target
			.map(|target| Str::new(target.wire_model.as_str())),
		thinking_close_max_retries: context.policy.streaming.thinking_close_max_retries,
	}
}

pub(super) fn hosted_image_decoder(
	context: &DecodeContext<'_>,
	request: &ImageRequest,
) -> DecoderState {
	Box::new(HostedImageDecoder {
		inner:      responses_decoder(context),
		dimensions: selected(&request.dimensions)
			.unwrap_or(Dimensions { width: 1024, height: 1024 }),
		format:     selected(&request.format).unwrap_or(ImageFormat::Png),
		artifacts:  0,
	})
}

fn canonical_responses_adjustments(
	adjustments: &[ResponsesAdjustment],
) -> Result<Vec<Adjustment>, Error> {
	let mut canonical = Vec::new();
	for adjustment in adjustments {
		let ResponsesAdjustment::StrictFallback { field, reason } = adjustment else {
			return Err(encoding_error("responses_adjustment_requires_planning"));
		};
		let feature = match field.as_str() {
			"tools.strict" => FeatureId::new_static("chat.tool.strict"),
			"response_format.strict" => FeatureId::new_static("chat.structured_output.strict"),
			_ => return Err(encoding_error("responses_strict_adjustment_field")),
		};
		canonical.push(Adjustment::Dropped { feature, reason: ReasonId(reason.clone()) });
	}
	Ok(canonical)
}

impl Codec for OpenAiResponsesCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		if let OperationCall::GenerateImage(request) = operation {
			let target = context
				.target
				.ok_or_else(|| encoding_error("missing_responses_image_wire_target"))?;
			return Ok(EncodedRequest {
				operation:   OperationKind::GenerateImage,
				method:      RequestMethod::Post,
				uri:         responses_uri(target.endpoint.base_url.as_str()),
				headers:     vec![
					super::RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
					super::RequestHeader { name: sf!("accept"), value: sf!("text/event-stream") },
				]
				.into_boxed_slice(),
				body:        BodySource::Bytes(hosted_image_body(context, request)?),
				framing:     FramingProtocol::Sse,
				bounds:      SizeBounds {
					request_body: 64 * 1024 * 1024,
					frame:        16 * 1024 * 1024,
					response:     256 * 1024 * 1024,
				},
				sealed_body: None,
				adjustments: Vec::new(),
			});
		}
		let OperationCall::Chat(request) = operation else {
			return Err(encoding_error("responses_operation_unsupported"));
		};
		let encoded = self
			.encode_chat(context, request)
			.map_err(|error| match error {
				ResponsesEncodeError::MismatchedProviderProof => {
					encoding_error("mismatched_responses_provider_proof")
				},
				ResponsesEncodeError::MissingWireTarget => {
					encoding_error("missing_responses_wire_target")
				},
				ResponsesEncodeError::MissingCallIdentity => {
					encoding_error("missing_responses_call_identity")
				},
				ResponsesEncodeError::UnresolvedStoredMedia => {
					encoding_error("unresolved_responses_media")
				},
				ResponsesEncodeError::UnreplayableImageFileReference { .. } => {
					encoding_error("unreplayable_responses_image_file_reference")
				},
				ResponsesEncodeError::UnreplayableProviderProof => {
					encoding_error("unreplayable_responses_provider_proof")
				},
				ResponsesEncodeError::UnsupportedOutputFormat => {
					encoding_error("unsupported_responses_output_format")
				},
				ResponsesEncodeError::UnsupportedComputerUse => {
					encoding_error("unsupported_responses_computer_use")
				},
				ResponsesEncodeError::UnsupportedComputerUseConfig => {
					encoding_error("unsupported_responses_computer_use_config")
				},
				ResponsesEncodeError::MalformedServerState => {
					encoding_error("malformed_responses_server_state")
				},
				ResponsesEncodeError::MismatchedServerState => {
					encoding_error("mismatched_responses_server_state")
				},
			})?;
		let adjustments = canonical_responses_adjustments(&encoded.adjustments)?;
		let body = serde_json::to_vec(&encoded.request)
			.map(Bytes::from)
			.map_err(|_| encoding_error("responses_request_serialization"))?;
		let mut headers = vec![
			super::RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
			super::RequestHeader { name: sf!("accept"), value: sf!("text/event-stream") },
		];
		if let Some(header) = prompt_cache_session_header(
			context.policy.headers.prompt_cache_session,
			context.affinity.prompt_cache.clone(),
		) {
			headers.push(header);
		}
		Ok(EncodedRequest {
			operation: OperationKind::Chat,
			method: RequestMethod::Post,
			uri: responses_uri(
				context
					.target
					.expect("chat encoding checked the wire target")
					.endpoint
					.base_url
					.as_str(),
			),
			headers: headers.into_boxed_slice(),
			body: BodySource::Bytes(body),
			framing: FramingProtocol::Sse,
			bounds: SizeBounds {
				request_body: 64 * 1024 * 1024,
				frame:        16 * 1024 * 1024,
				response:     256 * 1024 * 1024,
			},
			sealed_body: None,
			adjustments,
		})
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != context.operation_call.kind() {
			return Err(encoding_error("responses_decode_operation_mismatch"));
		}
		match context.operation_call {
			OperationCall::GenerateImage(request) => Ok(hosted_image_decoder(context, request)),
			OperationCall::Chat(_) => Ok(Box::new(responses_decoder(context))),
			_ => Err(encoding_error("responses_decode_operation_mismatch")),
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::Duration};

	use bytes::Bytes;
	use omp_catalog::{Catalog, ReasoningEffort, RouteDef, ThinkingEffort, WireTarget, policy};
	use omp_core::{Str, sf};

	use super::{
		EncodedResponses, HostedImageDecoder, OpenAiResponsesCodec, OpenAiResponsesDecoder,
		OpenAiResponsesOptions, ResponsesContinuationFailure, ResponsesDecoderAdapter,
		ResponsesEncodeError, ResponsesErrorEvidence, ResponsesImageDetail, ResponsesInputItem,
		ResponsesInputItemKind, ResponsesProjection, ResponsesProviderProof, ResponsesRole,
		ResponsesToolOutput, ResponsesToolOutputPart, classify_continuation_error,
		encode_provider_proof, hoist_interleaved_tool_batch_messages,
	};
	use crate::{
		answer::GenerationEvent,
		call::{
			Background, CallAffinity, ChatRequest, ContentPart, Dimensions, ImageFormat, ImageQuality,
			ImageRequest, MediaInput, Message, NegotiationPolicy, OpaqueJson, OperationCall,
			ProviderProof, ReasoningRequest, ReasoningVisibility, Role, Sampling, Setting,
			StructuredOutput, ToolChoice, ToolDefinition, ToolGrammar, ToolGrammarSyntax,
			ToolInputConstraint, ToolResultContent,
		},
		catalog::{ProviderId, RouteId},
		codec::{Codec as _, Decoder as _, EncodeContext, RawEvent},
		event::{ChatEvent, FinishReason},
		id::{RequestId, ToolCallId},
		receipt::Usage,
		transport::{Frame, SseEvent},
	};

	fn replay_sse(fixture: &str) -> Vec<ResponsesProjection> {
		let mut decoder = OpenAiResponsesDecoder::default();
		let mut events = Vec::new();
		for block in fixture.split("\n\n") {
			for line in block.lines() {
				if let Some(data) = line.strip_prefix("data: ") {
					events.extend(decoder.push_json(data.as_bytes()));
				}
			}
		}
		events.extend(decoder.finish());
		events
	}

	fn request_with_tool(input: ToolInputConstraint) -> ChatRequest {
		ChatRequest {
			messages:          Arc::from([]),
			tools:             Arc::from([ToolDefinition {
				name: sf!("match_input"),
				description: None,
				input,
			}]),
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

	fn empty_chat_request() -> ChatRequest {
		let mut request = request_with_tool(ToolInputConstraint::Grammar {
			grammar:  ToolGrammar {
				syntax:     ToolGrammarSyntax::Lark,
				definition: Str::new_static("start: WORD"),
			},
			fallback: OpaqueJson::new(serde_json::json!({"type": "object"})),
		});
		request.tools = Arc::from([]);
		request
	}

	fn request_with_tool_result(content: Vec<ToolResultContent>) -> ChatRequest {
		let mut request = empty_chat_request();
		request.messages = Arc::from([Message {
			role:    Role::Tool,
			content: Arc::from([ContentPart::ToolResult {
				call:     ToolCallId::new("call_read"),
				name:     Some(Str::new_static("read")),
				content:  content.into(),
				is_error: false,
			}]),
			name:    None,
		}]);
		request
	}

	fn native_tool_output(
		kind: ResponsesInputItemKind,
		output: Option<ResponsesToolOutput>,
	) -> ResponsesInputItem {
		let mut item = ResponsesInputItem::message(ResponsesRole::User, Vec::new());
		item.kind = Some(kind);
		item.role = None;
		item.call_id = Some(Str::new_static("call_read"));
		item.output = output;
		item
	}

	/// First-party OpenA`OpenAI`onses fixture: the model, its `openai` Responses
	/// route, and the wire target. Selected by provider rather than catalog
	/// order so roster refreshes (new Responses-speaking hosts sorting first)
	/// cannot swap the fixture for one with a different strict/cache policy.
	fn embedded_openai_responses_fixture(
		catalog: &Catalog,
	) -> (&omp_catalog::ModelSpec, RouteDef, WireTarget) {
		let (model, route) = catalog
			.models()
			.iter()
			.find_map(|model| {
				model
					.routes
					.iter()
					.filter_map(|route| catalog.route(route))
					.find(|route| {
						route.provider.as_str() == "openai" && route.codec.as_str() == "openai-responses"
					})
					.map(|route| (model, route.clone()))
			})
			.expect("embedded first-party OpenAI Responses model");
		let wire_model = model
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.expect("embedded Responses wire model")
			.1
			.clone();
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		(model, route, target)
	}

	fn encode_tool(input: ToolInputConstraint) -> Vec<u8> {
		let catalog = Catalog::embedded();
		let (model, route, target) = embedded_openai_responses_fixture(catalog);
		let policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("embedded Responses wire policy");
		let request_id = RequestId::new("responses-tool-encoding");
		let context = EncodeContext {
			request_id: &request_id,
			route: &route,
			target: Some(&target),
			policy,
			..EncodeContext::default()
		};
		let encoded = OpenAiResponsesCodec::default()
			.encode_chat(&context, &request_with_tool(input))
			.expect("tool request encodes");
		serde_json::to_vec(&encoded.request.tools).expect("tools serialize")
	}
	fn encode_cache_affinity(disable_prompt_caching: bool) -> Option<Str> {
		let catalog = Catalog::embedded();
		let (model, mut route, target) = embedded_openai_responses_fixture(catalog);
		route.capability_limits.disable_prompt_caching = disable_prompt_caching;
		let policy = catalog
			.wire_policy(&model.wire_policy)
			.expect("embedded Responses wire policy");
		// No provider conversation is bound: the invocation key must still
		// reach the wire from the session-independent call affinity.
		let affinity =
			CallAffinity { prompt_cache: Some(sf!("invocation-cache")), provider_session: None };
		let request_id = RequestId::new("responses-cache-encoding");
		let context = EncodeContext {
			request_id: &request_id,
			route: &route,
			target: Some(&target),
			policy,
			affinity: &affinity,
			..EncodeContext::default()
		};
		OpenAiResponsesCodec::default()
			.encode_chat(
				&context,
				&request_with_tool(ToolInputConstraint::JsonSchema {
					parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
					strict:     false,
				}),
			)
			.expect("cache request encodes")
			.request
			.prompt_cache_key
	}

	fn image_request() -> ImageRequest {
		ImageRequest {
			prompt:      sf!("a blue hour cityscape"),
			references:  Arc::from([]),
			mask:        None,
			count:       1,
			dimensions:  Setting::Require(Dimensions { width: 1536, height: 1024 }),
			quality:     Setting::Require(ImageQuality::High),
			background:  Setting::Require(Background::Opaque),
			format:      Setting::Require(ImageFormat::Png),
			style:       Setting::Unset,
			safety:      Arc::from([]),
			seed:        None,
			negotiation: NegotiationPolicy::default(),
		}
	}

	#[test]
	fn hosted_image_request_uses_responses_tool_contract() {
		let catalog = Catalog::embedded();
		let route = catalog
			.routes()
			.iter()
			.find(|route| {
				route.provider.as_str() == "openai" && route.codec.as_str() == "openai-responses"
			})
			.expect("OpenAI Responses route");
		let target = WireTarget {
			route:      route.id.clone(),
			codec:      route.codec.clone(),
			endpoint:   route.endpoint.clone(),
			wire_model: sf!("gpt-5.5").into(),
		};
		let request_id = RequestId::new("responses-image");
		let policy = policy::WirePolicy::baseline();
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy: &policy,
			..EncodeContext::default()
		};
		let encoded = OpenAiResponsesCodec::default()
			.encode(&context, &OperationCall::GenerateImage(Arc::new(image_request())))
			.expect("hosted image request");
		assert_eq!(encoded.operation, omp_catalog::OperationKind::GenerateImage);
		assert_eq!(encoded.uri.as_str(), "https://api.openai.com/v1/responses");
		let crate::body::BodySource::Bytes(body) = encoded.body else {
			panic!("Responses image body is buffered JSON");
		};
		let body: serde_json::Value = serde_json::from_slice(&body).expect("request JSON");
		assert_eq!(body["tools"][0]["type"], "image_generation");
		assert_eq!(body["tools"][0]["size"], "1536x1024");
		assert_eq!(body["tool_choice"]["type"], "image_generation");
		assert_eq!(body["stream"], true);
	}

	#[test]
	fn hosted_image_result_projects_generation_artifact_and_completion() {
		let request_id = RequestId::new("responses-image-result");
		let provider = ProviderId::new("openai");
		let route = RouteId::new("openai/primary");
		let mut decoder = HostedImageDecoder {
			inner:      ResponsesDecoderAdapter {
				inner: OpenAiResponsesDecoder::default(),
				request_id,
				provider,
				route,
				wire_model: Some(sf!("gpt-5.5")),
				thinking_close_max_retries: None,
			},
			dimensions: Dimensions { width: 1024, height: 1024 },
			format:     ImageFormat::Png,
			artifacts:  0,
		};
		let payload = serde_json::json!({
			"type": "response.completed",
			"response": {
				"id": "resp_image",
				"status": "completed",
				"output": [{
					"type": "image_generation_call",
					"id": "ig_1",
					"status": "completed",
					"result": "aW1hZ2U="
				}]
			}
		});
		let mut events = Vec::new();
		decoder
			.push(
				Frame::Sse(SseEvent {
					name: None,
					data: Bytes::from(serde_json::to_vec(&payload).expect("event JSON")),
				}),
				&mut |event| events.push(event),
			)
			.expect("terminal image response");
		assert!(
			events
				.iter()
				.any(|event| matches!(event, RawEvent::ImageGeneration(GenerationEvent::Artifact(_))))
		);
		assert!(
			events
				.iter()
				.any(|event| matches!(event, RawEvent::ImageGeneration(GenerationEvent::Completed(_))))
		);
	}

	#[test]
	fn call_cache_affinity_lowers_without_a_bound_conversation_only_on_compatible_route() {
		assert_eq!(encode_cache_affinity(false).as_deref(), Some("invocation-cache"));
		assert_eq!(encode_cache_affinity(true), None);
	}

	#[test]
	fn text_only_tool_output_stays_a_flat_string() {
		let policy = policy::WirePolicy::baseline();
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool_result(vec![ToolResultContent::Text(Str::new_static("read complete"))])
		});
		let output = encoded
			.request
			.input
			.iter()
			.find_map(|item| item.output.as_ref())
			.expect("tool output");
		assert_eq!(output, &ResponsesToolOutput::Text(Str::new_static("read complete")),);
		let wire = serde_json::to_string(output).expect("tool output serializes");
		assert_eq!(wire, r#""read complete""#);
		let decoded: ResponsesToolOutput =
			serde_json::from_str(&wire).expect("flat tool output parses");
		assert_eq!(decoded, *output);
	}

	#[test]
	fn replayed_text_only_null_and_empty_outputs_normalize_to_flat_strings() {
		let policy = policy::WirePolicy::baseline();
		let options = OpenAiResponsesOptions {
			native_input: vec![
				native_tool_output(
					ResponsesInputItemKind::FunctionCallOutput,
					Some(ResponsesToolOutput::Multimodal(vec![
						ResponsesToolOutputPart::InputText { text: Str::new_static("first") },
						ResponsesToolOutputPart::InputText { text: Str::new_static("second") },
					])),
				),
				native_tool_output(
					ResponsesInputItemKind::CustomToolCallOutput,
					Some(ResponsesToolOutput::Multimodal(Vec::new())),
				),
				native_tool_output(ResponsesInputItemKind::FunctionCallOutput, None),
			],
			..OpenAiResponsesOptions::default()
		};
		let encoded = try_encode_with_options(&policy, options, |_, _| empty_chat_request())
			.expect("empty and text-only outputs encode");
		assert_eq!(
			encoded.request.input[0].output,
			Some(ResponsesToolOutput::Text(Str::new_static("first\nsecond"))),
		);
		assert_eq!(encoded.request.input[1].output, Some(ResponsesToolOutput::Text(Str::empty())),);
		assert_eq!(encoded.request.input[2].output, Some(ResponsesToolOutput::Text(Str::empty())),);
	}

	#[test]
	fn mixed_tool_output_encodes_ordered_text_and_image_parts() {
		let policy = policy::WirePolicy::baseline();
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool_result(vec![
				ToolResultContent::Text(Str::new_static("Read image file [image/png]")),
				ToolResultContent::Image(MediaInput::Bytes {
					media_type: Str::new_static("image/png"),
					data:       Bytes::from_static(b"tool image"),
				}),
			])
		});
		assert_eq!(encoded.request.input.len(), 1);
		assert_eq!(encoded.request.input[0].kind, Some(ResponsesInputItemKind::FunctionCallOutput),);
		let output = encoded.request.input[0]
			.output
			.as_ref()
			.expect("tool output");
		assert_eq!(
			output,
			&ResponsesToolOutput::Multimodal(vec![
				ResponsesToolOutputPart::InputText {
					text: Str::new_static("Read image file [image/png]"),
				},
				ResponsesToolOutputPart::InputImage {
					detail:    Some(ResponsesImageDetail::Auto),
					image_url: Some(Str::new_static("data:image/png;base64,dG9vbCBpbWFnZQ==",)),
					file_id:   None,
				},
			]),
		);
		let wire = serde_json::to_string(output).expect("multimodal tool output serializes");
		let decoded: ResponsesToolOutput =
			serde_json::from_str(&wire).expect("multimodal tool output parses");
		assert_eq!(decoded, *output);
	}

	#[test]
	fn text_only_model_keeps_image_tool_output_in_flat_fallback_form() {
		let mut policy = policy::WirePolicy::baseline();
		policy.image.encoding = Some(policy::ImageEncodingFormat::None);
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool_result(vec![
				ToolResultContent::Text(Str::new_static("read complete")),
				ToolResultContent::Image(MediaInput::Bytes {
					media_type: Str::new_static("image/png"),
					data:       Bytes::from_static(b"tool image"),
				}),
			])
		});
		assert_eq!(
			encoded.request.input[0].output,
			Some(ResponsesToolOutput::Text(Str::new_static(
				"read complete\n[image omitted: model does not support vision]",
			))),
		);
	}

	#[test]
	fn replayed_original_image_detail_is_clamped_to_auto() {
		let mut policy = policy::WirePolicy::baseline();
		policy.image.supports_detail_original = Some(false);
		let output = ResponsesToolOutput::Multimodal(vec![ResponsesToolOutputPart::InputImage {
			detail:    Some(ResponsesImageDetail::Original),
			image_url: Some(Str::new_static("https://example.invalid/image.png")),
			file_id:   None,
		}]);
		let options = OpenAiResponsesOptions {
			native_input: vec![native_tool_output(
				ResponsesInputItemKind::FunctionCallOutput,
				Some(output),
			)],
			..OpenAiResponsesOptions::default()
		};
		let encoded = try_encode_with_options(&policy, options, |_, _| empty_chat_request())
			.expect("replayed output encodes");
		let detail = encoded.request.input.iter().find_map(|item| {
			let Some(ResponsesToolOutput::Multimodal(parts)) = item.output.as_ref() else {
				return None;
			};
			parts.iter().find_map(|part| match part {
				ResponsesToolOutputPart::InputImage { detail, .. } => *detail,
				ResponsesToolOutputPart::InputText { .. } => None,
			})
		});
		assert_eq!(detail, Some(ResponsesImageDetail::Auto));
	}

	#[test]
	fn replayed_file_id_without_data_or_url_is_rejected() {
		let policy = policy::WirePolicy::baseline();
		let output = ResponsesToolOutput::Multimodal(vec![ResponsesToolOutputPart::InputImage {
			detail:    Some(ResponsesImageDetail::Low),
			image_url: None,
			file_id:   Some(Str::new_static("file_image_123")),
		}]);
		let options = OpenAiResponsesOptions {
			native_input: vec![native_tool_output(
				ResponsesInputItemKind::FunctionCallOutput,
				Some(output),
			)],
			..OpenAiResponsesOptions::default()
		};
		let error = try_encode_with_options(&policy, options, |_, _| empty_chat_request())
			.expect_err("provider file identity is not replayable");
		assert_eq!(error, ResponsesEncodeError::UnreplayableImageFileReference {
			file_id: Str::new_static("file_image_123"),
		},);
	}

	#[test]
	fn inbound_function_and_custom_outputs_preserve_multimodal_parts() {
		for (wire, expected_kind) in [
			(
				r#"{
				"type": "function_call_output",
				"call_id": "call_read",
				"output": [
					{"type": "input_text", "text": "rendered"},
					{
						"type": "input_image",
						"detail": "high",
						"image_url": "data:image/png;base64,AAAA"
					},
					{
						"type": "input_image",
						"detail": "low",
						"file_id": "file_image_123"
					}
				]
			}"#,
				ResponsesInputItemKind::FunctionCallOutput,
			),
			(
				r#"{
				"type": "custom_tool_call_output",
				"call_id": "call_read",
				"output": [
					{"type": "input_text", "text": "rendered"},
					{
						"type": "input_image",
						"detail": "high",
						"image_url": "data:image/png;base64,AAAA"
					},
					{
						"type": "input_image",
						"detail": "low",
						"file_id": "file_image_123"
					}
				]
			}"#,
				ResponsesInputItemKind::CustomToolCallOutput,
			),
		] {
			let item: ResponsesInputItem =
				serde_json::from_str(wire).expect("multimodal inbound output parses");
			assert_eq!(item.kind, Some(expected_kind));
			assert_eq!(
				item.output,
				Some(ResponsesToolOutput::Multimodal(vec![
					ResponsesToolOutputPart::InputText { text: Str::new_static("rendered") },
					ResponsesToolOutputPart::InputImage {
						detail:    Some(ResponsesImageDetail::High),
						image_url: Some(Str::new_static("data:image/png;base64,AAAA")),
						file_id:   None,
					},
					ResponsesToolOutputPart::InputImage {
						detail:    Some(ResponsesImageDetail::Low),
						image_url: None,
						file_id:   Some(Str::new_static("file_image_123")),
					},
				])),
			);
		}

		let null: ResponsesInputItem = serde_json::from_str(
			r#"{"type":"function_call_output","call_id":"call_null","output":null}"#,
		)
		.expect("null output parses");
		assert_eq!(null.output, None);
		let empty: ResponsesInputItem = serde_json::from_str(
			r#"{"type":"custom_tool_call_output","call_id":"call_empty","output":[]}"#,
		)
		.expect("empty array output parses");
		assert_eq!(empty.output, Some(ResponsesToolOutput::Multimodal(Vec::new())),);
	}

	fn try_encode_with_options(
		policy: &policy::WirePolicy,
		options: OpenAiResponsesOptions,
		build: impl FnOnce(&RouteDef, &WireTarget) -> ChatRequest,
	) -> Result<EncodedResponses, ResponsesEncodeError> {
		try_encode_with_thinking(policy, options, None, build)
	}

	fn try_encode_with_thinking(
		policy: &policy::WirePolicy,
		options: OpenAiResponsesOptions,
		thinking: Option<(&omp_catalog::ThinkingPolicy, &omp_catalog::ThinkingSelection)>,
		build: impl FnOnce(&RouteDef, &WireTarget) -> ChatRequest,
	) -> Result<EncodedResponses, ResponsesEncodeError> {
		let catalog = Catalog::embedded();
		let model = catalog
			.models()
			.iter()
			.find(|model| {
				model.routes.iter().any(|route| {
					catalog
						.route(route)
						.is_some_and(|route| route.codec.as_str() == "openai-responses")
				})
			})
			.expect("embedded Responses model");
		let route = model
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.codec.as_str() == "openai-responses")
			.expect("embedded Responses route");
		let wire_model = model
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.expect("embedded Responses wire model")
			.1
			.clone();
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let request = build(route, &target);
		let request_id = RequestId::new("responses-policy-encoding");
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy,
			thinking_policy: thinking.map(|(policy, _)| policy),
			thinking_selection: thinking.map(|(_, selection)| selection),
			..EncodeContext::default()
		};
		OpenAiResponsesCodec::new(options).encode_chat(&context, &request)
	}

	fn encode_with_policy(
		policy: &policy::WirePolicy,
		build: impl FnOnce(&RouteDef, &WireTarget) -> ChatRequest,
	) -> EncodedResponses {
		try_encode_with_options(policy, OpenAiResponsesOptions::default(), build)
			.expect("policy request encodes")
	}

	#[test]
	fn always_send_max_tokens_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.context.always_send_max_tokens = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| empty_chat_request());
		assert!(encoded.request.max_output_tokens.is_some());
	}

	#[test]
	fn cache_control_format_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.cache.control_format = Some(policy::CacheControlFormat::Anthropic);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.cache_retention = Setting::Require(crate::call::CacheRetention::Short);
			request
		});
		assert_eq!(
			encoded.request.cache_control,
			Some(super::ResponsesCacheControl { kind: sf!("ephemeral") })
		);
	}

	#[test]
	fn disable_reasoning_on_forced_tool_choice_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.disable_reasoning_on_forced_choice = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.reasoning = Setting::Require(ReasoningRequest {
				visibility:          ReasoningVisibility::Visible,
				effort:              Some(ReasoningEffort::Medium),
				max_tokens:          None,
				preserve_signatures: false,
			});
			request.tool_choice = Setting::Require(ToolChoice::Auto);
			request
		});
		assert_eq!(encoded.request.tool_choice, None);
	}

	#[test]
	fn prompt_cache_session_header_matches_pi_request_shape() {
		let header = super::prompt_cache_session_header(
			Some(policy::PromptCacheSessionHeader::XGrokConversationId),
			Some(sf!("conversation-1")),
		)
		.expect("session header");
		assert_eq!(header.name, "x-grok-conv-id");
		assert_eq!(header.value, "conversation-1");
	}

	#[test]
	fn prompt_cache_breakpoint_ttl_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.cache.supports_breakpoints = Some(true);
		policy.cache.breakpoint_ttl = Some(policy::PromptCacheBreakpointTtl::ThirtyMinutes);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.messages = Arc::from([Message {
				role:    Role::User,
				content: Arc::from([
					ContentPart::Text { text: sf!("stable"), proof: None },
					ContentPart::CachePoint(crate::call::CacheRetention::Short),
				]),
				name:    None,
			}]);
			request
		});
		let options = encoded.request.prompt_cache_options.expect("cache options");
		assert_eq!(options.mode, "explicit");
		assert_eq!(options.ttl.as_deref(), Some("30m"));
	}

	#[test]
	fn supports_prompt_cache_breakpoints_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.cache.supports_breakpoints = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.messages = Arc::from([Message {
				role:    Role::User,
				content: Arc::from([
					ContentPart::Text { text: sf!("stable"), proof: None },
					ContentPart::CachePoint(crate::call::CacheRetention::Short),
				]),
				name:    None,
			}]);
			request
		});
		let parts = encoded.request.input[0]
			.content
			.parts()
			.expect("typed content");
		assert_eq!(
			parts[0]
				.prompt_cache_breakpoint
				.as_ref()
				.map(|breakpoint| breakpoint.mode.as_str()),
			Some("explicit")
		);
	}

	#[test]
	fn reject_root_object_union_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.reject_root_object_union = Some(true);
		let schema = serde_json::from_str(
			r#"{"type":"object","anyOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"type":"string"}]}"#,
		)
		.expect("schema");
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(schema),
				strict:     true,
			})
		});
		assert!(encoded.request.tools.is_empty());
	}

	#[test]
	fn requires_reasoning_off_juice_instruction_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.reasoning.requires_off_juice_instruction = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.reasoning = Setting::Require(ReasoningRequest {
				visibility:          ReasoningVisibility::Hidden,
				effort:              Some(ReasoningEffort::Off),
				max_tokens:          None,
				preserve_signatures: false,
			});
			request
		});
		assert!(encoded.request.input.iter().any(|item| {
			item.content.parts().is_some_and(|parts| {
				parts
					.iter()
					.any(|part| part.text.as_deref() == Some("# Juice: 0 !important"))
			})
		}));
	}

	#[test]
	fn strict_responses_pairing_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.strict_responses_pairing = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool_result(vec![ToolResultContent::Text(sf!("orphaned"))])
		});
		assert_eq!(encoded.request.input[0].role, Some(ResponsesRole::Assistant));
		assert!(
			encoded.request.input[0]
				.content
				.parts()
				.is_some_and(|parts| parts[0].text.as_deref().is_some_and(|text| {
					text.starts_with("[Orphan read result; call_id=call_read]: orphaned")
				}))
		);
	}

	#[test]
	fn strip_image_input_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.image.strip_input = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.messages = Arc::from([Message {
				role:    Role::User,
				content: Arc::from([
					ContentPart::Text { text: sf!("describe"), proof: None },
					ContentPart::Image(MediaInput::Bytes {
						media_type: sf!("image/png"),
						data:       Bytes::from_static(b"png"),
					}),
				]),
				name:    None,
			}]);
			request
		});
		let parts = encoded.request.input[0]
			.content
			.parts()
			.expect("typed content");
		assert_eq!(parts.len(), 1);
		assert_eq!(parts[0].kind, super::ResponsesContentKind::InputText);
	}

	#[test]
	fn supports_long_prompt_cache_retention_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.cache.supports_long_retention = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.cache_retention = Setting::Require(crate::call::CacheRetention::Long);
			request
		});
		assert_eq!(encoded.request.prompt_cache_retention.as_deref(), Some("24h"));
	}

	#[test]
	fn supports_named_tool_choice_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.named_choice = Some(false);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					serde_json::from_str(r#"{"type":"object"}"#).expect("schema"),
				),
				strict:     false,
			});
			request.tool_choice = Setting::Require(ToolChoice::Named(sf!("match_input")));
			request
		});
		assert!(matches!(
			encoded.request.tool_choice,
			Some(super::ResponsesToolChoice::Mode(super::ResponsesToolChoiceMode::Required))
		));
		assert_eq!(encoded.request.tools.len(), 1);
		assert_eq!(encoded.request.tools[0].name.as_deref(), Some("match_input"));
	}

	#[test]
	fn supports_obfuscation_opt_out_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.streaming.supports_obfuscation_opt_out = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| empty_chat_request());
		assert_eq!(
			encoded
				.request
				.stream_options
				.and_then(|options| options.include_obfuscation),
			Some(false)
		);
	}

	#[test]
	fn supports_penalty_and_stop_params_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.structured.penalty_and_stop_params = Some(false);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.sampling.presence_penalty = Some(0.5);
			request.sampling.frequency_penalty = Some(0.25);
			request
		});
		assert_eq!(encoded.request.presence_penalty, None);
		assert_eq!(encoded.request.frequency_penalty, None);
	}

	#[test]
	fn supports_reasoning_params_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.reasoning.supports_params = Some(false);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.reasoning = Setting::Require(ReasoningRequest {
				visibility:          ReasoningVisibility::Visible,
				effort:              Some(ReasoningEffort::Medium),
				max_tokens:          None,
				preserve_signatures: false,
			});
			request
		});
		assert!(encoded.request.reasoning.is_none());
	}

	#[test]
	fn supports_strict_mode_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.supports_strict_mode = Some(false);
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					serde_json::from_str(r#"{"type":"object"}"#).expect("schema"),
				),
				strict:     true,
			})
		});
		assert_eq!(encoded.request.tools[0].strict, None);
		assert!(matches!(
			encoded.adjustments.as_slice(),
			[super::ResponsesAdjustment::StrictFallback { field, reason }]
				if field == "tools.strict"
					&& reason == "catalog.strict-schema-unsupported"
		));
		let canonical = super::canonical_responses_adjustments(&encoded.adjustments)
			.expect("strict fallback is transport-safe");
		assert!(matches!(
			canonical.as_slice(),
			[crate::receipt::Adjustment::Dropped { feature, reason }]
				if feature.0 == "chat.tool.strict"
					&& reason.0 == "catalog.strict-schema-unsupported"
		));
	}

	#[test]
	fn unknown_strict_capability_is_unsupported_and_receipted() {
		let encoded = encode_with_policy(&policy::WirePolicy::baseline(), |_, _| {
			request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({
					"type": "object",
					"properties": {"query": {"type": "string"}}
				})),
				strict:     true,
			})
		});
		assert_eq!(encoded.request.tools[0].strict, None);
		assert!(matches!(
			encoded.adjustments.as_slice(),
			[super::ResponsesAdjustment::StrictFallback { reason, .. }]
				if reason == "catalog.strict-schema-unsupported"
		));
	}

	#[test]
	fn strict_responses_schema_uses_shared_nullable_and_keyword_normalization() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.supports_strict_mode = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({
					"type": "object",
					"properties": {
						"query": {"type": "string", "pattern": "^x+$"},
						"limit": {"type": "integer", "minimum": 1}
					},
					"required": ["query"],
					"oneOf": [
						{"type": "object", "properties": {"query": {"type": "string"}}}
					]
				})),
				strict:     true,
			})
		});
		let schema = encoded.request.tools[0]
			.parameters
			.as_ref()
			.expect("schema");
		assert_eq!(encoded.request.tools[0].strict, Some(true));
		assert!(schema.get("oneOf").is_none());
		assert!(schema.get("anyOf").is_some());
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["required"], serde_json::json!(["query", "limit"]));
		assert!(schema["properties"]["query"].get("pattern").is_none());
		assert_eq!(schema["properties"]["limit"]["anyOf"][1]["type"], "null");
		assert!(encoded.adjustments.is_empty());
	}

	#[test]
	fn strict_responses_output_schema_uses_the_same_dialect_normalizer() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.supports_strict_mode = Some(true);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = empty_chat_request();
			request.output = Setting::Require(StructuredOutput::JsonSchema {
				name:   sf!("answer"),
				schema: OpaqueJson::new(serde_json::json!({
					"type": "object",
					"properties": {"answer": {"type": "string", "maxLength": 20}}
				})),
				strict: true,
			});
			request
		});
		let format = encoded
			.request
			.text
			.as_ref()
			.and_then(|text| text.format.as_ref())
			.expect("response format");
		let schema = format.schema.as_ref().expect("schema");
		assert_eq!(format.strict, Some(true));
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(schema["required"], serde_json::json!(["answer"]));
		assert_eq!(schema["properties"]["answer"]["anyOf"][1]["type"], "null");
		assert!(schema["properties"]["answer"].get("maxLength").is_none());
	}

	#[test]
	fn responses_cached_tokens_are_removed_from_uncached_input_dimension() {
		let usage = Usage::from(&super::ResponsesUsage {
			input_tokens: 100,
			output_tokens: 30,
			input_tokens_details: super::ResponsesInputTokenDetails { cached_tokens: 40 },
			output_tokens_details: super::ResponsesOutputTokenDetails { reasoning_tokens: 20 },
			..Default::default()
		});
		assert_eq!(usage.input_tokens, 60);
		assert_eq!(usage.cache_read_tokens, 40);
		assert_eq!(usage.output_tokens, 30);
		assert_eq!(usage.reasoning_tokens, 20);
	}

	/// First-party xAI `/v1/responses` wire policy: no summary, no penalties,
	/// encrypted reasoning requested and replayed, `minimal` clamped to `low`.
	fn xai_like_policy() -> policy::WirePolicy {
		let mut policy = policy::WirePolicy::baseline();
		policy.structured.penalties = Some(false);
		policy.reasoning.supports_summary = Some(false);
		policy.reasoning.include_encrypted = Some(true);
		policy.reasoning.filter_history = Some(false);
		policy
			.reasoning
			.effort_map
			.insert(ThinkingEffort::Minimal, sf!("low"));
		policy
	}

	fn xai_replay_request(route: &RouteDef, target: &WireTarget) -> ChatRequest {
		let proof = encode_provider_proof(&ResponsesProviderProof {
			item_id: Some(sf!("rs_1")),
			encrypted_reasoning: Some(sf!("enc_BLOB")),
			..ResponsesProviderProof::default()
		})
		.expect("proof encodes");
		ChatRequest {
			messages:          Arc::from([
				Message {
					role:    Role::User,
					content: Arc::from([ContentPart::Text { text: "hi".into(), proof: None }]),
					name:    None,
				},
				Message {
					role:    Role::Assistant,
					content: Arc::from([ContentPart::Reasoning {
						text:  sf!("Inspect first."),
						proof: Some(ProviderProof {
							provider: route.provider.clone(),
							codec:    target.codec.clone(),
							value:    proof,
						}),
					}]),
					name:    None,
				},
			]),
			tools:             Arc::from([]),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Unset,
			output:            Setting::Unset,
			reasoning:         Setting::Require(ReasoningRequest {
				visibility:          ReasoningVisibility::Summary,
				effort:              Some(ReasoningEffort::Minimal),
				max_tokens:          None,
				preserve_signatures: false,
			}),
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          Sampling {
				presence_penalty: Some(0.5),
				frequency_penalty: Some(0.25),
				..Sampling::default()
			},
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       NegotiationPolicy::default(),
			forced_call:       None,
		}
	}

	#[test]
	fn xai_policy_omits_summary_and_penalties_and_replays_encrypted_reasoning() {
		let policy = xai_like_policy();
		let encoded = encode_with_policy(&policy, xai_replay_request);
		assert!(encoded.adjustments.is_empty(), "policy lowering is not an adjustment");
		let request = &encoded.request;
		// `minimal` clamps to `low` through the route effort map; the summary
		// field is omitted entirely, not sent as null or filled with `auto`.
		let reasoning = serde_json::to_value(request.reasoning.as_ref().expect("reasoning object"))
			.expect("reasoning serializes");
		assert_eq!(reasoning.get("effort"), Some(&serde_json::json!("low")));
		assert!(reasoning.get("summary").is_none());
		// api.x.ai rejects presence/frequency penalties for every Grok model.
		assert_eq!(request.presence_penalty, None);
		assert_eq!(request.frequency_penalty, None);
		// Encrypted reasoning is requested via `include` and replayed from
		// history proofs so later turns keep the encrypted chain.
		assert!(
			request
				.include
				.iter()
				.any(|value| value == "reasoning.encrypted_content")
		);
		let replayed = request
			.input
			.iter()
			.find(|item| item.kind == Some(ResponsesInputItemKind::Reasoning))
			.expect("replayed reasoning item");
		assert_eq!(replayed.encrypted_content.as_deref(), Some("enc_BLOB"));
		assert_eq!(replayed.id.as_deref(), Some("rs_1"));
	}

	#[test]
	fn filtered_reasoning_history_drops_replay_wrappers_without_adjustments() {
		let mut policy = xai_like_policy();
		policy.reasoning.filter_history = Some(true);
		policy.reasoning.include_encrypted = Some(false);
		let encoded = encode_with_policy(&policy, xai_replay_request);
		assert!(encoded.adjustments.is_empty());
		assert!(
			!encoded
				.request
				.input
				.iter()
				.any(|item| item.kind == Some(ResponsesInputItemKind::Reasoning))
		);
		assert!(
			!encoded
				.request
				.include
				.iter()
				.any(|value| value == "reasoning.encrypted_content")
		);
	}

	fn reasoning_request(effort: ReasoningEffort) -> ChatRequest {
		let mut request = empty_chat_request();
		request.reasoning = Setting::Prefer(ReasoningRequest {
			visibility:          ReasoningVisibility::Visible,
			effort:              Some(effort),
			max_tokens:          None,
			preserve_signatures: true,
		});
		request
	}

	/// Encodes `effort` against a gpt-5-shaped ladder (`minimal..high`, off
	/// allowed, no `reasoning-disable-mode`) through the planner's resolution.
	fn encode_on_four_tier_ladder(
		policy: &policy::WirePolicy,
		effort: ReasoningEffort,
	) -> Option<serde_json::Value> {
		let thinking = omp_catalog::ThinkingPolicy::new(omp_catalog::ThinkingMode::Effort, [
			ThinkingEffort::Minimal,
			ThinkingEffort::Low,
			ThinkingEffort::Medium,
			ThinkingEffort::High,
		])
		.expect("valid ladder");
		let selection = omp_catalog::ThinkingRouting::default()
			.resolve(&thinking, Some(effort.into()), omp_catalog::WireModelId::from_ref("gpt-5"))
			.expect("ladder resolves every canonical effort");
		let encoded = try_encode_with_thinking(
			policy,
			OpenAiResponsesOptions::default(),
			Some((&thinking, &selection)),
			|_, _| reasoning_request(effort),
		)
		.expect("request encodes");
		encoded
			.request
			.reasoning
			.as_ref()
			.map(|reasoning| serde_json::to_value(reasoning).expect("reasoning serializes"))
	}

	#[test]
	fn effort_outside_catalog_efforts_is_clamped_not_sent() {
		// `reasoning.effort` is the catalog-mapped effort, and `none` is only a wire
		// value where `reasoning-disable-mode "none-effort"`
		// says so (gpt-5.6); gpt-5 400s on it. Above the ladder clamps to
		// the ceiling; off sends no effort and no summary at all.
		let policy = policy::WirePolicy::baseline();
		let xhigh = encode_on_four_tier_ladder(&policy, ReasoningEffort::Xhigh).expect("reasoning");
		assert_eq!(xhigh.get("effort"), Some(&serde_json::json!("high")));
		assert_eq!(xhigh.get("summary"), Some(&serde_json::json!("auto")));
		let off = encode_on_four_tier_ladder(&policy, ReasoningEffort::Off);
		assert_eq!(off, None, "reasoning-off without a catalog spelling sends nothing");

		let mut none_effort = policy::WirePolicy::baseline();
		none_effort.reasoning.disable_mode = Some(policy::ReasoningDisableMode::NoneEffort);
		let off = encode_on_four_tier_ladder(&none_effort, ReasoningEffort::Off).expect("reasoning");
		assert_eq!(off.get("effort"), Some(&serde_json::json!("none")));
	}

	#[test]
	fn omitted_effort_with_no_summary_sends_no_reasoning_object_at_all() {
		// No-dial Grok rows 400 on `reasoning.effort`, and api.x.ai rejects
		// `reasoning.summary`; with both omitted the object carries nothing,
		// so the wire drops `reasoning` entirely rather than sending `{}`.
		let mut policy = xai_like_policy();
		policy.reasoning.omit_effort = Some(true);
		let encoded = encode_with_policy(&policy, xai_replay_request);
		assert!(encoded.request.reasoning.is_none());
	}

	#[test]
	fn tool_choice_policy_omits_forced_selectors_while_preserving_tools() {
		// Console Go's Responses route rejects forced named selectors for
		// DeepSeek V4 while thinking mode is active (#8244); the selector is
		// dropped but the tool definitions stay on the wire.
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.supports_tool_choice = Some(false);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
				strict:     false,
			});
			request.tool_choice = Setting::Require(ToolChoice::Named(sf!("match_input")));
			request
		});
		assert_eq!(encoded.request.tool_choice, None, "rejected selector is omitted");
		assert_eq!(encoded.request.tools.len(), 1, "tool definitions are preserved");
		assert_eq!(encoded.request.tools[0].name.as_deref(), Some("match_input"));
		assert!(
			matches!(
				&encoded.adjustments[..],
				[super::ResponsesAdjustment::Dropped { field, .. }] if field == "tool_choice"
			),
			"the drop is recorded as an adjustment"
		);
	}

	#[test]
	fn forced_choice_policy_keeps_auto_but_drops_required_selectors() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.forced_choice = Some(false);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
				strict:     false,
			});
			request.tool_choice = Setting::Require(ToolChoice::Required);
			request
		});
		assert_eq!(encoded.request.tool_choice, None);
		let encoded = encode_with_policy(&policy, |_, _| {
			let mut request = request_with_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
				strict:     false,
			});
			request.tool_choice = Setting::Require(ToolChoice::Auto);
			request
		});
		assert!(
			matches!(
				encoded.request.tool_choice,
				Some(super::ResponsesToolChoice::Mode(super::ResponsesToolChoiceMode::Auto))
			),
			"auto is not a forced selector and stays on the wire"
		);
	}
	#[test]
	fn reasoning_conflict_drops_only_redundant_auto_tool_choice() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.disable_reasoning_on_choice = Some(true);
		let encode_choice = |policy: &policy::WirePolicy, reasoning: bool, choice: ToolChoice| {
			encode_with_policy(policy, |_, _| {
				let mut request = request_with_tool(ToolInputConstraint::JsonSchema {
					parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
					strict:     false,
				});
				if reasoning {
					request.reasoning = Setting::Require(ReasoningRequest {
						visibility:          ReasoningVisibility::Visible,
						effort:              Some(ReasoningEffort::Medium),
						max_tokens:          None,
						preserve_signatures: false,
					});
				}
				request.tool_choice = Setting::Require(choice);
				request
			})
			.request
			.tool_choice
		};

		assert_eq!(encode_choice(&policy, true, ToolChoice::Auto), None);
		assert!(matches!(
			encode_choice(&policy, false, ToolChoice::Auto),
			Some(super::ResponsesToolChoice::Mode(super::ResponsesToolChoiceMode::Auto))
		));

		let baseline = policy::WirePolicy::baseline();
		assert!(matches!(
			encode_choice(&baseline, true, ToolChoice::Auto),
			Some(super::ResponsesToolChoice::Mode(super::ResponsesToolChoiceMode::Auto))
		));
		assert!(matches!(
			encode_choice(&policy, true, ToolChoice::Required),
			Some(super::ResponsesToolChoice::Mode(super::ResponsesToolChoiceMode::Required))
		));
		assert!(matches!(
			encode_choice(
				&policy,
				true,
				ToolChoice::Named(sf!("match_input"))
			),
			Some(super::ResponsesToolChoice::Named(named))
				if named.name.as_deref() == Some("match_input")
		));
	}

	#[test]
	fn custom_tool_grammars_preserve_exact_syntax_and_definition_on_wire() {
		let cases: [(ToolGrammarSyntax, &'static str, &'static [u8]); 3] = [
			(
				ToolGrammarSyntax::Regex,
				"[a-z]+",
				br#"[{"type":"custom","name":"match_input","format":{"type":"grammar","syntax":"regex","definition":"[a-z]+"}}]"#,
			),
			(
				ToolGrammarSyntax::Lark,
				"start: WORD\n%import common.WORD",
				br#"[{"type":"custom","name":"match_input","format":{"type":"grammar","syntax":"lark","definition":"start: WORD\n%import common.WORD"}}]"#,
			),
			(
				ToolGrammarSyntax::Ebnf,
				r#"root = "yes" | "no";"#,
				br#"[{"type":"custom","name":"match_input","format":{"type":"grammar","syntax":"ebnf","definition":"root = \"yes\" | \"no\";"}}]"#,
			),
		];
		for (syntax, definition, expected) in cases {
			assert_eq!(
				encode_tool(ToolInputConstraint::Grammar {
					grammar:  ToolGrammar { syntax, definition: Str::new(definition) },
					fallback: OpaqueJson::new(serde_json::json!({"type": "object"})),
				}),
				expected,
			);
		}
	}

	#[test]
	fn json_schema_tool_encoding_remains_a_strict_function_tool() {
		assert_eq!(
			encode_tool(ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({"type": "object"})),
				strict: true,
			}),
			br#"[{"type":"function","name":"match_input","parameters":{"type":"object","properties":{},"required":[],"additionalProperties":false},"strict":true}]"#,
		);
	}

	#[test]
	fn replays_encrypted_reasoning_tool_and_usage_fixture() {
		let events = replay_sse(include_str!(
			"../../../../fixtures/llm-oracle/openai/responses/stream.encrypted_tool_usage.sse"
		));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::Canonical(ChatEvent::ThinkingDelta { text, .. })
				if text == "Inspect first."
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::ReasoningSignature { signature, .. }
				if signature == b"enc_REDACTED".as_slice()
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::ToolCallComplete { name, arguments, custom: false, .. }
				if name == "read" && arguments == br#"{"path":"README.md"}"#.as_slice()
		)));
		assert!(!events.iter().any(|event| matches!(
			event,
			ResponsesProjection::Canonical(ChatEvent::ToolCallReady { .. })
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::Canonical(ChatEvent::Usage(update))
				if update.usage.input_tokens == 10
					&& update.usage.output_tokens == 8
					&& update.usage.cache_read_tokens == 20
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::Completion(completion)
				if completion.reason == FinishReason::ToolCalls
		)));
	}
	#[test]
	fn reasoning_summary_done_recovers_omitted_part_and_delta_events() {
		for (delta, expected) in
			[(None, vec!["Let's check"]), (Some("Let's "), vec!["Let's ", "check"])]
		{
			let mut decoder = OpenAiResponsesDecoder::default();
			let mut events = decoder.push_json(
				br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_ollama","summary":[]}}"#,
			);
			if let Some(delta) = delta {
				events.extend(decoder.push_json(
					format!(
						r#"{{"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_ollama","summary_index":0,"delta":{}}}"#,
						serde_json::to_string(delta).unwrap(),
					)
					.as_bytes(),
				));
			}
			events.extend(decoder.push_json(
				br#"{"type":"response.reasoning_summary_text.done","output_index":0,"item_id":"rs_ollama","summary_index":0,"text":"Let's check"}"#,
			));
			let deltas = events
				.iter()
				.filter_map(|event| match event {
					ResponsesProjection::Canonical(ChatEvent::ThinkingDelta { text, .. }) => {
						Some(text.as_str())
					},
					_ => None,
				})
				.collect::<Vec<_>>();
			assert_eq!(deltas, expected);
		}
	}

	#[test]
	fn replays_hosted_tool_ordering_and_reasoning_usage_fixture() {
		let events = replay_sse(include_str!(
			"../../../../fixtures/llm-oracle/openai/responses/stream.server_tools_ordering.sse"
		));
		let text = events
			.iter()
			.position(|event| {
				matches!(
					event,
					ResponsesProjection::Canonical(ChatEvent::TextDelta { text, .. }) if text == "Found it."
				)
			})
			.expect("text delta");
		let usage = events
			.iter()
			.position(|event| {
				matches!(
					event,
					ResponsesProjection::Canonical(ChatEvent::Usage(update))
						if update.usage.reasoning_tokens == 7 && update.usage.cache_read_tokens == 32
				)
			})
			.expect("usage");
		let complete = events
			.iter()
			.position(|event| {
				matches!(
					event,
					ResponsesProjection::Completion(completion)
						if completion.reason == FinishReason::Stop
				)
			})
			.expect("completion");
		assert!(text < usage && usage < complete);
	}

	#[test]
	fn custom_tool_input_remains_freeform_and_unvalidated() {
		let mut decoder = OpenAiResponsesDecoder::default();
		let mut events = decoder.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"custom_tool_call","id":"ct_1","call_id":"call_1","name":"shell","input":""}}"#);
		events.extend(decoder.push_json(br#"{"type":"response.custom_tool_call_input.delta","output_index":0,"item_id":"ct_1","delta":"cat README.md"}"#));
		events.extend(decoder.push_json(br#"{"type":"response.output_item.done","output_index":0,"item":{"type":"custom_tool_call","id":"ct_1","call_id":"call_1","name":"shell","input":"cat README.md"}}"#));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::ToolCallComplete { name, arguments, custom: true, .. }
				if name == "shell" && arguments == b"cat README.md".as_slice()
		)));
		assert!(!events.iter().any(|event| matches!(
			event,
			ResponsesProjection::Canonical(ChatEvent::ToolCallReady { .. })
		)));
	}
	#[test]
	fn call_id_aliases_route_interleaved_parallel_tool_deltas() {
		let mut decoder = OpenAiResponsesDecoder::default();
		let mut events = decoder.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_a","name":"a","arguments":""}}"#);
		events.extend(decoder.push_json(br#"{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_b","name":"b","arguments":""}}"#));
		events.extend(decoder.push_json(br#"{"type":"response.function_call_arguments.delta","item_id":"call_a","delta":"{\"a\":1"}"#));
		events.extend(decoder.push_json(br#"{"type":"response.function_call_arguments.delta","item_id":"fc_call_b","delta":"{\"b\":2"}"#));
		let routed = events
			.iter()
			.filter_map(|event| match event {
				ResponsesProjection::Canonical(ChatEvent::ToolArgumentsDelta { index, bytes }) => {
					Some((*index, bytes.clone()))
				},
				_ => None,
			})
			.collect::<Vec<_>>();
		assert_eq!(routed.len(), 2);
		assert_eq!(routed[0].0, 0);
		assert_eq!(routed[1].0, 1);
		let mut guarded = OpenAiResponsesDecoder::default();
		guarded.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg"}}"#);
		guarded.push_json(br#"{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"only_call","name":"tool","arguments":""}}"#);
		let events =
			guarded.push_json(br#"{"type":"response.function_call_arguments.delta","delta":"{}"}"#);
		assert!(events.iter().any(|event| {
			matches!(
				event,
				ResponsesProjection::Canonical(ChatEvent::ToolArgumentsDelta { index: 1, .. })
			)
		}));
	}

	#[test]
	fn authoritative_done_emits_unseen_suffix_and_rejects_divergence() {
		let mut decoder = OpenAiResponsesDecoder::default();
		let mut events = decoder.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}"#);
		events
			.extend(decoder.push_json(
				br#"{"type":"response.output_text.delta","item_id":"msg_1","delta":"hel"}"#,
			));
		events
			.extend(decoder.push_json(
				br#"{"type":"response.output_text.done","item_id":"msg_1","text":"hello"}"#,
			));
		let text = events
			.iter()
			.filter_map(|event| match event {
				ResponsesProjection::Canonical(ChatEvent::TextDelta { text, .. }) => {
					Some(text.as_str())
				},
				_ => None,
			})
			.collect::<Vec<_>>();
		assert_eq!(text, ["hel", "lo"]);
		let mut item_done = OpenAiResponsesDecoder::default();
		item_done.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_item"}}"#);
		item_done
			.push_json(br#"{"type":"response.output_text.delta","item_id":"msg_item","delta":"hel"}"#);
		let events = item_done.push_json(br#"{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_item","content":[{"type":"output_text","text":"hello"}]}}"#);
		assert!(events.iter().any(|event| {
			matches!(
				event,
				ResponsesProjection::Canonical(ChatEvent::TextDelta { text, .. })
					if text == "lo"
			)
		}));

		let mut divergent = OpenAiResponsesDecoder::default();
		divergent.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_2"}}"#);
		divergent
			.push_json(br#"{"type":"response.output_text.delta","item_id":"msg_2","delta":"hel"}"#);
		let events = divergent
			.push_json(br#"{"type":"response.output_text.done","item_id":"msg_2","text":"goodbye"}"#);
		assert!(events.iter().any(|event| {
			matches!(event, ResponsesProjection::Error(error) if error.code.as_deref() == Some("authoritative_output_diverged"))
		}));
	}

	#[test]
	fn preserves_leaked_tags_as_visible_text_for_recovery() {
		let mut decoder = OpenAiResponsesDecoder::default();
		let mut events = decoder.push_json(br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}"#);
		events.extend(decoder.push_json(br#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"<think>leaked</think>answer"}"#));
		assert!(events.iter().any(|event| matches!(
			event,
			ResponsesProjection::Canonical(ChatEvent::TextDelta { text, .. })
				if text == "<think>leaked</think>answer"
		)));
	}

	#[test]
	fn continuation_recovery_requires_exact_typed_evidence() {
		let stale = classify_continuation_error(
			400,
			br#"{"error":{"code":"previous_response_not_found","message":"Previous response expired."}}"#,
		);
		assert_eq!(stale.continuation, ResponsesContinuationFailure::StalePreviousResponse);
		let orphan = classify_continuation_error(
			404,
			br#"{"error":{"type":"invalid_request_error","message":"Item with id 'fc_server_stale' not found."}}"#,
		);
		assert_eq!(orphan.continuation, ResponsesContinuationFailure::StaleServerItem);
		let unrelated = classify_continuation_error(
			400,
			br#"{"error":{"code":"invalid_request_error","message":"The request schema is invalid."}}"#,
		);
		assert_eq!(unrelated.continuation, ResponsesContinuationFailure::NotStale);
		let malformed = classify_continuation_error(400, b"{not-json previous response words only");
		assert_eq!(malformed.continuation, ResponsesContinuationFailure::Malformed);
	}

	#[test]
	fn continuation_anchor_is_published_only_after_response_completion() {
		let mut decoder = OpenAiResponsesDecoder::default();
		let created =
			decoder.push_json(br#"{"type":"response.created","response":{"id":"resp_in_progress"}}"#);
		assert!(
			!created
				.iter()
				.any(|event| matches!(event, ResponsesProjection::Continuation { .. }))
		);
		let completed = decoder.push_json(
			br#"{"type":"response.completed","response":{"id":"resp_complete","status":"completed"}}"#,
		);
		assert!(completed.iter().any(|event| matches!(
			event,
			ResponsesProjection::Continuation { response_id, .. }
				if response_id.as_str() == "resp_complete"
		)));
	}

	#[test]
	fn malformed_and_post_terminal_frames_are_bounded() {
		let mut decoder = OpenAiResponsesDecoder::default();
		let malformed = decoder.push_json(b"{");
		assert!(matches!(malformed.as_slice(), [ResponsesProjection::Error(_)]));
		assert!(
			decoder
				.push_json(br#"{"type":"response.created","response":{"id":"late"}}"#)
				.is_empty()
		);
		assert!(decoder.finish().is_empty());
	}

	const CODEX_DENIAL: &str = "The 'gpt-daybreak-blue-latest' model is not supported when using \
	                            Codex with a ChatGPT account. (code=invalid_request_error)";

	#[test]
	fn codex_chatgpt_model_denial_matches_only_the_exact_sentence() {
		use super::codex_chatgpt_account_policy_model as model_of;
		assert_eq!(model_of(CODEX_DENIAL), Some("gpt-daybreak-blue-latest"));
		// Double quotes and case-insensitive sentence also match.
		assert_eq!(
			model_of(
				"the \"GPT-Daybreak-Blue-Latest\" MODEL IS NOT SUPPORTED WHEN USING CODEX WITH A \
				 CHATGPT ACCOUNT."
			),
			Some("GPT-Daybreak-Blue-Latest")
		);
		// Near misses never match: missing period, different sentence, unquoted
		// model, model spanning lines, or an embedded word boundary violation.
		assert_eq!(
			model_of(
				"The 'gpt-daybreak-blue-latest' model is not supported when using Codex with a \
				 ChatGPT account"
			),
			None
		);
		assert_eq!(
			model_of(
				"The gpt-daybreak model is not supported when using Codex with a ChatGPT account."
			),
			None
		);
		assert_eq!(
			model_of("The '' model is not supported when using Codex with a ChatGPT account."),
			None
		);
		assert_eq!(
			model_of("The 'a\nb' model is not supported when using Codex with a ChatGPT account."),
			None
		);
		assert_eq!(
			model_of("Breathe 'x' model is not supported when using Codex with a ChatGPT account."),
			None
		);
	}

	#[test]
	fn codex_model_denial_rotates_only_for_the_requested_model_on_codex() {
		use super::is_codex_chatgpt_account_policy_denial as denial;
		// Exact provider and model identity: rotation fires.
		assert!(denial("openai-codex", Some("gpt-daybreak-blue-latest"), CODEX_DENIAL));
		// Provider-prefixed and case-shifted requested ids normalize to the same
		// bare identity.
		assert!(denial("openai-codex", Some("openai-codex/GPT-Daybreak-Blue-Latest"), CODEX_DENIAL));
		// A denial naming some other model must not burn sibling credentials.
		assert!(!denial("openai-codex", Some("gpt-5.3-codex"), CODEX_DENIAL));
		// Non-Codex providers never rotate on this provider-controlled sentence.
		assert!(!denial("openai", Some("gpt-daybreak-blue-latest"), CODEX_DENIAL));
		// Absent or unbounded requested identity never matches.
		assert!(!denial("openai-codex", None, CODEX_DENIAL));
		let oversized = "m".repeat(300);
		assert!(!denial("openai-codex", Some(oversized.as_str()), CODEX_DENIAL));
	}

	#[test]
	fn codex_model_denial_classifies_as_account_rotation() {
		use crate::error::{ErrorKind, RetryAction};
		let adapter = ResponsesDecoderAdapter {
			inner: OpenAiResponsesDecoder::default(),
			request_id: RequestId::new("request"),
			provider: ProviderId::from("openai-codex"),
			route: RouteId::from("openai-codex/primary"),
			wire_model: Some(sf!("gpt-daybreak-blue-latest")),
			thinking_close_max_retries: None,
		};
		let denial = adapter.error_from_evidence(ResponsesErrorEvidence {
			code:         None,
			message:      Str::new(CODEX_DENIAL),
			continuation: ResponsesContinuationFailure::NotStale,
		});
		assert_eq!(denial.kind, ErrorKind::Authorization);
		assert_eq!(denial.action, RetryAction::RotateAccount);
		assert_eq!(denial.code.as_deref(), Some("codex_chatgpt_account_model_policy"));
		assert!(!denial.committed);

		// The identical sentence naming another model stays a plain provider
		// error with no rotation.
		let unrelated = adapter.error_from_evidence(ResponsesErrorEvidence {
			code:         None,
			message:      sf!(
				"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
			),
			continuation: ResponsesContinuationFailure::NotStale,
		});
		assert_eq!(unrelated.kind, ErrorKind::Protocol);
		assert_eq!(unrelated.action, RetryAction::Never);
	}
	#[test]
	fn streamed_error_codes_preserve_precommit_retry_policy() {
		use crate::error::{ErrorKind, RetryAction};
		for (code, kind, action) in [
			("authentication_error", ErrorKind::Authentication, RetryAction::RefreshCredential),
			("permission_denied", ErrorKind::Authorization, RetryAction::RotateAccount),
			("rate_limit_exceeded", ErrorKind::RateLimited, RetryAction::SameRoute {
				after: Duration::from_secs(30),
			}),
			("server_error", ErrorKind::ResourceExhausted, RetryAction::SameRoute {
				after: Duration::from_millis(500),
			}),
			("context_length_exceeded", ErrorKind::ContextOverflow, RetryAction::Never),
			("invalid_request_error", ErrorKind::InvalidRequest, RetryAction::Never),
		] {
			let (actual_kind, actual_action) =
				super::classify_responses_provider_error(Some(code), "provider failure", false);
			assert_eq!(actual_kind, kind, "{code}");
			assert_eq!(actual_action, action, "{code}");
		}
		let (_, action) = super::classify_responses_provider_error(
			Some("rate_limit_exceeded"),
			"provider failure",
			true,
		);
		assert_eq!(action, RetryAction::Never);
	}

	#[test]
	fn premature_close_retries_only_before_any_delta_commits() {
		use crate::error::{ErrorKind, RetryAction};

		let mut adapter = ResponsesDecoderAdapter {
			inner: OpenAiResponsesDecoder::default(),
			request_id: RequestId::new("request"),
			provider: ProviderId::from("github-copilot"),
			route: RouteId::from("github-copilot/responses"),
			wire_model: Some(sf!("grok-4.6")),
			thinking_close_max_retries: Some(1),
		};
		adapter.inner.push_json(
			br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}"#,
		);
		adapter.inner.push_json(
			br#"{"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_1","summary_index":0,"delta":"thinking"}"#,
		);
		let error = adapter.error_from_evidence(ResponsesErrorEvidence {
			code:         Some(sf!("premature_end")),
			message:      sf!("Responses stream ended before an authoritative terminal event"),
			continuation: ResponsesContinuationFailure::NotStale,
		});
		assert_eq!(error.kind, ErrorKind::Protocol);
		assert_eq!(error.action, RetryAction::Never);
		assert!(error.committed);

		let mut empty = ResponsesDecoderAdapter {
			inner: OpenAiResponsesDecoder::default(),
			request_id: RequestId::new("request"),
			provider: ProviderId::from("openai"),
			route: RouteId::from("openai/responses"),
			wire_model: Some(sf!("gpt")),
			thinking_close_max_retries: None,
		};
		empty.inner.push_json(
			br#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1"}}"#,
		);
		let error = empty.error_from_evidence(ResponsesErrorEvidence {
			code:         Some(sf!("premature_end")),
			message:      sf!("Responses stream ended before an authoritative terminal event"),
			continuation: ResponsesContinuationFailure::NotStale,
		});
		assert_eq!(error.action, RetryAction::SameRouteLimited {
			after:       Duration::ZERO,
			max_retries: 1,
		});
		assert!(!error.committed);
	}

	#[test]
	fn bare_error_envelope_preserves_code_and_message_for_classification() {
		// Non-2xx bodies arrive as `{"error":{…}}` without a stream event type;
		// the denial message must survive into the error evidence.
		let mut decoder = OpenAiResponsesDecoder::default();
		let events = decoder.push_json(
			format!(r#"{{"error":{{"type":"invalid_request_error","message":"{CODEX_DENIAL}"}}}}"#)
				.replace("(code=invalid_request_error)", "")
				.as_bytes(),
		);
		match events.as_slice() {
			[ResponsesProjection::Error(evidence)] => {
				assert_eq!(evidence.continuation, ResponsesContinuationFailure::NotStale);
				assert_eq!(evidence.code.as_deref(), Some("invalid_request_error"));
				assert!(
					evidence
						.message
						.contains("model is not supported when using Codex")
				);
			},
			other => panic!("expected error evidence, got {other:?}"),
		}
	}

	fn history_request(messages: Vec<Message>) -> ChatRequest {
		ChatRequest {
			messages:          Arc::from(messages),
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

	fn read_call(id: &str, path: &str) -> ContentPart {
		ContentPart::ToolCall {
			call:      ToolCallId::new(id),
			name:      sf!("read"),
			arguments: OpaqueJson::new(serde_json::json!({ "path": path })),
			proof:     None,
		}
	}

	fn read_results(pairs: &[(&str, &str)]) -> Message {
		Message {
			role:    Role::Tool,
			content: pairs
				.iter()
				.map(|(id, output)| ContentPart::ToolResult {
					call:     ToolCallId::new(*id),
					name:     Some(sf!("read")),
					content:  Arc::from([ToolResultContent::Text(Str::new(*output))]),
					is_error: false,
				})
				.collect(),
			name:    None,
		}
	}

	fn input_item_kinds(input: &[ResponsesInputItem]) -> Vec<&'static str> {
		input
			.iter()
			.map(|item| match item.kind {
				Some(ResponsesInputItemKind::FunctionCall) => "function_call",
				Some(ResponsesInputItemKind::FunctionCallOutput) => "function_call_output",
				Some(_) => "other",
				None => match item.role {
					Some(ResponsesRole::Assistant) => "message:assistant",
					Some(ResponsesRole::User) => "message:user",
					_ => "message",
				},
			})
			.collect()
	}

	#[test]
	fn hoists_trailing_assistant_text_before_its_tool_call_batch() {
		// Console Go (opencode-go) 400s with "No tool output found for tool
		// call …" when an assistant message sits between a function_call
		// batch and its function_call_output items; the model streamed
		// [3 tool calls, trailing demoted-thinking text] and the block-encode
		// path preserves stream order. See #8789.
		let trailing = "<think>\n</thinking\n</think>";
		let request = history_request(vec![
			Message {
				role:    Role::Assistant,
				content: Arc::from([
					read_call("call_a", "a"),
					read_call("call_b", "b"),
					read_call("call_c", "c"),
					ContentPart::Text { text: Str::new(trailing), proof: None },
				]),
				name:    None,
			},
			read_results(&[("call_a", "out a"), ("call_b", "out b"), ("call_c", "out c")]),
			Message {
				role:    Role::User,
				content: Arc::from([ContentPart::Text { text: sf!("continue"), proof: None }]),
				name:    None,
			},
		]);
		let policy = policy::WirePolicy::baseline();
		let encoded = encode_with_policy(&policy, |_, _| request);
		// Canonical message(s) → calls → outputs, byte-exact on the wire.
		assert_eq!(
			serde_json::to_string(&encoded.request.input).expect("input serializes"),
			r#"[{"role":"assistant","content":[{"type":"input_text","text":"<think>\n</thinking\n</think>"}]},{"type":"function_call","name":"read","call_id":"call_a","arguments":"{\"path\":\"a\"}"},{"type":"function_call","name":"read","call_id":"call_b","arguments":"{\"path\":\"b\"}"},{"type":"function_call","name":"read","call_id":"call_c","arguments":"{\"path\":\"c\"}"},{"type":"function_call_output","call_id":"call_a","output":"out a"},{"type":"function_call_output","call_id":"call_b","output":"out b"},{"type":"function_call_output","call_id":"call_c","output":"out c"},{"role":"user","content":[{"type":"input_text","text":"continue"}]}]"#,
		);
		// Hoisting is idempotent: a second pass changes nothing.
		let mut again = encoded.request.input.clone();
		hoist_interleaved_tool_batch_messages(&mut again);
		assert_eq!(again, encoded.request.input);
	}

	#[test]
	fn already_canonical_message_calls_outputs_turn_is_unchanged() {
		let request = history_request(vec![
			Message {
				role:    Role::Assistant,
				content: Arc::from([
					ContentPart::Text { text: sf!("calling read on two files"), proof: None },
					read_call("call_a", "a"),
					read_call("call_b", "b"),
				]),
				name:    None,
			},
			read_results(&[("call_a", "out a"), ("call_b", "out b")]),
		]);
		let policy = policy::WirePolicy::baseline();
		let encoded = encode_with_policy(&policy, |_, _| request);
		assert_eq!(
			serde_json::to_string(&encoded.request.input).expect("input serializes"),
			r#"[{"role":"assistant","content":[{"type":"input_text","text":"calling read on two files"}]},{"type":"function_call","name":"read","call_id":"call_a","arguments":"{\"path\":\"a\"}"},{"type":"function_call","name":"read","call_id":"call_b","arguments":"{\"path\":\"b\"}"},{"type":"function_call_output","call_id":"call_a","output":"out a"},{"type":"function_call_output","call_id":"call_b","output":"out b"}]"#,
		);
	}
	#[test]
	fn custom_tool_replay_extracts_the_canonical_freeform_input() {
		let text = "*** Begin Patch\n*** End Patch";
		let policy = policy::WirePolicy::baseline();
		let encoded = encode_with_policy(&policy, |route, target| {
			let proof = |call_id: &str| ProviderProof {
				provider: route.provider.clone(),
				codec:    target.codec.clone(),
				value:    encode_provider_proof(&ResponsesProviderProof {
					call_id: Some(Str::new(call_id)),
					custom_tool: true,
					..ResponsesProviderProof::default()
				})
				.expect("proof encodes"),
			};
			history_request(vec![Message {
				role:    Role::Assistant,
				content: Arc::from([
					ContentPart::ToolCall {
						call:      ToolCallId::new("call_edit"),
						name:      sf!("edit"),
						arguments: OpaqueJson::new(serde_json::json!({ "input": text })),
						proof:     Some(proof("call_edit")),
					},
					ContentPart::ToolCall {
						call:      ToolCallId::new("call_legacy"),
						name:      sf!("edit"),
						arguments: OpaqueJson::new(serde_json::json!({"legacy": true})),
						proof:     Some(proof("call_legacy")),
					},
				]),
				name:    None,
			}])
		});
		let custom = encoded
			.request
			.input
			.iter()
			.filter(|item| matches!(item.kind, Some(ResponsesInputItemKind::CustomToolCall)))
			.collect::<Vec<_>>();
		let [canonical, legacy] = custom.as_slice() else {
			panic!("both replayed calls stay custom: {:?}", encoded.request.input);
		};
		// Canonical `{"input": text}` arguments replay as the raw freeform text.
		assert_eq!(canonical.input.as_deref(), Some(text));
		assert!(canonical.arguments.is_none());
		// History recorded without the property replays the serialized object.
		assert_eq!(legacy.input.as_deref(), Some(r#"{"legacy":true}"#));
	}

	#[test]
	fn hoists_demoted_thinking_turn_text_ahead_of_calls() {
		// deepseek-v4-flash on opencode-go streamed [thinking, 2 tool calls,
		// trailing "</thinking" text]; the proofless reasoning drops out of
		// the replay and the demoted text must not wedge between the calls
		// and their outputs.
		let request = history_request(vec![
			Message {
				role:    Role::Assistant,
				content: Arc::from([
					ContentPart::Reasoning { text: sf!("planning"), proof: None },
					read_call("call_a", "a"),
					read_call("call_b", "b"),
					ContentPart::Text { text: sf!("<think>\n</thinking\n</think>"), proof: None },
				]),
				name:    None,
			},
			read_results(&[("call_a", "out a"), ("call_b", "out b")]),
		]);
		let policy = policy::WirePolicy::baseline();
		let encoded = encode_with_policy(&policy, |_, _| request);
		assert_eq!(input_item_kinds(&encoded.request.input), vec![
			"message:assistant",
			"function_call",
			"function_call",
			"function_call_output",
			"function_call_output",
		]);
		// The demoted-thinking text is preserved verbatim as the hoisted
		// message.
		let hoisted = serde_json::to_string(&encoded.request.input[0]).expect("message serializes");
		assert!(hoisted.contains("</thinking"), "hoisted message keeps text: {hoisted}");
	}
}
