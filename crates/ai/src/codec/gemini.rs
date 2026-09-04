//! Typed Google `GenerateContent` and Vertex request/response projection.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt, str,
	sync::Arc,
	time,
};

use bytes::Bytes;
use omp_catalog::{
	CodecId, OperationKind, ProviderId, ReasoningEffort, ThinkingEffort, ThinkingMode,
	ThinkingPolicy, ThinkingSelection,
};
use omp_core::{IntoStr, Str, encoding::base64, sf};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use strum::IntoStaticStr;

use crate::{
	answer::{AnswerBody, Embedding, EmbeddingBatch, TokenCount, TokenizerProvenance},
	auth::AuthScheme,
	body::BodySource,
	call::{
		ChatRequest, ContentPart, CountTokensRequest, EmbedRequest, EmbeddingInput, HostedTool,
		MediaInput, Message, OpaqueJson, OperationCall, ProviderProof, ReasoningRequest,
		ReasoningVisibility, Role, SafetySetting, SafetyThreshold, Sampling, Setting,
		StructuredOutput, ToolChoice, ToolDefinition, ToolResultContent, TruncationPolicy,
	},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
		ProviderMetadataEvent, ProviderStateEvent, RawCompletion, RawEvent, RequestHeader,
		RequestMethod, SizeBounds, ToolInputKind, UnvalidatedToolCall,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{Adjustment, ExecutionReceipt, FeatureId, ReasonId, Usage, UsageSource},
	recovery::thinking::ThinkingFenceStripper,
	transport::{Frame, FramingProtocol},
};

/// Public Generative Language API root used when catalog data does not override
/// it.
pub const GENERATIVE_LANGUAGE_BASE: &str = "https://generativelanguage.googleapis.com";
/// Public Generative Language streaming path suffix.
pub const GENERATIVE_LANGUAGE_STREAM_PATH: &str = ":streamGenerateContent?alt=sse";
const SKIP_THOUGHT_SIGNATURE: &str = "skip_thought_signature_validator";
/// Adjustment feature recorded when a resumed conversation carries a
/// continuation proof issued by a different provider or codec.
const FOREIGN_SIGNATURE_FEATURE: &str = "reasoning.signature";
/// Stable reason attached to [`FOREIGN_SIGNATURE_FEATURE`].
const FOREIGN_SIGNATURE_REASON: &str = "signature.foreign-scope";
const NON_VISION_IMAGE_PLACEHOLDER: &str = "[image omitted: model does not support vision]";
const TOOL_RESULT_IMAGE_LABEL: &str = "Tool result image:";
const TOOL_RESULT_IMAGE_REFERENCE: &str = "(see attached image)";

/// `GenerateContent` endpoint behavior that affects the JSON body.
#[derive(Clone, Copy, Debug, Default, Eq, IntoStaticStr, PartialEq)]
pub enum GoogleEndpointKind {
	/// Public Generative Language endpoint, which preserves function-part IDs.
	#[default]
	#[strum(serialize = "v1beta")]
	GenerativeLanguage,
	/// Vertex endpoint, which rejects function-part IDs and therefore strips
	/// them.
	#[strum(serialize = "v1")]
	Vertex,
	/// Cloud Code Assist endpoint, which preserves IDs and uses legacy schema
	/// keys.
	#[strum(serialize = "v1internal")]
	CloudCodeAssist,
}

#[derive(Clone, Copy)]
enum GoogleSchemaKey {
	Parameters,
	ParametersJsonSchema,
}

/// Provider and codec identity against which continuation proofs are checked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoogleProofScope {
	/// Selected provider identity.
	pub provider: ProviderId,
	/// Selected codec identity.
	pub codec:    CodecId,
}

/// Whether tool descriptors are moved into deterministic system guidance.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum InlineToolDescriptorsMode {
	/// Enable only for Gemini-equivalent guidance. This codec is
	/// Gemini-equivalent.
	#[default]
	Auto,
	/// Always inline descriptors.
	On,
	/// Keep descriptions and schemas in native declarations.
	Off,
}

impl InlineToolDescriptorsMode {
	const fn enabled_for_gemini(self) -> bool {
		!matches!(self, Self::Off)
	}
}

/// A provider-scoped request option supplied explicitly by planning or the
/// caller.
#[derive(Clone, Debug, Default)]
pub struct GoogleRequestOptions {
	/// Existing Google cached-content resource name.
	pub cached_content: Option<Str>,
	/// Explicit safety policy. An empty list means no safetySettings field.
	pub safety_settings: Vec<GoogleSafetySetting>,
	/// Explicit output modalities.
	pub response_modalities: Vec<Str>,
	/// Whether the Google Search hosted tool is enabled.
	pub google_search: bool,
	/// Whether the code-execution hosted tool is enabled.
	pub code_execution: bool,
	/// Selected wire identity required whenever historical continuation proofs
	/// are present.
	pub proof_scope: Option<GoogleProofScope>,
	/// Whether assistant reasoning without a continuation proof is omitted from
	/// the wire request instead of sent as an unsigned thought part.
	pub drop_unsigned_reasoning: bool,
	/// Whether function calls and results carry their canonical call ID.
	pub supports_function_part_id: Option<bool>,
	/// Whether every unsigned historical function call carries Google's
	/// validation bypass sentinel.
	pub requires_skip_thought_signature: bool,
	/// Whether only the first function call of an assistant message carries the
	/// bypass sentinel when it is unsigned; later unsigned calls stay bare.
	pub requires_skip_thought_signature_on_first_function_call: bool,
	/// Whether tool-result media is nested in `functionResponse.parts`.
	pub multimodal_function_response: Option<bool>,
	/// Whether image inputs are replaced by the non-vision placeholder.
	pub strip_image_input: bool,
	/// Whether function declarations use CCA's legacy `parameters` key.
	pub cca_legacy_parameters_schema: Option<bool>,
	/// Legacy typed remote-file substitutions keyed by `(message index, part
	/// index)`.
	pub remote_files: BTreeMap<(usize, usize), GoogleFileData>,
	/// Inline descriptor optimization mode.
	pub inline_tool_descriptors: InlineToolDescriptorsMode,
}

/// One explicit Google harm-policy entry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSafetySetting {
	/// Google harm category.
	pub category:  Str,
	/// Google blocking threshold.
	pub threshold: Str,
}

impl From<&SafetySetting> for GoogleSafetySetting {
	fn from(value: &SafetySetting) -> Self {
		let threshold = match value.threshold {
			SafetyThreshold::Off => "OFF",
			SafetyThreshold::Low => "BLOCK_ONLY_HIGH",
			SafetyThreshold::Medium => "BLOCK_MEDIUM_AND_ABOVE",
			SafetyThreshold::High | SafetyThreshold::BlockMost => "BLOCK_LOW_AND_ABOVE",
		};
		Self { category: value.category.clone(), threshold: sf!(threshold) }
	}
}

/// A remote Google file reference used instead of inline bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleFileData {
	/// MIME type of the referenced object.
	pub mime_type: Str,
	/// Google-readable URI, such as a `gs://` object.
	pub file_uri:  Str,
}

/// Complete typed `GenerateContent` request body.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateContentRequest {
	/// Ordered conversation turns.
	pub contents:           Vec<GoogleContent>,
	/// Text-only system instruction.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub system_instruction: Option<GoogleSystemInstruction>,
	/// Function and hosted-tool declarations.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub tools:              Vec<GoogleTool>,
	/// Function-calling policy.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub tool_config:        Option<GoogleToolConfig>,
	/// Explicit safety policy; never synthesized by this codec.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub safety_settings:    Vec<GoogleSafetySetting>,
	/// Existing cached-content resource.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cached_content:     Option<Str>,
	/// Generation controls.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub generation_config:  Option<GoogleGenerationConfig>,
	/// Requested Google serving tier.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub service_tier:       Option<Str>,
}

/// One role-tagged `GenerateContent` content item.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleContent {
	/// Wire role (`user` or `model`).
	pub role:  Str,
	/// Ordered content parts.
	pub parts: Vec<GooglePart>,
}

/// Text-only system instruction body.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleSystemInstruction {
	/// Optional role used by Cloud Code Assist adapters.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub role:  Option<Str>,
	/// Ordered text parts.
	pub parts: Vec<GooglePart>,
}

/// `GenerateContent`'s heterogeneous part union.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GooglePart {
	/// Text or reasoning text.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub text:                  Option<Str>,
	/// Marks text as model reasoning.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub thought:               Option<bool>,
	/// Inline media.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub inline_data:           Option<GoogleInlineData>,
	/// Remote media.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub file_data:             Option<GoogleFileData>,
	/// Model function invocation.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub function_call:         Option<GoogleFunctionCall>,
	/// Opaque provider continuation proof.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub thought_signature:     Option<Str>,
	/// Function result supplied by the caller.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub function_response:     Option<GoogleFunctionResponse>,
	/// Provider code-execution input.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub executable_code:       Option<GoogleExecutableCode>,
	/// Provider code-execution output.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub code_execution_result: Option<GoogleCodeExecutionResult>,
}

/// Inline binary content represented as base64.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleInlineData {
	/// MIME type.
	pub mime_type: Str,
	/// Standard padded base64 payload.
	pub data:      Str,
}

/// One model-requested function invocation.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleFunctionCall {
	/// Provider function-call identity where the endpoint supports it.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub id:   Option<Str>,
	/// Declared function name.
	#[serde(default)]
	pub name: Str,
	/// Opaque JSON arguments.
	pub args: Box<RawValue>,
}

/// One caller-supplied function result.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleFunctionResponse {
	/// Provider function-call identity where the endpoint supports it.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub id:       Option<Str>,
	/// Declared function name.
	pub name:     Str,
	/// Opaque response object.
	pub response: Box<RawValue>,
	/// Optional media response parts.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub parts:    Vec<GooglePart>,
}

/// Provider-generated executable code part.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleExecutableCode {
	/// Language label.
	#[serde(default)]
	pub language: Option<Str>,
	/// Source text.
	pub code:     Str,
}

/// Provider-generated code execution result part.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleCodeExecutionResult {
	/// Outcome label.
	#[serde(default)]
	pub outcome: Option<Str>,
	/// Process output.
	pub output:  Str,
}

/// One `GenerateContent` tool group.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleTool {
	/// Caller-executable functions.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub function_declarations: Vec<GoogleFunctionDeclaration>,
	/// Enables provider-hosted search.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub google_search:         Option<GoogleEmptyObject>,
	/// Enables provider-hosted code execution.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub code_execution:        Option<GoogleEmptyObject>,
}

/// Empty JSON object marker used by hosted tools.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct GoogleEmptyObject {}

/// One typed function declaration.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleFunctionDeclaration {
	/// Function name.
	pub name:                   Str,
	/// Human-readable function purpose.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description:            Option<Str>,
	/// Modern `GenerateContent` JSON Schema key.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub parameters_json_schema: Option<GoogleSchema>,
	/// Legacy CCA JSON Schema key.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub parameters:             Option<GoogleSchema>,
}

/// Function calling configuration wrapper.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleToolConfig {
	/// Function calling mode and optional allowlist.
	pub function_calling_config: GoogleFunctionCallingConfig,
}

/// Google function calling mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GoogleFunctionCallingMode {
	/// Model decides whether to call functions.
	Auto,
	/// Model must not call functions.
	None,
	/// Model must call a function.
	Any,
	/// Antigravity validated function calling mode.
	Validated,
}

/// Function calling mode and optional named allowlist.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleFunctionCallingConfig {
	/// Function calling mode (`AUTO`, `NONE`, `ANY`, or `VALIDATED`).
	pub mode:                   GoogleFunctionCallingMode,
	/// Allowed function names for named forcing.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub allowed_function_names: Vec<Str>,
}

/// Typed generation controls with exact absence semantics.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleGenerationConfig {
	/// Temperature.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub temperature:          Option<f64>,
	/// Nucleus probability.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub top_p:                Option<f64>,
	/// Top-k candidate bound.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub top_k:                Option<u32>,
	/// Output-token bound.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub max_output_tokens:    Option<u64>,
	/// Stop strings.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub stop_sequences:       Vec<Str>,
	/// JSON response MIME type.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub response_mime_type:   Option<Str>,
	/// JSON Schema for structured output.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub response_json_schema: Option<GoogleSchema>,
	/// Output modality allowlist.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub response_modalities:  Vec<Str>,
	/// Provider reasoning controls.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub thinking_config:      Option<GoogleThinkingConfig>,
}

/// Google reasoning controls.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleThinkingConfig {
	/// Whether reasoning text or summary is included.
	pub include_thoughts: bool,
	/// Token budget for budget-mode models.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub thinking_budget:  Option<u64>,
	/// Level for level-mode models.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub thinking_level:   Option<Str>,
}

/// Explicit catalog-selected Google thinking wire policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoogleThinkingPolicy {
	/// Emit qualitative `thinkingLevel` values.
	Level,
	/// Emit `thinkingBudget` values, using the supplied effort budget table.
	Budget(GoogleThinkingBudgets),
}

/// Explicit effort-to-budget mapping supplied by catalog policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GoogleThinkingBudgets {
	/// Minimal effort budget.
	pub minimal: u64,
	/// Low effort budget.
	pub low:     u64,
	/// Medium effort budget.
	pub medium:  u64,
	/// High effort budget.
	pub high:    u64,
	/// Extra-high effort budget.
	pub xhigh:   u64,
	/// Maximum effort budget.
	pub maximum: u64,
}

/// JSON Schema subset understood by Google, retaining extension keywords
/// opaquely.
#[derive(Clone, Debug, Default, Serialize)]
pub struct GoogleSchema {
	/// Schema type or nullable type union.
	#[serde(rename = "type", skip_serializing_if = "Option::is_none")]
	pub schema_type:           Option<GoogleSchemaType>,
	/// Google nullable marker.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub nullable:              Option<bool>,
	/// Object properties, preserving declaration order.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub properties:            Option<BTreeMap<String, Self>>,
	/// Required property names.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub required:              Vec<Str>,
	/// Array item schema.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub items:                 Option<Box<Self>>,
	/// Opaque enum members.
	#[serde(rename = "enum", default, skip_serializing_if = "Vec::is_empty")]
	pub enum_values:           Vec<Box<RawValue>>,
	/// Human-readable description.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub description:           Option<Str>,
	/// Draft marker removed by the CCA adapter.
	#[serde(rename = "$schema", skip_serializing_if = "Option::is_none")]
	pub draft:                 Option<Str>,
	/// Annotation removed by the CCA adapter.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub title:                 Option<Str>,
	/// Constraint removed by the CCA adapter.
	#[serde(rename = "additionalProperties", skip_serializing_if = "Option::is_none")]
	pub additional_properties: Option<Box<RawValue>>,
	/// Constraint removed by the CCA adapter.
	#[serde(rename = "patternProperties", skip_serializing_if = "Option::is_none")]
	pub pattern_properties:    Option<Box<RawValue>>,
	/// Constraint removed by the CCA adapter.
	#[serde(rename = "propertyNames", skip_serializing_if = "Option::is_none")]
	pub property_names:        Option<Box<RawValue>>,
	/// Vendor or future JSON Schema extensions retained without interpretation.
	#[serde(flatten)]
	pub extensions:            BTreeMap<String, Box<RawValue>>,
}

impl<'de> Deserialize<'de> for GoogleSchema {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		struct GoogleSchemaVisitor;

		impl<'de> serde::de::Visitor<'de> for GoogleSchemaVisitor {
			type Value = GoogleSchema;

			fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str("a JSON Schema object")
			}

			fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
			where
				A: serde::de::MapAccess<'de>,
			{
				let mut schema = GoogleSchema::default();
				while let Some(key) = map.next_key::<String>()? {
					match key.as_str() {
						"type" => schema.schema_type = map.next_value()?,
						"nullable" => schema.nullable = map.next_value()?,
						"properties" => schema.properties = map.next_value()?,
						"required" => {
							schema.required = map.next_value::<Option<Vec<Str>>>()?.unwrap_or_default();
						},
						"items" => schema.items = map.next_value()?,
						"enum" => {
							schema.enum_values = map
								.next_value::<Option<Vec<Box<RawValue>>>>()?
								.unwrap_or_default();
						},
						"description" => schema.description = map.next_value()?,
						"$schema" => schema.draft = map.next_value()?,
						"title" => schema.title = map.next_value()?,
						"additionalProperties" => schema.additional_properties = map.next_value()?,
						"patternProperties" => schema.pattern_properties = map.next_value()?,
						"propertyNames" => schema.property_names = map.next_value()?,
						_ => {
							schema.extensions.insert(key, map.next_value()?);
						},
					}
				}
				Ok(schema)
			}
		}

		deserializer.deserialize_map(GoogleSchemaVisitor)
	}
}

/// Single JSON Schema type or a nullable type union.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum GoogleSchemaType {
	/// One type.
	Single(Str),
	/// A type union.
	Multiple(Vec<Str>),
}

impl GoogleSchema {
	/// Parses and recursively normalizes an opaque schema for `GenerateContent`.
	pub fn from_opaque(value: &OpaqueJson) -> Result<Self, GoogleCodecError> {
		let raw = serde_json::value::to_raw_value(value.0.as_ref())
			.map_err(|error| GoogleCodecError::encoding(format!("invalid JSON Schema: {error}")))?;
		let mut schema: Self = serde_json::from_str(raw.get())
			.map_err(|error| GoogleCodecError::encoding(format!("invalid JSON Schema: {error}")))?;
		schema.normalize();
		Ok(schema)
	}

	/// Applies Google's wire-safe schema normalization recursively.
	pub fn normalize(&mut self) {
		for key in ["deprecated", "readOnly", "writeOnly", "$comment", "x-mcp-header"] {
			self.extensions.remove(key);
		}
		let nullable_type = match &self.schema_type {
			Some(GoogleSchemaType::Multiple(types)) => {
				let mut non_null = types.iter().filter(|kind| kind.as_str() != "null");
				match (non_null.next(), non_null.next()) {
					(Some(kind), None) if types.iter().any(|kind| kind.as_str() == "null") => {
						Some(kind.clone())
					},
					_ => None,
				}
			},
			_ => None,
		};
		if let Some(kind) = nullable_type {
			self.schema_type = Some(GoogleSchemaType::Single(kind));
			self.nullable = Some(true);
		}
		if self.schema_type.is_none() {
			self.schema_type = self
				.enum_values
				.first()
				.and_then(|value| infer_json_scalar(value.get()))
				.map(|kind| GoogleSchemaType::Single(Str::new(kind)));
		}
		if matches!(
			&self.schema_type,
			Some(GoogleSchemaType::Single(kind)) if kind.as_str() == "object"
		) && self.properties.is_none()
		{
			self.properties = Some(BTreeMap::new());
		}
		if let Some(properties) = &mut self.properties {
			for child in properties.values_mut() {
				child.normalize();
			}
		}
		if let Some(items) = &mut self.items {
			items.normalize();
		}
	}

	/// Removes the schema keywords rejected specifically by Cloud Code Assist
	/// recursively, after applying the shared Google wire normalization.
	pub fn normalize_for_cca(&mut self) {
		self.normalize();
		self.draft = None;
		self.title = None;
		self.additional_properties = None;
		self.pattern_properties = None;
		self.property_names = None;
		if let Some(properties) = &mut self.properties {
			for child in properties.values_mut() {
				child.normalize_for_cca();
			}
		}
		if let Some(items) = &mut self.items {
			items.normalize_for_cca();
		}
	}
}

fn infer_json_scalar(raw: &str) -> Option<&'static str> {
	let trimmed = raw.trim_start();
	match trimmed.as_bytes().first().copied() {
		Some(b'"') => Some("string"),
		Some(b't' | b'f') => Some("boolean"),
		Some(b'-' | b'0'..=b'9') => {
			if trimmed
				.bytes()
				.any(|byte| matches!(byte, b'.' | b'e' | b'E'))
			{
				Some("number")
			} else {
				Some("integer")
			}
		},
		_ => None,
	}
}

/// Typed adjustment emitted when optional canonical intent has no Google
/// projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoogleAdjustment {
	/// Canonical feature path.
	pub what:   Str,
	/// Stable explanation.
	pub detail: Str,
}

impl GoogleAdjustment {
	/// Creates an adjustment from dynamic strings.
	#[inline]
	pub fn new(what: impl IntoStr, detail: impl IntoStr) -> Self {
		Self { what: what.into_str(), detail: detail.into_str() }
	}

	/// Creates an adjustment from static strings.
	#[inline]
	pub const fn new_static(what: &'static str, detail: &'static str) -> Self {
		Self { what: sf!(what), detail: sf!(detail) }
	}
}

/// Successful Google request projection and its explicit adjustments.
#[derive(Clone, Debug)]
pub struct GoogleProjection {
	/// Typed request ready for direct serialization.
	pub request:     GenerateContentRequest,
	/// Explicitly dropped optional intent.
	pub adjustments: Vec<GoogleAdjustment>,
}

impl GoogleProjection {
	/// Returns the first adjustment that planning should have prevented.
	///
	/// A foreign continuation proof is a request-shape fact the codec resolves
	/// by omission, so it never signals a planning gap. A merely preferred
	/// grammar is exempt when `allow_preferred_grammar` is set.
	pub fn unplanned_adjustment(&self, allow_preferred_grammar: bool) -> Option<&GoogleAdjustment> {
		self.adjustments.iter().find(|adjustment| {
			adjustment.what != FOREIGN_SIGNATURE_FEATURE
				&& (adjustment.what != "response_format.grammar" || !allow_preferred_grammar)
		})
	}
}

fn canonical_google_adjustments(adjustments: &[GoogleAdjustment]) -> Vec<Adjustment> {
	adjustments
		.iter()
		.filter(|adjustment| adjustment.what == FOREIGN_SIGNATURE_FEATURE)
		.map(|_| Adjustment::Dropped {
			feature: FeatureId::new_static(FOREIGN_SIGNATURE_FEATURE),
			reason:  ReasonId::new_static(FOREIGN_SIGNATURE_REASON),
		})
		.collect()
}

/// Pure `GenerateContent` request projector.
#[derive(Clone, Copy, Debug)]
pub struct GeminiCodec {
	endpoint:        GoogleEndpointKind,
	thinking_policy: Option<GoogleThinkingPolicy>,
}

impl GeminiCodec {
	/// Creates a codec for public Generative Language.
	pub const fn generative_language(thinking_policy: Option<GoogleThinkingPolicy>) -> Self {
		Self { endpoint: GoogleEndpointKind::GenerativeLanguage, thinking_policy }
	}

	/// Creates a codec for Vertex `GenerateContent`.
	pub const fn vertex(thinking_policy: Option<GoogleThinkingPolicy>) -> Self {
		Self { endpoint: GoogleEndpointKind::Vertex, thinking_policy }
	}

	/// Creates a codec for Cloud Code Assist's embedded `GenerateContent` body.
	pub const fn cloud_code_assist(thinking_policy: Option<GoogleThinkingPolicy>) -> Self {
		Self { endpoint: GoogleEndpointKind::CloudCodeAssist, thinking_policy }
	}

	/// Projects one canonical chat request without performing I/O or auth.
	pub fn project(
		self,
		request: &ChatRequest,
		options: &GoogleRequestOptions,
	) -> Result<GoogleProjection, GoogleCodecError> {
		let mut output = GenerateContentRequest::default();
		let mut adjustments = Vec::new();
		let mut system_parts = Vec::new();
		let mut pending_tool_images = Vec::new();
		for (message_index, message) in request.messages.iter().enumerate() {
			self.project_message(
				message,
				message_index,
				options,
				&mut system_parts,
				&mut output.contents,
				&mut pending_tool_images,
				&mut adjustments,
			)?;
		}
		flush_tool_images(&mut output.contents, &mut pending_tool_images);
		if options.inline_tool_descriptors.enabled_for_gemini() && !request.tools.is_empty() {
			system_parts.push(GooglePart {
				text: Some(inline_tool_guidance(&request.tools)?),
				..GooglePart::default()
			});
		}
		if !system_parts.is_empty() {
			output.system_instruction =
				Some(GoogleSystemInstruction { role: None, parts: system_parts });
		}
		self.project_tools(request, options, &mut output, &mut adjustments)?;
		output.generation_config = self.project_generation(request, options, &mut adjustments)?;
		output.service_tier = match &request.service_tier {
			Setting::Unset => None,
			Setting::Require(tier) | Setting::Prefer(tier) => Some(tier.name.clone()),
		};
		output.safety_settings = if options.safety_settings.is_empty() {
			request
				.safety
				.iter()
				.map(GoogleSafetySetting::from)
				.collect()
		} else {
			options.safety_settings.clone()
		};
		if let Some(cached) = &options.cached_content {
			if cached.trim().is_empty() {
				return Err(GoogleCodecError::encoding("google/cached_content must not be blank"));
			}
			if output.system_instruction.is_some() {
				return Err(GoogleCodecError::encoding(
					"google/cached_content cannot be combined with request-level systemInstruction",
				));
			}
			if !output.tools.is_empty() {
				return Err(GoogleCodecError::encoding(
					"google/cached_content cannot be combined with request-level tools",
				));
			}
			output.cached_content = Some(cached.clone());
		}
		Ok(GoogleProjection { request: output, adjustments })
	}

	/// Projects using only the immutable plan's resolved thinking selection.
	pub(crate) fn project_for_encode(
		self,
		request: &ChatRequest,
		options: &GoogleRequestOptions,
		structural_policy: Option<&ThinkingPolicy>,
		selection: Option<&ThinkingSelection>,
	) -> Result<GoogleProjection, GoogleCodecError> {
		let reasoning_requested = !matches!(&request.reasoning, Setting::Unset);
		let Some(selection) = selection else {
			if reasoning_requested {
				return Err(GoogleCodecError::capability(
					"Google reasoning requires a thinking selection resolved by the execution plan",
				));
			}
			let mut codec = self;
			codec.thinking_policy = None;
			return codec.project(request, options);
		};
		let mode = structural_policy.map(|policy| policy.mode).ok_or_else(|| {
			GoogleCodecError::encoding(
				"Google thinking selection requires a structural thinking policy from the execution \
				 plan",
			)
		})?;
		let structural = match mode {
			ThinkingMode::GoogleLevel => GoogleThinkingPolicy::Level,
			ThinkingMode::Budget => GoogleThinkingPolicy::Budget(GoogleThinkingBudgets {
				minimal: 0,
				low:     0,
				medium:  0,
				high:    0,
				xhigh:   0,
				maximum: 0,
			}),
			_ => {
				return Err(GoogleCodecError::encoding(
					"execution plan selected a non-Google thinking mode for a Google codec",
				));
			},
		};
		let mut resolved_request = request.clone();
		match &mut resolved_request.reasoning {
			Setting::Require(reasoning) | Setting::Prefer(reasoning) => {
				reasoning.effort = None;
				reasoning.max_tokens = match structural {
					GoogleThinkingPolicy::Level => None,
					GoogleThinkingPolicy::Budget(_) => selection.budget,
				};
			},
			Setting::Unset => {},
		}
		let mut codec = self;
		codec.thinking_policy = Some(structural);
		let mut projection = codec.project(&resolved_request, options)?;
		let include_thoughts = match &request.reasoning {
			Setting::Require(reasoning) | Setting::Prefer(reasoning) => {
				!matches!(reasoning.visibility, ReasoningVisibility::Hidden)
					&& selection.effort != ThinkingEffort::Off
			},
			Setting::Unset => false,
		};
		let resolved = if selection.suppress_when_off && selection.effort == ThinkingEffort::Off {
			None
		} else {
			match structural {
				GoogleThinkingPolicy::Level => {
					// The catalog's native spelling override wins; otherwise
					// the canonical wire effort is spelled directly.
					// `wire_effort` already collapses `minimal` onto `low`
					// when a collapsed family aliases both onto the same
					// `-low` SKU — Cloud Code Assist rejects `MINIMAL` there
					let level = selection
						.native_effort
						.clone()
						.unwrap_or_else(|| selection_thinking_level(selection.wire_effort));
					Some(GoogleThinkingConfig {
						include_thoughts,
						thinking_budget: None,
						thinking_level: Some(level),
					})
				},
				GoogleThinkingPolicy::Budget(_) => Some(GoogleThinkingConfig {
					include_thoughts,
					thinking_budget: selection.budget,
					thinking_level: None,
				}),
			}
		};
		if let Some(generation) = &mut projection.request.generation_config {
			generation.thinking_config = resolved;
			if generation_config_is_empty(generation) {
				projection.request.generation_config = None;
			}
		} else if let Some(thinking_config) = resolved {
			projection.request.generation_config = Some(GoogleGenerationConfig {
				thinking_config: Some(thinking_config),
				..GoogleGenerationConfig::default()
			});
		}
		Ok(projection)
	}

	fn project_message(
		self,
		message: &Message,
		message_index: usize,
		options: &GoogleRequestOptions,
		system_parts: &mut Vec<GooglePart>,
		contents: &mut Vec<GoogleContent>,
		pending_tool_images: &mut Vec<GooglePart>,
		adjustments: &mut Vec<GoogleAdjustment>,
	) -> Result<(), GoogleCodecError> {
		if !matches!(message.role, Role::Tool) {
			flush_tool_images(contents, pending_tool_images);
		}
		if message.name.is_some() {
			adjustments.push(GoogleAdjustment::new_static(
				"thread.message.name",
				"Gemini GenerateContent does not expose portable author names",
			));
		}
		let is_system = matches!(message.role, Role::System | Role::Developer);
		let mut parts = Vec::new();
		let mut first_tool_call = true;
		for (part_index, part) in message.content.iter().enumerate() {
			if is_system {
				match part {
					ContentPart::Text { text, proof: None } => {
						if !text.is_empty() {
							parts.push(text_part(text.clone()));
						}
					},
					ContentPart::Text { proof: Some(_), .. } => {
						return Err(GoogleCodecError::encoding(
							"Google continuation proofs cannot be attached to systemInstruction text",
						));
					},
					_ => adjustments.push(GoogleAdjustment::new_static(
						"thread.system.parts",
						"Gemini systemInstruction accepts text parts only",
					)),
				}
				continue;
			}
			if matches!(part, ContentPart::CachePoint(_)) {
				adjustments.push(GoogleAdjustment::new_static(
					"cache",
					"a session key is not a Google cachedContent resource name",
				));
				continue;
			}
			if options.drop_unsigned_reasoning
				&& matches!(part, ContentPart::Reasoning { proof: None, .. })
			{
				continue;
			}
			if options.strip_image_input && matches!(part, ContentPart::Image(_)) {
				if !parts
					.iter()
					.any(|part| part.text.as_deref() == Some(NON_VISION_IMAGE_PLACEHOLDER))
				{
					parts.push(text_part(sf!(NON_VISION_IMAGE_PLACEHOLDER)));
				}
				continue;
			}
			if matches!(
				part,
				ContentPart::Image(MediaInput::Bytes { data, .. })
					| ContentPart::Audio(MediaInput::Bytes { data, .. })
					| ContentPart::Document(MediaInput::Bytes { data, .. })
					if data.is_empty()
			) && !options
				.remote_files
				.contains_key(&(message_index, part_index))
			{
				adjustments.push(GoogleAdjustment::new_static(
					"thread.parts.blob.inline",
					"Google inlineData requires payload bytes",
				));
				continue;
			}
			parts.push(self.project_part(
				part,
				message_index,
				part_index,
				options,
				&mut first_tool_call,
				adjustments,
			)?);
		}
		if parts.is_empty() {
			return Ok(());
		}
		if is_system {
			system_parts.extend(parts);
			return Ok(());
		}
		let role = if matches!(message.role, Role::Assistant) {
			"model"
		} else {
			"user"
		};
		let function_response = matches!(message.role, Role::Tool);
		if function_response && options.multimodal_function_response != Some(true) {
			let mut trailing = Vec::new();
			for part in &mut parts {
				if let Some(response) = &mut part.function_response {
					trailing.append(&mut response.parts);
				}
			}
			append_content(contents, Str::new(role), parts, true);
			pending_tool_images.extend(trailing);
		} else {
			append_content(contents, Str::new(role), parts, function_response);
		}
		Ok(())
	}

	fn project_part(
		self,
		part: &ContentPart,
		message_index: usize,
		part_index: usize,
		options: &GoogleRequestOptions,
		first_tool_call: &mut bool,
		adjustments: &mut Vec<GoogleAdjustment>,
	) -> Result<GooglePart, GoogleCodecError> {
		match part {
			ContentPart::Text { text, proof } => Ok(GooglePart {
				text: Some(text.clone()),
				thought_signature: proof_string(proof.as_ref(), options, adjustments)?,
				..GooglePart::default()
			}),
			ContentPart::Reasoning { text, proof } => Ok(GooglePart {
				text: Some(text.clone()),
				thought: Some(true),
				thought_signature: proof_string(proof.as_ref(), options, adjustments)?,
				..GooglePart::default()
			}),
			ContentPart::Image(media) | ContentPart::Audio(media) | ContentPart::Document(media) => {
				project_media(media, options.remote_files.get(&(message_index, part_index)))
			},
			ContentPart::ToolCall { call, name, arguments, proof } => {
				// The public API needs the bypass sentinel on every unsigned call; Cloud Code
				// Assist needs it only when the
				// first call of the message is itself unsigned.
				let requires_fallback = options.requires_skip_thought_signature
					|| (*first_tool_call
						&& options.requires_skip_thought_signature_on_first_function_call);
				*first_tool_call = false;
				let thought_signature = proof_string(proof.as_ref(), options, adjustments)?
					.or_else(|| requires_fallback.then(|| sf!(SKIP_THOUGHT_SIGNATURE)));
				Ok(GooglePart {
					function_call: Some(GoogleFunctionCall {
						id:   (options.supports_function_part_id == Some(true))
							.then(|| Str::new(call.as_str())),
						name: name.clone(),
						args: opaque_raw(arguments, "tool arguments")?,
					}),
					thought_signature,
					..GooglePart::default()
				})
			},
			ContentPart::ToolResult { call, name, content, is_error } => {
				let name = name.clone().ok_or_else(|| {
					GoogleCodecError::encoding(
						"Google functionResponse requires the original non-empty tool name",
					)
				})?;
				if name.is_empty() {
					return Err(GoogleCodecError::encoding(
						"Google functionResponse requires the original non-empty tool name",
					));
				}
				let (response, parts) =
					tool_response_raw(content, *is_error, options.strip_image_input)?;
				Ok(GooglePart {
					function_response: Some(GoogleFunctionResponse {
						id: (options.supports_function_part_id == Some(true))
							.then(|| Str::new(call.as_str())),
						name,
						response,
						parts,
					}),
					..GooglePart::default()
				})
			},
			ContentPart::CachePoint(_) => Err(GoogleCodecError::encoding(
				"Google cachedContent requires an explicit provider resource, not a canonical cache \
				 breakpoint",
			)),
		}
	}

	fn project_tools(
		self,
		request: &ChatRequest,
		options: &GoogleRequestOptions,
		output: &mut GenerateContentRequest,
		adjustments: &mut Vec<GoogleAdjustment>,
	) -> Result<(), GoogleCodecError> {
		if !request.tools.is_empty() {
			let mut declarations = Vec::with_capacity(request.tools.len());
			for tool in request.tools.iter() {
				if tool.input.grammar().is_some() {
					return Err(GoogleCodecError::capability(format!(
						"Gemini function declaration `{}` does not accept grammar-constrained tool input",
						tool.name,
					)));
				}
				let (parameters, strict) = tool.input.wire_schema();
				let mut schema = GoogleSchema::from_opaque(parameters)?;
				if matches!(self.endpoint, GoogleEndpointKind::CloudCodeAssist) {
					schema.normalize_for_cca();
				}
				if strict {
					adjustments.push(GoogleAdjustment::new(
						format!("tools.{}.strict", tool.name),
						sf!("Gemini function declarations do not expose a strict boolean"),
					));
				}
				let (parameters_json_schema, parameters, description) =
					if options.inline_tool_descriptors.enabled_for_gemini() {
						(None, None, None)
					} else {
						let key = if options.cca_legacy_parameters_schema == Some(true) {
							GoogleSchemaKey::Parameters
						} else {
							GoogleSchemaKey::ParametersJsonSchema
						};
						match key {
							GoogleSchemaKey::Parameters => (None, Some(schema), tool.description.clone()),
							GoogleSchemaKey::ParametersJsonSchema => {
								(Some(schema), None, tool.description.clone())
							},
						}
					};
				declarations.push(GoogleFunctionDeclaration {
					name: tool.name.clone(),
					description,
					parameters_json_schema,
					parameters,
				});
			}
			output
				.tools
				.push(GoogleTool { function_declarations: declarations, ..GoogleTool::default() });
		}
		for hosted in request.hosted_tools.iter() {
			match hosted {
				HostedTool::WebSearch { allowed_domains, blocked_domains, recency_days } => {
					if !allowed_domains.is_empty()
						|| !blocked_domains.is_empty()
						|| recency_days.is_some()
					{
						adjustments.push(GoogleAdjustment::new_static(
							"hosted_tools.web_search.filters",
							"Google Search does not expose portable domain or recency filters",
						));
					}
					output.tools.push(GoogleTool {
						google_search: Some(GoogleEmptyObject {}),
						..GoogleTool::default()
					});
				},
				HostedTool::CodeExecution => output.tools.push(GoogleTool {
					code_execution: Some(GoogleEmptyObject {}),
					..GoogleTool::default()
				}),
				HostedTool::Retrieval { .. } => adjustments.push(GoogleAdjustment::new_static(
					"hosted_tools.retrieval",
					"Gemini GenerateContent has no portable named-store retrieval projection",
				)),
			}
		}
		if options.google_search {
			output.tools.push(GoogleTool {
				google_search: Some(GoogleEmptyObject {}),
				..GoogleTool::default()
			});
		}
		if options.code_execution {
			output.tools.push(GoogleTool {
				code_execution: Some(GoogleEmptyObject {}),
				..GoogleTool::default()
			});
		}
		output.tool_config = project_tool_choice(&request.tool_choice, &request.tools)?;
		Ok(())
	}

	fn project_generation(
		self,
		request: &ChatRequest,
		options: &GoogleRequestOptions,
		adjustments: &mut Vec<GoogleAdjustment>,
	) -> Result<Option<GoogleGenerationConfig>, GoogleCodecError> {
		if !matches!(request.verbosity, Setting::Unset) {
			adjustments.push(GoogleAdjustment::new_static(
				"verbosity",
				"Gemini GenerateContent has no portable text verbosity control",
			));
		}
		if !matches!(request.cache_retention, Setting::Unset) {
			adjustments.push(GoogleAdjustment::new_static(
				"cache",
				"a cache retention request is not a Google cachedContent resource name",
			));
		}
		if request.top_logprobs.is_some() {
			adjustments.push(GoogleAdjustment::new_static(
				"top_logprobs",
				"Gemini GenerateContent has no portable token-logprob projection",
			));
		}
		let temperature = request
			.sampling
			.temperature
			.map(shortest_wire_f32)
			.transpose()?;
		let top_p = request.sampling.top_p.map(shortest_wire_f32).transpose()?;
		let mut generation = GoogleGenerationConfig {
			temperature,
			top_p,
			top_k: request.sampling.top_k,
			max_output_tokens: request.max_output_tokens,
			stop_sequences: request.sampling.stop.iter().cloned().collect(),
			response_modalities: options.response_modalities.clone(),
			..GoogleGenerationConfig::default()
		};
		for (present, what) in [
			(request.sampling.presence_penalty.is_some(), "sampling.presence_penalty"),
			(request.sampling.frequency_penalty.is_some(), "sampling.frequency_penalty"),
			(request.sampling.seed.is_some(), "sampling.seed"),
		] {
			if present {
				adjustments.push(GoogleAdjustment::new(
					what,
					sf!("control has no portable Google GenerateContent projection"),
				));
			}
		}
		match &request.output {
			Setting::Require(StructuredOutput::JsonObject)
			| Setting::Prefer(StructuredOutput::JsonObject) => {
				generation.response_mime_type = Some(sf!("application/json"));
			},
			Setting::Require(StructuredOutput::JsonSchema { schema, .. })
			| Setting::Prefer(StructuredOutput::JsonSchema { schema, .. }) => {
				generation.response_mime_type = Some(sf!("application/json"));
				generation.response_json_schema = Some(GoogleSchema::from_opaque(schema)?);
			},
			Setting::Require(_) => {
				return Err(GoogleCodecError::capability(
					"Gemini GenerateContent does not accept the required portable response format",
				));
			},
			Setting::Prefer(_) => adjustments.push(GoogleAdjustment::new_static(
				"response_format.grammar",
				"Gemini GenerateContent does not accept portable grammar response formats",
			)),
			Setting::Unset => {},
		}
		match &request.reasoning {
			Setting::Require(reasoning) | Setting::Prefer(reasoning) => {
				generation.thinking_config = Some(self.project_reasoning(reasoning)?);
			},
			Setting::Unset => {},
		}
		Ok((!generation_config_is_empty(&generation)).then_some(generation))
	}

	fn project_reasoning(
		self,
		reasoning: &ReasoningRequest,
	) -> Result<GoogleThinkingConfig, GoogleCodecError> {
		let include_thoughts = !matches!(reasoning.visibility, ReasoningVisibility::Hidden);
		let Some(policy) = self.thinking_policy else {
			return Err(GoogleCodecError::capability(
				"resolved model policy does not advertise native Google thinking",
			));
		};
		match policy {
			GoogleThinkingPolicy::Level => {
				if reasoning.max_tokens.is_some() {
					return Err(GoogleCodecError::capability(
						"Google level-mode models do not accept a token thinking budget",
					));
				}
				Ok(GoogleThinkingConfig {
					include_thoughts,
					thinking_budget: None,
					thinking_level: reasoning.effort.map(thinking_level),
				})
			},
			GoogleThinkingPolicy::Budget(budgets) => {
				let budget = reasoning.max_tokens.or_else(|| {
					reasoning
						.effort
						.map(|effort| thinking_budget(effort, budgets))
				});
				Ok(GoogleThinkingConfig {
					include_thoughts,
					thinking_budget: budget,
					thinking_level: None,
				})
			},
		}
	}

	/// Serializes a projected body directly from its typed representation.
	pub fn encode_json(request: &GenerateContentRequest) -> Result<Bytes, GoogleCodecError> {
		serde_json::to_vec(request)
			.map(Bytes::from)
			.map_err(|error| GoogleCodecError::encoding(format!("invalid Google request: {error}")))
	}
}

fn shortest_wire_f32(value: f32) -> Result<f64, GoogleCodecError> {
	if !value.is_finite() {
		return Err(GoogleCodecError::encoding("Google sampling controls must be finite"));
	}
	value
		.to_string()
		.parse()
		.map_err(|_| GoogleCodecError::encoding("Google sampling control is not a JSON number"))
}

const fn generation_config_is_empty(generation: &GoogleGenerationConfig) -> bool {
	generation.temperature.is_none()
		&& generation.top_p.is_none()
		&& generation.top_k.is_none()
		&& generation.max_output_tokens.is_none()
		&& generation.stop_sequences.is_empty()
		&& generation.response_mime_type.is_none()
		&& generation.response_json_schema.is_none()
		&& generation.response_modalities.is_empty()
		&& generation.thinking_config.is_none()
}

#[derive(Clone, Copy, IntoStaticStr)]
enum GoogleThinkingLevel {
	#[strum(serialize = "MINIMAL")]
	Minimal,
	#[strum(serialize = "LOW")]
	Low,
	#[strum(serialize = "MEDIUM")]
	Medium,
	#[strum(serialize = "HIGH")]
	High,
}

/// `HIGH` is Google's ceiling, so `xhigh` and `max` collapse onto it rather
/// than an unspecified level.
impl From<ReasoningEffort> for GoogleThinkingLevel {
	fn from(effort: ReasoningEffort) -> Self {
		match effort {
			ReasoningEffort::Off | ReasoningEffort::Minimal => Self::Minimal,
			ReasoningEffort::Low => Self::Low,
			ReasoningEffort::Medium => Self::Medium,
			ReasoningEffort::High | ReasoningEffort::Xhigh | ReasoningEffort::Max => Self::High,
		}
	}
}

impl From<ThinkingEffort> for GoogleThinkingLevel {
	fn from(effort: ThinkingEffort) -> Self {
		match effort {
			ThinkingEffort::Off | ThinkingEffort::Minimal => Self::Minimal,
			ThinkingEffort::Low => Self::Low,
			ThinkingEffort::Medium => Self::Medium,
			ThinkingEffort::High | ThinkingEffort::XHigh | ThinkingEffort::Max => Self::High,
		}
	}
}

fn thinking_level(effort: ReasoningEffort) -> Str {
	sf!(<&'static str>::from(GoogleThinkingLevel::from(effort)))
}

/// Spells a resolved catalog wire effort as Google's `thinkingLevel` value.
fn selection_thinking_level(effort: ThinkingEffort) -> Str {
	sf!(<&'static str>::from(GoogleThinkingLevel::from(effort)))
}

const fn thinking_budget(effort: ReasoningEffort, budgets: GoogleThinkingBudgets) -> u64 {
	match effort {
		ReasoningEffort::Off => 0,
		ReasoningEffort::Minimal => budgets.minimal,
		ReasoningEffort::Low => budgets.low,
		ReasoningEffort::Medium => budgets.medium,
		ReasoningEffort::High => budgets.high,
		ReasoningEffort::Xhigh => budgets.xhigh,
		ReasoningEffort::Max => budgets.maximum,
	}
}

fn text_part(text: Str) -> GooglePart {
	GooglePart { text: Some(text), ..GooglePart::default() }
}

fn project_media(
	media: &MediaInput,
	remote: Option<&GoogleFileData>,
) -> Result<GooglePart, GoogleCodecError> {
	if let Some(remote) = remote {
		if remote.file_uri.trim().is_empty() {
			return Err(GoogleCodecError::encoding("google/file_data file_uri must not be blank"));
		}
		return Ok(GooglePart { file_data: Some(remote.clone()), ..GooglePart::default() });
	}
	match media {
		MediaInput::Bytes { media_type, data } if !data.is_empty() => Ok(GooglePart {
			inline_data: Some(GoogleInlineData {
				mime_type: media_type.clone(),
				data:      base64::encode(data).into_string().into(),
			}),
			..GooglePart::default()
		}),
		MediaInput::Bytes { .. } => {
			Err(GoogleCodecError::encoding("Google inlineData requires payload bytes"))
		},
		MediaInput::Remote { uri, media_type: Some(media_type), .. } if !uri.trim().is_empty() => {
			Ok(GooglePart {
				file_data: Some(GoogleFileData {
					mime_type: media_type.clone(),
					file_uri:  uri.clone(),
				}),
				..GooglePart::default()
			})
		},
		MediaInput::Remote { uri, .. } if uri.trim().is_empty() => {
			Err(GoogleCodecError::encoding("google/file_data file_uri must not be blank"))
		},
		MediaInput::Remote { .. } => {
			Err(GoogleCodecError::encoding("Google fileData requires an explicit MIME type"))
		},
		MediaInput::Stored(_) => Err(GoogleCodecError::encoding(
			"stored media must be resolved to inline bytes or a Google-readable remote URI before \
			 encoding",
		)),
		MediaInput::Body { .. } => Err(GoogleCodecError::encoding(
			"streamed media must be explicitly staged before Google request encoding",
		)),
	}
}

fn opaque_raw(value: &OpaqueJson, label: &str) -> Result<Box<RawValue>, GoogleCodecError> {
	serde_json::value::to_raw_value(value.0.as_ref())
		.map_err(|error| GoogleCodecError::encoding(format!("invalid {label}: {error}")))
}

/// Resolves a historical continuation proof to its wire `thoughtSignature`.
///
/// A proof issued by a different provider or codec (a resumed conversation
/// after a model switch) is omitted rather than fatal; the omission is recorded
/// once per request.
fn proof_string(
	proof: Option<&ProviderProof>,
	options: &GoogleRequestOptions,
	adjustments: &mut Vec<GoogleAdjustment>,
) -> Result<Option<Str>, GoogleCodecError> {
	let Some(proof) = proof else {
		return Ok(None);
	};
	let scope = options.proof_scope.as_ref().ok_or_else(|| {
		GoogleCodecError::encoding(
			"Google continuation proof cannot be returned without selected provider and codec \
			 identity",
		)
	})?;
	if proof.provider != scope.provider || proof.codec != scope.codec {
		if !adjustments
			.iter()
			.any(|adjustment| adjustment.what == FOREIGN_SIGNATURE_FEATURE)
		{
			adjustments.push(GoogleAdjustment::new_static(
				FOREIGN_SIGNATURE_FEATURE,
				FOREIGN_SIGNATURE_REASON,
			));
		}
		return Ok(None);
	}
	str::from_utf8(&proof.value)
		.map(|signature| Some(Str::new(signature)))
		.map_err(|error| {
			GoogleCodecError::encoding(format!("Google thought signature is not UTF-8: {error}"))
		})
}

fn wire_function_arguments(args: &RawValue) -> Result<(Bytes, bool), GoogleCodecError> {
	let raw = args.get().trim();
	if raw.starts_with('"') {
		let inner: Str = serde_json::from_str(raw).map_err(|error| {
			GoogleCodecError::decode(format!(
				"Google functionCall args string is not valid JSON text: {error}"
			))
		})?;
		return Ok((Bytes::copy_from_slice(inner.as_bytes()), false));
	}
	Ok((Bytes::copy_from_slice(raw.as_bytes()), raw.starts_with('{')))
}

fn tool_response_raw(
	content: &[ToolResultContent],
	is_error: bool,
	strip_image_input: bool,
) -> Result<(Box<RawValue>, Vec<GooglePart>), GoogleCodecError> {
	let mut text = String::new();
	let mut json = None;
	let mut parts = Vec::new();
	for item in content {
		match item {
			ToolResultContent::Text(value) => {
				if !text.is_empty() {
					text.push('\n');
				}
				text.push_str(value);
			},
			ToolResultContent::Json(value) => {
				if json.is_some() || !text.is_empty() {
					return Err(GoogleCodecError::encoding(
						"Google functionResponse accepts one JSON result or joined text, not both",
					));
				}
				json = Some(opaque_raw(value, "tool response")?);
			},
			ToolResultContent::Image(media) => {
				if strip_image_input {
					if !text.is_empty() {
						text.push('\n');
					}
					text.push_str(NON_VISION_IMAGE_PLACEHOLDER);
				} else {
					parts.push(project_media(media, None)?);
				}
			},
			ToolResultContent::Document(media) => {
				parts.push(project_media(media, None)?);
			},
		}
	}
	let result = match &json {
		Some(value) => ToolResponseValue::Json(value.as_ref()),
		None if text.is_empty() && !parts.is_empty() => {
			ToolResponseValue::Text(TOOL_RESULT_IMAGE_REFERENCE)
		},
		None => ToolResponseValue::Text(text.as_str()),
	};
	#[derive(Serialize)]
	struct Response<'a> {
		#[serde(skip_serializing_if = "Option::is_none")]
		output: Option<ToolResponseValue<'a>>,
		#[serde(skip_serializing_if = "Option::is_none")]
		error:  Option<ToolResponseValue<'a>>,
	}
	let response =
		Response { output: (!is_error).then_some(result), error: is_error.then_some(result) };
	let raw = serde_json::value::to_raw_value(&response)
		.map_err(|error| GoogleCodecError::encoding(format!("invalid tool response: {error}")))?;
	Ok((raw, parts))
}

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
enum ToolResponseValue<'a> {
	Text(&'a str),
	Json(&'a RawValue),
}
fn flush_tool_images(contents: &mut Vec<GoogleContent>, pending: &mut Vec<GooglePart>) {
	if pending.is_empty() {
		return;
	}
	let mut parts = Vec::with_capacity(pending.len().saturating_add(1));
	parts.push(text_part(sf!(TOOL_RESULT_IMAGE_LABEL)));
	parts.append(pending);
	contents.push(GoogleContent { role: sf!("user"), parts });
}

fn append_content(
	contents: &mut Vec<GoogleContent>,
	role: Str,
	parts: Vec<GooglePart>,
	function_response: bool,
) {
	if let Some(last) = contents.last_mut()
		&& last.role == role
		&& (!function_response
			|| last
				.parts
				.iter()
				.any(|part| part.function_response.is_some()))
	{
		last.parts.extend(parts);
	} else {
		contents.push(GoogleContent { role, parts });
	}
}

fn inline_tool_guidance(tools: &[ToolDefinition]) -> Result<Str, GoogleCodecError> {
	let mut guidance = String::from(
		"Tool descriptors (use the native function names exactly; arguments must match each JSON \
		 schema):",
	);
	for tool in tools {
		let (parameters, _) = tool.input.wire_schema();
		guidance.push_str("\n\n");
		guidance.push_str(tool.name.as_str());
		if let Some(description) = &tool.description {
			guidance.push_str(": ");
			guidance.push_str(description);
		}
		guidance.push_str("\ninput_schema: ");
		let schema = serde_json::to_string(parameters.0.as_ref())
			.map_err(|error| GoogleCodecError::encoding(format!("invalid tool schema: {error}")))?;
		guidance.push_str(&schema);
	}
	Ok(Str::from(guidance))
}

fn project_tool_choice(
	choice: &Setting<ToolChoice>,
	tools: &[ToolDefinition],
) -> Result<Option<GoogleToolConfig>, GoogleCodecError> {
	let choice = match choice {
		Setting::Unset => return Ok(None),
		Setting::Require(value) | Setting::Prefer(value) => value,
	};
	if tools.is_empty() {
		return match choice {
			ToolChoice::Disabled | ToolChoice::Auto => Ok(None),
			ToolChoice::Required | ToolChoice::Named(_) => Err(GoogleCodecError::encoding(
				"Gemini cannot force function calling without function declarations",
			)),
		};
	}
	let (mode, allowed_function_names) = match choice {
		ToolChoice::Disabled => (GoogleFunctionCallingMode::None, Vec::new()),
		ToolChoice::Auto => (GoogleFunctionCallingMode::Auto, Vec::new()),
		ToolChoice::Required => (GoogleFunctionCallingMode::Any, Vec::new()),
		ToolChoice::Named(name) => {
			if !tools.iter().any(|tool| tool.name == *name) {
				return Err(GoogleCodecError::encoding(format!(
					"named Google tool choice `{name}` is not declared"
				)));
			}
			(GoogleFunctionCallingMode::Any, vec![name.clone()])
		},
	};
	Ok(Some(GoogleToolConfig {
		function_calling_config: GoogleFunctionCallingConfig { mode, allowed_function_names },
	}))
}

/// Typed native Google `CountTokens` request.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCountTokensRequest {
	/// Direct content list for a plain prompt count.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub contents:                 Vec<GoogleContent>,
	/// Full request semantics when system instructions or tools affect the
	/// count.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub generate_content_request: Option<GenerateContentRequest>,
}

/// Typed native Google `CountTokens` response.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCountTokensResponse {
	/// Exact total prompt tokens reported by Google.
	pub total_tokens: Option<u64>,
	/// Cached-content tokens included in the total, when reported.
	pub cached_content_token_count: Option<u64>,
	/// Typed provider error.
	pub error: Option<GoogleWireError>,
}

/// Role-free content accepted by Google's embedding methods.
#[derive(Clone, Debug, Serialize)]
pub struct GoogleEmbeddingContent {
	/// Ordered embedding input parts.
	pub parts: Vec<GooglePart>,
}

/// One Google embedding request item.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleEmbedContentRequest {
	/// Fully scoped model name required inside batch requests.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub model:                 Option<Str>,
	/// Text content to embed.
	pub content:               GoogleEmbeddingContent,
	/// Requested output dimensions.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub output_dimensionality: Option<u32>,
}

/// Typed Google batch embedding request.
#[derive(Clone, Debug, Serialize)]
pub struct GoogleBatchEmbedContentsRequest {
	/// Ordered per-input requests.
	pub requests: Vec<GoogleEmbedContentRequest>,
}

/// One dense Google embedding vector.
#[derive(Clone, Debug, Deserialize)]
pub struct GoogleEmbeddingValues {
	/// Dense finite components.
	pub values: Vec<f32>,
}

/// Typed response accepted from embedContent or batchEmbedContents.
#[derive(Clone, Debug, Deserialize)]
pub struct GoogleEmbeddingResponse {
	/// Single embedContent result.
	pub embedding:  Option<GoogleEmbeddingValues>,
	/// Batch results in request order.
	#[serde(default)]
	pub embeddings: Vec<GoogleEmbeddingValues>,
	/// Typed provider error.
	pub error:      Option<GoogleWireError>,
}

/// Typed `GenerateContent` response chunk.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateContentResponse {
	/// Candidate deltas.
	#[serde(default)]
	pub candidates:      Vec<GoogleCandidate>,
	/// Provider response identity.
	pub response_id:     Option<Str>,
	/// Cumulative usage.
	pub usage_metadata:  Option<GoogleUsageMetadata>,
	/// Prompt-level block evidence.
	pub prompt_feedback: Option<GooglePromptFeedback>,
	/// In-band provider error.
	pub error:           Option<GoogleWireError>,
}

/// One candidate response delta.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCandidate {
	/// Content delta.
	pub content:            Option<GoogleResponseContent>,
	/// Terminal finish reason.
	pub finish_reason:      Option<Str>,
	/// Provider finish detail.
	pub finish_message:     Option<Str>,
	/// Grounding metadata retained opaquely.
	pub grounding_metadata: Option<Box<RawValue>>,
	/// Citation metadata retained opaquely.
	pub citation_metadata:  Option<Box<RawValue>>,
	/// Typed safety ratings.
	#[serde(default)]
	pub safety_ratings:     Vec<GoogleSafetyRating>,
}

/// Candidate content wrapper.
#[derive(Debug, Deserialize)]
pub struct GoogleResponseContent {
	/// Ordered response parts.
	#[serde(default)]
	pub parts: Vec<GooglePart>,
}

/// One typed candidate safety rating.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct GoogleSafetyRating {
	/// Harm category.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub category:    Option<Str>,
	/// Probability label.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub probability: Option<Str>,
	/// Whether the category blocked output.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub blocked:     Option<bool>,
	/// Severity label where supplied.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub severity:    Option<Str>,
}

/// Prompt blocking metadata.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GooglePromptFeedback {
	/// Block reason.
	pub block_reason:         Option<Str>,
	/// Human-readable provider message.
	pub block_reason_message: Option<Str>,
}

/// In-band `GenerateContent` error object.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleWireError {
	/// Numeric provider code.
	pub code:    Option<u16>,
	/// Human-readable provider message.
	pub message: Option<Str>,
	/// Symbolic provider status.
	pub status:  Option<Str>,
	/// Structured Google RPC error evidence.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub details: Vec<GoogleErrorDetail>,
}

/// One structured `google.rpc.Status` detail.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GoogleErrorDetail {
	/// Fully qualified protobuf detail type.
	#[serde(rename = "@type")]
	pub type_url:    Str,
	/// Provider classification supplied by `google.rpc.ErrorInfo`.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reason:      Option<Str>,
	/// Retry delay supplied by `google.rpc.RetryInfo`.
	#[serde(default, rename = "retryDelay", skip_serializing_if = "Option::is_none")]
	pub retry_delay: Option<Str>,
}

/// Provider-reported usage counters.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleUsageMetadata {
	/// Prompt tokens.
	#[serde(default)]
	pub prompt_token_count:         u64,
	/// Candidate output tokens excluding explicit thought tokens.
	#[serde(default)]
	pub candidates_token_count:     u64,
	/// Cached prompt tokens.
	#[serde(default)]
	pub cached_content_token_count: u64,
	/// Thought tokens.
	#[serde(default)]
	pub thoughts_token_count:       u64,
	/// Provider total, retained for diagnostics.
	#[serde(default)]
	pub total_token_count:          u64,
}

impl GoogleUsageMetadata {
	/// Projects Google counters into dimensioned canonical usage.
	pub const fn canonical(self) -> Usage {
		Usage {
			input_tokens: self
				.prompt_token_count
				.saturating_sub(self.cached_content_token_count),
			output_tokens: self
				.candidates_token_count
				.saturating_add(self.thoughts_token_count),
			reasoning_tokens: self.thoughts_token_count,
			cache_read_tokens: self.cached_content_token_count,
			cache_write_tokens: 0,
			cache_write_1h_tokens: 0,
			images: 0,
			audio_input_ms: 0,
			audio_output_ms: 0,
			video_ms: 0,
			search_calls: 0,
			premium_requests_millionths: 0,
			source: UsageSource::Provider,
		}
	}
}

/// Auxiliary provider-part kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoogleAuxiliaryKind {
	/// Provider-generated source code.
	ExecutableCode,
	/// Provider-generated execution output.
	CodeExecutionResult,
}

/// Normalized terminal reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoogleFinishReason {
	/// Natural end of turn.
	EndTurn,
	/// Output-token bound reached.
	MaxTokens,
	/// Content or safety policy stopped output.
	ContentFilter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContiguousPartKind {
	Text,
	Thinking,
}

/// Incremental typed output produced by [`GeminiDecoder`].
#[derive(Debug)]
pub enum GoogleDecodedEvent {
	/// Text block delta with an optional continuation proof.
	Text {
		/// Canonical block index.
		index:     u32,
		/// Visible text delta.
		text:      Str,
		/// Optional provider continuation proof.
		signature: Option<Str>,
	},
	/// Thinking block delta with optional continuation proof.
	Thinking {
		/// Canonical block index.
		index:     u32,
		/// Reasoning text delta.
		text:      Str,
		/// Optional provider continuation proof.
		signature: Option<Str>,
	},
	/// Continuation proof delivered on an empty-text part for the block that is
	/// currently open; it carries no visible delta.
	Signature {
		/// Canonical block index of the open text or thinking block.
		index:     u32,
		/// Provider continuation proof.
		signature: Str,
	},
	/// Complete provider function call.
	FunctionCall {
		/// Canonical block index.
		index:             u32,
		/// Stable provider or synthesized call identity.
		id:                Str,
		/// Declared function name.
		name:              Str,
		/// Opaque complete arguments.
		args:              Box<RawValue>,
		/// Optional continuation proof.
		thought_signature: Option<Str>,
	},
	/// Textual auxiliary code-execution output.
	Auxiliary {
		/// Canonical block index.
		index: u32,
		/// Provider auxiliary output category.
		kind:  GoogleAuxiliaryKind,
		/// Auxiliary text.
		text:  Str,
		/// Provider language or outcome label.
		label: Str,
	},
	/// Candidate metadata attached to the attempt.
	Metadata(GoogleCandidateMetadata),
	/// Cumulative usage observation.
	Usage(Usage),
	/// Successful completion.
	Completed(GoogleFinishReason),
	/// Typed provider failure.
	Error(GoogleCodecError),
}

/// Candidate metadata projected without interpreting opaque grounding payloads.
#[derive(Debug, Default)]
pub struct GoogleCandidateMetadata {
	/// Candidate index.
	pub candidate:      u32,
	/// Response ID.
	pub response_id:    Option<Str>,
	/// Grounding metadata.
	pub grounding:      Option<Box<RawValue>>,
	/// Citation metadata.
	pub citations:      Option<Box<RawValue>>,
	/// Safety ratings.
	pub safety:         Vec<GoogleSafetyRating>,
	/// Finish message.
	pub finish_message: Option<Str>,
}

/// Sans-I/O incremental `GenerateContent` frame decoder.
#[derive(Debug, Default)]
pub struct GeminiDecoder {
	next_index:      u32,
	text_index:      Option<u32>,
	thinking_index:  Option<u32>,
	active_part:     Option<ContiguousPartKind>,
	completed:       bool,
	observed_finish: bool,
	response_id:     Option<Str>,
	/// Heals leaked ```` ```thinking ```` opener lines that Gemini thought
	/// summaries emit as between-summary delimiters.
	thinking_fence:  ThinkingFenceStripper,
}

impl GeminiDecoder {
	/// Decodes one complete SSE data field or unary JSON body.
	pub fn push_json(&mut self, data: &[u8]) -> Result<Vec<GoogleDecodedEvent>, GoogleCodecError> {
		if self.completed || data.is_empty() {
			return Ok(Vec::new());
		}
		if data == b"[DONE]" {
			return self.finish();
		}
		let response: GenerateContentResponse = serde_json::from_slice(data).map_err(|error| {
			GoogleCodecError::decode(format!("invalid Google response JSON: {error}"))
		})?;
		self.decode_response(response)
	}

	/// Ends the body, producing one error if no terminal finish reason was
	/// observed.
	pub fn finish(&mut self) -> Result<Vec<GoogleDecodedEvent>, GoogleCodecError> {
		if self.completed {
			return Ok(Vec::new());
		}
		self.completed = true;
		let mut events = Vec::new();
		self.flush_thinking_fence(&mut events);
		if !self.observed_finish {
			events.push(GoogleDecodedEvent::Error(GoogleCodecError::upstream(
				"Google stream ended without a finish reason",
			)));
		}
		Ok(events)
	}

	/// Drains the fence stripper's held partial line into a final thinking
	/// delta.
	fn flush_thinking_fence(&mut self, events: &mut Vec<GoogleDecodedEvent>) {
		let tail = self.thinking_fence.flush();
		if tail.is_empty() {
			return;
		}
		let index = *self
			.thinking_index
			.get_or_insert_with(|| take_index(&mut self.next_index));
		events.push(GoogleDecodedEvent::Thinking { index, text: Str::new(tail), signature: None });
	}

	/// Decodes one already typed embedded response envelope.
	pub fn push_response(
		&mut self,
		response: GenerateContentResponse,
	) -> Result<Vec<GoogleDecodedEvent>, GoogleCodecError> {
		if self.completed {
			return Ok(Vec::new());
		}
		self.decode_response(response)
	}

	fn decode_response(
		&mut self,
		response: GenerateContentResponse,
	) -> Result<Vec<GoogleDecodedEvent>, GoogleCodecError> {
		let mut events = Vec::new();
		if let Some(response_id) = response.response_id {
			self.response_id = Some(response_id);
		}
		if let Some(error) = response.error {
			self.completed = true;
			events.push(GoogleDecodedEvent::Error(GoogleCodecError::from_wire(error)));
			return Ok(events);
		}
		if let Some(feedback) = response.prompt_feedback
			&& feedback.block_reason.is_some()
		{
			self.completed = true;
			let detail = feedback
				.block_reason_message
				.or(feedback.block_reason)
				.unwrap_or_else(|| sf!("Google blocked the prompt"));
			events.push(GoogleDecodedEvent::Error(GoogleCodecError::upstream(detail)));
			return Ok(events);
		}
		if let Some(usage) = response.usage_metadata {
			events.push(GoogleDecodedEvent::Usage(usage.canonical()));
		}
		let mut finish = None;
		for (candidate_index, candidate) in response.candidates.into_iter().enumerate() {
			let metadata = GoogleCandidateMetadata {
				candidate:      u32::try_from(candidate_index).unwrap_or(u32::MAX),
				response_id:    self.response_id.clone(),
				grounding:      candidate.grounding_metadata,
				citations:      candidate.citation_metadata,
				safety:         candidate.safety_ratings,
				finish_message: candidate.finish_message,
			};
			if metadata.response_id.is_some()
				|| metadata.grounding.is_some()
				|| metadata.citations.is_some()
				|| !metadata.safety.is_empty()
				|| metadata.finish_message.is_some()
			{
				events.push(GoogleDecodedEvent::Metadata(metadata));
			}
			if let Some(content) = candidate.content {
				for part in content.parts {
					self.decode_part(part, &mut events)?;
				}
			}
			finish = candidate.finish_reason.or(finish);
		}
		if let Some(reason) = finish {
			self.observed_finish = true;
			self.completed = true;
			self.flush_thinking_fence(&mut events);
			match map_finish_reason(reason.as_str()) {
				Ok(reason) => events.push(GoogleDecodedEvent::Completed(reason)),
				Err(error) => events.push(GoogleDecodedEvent::Error(error)),
			}
		}
		Ok(events)
	}

	fn decode_part(
		&mut self,
		mut part: GooglePart,
		events: &mut Vec<GoogleDecodedEvent>,
	) -> Result<(), GoogleCodecError> {
		if let Some(call) = part.function_call {
			self.transition_part(None, events);
			if call.name.is_empty() {
				self.completed = true;
				return Err(GoogleCodecError::upstream(
					"Google functionCall is missing a non-empty name",
				));
			}
			if part.thought_signature.as_ref().is_some_and(Str::is_empty) {
				self.completed = true;
				return Err(GoogleCodecError::upstream(
					"Google functionCall carried an empty thoughtSignature",
				));
			}
			let index = take_index(&mut self.next_index);
			let id = call
				.id
				.unwrap_or_else(|| format!("google-call-{index}").into());
			events.push(GoogleDecodedEvent::FunctionCall {
				index,
				id,
				name: call.name,
				args: call.args,
				thought_signature: part.thought_signature,
			});
			return Ok(());
		}
		if let Some(active) = self.active_part
			&& part.text.as_deref() == Some("")
			&& let Some(signature) = part
				.thought_signature
				.take()
				.filter(|signature| !signature.is_empty())
		{
			// Google can deliver the proof on a trailing empty-text part; it
			// belongs to the block that is still open.
			let slot = match active {
				ContiguousPartKind::Text => &mut self.text_index,
				ContiguousPartKind::Thinking => &mut self.thinking_index,
			};
			let index = *slot.get_or_insert_with(|| take_index(&mut self.next_index));
			events.push(GoogleDecodedEvent::Signature { index, signature });
		} else if let Some(text) = part.text
			&& !text.is_empty()
		{
			if part.thought.unwrap_or(false) {
				self.transition_part(Some(ContiguousPartKind::Thinking), events);
				// Structured thought parts bypass the visible-channel leaked
				// reasoning healers, so a leaked ```thinking delimiter would
				// reach display and persistence verbatim.
				let cleaned = self.thinking_fence.push(&text);
				if !cleaned.is_empty() || part.thought_signature.is_some() {
					let index = *self
						.thinking_index
						.get_or_insert_with(|| take_index(&mut self.next_index));
					events.push(GoogleDecodedEvent::Thinking {
						index,
						text: Str::new(cleaned),
						signature: part.thought_signature,
					});
				}
			} else {
				self.transition_part(Some(ContiguousPartKind::Text), events);
				let index = *self
					.text_index
					.get_or_insert_with(|| take_index(&mut self.next_index));
				events.push(GoogleDecodedEvent::Text {
					index,
					text,
					signature: part.thought_signature,
				});
			}
		}
		if let Some(code) = part.executable_code {
			self.transition_part(None, events);
			let index = take_index(&mut self.next_index);
			events.push(GoogleDecodedEvent::Auxiliary {
				index,
				kind: GoogleAuxiliaryKind::ExecutableCode,
				text: code.code,
				label: code.language.unwrap_or_else(|| sf!("LANGUAGE_UNSPECIFIED")),
			});
		}
		if let Some(result) = part.code_execution_result {
			self.transition_part(None, events);
			let index = take_index(&mut self.next_index);
			events.push(GoogleDecodedEvent::Auxiliary {
				index,
				kind: GoogleAuxiliaryKind::CodeExecutionResult,
				text: result.output,
				label: result.outcome.unwrap_or_else(|| sf!("OUTCOME_UNSPECIFIED")),
			});
		}
		Ok(())
	}

	fn transition_part(
		&mut self,
		next: Option<ContiguousPartKind>,
		events: &mut Vec<GoogleDecodedEvent>,
	) {
		if self.active_part == next {
			return;
		}
		if self.active_part == Some(ContiguousPartKind::Thinking) {
			self.flush_thinking_fence(events);
		}
		self.text_index = None;
		self.thinking_index = None;
		self.active_part = next;
	}
}

const fn take_index(next: &mut u32) -> u32 {
	let index = *next;
	*next = next.saturating_add(1);
	index
}

fn map_finish_reason(reason: &str) -> Result<GoogleFinishReason, GoogleCodecError> {
	match reason {
		"STOP" => Ok(GoogleFinishReason::EndTurn),
		"MAX_TOKENS" => Ok(GoogleFinishReason::MaxTokens),
		"SAFETY"
		| "RECITATION"
		| "BLOCKLIST"
		| "PROHIBITED_CONTENT"
		| "SPII"
		| "IMAGE_SAFETY"
		| "IMAGE_PROHIBITED_CONTENT"
		| "IMAGE_RECITATION"
		| "IMAGE_OTHER"
		| "NO_IMAGE" => Ok(GoogleFinishReason::ContentFilter),
		"FINISH_REASON_UNSPECIFIED"
		| "OTHER"
		| "LANGUAGE"
		| "MALFORMED_FUNCTION_CALL"
		| "UNEXPECTED_TOOL_CALL" => Err(GoogleCodecError::upstream(format!(
			"Google generation failed with finish reason: {reason}"
		))),
		unknown => {
			Err(GoogleCodecError::upstream(format!("unknown Google finish reason: {unknown}")))
		},
	}
}

impl Codec for GeminiCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		if let OperationCall::CountTokens(request) = operation {
			return encode_google_count_tokens(*self, context, request);
		}
		if let OperationCall::Embed(request) = operation {
			return encode_google_embeddings(*self, context, request);
		}
		let OperationCall::Chat(request) = operation else {
			return Err(
				GoogleCodecError::capability(
					"Google codec accepts chat, count-tokens, and embedding operations",
				)
				.into_inference(false),
			);
		};
		let target = context.target.ok_or_else(|| {
			GoogleCodecError::encoding("Google GenerateContent requires a selected wire model target")
				.into_inference(false)
		})?;
		if let Some(selection) = context.thinking_selection
			&& selection.wire_model.as_str() != target.wire_model.as_str()
		{
			return Err(
				GoogleCodecError::encoding(
					"Google thinking selection wire model does not match the encoded target",
				)
				.into_inference(false),
			);
		}
		let options = GoogleRequestOptions {
			proof_scope: Some(GoogleProofScope {
				provider: context.route.provider.clone(),
				codec:    target.codec.clone(),
			}),
			drop_unsigned_reasoning: context.policy.reasoning.drop_unsigned == Some(true),
			supports_function_part_id: context.policy.tool.supports_function_part_id,
			requires_skip_thought_signature: context.policy.tool.requires_skip_thought_signature
				== Some(true),
			requires_skip_thought_signature_on_first_function_call: context
				.policy
				.tool
				.requires_skip_thought_signature_on_first_function_call
				== Some(true),
			multimodal_function_response: context.policy.image.multimodal_function_response,
			strip_image_input: context.policy.image.strip_input == Some(true),
			cca_legacy_parameters_schema: context.policy.tool.cca_legacy_parameters_schema,
			inline_tool_descriptors: if context.policy.tool.cca_legacy_parameters_schema == Some(true)
			{
				InlineToolDescriptorsMode::Off
			} else {
				InlineToolDescriptorsMode::Auto
			},
			..GoogleRequestOptions::default()
		};
		let projection = self
			.project_for_encode(request, &options, context.thinking_policy, context.thinking_selection)
			.map_err(|error| error.into_inference(false))?;
		if let Some(adjustment) =
			projection.unplanned_adjustment(matches!(&request.output, Setting::Prefer(_)))
		{
			return Err(
				GoogleCodecError::capability(format!(
					"planning did not account for unsupported Google feature `{}`: {}",
					adjustment.what, adjustment.detail,
				))
				.into_inference(false),
			);
		}
		let adjustments = canonical_google_adjustments(&projection.adjustments);
		let body =
			Self::encode_json(&projection.request).map_err(|error| error.into_inference(false))?;
		let project = context
			.account
			.and_then(|account| account.project.as_ref())
			.map(|project| project.as_str());
		let location = target.endpoint.region.as_deref().or_else(|| {
			context
				.account
				.and_then(|account| account.region.as_ref())
				.map(|region| region.as_str())
		});
		let uri = google_stream_uri(
			self.endpoint,
			target.endpoint.base_url.as_str(),
			target.wire_model.as_str(),
			project,
			location,
			context.auth_scheme == Some(AuthScheme::ApiKey),
		)
		.map_err(|error| error.into_inference(false))?;
		Ok(EncodedRequest {
			operation: OperationKind::Chat,
			method: RequestMethod::Post,
			uri,
			headers: vec![
				RequestHeader::new_static("content-type", "application/json"),
				RequestHeader::new_static("accept", "text/event-stream"),
			]
			.into_boxed_slice(),
			body: BodySource::Bytes(body),
			framing: FramingProtocol::Sse,
			bounds: SizeBounds {
				request_body: 32 * 1024 * 1024,
				frame:        16 * 1024 * 1024,
				response:     512 * 1024 * 1024,
			},
			sealed_body: None,
			adjustments,
		})
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		match context.operation {
			OperationKind::Chat if matches!(context.operation_call, OperationCall::Chat(_)) => {
				Ok(Box::new(CanonicalGeminiDecoder::default()))
			},
			OperationKind::Chat => Err(
				GoogleCodecError::decode(
					"Google chat decoder discriminator does not match canonical intent",
				)
				.into_inference(false),
			),
			OperationKind::CountTokens | OperationKind::Embed => {
				let target = context.target.ok_or_else(|| {
					GoogleCodecError::decode("Google unary decoder requires the selected wire target")
						.into_inference(false)
				})?;
				let (expected_embeddings, requested_dimensions) = match context.operation_call {
					OperationCall::CountTokens(_) if context.operation == OperationKind::CountTokens => {
						(None, None)
					},
					OperationCall::Embed(request) if context.operation == OperationKind::Embed => {
						let dimensions = match &request.dimensions {
							Setting::Unset => None,
							Setting::Require(value) | Setting::Prefer(value) => Some(*value),
						};
						(Some(request.inputs.len()), dimensions)
					},
					_ => {
						return Err(
							GoogleCodecError::decode(
								"Google decoder operation discriminator does not match canonical intent",
							)
							.into_inference(false),
						);
					},
				};
				Ok(Box::new(GoogleUnaryDecoder {
					operation: context.operation,
					tokenizer: format!(
						"gemini-count-tokens:{}:{}",
						context.route.as_str(),
						target.wire_model.as_str(),
					)
					.into(),
					revision: sf!(<&'static str>::from(self.endpoint)),
					expected_embeddings,
					requested_dimensions,
					done: false,
				}))
			},
			_ => Err(
				GoogleCodecError::decode("Google codec has no decoder for the planned operation")
					.into_inference(false),
			),
		}
	}
}

fn encode_google_count_tokens(
	codec: GeminiCodec,
	context: &EncodeContext<'_>,
	request: &CountTokensRequest,
) -> Result<EncodedRequest, Error> {
	let target = context.target.ok_or_else(|| {
		GoogleCodecError::encoding("Google CountTokens requires a selected wire model target")
			.into_inference(false)
	})?;
	let chat = ChatRequest {
		messages:          Arc::clone(&request.messages),
		tools:             Arc::clone(&request.tools),
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
		negotiation:       Default::default(),
		forced_call:       None,
	};
	let projection = codec
		.project(&chat, &GoogleRequestOptions {
			proof_scope: Some(GoogleProofScope {
				provider: context.route.provider.clone(),
				codec:    target.codec.clone(),
			}),
			drop_unsigned_reasoning: context.policy.reasoning.drop_unsigned == Some(true),
			supports_function_part_id: context.policy.tool.supports_function_part_id,
			requires_skip_thought_signature: context.policy.tool.requires_skip_thought_signature
				== Some(true),
			requires_skip_thought_signature_on_first_function_call: context
				.policy
				.tool
				.requires_skip_thought_signature_on_first_function_call
				== Some(true),
			multimodal_function_response: context.policy.image.multimodal_function_response,
			strip_image_input: context.policy.image.strip_input == Some(true),
			cca_legacy_parameters_schema: context.policy.tool.cca_legacy_parameters_schema,
			inline_tool_descriptors: if context.policy.tool.cca_legacy_parameters_schema == Some(true)
			{
				InlineToolDescriptorsMode::Off
			} else {
				InlineToolDescriptorsMode::Auto
			},
			..GoogleRequestOptions::default()
		})
		.map_err(|error| error.into_inference(false))?;
	if let Some(adjustment) = projection.unplanned_adjustment(false) {
		return Err(
			GoogleCodecError::capability(format!(
				"planning did not account for unsupported Google CountTokens feature `{}`: {}",
				adjustment.what, adjustment.detail,
			))
			.into_inference(false),
		);
	}
	let adjustments = canonical_google_adjustments(&projection.adjustments);
	let full_request = projection.request.system_instruction.is_some()
		|| !projection.request.tools.is_empty()
		|| projection.request.tool_config.is_some();
	let body = if full_request {
		GoogleCountTokensRequest {
			contents:                 Vec::new(),
			generate_content_request: Some(projection.request),
		}
	} else {
		GoogleCountTokensRequest {
			contents:                 projection.request.contents,
			generate_content_request: None,
		}
	};
	let mut encoded = encode_google_unary(
		codec.endpoint,
		context,
		OperationKind::CountTokens,
		"countTokens",
		serde_json::to_vec(&body).map_err(|error| {
			GoogleCodecError::encoding(format!("invalid Google CountTokens request: {error}"))
				.into_inference(false)
		})?,
	)?;
	encoded.adjustments = adjustments;
	Ok(encoded)
}

fn encode_google_embeddings(
	codec: GeminiCodec,
	context: &EncodeContext<'_>,
	request: &EmbedRequest,
) -> Result<EncodedRequest, Error> {
	let target = context.target.ok_or_else(|| {
		GoogleCodecError::encoding("Google embeddings require a selected wire model target")
			.into_inference(false)
	})?;
	if request.inputs.is_empty() {
		return Err(
			GoogleCodecError::encoding("Google embeddings require at least one input")
				.into_inference(false),
		);
	}
	if !matches!(&request.normalize, Setting::Unset) {
		return Err(
			GoogleCodecError::capability(
				"Google embedding normalization must be resolved by planning; the wire has no control",
			)
			.into_inference(false),
		);
	}
	if !matches!(request.truncation, TruncationPolicy::Reject) {
		return Err(
			GoogleCodecError::capability("Google embedding truncation has no explicit wire control")
				.into_inference(false),
		);
	}
	let dimensions = match &request.dimensions {
		Setting::Unset => None,
		Setting::Require(value) | Setting::Prefer(value) => Some(*value),
	};
	let model: Str = format!("models/{}", target.wire_model.as_str()).into();
	let mut requests = Vec::with_capacity(request.inputs.len());
	for input in request.inputs.iter() {
		let EmbeddingInput::Text(text) = input else {
			return Err(
				GoogleCodecError::capability(
					"Google embedContent accepts text, not pre-tokenized inputs",
				)
				.into_inference(false),
			);
		};
		requests.push(GoogleEmbedContentRequest {
			model:                 (request.inputs.len() > 1).then(|| model.clone()),
			content:               GoogleEmbeddingContent { parts: vec![text_part(text.clone())] },
			output_dimensionality: dimensions,
		});
	}
	let (action, body) = if requests.len() == 1 {
		let request = requests.pop().expect("one request was checked");
		("embedContent", serde_json::to_vec(&request))
	} else {
		("batchEmbedContents", serde_json::to_vec(&GoogleBatchEmbedContentsRequest { requests }))
	};
	encode_google_unary(
		codec.endpoint,
		context,
		OperationKind::Embed,
		action,
		body.map_err(|error| {
			GoogleCodecError::encoding(format!("invalid Google embedding request: {error}"))
				.into_inference(false)
		})?,
	)
}

fn encode_google_unary(
	endpoint: GoogleEndpointKind,
	context: &EncodeContext<'_>,
	operation: OperationKind,
	action: &str,
	body: Vec<u8>,
) -> Result<EncodedRequest, Error> {
	let target = context.target.ok_or_else(|| {
		GoogleCodecError::encoding("Google unary operation requires a selected wire model target")
			.into_inference(false)
	})?;
	let project = context
		.account
		.and_then(|account| account.project.as_ref())
		.map(|project| project.as_str());
	let location = target.endpoint.region.as_deref().or_else(|| {
		context
			.account
			.and_then(|account| account.region.as_ref())
			.map(|region| region.as_str())
	});
	let uri = google_unary_uri(
		endpoint,
		target.endpoint.base_url.as_str(),
		target.wire_model.as_str(),
		project,
		location,
		action,
		context.auth_scheme == Some(AuthScheme::ApiKey),
	)
	.map_err(|error| error.into_inference(false))?;
	Ok(EncodedRequest {
		operation,
		method: RequestMethod::Post,
		uri,
		headers: vec![
			RequestHeader::new_static("content-type", "application/json"),
			RequestHeader::new_static("accept", "application/json"),
		]
		.into_boxed_slice(),
		body: BodySource::Bytes(Bytes::from(body)),
		framing: FramingProtocol::Raw,
		bounds: SizeBounds {
			request_body: 32 * 1024 * 1024,
			frame:        64 * 1024 * 1024,
			response:     64 * 1024 * 1024,
		},
		sealed_body: None,
		adjustments: Vec::new(),
	})
}

fn google_unary_uri(
	endpoint: GoogleEndpointKind,
	base: &str,
	model: &str,
	project: Option<&str>,
	location: Option<&str>,
	action: &str,
	api_key: bool,
) -> Result<Str, GoogleCodecError> {
	validate_path("model", model, false)?;
	let base = base.trim_end_matches('/');
	match endpoint {
		GoogleEndpointKind::GenerativeLanguage => {
			Ok(format!("{base}/models/{model}:{action}").into())
		},
		GoogleEndpointKind::Vertex if api_key => {
			let version = vertex_version_prefix(base);
			Ok(format!("{base}{version}/publishers/google/models/{model}:{action}").into())
		},
		GoogleEndpointKind::Vertex => {
			let project = project.ok_or_else(|| {
				GoogleCodecError::encoding("Vertex unary operation requires an account project")
			})?;
			validate_path("project", project, false)?;
			let location = location.unwrap_or("global");
			validate_path("location", location, false)?;
			let version = vertex_version_prefix(base);
			Ok(format!(
				"{base}{version}/projects/{project}/locations/{location}/publishers/google/models/\
				 {model}:{action}",
			)
			.into())
		},
		GoogleEndpointKind::CloudCodeAssist => Err(GoogleCodecError::capability(
			"Cloud Code Assist does not expose this Google unary operation",
		)),
	}
}

#[derive(Debug)]
struct GoogleUnaryDecoder {
	operation:            OperationKind,
	tokenizer:            Str,
	revision:             Str,
	expected_embeddings:  Option<usize>,
	requested_dimensions: Option<u32>,
	done:                 bool,
}

impl Decoder for GoogleUnaryDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			return Err(
				GoogleCodecError::decode("Google unary response emitted more than one body")
					.into_inference(false),
			);
		}
		let Frame::Raw(data) = frame else {
			return Err(
				GoogleCodecError::decode("Google unary decoder requires one raw body frame")
					.into_inference(false),
			);
		};
		match self.operation {
			OperationKind::CountTokens => {
				let response: GoogleCountTokensResponse =
					serde_json::from_slice(&data).map_err(|error| {
						GoogleCodecError::decode(format!("invalid Google CountTokens response: {error}"))
							.into_inference(false)
					})?;
				if let Some(error) = response.error {
					return Err(GoogleCodecError::from_wire(error).into_inference(false));
				}
				let total_tokens = response.total_tokens.ok_or_else(|| {
					GoogleCodecError::decode("Google CountTokens response is missing totalTokens")
						.into_inference(false)
				})?;
				emit(RawEvent::Answer(AnswerBody::Tokens(TokenCount {
					tokens:     total_tokens,
					provenance: TokenizerProvenance {
						tokenizer: self.tokenizer.clone(),
						revision:  self.revision.clone(),
						exact:     true,
					},
				})));
			},
			OperationKind::Embed => {
				let response: GoogleEmbeddingResponse =
					serde_json::from_slice(&data).map_err(|error| {
						GoogleCodecError::decode(format!("invalid Google embedding response: {error}"))
							.into_inference(false)
					})?;
				if let Some(error) = response.error {
					return Err(GoogleCodecError::from_wire(error).into_inference(false));
				}
				let values = match response.embedding {
					Some(embedding) if response.embeddings.is_empty() => vec![embedding],
					None if !response.embeddings.is_empty() => response.embeddings,
					_ => {
						return Err(
							GoogleCodecError::decode(
								"Google embedding response must contain exactly one result shape",
							)
							.into_inference(false),
						);
					},
				};
				if let Some(expected) = self.expected_embeddings
					&& values.len() != expected
				{
					return Err(
						GoogleCodecError::decode(format!(
							"Google embedding response returned {} vectors for {expected} inputs",
							values.len(),
						))
						.into_inference(false),
					);
				}
				let dimensions = values.first().map_or(0, |embedding| embedding.values.len());
				if dimensions > u32::MAX as usize
					|| values.iter().any(|embedding| {
						embedding.values.len() != dimensions
							|| embedding.values.iter().any(|value| !value.is_finite())
					}) {
					return Err(
						GoogleCodecError::decode(
							"Google embedding response contains invalid vector dimensions or components",
						)
						.into_inference(false),
					);
				}
				if let Some(requested) = self.requested_dimensions
					&& dimensions != requested as usize
				{
					return Err(
						GoogleCodecError::decode(format!(
							"Google embedding response dimension {dimensions} does not match requested \
							 {requested}",
						))
						.into_inference(false),
					);
				}
				let embeddings = values
					.into_iter()
					.enumerate()
					.map(|(index, embedding)| Embedding {
						index:  index as u32,
						values: embedding.values,
					})
					.collect();
				emit(RawEvent::Answer(AnswerBody::Embeddings(EmbeddingBatch {
					dimensions: dimensions as u32,
					embeddings,
					usage: Usage { source: UsageSource::Unknown, ..Usage::default() },
				})));
			},
			_ => {
				return Err(
					GoogleCodecError::decode("Google unary decoder received a non-unary operation")
						.into_inference(false),
				);
			},
		}
		self.done = true;
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			Ok(())
		} else {
			Err(
				GoogleCodecError::decode("Google unary response ended without a body")
					.into_inference(false),
			)
		}
	}
}

/// Builds the streaming `GenerateContent` URI.
///
/// Vertex API keys authenticate against the Express publisher path, which
/// carries neither project nor location; bearer credentials keep the
/// project-scoped path and therefore still require both.
fn google_stream_uri(
	endpoint: GoogleEndpointKind,
	base: &str,
	model: &str,
	project: Option<&str>,
	location: Option<&str>,
	api_key: bool,
) -> Result<Str, GoogleCodecError> {
	validate_path("model", model, false)?;
	let base = base.trim_end_matches('/');
	let uri = match endpoint {
		GoogleEndpointKind::GenerativeLanguage => {
			format!("{base}/models/{model}{GENERATIVE_LANGUAGE_STREAM_PATH}")
		},
		GoogleEndpointKind::Vertex if api_key => {
			let version = vertex_version_prefix(base);
			format!(
				"{base}{version}/publishers/google/models/{model}{GENERATIVE_LANGUAGE_STREAM_PATH}"
			)
		},
		GoogleEndpointKind::Vertex => {
			let project = project.ok_or_else(|| {
				GoogleCodecError::encoding("Vertex GenerateContent requires an account project")
			})?;
			let location = location.ok_or_else(|| {
				GoogleCodecError::encoding(
					"Vertex GenerateContent requires a catalog or account location",
				)
			})?;
			validate_path("project", project, false)?;
			validate_path("location", location, false)?;
			let version = vertex_version_prefix(base);
			format!(
				"{base}{version}/projects/{project}/locations/{location}/publishers/google/models/\
				 {model}{GENERATIVE_LANGUAGE_STREAM_PATH}",
			)
		},
		GoogleEndpointKind::CloudCodeAssist => {
			return Err(GoogleCodecError::encoding(
				"Cloud Code Assist requires its typed project envelope adapter",
			));
		},
	};
	Ok(uri.into())
}

pub(super) fn vertex_version_prefix(base: &str) -> &'static str {
	if base.ends_with("/v1") { "" } else { "/v1" }
}

fn validate_path(name: &str, value: &str, allow_slash: bool) -> Result<(), GoogleCodecError> {
	if value.is_empty()
		|| !value.bytes().all(|byte| {
			byte.is_ascii_alphanumeric()
				|| matches!(byte, b'-' | b'_' | b'.' | b'@')
				|| allow_slash && byte == b'/'
		}) {
		return Err(GoogleCodecError::encoding(format!(
			"Google {name} contains invalid path characters",
		)));
	}
	Ok(())
}

#[derive(Debug, Default)]
pub(super) struct CanonicalGeminiDecoder {
	inner:      GeminiDecoder,
	opened:     BTreeSet<u32>,
	usage:      Usage,
	blocks:     u32,
	committed:  bool,
	tool_calls: bool,
}

impl CanonicalGeminiDecoder {
	pub(super) fn emit_events(
		&mut self,
		events: Vec<GoogleDecodedEvent>,
		emit: &mut dyn FnMut(RawEvent),
	) {
		for event in events {
			match event {
				GoogleDecodedEvent::Text { index, text, signature } => {
					self.open(index, BlockKind::Text, emit);
					self.committed = true;
					emit(RawEvent::Chat(ChatEvent::TextDelta { index, text }));
					if let Some(signature) = signature {
						emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
							index,
							signature: Bytes::copy_from_slice(signature.as_bytes()),
						}));
					}
				},
				GoogleDecodedEvent::Thinking { index, text, signature } => {
					self.open(index, BlockKind::Thinking, emit);
					self.committed = true;
					emit(RawEvent::Chat(ChatEvent::ThinkingDelta { index, text }));
					if let Some(signature) = signature {
						emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
							index,
							signature: Bytes::copy_from_slice(signature.as_bytes()),
						}));
					}
				},
				GoogleDecodedEvent::Signature { index, signature } => {
					emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
						index,
						signature: Bytes::copy_from_slice(signature.as_bytes()),
					}));
				},
				GoogleDecodedEvent::FunctionCall { index, id, name, args, thought_signature } => {
					self.tool_calls = true;
					self.open(index, BlockKind::ToolCall, emit);
					self.committed = true;
					let id = ToolCallId::new(id);
					let (arguments, strict_json_object) = wire_function_arguments(&args)
						.unwrap_or_else(|_| (Bytes::copy_from_slice(args.get().as_bytes()), false));
					emit(RawEvent::Chat(ChatEvent::ToolCallStarted {
						index,
						id: id.clone(),
						name: name.clone(),
					}));
					if strict_json_object {
						emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
							index,
							bytes: arguments.clone(),
						}));
					}
					emit(RawEvent::ToolCallComplete {
						index,
						call: UnvalidatedToolCall {
							id,
							name,
							input_kind: ToolInputKind::Json,
							arguments,
						},
					});
					if let Some(signature) = thought_signature {
						emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
							index,
							signature: Bytes::copy_from_slice(signature.as_bytes()),
						}));
					}
				},
				GoogleDecodedEvent::Auxiliary { index, kind, text, label } => {
					let kind = match kind {
						GoogleAuxiliaryKind::ExecutableCode => "executable_code",
						GoogleAuxiliaryKind::CodeExecutionResult => "code_execution_result",
					};
					emit(RawEvent::Metadata(ProviderMetadataEvent::AuxiliaryPart {
						index,
						kind: Str::new(kind),
						label: Some(label),
					}));
					self.open(index, BlockKind::Text, emit);
					self.committed = true;
					emit(RawEvent::Chat(ChatEvent::TextDelta { index, text }));
				},
				GoogleDecodedEvent::Metadata(metadata) => {
					let candidate = metadata.candidate;
					if let Some(response_id) = metadata.response_id {
						emit(RawEvent::Metadata(ProviderMetadataEvent::ResponseId(response_id)));
					}
					if let Some(grounding) = metadata.grounding {
						emit(RawEvent::Metadata(ProviderMetadataEvent::Grounding {
							candidate,
							data: Bytes::copy_from_slice(grounding.get().as_bytes()),
						}));
					}
					if let Some(citations) = metadata.citations {
						emit(RawEvent::Metadata(ProviderMetadataEvent::Citations {
							candidate,
							data: Bytes::copy_from_slice(citations.get().as_bytes()),
						}));
					}
					if !metadata.safety.is_empty()
						&& let Ok(data) = serde_json::to_vec(&metadata.safety)
					{
						emit(RawEvent::Metadata(ProviderMetadataEvent::SafetyRatings {
							candidate,
							data: Bytes::from(data),
						}));
					}
					if let Some(message) = metadata.finish_message {
						emit(RawEvent::Metadata(ProviderMetadataEvent::FinishMessage {
							candidate,
							message,
						}));
					}
				},
				GoogleDecodedEvent::Usage(usage) => {
					self.usage = usage;
					emit(RawEvent::Chat(ChatEvent::Usage(UsageUpdate { usage, final_update: false })));
				},
				GoogleDecodedEvent::Completed(reason) => {
					self.committed = true;
					emit(RawEvent::Completion(RawCompletion {
						reason: match reason {
							GoogleFinishReason::EndTurn if self.tool_calls => FinishReason::ToolCalls,
							GoogleFinishReason::EndTurn => FinishReason::Stop,
							GoogleFinishReason::MaxTokens => FinishReason::Length,
							GoogleFinishReason::ContentFilter => FinishReason::ContentFilter,
						},
						blocks: self.blocks,
						usage:  self.usage,
					}));
				},
				GoogleDecodedEvent::Error(error) => {
					emit(RawEvent::Failure(error.into_inference(self.committed)));
				},
			}
		}
	}

	fn open(&mut self, index: u32, kind: BlockKind, emit: &mut dyn FnMut(RawEvent)) {
		if self.opened.insert(index) {
			self.blocks = self.blocks.saturating_add(1);
			emit(RawEvent::Chat(ChatEvent::BlockStarted { index, kind }));
		}
	}

	pub(super) const fn committed(&self) -> bool {
		self.committed
	}
}

impl Decoder for CanonicalGeminiDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let data = match frame {
			Frame::Sse(event) => event.data,
			Frame::Raw(data) => data,
			_ => {
				return Err(
					GoogleCodecError::decode(
						"Google GenerateContent decoder requires SSE or unary raw frames",
					)
					.into_inference(self.committed),
				);
			},
		};
		if data.as_ref() == b"[DONE]" {
			return Ok(());
		}
		let events = self
			.inner
			.push_json(&data)
			.map_err(|error| error.into_inference(self.committed))?;
		self.emit_events(events, emit);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let events = self
			.inner
			.finish()
			.map_err(|error| error.into_inference(self.committed))?;
		self.emit_events(events, emit);
		Ok(())
	}
}

const GOOGLE_RPC_ERROR_INFO_TYPE: &str = "type.googleapis.com/google.rpc.ErrorInfo";
const GOOGLE_RPC_RETRY_INFO_TYPE: &str = "type.googleapis.com/google.rpc.RetryInfo";
const LONG_RATE_LIMIT_DELAY_MS: u64 = 5 * 60 * 1_000;

fn parse_google_retry_delay_ms(delay: &str) -> Option<u64> {
	let seconds = delay.strip_suffix('s')?.parse::<f64>().ok()?;
	let milliseconds = seconds * 1_000.0;
	(seconds.is_finite() && seconds >= 0.0 && milliseconds <= u64::MAX as f64)
		.then_some(milliseconds as u64)
}

/// Stable Google codec error category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoogleCodecErrorKind {
	/// Canonical request could not be encoded.
	Encoding,
	/// Selected Google route cannot represent a required declaration.
	Capability,
	/// Provider bytes violated the wire schema.
	Decode,
	/// Provider reported rate limiting.
	RateLimited,
	/// Provider reported exhausted account or credit quota; sibling credentials
	/// may still be usable.
	QuotaExhausted,
	/// Provider reported overload.
	Overloaded,
	/// Other provider contract failure.
	Upstream,
}

/// Typed, secret-free Google protocol failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{detail}")]
pub struct GoogleCodecError {
	/// Stable category.
	pub kind:           GoogleCodecErrorKind,
	/// Sanitized bounded detail.
	pub detail:         Str,
	/// Numeric status when supplied.
	pub status:         Option<u16>,
	/// Structured provider reason, or symbolic status when no reason was
	/// supplied.
	pub code:           Option<Str>,
	/// Provider-suggested minimum delay; policy decides whether retry is legal.
	pub retry_after_ms: u64,
}

impl GoogleCodecError {
	fn encoding(detail: impl IntoStr) -> Self {
		Self {
			kind:           GoogleCodecErrorKind::Encoding,
			detail:         detail.into_str(),
			status:         None,
			code:           None,
			retry_after_ms: 0,
		}
	}

	fn capability(detail: impl IntoStr) -> Self {
		Self {
			kind:           GoogleCodecErrorKind::Capability,
			detail:         detail.into_str(),
			status:         None,
			code:           None,
			retry_after_ms: 0,
		}
	}

	fn decode(detail: impl IntoStr) -> Self {
		Self {
			kind:           GoogleCodecErrorKind::Decode,
			detail:         detail.into_str(),
			status:         None,
			code:           None,
			retry_after_ms: 0,
		}
	}

	fn upstream(detail: impl IntoStr) -> Self {
		Self {
			kind:           GoogleCodecErrorKind::Upstream,
			detail:         detail.into_str(),
			status:         None,
			code:           None,
			retry_after_ms: 0,
		}
	}

	/// Classifies a typed wire error, retaining a structured Google RPC reason
	/// in `code` so receipts can distinguish provider quota categories.
	pub(super) fn from_wire(error: GoogleWireError) -> Self {
		let GoogleWireError { code, message, status, details } = error;
		let mut kind = match (code, status.as_deref()) {
			(Some(429), _) | (_, Some("RESOURCE_EXHAUSTED")) => GoogleCodecErrorKind::RateLimited,
			(Some(503), _) | (_, Some("UNAVAILABLE")) => GoogleCodecErrorKind::Overloaded,
			_ => GoogleCodecErrorKind::Upstream,
		};
		let structured_reason = (kind == GoogleCodecErrorKind::RateLimited)
			.then(|| {
				details
					.iter()
					.find(|detail| {
						detail.type_url == GOOGLE_RPC_ERROR_INFO_TYPE && detail.reason.is_some()
					})
					.and_then(|detail| detail.reason.as_deref())
					.map(|reason| Str::new(reason.trim().to_ascii_uppercase()))
			})
			.flatten();
		let structured_retry_after_ms = (kind == GoogleCodecErrorKind::RateLimited)
			.then(|| {
				details
					.iter()
					.find(|detail| detail.type_url == GOOGLE_RPC_RETRY_INFO_TYPE)
					.and_then(|detail| detail.retry_delay.as_deref())
					.and_then(parse_google_retry_delay_ms)
			})
			.flatten();
		if let Some(reason) = structured_reason.as_deref() {
			kind = match reason {
				"QUOTA_EXHAUSTED" | "INSUFFICIENT_G1_CREDITS_BALANCE" => {
					GoogleCodecErrorKind::QuotaExhausted
				},
				"RATE_LIMIT_EXCEEDED"
					if structured_retry_after_ms
						.is_some_and(|delay| delay >= LONG_RATE_LIMIT_DELAY_MS) =>
				{
					GoogleCodecErrorKind::QuotaExhausted
				},
				_ => GoogleCodecErrorKind::RateLimited,
			};
		}
		let retry_after_ms = if matches!(
			kind,
			GoogleCodecErrorKind::RateLimited | GoogleCodecErrorKind::QuotaExhausted
		) {
			structured_retry_after_ms.unwrap_or(1_000)
		} else if kind == GoogleCodecErrorKind::Overloaded {
			1_000
		} else {
			0
		};
		Self {
			kind,
			detail: message.unwrap_or_else(|| sf!("Google provider error")),
			status: code,
			code: structured_reason.or(status),
			retry_after_ms,
		}
	}

	/// Converts protocol evidence to the shared inference error, attaching
	/// retry or account-rotation intent only before output is committed.
	pub fn into_inference(self, committed: bool) -> Error {
		let kind = match self.kind {
			GoogleCodecErrorKind::Encoding => ErrorKind::InvalidRequest,
			GoogleCodecErrorKind::Capability => ErrorKind::CapabilityMismatch,
			GoogleCodecErrorKind::Decode => ErrorKind::StreamCorruption,
			GoogleCodecErrorKind::RateLimited => ErrorKind::RateLimited,
			GoogleCodecErrorKind::QuotaExhausted => ErrorKind::QuotaExhausted,
			GoogleCodecErrorKind::Overloaded => ErrorKind::ResourceExhausted,
			GoogleCodecErrorKind::Upstream => ErrorKind::Protocol,
		};
		let phase = if matches!(
			self.kind,
			GoogleCodecErrorKind::Encoding | GoogleCodecErrorKind::Capability
		) {
			ErrorPhase::Encoding
		} else {
			ErrorPhase::Streaming
		};
		let action = if committed {
			RetryAction::Never
		} else {
			match self.kind {
				GoogleCodecErrorKind::RateLimited | GoogleCodecErrorKind::Overloaded => {
					RetryAction::SameRoute {
						after: time::Duration::from_millis(self.retry_after_ms.max(1)),
					}
				},
				GoogleCodecErrorKind::QuotaExhausted => RetryAction::RotateAccount,
				_ => RetryAction::Never,
			}
		};
		Error::new(kind, phase, action, ExecutionReceipt::default())
			.status(self.status)
			.optional_code(self.code)
			.committed(committed)
			.detail(ErrorDetail::protocol(ReasonId(self.detail)))
	}
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_catalog::{Catalog, WireTarget, policy};
	use serde_json::Value;

	use super::*;
	use crate::{
		call::{AccountRoutingContext, Sampling as CallSampling, ToolInputConstraint},
		id::{ProjectId, RegionId, RequestId},
	};

	fn opaque(source: &str) -> OpaqueJson {
		OpaqueJson(Arc::new(serde_json::from_str(source).expect("valid test JSON")))
	}
	fn google_rpc_429(reason: &str, retry_delay: Option<&str>) -> String {
		let mut details = vec![serde_json::json!({
			"@type": GOOGLE_RPC_ERROR_INFO_TYPE,
			"reason": reason,
		})];
		if let Some(retry_delay) = retry_delay {
			details.push(serde_json::json!({
				"@type": GOOGLE_RPC_RETRY_INFO_TYPE,
				"retryDelay": retry_delay,
			}));
		}
		serde_json::json!({
			"error": {
				"code": 429,
				"message": "Resource exhausted",
				"status": "RESOURCE_EXHAUSTED",
				"details": details,
			},
		})
		.to_string()
	}

	fn decode_google_error(body: &str) -> GoogleCodecError {
		let mut decoder = GeminiDecoder::default();
		let events = decoder
			.push_json(body.as_bytes())
			.expect("Google RPC error body decodes");
		let [GoogleDecodedEvent::Error(error)] = events.as_slice() else {
			panic!("Google RPC error body produces exactly one error");
		};
		error.clone()
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
			sampling:          CallSampling::default(),
			max_output_tokens: None,
			top_logprobs:      None,
			safety:            Arc::from([]),
			negotiation:       Default::default(),
			forced_call:       None,
		}
	}

	fn tool_call_message() -> Message {
		Message {
			role:    Role::Assistant,
			content: vec![ContentPart::ToolCall {
				call:      ToolCallId::new("call-1"),
				name:      sf!("read"),
				arguments: opaque(r#"{"path":"note.txt"}"#),
				proof:     None,
			}]
			.into(),
			name:    None,
		}
	}

	#[test]
	fn cca_legacy_parameters_schema_matches_pi_request_shape() {
		let mut request = empty_chat_request();
		request.tools = vec![ToolDefinition {
			name:        sf!("read"),
			description: Some(sf!("Read a file")),
			input:       ToolInputConstraint::JsonSchema {
				parameters: opaque(r#"{"type":"object","properties":{"path":{"type":"string"}}}"#),
				strict:     false,
			},
		}]
		.into();
		let projection = GeminiCodec::cloud_code_assist(None)
			.project(&request, &GoogleRequestOptions {
				inline_tool_descriptors: InlineToolDescriptorsMode::Off,
				cca_legacy_parameters_schema: Some(true),
				..Default::default()
			})
			.expect("CCA tool projects");
		let declaration = &projection.request.tools[0].function_declarations[0];
		assert!(declaration.parameters.is_some());
		assert!(declaration.parameters_json_schema.is_none());
	}

	#[test]
	fn drop_unsigned_thinking_matches_pi_request_shape() {
		let mut request = empty_chat_request();
		request.messages = vec![Message {
			role:    Role::Assistant,
			content: vec![ContentPart::Reasoning { text: sf!("unsigned plan"), proof: None }].into(),
			name:    None,
		}]
		.into();
		let projection = GeminiCodec::cloud_code_assist(None)
			.project(&request, &GoogleRequestOptions {
				drop_unsigned_reasoning: true,
				..Default::default()
			})
			.expect("unsigned reasoning is safely omitted");
		assert!(projection.request.contents.is_empty());
	}

	#[test]
	fn requires_skip_thought_signature_matches_pi_request_shape() {
		let mut request = empty_chat_request();
		request.messages = vec![tool_call_message()].into();
		let projection = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions {
				requires_skip_thought_signature: true,
				..Default::default()
			})
			.expect("unsigned tool call projects");
		assert_eq!(
			projection.request.contents[0].parts[0]
				.thought_signature
				.as_deref(),
			Some(SKIP_THOUGHT_SIGNATURE),
		);
	}

	#[test]
	fn first_function_call_sentinel_applies_only_to_first_unsigned_call() {
		let mut request = empty_chat_request();
		request.messages = vec![Message {
			role:    Role::Assistant,
			content: vec![
				ContentPart::ToolCall {
					call:      ToolCallId::new("call-1"),
					name:      sf!("read"),
					arguments: opaque(r#"{"path":"a.txt"}"#),
					proof:     None,
				},
				ContentPart::ToolCall {
					call:      ToolCallId::new("call-2"),
					name:      sf!("read"),
					arguments: opaque(r#"{"path":"b.txt"}"#),
					proof:     None,
				},
			]
			.into(),
			name:    None,
		}]
		.into();
		let signatures = |options: GoogleRequestOptions| {
			GeminiCodec::cloud_code_assist(None)
				.project(&request, &options)
				.expect("unsigned parallel calls project")
				.request
				.contents[0]
				.parts
				.iter()
				.map(|part| part.thought_signature.as_deref().map(str::to_owned))
				.collect::<Vec<_>>()
		};
		assert_eq!(
			signatures(GoogleRequestOptions {
				requires_skip_thought_signature_on_first_function_call: true,
				..Default::default()
			}),
			[Some(SKIP_THOUGHT_SIGNATURE.to_owned()), None],
			"only the first unsigned call of the message carries the sentinel",
		);
		assert_eq!(
			signatures(GoogleRequestOptions {
				requires_skip_thought_signature: true,
				..Default::default()
			}),
			[Some(SKIP_THOUGHT_SIGNATURE.to_owned()), Some(SKIP_THOUGHT_SIGNATURE.to_owned())],
			"the all-calls variant signs every unsigned call",
		);
		assert_eq!(signatures(GoogleRequestOptions::default()), [None, None]);
	}

	#[test]
	fn foreign_proof_is_omitted_not_fatal() {
		let provider = ProviderId::new("google");
		let codec_id = CodecId::new("gemini");
		let foreign = ProviderProof {
			provider: ProviderId::new("anthropic"),
			codec:    CodecId::new("anthropic"),
			value:    Bytes::from_static(b"claude-sig"),
		};
		let mut request = empty_chat_request();
		request.messages = vec![Message {
			role:    Role::Assistant,
			content: vec![
				ContentPart::Reasoning { text: sf!("plan"), proof: Some(foreign.clone()) },
				ContentPart::Text { text: sf!("answer"), proof: Some(foreign.clone()) },
				ContentPart::ToolCall {
					call:      ToolCallId::new("call-1"),
					name:      sf!("read"),
					arguments: opaque(r#"{"path":"note.txt"}"#),
					proof:     Some(foreign),
				},
			]
			.into(),
			name:    None,
		}]
		.into();
		let projection = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions {
				proof_scope: Some(GoogleProofScope { provider, codec: codec_id }),
				..Default::default()
			})
			.expect("a model switch omits foreign signatures instead of failing");
		let parts = &projection.request.contents[0].parts;
		assert_eq!(parts.len(), 3);
		assert!(parts.iter().all(|part| part.thought_signature.is_none()));
		assert_eq!(parts[0].text.as_deref(), Some("plan"));
		assert_eq!(
			parts[2]
				.function_call
				.as_ref()
				.map(|call| call.name.as_str()),
			Some("read")
		);
		assert_eq!(projection.adjustments, [GoogleAdjustment::new_static(
			FOREIGN_SIGNATURE_FEATURE,
			FOREIGN_SIGNATURE_REASON
		)]);
		assert!(
			projection.unplanned_adjustment(false).is_none(),
			"a foreign signature is not a planning gap"
		);

		let catalog = Catalog::embedded();
		let route = catalog
			.routes()
			.iter()
			.find(|route| route.codec.as_str() == "google-genai")
			.expect("Google GenerateContent route");
		let target = WireTarget {
			route:      route.id.clone(),
			codec:      route.codec.clone(),
			endpoint:   route.endpoint.clone(),
			wire_model: omp_catalog::WireModelId::new("gemini-2.5-flash"),
		};
		let request_id = RequestId::new("gemini-foreign-proof");
		let policy = policy::WirePolicy::baseline();
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy: &policy,
			..EncodeContext::default()
		};
		let encoded = GeminiCodec::generative_language(None)
			.encode(&context, &OperationCall::Chat(Arc::new(request)))
			.expect("foreign signatures omit on the live codec path");
		assert_eq!(encoded.adjustments, [Adjustment::Dropped {
			feature: FeatureId::new_static(FOREIGN_SIGNATURE_FEATURE),
			reason:  ReasonId::new_static(FOREIGN_SIGNATURE_REASON),
		}],);
	}

	#[test]
	fn supports_function_part_id_matches_pi_request_shape() {
		let mut request = empty_chat_request();
		request.messages = vec![tool_call_message()].into();
		let projection = GeminiCodec::vertex(None)
			.project(&request, &GoogleRequestOptions {
				supports_function_part_id: Some(true),
				..Default::default()
			})
			.expect("function ID projects from policy");
		assert_eq!(
			projection.request.contents[0].parts[0]
				.function_call
				.as_ref()
				.and_then(|call| call.id.as_deref()),
			Some("call-1"),
		);

		let omitted = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions {
				supports_function_part_id: Some(false),
				..Default::default()
			})
			.expect("unsupported function ID is omitted");
		assert!(
			omitted.request.contents[0].parts[0]
				.function_call
				.as_ref()
				.expect("function call")
				.id
				.is_none()
		);
	}

	#[test]
	fn strip_image_input_matches_pi_request_shape() {
		let mut request = empty_chat_request();
		request.messages = vec![Message {
			role:    Role::User,
			content: vec![
				ContentPart::Text { text: sf!("inspect"), proof: None },
				ContentPart::Image(MediaInput::Bytes {
					media_type: sf!("image/png"),
					data:       Bytes::from_static(&[1, 2, 3]),
				}),
			]
			.into(),
			name:    None,
		}]
		.into();
		let projection = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions { strip_image_input: true, ..Default::default() })
			.expect("image is replaced");
		let parts = &projection.request.contents[0].parts;
		assert_eq!(parts.len(), 2);
		assert_eq!(parts[1].text.as_deref(), Some(NON_VISION_IMAGE_PLACEHOLDER));
		assert!(parts[1].inline_data.is_none());
	}

	#[test]
	fn multimodal_function_response_matches_pi_request_shape() {
		let mut request = empty_chat_request();
		request.messages = vec![Message {
			role:    Role::Tool,
			content: vec![ContentPart::ToolResult {
				call:     ToolCallId::new("call-1"),
				name:     Some(sf!("read")),
				content:  vec![ToolResultContent::Image(MediaInput::Bytes {
					media_type: sf!("image/png"),
					data:       Bytes::from_static(&[1, 2, 3]),
				})]
				.into(),
				is_error: false,
			}]
			.into(),
			name:    None,
		}]
		.into();

		let nested = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions {
				multimodal_function_response: Some(true),
				..Default::default()
			})
			.expect("multimodal result projects");
		let response = nested.request.contents[0].parts[0]
			.function_response
			.as_ref()
			.expect("function response");
		assert_eq!(response.parts.len(), 1);
		assert_eq!(response.response.get(), r#"{"output":"(see attached image)"}"#);

		let legacy = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions {
				multimodal_function_response: Some(false),
				..Default::default()
			})
			.expect("legacy image result projects");
		assert!(
			legacy.request.contents[0].parts[0]
				.function_response
				.as_ref()
				.expect("function response")
				.parts
				.is_empty()
		);
		assert_eq!(legacy.request.contents[1].role, "user");
		assert_eq!(
			legacy.request.contents[1].parts[0].text.as_deref(),
			Some(TOOL_RESULT_IMAGE_LABEL),
		);
		assert!(legacy.request.contents[1].parts[1].inline_data.is_some());
	}

	#[test]
	fn schema_normalization_matches_oracle() {
		#[derive(Deserialize)]
		struct Behavior {
			cases: Vec<BehaviorCase>,
		}
		#[derive(Deserialize)]
		struct BehaviorCase {
			id:     Str,
			input:  Option<Box<RawValue>>,
			output: Option<Box<RawValue>>,
		}
		let behavior: Behavior = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/request.behavior.v1.json"
		))
		.expect("generated request behavior parses");
		let case = behavior
			.cases
			.into_iter()
			.find(|case| case.id.as_str() == "google.request.schema-normalization.v1")
			.expect("schema normalization case exists");
		let schema = GoogleSchema::from_opaque(&opaque(case.input.expect("schema input").get()))
			.expect("schema projects");
		let expected: GoogleSchema = serde_json::from_str(case.output.expect("schema output").get())
			.expect("typed expected schema");
		assert_eq!(
			serde_json::to_vec(&schema).expect("actual schema"),
			serde_json::to_vec(&expected).expect("expected schema"),
		);
	}
	#[test]
	fn cca_schema_normalization_matches_generated_oracle() {
		#[derive(Deserialize)]
		struct CcaBehavior {
			cases: Vec<CcaCase>,
		}
		#[derive(Deserialize)]
		struct CcaCase {
			id:     Str,
			input:  Option<Box<RawValue>>,
			output: Option<Box<RawValue>>,
		}

		let behavior: CcaBehavior = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/cca.behavior.v1.json"
		))
		.expect("CCA behavior oracle parses");
		let case = behavior
			.cases
			.into_iter()
			.find(|case| case.id.as_str() == "google.cca.tool-schema.v1")
			.expect("CCA tool-schema case is present");
		let mut actual: GoogleSchema =
			serde_json::from_str(case.input.expect("tool-schema input").get())
				.expect("tool-schema input is typed");
		actual.normalize_for_cca();
		let expected: GoogleSchema =
			serde_json::from_str(case.output.expect("tool-schema output").get())
				.expect("tool-schema output is typed");
		assert_eq!(
			serde_json::to_vec(&actual).expect("actual schema serializes"),
			serde_json::to_vec(&expected).expect("expected schema serializes"),
		);
	}
	#[test]
	fn google_and_cca_strip_protojson_unknown_annotations() {
		let input = r#"{
			"type":"object",
			"properties":{
				"annotated":{
					"type":"string",
					"deprecated":true,
					"readOnly":true,
					"writeOnly":true,
					"$comment":"internal",
					"x-mcp-header":"owner"
				},
				"x-mcp-header":{"type":"string"}
			}
		}"#;
		let expected = serde_json::json!({
			"type": "object",
			"properties": {
				"annotated": {"type": "string"},
				"x-mcp-header": {"type": "string"}
			}
		});

		let google = GoogleSchema::from_opaque(&opaque(input)).expect("Google schema projects");
		assert_eq!(serde_json::to_value(&google).expect("Google schema serializes"), expected,);

		let mut cca: GoogleSchema = serde_json::from_str(input).expect("CCA schema input is typed");
		cca.normalize_for_cca();
		assert_eq!(serde_json::to_value(&cca).expect("CCA schema serializes"), expected,);
	}

	#[test]
	fn provider_options_and_cache_have_exact_conditional_fields() {
		let codec = GeminiCodec::generative_language(None);
		let cached = codec
			.project(&empty_chat_request(), &GoogleRequestOptions {
				cached_content: Some("cachedContents/oracle".into()),
				..Default::default()
			})
			.expect("cached content projects");
		assert_eq!(
			serde_json::to_string(&cached.request).expect("cached request serializes"),
			r#"{"contents":[],"cachedContent":"cachedContents/oracle"}"#,
		);

		let options = GoogleRequestOptions {
			safety_settings: vec![GoogleSafetySetting {
				category:  "HARM_CATEGORY_HARASSMENT".into(),
				threshold: "OFF".into(),
			}],
			response_modalities: vec!["TEXT".into()],
			google_search: true,
			code_execution: true,
			..Default::default()
		};
		let projected = codec
			.project(&empty_chat_request(), &options)
			.expect("explicit provider options project");
		assert_eq!(projected.request.safety_settings, options.safety_settings);
		assert_eq!(
			projected
				.request
				.generation_config
				.as_ref()
				.map(|config| config.response_modalities.as_slice()),
			Some(options.response_modalities.as_slice()),
		);
		assert_eq!(projected.request.tools.len(), 2);
		assert!(projected.request.tools[0].google_search.is_some());
		assert!(projected.request.tools[1].code_execution.is_some());

		let mut system_request = empty_chat_request();
		system_request.messages = vec![Message {
			role:    Role::System,
			content: vec![ContentPart::Text { text: "system".into(), proof: None }].into(),
			name:    None,
		}]
		.into();
		let error = codec
			.project(&system_request, &GoogleRequestOptions {
				cached_content: Some("cachedContents/oracle".into()),
				..Default::default()
			})
			.expect_err("cache and system instruction conflict");
		assert_eq!(
			error.detail.as_str(),
			"google/cached_content cannot be combined with request-level systemInstruction",
		);
	}

	#[test]
	fn generated_thinking_cases_all_match_typed_policies() {
		#[derive(Deserialize)]
		struct Behavior {
			cases: Vec<BehaviorCase>,
		}
		#[derive(Deserialize)]
		struct BehaviorCase {
			id:    Str,
			cases: Option<Box<RawValue>>,
		}
		#[derive(Deserialize)]
		struct ThinkingCase {
			input:         ThinkingInput,
			legacy:        GoogleThinkingConfig,
			budget_policy: Option<GoogleThinkingConfig>,
		}
		#[derive(Deserialize)]
		struct ThinkingInput {
			effort:        Option<ReasoningEffort>,
			budget_tokens: Option<u64>,
			#[serde(default)]
			hide_summary:  bool,
		}

		let behavior: Behavior = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/request.behavior.v1.json"
		))
		.expect("generated request behavior parses");
		let raw_cases = behavior
			.cases
			.into_iter()
			.find(|case| case.id.as_str() == "google.request.thinking.v1")
			.and_then(|case| case.cases)
			.expect("thinking oracle case exists");
		let cases: Vec<ThinkingCase> =
			serde_json::from_str(raw_cases.get()).expect("thinking cases are typed");
		assert_eq!(cases.len(), 8);
		let budgets = GoogleThinkingBudgets {
			minimal: 1_024,
			low:     2_048,
			medium:  8_192,
			high:    16_384,
			xhigh:   32_768,
			maximum: 65_536,
		};
		for case in cases {
			let request = ReasoningRequest {
				visibility:          if case.input.hide_summary {
					ReasoningVisibility::Hidden
				} else {
					ReasoningVisibility::Visible
				},
				effort:              case.input.effort,
				max_tokens:          case.input.budget_tokens,
				preserve_signatures: false,
			};
			if request.max_tokens.is_none() {
				let actual = GeminiCodec::generative_language(Some(GoogleThinkingPolicy::Level))
					.project_reasoning(&request)
					.expect("level thinking case projects");
				assert_eq!(
					serde_json::to_vec(&actual).expect("actual level config"),
					serde_json::to_vec(&case.legacy).expect("oracle level config"),
				);
			}
			if let Some(expected) = case.budget_policy {
				let actual =
					GeminiCodec::generative_language(Some(GoogleThinkingPolicy::Budget(budgets)))
						.project_reasoning(&request)
						.expect("budget thinking case projects");
				assert_eq!(
					serde_json::to_vec(&actual).expect("actual budget config"),
					serde_json::to_vec(&expected).expect("oracle budget config"),
				);
			} else if request.max_tokens.is_some() {
				let actual =
					GeminiCodec::generative_language(Some(GoogleThinkingPolicy::Budget(budgets)))
						.project_reasoning(&request)
						.expect("explicit hidden budget projects");
				assert_eq!(
					serde_json::to_vec(&actual).expect("actual explicit budget"),
					serde_json::to_vec(&case.legacy).expect("oracle explicit budget"),
				);
			}
		}
	}

	#[test]
	fn generated_cca_thinking_off_cases_match_resolved_projection() {
		#[derive(Deserialize)]
		struct Behavior {
			cases: Vec<BehaviorCase>,
		}
		#[derive(Deserialize)]
		struct BehaviorCase {
			id:    Str,
			cases: Option<Box<RawValue>>,
		}
		#[derive(Deserialize)]
		struct OffCase {
			policy_mode: Str,
			output:      GoogleThinkingConfig,
		}

		let behavior: Behavior = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/cca.behavior.v1.json"
		))
		.expect("generated CCA behavior parses");
		let raw_cases = behavior
			.cases
			.into_iter()
			.find(|case| case.id.as_str() == "google.cca.thinking-off.v1")
			.and_then(|case| case.cases)
			.expect("CCA thinking-off cases exist");
		let cases: Vec<OffCase> =
			serde_json::from_str(raw_cases.get()).expect("CCA thinking-off cases are typed");
		assert_eq!(cases.len(), 2);
		for case in cases {
			let (mode, native_effort, budget) = match case.policy_mode.as_str() {
				"google_level" => (ThinkingMode::GoogleLevel, Some(sf!("LOW")), None),
				"budget" => (ThinkingMode::Budget, None, Some(0)),
				other => panic!("unknown CCA thinking mode {other}"),
			};
			let policy =
				ThinkingPolicy::new(mode, [ThinkingEffort::Low]).expect("valid CCA thinking policy");
			let selection = ThinkingSelection {
				effort: ThinkingEffort::Off,
				wire_effort: ThinkingEffort::Off,
				native_effort,
				budget,
				wire_model: omp_catalog::WireModelId::new("cca-wire-model"),
				reasoning_mode: None,
				suppress_when_off: false,
				adaptive_tag_only: false,
			};
			let mut request = empty_chat_request();
			request.reasoning = Setting::Require(ReasoningRequest {
				visibility:          ReasoningVisibility::Visible,
				effort:              Some(ReasoningEffort::Off),
				max_tokens:          None,
				preserve_signatures: false,
			});
			let actual = GeminiCodec::cloud_code_assist(None)
				.project_for_encode(
					&request,
					&GoogleRequestOptions::default(),
					Some(&policy),
					Some(&selection),
				)
				.expect("resolved CCA thinking-off projects")
				.request
				.generation_config
				.and_then(|generation| generation.thinking_config)
				.expect("CCA thinking-off config");
			assert_eq!(
				serde_json::to_vec(&actual).expect("actual CCA off config"),
				serde_json::to_vec(&case.output).expect("oracle CCA off config"),
			);
		}
	}

	#[test]
	fn generated_part_cases_all_match_typed_projection() {
		#[derive(Deserialize)]
		struct Behavior {
			cases: Vec<BehaviorCase>,
		}
		#[derive(Deserialize)]
		struct BehaviorCase {
			id:    Str,
			cases: Option<Box<RawValue>>,
		}
		#[derive(Deserialize)]
		struct PartCase {
			canonical:         CanonicalPart,
			wire:              Option<Box<RawValue>>,
			typed_unsupported: Option<UnsupportedPart>,
		}
		#[derive(Deserialize)]
		#[serde(tag = "type", rename_all = "snake_case")]
		enum CanonicalPart {
			Text {
				text: Str,
			},
			Thinking {
				text:      Str,
				signature: Str,
			},
			InlineBlob {
				mime:      Str,
				bytes_hex: Str,
			},
			FileBlob {
				mime:   Str,
				#[serde(rename = "google/file_data")]
				remote: CanonicalRemote,
			},
			EmptyBlob {
				#[serde(rename = "google/file_data")]
				_remote: Option<CanonicalRemote>,
			},
		}
		#[derive(Deserialize)]
		struct CanonicalRemote {
			file_uri:  Str,
			mime_type: Str,
		}
		#[derive(Deserialize)]
		struct UnsupportedPart {
			what:   Str,
			detail: Str,
		}

		let behavior: Behavior = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/request.behavior.v1.json"
		))
		.expect("generated request behavior parses");
		let raw_cases = behavior
			.cases
			.into_iter()
			.find(|case| case.id.as_str() == "google.request.parts.v1")
			.and_then(|case| case.cases)
			.expect("parts oracle case exists");
		let cases: Vec<PartCase> =
			serde_json::from_str(raw_cases.get()).expect("part cases are typed");
		assert_eq!(cases.len(), 5);
		let provider = ProviderId::new("google");
		let codec_id = CodecId::new("gemini");
		for case in cases {
			let mut options = GoogleRequestOptions {
				proof_scope: Some(GoogleProofScope {
					provider: provider.clone(),
					codec:    codec_id.clone(),
				}),
				..GoogleRequestOptions::default()
			};
			let (role, content) = match case.canonical {
				CanonicalPart::Text { text } => (Role::User, ContentPart::Text { text, proof: None }),
				CanonicalPart::Thinking { text, signature } => {
					(Role::Assistant, ContentPart::Reasoning {
						text,
						proof: Some(ProviderProof {
							provider: provider.clone(),
							codec:    codec_id.clone(),
							value:    Bytes::copy_from_slice(signature.as_bytes()),
						}),
					})
				},
				CanonicalPart::InlineBlob { mime, bytes_hex } => {
					assert_eq!(bytes_hex.len() % 2, 0);
					let bytes = (0..bytes_hex.len())
						.step_by(2)
						.map(|index| {
							u8::from_str_radix(&bytes_hex[index..index + 2], 16).expect("oracle hex byte")
						})
						.collect::<Vec<_>>();
					(
						Role::User,
						ContentPart::Image(MediaInput::Bytes {
							media_type: mime,
							data:       Bytes::from(bytes),
						}),
					)
				},
				CanonicalPart::FileBlob { mime, remote } => {
					options.remote_files.insert((0, 0), GoogleFileData {
						file_uri:  remote.file_uri,
						mime_type: remote.mime_type,
					});
					(
						Role::User,
						ContentPart::Document(MediaInput::Bytes {
							media_type: mime,
							data:       Bytes::new(),
						}),
					)
				},
				CanonicalPart::EmptyBlob { _remote: None } => (
					Role::User,
					ContentPart::Image(MediaInput::Bytes {
						media_type: "application/octet-stream".into(),
						data:       Bytes::new(),
					}),
				),
				CanonicalPart::EmptyBlob { _remote: Some(_) } => {
					panic!("empty-blob oracle unexpectedly carried remote data")
				},
			};
			let mut request = empty_chat_request();
			request.messages =
				vec![Message { role, content: vec![content].into(), name: None }].into();
			let projection = GeminiCodec::generative_language(None)
				.project(&request, &options)
				.expect("part projects");
			match (case.wire, case.typed_unsupported) {
				(Some(expected), None) => {
					let actual = projection
						.request
						.contents
						.first()
						.and_then(|content| content.parts.first())
						.expect("projected wire part");
					let expected: GooglePart =
						serde_json::from_str(expected.get()).expect("typed expected wire part");
					assert_eq!(
						serde_json::to_vec(actual).expect("actual part"),
						serde_json::to_vec(&expected).expect("expected part"),
					);
					assert!(projection.adjustments.is_empty());
				},
				(None, Some(expected)) => {
					assert!(projection.request.contents.is_empty());
					assert_eq!(projection.adjustments.len(), 1);
					assert_eq!(projection.adjustments[0].what, expected.what);
					assert_eq!(projection.adjustments[0].detail, expected.detail);
				},
				_ => panic!("part oracle must have exactly one expected outcome"),
			}
		}
	}
	#[test]
	fn typed_unsupported_intent_is_reported_without_silent_drops() {
		let mut request = empty_chat_request();
		request.messages = vec![
			Message {
				role:    Role::System,
				content: vec![ContentPart::Image(MediaInput::Bytes {
					media_type: "image/png".into(),
					data:       Bytes::from_static(&[1]),
				})]
				.into(),
				name:    None,
			},
			Message {
				role:    Role::User,
				content: vec![ContentPart::CachePoint(crate::call::CacheRetention::Session)].into(),
				name:    None,
			},
		]
		.into();
		request.output = Setting::Prefer(StructuredOutput::Regex("a+".into()));
		request.sampling.frequency_penalty = Some(0.5);
		request.sampling.presence_penalty = Some(0.25);
		request.tools = vec![ToolDefinition {
			name:        "lookup".into(),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: opaque(r#"{"type":"object"}"#),
				strict:     true,
			},
		}]
		.into();
		let projection = GeminiCodec::generative_language(None)
			.project(&request, &GoogleRequestOptions::default())
			.expect("optional unsupported intent is explicitly adjusted");
		let whats = projection
			.adjustments
			.iter()
			.map(|adjustment| adjustment.what.as_str())
			.collect::<BTreeSet<_>>();
		assert_eq!(
			whats,
			BTreeSet::from([
				"cache",
				"response_format.grammar",
				"sampling.frequency_penalty",
				"sampling.presence_penalty",
				"thread.system.parts",
				"tools.lookup.strict",
			]),
		);
	}

	#[test]
	fn preferred_portable_grammar_encodes_as_plain_generate_content() {
		let catalog = Catalog::embedded();
		let route = catalog
			.routes()
			.iter()
			.find(|route| route.codec.as_str() == "google-genai")
			.expect("Google GenerateContent route");
		let target = WireTarget {
			route:      route.id.clone(),
			codec:      route.codec.clone(),
			endpoint:   route.endpoint.clone(),
			wire_model: omp_catalog::WireModelId::new("gemini-2.5-flash"),
		};
		let request_id = RequestId::new("gemini-preferred-grammar");
		let policy = policy::WirePolicy::baseline();
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy: &policy,
			..EncodeContext::default()
		};
		let mut request = empty_chat_request();
		request.output = Setting::Prefer(StructuredOutput::Regex(sf!("^[A-Z]+$")));
		let encoded = GeminiCodec::generative_language(None)
			.encode(&context, &OperationCall::Chat(Arc::new(request)))
			.expect("preferred grammar is downgraded, not rejected");
		let BodySource::Bytes(body) = encoded.body else {
			panic!("GenerateContent request is buffered JSON");
		};
		let body: serde_json::Value = serde_json::from_slice(&body).expect("request JSON");
		assert!(
			body.pointer("/generationConfig/responseMimeType").is_none(),
			"dropped grammar must not become JSON mode"
		);
	}

	#[test]
	fn encode_projection_uses_resolved_thinking_selection() {
		let selection = ThinkingSelection {
			effort:            ThinkingEffort::High,
			wire_effort:       ThinkingEffort::High,
			native_effort:     Some("HIGH".into()),
			budget:            None,
			wire_model:        omp_catalog::WireModelId::new("gemini-selected"),
			reasoning_mode:    None,
			suppress_when_off: false,
			adaptive_tag_only: false,
		};
		let policy = ThinkingPolicy::new(ThinkingMode::GoogleLevel, [ThinkingEffort::High])
			.expect("valid thinking policy");
		let projection = GeminiCodec::generative_language(Some(GoogleThinkingPolicy::Level))
			.project_for_encode(
				&ChatRequest {
					messages:          Arc::from([]),
					tools:             Arc::from([]),
					hosted_tools:      Arc::from([]),
					tool_choice:       Setting::Unset,
					output:            Setting::Unset,
					reasoning:         Setting::Unset,
					verbosity:         Setting::Unset,
					cache_retention:   Setting::Unset,
					service_tier:      Setting::Unset,
					sampling:          CallSampling::default(),
					max_output_tokens: None,
					top_logprobs:      None,
					safety:            Arc::from([]),
					negotiation:       Default::default(),
					forced_call:       None,
				},
				&GoogleRequestOptions::default(),
				Some(&policy),
				Some(&selection),
			)
			.expect("resolved selection projects");
		let thinking = projection
			.request
			.generation_config
			.and_then(|generation| generation.thinking_config)
			.expect("thinking config");
		assert_eq!(thinking.thinking_level.as_deref(), Some("HIGH"));
		assert_eq!(thinking.thinking_budget, None);
	}

	#[test]
	fn xhigh_and_max_efforts_spell_googles_high_ceiling() {
		// HIGH is the top level; the API treats THINKING_LEVEL_UNSPECIFIED as unset.
		for effort in [ReasoningEffort::High, ReasoningEffort::Xhigh, ReasoningEffort::Max] {
			assert_eq!(thinking_level(effort).as_str(), "HIGH", "{effort:?}");
		}
		for effort in [ThinkingEffort::High, ThinkingEffort::XHigh, ThinkingEffort::Max] {
			assert_eq!(selection_thinking_level(effort).as_str(), "HIGH", "{effort:?}");
		}
	}

	#[test]
	fn cca_minimal_aliased_onto_the_low_sku_sends_low_level() {
		// Cloud Code Assist Gemini 3.6/3.7 Flash aliases `minimal` onto the same
		// `-low` wire SKU as `low`; that SKU rejects
		// `thinkingLevel: MINIMAL` with HTTP 400, so the wire must spell LOW.
		let policy = ThinkingPolicy::new(ThinkingMode::GoogleLevel, [
			ThinkingEffort::Minimal,
			ThinkingEffort::Low,
			ThinkingEffort::Medium,
			ThinkingEffort::High,
		])
		.expect("valid thinking policy");
		let mut routing = omp_catalog::ThinkingRouting::default();
		routing
			.effort_routing
			.insert(ThinkingEffort::Minimal, "gemini-3.7-flash-low".into());
		routing
			.effort_routing
			.insert(ThinkingEffort::Low, "gemini-3.7-flash-low".into());
		routing
			.effort_routing
			.insert(ThinkingEffort::Medium, "gemini-3.7-flash-medium".into());
		let selection = routing
			.resolve(
				&policy,
				Some(ThinkingEffort::Minimal),
				omp_catalog::WireModelId::from_ref("gemini-3.7-flash"),
			)
			.expect("minimal resolves");
		assert_eq!(selection.wire_model, "gemini-3.7-flash-low");
		let mut request = empty_chat_request();
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Visible,
			effort:              Some(ReasoningEffort::Minimal),
			max_tokens:          None,
			preserve_signatures: false,
		});
		let thinking = GeminiCodec::cloud_code_assist(None)
			.project_for_encode(
				&request,
				&GoogleRequestOptions::default(),
				Some(&policy),
				Some(&selection),
			)
			.expect("aliased minimal projects")
			.request
			.generation_config
			.and_then(|generation| generation.thinking_config)
			.expect("thinking config");
		assert_eq!(thinking.thinking_level.as_deref(), Some("LOW"));
	}

	#[test]
	fn real_vertex_projection_matches_generated_oracle() {
		let provider = ProviderId::new("google-vertex");
		let codec_id = CodecId::new("google-vertex");
		let proof = ProviderProof {
			provider: provider.clone(),
			codec:    codec_id.clone(),
			value:    Bytes::from_static(b"sig_REDACTED"),
		};
		let call = ToolCallId::new("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		let request = ChatRequest {
			messages:          vec![
				Message {
					role:    Role::System,
					content: vec![ContentPart::Text { text: "Use evidence only.".into(), proof: None }]
						.into(),
					name:    None,
				},
				Message {
					role:    Role::User,
					content: vec![
						ContentPart::Text { text: "Inspect both attachments.".into(), proof: None },
						ContentPart::Image(MediaInput::Bytes {
							media_type: "image/png".into(),
							data:       Bytes::from_static(&[0, 1, 2, 255]),
						}),
						ContentPart::Document(MediaInput::Remote {
							uri:        "gs://oracle-bucket/document.pdf".into(),
							media_type: Some("application/pdf".into()),
							name:       None,
						}),
					]
					.into(),
					name:    None,
				},
				Message {
					role:    Role::Assistant,
					content: vec![ContentPart::ToolCall {
						call:      call.clone(),
						name:      "lookup".into(),
						arguments: opaque(r#"{"q":"oracle"}"#),
						proof:     Some(proof),
					}]
					.into(),
					name:    None,
				},
				Message {
					role:    Role::Tool,
					content: vec![ContentPart::ToolResult {
						call,
						name: Some("lookup".into()),
						content: vec![ToolResultContent::Text("found".into())].into(),
						is_error: false,
					}]
					.into(),
					name:    None,
				},
			]
			.into(),
			tools:             vec![ToolDefinition {
				name:        "lookup".into(),
				description: Some("Look up a record".into()),
				input:       ToolInputConstraint::JsonSchema {
					parameters: opaque(
						r#"{"type":"object","properties":{"q":{"type":["string","null"]}},"required":["q"]}"#,
					),
					strict:     false,
				},
			}]
			.into(),
			hosted_tools:      Arc::from([]),
			tool_choice:       Setting::Require(ToolChoice::Named("lookup".into())),
			output:            Setting::Unset,
			reasoning:         Setting::Require(ReasoningRequest {
				visibility:          ReasoningVisibility::Visible,
				effort:              Some(ReasoningEffort::High),
				max_tokens:          None,
				preserve_signatures: true,
			}),
			verbosity:         Setting::Unset,
			cache_retention:   Setting::Unset,
			service_tier:      Setting::Unset,
			sampling:          CallSampling {
				temperature:        Some(0.2),
				top_p:              Some(0.9),
				top_k:              Some(32),
				min_p:              None,
				seed:               None,
				stop:               vec!["END".into()].into(),
				presence_penalty:   None,
				frequency_penalty:  None,
				repetition_penalty: None,
			},
			max_output_tokens: Some(2048),
			top_logprobs:      None,
			safety:            vec![
				SafetySetting {
					category:  "HARM_CATEGORY_HATE_SPEECH".into(),
					threshold: SafetyThreshold::Off,
				},
				SafetySetting {
					category:  "HARM_CATEGORY_DANGEROUS_CONTENT".into(),
					threshold: SafetyThreshold::Off,
				},
				SafetySetting {
					category:  "HARM_CATEGORY_HARASSMENT".into(),
					threshold: SafetyThreshold::Off,
				},
				SafetySetting {
					category:  "HARM_CATEGORY_SEXUALLY_EXPLICIT".into(),
					threshold: SafetyThreshold::Off,
				},
			]
			.into(),
			negotiation:       Default::default(),
			forced_call:       None,
		};
		let options = GoogleRequestOptions {
			response_modalities: vec!["TEXT".into()],
			proof_scope: Some(GoogleProofScope { provider, codec: codec_id }),
			inline_tool_descriptors: InlineToolDescriptorsMode::Off,
			..Default::default()
		};
		let projection = GeminiCodec::vertex(Some(GoogleThinkingPolicy::Level))
			.project(&request, &options)
			.expect("Vertex projection");
		assert!(projection.adjustments.is_empty());
		let actual = serde_json::to_value(projection.request).expect("request serializes");
		#[derive(Deserialize)]
		struct Oracle {
			wire_body: Value,
		}
		let oracle: Oracle = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/vertex.encoder.v1.json"
		))
		.expect("generated oracle parses");
		assert_eq!(actual, oracle.wire_body);
	}

	#[test]
	fn stream_projects_thought_tool_usage_and_finish() {
		let mut decoder = GeminiDecoder::default();
		let first = decoder.push_json(br#"{"candidates":[{"content":{"parts":[{"text":"plan","thought":true,"thoughtSignature":"sig"}]}}]}"#)
			.expect("thought frame");
		assert!(
			matches!(&first[0], GoogleDecodedEvent::Thinking { text, signature: Some(signature), .. } if text.as_str() == "plan" && signature.as_str() == "sig")
		);
		let last = decoder.push_json(br#"{"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{}},"thoughtSignature":"tool-sig"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":9,"cachedContentTokenCount":5,"thoughtsTokenCount":3}}"#)
			.expect("terminal frame");
		assert!(last.iter().any(|event| matches!(event, GoogleDecodedEvent::FunctionCall { name, .. } if name.as_str() == "lookup")));
		assert!(last.iter().any(|event| matches!(
			event,
			GoogleDecodedEvent::Usage(Usage {
				input_tokens: 7,
				output_tokens: 12,
				reasoning_tokens: 3,
				cache_read_tokens: 5,
				..
			})
		)));
		assert!(
			last.iter().any(|event| matches!(
				event,
				GoogleDecodedEvent::Completed(GoogleFinishReason::EndTurn)
			))
		);
	}
	#[test]
	fn signature_only_parts_attach_to_active_text_and_thinking_blocks() {
		let mut text_decoder = GeminiDecoder::default();
		let text = text_decoder
			.push_json(
				br#"{"candidates":[{"content":{"parts":[{"text":"answer"},{"text":"","thoughtSignature":"text-sig"}]}}]}"#,
			)
			.expect("text signature frame decodes");
		assert!(matches!(
			text.as_slice(),
			[
				GoogleDecodedEvent::Text { index: 0, text, signature: None },
				GoogleDecodedEvent::Signature { index: 0, signature },
			] if text.as_str() == "answer" && signature.as_str() == "text-sig"
		));

		let mut thinking_decoder = GeminiDecoder::default();
		let thinking = thinking_decoder
			.push_json(
				br#"{"candidates":[{"content":{"parts":[{"text":"plan","thought":true},{"text":"","thoughtSignature":"thinking-sig"}]}}]}"#,
			)
			.expect("thinking signature frame decodes");
		assert!(matches!(
			thinking.as_slice(),
			[
				GoogleDecodedEvent::Thinking { index: 0, text, signature: None },
				GoogleDecodedEvent::Signature { index: 0, signature },
			] if text.as_str() == "plan" && signature.as_str() == "thinking-sig"
		));
	}

	#[test]
	fn non_contiguous_text_parts_receive_new_block_indexes() {
		let mut decoder = GeminiDecoder::default();
		let events = decoder
			.push_json(
				br#"{"candidates":[{"content":{"parts":[{"text":"before"},{"functionCall":{"name":"lookup","args":{}}},{"text":"after"}]},"finishReason":"STOP"}]}"#,
			)
			.expect("interleaved parts decode");
		let indexes = events
			.iter()
			.filter_map(|event| match event {
				GoogleDecodedEvent::Text { index, .. }
				| GoogleDecodedEvent::FunctionCall { index, .. } => Some(*index),
				_ => None,
			})
			.collect::<Vec<_>>();
		assert_eq!(indexes, [0, 1, 2]);
	}

	#[test]
	fn leaked_thinking_fence_openers_are_stripped_from_thought_parts() {
		// Gemini thought summaries occasionally emit a bare ```thinking opener
		// line as a between-summary delimiter; structured
		// thought parts bypass the visible-channel healers, so the decoder
		// strips it while preserving legitimate fenced code.
		let mut decoder = GeminiDecoder::default();
		let mut thinking = String::new();
		let mut collect = |events: Vec<GoogleDecodedEvent>| {
			for event in events {
				if let GoogleDecodedEvent::Thinking { text, .. } = event {
					thinking.push_str(text.as_str());
				}
			}
		};
		collect(
			decoder
				.push_json(br#"{"candidates":[{"content":{"parts":[{"text":"```thinking\nplan","thought":true}]}}]}"#)
				.expect("first thought frame"),
		);
		collect(
			decoder
				.push_json(br#"{"candidates":[{"content":{"parts":[{"text":"\n```rs\ncode\n```","thought":true}]},"finishReason":"STOP"}]}"#)
				.expect("terminal thought frame"),
		);
		assert_eq!(thinking, "plan\n```rs\ncode\n```");
	}

	#[test]
	fn recorded_semantic_stream_projects_canonical_tool_completion() {
		let mut decoder = CanonicalGeminiDecoder::default();

		let mut events = Vec::new();
		for data in include_str!(
			"../../../../fixtures/llm-oracle/google/recorded/google_genai/stream.semantic_parity.sse"
		)
		.lines()
		.filter_map(|line| line.strip_prefix("data: "))
		{
			decoder
				.push(Frame::Raw(Bytes::copy_from_slice(data.as_bytes())), &mut |event| {
					events.push(event);
				})
				.expect("recorded Google frame decodes");
		}
		decoder
			.finish(&mut |event| events.push(event))
			.expect("recorded Google stream finishes");

		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::ThinkingDelta { text, .. }) if text.as_str() == "plan"
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::ToolCallStarted { id, name, .. })
				if id.as_str() == "wire-call-1" && name.as_str() == "lookup"
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::ToolArgumentsDelta { bytes, .. })
				if bytes.as_ref() == br#"{"q":"rust"}"#
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::Grounding { .. })
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::Citations { .. })
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::SafetyRatings { .. })
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::AuxiliaryPart { kind, label, .. })
				if kind.as_str() == "executable_code" && label.as_deref() == Some("PYTHON")
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::AuxiliaryPart { kind, label, .. })
				if kind.as_str() == "code_execution_result"
					&& label.as_deref() == Some("OUTCOME_OK")
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::Usage(UsageUpdate {
				usage: Usage {
					input_tokens: 7,
					output_tokens: 12,
					reasoning_tokens: 3,
					cache_read_tokens: 5,
					..
				},
				..
			}))
		)));
		assert!(matches!(
			events.last(),
			Some(RawEvent::Completion(RawCompletion {
				reason: FinishReason::ToolCalls,
				blocks: 4,
				usage:  Usage {
					input_tokens: 7,
					output_tokens: 12,
					reasoning_tokens: 3,
					cache_read_tokens: 5,
					..
				},
			}))
		));
	}
	#[test]
	fn generated_auxiliary_parts_preserve_kind_label_and_text() {
		#[derive(Deserialize)]
		struct StreamOracle {
			auxiliary_parts: AuxiliaryParts,
		}
		#[derive(Deserialize)]
		#[serde(rename_all = "camelCase")]
		struct AuxiliaryParts {
			executable_code:       AuxiliaryProjection,
			code_execution_result: AuxiliaryProjection,
		}
		#[derive(Deserialize)]
		struct AuxiliaryProjection {
			#[serde(rename = "props.google/part_kind")]
			kind: Str,
		}
		let oracle: StreamOracle = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/stream.behavior.v1.json"
		))
		.expect("generated stream behavior parses");
		let mut decoder = CanonicalGeminiDecoder::default();
		let mut events = Vec::new();
		decoder
			.push(
				Frame::Raw(Bytes::from_static(
					br#"{
				"candidates":[{
					"content":{"parts":[
						{"executableCode":{"language":"PYTHON","code":"print(1)"}},
						{"codeExecutionResult":{"outcome":"OUTCOME_OK","output":"1\n"}}
					]},
					"finishReason":"STOP"
				}]
			}"#,
				)),
				&mut |event| events.push(event),
			)
			.expect("auxiliary parts decode");
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::AuxiliaryPart { kind, label, .. })
				if kind == &oracle.auxiliary_parts.executable_code.kind
					&& label.as_deref() == Some("PYTHON")
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Metadata(ProviderMetadataEvent::AuxiliaryPart { kind, label, .. })
				if kind == &oracle.auxiliary_parts.code_execution_result.kind
					&& label.as_deref() == Some("OUTCOME_OK")
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::TextDelta { text, .. }) if text.as_str() == "print(1)"
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::TextDelta { text, .. }) if text.as_str() == "1\n"
		)));
	}

	#[test]
	fn generated_finish_reason_oracle_is_exhaustive() {
		#[derive(Deserialize)]
		struct StreamOracle {
			finish_reasons: BTreeMap<Str, FinishExpectation>,
		}
		#[derive(Deserialize)]
		#[serde(untagged)]
		enum FinishExpectation {
			Reason(Str),
			Error { error: Str },
		}

		let oracle: StreamOracle = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/stream.behavior.v1.json"
		))
		.expect("generated stream oracle parses");
		for (wire, expected) in oracle.finish_reasons {
			match expected {
				FinishExpectation::Reason(expected) => {
					let actual = map_finish_reason(wire.as_str())
						.unwrap_or_else(|error| panic!("{wire} unexpectedly failed: {error}"));
					let expected = match expected.as_str() {
						"end_turn" => GoogleFinishReason::EndTurn,
						"max_tokens" => GoogleFinishReason::MaxTokens,
						"content_filter" => GoogleFinishReason::ContentFilter,
						other => panic!("unknown generated canonical finish reason: {other}"),
					};
					assert_eq!(actual, expected, "{wire}");
				},
				FinishExpectation::Error { error } => {
					let actual = map_finish_reason(wire.as_str())
						.expect_err("generated failure reason must remain an error");
					assert_eq!(actual.detail, error, "{wire}");
				},
			}
		}
	}

	#[test]
	fn malformed_and_incomplete_streams_are_terminal_once() {
		let mut malformed = GeminiDecoder::default();
		assert!(matches!(
			malformed.push_json(b"not-json"),
			Err(GoogleCodecError { kind: GoogleCodecErrorKind::Decode, .. })
		));
		let mut incomplete = GeminiDecoder::default();
		assert!(
			matches!(&incomplete.finish().expect("finish")[0], GoogleDecodedEvent::Error(error) if error.detail.as_str() == "Google stream ended without a finish reason")
		);
		assert!(incomplete.finish().expect("idempotent finish").is_empty());
	}

	#[test]
	fn structured_google_rpc_rate_limits_classify_quota_and_backoff() {
		let quota = decode_google_error(&google_rpc_429("QUOTA_EXHAUSTED", Some("21600s")));
		assert_eq!(quota.kind, GoogleCodecErrorKind::QuotaExhausted);
		assert_eq!(quota.retry_after_ms, 21_600_000);
		assert_eq!(quota.code.as_deref(), Some("QUOTA_EXHAUSTED"));
		assert_eq!(quota.clone().into_inference(true).action, RetryAction::Never);
		let inference = quota.into_inference(false);
		assert_eq!(inference.kind, ErrorKind::QuotaExhausted);
		assert_eq!(inference.phase, ErrorPhase::Streaming);
		assert_eq!(inference.action, RetryAction::RotateAccount);

		for (reason, retry_delay, expected_kind, expected_delay) in [
			("RATE_LIMIT_EXCEEDED", Some("30s"), GoogleCodecErrorKind::RateLimited, 30_000),
			("RATE_LIMIT_EXCEEDED", None, GoogleCodecErrorKind::RateLimited, 1_000),
			("RATE_LIMIT_EXCEEDED", Some("300s"), GoogleCodecErrorKind::QuotaExhausted, 300_000),
			("RATE_LIMIT_EXCEEDED", Some("21600s"), GoogleCodecErrorKind::QuotaExhausted, 21_600_000),
			("RATE_LIMIT_EXCEEDED", Some("0.5s"), GoogleCodecErrorKind::RateLimited, 500),
		] {
			let actual = decode_google_error(&google_rpc_429(reason, retry_delay));
			assert_eq!(actual.kind, expected_kind, "{reason} {retry_delay:?}");
			assert_eq!(actual.retry_after_ms, expected_delay, "{reason} {retry_delay:?}");
			assert_eq!(actual.code.as_deref(), Some(reason));
			if retry_delay == Some("30s") {
				assert_eq!(actual.into_inference(false).action, RetryAction::SameRoute {
					after: std::time::Duration::from_secs(30),
				});
			}
		}

		let credits = decode_google_error(&google_rpc_429(" insufficient_g1_credits_balance ", None));
		assert_eq!(credits.kind, GoogleCodecErrorKind::QuotaExhausted);
		assert_eq!(credits.retry_after_ms, 1_000);
		assert_eq!(credits.code.as_deref(), Some("INSUFFICIENT_G1_CREDITS_BALANCE"));

		let plain = decode_google_error(
			r#"{"error":{"code":429,"message":"Too many requests","status":"RESOURCE_EXHAUSTED"}}"#,
		);
		assert_eq!(plain.kind, GoogleCodecErrorKind::RateLimited);
		assert_eq!(plain.retry_after_ms, 1_000);
		assert_eq!(plain.code.as_deref(), Some("RESOURCE_EXHAUSTED"));
	}

	#[test]
	fn generated_error_shapes_are_typed_and_terminal() {
		#[derive(Deserialize)]
		struct StreamOracle {
			errors: Vec<ErrorCase>,
		}
		#[derive(Deserialize)]
		struct ErrorCase {
			input:  Box<RawValue>,
			output: ErrorOutput,
		}
		#[derive(Deserialize)]
		struct WireErrorInput {
			code:    Option<u16>,
			status:  Option<Str>,
			message: Option<Str>,
		}
		#[derive(Deserialize)]
		struct ErrorOutput {
			kind:           Str,
			detail:         Option<Str>,
			retry_after_ms: Option<u64>,
		}
		let oracle: StreamOracle = serde_json::from_str(include_str!(
			"../../../../fixtures/llm-oracle/google/generated/stream.behavior.v1.json"
		))
		.expect("generated stream behavior parses");
		let mut typed_wire_errors = 0;
		for case in oracle.errors {
			let input: WireErrorInput =
				serde_json::from_str(case.input.get()).expect("typed error input");
			let Some(code) = input.code else {
				continue;
			};
			typed_wire_errors += 1;
			let status = input.status.expect("wire error status");
			let message = input.message.expect("wire error message");
			let body =
				format!(r#"{{"error":{{"code":{code},"status":"{status}","message":"{message}"}}}}"#);
			let mut decoder = GeminiDecoder::default();
			let events = decoder
				.push_json(body.as_bytes())
				.expect("typed generated wire error decodes");
			let [GoogleDecodedEvent::Error(actual)] = events.as_slice() else {
				panic!("wire error produced exactly one terminal error");
			};
			let expected_kind = match case.output.kind.as_str() {
				"rate_limited" => GoogleCodecErrorKind::RateLimited,
				"overloaded" => GoogleCodecErrorKind::Overloaded,
				"upstream" => GoogleCodecErrorKind::Upstream,
				other => panic!("unknown generated error kind {other}"),
			};
			assert_eq!(actual.kind, expected_kind);
			assert_eq!(actual.detail, case.output.detail.expect("error detail"));
			assert_eq!(actual.retry_after_ms, case.output.retry_after_ms.expect("retry delay"));
			assert_eq!(actual.status, Some(code));
			assert_eq!(actual.code.as_ref(), Some(&status));
			assert!(
				decoder
					.push_json(br#"{"candidates":[{"finishReason":"STOP"}]}"#)
					.expect("later frame ignored")
					.is_empty()
			);
			assert!(
				decoder
					.finish()
					.expect("terminal finish is idempotent")
					.is_empty()
			);
		}
		assert_eq!(typed_wire_errors, 3);

		let mut prompt_blocked = GeminiDecoder::default();
		let events = prompt_blocked
			.push_json(
				br#"{
			"promptFeedback":{
				"blockReason":"SAFETY",
				"blockReasonMessage":"Prompt blocked by policy"
			}
		}"#,
			)
			.expect("typed prompt block decodes");
		assert!(matches!(
			events.as_slice(),
			[GoogleDecodedEvent::Error(GoogleCodecError {
				kind: GoogleCodecErrorKind::Upstream,
				detail,
				..
			})] if detail.as_str() == "Prompt blocked by policy"
		));

		let mut invalid_call = GeminiDecoder::default();
		let error = invalid_call
			.push_json(
				br#"{
			"candidates":[{
				"content":{"parts":[{"functionCall":{"args":{}},"thoughtSignature":"sig_REDACTED"}]}
			}]
		}"#,
			)
			.expect_err("missing function name is rejected");
		assert_eq!(error.kind, GoogleCodecErrorKind::Upstream);
		assert_eq!(error.detail.as_str(), "Google functionCall is missing a non-empty name");

		let mut empty_signature = GeminiDecoder::default();
		let error = empty_signature
			.push_json(
				br#"{
			"candidates":[{
				"content":{"parts":[{
					"functionCall":{"name":"lookup","args":{}},
					"thoughtSignature":""
				}]}
			}]
		}"#,
			)
			.expect_err("empty function signature is rejected");
		assert_eq!(error.kind, GoogleCodecErrorKind::Upstream);
		assert_eq!(error.detail.as_str(), "Google functionCall carried an empty thoughtSignature",);
	}

	#[test]
	fn unary_google_shapes_decode_to_typed_answers() {
		let mut count = GoogleUnaryDecoder {
			operation:            OperationKind::CountTokens,
			tokenizer:            "gemini-count-tokens:route:model".into(),
			revision:             "v1beta".into(),
			expected_embeddings:  None,
			requested_dimensions: None,
			done:                 false,
		};
		let mut events = Vec::new();
		count
			.push(
				Frame::Raw(Bytes::from_static(br#"{"totalTokens":17,"cachedContentTokenCount":3}"#)),
				&mut |event| events.push(event),
			)
			.expect("count response");
		assert!(matches!(events.as_slice(), [RawEvent::Answer(AnswerBody::Tokens(TokenCount {
			tokens:     17,
			provenance: TokenizerProvenance { exact: true, .. },
		}))]));

		let mut embed = GoogleUnaryDecoder {
			operation:            OperationKind::Embed,
			tokenizer:            Str::default(),
			revision:             Str::default(),
			expected_embeddings:  Some(2),
			requested_dimensions: Some(2),
			done:                 false,
		};
		events.clear();
		embed
			.push(
				Frame::Raw(Bytes::from_static(
					br#"{"embeddings":[{"values":[1.0,2.0]},{"values":[3.0,4.0]}]}"#,
				)),
				&mut |event| events.push(event),
			)
			.expect("embedding response");
		assert!(matches!(
			events.as_slice(),
			[RawEvent::Answer(AnswerBody::Embeddings(EmbeddingBatch {
				dimensions: 2,
				embeddings,
				..
			}))] if embeddings.len() == 2
		));
	}

	#[test]
	fn batch_embedding_request_has_exact_conditional_fields() {
		let request = GoogleBatchEmbedContentsRequest {
			requests: vec![GoogleEmbedContentRequest {
				model:                 Some("models/gemini-embedding".into()),
				content:               GoogleEmbeddingContent {
					parts: vec![text_part("hello".into())],
				},
				output_dimensionality: Some(256),
			}],
		};
		assert_eq!(
			serde_json::to_string(&request).expect("request serializes"),
			r#"{"requests":[{"model":"models/gemini-embedding","content":{"parts":[{"text":"hello"}]},"outputDimensionality":256}]}"#,
		);
	}

	#[test]
	fn vertex_api_keys_use_express_paths_without_project_coordinates() {
		for base in ["https://aiplatform.googleapis.com", "https://aiplatform.googleapis.com/v1"] {
			assert_eq!(
				google_stream_uri(
					GoogleEndpointKind::Vertex,
					base,
					"gemini-2.5-pro",
					None,
					None,
					true,
				)
				.expect("Vertex Express stream path")
				.as_str(),
				"https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
			);
			assert_eq!(
				google_unary_uri(
					GoogleEndpointKind::Vertex,
					base,
					"gemini-embedding",
					None,
					None,
					"embedContent",
					true,
				)
				.expect("Vertex Express unary path")
				.as_str(),
				"https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-embedding:embedContent",
			);
		}

		let catalog = Catalog::embedded();
		let route = catalog
			.routes()
			.iter()
			.find(|route| route.codec.as_str() == "google-vertex")
			.expect("Vertex route");
		let mut endpoint = route.endpoint.clone();
		endpoint.base_url = sf!("https://aiplatform.googleapis.com/v1");
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint,
			wire_model: omp_catalog::WireModelId::new("gemini-2.5-pro"),
		};
		let request_id = RequestId::new("vertex-express-api-key");
		let policy = policy::WirePolicy::baseline();
		let api_key_context = EncodeContext {
			request_id: &request_id,
			auth_scheme: Some(AuthScheme::ApiKey),
			route,
			target: Some(&target),
			policy: &policy,
			..EncodeContext::default()
		};
		let chat = GeminiCodec::vertex(None)
			.encode(&api_key_context, &OperationCall::Chat(Arc::new(empty_chat_request())))
			.expect("API-key Vertex chat uses Express mode");
		assert_eq!(
			chat.uri.as_str(),
			"https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
		);
		let count = GeminiCodec::vertex(None)
			.encode(
				&api_key_context,
				&OperationCall::CountTokens(Arc::new(CountTokensRequest {
					messages: Arc::from([]),
					tools:    Arc::from([]),
					accuracy: crate::call::CountAccuracy::Exact,
				})),
			)
			.expect("API-key Vertex unary request uses Express mode");
		assert_eq!(
			count.uri.as_str(),
			"https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:countTokens",
		);

		let account = AccountRoutingContext {
			project: Some(ProjectId::new("project")),
			region: Some(RegionId::new("global")),
			..AccountRoutingContext::default()
		};
		let bearer_context = EncodeContext {
			request_id: &request_id,
			auth_scheme: Some(AuthScheme::ApplicationDefault),
			route,
			target: Some(&target),
			policy: &policy,
			account: Some(&account),
			..EncodeContext::default()
		};
		let bearer = GeminiCodec::vertex(None)
			.encode(&bearer_context, &OperationCall::Chat(Arc::new(empty_chat_request())))
			.expect("ADC Vertex chat remains project scoped");
		assert_eq!(
			bearer.uri.as_str(),
			"https://aiplatform.googleapis.com/v1/projects/project/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
		);

		assert!(
			google_stream_uri(
				GoogleEndpointKind::Vertex,
				"https://aiplatform.googleapis.com/v1",
				"gemini-2.5-pro",
				None,
				None,
				false,
			)
			.is_err(),
			"bearer-authenticated Vertex remains project scoped",
		);
		assert!(
			google_unary_uri(
				GoogleEndpointKind::Vertex,
				"https://aiplatform.googleapis.com/v1",
				"gemini-embedding",
				None,
				None,
				"embedContent",
				false,
			)
			.is_err(),
			"bearer-authenticated Vertex unary operations remain project scoped",
		);
	}

	#[test]
	fn unary_google_paths_and_count_shape_are_exact() {
		assert_eq!(
			google_unary_uri(
				GoogleEndpointKind::GenerativeLanguage,
				"https://generativelanguage.googleapis.com/v1beta",
				"gemini-count",
				None,
				None,
				"countTokens",
				false,
			)
			.expect("direct path")
			.as_str(),
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-count:countTokens",
		);
		for base in ["https://aiplatform.googleapis.com", "https://aiplatform.googleapis.com/v1"] {
			assert_eq!(
				google_unary_uri(
					GoogleEndpointKind::Vertex,
					base,
					"gemini-embedding",
					Some("project"),
					Some("global"),
					"batchEmbedContents",
					false,
				)
				.expect("Vertex path")
				.as_str(),
				"https://aiplatform.googleapis.com/v1/projects/project/locations/global/publishers/google/models/gemini-embedding:batchEmbedContents",
			);
		}
		let count = GoogleCountTokensRequest {
			contents:                 vec![GoogleContent {
				role:  "user".into(),
				parts: vec![text_part("hello".into())],
			}],
			generate_content_request: None,
		};
		assert_eq!(
			serde_json::to_string(&count).expect("count request serializes"),
			r#"{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}"#,
		);
	}
	#[test]
	fn malformed_tool_arguments_remain_private_for_recovery() {
		#[derive(Deserialize)]
		struct MalformedToolArguments {
			name:     Str,
			response: Str,
			expected: Str,
		}

		let fixtures: Vec<MalformedToolArguments> =
			serde_json::from_str(include_str!("fixtures/google_malformed_tool_arguments.json"))
				.expect("malformed tool argument fixtures parse");
		for fixture in fixtures {
			let mut decoder = CanonicalGeminiDecoder::default();
			let mut events = Vec::new();
			decoder
				.push(Frame::Raw(Bytes::copy_from_slice(fixture.response.as_bytes())), &mut |event| {
					events.push(event);
				})
				.unwrap_or_else(|error| panic!("{} outer response decodes: {error}", fixture.name));
			assert!(
				!events
					.iter()
					.any(|event| matches!(event, RawEvent::Chat(ChatEvent::ToolArgumentsDelta { .. }))),
				"{} leaked malformed arguments into an ordinary delta",
				fixture.name,
			);
			assert!(
				events.iter().any(|event| matches!(
					event,
					RawEvent::ToolCallComplete {
						call: UnvalidatedToolCall { arguments, input_kind: ToolInputKind::Json, .. },
						..
					} if arguments.as_ref() == fixture.expected.as_bytes()
				)),
				"{} did not preserve private repair evidence",
				fixture.name
			);
			assert!(
				!events
					.iter()
					.any(|event| matches!(event, RawEvent::Chat(ChatEvent::ToolCallReady { .. }))),
				"{} authorized a tool before repair and validation",
				fixture.name
			);
		}
	}
}
