//! Deterministic offline compilation of checked-in catalog oracle records.

use std::{
	collections::{BTreeMap, BTreeSet},
	io, str, time,
};

use omp_core::{Str, hex, sf};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value, value::RawValue};
use sha2::{Digest, Sha256};
use smallvec::SmallVec;
use toml::de;

use crate::{
	capability::{
		AudioFormatBits, Availability, CacheRetentionBits, ChatCapabilities, DimensionRange,
		EmbeddingCapabilities, EmbeddingFormatBits, EmbeddingInputBits, ImageCapabilities,
		ImageDecoderFamily, ImageFeatureBits, ImageInputCapabilities, ImageInputFormatBits,
		ModalityBits, ModelCapabilities, OperationBits, OperationKind, PromptCacheCapabilities,
		RealtimeCapabilities, RealtimeFeatureBits, ReasoningCapabilities, ReasoningEffort,
		ReasoningFeatureBits, SearchCapabilities, SearchFeatureBits, SpeechCapabilities,
		SpeechFeatureBits, TokenizationCapabilities, TokenizationFeatureBits, ToolCapabilities,
		ToolFeatureBits, TranscriptionCapabilities, TranscriptionFeatureBits, VideoCapabilities,
		VideoFeatureBits,
	},
	cascade::{AxisMap, CascadeError, CompatCascade, ResolveTarget},
	classify::{
		ClassificationInput, ClassificationPhase, EffortTier, ModelClassification, classify,
		strip_effort_lane, supports_dynamic_effort_siblings,
	},
	discover::DiscoveryDefaults,
	id::{
		AuthSpecId, CatalogRevision, CodecId, DiscoverySpecId, ModelKey, OAuthSpecId, ProviderId,
		RouteId, ThinkingPolicyId, WireModelId, WirePolicyId,
	},
	model::{
		ContextStrategy, EvidenceConfidence, ModelAvailability, ModelLimits, ModelProvenance,
		ModelRemoteCompaction, ModelSpec, ProvenanceKind, ProvenanceSource,
	},
	policy::{
		ApplyPatchWireKind, CacheControlFormat, ComputerUseConfigSupport, ComputerUseWireSupport,
		ExtendedContextMode, MaxOutputTokensEmission, PromptCacheMode, ReasoningBodyOverride,
		StreamWatchdog, ToolCallIdProfile, WhenThinkingPolicy, WirePolicy,
	},
	pricing::{PremiumMultiplier, Price, PriceTier, PriceUnit, Pricing},
	provider::{
		AccountScope, ApplicationDefaultSource, AuthSpec, AuthSpecKind, CodecProfile,
		CodexTransportPreference, CredentialSourceSpec, DiscoveryKind, DiscoveryPagination,
		DiscoverySpec, EndpointSpec, HeaderProfile, ManagementCapabilities, OAuthCompletion,
		OAuthExchangeKind, OAuthFlowSpec, OAuthParameter, OAuthPollingSpec, OAuthRefreshBehavior,
		OAuthSpec, OAuthTokenPlacement, PrincipalResolution, ProviderDef, RedirectTrust,
		RegionSource, RegistryMapping, RouteDef, RouteRestrictions, SealedBodyPlacement, SigV4Spec,
		StaticHeader, TransportKind, TrustDomain,
	},
	thinking::{ReasoningMode, ThinkingEffort, ThinkingMode, ThinkingPolicy, ThinkingRouting},
};
/// Schema version of reviewable normalized compiler output.
pub const COMPILED_SCHEMA_VERSION: u32 = 1;
/// An explicit opaque source-model property boundary.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RawModelProperties(Box<RawValue>);

impl RawModelProperties {
	/// Borrows the original JSON token sequence.
	pub fn json(&self) -> &str {
		self.0.get()
	}
}
impl PartialEq for RawModelProperties {
	fn eq(&self, other: &Self) -> bool {
		self.0.get() == other.0.get()
	}
}

impl Eq for RawModelProperties {}

/// Typed source modality.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceModality {
	/// Text.
	Text,
	/// Images.
	Image,
	/// Audio.
	Audio,
	/// Video.
	Video,
	/// PDF or document data.
	Pdf,
}

/// Closed source wire vocabulary retained from model and provider oracles.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum SourceTransport {
	/// Anthropic Messages.
	#[serde(rename = "anthropic-messages")]
	AnthropicMessages,
	/// Anthropic on Bedrock.
	#[serde(rename = "anthropic-bedrock")]
	AnthropicBedrock,
	/// Bedrock Converse.
	#[serde(rename = "bedrock-converse", alias = "bedrock-converse-stream")]
	BedrockConverse,
	/// Anthropic on Vertex.
	#[serde(rename = "anthropic-vertex")]
	AnthropicVertex,
	/// `OpenAI` Chat Completions.
	#[serde(rename = "open-ai-chat", alias = "openai-completions", alias = "openrouter")]
	OpenAiChat,
	/// `OpenAI` Responses.
	#[serde(
		rename = "open-ai-responses",
		alias = "openai-responses",
		alias = "azure-openai-responses"
	)]
	OpenAiResponses,
	/// `OpenAI` Codex.
	#[serde(rename = "open-ai-codex", alias = "openai-codex-responses")]
	OpenAiCodex,
	/// Google Generative AI.
	#[serde(rename = "google-gen-ai", alias = "google-generative-ai")]
	GoogleGenAi,
	/// Google Vertex.
	#[serde(rename = "google-vertex")]
	GoogleVertex,
	/// Google Cloud Code Assist.
	#[serde(rename = "google-cca", alias = "google-gemini-cli")]
	GoogleCca,
	/// Ollama native chat.
	#[serde(rename = "ollama-chat")]
	OllamaChat,
	/// Cursor Connect.
	#[serde(rename = "cursor", alias = "cursor-agent")]
	Cursor,
	/// Devin Connect.
	#[serde(rename = "devin", alias = "devin-agent")]
	Devin,
	/// GitLab Duo workflow.
	#[serde(rename = "gitlab-duo-workflow", alias = "gitlab-duo-agent")]
	GitlabDuoWorkflow,
	/// OMP federation.
	#[serde(rename = "omp")]
	Omp,
	/// In-process inference.
	#[serde(rename = "embedded", alias = "apple-intelligence-api")]
	Embedded,
}

/// Typed source price components in decimal US dollars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCost {
	/// Input price per million tokens.
	#[serde(default = "zero_number")]
	pub input:        Number,
	/// Output price per million tokens.
	#[serde(default = "zero_number")]
	pub output:       Number,
	/// Cache-read price per million tokens.
	#[serde(default = "zero_number")]
	pub cache_read:   Number,
	/// Cache-write price per million tokens.
	#[serde(default = "zero_number")]
	pub cache_write:  Number,
	/// Long-context replacement schedule.
	#[serde(default)]
	pub long_context: Option<SourceLongContextCost>,
}

/// Typed long-context source price schedule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceLongContextCost {
	/// Exclusive prompt-token threshold.
	pub input_threshold:           u64,
	/// Whether the source threshold itself activates the replacement schedule.
	#[serde(default)]
	pub input_threshold_inclusive: bool,
	/// Input price.
	#[serde(default = "zero_number")]
	pub input:                     Number,
	/// Output price.
	#[serde(default = "zero_number")]
	pub output:                    Number,
	/// Cache-read price.
	#[serde(default = "zero_number")]
	pub cache_read:                Number,
	/// Cache-write price.
	#[serde(default = "zero_number")]
	pub cache_write:               Number,
}

/// Closed typed record parsed from one oracle model row.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceModelRecord {
	/// Optional denormalized identity.
	#[serde(default)]
	pub id: Option<Str>,
	/// Display name.
	#[serde(default)]
	pub name: Option<Str>,
	/// Optional denormalized provider.
	#[serde(default)]
	pub provider: Option<Str>,
	/// Optional per-model transport override.
	#[serde(default)]
	pub api: Option<SourceTransport>,
	/// Optional per-model endpoint override.
	#[serde(default)]
	pub base_url: Option<Str>,
	/// Declared reasoning support.
	#[serde(default)]
	pub reasoning: bool,
	/// Declared input modalities.
	#[serde(default)]
	pub input: Vec<SourceModality>,
	/// Declared output modalities.
	#[serde(default)]
	pub output: Vec<SourceModality>,
	/// Declared chat image decoder family.
	#[serde(default)]
	pub image_input_decoder: Option<ImageDecoderFamily>,
	/// Typed pricing.
	#[serde(default)]
	pub cost: SourceCost,
	/// Context window.
	#[serde(default)]
	pub context_window: Option<u64>,
	/// Maximum output tokens.
	#[serde(default)]
	pub max_tokens: Option<u64>,
	/// Typed native reasoning properties.
	#[serde(default)]
	pub thinking: Option<SourceThinking>,
	/// Fixed embedding dimension.
	#[serde(default)]
	pub embedding_dimensions: Option<u32>,
	/// Deprecation declaration.
	#[serde(default)]
	pub deprecated: bool,
	/// Explicit tool support evidence.
	#[serde(default)]
	pub supports_tools: Option<bool>,
	/// Explicit computer-use evidence.
	#[serde(default)]
	pub supports_computer_use: Option<bool>,
	/// Authored computer-use evidence.
	#[serde(default)]
	pub supports_computer_use_config: Option<bool>,
	/// Cursor max-mode evidence.
	#[serde(default)]
	pub cursor_max_mode: Option<bool>,
	/// Output-token field omission.
	#[serde(default)]
	pub omit_max_output_tokens: Option<bool>,
	/// Apply-patch wire spelling.
	#[serde(default)]
	pub apply_patch_tool_type: Option<Str>,
	/// Preferred edit-tool contract revision.
	#[serde(default)]
	pub edit_revision: Option<Str>,
	/// Context promotion target.
	#[serde(default)]
	pub context_promotion_target: Option<Str>,
	/// Local compaction model target.
	#[serde(default)]
	pub compaction_model: Option<Str>,
	/// Wire model override.
	#[serde(default)]
	pub request_model_id: Option<Str>,
	/// Typed remote-compaction source properties.
	#[serde(default)]
	pub remote_compaction: Option<SourceRemoteCompaction>,
	/// Exact premium multiplier source number.
	#[serde(default)]
	pub premium_multiplier: Option<Number>,
	/// Reasoning serving mode.
	#[serde(default)]
	pub reasoning_mode: Option<Str>,
	/// Responses-lite choice.
	#[serde(default)]
	pub use_responses_lite: Option<bool>,
	/// WebSocket preference.
	#[serde(default)]
	pub prefer_websockets: Option<bool>,
	/// Route priority.
	#[serde(default)]
	pub priority: Option<u32>,
	/// Static source headers.
	#[serde(default)]
	pub headers: BTreeMap<Str, Str>,
	/// Typed compatibility properties.
	#[serde(default)]
	pub compat: Option<SourceWirePolicy>,
	/// Verbatim sparse compatibility properties retained alongside the resolved
	/// compatibility record.
	#[serde(default)]
	pub compat_config: Option<SourceWirePolicy>,
	/// Whether the model requires reversible private-use glyph tokenization.
	#[serde(default)]
	pub requires_glyph_tokenization: Option<bool>,
	/// Catalog-resolved local tokenizer family, retained as source metadata.
	#[serde(default)]
	pub tokenizer: Option<Str>,
	/// Provider tool-surface restriction, retained as source metadata.
	#[serde(default)]
	pub tool_mode: Option<Str>,
	/// Compiler-derived canonical metadata reference.
	#[serde(skip)]
	pub inherited_from: Option<ModelKey>,
	/// Compiler evidence that dynamic-pricing sentinels were intentionally
	/// omitted.
	#[serde(skip)]
	pub omitted_dynamic_pricing: bool,
}

/// Typed source provider-side compaction routing.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRemoteCompaction {
	/// Explicit enablement.
	#[serde(default)]
	pub enabled:              Option<bool>,
	/// Compaction transport override.
	#[serde(default)]
	pub api:                  Option<SourceTransport>,
	/// Primary endpoint.
	#[serde(default)]
	pub endpoint:             Option<Str>,
	/// V2 streaming enablement.
	#[serde(default)]
	pub v2_streaming_enabled: Option<bool>,
	/// V2 endpoint.
	#[serde(default)]
	pub v2_endpoint:          Option<Str>,
	/// Streaming endpoint.
	#[serde(default)]
	pub streaming_endpoint:   Option<Str>,
	/// Wire model override.
	#[serde(default)]
	pub model:                Option<Str>,
}
/// Typed model reasoning source, with route spellings excluded from profile
/// identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceThinking {
	/// Native control mode.
	pub mode:              ThinkingMode,
	/// Ordered advertised efforts.
	pub efforts:           SmallVec<ThinkingEffort, 6>,
	/// Default effort.
	#[serde(default)]
	pub default_level:     Option<ThinkingEffort>,
	/// Native effort spellings.
	#[serde(default)]
	pub effort_map:        BTreeMap<ThinkingEffort, Str>,
	/// Effort-specific wire routes.
	#[serde(default)]
	pub effort_routing:    BTreeMap<ThinkingEffort, Str>,
	/// Additional provider serving path.
	#[serde(default)]
	pub reasoning_mode:    Option<ReasoningMode>,
	/// Effort-specific token budgets.
	#[serde(default)]
	pub effort_budgets:    BTreeMap<ThinkingEffort, u64>,
	/// Adaptive display support.
	#[serde(default)]
	pub supports_display:  Option<bool>,
	/// Off-wire suppression.
	#[serde(default)]
	pub suppress_when_off: Option<bool>,
	/// Required effort evidence.
	#[serde(default)]
	pub requires_effort:   Option<bool>,
}

/// Authentication record in the provider oracle.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum SourceAuth {
	/// No credentials.
	#[default]
	None,
	/// Required bearer token.
	Bearer {
		/// Environment lookup order, retained only as provenance.
		#[serde(default)]
		env: Vec<Str>,
	},
	/// RFC 7617 basic authentication from independently named secrets.
	Basic {
		/// Username environment lookup order.
		#[serde(default)]
		username_env: Vec<Str>,
		/// Password environment lookup order.
		#[serde(default)]
		password_env: Vec<Str>,
	},
	/// Optional bearer token.
	OptionalBearer {
		/// Environment lookup order.
		#[serde(default)]
		env: Vec<Str>,
	},
	/// Devin session token bound into sealed protobuf metadata.
	DevinSession {
		/// Environment lookup order, retained only as provenance.
		#[serde(default)]
		env: Vec<Str>,
	},
	/// Custom credential header.
	Header {
		/// Header name.
		name: Str,
		/// Environment lookup order.
		#[serde(default)]
		env:  Vec<Str>,
	},
	/// Credential query parameter.
	Query {
		/// Query parameter name.
		param: Str,
		/// Environment lookup order.
		#[serde(default)]
		env:   Vec<Str>,
	},
	/// AWS Signature Version 4.
	AwsSigV4,
	/// Google application-default credentials.
	GoogleAdc {
		/// API-key environment order.
		#[serde(default)]
		api_key_env:  Vec<Str>,
		/// Project environment order.
		#[serde(default)]
		project_env:  Vec<Str>,
		/// Location environment order.
		#[serde(default)]
		location_env: Vec<Str>,
	},
	/// OAuth flow.
	Oauth {
		/// Stable flow identifier.
		flow: Str,
	},
}

/// Provider registry mapping source.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceMapping {
	/// Concrete provider.
	#[default]
	Concrete,
	/// Provider alias.
	Alias {
		/// Canonical provider.
		target: Str,
		/// Reviewed rationale.
		reason: Str,
	},
	/// Provider implementation replacement.
	Replacement {
		/// Component name.
		component: Str,
		/// Reviewed rationale.
		reason:    Str,
	},
}

/// Provider discovery source.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceDiscovery {
	/// Discovery schema kind.
	pub kind:             Str,
	/// Human-readable label.
	pub label:            Str,
	/// Endpoint path relative to the provider base URL.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub path:             Option<Str>,
	/// Query parameter used to send the next response cursor.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cursor_parameter: Option<Str>,
	/// Whether absence proves unavailability.
	#[serde(default)]
	pub authoritative:    bool,
	/// Requested periodic polling interval in milliseconds.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub interval_ms:      Option<u64>,
}

/// Sparse typed provider/model wire-policy source.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SourceWirePolicy {
	/// Streaming usage support.
	#[serde(alias = "supportsUsageInStreaming")]
	pub usage_in_streaming: Option<bool>,
	/// Reversible private-use glyph tokenization at the provider wire boundary.
	pub glyph_tokenization: Option<bool>,
	/// Multiple system-message support.
	pub multiple_system_messages: Option<bool>,
	/// Output-token field spelling.
	#[serde(alias = "maxTokensField")]
	pub max_tokens_field: Option<Str>,
	/// Sampling support.
	pub sampling_params: Option<bool>,
	/// Model-level sampling support.
	#[serde(alias = "supportsSamplingParams")]
	pub supports_sampling_params: Option<bool>,
	/// Penalty support.
	pub penalties: Option<bool>,
	/// Tool strictness.
	pub tool_strict_mode: Option<Str>,
	/// Named tool choice.
	pub named_tool_choice: Option<bool>,
	/// Forced tool choice.
	#[serde(alias = "supportsForcedToolChoice")]
	pub forced_tool_choice: Option<bool>,
	/// General tool-choice support.
	#[serde(alias = "supportsToolChoice")]
	pub supports_tool_choice: Option<bool>,
	/// Tool-call identifier profile.
	pub tool_call_id_profile: Option<Str>,
	/// Reasoning wire format.
	pub reasoning_wire_format: Option<Str>,
	/// Whether thinking may be interleaved with tool-use blocks.
	pub interleaved_thinking: Option<bool>,
	/// Stateful chaining.
	pub stateful_response_chaining: Option<bool>,
	/// Thinking/tool conflict policy.
	pub thinking_tool_choice_conflict: Option<Str>,
	/// Cache-control format.
	pub cache_control_format: Option<Str>,
	/// Bedrock prompt-cache checkpoint mode.
	#[serde(alias = "promptCacheMode")]
	pub prompt_cache_mode: Option<Str>,
	/// Bedrock minimum tokens for explicit prompt caching.
	#[serde(alias = "promptCacheMinimumTokens")]
	pub prompt_cache_minimum_tokens: Option<u64>,
	/// Bedrock maximum explicit prompt-cache checkpoints.
	#[serde(alias = "promptCacheMaxCheckpoints")]
	pub prompt_cache_max_checkpoints: Option<u8>,
	/// Image encoding.
	pub image_encoding_format: Option<Str>,
	/// Stop-sequence support.
	pub stop_sequences: Option<bool>,
	/// Tool-schema flavor.
	pub tool_schema_flavor: Option<Str>,
	/// Leaked-thinking healer.
	pub leaked_thinking_healer: Option<Str>,
	/// Thinking loop guard.
	pub thinking_loop_guard: Option<bool>,
	/// Stream watchdog.
	pub stream_watchdog: Option<SourceStreamWatchdog>,
	/// Model stream idle timeout.
	#[serde(alias = "streamIdleTimeoutMs")]
	pub stream_idle_timeout_ms: Option<u64>,
	/// Maximum retries for a reasoning-only stream close.
	pub thinking_close_max_retries: Option<u32>,
	/// Stream protocol.
	pub stream_protocol: Option<Str>,
	/// Audio API version.
	pub audio_api_version: Option<Str>,
	/// Developer role support.
	#[serde(alias = "supportsDeveloperRole")]
	pub supports_developer_role: Option<bool>,
	/// Mid-conversation system role support.
	#[serde(alias = "supportsMidConversationSystem")]
	pub supports_mid_conversation_system: Option<bool>,
	/// Built-in tool-name escaping.
	#[serde(alias = "escapeBuiltinToolNames")]
	pub escape_builtin_tool_names: Option<bool>,
	/// Required tool result identifier.
	#[serde(alias = "requiresToolResultId")]
	pub requires_tool_result_id: Option<bool>,
	/// Eager tool-input streaming.
	#[serde(alias = "supportsEagerToolInputStreaming")]
	pub supports_eager_tool_input_streaming: Option<bool>,
	/// Required assistant content on tool calls.
	#[serde(alias = "requiresAssistantContentForToolCalls")]
	pub requires_assistant_content_for_tool_calls: Option<bool>,
	/// Disable reasoning on tool choice.
	#[serde(alias = "disableReasoningOnToolChoice")]
	pub disable_reasoning_on_tool_choice: Option<bool>,
	/// Reasoning effort support.
	#[serde(alias = "supportsReasoningEffort")]
	pub supports_reasoning_effort: Option<bool>,
	/// Reasoning summary support.
	#[serde(alias = "supportsReasoningSummary")]
	pub supports_reasoning_summary: Option<bool>,
	/// Omit native reasoning effort.
	#[serde(alias = "omitReasoningEffort")]
	pub omit_reasoning_effort: Option<bool>,
	/// Route selected effort through Qwen chat-template kwargs.
	#[serde(alias = "templateReasoningEffort")]
	pub template_reasoning_effort: Option<bool>,
	/// Reasoning effort spellings.
	#[serde(alias = "reasoningEffortMap")]
	pub reasoning_effort_map: BTreeMap<ThinkingEffort, Str>,
	/// Reasoning disable operation.
	#[serde(alias = "reasoningDisableMode")]
	pub reasoning_disable_mode: Option<Str>,
	/// Reasoning content field.
	#[serde(alias = "reasoningContentField")]
	pub reasoning_content_field: Option<Str>,
	/// Required reasoning on tool-call turns.
	#[serde(alias = "requiresReasoningContentForToolCalls")]
	pub requires_reasoning_content_for_tool_calls: Option<bool>,
	/// Required reasoning on all assistant turns.
	#[serde(alias = "requiresReasoningContentForAllAssistantTurns")]
	pub requires_reasoning_content_for_all_assistant_turns: Option<bool>,
	/// Synthetic reasoning permission.
	#[serde(alias = "allowsSyntheticReasoningContentForToolCalls")]
	pub allows_synthetic_reasoning_content_for_tool_calls: Option<bool>,
	/// Reasoning history filtering.
	#[serde(alias = "filterReasoningHistory")]
	pub filter_reasoning_history: Option<bool>,
	/// Root-union tool schema flattening.
	#[serde(alias = "flattenRootUnions")]
	pub flatten_root_unions: Option<bool>,
	/// Encrypted reasoning inclusion.
	#[serde(alias = "includeEncryptedReasoning")]
	pub include_encrypted_reasoning: Option<bool>,
	/// Unsigned thinking replay.
	#[serde(alias = "replayUnsignedThinking")]
	pub replay_unsigned_thinking: Option<bool>,
	/// Required thinking enablement.
	#[serde(alias = "requiresThinkingEnabled")]
	pub requires_thinking_enabled: Option<bool>,
	/// Adaptive thinking disablement.
	#[serde(alias = "disableAdaptiveThinking")]
	pub disable_adaptive_thinking: Option<bool>,
	/// Official endpoint evidence.
	#[serde(alias = "officialEndpoint")]
	pub official_endpoint: Option<bool>,
	/// Signing endpoint evidence.
	#[serde(alias = "signingEndpoint")]
	pub signing_endpoint: Option<bool>,
	/// Additional thinking text format.
	#[serde(alias = "thinkingFormat")]
	pub thinking_format: Option<Str>,
	/// Typed fixed body override kept opaque at the model property boundary.
	#[serde(alias = "extraBody")]
	pub extra_body: Option<RawModelProperties>,
	/// Typed conditional body override kept opaque at the model property
	/// boundary.
	#[serde(alias = "whenThinking")]
	pub when_thinking: Option<RawModelProperties>,
	/// Long cache retention.
	#[serde(alias = "supportsLongCacheRetention")]
	pub supports_long_cache_retention: Option<bool>,
	/// Store support.
	#[serde(alias = "supportsStore")]
	pub supports_store: Option<bool>,
	/// Original image detail support.
	#[serde(alias = "supportsImageDetailOriginal")]
	pub supports_image_detail_original: Option<bool>,
}

/// Typed source watchdog bounds.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SourceStreamWatchdog {
	/// First-event timeout.
	pub first_event_ms: Option<u64>,
	/// Inter-event timeout.
	pub idle_ms:        Option<u64>,
}

/// Authored provider operation evidence.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceFacet {
	/// Conversational generation.
	Chat,
	/// Vector embeddings.
	Embeddings,
	/// Image generation or editing.
	ImageGeneration,
	/// Video generation or editing.
	VideoGeneration,
	/// Speech synthesis.
	AudioSpeech,
	/// Audio transcription.
	AudioTranscription,
	/// Bidirectional realtime sessions.
	Realtime,
	/// Standalone web search.
	WebSearch,
	/// Bounded web-resource extraction.
	WebExtract,
	/// Token counting and conversion.
	Tokenization,
}

/// One curated provider source record.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceProviderRecord {
	/// Source transport.
	pub transport:             SourceTransport,
	/// Additional wire protocols exposed at the primary base URL.
	///
	/// These routes are addressable by runtime discovery but remain inert for
	/// bundled models unless model evidence explicitly selects them.
	#[serde(default)]
	pub additional_transports: Vec<SourceTransport>,
	/// Typed codec-construction discriminator.
	#[serde(default)]
	pub codec_profile:         CodecProfile,
	/// Explicit operation codec identifier when it differs from the source
	/// transport vocabulary.
	#[serde(default)]
	pub codec:                 Option<CodecId>,
	/// Explicit runtime transport when it differs from the source transport
	/// vocabulary.
	#[serde(default)]
	pub route_transport:       Option<TransportKind>,
	/// Primary base URL.
	pub base_url:              Str,
	/// Optional API version.
	#[serde(default)]
	pub api_version:           Option<Str>,
	/// Codex transport preference.
	#[serde(default)]
	pub codex_transport:       Option<Str>,
	/// Codex Responses-lite choice.
	#[serde(default)]
	pub codex_responses_lite:  bool,
	/// Additional route URLs.
	#[serde(default)]
	pub fallback_base_urls:    Vec<Str>,
	/// Authentication source.
	#[serde(default)]
	pub auth:                  SourceAuth,
	/// Declared provider facets.
	#[serde(default)]
	pub facets:                Vec<SourceFacet>,
	/// Static non-secret headers.
	#[serde(default)]
	pub headers:               BTreeMap<Str, Str>,
	/// Typed wire policy overrides.
	#[serde(default)]
	pub compat:                SourceWirePolicy,
	/// Registry mapping.
	#[serde(default)]
	pub mapping:               SourceMapping,
	/// Optional login flow.
	#[serde(default)]
	pub oauth_flow:            Option<Str>,
	/// Optional OAuth credential placement.
	#[serde(default)]
	pub oauth_auth:            Option<SourceAuth>,
	/// Optional discovery source.
	#[serde(default)]
	pub discovery:             Option<SourceDiscovery>,
	/// Whether provider-level console quota reporting is available.
	#[serde(default)]
	pub usage:                 bool,
	/// Facets withheld until a transport exists.
	#[serde(default)]
	pub pending_facets:        Vec<SourceFacet>,
	/// Withheld transport source name.
	#[serde(default)]
	pub pending_transport:     Option<Str>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderDocument {
	providers: BTreeMap<Str, SourceProviderRecord>,
}

/// Typed in-memory compiler source.
#[derive(Debug)]
pub struct CatalogSource {
	/// Curated provider records.
	pub providers: BTreeMap<Str, SourceProviderRecord>,
	/// Raw provider-keyed model records.
	pub models:    BTreeMap<Str, BTreeMap<Str, SourceModelRecord>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceOAuthDocument {
	provider: Vec<SourceOAuthSpec>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceOAuthSpec {
	provider:             Str,
	credential_provider:  Str,
	kind:                 SourceOAuthKind,
	client_id:            Str,
	authorize_url:        Str,
	token_url:            Str,
	#[serde(default)]
	scopes:               Vec<Str>,
	callback_port:        Option<u16>,
	callback_host:        Option<Str>,
	callback_path:        Option<Str>,
	#[serde(default)]
	authorize_params:     BTreeMap<Str, Str>,
	#[serde(default)]
	token_params:         BTreeMap<Str, Str>,
	#[serde(default)]
	custom_params:        BTreeMap<Str, Str>,
	refresh_url:          Option<Str>,
	exchange:             Option<OAuthExchangeKind>,
	principal_resolution: Option<SourcePrincipalResolution>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SourceOAuthKind {
	Pkce,
	DeviceCode,
	CustomExchange,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum SourcePrincipalResolution {
	IdTokenClaim { claim: Str },
	AccessTokenClaims { claims: Box<[Str]> },
	TokenResponseField { pointer: Str },
	UserinfoEndpoint { url: Str, field: Str },
	StaticLabel { label: Str },
}

impl From<SourcePrincipalResolution> for PrincipalResolution {
	fn from(source: SourcePrincipalResolution) -> Self {
		match source {
			SourcePrincipalResolution::IdTokenClaim { claim } => Self::IdTokenClaim { claim },
			SourcePrincipalResolution::AccessTokenClaims { claims } => {
				Self::AccessTokenClaims { claims }
			},
			SourcePrincipalResolution::TokenResponseField { pointer } => {
				Self::TokenResponseField { pointer }
			},
			SourcePrincipalResolution::UserinfoEndpoint { url, field } => {
				Self::UserinfoEndpoint { url, field }
			},
			SourcePrincipalResolution::StaticLabel { label } => Self::StaticLabel { label },
		}
	}
}

/// Stable alias emitted by normalization.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CatalogAlias {
	/// Alias selector.
	pub alias:      Str,
	/// Canonical model key.
	pub target:     ModelKey,
	/// Review rationale.
	pub rationale:  Str,
	/// Evidence provenance.
	pub provenance: Str,
}

/// Reviewable compiler census encoded with normalized output.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CompilerCensus {
	/// Raw model rows.
	pub raw_models:        usize,
	/// Logical model rows.
	pub logical_models:    usize,
	/// Curated providers.
	pub providers:         usize,
	/// Provider keys in raw model data.
	pub raw_provider_keys: usize,
	/// Distinct route URLs.
	pub urls:              usize,
	/// Distinct transports active across curated providers.
	pub active_transports: usize,
}

/// Deterministically compiled catalog and all structurally interned profiles.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CompiledCatalog {
	/// Normalized schema version.
	pub schema_version:    u32,
	/// Content-derived catalog revision.
	pub revision:          CatalogRevision,
	/// Verified compilation census.
	pub census:            CompilerCensus,
	/// Providers sorted by identifier.
	pub providers:         Box<[ProviderDef]>,
	/// Structurally interned authentication specifications.
	pub auth_specs:        Box<[AuthSpec]>,
	/// Structurally interned public OAuth flow specifications.
	pub oauth_specs:       Box<[OAuthSpec]>,
	/// Structurally interned safe header profiles.
	pub header_profiles:   Box<[HeaderProfile]>,
	/// Structurally interned discovery specifications.
	pub discovery_specs:   Box<[DiscoverySpec]>,
	/// Routes sorted by identifier.
	pub routes:            Box<[RouteDef]>,
	/// Logical models sorted by key.
	pub models:            Box<[ModelSpec]>,
	/// Structurally interned wire policies.
	pub wire_policies:     Box<[WirePolicy]>,
	/// Structurally interned thinking policies.
	pub thinking_policies: Box<[ThinkingPolicy]>,
	/// Aliases sorted by alias and target.
	pub aliases:           Box<[CatalogAlias]>,
}

impl CompiledCatalog {
	/// Serializes the review schema as deterministic pretty JSON with one
	/// trailing newline.
	pub fn normalized_json(&self) -> Result<Vec<u8>, CompileError> {
		let mut bytes = serde_json::to_vec_pretty(self)?;
		bytes.push(b'\n');
		Ok(bytes)
	}
}

/// Offline compiler failure.
#[derive(Debug, thiserror::Error)]
pub enum CompileError {
	/// Provider TOML did not match the closed schema.
	#[error("provider oracle is invalid: {0}")]
	Provider(#[from] de::Error),
	/// Model JSON did not match the closed schema.
	#[error("model oracle is invalid: {0}")]
	Json(#[from] serde_json::Error),
	/// Compressed model source could not be decoded.
	#[error("model oracle compression is invalid: {0}")]
	Compression(#[from] io::Error),
	/// Compatibility cascade parsing or resolution failed.
	#[error("compatibility cascade is invalid: {0}")]
	Cascade(#[from] CascadeError),
	/// Source data violated a catalog invariant.
	#[error("catalog invariant failed: {0}")]
	Invariant(Str),
}

/// Parses the two checked-in oracle source formats into typed records.
#[tracing::instrument(
	name = "catalog_oracle_parse",
	level = "debug",
	skip_all,
	fields(
		provider_source_bytes = providers_toml.len(),
		model_source_bytes = models_json_zstd.len()
	)
)]
pub fn parse_oracle(
	providers_toml: &str,
	models_json_zstd: &[u8],
) -> Result<CatalogSource, CompileError> {
	let mut providers: ProviderDocument = toml::from_str(providers_toml)?;
	for (provider, profile) in [
		("google-gemini-cli", CodecProfile::GoogleCcaGeminiCli),
		("google-antigravity", CodecProfile::GoogleCcaAntigravity),
		("apple-intelligence", CodecProfile::AppleFm),
	] {
		if let Some(record) = providers.providers.get_mut(provider) {
			record.codec_profile = profile;
		}
	}
	let json = zstd::stream::decode_all(models_json_zstd)?;
	let models = serde_json::from_slice(&json)?;
	Ok(CatalogSource { providers: providers.providers, models })
}

/// Compiles the checked-in provider, model, and OAuth oracles without network
/// access.
pub fn compile_oracle(
	providers_toml: &str,
	models_json_zstd: &[u8],
	oauth_toml: &str,
) -> Result<CompiledCatalog, CompileError> {
	compile_with_oauth(parse_oracle(providers_toml, models_json_zstd)?, oauth_toml)
}

/// Compiles typed source records with the bundled public OAuth table.
pub fn compile(source: CatalogSource) -> Result<CompiledCatalog, CompileError> {
	compile_with_oauth(source, include_str!("../../../fixtures/llm-oracle/catalog/oauth.toml"))
}

#[tracing::instrument(
	name = "catalog_compile",
	level = "debug",
	skip_all,
	fields(
		provider_count = source.providers.len(),
		model_provider_count = source.models.len()
	)
)]
fn compile_with_oauth(
	source: CatalogSource,
	oauth_toml: &str,
) -> Result<CompiledCatalog, CompileError> {
	let cascade = CompatCascade::bundled()?;
	let CatalogSource { providers: provider_sources, models: mut model_sources } = source;
	let provider_facets = provider_sources
		.iter()
		.map(|(provider, source)| (provider.clone(), source.facets.clone()))
		.collect::<BTreeMap<_, _>>();
	let provider_transports = provider_sources
		.iter()
		.map(|(provider, source)| (provider.clone(), source.transport))
		.collect::<BTreeMap<_, _>>();
	inherit_source_references(&mut model_sources);
	let raw_models = model_sources.values().map(BTreeMap::len).sum();
	let active_transports = provider_sources
		.values()
		.map(|provider| provider.transport)
		.collect::<BTreeSet<_>>()
		.len();
	let raw_provider_keys = model_sources.len();
	let urls = source_url_census(&provider_sources, &model_sources);
	let (oauth_specs, oauth_ids) = compile_oauth_specs(oauth_toml)?;
	let (
		mut providers,
		auth_specs,
		mut header_profiles,
		discovery_specs,
		mut routes,
		provider_routes,
		mut wire_policy_table,
		provider_policies,
	) = compile_providers(provider_sources, &oauth_ids, &oauth_specs)?;
	let model_routes = compile_model_routes(
		&model_sources,
		&mut providers,
		&mut routes,
		&mut header_profiles,
		&provider_routes,
	)?;
	let mut thinking_policy_table = BTreeMap::new();
	let (models, aliases) = compile_models(
		model_sources,
		&model_routes,
		&provider_policies,
		&mut wire_policy_table,
		&mut thinking_policy_table,
		&provider_facets,
		&provider_transports,
		&cascade,
	)?;
	enable_hosted_image_routes(&models, &mut routes);
	let census = CompilerCensus {
		raw_models,
		logical_models: models.len(),
		providers: providers.len(),
		raw_provider_keys,
		urls,
		active_transports,
	};
	let wire_policies: Vec<WirePolicy> = wire_policy_table.into_values().collect();
	let thinking_policies: Vec<ThinkingPolicy> = thinking_policy_table.into_values().collect();
	let revision = revision_for(&providers, &routes, &models)?;
	Ok(CompiledCatalog {
		schema_version: COMPILED_SCHEMA_VERSION,
		revision,
		census,
		oauth_specs: oauth_specs.into_boxed_slice(),
		providers: providers.into_boxed_slice(),
		auth_specs: auth_specs.into_boxed_slice(),
		header_profiles: header_profiles.into_boxed_slice(),
		discovery_specs: discovery_specs.into_boxed_slice(),
		routes: routes.into_boxed_slice(),
		models: models.into_boxed_slice(),
		wire_policies: wire_policies.into_boxed_slice(),
		thinking_policies: thinking_policies.into_boxed_slice(),
		aliases: aliases.into_boxed_slice(),
	})
}

#[derive(Clone, Copy)]
struct ExactSourceReference {
	provider:           &'static str,
	model:              &'static str,
	reference_provider: &'static str,
	reference_model:    &'static str,
	rationale:          &'static str,
	provenance:         &'static str,
	expires_at_ms:      Option<u64>,
}

const fn review_metadata_is_valid(
	rationale: &str,
	provenance: &str,
	expires_at_ms: Option<u64>,
) -> bool {
	!rationale.is_empty()
		&& !provenance.is_empty()
		&& match expires_at_ms {
			Some(expiry) => expiry > 0,
			None => true,
		}
}

const fn reviewed_source_reference(
	provider: &'static str,
	model: &'static str,
	reference_provider: &'static str,
	reference_model: &'static str,
	rationale: &'static str,
) -> ExactSourceReference {
	ExactSourceReference {
		provider,
		model,
		reference_provider,
		reference_model,
		rationale,
		provenance: "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	}
}

const EXACT_SOURCE_REFERENCES: &[ExactSourceReference] = &[
	ExactSourceReference {
		provider:           "kilo",
		model:              "deepseek/deepseek-v4-flash:free",
		reference_provider: "kilo",
		reference_model:    "deepseek/deepseek-v4-flash:discounted",
		rationale:          "The free selector inherits the reviewed discounted wire sibling's \
		                     effective pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "minimax/minimax-m2",
		reference_provider: "minimax",
		reference_model:    "MiniMax-M2.5",
		rationale:          "The reseller card inherits canonical MiniMax cache-write pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "minimax/minimax-m2.1",
		reference_provider: "minimax",
		reference_model:    "MiniMax-M2.1",
		rationale:          "The reseller card inherits canonical MiniMax cache-write pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "minimax/minimax-m2.5",
		reference_provider: "minimax",
		reference_model:    "MiniMax-M2.5",
		rationale:          "The reseller card inherits canonical MiniMax cache-write pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "minimax/minimax-m2.5:free",
		reference_provider: "openrouter",
		reference_model:    "minimax/minimax-m2.5:free",
		rationale:          "The free selector inherits reviewed free-tier prices before canonical \
		                     cache-write pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "minimax/minimax-m2.7",
		reference_provider: "minimax",
		reference_model:    "MiniMax-M2.7",
		rationale:          "The reseller card inherits canonical MiniMax cache-write pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "openrouter",
		model:              "minimax/minimax-m2.5:free",
		reference_provider: "openrouter",
		reference_model:    "minimax/minimax-m2.5",
		rationale:          "The free-tier row inherits reviewed free pricing before canonical \
		                     cache-write pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "openrouter",
		model:              "minimax/minimax-m2.5",
		reference_provider: "minimax",
		reference_model:    "MiniMax-M2.5",
		rationale:          "The gateway price wins component-wise while canonical cache-write \
		                     pricing fills its zero.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "aiand",
		model:              "qwen/qwen3.6-27b",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3.6-27B",
		rationale:          "The reseller's explicit prices win while the reviewed deployment fills \
		                     cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3-235B-A22B-Instruct-2507",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3-235B-A22B-Instruct-2507",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3-235B-A22B-Thinking-2507",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3-235B-A22B-Thinking-2507",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3-Coder-480B-A35B-Instruct",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3-Coder-Next",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen3-coder-next",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical route fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3.5-27B",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3.5-27B",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3.5-35B-A3B",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3.5-35B-A3B",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3.6-27B",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3.6-27B",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3.6-35B-A3B",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3.6-35B-A3B",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "Qwen/Qwen3.5-397B-A17B",
		reference_provider: "together",
		reference_model:    "Qwen/Qwen3.5-397B-A17B",
		rationale:          "Every exact deployment spelling preserves its explicit prices while \
		                     the reviewed canonical deployment fills cache-read pricing.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen-max",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen-max",
		rationale:          "The exact OpenRouter card supplies reviewed Qwen Max limits and cache \
		                     pricing without replacing explicit reseller prices.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen-turbo",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen-turbo",
		rationale:          "The exact OpenRouter card supplies reviewed Qwen Turbo limits and \
		                     cache pricing without replacing explicit reseller prices.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen-vl-max",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen-vl-max",
		rationale:          "The exact OpenRouter card supplies reviewed Qwen VL Max limits without \
		                     replacing explicit reseller prices.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwq-32b",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwq-32b",
		rationale:          "The exact OpenRouter card supplies reviewed QwQ limits without \
		                     replacing explicit reseller prices.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-30b-a3b-instruct-2507",
		reference_provider: "coreweave",
		reference_model:    "Qwen/Qwen3-30B-A3B-Instruct-2507",
		rationale:          "The exact canonical deployment fills cache-read pricing without \
		                     replacing explicit reseller prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-30b-a3b-thinking-2507",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen3-30b-a3b-thinking-2507",
		rationale:          "The exact reviewed route fills cache-read pricing without replacing \
		                     explicit reseller prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-8b",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen3-8b",
		rationale:          "The exact reviewed route fills cache-read pricing without replacing \
		                     explicit reseller prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-coder-30b-a3b-instruct",
		reference_provider: "nanogpt",
		reference_model:    "qwen3-coder-30b-a3b-instruct",
		rationale:          "The exact reviewed deployment fills cache-read pricing without \
		                     replacing explicit reseller prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-vl-235b-a22b-instruct",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen3-vl-235b-a22b-instruct",
		rationale:          "The exact reviewed route fills cache-read pricing without replacing \
		                     explicit reseller prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-vl-235b-a22b-thinking",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen3-vl-235b-a22b-instruct",
		rationale:          "The reviewed sibling supplies the shared cache-read price without \
		                     replacing explicit thinking-route prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "*",
		model:              "qwen/qwen3-coder",
		reference_provider: "openrouter",
		reference_model:    "qwen/qwen3-coder",
		rationale:          "The exact reviewed route fills cache-read pricing without replacing \
		                     explicit reseller prices or limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "qwen/qwen3.6-plus:free",
		reference_provider: "opencode-go",
		reference_model:    "qwen3.6-plus",
		rationale:          "The free selector retains its explicit prices while the reviewed \
		                     canonical card fills both cache components.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "qwen/qwen3.7-plus:free",
		reference_provider: "kilo",
		reference_model:    "qwen/qwen3.7-plus",
		rationale:          "The free selector retains its explicit prices while the reviewed \
		                     sibling fills both cache components.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "stepfun/step-3.5-flash:free",
		reference_provider: "openrouter",
		reference_model:    "stepfun/step-3.5-flash",
		rationale:          "The free selector inherits reviewed public prices while retaining its \
		                     explicit limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "stepfun/step-3.7-flash:free",
		reference_provider: "kilo",
		reference_model:    "stepfun/step-3.7-flash",
		rationale:          "The free selector inherits reviewed sibling prices while retaining its \
		                     explicit limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "tencent/hy3-preview:free",
		reference_provider: "kilo",
		reference_model:    "tencent/hy3-preview",
		rationale:          "The free selector inherits the reviewed sibling's complete price while \
		                     retaining its explicit limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "tencent/hy3:free",
		reference_provider: "nanogpt",
		reference_model:    "tencent/hy3",
		rationale:          "The free selector inherits the reviewed canonical deployment's \
		                     complete price while retaining its explicit limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "kilo",
		model:              "x-ai/grok-code-fast-1:optimized:free",
		reference_provider: "xai",
		reference_model:    "grok-code-fast-1",
		rationale:          "The stacked optimized/free selector inherits the reviewed native \
		                     card's complete price while retaining its explicit limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	ExactSourceReference {
		provider:           "nanogpt",
		model:              "Qwen/Qwen3-Next-80B-A3B-Instruct",
		reference_provider: "huggingface",
		reference_model:    "Qwen/Qwen3-Next-80B-A3B-Instruct",
		rationale:          "The reviewed Hugging Face card fills the NanoGPT selector's absent \
		                     prices while preserving its explicit limits.",
		provenance:         "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms:      None,
	},
	reviewed_source_reference(
		"nanogpt",
		"anthropic/claude-opus-4.6:thinking",
		"openrouter",
		"anthropic/claude-opus-4.6",
		"The thinking selector inherits the reviewed base card's missing cache-write component.",
	),
	reviewed_source_reference(
		"nanogpt",
		"anthropic/claude-opus-4.6:thinking:low",
		"openrouter",
		"anthropic/claude-opus-4.6",
		"The low thinking selector inherits the reviewed base card's missing cache-write component.",
	),
	reviewed_source_reference(
		"nanogpt",
		"anthropic/claude-opus-4.6:thinking:medium",
		"openrouter",
		"anthropic/claude-opus-4.6",
		"The medium thinking selector inherits the reviewed base card's missing cache-write \
		 component.",
	),
	reviewed_source_reference(
		"nanogpt",
		"anthropic/claude-opus-4.7:thinking",
		"openrouter",
		"anthropic/claude-opus-4.7",
		"The thinking selector inherits the reviewed base card's missing cache-write component.",
	),
	reviewed_source_reference(
		"nanogpt",
		"anthropic/claude-opus-4.8:thinking",
		"openrouter",
		"anthropic/claude-opus-4.8",
		"The thinking selector inherits the reviewed base card's missing cache-write component.",
	),
	reviewed_source_reference(
		"nanogpt",
		"anthropic/claude-sonnet-4.6:thinking",
		"openrouter",
		"anthropic/claude-sonnet-4.6",
		"The thinking selector inherits the reviewed base card's missing cache-write component.",
	),
	reviewed_source_reference(
		"*",
		"minimax/minimax-m2.1",
		"minimax",
		"MiniMax-M2.1",
		"Every exact deployment preserves explicit prices while the reviewed native card fills \
		 missing cache-write pricing.",
	),
	reviewed_source_reference(
		"*",
		"minimax/minimax-m2.5",
		"minimax",
		"MiniMax-M2.5",
		"Every exact deployment preserves explicit prices while the reviewed native card fills \
		 missing cache-write pricing.",
	),
	reviewed_source_reference(
		"*",
		"minimax/minimax-m2.7",
		"minimax",
		"MiniMax-M2.7",
		"Every exact deployment preserves explicit prices while the reviewed native card fills \
		 missing cache-write pricing.",
	),
	reviewed_source_reference(
		"*",
		"minimaxai/minimax-m2.1",
		"minimax",
		"MiniMax-M2.1",
		"Every exact deployment preserves explicit prices while the reviewed native card fills \
		 missing cache pricing.",
	),
	reviewed_source_reference(
		"*",
		"minimaxai/minimax-m2.5",
		"minimax",
		"MiniMax-M2.5",
		"Every exact deployment preserves explicit prices while the reviewed native card fills \
		 missing cache pricing.",
	),
	reviewed_source_reference(
		"*",
		"minimaxai/minimax-m2.7",
		"minimax",
		"MiniMax-M2.7",
		"Every exact deployment preserves explicit prices while the reviewed native card fills \
		 missing cache pricing.",
	),
	reviewed_source_reference(
		"nanogpt",
		"claude-opus-4-5-20251101:thinking",
		"anthropic",
		"claude-opus-4-5-20251101",
		"The thinking selector inherits the reviewed native card's missing cache-write component.",
	),
	reviewed_source_reference(
		"nanogpt",
		"moonshotai/kimi-k2-thinking-original",
		"nanogpt",
		"moonshotai/kimi-k2-thinking",
		"The original selector inherits the reviewed canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"moonshotai/kimi-k2-thinking-turbo-original",
		"moonshot",
		"kimi-k2-thinking-turbo",
		"The original turbo selector inherits the reviewed native deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"openai/o1-pro",
		"openai",
		"o1-pro",
		"The namespaced selector inherits the reviewed native deployment's complete price.",
	),
	reviewed_source_reference(
		"*",
		"qwen/qwen3-coder-plus",
		"openrouter",
		"qwen/qwen3-coder-plus",
		"Every exact deployment preserves explicit prices while the reviewed route fills missing \
		 cache-write pricing.",
	),
	reviewed_source_reference(
		"*",
		"qwen/qwen3-max",
		"openrouter",
		"qwen/qwen3-max",
		"Every exact deployment preserves explicit prices while the reviewed route fills missing \
		 cache pricing.",
	),
	reviewed_source_reference(
		"*",
		"qwen/qwen3-next-80b-a3b-instruct",
		"huggingface",
		"Qwen/Qwen3-Next-80B-A3B-Instruct",
		"Every exact deployment preserves explicit limits while the reviewed deployment fills \
		 absent prices.",
	),
	reviewed_source_reference(
		"*",
		"qwen/qwen3-next-80b-a3b-thinking",
		"huggingface",
		"Qwen/Qwen3-Next-80B-A3B-Thinking",
		"Every exact deployment preserves explicit limits while the reviewed deployment fills \
		 absent prices.",
	),
	reviewed_source_reference(
		"nanogpt",
		"qwen3-vl-235b-a22b-instruct-original",
		"openrouter",
		"qwen/qwen3-vl-235b-a22b-instruct",
		"The original selector inherits the reviewed route's complete prices and limits.",
	),
	reviewed_source_reference(
		"nanogpt",
		"x-ai/grok-4.20-multi-agent",
		"xai",
		"grok-4.20-multi-agent-beta-latest",
		"The reviewed native card fills the deployment's missing cache-read price without replacing \
		 explicit input or output prices.",
	),
	reviewed_source_reference(
		"nanogpt",
		"x-ai/grok-4.20-multi-agent-beta",
		"vercel-ai-gateway",
		"xai/grok-4.20-multi-agent-beta",
		"The beta selector inherits the reviewed gateway deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"xiaomi/mimo-v2-flash-original",
		"nanogpt",
		"xiaomi/mimo-v2-flash",
		"The original selector inherits the reviewed canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"zai-org/glm-4.5",
		"zai",
		"glm-4.5",
		"The reviewed native card fills the deployment's missing cache-read price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"zai-org/glm-4.6-original",
		"novita",
		"zai-org/glm-4.6",
		"The original selector inherits the reviewed version-exact deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"zai-org/glm-4.6v-original",
		"novita",
		"zai-org/glm-4.6v",
		"The original vision selector inherits the reviewed deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"zai-org/glm-4.6v-flash-original",
		"zenmux",
		"z-ai/glm-4.6v-flash",
		"The original vision-flash selector inherits the reviewed deployment's complete price.",
	),
	reviewed_source_reference(
		"novita",
		"deepseek/deepseek-v3/community",
		"vercel-ai-gateway",
		"deepseek/deepseek-v3",
		"The community deployment preserves explicit input and output prices while the reviewed \
		 route fills cache-read pricing.",
	),
	reviewed_source_reference(
		"nvidia",
		"meta/llama-4-scout-17b-16e-instruct",
		"zenmux",
		"meta/llama-4-scout-17b-16e-instruct",
		"The deployment inherits reviewed input and output prices before canonical cache components \
		 are filled.",
	),
	reviewed_source_reference(
		"nvidia",
		"qwen/qwen3.5-122b-a10b",
		"kilo",
		"qwen/qwen3.5-122b-a10b",
		"The deployment inherits reviewed input and output prices before the exact cache-read \
		 component is filled.",
	),
	reviewed_source_reference(
		"nvidia",
		"thinkingmachines/inkling",
		"huggingface",
		"thinkingmachines/Inkling",
		"The deployment inherits reviewed input and output prices before the deployment-specific \
		 cache-read component is filled.",
	),
	reviewed_source_reference(
		"openrouter",
		"arcee-ai/trinity-large-thinking:free",
		"openrouter",
		"arcee-ai/trinity-large-thinking",
		"The reviewed free selector inherits its canonical paid sibling's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"baidu/cobuddy:free",
		"novita",
		"baidu/cobuddy",
		"The reviewed free selector inherits its canonical paid deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"deepseek/deepseek-v4-flash:free",
		"deepseek",
		"deepseek-v4-flash",
		"The reviewed free selector inherits the native deployment's complete price.",
	),
	reviewed_source_reference(
		"zenmux",
		"deepseek/deepseek-v4-flash-free",
		"deepseek",
		"deepseek-v4-flash",
		"The reviewed free selector inherits the native deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"inclusionai/ling-2.6-1t:free",
		"nanogpt",
		"inclusionai/ling-2.6-1t",
		"The reviewed free selector inherits the canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"inclusionai/ling-2.6-flash:free",
		"nanogpt",
		"inclusionai/ling-2.6-flash",
		"The reviewed free selector inherits the canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"inclusionai/ring-2.6-1t:free",
		"nanogpt",
		"inclusionai/ring-2.6-1t",
		"The reviewed free selector inherits the canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"moonshotai/kimi-k2",
		"opencode-zen",
		"kimi-k2",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"openrouter",
		"moonshotai/kimi-k2-0905:exacto",
		"openrouter",
		"moonshotai/kimi-k2-0905",
		"The reviewed exact selector preserves explicit prices while inheriting canonical \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"openrouter",
		"moonshotai/kimi-k2.6:free",
		"coreweave",
		"moonshotai/Kimi-K2.6",
		"The reviewed free selector inherits the canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"nex-agi/nex-n2-pro:free",
		"openrouter",
		"nex-agi/nex-n2-pro",
		"The reviewed free selector inherits its canonical paid sibling's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"nvidia/nemotron-3-super-120b-a12b:free",
		"openrouter",
		"nvidia/nemotron-3-super-120b-a12b",
		"The reviewed free selector inherits its canonical paid sibling's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"nvidia/nemotron-3-ultra-550b-a55b:free",
		"nanogpt",
		"nvidia/nemotron-3-ultra-550b-a55b",
		"The reviewed free selector inherits the canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"openai/gpt-5.4-pro",
		"opencode",
		"gpt-5.4-pro",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"openrouter",
		"openai/gpt-5.5-pro",
		"opencode-zen",
		"gpt-5.5-pro",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"vercel-ai-gateway",
		"openai/gpt-5.4-pro",
		"opencode",
		"gpt-5.4-pro",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"vercel-ai-gateway",
		"openai/gpt-5.5-pro",
		"opencode-zen",
		"gpt-5.5-pro",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"zenmux",
		"openai/gpt-5.4-pro",
		"opencode",
		"gpt-5.4-pro",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"zenmux",
		"openai/gpt-5.5-pro",
		"opencode-zen",
		"gpt-5.5-pro",
		"The deployment preserves explicit input and output prices while the reviewed route fills \
		 cache-read pricing.",
	),
	reviewed_source_reference(
		"openrouter",
		"openai/gpt-oss-120b:exacto",
		"coreweave",
		"openai/gpt-oss-120b",
		"The exact selector preserves explicit input and output prices while the reviewed \
		 deployment fills cache-read pricing.",
	),
	reviewed_source_reference(
		"openrouter",
		"poolside/laguna-m.1:free",
		"openrouter",
		"poolside/laguna-m.1",
		"The reviewed free selector inherits its canonical paid sibling's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"poolside/laguna-xs-2.1:free",
		"kilo",
		"poolside/laguna-xs-2.1",
		"The reviewed free selector inherits the canonical deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"poolside/laguna-xs.2:free",
		"openrouter",
		"poolside/laguna-xs.2",
		"The reviewed free selector inherits its canonical paid sibling's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"qwen/qwen3.6-plus:free",
		"opencode-zen",
		"qwen3.6-plus",
		"The reviewed free selector inherits the native deployment's complete price.",
	),
	reviewed_source_reference(
		"openrouter",
		"stepfun/step-3.5-flash:free",
		"openrouter",
		"stepfun/step-3.5-flash",
		"The reviewed free selector inherits its canonical paid sibling's complete price.",
	),
	reviewed_source_reference(
		"zenmux",
		"xiaomi/mimo-v2-flash-free",
		"xiaomi",
		"mimo-v2-flash",
		"The reviewed free selector inherits the native deployment's complete price.",
	),
	reviewed_source_reference(
		"nanogpt",
		"baseten/Kimi-K2-Instruct-FP4",
		"nanogpt",
		"moonshotai/kimi-k2-instruct",
		"The reviewed native Kimi deployment supplies the FP4 selector's absent prices.",
	),
];

#[derive(Clone, Copy)]
struct SourceInheritanceOverride {
	provider:      Option<&'static str>,
	model:         &'static str,
	max_hops:      usize,
	prefer_suffix: bool,
	rationale:     &'static str,
	provenance:    &'static str,
	expires_at_ms: Option<u64>,
}

const fn reviewed_no_inheritance(
	provider: &'static str,
	model: &'static str,
	rationale: &'static str,
) -> SourceInheritanceOverride {
	SourceInheritanceOverride {
		provider: Some(provider),
		model,
		max_hops: 0,
		prefer_suffix: false,
		rationale,
		provenance: "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	}
}

const SOURCE_INHERITANCE_OVERRIDES: &[SourceInheritanceOverride] = &[
	SourceInheritanceOverride {
		provider:      Some("azure"),
		model:         "gpt-chat-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The declared Azure price is complete; the fuzzy Nanogpt suffix match is not \
		                upstream evidence.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      None,
		model:         "MiniMaxAI/MiniMax-M2.1",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The namespace is a reseller decoration; the bare MiniMax card is \
		                authoritative.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      None,
		model:         "MiniMaxAI/MiniMax-M2.5",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The namespace is a reseller decoration; the bare MiniMax card is \
		                authoritative.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      None,
		model:         "MiniMaxAI/MiniMax-M2.7",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The namespace is a reseller decoration; the bare MiniMax card is \
		                authoritative.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      None,
		model:         "MiniMaxAI/MiniMax-M3",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The namespace is a reseller decoration; the bare MiniMax card is \
		                authoritative.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      None,
		model:         "Qwen/Qwen3.5-122B-A10B",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The Qwen namespace is a reseller decoration; the reviewed bare card owns \
		                cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("huggingface"),
		model:         "deepseek-ai/DeepSeek-V3",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The provider namespace is decorative; the reviewed suffix index carries \
		                cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("aimlapi"),
		model:         "nemotron-3-nano-omni-30b-a3b-reasoning:free",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The free variant explicitly retains unknown limits and zero pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("kilo"),
		model:         "google/gemini-3-pro-preview",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The Google namespace is decorative; the reviewed native card owns cache \
		                pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("kilo"),
		model:         "minimax/minimax-m2.5:free",
		max_hops:      3,
		prefer_suffix: false,
		rationale:     "Three reviewed references separate free-tier prices from canonical \
		                cache-write pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("kilo"),
		model:         "minimax/minimax-m3:discounted",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed discounted selector explicitly remains zero-priced.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("kilo"),
		model:         "moonshotai/kimi-k2",
		max_hops:      1,
		prefer_suffix: true,
		rationale:     "The Moonshot namespace is decorative; the reviewed bare Kimi card owns \
		                cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "devstral-medium-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral card explicitly declares zero cache pricing; a fuzzy \
		                dated sibling must not overwrite it.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "codestral-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "devstral-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "magistral-medium-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "ministral-3b-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "ministral-8b-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "mistral-large-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "mistral-medium-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "mistral-small-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "pixtral-large-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("mistral"),
		model:         "voxtral-small-latest",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed Mistral rolling card explicitly declares zero cache pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("nanogpt"),
		model:         "Alibaba-NLP/Tongyi-DeepResearch-30B-A3B",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed NanoGPT row explicitly leaves limits unknown and prices zero; \
		                a namespaced source match is not evidence.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("nanogpt"),
		model:         "meituan-longcat/LongCat-Flash-Chat-FP8",
		max_hops:      0,
		prefer_suffix: false,
		rationale:     "The reviewed NanoGPT row explicitly leaves limits unknown and prices zero; \
		                a namespaced source match is not evidence.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("nvidia"),
		model:         "meta/llama-4-scout-17b-16e-instruct",
		max_hops:      2,
		prefer_suffix: true,
		rationale:     "Two reviewed exact references preserve the lower input/output price while \
		                adding cache-read and cache-write pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("nvidia"),
		model:         "qwen/qwen3.5-122b-a10b",
		max_hops:      2,
		prefer_suffix: true,
		rationale:     "Two reviewed exact references preserve lower input/output pricing while \
		                adding the cache-read component.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("nvidia"),
		model:         "thinkingmachines/inkling",
		max_hops:      2,
		prefer_suffix: true,
		rationale:     "Two reviewed exact references preserve input/output pricing while adding \
		                the deployment-specific cache-read component.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	SourceInheritanceOverride {
		provider:      Some("openrouter"),
		model:         "minimax/minimax-m2.5:free",
		max_hops:      2,
		prefer_suffix: true,
		rationale:     "Two reviewed references preserve free-tier prices while adding canonical \
		                cache-write pricing.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	reviewed_no_inheritance(
		"opencode-zen",
		"hy3-preview-free",
		"The reviewed free deployment explicitly preserves zero pricing.",
	),
	reviewed_no_inheritance(
		"opencode-zen",
		"laguna-s-2.1-free",
		"The reviewed free deployment explicitly preserves zero pricing.",
	),
	reviewed_no_inheritance(
		"opencode-zen",
		"ling-2.6-flash-free",
		"The reviewed free deployment explicitly preserves zero pricing.",
	),
	reviewed_no_inheritance(
		"opencode-zen",
		"ling-3.0-flash-free",
		"The reviewed free deployment explicitly preserves zero pricing.",
	),
	reviewed_no_inheritance(
		"opencode-zen",
		"ling-3.0-tiny-free",
		"The reviewed free deployment explicitly preserves zero pricing.",
	),
	reviewed_no_inheritance(
		"opencode-zen",
		"ring-2.6-1t-free",
		"The reviewed free deployment explicitly preserves zero pricing.",
	),
];

#[derive(Clone, Copy)]
struct ReferenceCandidatePolicy {
	provider:            &'static str,
	exclude_zero_prices: bool,
	rationale:           &'static str,
	provenance:          &'static str,
	expires_at_ms:       Option<u64>,
}

const REFERENCE_CANDIDATE_POLICIES: &[ReferenceCandidatePolicy] = &[ReferenceCandidatePolicy {
	provider:            "xai-oauth",
	exclude_zero_prices: true,
	rationale:           "Account-scoped OAuth rows carry unresolved zero prices and cannot serve \
	                      as canonical price references.",
	provenance:          "fixtures/llm-oracle/catalog/models.normalized.json",
	expires_at_ms:       None,
}];

#[derive(Clone, Copy)]
struct ExactInheritancePolicy {
	provider:                  &'static str,
	model:                     &'static str,
	inherit_limits:            bool,
	preserve_zero_cache_read:  bool,
	preserve_zero_cache_write: bool,
	rationale:                 &'static str,
	provenance:                &'static str,
	expires_at_ms:             Option<u64>,
}

const fn reviewed_inheritance_policy(
	provider: &'static str,
	model: &'static str,
	inherit_limits: bool,
	preserve_zero_cache_write: bool,
	rationale: &'static str,
) -> ExactInheritancePolicy {
	ExactInheritancePolicy {
		provider,
		model,
		inherit_limits,
		preserve_zero_cache_read: false,
		preserve_zero_cache_write,
		rationale,
		provenance: "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	}
}

const fn reviewed_zero_cache_read_policy(
	provider: &'static str,
	model: &'static str,
	rationale: &'static str,
) -> ExactInheritancePolicy {
	ExactInheritancePolicy {
		provider,
		model,
		inherit_limits: true,
		preserve_zero_cache_read: true,
		preserve_zero_cache_write: false,
		rationale,
		provenance: "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	}
}

const EXACT_INHERITANCE_POLICIES: &[ExactInheritancePolicy] = &[
	reviewed_inheritance_policy(
		"aimlapi",
		"nemotron-3-nano-omni-30b-a3b-reasoning:free",
		false,
		false,
		"The reviewed free selector preserves unknown limits while inheriting its canonical price.",
	),
	reviewed_inheritance_policy(
		"nanogpt",
		"google/gemini-3.5-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"nanogpt",
		"google/gemini-3.6-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-2.5-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-2.5-flash-lite-preview-09-2025",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-2.5-flash-preview-09-2025",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-2.5-pro",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-3-pro-preview",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-3.1-flash-lite",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-3.5-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-3.5-flash-lite",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"vercel-ai-gateway",
		"google/gemini-3.6-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_zero_cache_read_policy(
		"vercel-ai-gateway",
		"mistral/devstral-small",
		"The reviewed gateway deployment explicitly preserves zero cache-read pricing.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"bytedance/doubao-seed-code",
		false,
		false,
		"The reviewed deployment preserves unknown output limits while inheriting canonical prices.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"kuaishou/kat-coder-air-v2.5",
		false,
		false,
		"The reviewed deployment preserves unknown output limits while inheriting canonical prices.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"kuaishou/kat-coder-pro-v2.5",
		false,
		false,
		"The reviewed deployment preserves unknown output limits while inheriting canonical prices.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"google/gemini-3.1-flash-lite",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"google/gemini-3.5-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"google/gemini-3.5-flash-free",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"google/gemini-3.5-flash-lite",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
	reviewed_inheritance_policy(
		"zenmux",
		"google/gemini-3.6-flash",
		true,
		true,
		"The reviewed route explicitly preserves zero cache-write pricing.",
	),
];
fn inherit_source_references(models: &mut BTreeMap<Str, BTreeMap<Str, SourceModelRecord>>) {
	let snapshot = models.clone();
	let mut exact: BTreeMap<Str, (Str, Str)> = BTreeMap::new();
	for (provider, rows) in &snapshot {
		for (model, row) in rows {
			let candidate_policy = REFERENCE_CANDIDATE_POLICIES
				.iter()
				.find(|policy| policy.provider == provider.as_str());
			if candidate_policy.is_some_and(|policy| {
				debug_assert!(review_metadata_is_valid(
					policy.rationale,
					policy.provenance,
					policy.expires_at_ms,
				));
				policy.exclude_zero_prices && source_cost_is_zero(&row.cost)
			}) {
				continue;
			}
			let key = Str::from(model.trim().to_ascii_lowercase());
			let identity = (provider.clone(), model.clone());
			let replace = exact.get(&key).is_some_and(|existing| {
				reference_rank(&identity, row)
					> reference_rank(existing, &snapshot[&existing.0][&existing.1])
			});
			if replace || !exact.contains_key(&key) {
				exact.insert(key, identity);
			}
		}
	}
	let mut suffix: BTreeMap<Str, (Str, Str)> = BTreeMap::new();
	for identity in exact.values() {
		let Some(candidate) = identity
			.1
			.rsplit('/')
			.next()
			.filter(|candidate| *candidate != identity.1.as_str())
		else {
			continue;
		};
		let candidate = Str::from(candidate.trim().to_ascii_lowercase());
		let row = &snapshot[&identity.0][&identity.1];
		let replace = suffix.get(&candidate).is_some_and(|existing| {
			reference_rank(identity, row)
				> reference_rank(existing, &snapshot[&existing.0][&existing.1])
		});
		if replace || !suffix.contains_key(&candidate) {
			suffix.insert(candidate, identity.clone());
		}
	}
	for (provider, rows) in models {
		for (model, row) in rows {
			row.omitted_dynamic_pricing =
				[&row.cost.input, &row.cost.output, &row.cost.cache_read, &row.cost.cache_write]
					.into_iter()
					.any(|number| number.to_string() == "-1000000");
			if model.starts_with('@') {
				continue;
			}
			let max_hops = SOURCE_INHERITANCE_OVERRIDES
				.iter()
				.find(|override_| {
					debug_assert!(review_metadata_is_valid(
						override_.rationale,
						override_.provenance,
						override_.expires_at_ms,
					));
					override_
						.provider
						.is_none_or(|candidate| candidate == provider)
						&& override_.model == model
				})
				.map_or(1, |override_| override_.max_hops);
			if max_hops == 0 {
				continue;
			}
			let exact_reference = EXACT_SOURCE_REFERENCES.iter().find(|reference| {
				(reference.provider == "*" || reference.provider == provider.as_str())
					&& reference.model == model.as_str()
			});
			let mut current = (provider.clone(), model.clone());
			let mut visited = BTreeSet::new();
			while let Some(reference) = exact_reference
				.filter(|_| visited.is_empty())
				.map(|reference| {
					debug_assert!(review_metadata_is_valid(
						reference.rationale,
						reference.provenance,
						reference.expires_at_ms,
					));
					(Str::new(reference.reference_provider), Str::new(reference.reference_model))
				})
				.or_else(|| select_reference(&current.1, &current.0, &current.1, &exact, &suffix))
			{
				if !visited.insert(reference.clone()) {
					break;
				}
				let reference_row = &snapshot[&reference.0][&reference.1];
				let inheritance_policy = EXACT_INHERITANCE_POLICIES.iter().find(|policy| {
					debug_assert!(review_metadata_is_valid(
						policy.rationale,
						policy.provenance,
						policy.expires_at_ms,
					));
					policy.provider == provider.as_str() && policy.model == model.as_str()
				});
				let (inherit_limits, preserve_zero_cache_read, preserve_zero_cache_write) =
					inheritance_policy.map_or((true, false, false), |policy| {
						(
							policy.inherit_limits,
							policy.preserve_zero_cache_read,
							policy.preserve_zero_cache_write,
						)
					});
				inherit_source_row(
					row,
					reference_row,
					inherit_limits,
					preserve_zero_cache_read,
					preserve_zero_cache_write,
				);
				row.inherited_from
					.get_or_insert_with(|| ModelKey::new(format!("{}/{}", reference.0, reference.1)));
				current = reference;
				if visited.len() >= max_hops {
					break;
				}
			}
		}
	}
}

fn source_inheritance_override(
	provider: &str,
	model: &str,
) -> Option<&'static SourceInheritanceOverride> {
	SOURCE_INHERITANCE_OVERRIDES.iter().find(|override_| {
		debug_assert!(review_metadata_is_valid(
			override_.rationale,
			override_.provenance,
			override_.expires_at_ms,
		));
		override_
			.provider
			.is_none_or(|candidate| candidate == provider)
			&& override_.model == model
	})
}

fn select_reference(
	model: &str,
	provider: &str,
	original_model: &str,
	exact: &BTreeMap<Str, (Str, Str)>,
	suffix: &BTreeMap<Str, (Str, Str)>,
) -> Option<(Str, Str)> {
	if let Some(override_) = EXACT_SOURCE_REFERENCES.iter().find(|override_| {
		debug_assert!(review_metadata_is_valid(
			override_.rationale,
			override_.provenance,
			override_.expires_at_ms,
		));
		(override_.provider == "*" || override_.provider == provider)
			&& override_.model.eq_ignore_ascii_case(model)
	}) {
		return Some((Str::new(override_.reference_provider), Str::new(override_.reference_model)));
	}
	let mut candidates = reference_keys(model);
	let prefer_suffix = source_inheritance_override(provider, model)
		.is_some_and(|override_| override_.prefer_suffix)
		|| model.split_once('/').is_some_and(|(namespace, bare)| {
			let bare = classify(ClassificationInput {
				phase: ClassificationPhase::CatalogCompiler,
				provider,
				model: bare,
				observed_at_ms: None,
			});
			bare.class.as_str() == "qwen" && namespace.eq_ignore_ascii_case("qwen")
		});
	if prefer_suffix && candidates.len() > 1 {
		candidates.swap(0, 1);
	}
	let classified = classify(ClassificationInput {
		phase: ClassificationPhase::CatalogCompiler,
		provider,
		model,
		observed_at_ms: None,
	});
	if classified.logical_model.as_str() != model {
		candidates.push(classified.logical_model);
	}
	for candidate in candidates {
		let key = Str::from(candidate.trim().to_ascii_lowercase());
		let Some(reference) = exact.get(&key).or_else(|| suffix.get(&key)) else {
			continue;
		};
		if reference.0.as_str() != provider || reference.1.as_str() != original_model {
			return Some(reference.clone());
		}
	}
	None
}

fn reference_keys(model: &str) -> Vec<Str> {
	const MARKERS: &[&str] = &["cloud", "free", "discounted", "latest", "exacto", "search", "fp8"];
	let mut keys = Vec::new();
	let mut queue = vec![model.trim().to_ascii_lowercase()];
	let mut next = 0;
	while let Some(candidate) = queue.get(next).cloned() {
		next += 1;
		let candidate = candidate.trim().to_owned();
		if candidate.is_empty() || keys.iter().any(|seen: &Str| seen.as_str() == candidate) {
			continue;
		}
		keys.push(Str::from(candidate.clone()));
		if let Some((_, suffix)) = candidate.rsplit_once('/') {
			queue.push(suffix.to_owned());
		}
		if candidate.contains(':') {
			queue.push(candidate.replace(':', "-"));
		}
		for marker in MARKERS {
			if let Some(prefix) = candidate.strip_suffix(marker)
				&& let Some(stripped) = prefix.strip_suffix(['-', ':'])
			{
				queue.push(stripped.to_owned());
			}
		}
	}
	keys
}

fn reference_rank(identity: &(Str, Str), row: &SourceModelRecord) -> (u64, u64, bool, bool) {
	(
		row.context_window.unwrap_or(0),
		row.max_tokens.unwrap_or(0),
		source_price_present(&row.cost.cache_read) || source_price_present(&row.cost.cache_write),
		identity.0.as_str() == "openai",
	)
}

fn source_cost_is_zero(cost: &SourceCost) -> bool {
	[&cost.input, &cost.output, &cost.cache_read, &cost.cache_write]
		.into_iter()
		.all(|number| number.as_u64() == Some(0))
}

fn inherit_source_row(
	target: &mut SourceModelRecord,
	reference: &SourceModelRecord,
	inherit_limits: bool,
	preserve_zero_cache_read: bool,
	preserve_zero_cache_write: bool,
) {
	for (index, (target, source)) in [
		(&mut target.cost.input, &reference.cost.input),
		(&mut target.cost.output, &reference.cost.output),
		(&mut target.cost.cache_read, &reference.cost.cache_read),
		(&mut target.cost.cache_write, &reference.cost.cache_write),
	]
	.into_iter()
	.enumerate()
	{
		if preserve_zero_cache_read && index == 2 {
			continue;
		}
		if preserve_zero_cache_write && index == 3 {
			continue;
		}
		if target.as_u64() == Some(0) && source_price_present(source) {
			*target = source.clone();
		}
	}
	if inherit_limits {
		if target.context_window.is_none() {
			target.context_window = reference.context_window;
		}
		if target.max_tokens.is_none() {
			target.max_tokens = reference.max_tokens;
		}
	}
}

fn source_url_census(
	providers: &BTreeMap<Str, SourceProviderRecord>,
	models: &BTreeMap<Str, BTreeMap<Str, SourceModelRecord>>,
) -> usize {
	let mut urls = BTreeSet::new();
	for provider in providers.values() {
		urls.insert(provider.base_url.as_str());
		urls.extend(provider.fallback_base_urls.iter().map(Str::as_str));
		urls.extend(
			provider
				.headers
				.values()
				.map(Str::as_str)
				.filter(|value| value.starts_with("http://") || value.starts_with("https://")),
		);
	}
	urls.extend(
		models
			.values()
			.flat_map(BTreeMap::values)
			.filter_map(|model| model.base_url.as_ref())
			.map(Str::as_str)
			.filter(|value| !value.trim().is_empty()),
	);
	urls.len()
}

fn compile_oauth_specs(
	input: &str,
) -> Result<(Vec<OAuthSpec>, BTreeMap<Str, OAuthSpecId>), CompileError> {
	let document: SourceOAuthDocument = toml::from_str(input)?;
	let mut specs = Vec::with_capacity(document.provider.len());
	let mut ids = BTreeMap::new();
	for source in document.provider {
		validate_url(&source.authorize_url)?;
		if !source.token_url.is_empty() {
			validate_url(&source.token_url)?;
		}
		if let Some(url) = &source.refresh_url {
			validate_url(url)?;
		}
		let authorize_parameters = oauth_parameters(&source.authorize_params);
		let token_parameters = oauth_parameters(&source.token_params);
		let custom_parameters = oauth_parameters(&source.custom_params);
		let flow = match source.kind {
			SourceOAuthKind::Pkce => {
				let host = source
					.callback_host
					.as_ref()
					.map_or("127.0.0.1", Str::as_str);
				let path = source
					.callback_path
					.as_ref()
					.map_or("/callback", Str::as_str);
				let port = source.callback_port.ok_or_else(|| {
					CompileError::Invariant(Str::from(format!(
						"OAuth PKCE flow `{}` has no callback port",
						source.provider
					)))
				})?;
				OAuthFlowSpec::Pkce {
					authorize_url: source.authorize_url.clone(),
					redirect_uri: Str::from(format!("http://{host}:{port}{path}")),
					completion: OAuthCompletion::PasteCallbackUrl,
					authorize_parameters,
				}
			},
			SourceOAuthKind::DeviceCode => OAuthFlowSpec::DeviceCode {
				device_authorization_url: source.authorize_url.clone(),
				polling:                  OAuthPollingSpec {
					maximum_polls:       None,
					default_interval_ms: 5_000,
					maximum_interval_ms: 30_000,
				},
			},
			SourceOAuthKind::CustomExchange => OAuthFlowSpec::Custom {
				authorize_url: source.authorize_url.clone(),
				exchange:      source.exchange.ok_or_else(|| {
					CompileError::Invariant(Str::from(format!(
						"custom OAuth flow `{}` has no exchange engine",
						source.provider
					)))
				})?,
				parameters:    custom_parameters,
				polling:       None,
			},
		};
		let refresh = match source.refresh_url {
			Some(url) => OAuthRefreshBehavior::Endpoint { url, parameters: Box::new([]) },
			None if source.token_url.is_empty() => OAuthRefreshBehavior::Unsupported,
			None => OAuthRefreshBehavior::TokenEndpoint,
		};
		let principal_resolution = source.principal_resolution.map(PrincipalResolution::from);
		let canonical = serde_json::to_vec(&(
			&source.client_id,
			&source.token_url,
			&source.scopes,
			&token_parameters,
			&flow,
			&refresh,
			&principal_resolution,
		))?;
		let id = OAuthSpecId::new(content_id("oauth", &canonical));
		if ids.insert(source.provider.clone(), id.clone()).is_some() {
			return Err(CompileError::Invariant(Str::from(format!(
				"duplicate OAuth flow `{}`",
				source.provider
			))));
		}
		specs.push(OAuthSpec {
			id,
			client_id: source.client_id,
			token_url: source.token_url,
			scopes: source.scopes.into_boxed_slice(),
			audience: None,
			placement: OAuthTokenPlacement::Header {
				name:   sf!("authorization"),
				prefix: sf!("Bearer "),
			},
			token_parameters,
			flow,
			refresh,
			principal_resolution,
		});
	}
	specs.sort_by(|left, right| left.id.cmp(&right.id));
	Ok((specs, ids))
}

fn oauth_parameters(parameters: &BTreeMap<Str, Str>) -> Box<[OAuthParameter]> {
	parameters
		.iter()
		.map(|(name, value)| OAuthParameter { name: name.clone(), value: value.clone() })
		.collect()
}

fn facet_operations(facets: &[SourceFacet]) -> OperationBits {
	let mut operations = OperationBits::empty();
	for facet in facets {
		match facet {
			SourceFacet::Chat => operations.insert_kind(OperationKind::Chat),
			SourceFacet::Embeddings => operations.insert_kind(OperationKind::Embed),
			SourceFacet::ImageGeneration => operations.insert_kind(OperationKind::GenerateImage),
			SourceFacet::VideoGeneration => operations.insert_kind(OperationKind::GenerateVideo),
			SourceFacet::AudioSpeech => operations.insert_kind(OperationKind::Speak),
			SourceFacet::AudioTranscription => operations.insert_kind(OperationKind::Transcribe),
			SourceFacet::Realtime => operations.insert_kind(OperationKind::Realtime),
			SourceFacet::WebSearch => operations.insert_kind(OperationKind::Search),
			SourceFacet::WebExtract => operations.insert_kind(OperationKind::Extract),
			SourceFacet::Tokenization => {
				operations.insert_kind(OperationKind::CountTokens);
				operations.insert_kind(OperationKind::Tokenize);
				operations.insert_kind(OperationKind::Detokenize);
			},
		}
	}
	operations
}

#[allow(
	clippy::type_complexity,
	reason = "compiler phase returns each independently interned table"
)]
fn canonical_provider_base(provider: &str, base_url: Str) -> Str {
	if provider == "azure"
		&& (base_url.as_str().contains("{region}") || base_url.as_str().contains("{deployment}"))
	{
		Str::new_static("https://openai.azure.com/openai")
	} else {
		base_url
	}
}

fn compile_providers(
	providers: BTreeMap<Str, SourceProviderRecord>,
	oauth_ids: &BTreeMap<Str, OAuthSpecId>,
	oauth_specs: &[OAuthSpec],
) -> Result<
	(
		Vec<ProviderDef>,
		Vec<AuthSpec>,
		Vec<HeaderProfile>,
		Vec<DiscoverySpec>,
		Vec<RouteDef>,
		BTreeMap<Str, Vec<RouteId>>,
		BTreeMap<WirePolicyId, WirePolicy>,
		BTreeMap<Str, WirePolicyId>,
	),
	CompileError,
> {
	let mut output = Vec::new();
	let mut auth_by_id = BTreeMap::new();
	let mut headers_by_id = BTreeMap::new();
	let mut discovery_by_id = BTreeMap::new();
	let mut routes = Vec::new();
	let mut provider_routes = BTreeMap::new();
	let mut policies = BTreeMap::new();
	let mut provider_policies = BTreeMap::new();
	for (provider_key, source) in providers {
		let provider_id = ProviderId::new(provider_key.clone());
		let auth = compile_auth(&source.auth, oauth_ids)?;
		let auth_id = auth.id.clone();
		auth_by_id.entry(auth_id.clone()).or_insert(auth);
		let mut provider_auth_ids = Vec::with_capacity(3);
		let oauth_auth = source
			.oauth_auth
			.as_ref()
			.map(|auth| compile_auth(auth, oauth_ids))
			.transpose()?;
		let login_auth = if let Some(flow) = source.oauth_flow.as_ref()
			&& !matches!(&source.auth, SourceAuth::Oauth { flow: request_flow } if request_flow == flow)
		{
			Some(compile_auth(&SourceAuth::Oauth { flow: flow.clone() }, oauth_ids)?)
		} else {
			None
		};
		let prefer_login = source.oauth_flow.as_ref().is_some_and(|flow| {
			oauth_ids
				.get(flow)
				.and_then(|id| oauth_specs.iter().find(|spec| &spec.id == id))
				.is_some_and(|spec| {
					spec.principal_resolution.is_some()
						&& !matches!(spec.flow, OAuthFlowSpec::Custom { .. })
				})
		});
		if let Some(login_auth) = &login_auth
			&& prefer_login
		{
			provider_auth_ids.push(login_auth.id.clone());
		}
		provider_auth_ids.push(auth_id.clone());
		if let Some(oauth_auth) = oauth_auth {
			provider_auth_ids.push(oauth_auth.id.clone());
			auth_by_id
				.entry(oauth_auth.id.clone())
				.or_insert(oauth_auth);
		}
		if let Some(login_auth) = login_auth {
			if !prefer_login {
				provider_auth_ids.push(login_auth.id.clone());
			}
			auth_by_id
				.entry(login_auth.id.clone())
				.or_insert(login_auth);
		}
		let header = compile_headers(&source.headers)?;
		let header_id = header.id.clone();
		headers_by_id.entry(header_id.clone()).or_insert(header);
		let discovery = source
			.discovery
			.as_ref()
			.map(compile_discovery)
			.transpose()?;
		let discovery_id = discovery.as_ref().map(|entry| entry.id.clone());
		if let Some(discovery) = discovery {
			discovery_by_id
				.entry(discovery.id.clone())
				.or_insert(discovery);
		}
		let policy = compile_wire_policy(WirePolicy::overrides(), &source.compat)?;
		let policy_id = policy.content_id();
		policies.entry(policy_id.clone()).or_insert(policy);
		provider_policies.insert(provider_key.clone(), policy_id.clone());
		let mut urls = Vec::with_capacity(1 + source.fallback_base_urls.len());
		urls.push(source.base_url.clone());
		urls.extend(source.fallback_base_urls.iter().cloned());
		let mut owned_routes = Vec::with_capacity(
			urls
				.len()
				.saturating_add(source.additional_transports.len()),
		);
		let mut inherited_routes = Vec::with_capacity(urls.len());
		let mut route_operations = facet_operations(&source.facets);
		if discovery_id.is_some() {
			route_operations.insert_kind(OperationKind::DiscoverModels);
		}
		if !matches!(&source.auth, SourceAuth::None) || source.oauth_flow.is_some() {
			route_operations.insert_kind(OperationKind::Auth);
		}
		if source.usage {
			route_operations.insert_kind(OperationKind::Usage);
		}
		for (index, url) in urls.into_iter().enumerate() {
			let url = canonical_provider_base(&provider_key, url);
			validate_url(&url)?;
			let suffix = if index == 0 {
				"primary".to_owned()
			} else {
				format!("fallback-{index}")
			};
			let route_id = RouteId::new(format!("{provider_key}/{suffix}"));
			let (default_codec, default_transport) = translate_transport(source.transport);
			let codec = source.codec.clone().unwrap_or(default_codec);
			let transport = source.route_transport.unwrap_or(default_transport);
			let origin = url
				.as_str()
				.split('/')
				.take(3)
				.collect::<Vec<_>>()
				.join("/");
			routes.push(RouteDef {
				id: route_id.clone(),
				provider: provider_id.clone(),
				codec_profile: source.codec_profile,
				codec,
				transport,
				endpoint: EndpointSpec {
					base_url:    url,
					region:      None,
					api_version: source.api_version.clone(),
				},
				auth: auth_id.clone(),
				headers: header_id.clone(),
				discovery: discovery_id.clone(),
				capability_limits: RouteRestrictions {
					operations: (route_operations != OperationBits::empty()).then_some(route_operations),
					..RouteRestrictions::default()
				},
				trust_domain: TrustDomain {
					origin:          Str::from(origin),
					redirects:       RedirectTrust::SameOrigin,
					allow_plaintext: false,
				},
				codex_transport: if source.codex_transport.as_deref() == Some("websocket-preferred") {
					CodexTransportPreference::WebsocketPreferred
				} else {
					CodexTransportPreference::HttpOnly
				},
				use_responses_lite: Some(source.codex_responses_lite),
				priority: None,
			});
			owned_routes.push(route_id.clone());
			inherited_routes.push(route_id);
		}
		for additional in &source.additional_transports {
			let (codec, transport) = translate_transport(*additional);
			let base_url = canonical_provider_base(&provider_key, source.base_url.clone());
			let route_id = RouteId::new(format!("{provider_key}/{}", codec.as_str()));
			if owned_routes.contains(&route_id) {
				return Err(CompileError::Invariant(sf!(
					"provider `{provider_key}` declares duplicate route `{route_id}`"
				)));
			}
			let origin = base_url
				.as_str()
				.split('/')
				.take(3)
				.collect::<Vec<_>>()
				.join("/");
			routes.push(RouteDef {
				id: route_id.clone(),
				provider: provider_id.clone(),
				codec_profile: source.codec_profile,
				codec,
				transport,
				endpoint: EndpointSpec {
					base_url,
					region: None,
					api_version: source.api_version.clone(),
				},
				auth: auth_id.clone(),
				headers: header_id.clone(),
				discovery: discovery_id.clone(),
				capability_limits: RouteRestrictions {
					operations: (route_operations != OperationBits::empty()).then_some(route_operations),
					..RouteRestrictions::default()
				},
				trust_domain: TrustDomain {
					origin:          Str::from(origin),
					redirects:       RedirectTrust::SameOrigin,
					allow_plaintext: false,
				},
				codex_transport: if source.codex_transport.as_deref() == Some("websocket-preferred") {
					CodexTransportPreference::WebsocketPreferred
				} else {
					CodexTransportPreference::HttpOnly
				},
				use_responses_lite: Some(source.codex_responses_lite),
				priority: None,
			});
			owned_routes.push(route_id);
		}
		let mapping = match source.mapping {
			SourceMapping::Concrete => RegistryMapping::Concrete,
			SourceMapping::Alias { target, reason } => {
				RegistryMapping::Alias { target: ProviderId::new(target), reason }
			},
			SourceMapping::Replacement { component, reason } => {
				RegistryMapping::Replacement { component, reason }
			},
		};
		let mut management_operations = OperationBits::empty();
		if discovery_id.is_some() {
			management_operations.insert_kind(OperationKind::DiscoverModels);
		}
		if !matches!(&source.auth, SourceAuth::None) || source.oauth_flow.is_some() {
			management_operations.insert_kind(OperationKind::Auth);
		}
		if source.usage {
			management_operations.insert_kind(OperationKind::Usage);
		}
		let refresh_flow = source.oauth_flow.as_ref().or(match &source.auth {
			SourceAuth::Oauth { flow } => Some(flow),
			_ => None,
		});
		let refresh = refresh_flow
			.and_then(|flow| oauth_ids.get(flow))
			.and_then(|id| oauth_specs.iter().find(|spec| &spec.id == id))
			.is_some_and(|spec| !matches!(spec.refresh, OAuthRefreshBehavior::Unsupported));
		let discovery_defaults = discovery_id.is_some().then(|| DiscoveryDefaults {
			wire_policy:          policy_id.clone(),
			extended_wire_policy: None,
			context:              ContextStrategy::Replay,
			thinking:             None,
			pricing:              Pricing::default(),
		});
		output.push(ProviderDef {
			id: provider_id,
			name: humanize(&provider_key),
			auth: provider_auth_ids.into_boxed_slice(),
			management: ManagementCapabilities {
				operations: management_operations,
				multiple_accounts: source.oauth_flow.is_some(),
				refresh,
				principal_quota: true,
			},
			routes: owned_routes.clone().into_boxed_slice(),
			wire_policy: policy_id.clone(),
			discovery_defaults,
			mapping,
		});
		provider_routes.insert(provider_key, inherited_routes);
	}
	output.sort_by(|left, right| left.id.cmp(&right.id));
	routes.sort_by(|left, right| left.id.cmp(&right.id));
	Ok((
		output,
		auth_by_id.into_values().collect(),
		headers_by_id.into_values().collect(),
		discovery_by_id.into_values().collect(),
		routes,
		provider_routes,
		policies,
		provider_policies,
	))
}

fn compile_model_routes(
	models: &BTreeMap<Str, BTreeMap<Str, SourceModelRecord>>,
	providers: &mut [ProviderDef],
	routes: &mut Vec<RouteDef>,
	header_profiles: &mut Vec<HeaderProfile>,
	provider_routes: &BTreeMap<Str, Vec<RouteId>>,
) -> Result<BTreeMap<(Str, Str), Vec<RouteId>>, CompileError> {
	let mut output = BTreeMap::new();
	let mut route_by_shape: BTreeMap<Vec<u8>, RouteId> = BTreeMap::new();
	for (provider, rows) in models {
		let inherited = provider_routes.get(provider).ok_or_else(|| {
			CompileError::Invariant(Str::from(format!(
				"model provider `{provider}` has no curated route"
			)))
		})?;
		let primary_id = inherited.first().ok_or_else(|| {
			CompileError::Invariant(Str::from(format!("provider `{provider}` has no primary route")))
		})?;
		let primary = routes
			.iter()
			.find(|route| &route.id == primary_id)
			.cloned()
			.ok_or_else(|| CompileError::Invariant(sf!("provider primary route is missing")))?;
		for (model, row) in rows {
			let embedding_override = exact_capability_override(provider, model)
				.is_some_and(|override_| override_.correction == CapabilityCorrection::Embedding);
			let endpoint_override = row
				.base_url
				.as_ref()
				.filter(|url| !url.trim().is_empty() && **url != primary.endpoint.base_url);
			let transport_override = row.api.filter(|transport| {
				let (codec, kind) = translate_transport(*transport);
				codec != primary.codec || kind != primary.transport
			});
			let has_override = endpoint_override.is_some()
				|| transport_override.is_some()
				|| !row.headers.is_empty()
				|| row.use_responses_lite.is_some()
				|| row.prefer_websockets.is_some()
				|| row.priority.is_some()
				|| embedding_override;
			if !has_override {
				output.insert((provider.clone(), model.clone()), inherited.clone());
				continue;
			}
			let mut route = primary.clone();
			if let Some(url) = endpoint_override {
				validate_url(url)?;
				route.endpoint.base_url = url.clone();
				route.trust_domain.origin = Str::from(
					url.as_str()
						.split('/')
						.take(3)
						.collect::<Vec<_>>()
						.join("/"),
				);
			}
			if let Some(transport) = transport_override {
				(route.codec, route.transport) = translate_transport(transport);
			}
			if embedding_override {
				let operations = route
					.capability_limits
					.operations
					.get_or_insert_with(OperationBits::empty);
				operations.insert_kind(OperationKind::Embed);
			}
			if !row.headers.is_empty() {
				let profile = compile_headers(&row.headers).map_err(|error| {
					CompileError::Invariant(Str::from(format!(
						"source model `{provider}/{model}` has invalid headers: {error}"
					)))
				})?;
				route.headers = profile.id.clone();
				if !header_profiles
					.iter()
					.any(|existing| existing.id == profile.id)
				{
					header_profiles.push(profile);
				}
			}
			if let Some(lite) = row.use_responses_lite {
				route.use_responses_lite = Some(lite);
			}
			if row.prefer_websockets == Some(true) {
				route.codex_transport = CodexTransportPreference::WebsocketPreferred;
			}
			route.priority = row.priority;
			let shape = serde_json::to_vec(&(
				&route.provider,
				&route.codec,
				route.transport,
				&route.endpoint,
				&route.auth,
				&route.headers,
				&route.capability_limits,
				&route.codex_transport,
				route.use_responses_lite,
				route.priority,
			))?;
			let route_id = if let Some(existing) = route_by_shape.get(&shape) {
				existing.clone()
			} else {
				let id = RouteId::new(content_id("route", &shape));
				route.id = id.clone();
				routes.push(route);
				route_by_shape.insert(shape, id.clone());
				if let Some(owner) = providers
					.iter_mut()
					.find(|entry| entry.id.as_str() == provider.as_str())
				{
					let mut owned = owner.routes.to_vec();
					owned.push(id.clone());
					owned.sort();
					owned.dedup();
					owner.routes = owned.into_boxed_slice();
				}
				id
			};
			output.insert((provider.clone(), model.clone()), vec![route_id]);
		}
	}
	for provider in providers {
		let mut owned = provider.routes.to_vec();
		owned.sort();
		owned.dedup();
		provider.routes = owned.into_boxed_slice();
	}
	routes.sort_by(|left, right| left.id.cmp(&right.id));
	header_profiles.sort_by(|left, right| left.id.cmp(&right.id));
	Ok(output)
}

fn compile_models(
	providers: BTreeMap<Str, BTreeMap<Str, SourceModelRecord>>,
	model_routes: &BTreeMap<(Str, Str), Vec<RouteId>>,
	provider_policies: &BTreeMap<Str, WirePolicyId>,
	policies: &mut BTreeMap<WirePolicyId, WirePolicy>,
	thinking_policies: &mut BTreeMap<ThinkingPolicyId, ThinkingPolicy>,
	provider_facets: &BTreeMap<Str, Vec<SourceFacet>>,
	provider_transports: &BTreeMap<Str, SourceTransport>,
	cascade: &CompatCascade,
) -> Result<(Vec<ModelSpec>, Vec<CatalogAlias>), CompileError> {
	let mut output = Vec::new();
	let mut aliases = Vec::new();
	for (provider, rows) in providers {
		let provider_policy_id = provider_policies.get(&provider).ok_or_else(|| {
			CompileError::Invariant(Str::from(format!("provider `{provider}` has no wire policy")))
		})?;
		if !policies.contains_key(provider_policy_id) {
			return Err(CompileError::Invariant(sf!("provider wire policy was not interned",)));
		}
		let facets = provider_facets
			.get(&provider)
			.map(Vec::as_slice)
			.unwrap_or_default();
		let provider_transport = provider_transports
			.get(&provider)
			.copied()
			.ok_or_else(|| CompileError::Invariant(sf!("provider transport is missing")))?;
		let identities: BTreeMap<Str, ModelClassification> = rows
			.keys()
			.map(|model| {
				let classified = classify(ClassificationInput {
					phase: ClassificationPhase::CatalogCompiler,
					provider: &provider,
					model,
					observed_at_ms: None,
				});
				(model.clone(), classified)
			})
			.collect();
		let collapsible = collapsible_groups(&identities);
		let mut logical: BTreeMap<Str, Vec<(Str, SourceModelRecord, ModelClassification)>> =
			BTreeMap::new();
		for (wire, row) in rows {
			let classified = identities
				.get(&wire)
				.expect("classification index is complete");
			let key = if collapsible.contains(classified.logical_model.as_str()) {
				classified.logical_model.clone()
			} else {
				wire.clone()
			};
			logical
				.entry(key)
				.or_default()
				.push((wire, row, classified.clone()));
		}
		for (logical_id, members) in logical {
			let first = &members[0];
			let mut merged_row = first.1.clone();
			for (_, row, _) in members.iter().skip(1) {
				for input in &row.input {
					if !merged_row.input.contains(input) {
						merged_row.input.push(*input);
					}
				}
				for output in &row.output {
					if !merged_row.output.contains(output) {
						merged_row.output.push(*output);
					}
				}
			}
			let tier_reasoning = members.len() > 1
				&& members.iter().any(|(_, _, classified)| {
					classified.effort.is_some() || classified.thinking_variant
				});
			merged_row.reasoning = merged_row.reasoning || tier_reasoning;
			let class = first.2.class.clone();
			let display_name = first
				.1
				.name
				.clone()
				.map(|name| {
					if provider == "cursor"
						&& logical_id.as_str().starts_with("cursor-grok-")
						&& !name.as_str().starts_with("Cursor ")
					{
						Str::from(format!("Cursor {name}"))
					} else {
						name
					}
				})
				.unwrap_or_else(|| humanize(&logical_id));
			let context_window = members
				.iter()
				.filter_map(|(_, row, _)| row.context_window)
				.max();
			let maximum_output_tokens = members
				.iter()
				.filter_map(|(_, row, _)| row.max_tokens)
				.max();
			let mut routes = Vec::new();
			let mut wire_ids = Vec::new();
			for (wire, row, _) in &members {
				let member_routes = model_routes
					.get(&(provider.clone(), wire.clone()))
					.ok_or_else(|| {
						CompileError::Invariant(Str::from(format!(
							"source model `{provider}/{wire}` has no route"
						)))
					})?;
				for route in member_routes {
					routes.push(route.clone());
					wire_ids.push((
						route.clone(),
						WireModelId::new(row.request_model_id.clone().unwrap_or_else(|| wire.clone())),
					));
				}
			}
			routes.sort();
			routes.dedup();
			if members.len() > 1 {
				for route in &routes {
					wire_ids.push((route.clone(), WireModelId::new(logical_id.clone())));
				}
			}
			let capability_override = exact_capability_override(&provider, &logical_id);
			let resolved = cascade.resolve(&ResolveTarget {
				provider:  provider.as_str(),
				class:     class.as_str(),
				family:    first.2.family.as_ref().map(|family| family.as_str()),
				revision:  first.2.revision,
				model:     strip_effort_lane(provider.as_str(), logical_id.as_str()),
				reasoning: tier_reasoning || members.iter().any(|(_, row, _)| row.thinking.is_some()),
			})?;
			let pricing = compile_pricing(
				provider.as_str(),
				logical_id.as_str(),
				&first.1.cost,
				resolved.catalog.get("longContext"),
			)?;
			let edit_revision = resolved
				.catalog
				.get("editRevision")
				.and_then(Value::as_str)
				.map(Str::new)
				.or_else(|| first.1.edit_revision.clone());
			if resolved.thinking.contains_key("efforts") {
				merged_row.reasoning = true;
			}
			let mut capabilities = conservative_capabilities(
				&merged_row,
				facets,
				capability_override.map(|override_| override_.correction),
			);
			if hosted_image_model(&provider, &logical_id, &members, provider_transport) {
				capabilities
					.operations
					.insert_kind(OperationKind::GenerateImage);
				capabilities.image = Some(ImageCapabilities {
					features:         ImageFeatureBits::GENERATE,
					input_modalities: ModalityBits::TEXT,
					maximum_outputs:  None,
					maximum_pixels:   None,
				});
			}
			let has_wire_overrides = !resolved.wire.is_empty();
			let wire_overrides = axis_map_to_source_wire_policy(resolved.wire)?;
			let thinking_profile = if capabilities.chat.is_none()
				|| !merged_row.reasoning
				|| !resolved.thinking.contains_key("efforts")
				|| !resolved.thinking.contains_key("mode")
			{
				None
			} else {
				Some(axis_map_to_thinking_policy(resolved.thinking)?)
			};
			let mut wire_policy = if has_wire_overrides {
				compile_wire_policy(WirePolicy::overrides(), &wire_overrides)?
			} else {
				WirePolicy::baseline()
			};
			// Verbatim source-stage compatibility metadata is authoritative for
			// model-specific policy; the cascade supplies only absent defaults.
			for (_, row, _) in &members {
				if let Some(source) = row.compat_config.as_ref().or(row.compat.as_ref()) {
					wire_policy = compile_wire_policy(wire_policy, source)?;
				}
			}
			if let Some(enabled) = first.1.cursor_max_mode {
				wire_policy.context.extended_mode = Some(ExtendedContextMode::from_enabled(enabled));
			}
			if first.1.requires_glyph_tokenization == Some(true) {
				wire_policy.context.glyph_tokenization = Some(true);
			}
			if let Some(omit) = first.1.omit_max_output_tokens {
				wire_policy.context.max_output_tokens = Some(if omit {
					MaxOutputTokensEmission::Omit
				} else {
					MaxOutputTokensEmission::Emit
				});
			}
			if let Some(kind) = first.1.apply_patch_tool_type.as_deref() {
				wire_policy.tool.apply_patch =
					Some(kind.parse::<ApplyPatchWireKind>().map_err(|_| {
						CompileError::Invariant(Str::from(format!(
							"unknown apply-patch wire kind `{kind}` for `{provider}/{logical_id}`"
						)))
					})?);
			}
			if let Some(supported) = first.1.supports_computer_use {
				wire_policy.tool.computer_use = Some(if supported {
					ComputerUseWireSupport::Native
				} else {
					ComputerUseWireSupport::Unsupported
				});
			}
			if let Some(supported) = first.1.supports_computer_use_config {
				wire_policy.tool.computer_use_config = Some(if supported {
					ComputerUseConfigSupport::Supported
				} else {
					ComputerUseConfigSupport::Unsupported
				});
			}
			let (thinking, mut thinking_routing) = if capabilities.chat.is_some() {
				compile_thinking(provider.as_str(), &members, thinking_profile)?
			} else {
				(None, ThinkingRouting::default())
			};
			if let Some(chat) = capabilities.chat.as_mut() {
				chat.reasoning = reasoning_capabilities(merged_row.reasoning, thinking.as_ref());
				chat.prompt_caching = prompt_cache_capabilities(&wire_policy, &pricing);
			}
			let wire_policy_id = wire_policy.content_id();
			policies
				.entry(wire_policy_id.clone())
				.or_insert(wire_policy);
			if thinking.is_some()
				&& let Some(mode) = first.1.reasoning_mode.as_deref()
			{
				thinking_routing.reasoning_mode =
					Some(mode.parse::<ReasoningMode>().map_err(|_| {
						CompileError::Invariant(Str::from(format!("unknown reasoning mode `{mode}`")))
					})?);
			}
			let key = ModelKey::new(format!("{provider}/{logical_id}"));
			let thinking_id = thinking.as_ref().map(|profile| {
				let id = profile.content_id();
				thinking_policies
					.entry(id.clone())
					.or_insert_with(|| profile.clone());
				id
			});
			for (wire, _, classified) in &members {
				if wire.as_str() != logical_id.as_str() {
					aliases.push(CatalogAlias {
						alias:      Str::from(format!("{provider}/{wire}")),
						target:     key.clone(),
						rationale:  classified.evidence.rationale.clone(),
						provenance: classified.evidence.provenance.clone(),
					});
				}
			}
			for wire in thinking_routing.effort_routing.values() {
				if provider == "cursor"
					&& wire.as_str() != logical_id.as_str()
					&& !members
						.iter()
						.any(|(member, ..)| member.as_str() == wire.as_str())
				{
					aliases.push(CatalogAlias {
						alias:      Str::from(format!("{provider}/{wire}")),
						target:     key.clone(),
						rationale:  sf!("provider-declared effort route of one logical model"),
						provenance: sf!("catalog-oracle:thinking-routing"),
					});
				}
			}
			let mut provenance_sources = vec![ProvenanceSource {
				kind:           ProvenanceKind::Bundled,
				origin:         sf!("catalog-oracle/models.json.zst"),
				revision:       None,
				confidence:     EvidenceConfidence::Declared,
				observed_at_ms: None,
			}];
			if let Some(reference) = members
				.iter()
				.find_map(|(_, row, _)| row.inherited_from.as_ref())
			{
				provenance_sources.push(ProvenanceSource {
					kind:           ProvenanceKind::Bundled,
					origin:         Str::from(format!("catalog-oracle:inherit:{reference}")),
					revision:       None,
					confidence:     EvidenceConfidence::Inferred,
					observed_at_ms: None,
				});
			}
			if members
				.iter()
				.any(|(_, row, _)| row.omitted_dynamic_pricing)
			{
				provenance_sources.push(ProvenanceSource {
					kind:           ProvenanceKind::Bundled,
					origin:         sf!("catalog-oracle:omit:dynamic-pricing-sentinel"),
					revision:       None,
					confidence:     EvidenceConfidence::Inferred,
					observed_at_ms: None,
				});
			}
			if let Some(override_) = capability_override {
				provenance_sources.push(ProvenanceSource {
					kind:           ProvenanceKind::Bundled,
					origin:         Str::from(format!("{}#{}", override_.provenance, override_.id)),
					revision:       None,
					confidence:     EvidenceConfidence::Verified,
					observed_at_ms: None,
				});
			}
			output.push(ModelSpec {
				key,
				class,
				display_name,
				wire_ids: wire_ids.into_boxed_slice(),
				routes: routes.into_boxed_slice(),
				capabilities,
				limits: ModelLimits {
					context_window,
					maximum_input_tokens: None,
					maximum_output_tokens,
					maximum_batch: None,
				},
				thinking: thinking_id,
				thinking_routing,
				wire_policy: wire_policy_id,
				context: ContextStrategy::Replay,
				pricing,
				availability: ModelAvailability::Unspecified,
				provenance: ModelProvenance {
					sources:          provenance_sources.into_boxed_slice(),
					updated_at_ms:    None,
					blocked_until_ms: None,
					deprecated:       members.iter().all(|(_, row, _)| row.deprecated),
				},
				context_promotion_target: first.1.context_promotion_target.as_ref().map(|target| {
					ModelKey::new(if target.contains('/') {
						target.clone()
					} else {
						Str::from(format!("{provider}/{target}"))
					})
				}),
				compaction_model: first.1.compaction_model.as_ref().map(|target| {
					ModelKey::new(if target.contains('/') {
						target.clone()
					} else {
						Str::from(format!("{provider}/{target}"))
					})
				}),
				edit_revision,
				remote_compaction: first.1.remote_compaction.as_ref().map(|source| {
					ModelRemoteCompaction {
						enabled:              source.enabled,
						transport:            source
							.api
							.map(|transport| translate_transport(transport).0),
						endpoint:             source.endpoint.clone(),
						v2_streaming_enabled: source.v2_streaming_enabled,
						v2_endpoint:          source.v2_endpoint.clone(),
						streaming_endpoint:   source.streaming_endpoint.clone(),
						model:                source.model.clone().map(WireModelId::new),
						trigger_tokens:       None,
						target_tokens:        None,
					}
				}),
				premium_multiplier_millionths: first
					.1
					.premium_multiplier
					.as_ref()
					.map(decimal_millionths)
					.transpose()?
					.map(PremiumMultiplier::from_millionths),
			});
		}
	}
	retarget_collapsed_model_references(&mut output, &aliases);
	aliases.sort_by(|left, right| {
		left
			.alias
			.cmp(&right.alias)
			.then_with(|| left.target.cmp(&right.target))
	});
	aliases.dedup_by(|left, right| left.alias == right.alias && left.target == right.target);
	if let Some(pair) = aliases
		.windows(2)
		.find(|pair| pair[0].alias == pair[1].alias)
	{
		return Err(CompileError::Invariant(Str::from(format!(
			"variant alias has multiple logical targets: `{}` targets `{}` and `{}`",
			pair[0].alias, pair[0].target, pair[1].target
		))));
	}
	let attached = output
		.iter()
		.filter_map(|model| model.thinking.as_ref())
		.cloned()
		.collect::<BTreeSet<_>>();
	thinking_policies.retain(|id, _| attached.contains(id));
	Ok((output, aliases))
}

fn hosted_image_model(
	provider: &str,
	logical_id: &str,
	members: &[(Str, SourceModelRecord, ModelClassification)],
	provider_transport: SourceTransport,
) -> bool {
	if !crate::model_operation_overrides(provider, logical_id)
		.contains_kind(OperationKind::GenerateImage)
	{
		return false;
	}
	members.iter().any(|(_, row, _)| {
		matches!(
			row.api.unwrap_or(provider_transport),
			SourceTransport::OpenAiResponses | SourceTransport::OpenAiCodex
		)
	})
}

fn enable_hosted_image_routes(models: &[ModelSpec], routes: &mut [RouteDef]) {
	let image_routes = models
		.iter()
		.filter(|model| {
			model
				.capabilities
				.operations
				.contains_kind(OperationKind::GenerateImage)
		})
		.flat_map(|model| model.routes.iter())
		.collect::<BTreeSet<_>>();
	for route in routes {
		if image_routes.contains(&route.id)
			&& matches!(route.provider.as_str(), "openai" | "openai-codex")
			&& matches!(route.codec.as_str(), "openai-responses" | "openai-codex")
		{
			route
				.capability_limits
				.operations
				.get_or_insert_with(OperationBits::empty)
				.insert_kind(OperationKind::GenerateImage);
		}
	}
}

fn retarget_collapsed_model_references(models: &mut [ModelSpec], aliases: &[CatalogAlias]) {
	let live = models
		.iter()
		.map(|model| model.key.clone())
		.collect::<BTreeSet<_>>();
	let aliases = aliases
		.iter()
		.filter(|alias| live.contains(&alias.target))
		.map(|alias| (alias.alias.clone(), alias.target.clone()))
		.collect::<BTreeMap<_, _>>();
	for model in models {
		retarget_collapsed_model_reference(&mut model.context_promotion_target, &live, &aliases);
		retarget_collapsed_model_reference(&mut model.compaction_model, &live, &aliases);
	}
}

fn retarget_collapsed_model_reference(
	reference: &mut Option<ModelKey>,
	live: &BTreeSet<ModelKey>,
	aliases: &BTreeMap<Str, ModelKey>,
) {
	let Some(target) = reference else {
		return;
	};
	if live.contains(target) {
		return;
	}
	if let Some(replacement) = aliases.get(target.as_str())
		&& live.contains(replacement)
	{
		*target = replacement.clone();
	}
}

fn collapsible_groups(classified: &BTreeMap<Str, ModelClassification>) -> BTreeSet<Str> {
	let raw: BTreeSet<&str> = classified.keys().map(Str::as_str).collect();
	let mut tiers: BTreeMap<&str, Vec<EffortTier>> = BTreeMap::new();
	let mut result = BTreeSet::new();
	for value in classified.values() {
		if value.thinking_variant && raw.contains(value.logical_model.as_str()) {
			result.insert(value.logical_model.clone());
		}
		if let Some(effort) = value.effort {
			tiers
				.entry(value.logical_model.as_str())
				.or_default()
				.push(effort);
		}
	}
	for (logical, efforts) in tiers {
		let distinct = efforts.iter().copied().collect::<BTreeSet<_>>();
		if efforts.len() >= 2 && distinct.len() == efforts.len() {
			result.insert(Str::new(logical));
		}
	}
	result
}

fn axis_map_to_source_wire_policy(source: AxisMap) -> Result<SourceWirePolicy, CompileError> {
	let mut object = Map::new();
	for (key, value) in source {
		let key = match key.as_str() {
			"supports_usage_in_streaming" => "usage_in_streaming",
			"supports_forced_tool_choice" => "forced_tool_choice",
			key => key,
		};
		object.insert(key.to_owned(), value);
	}
	Ok(serde_json::from_value(Value::Object(object))?)
}

fn axis_map_to_thinking_policy(source: AxisMap) -> Result<ThinkingPolicy, CompileError> {
	let mut object = Map::new();
	for (key, value) in source {
		object.insert(key.as_str().to_owned(), value);
	}
	Ok(serde_json::from_value(Value::Object(object))?)
}

fn compile_wire_policy(
	mut policy: WirePolicy,
	source: &SourceWirePolicy,
) -> Result<WirePolicy, CompileError> {
	policy.usage.in_streaming = source.usage_in_streaming.or(policy.usage.in_streaming);
	policy.context.glyph_tokenization = source
		.glyph_tokenization
		.or(policy.context.glyph_tokenization);
	policy.role.multiple_system_messages = source
		.multiple_system_messages
		.or(policy.role.multiple_system_messages);
	policy.context.max_tokens_field =
		parse_policy(source.max_tokens_field.as_deref(), policy.context.max_tokens_field)?;
	policy.structured.sampling_params = source.sampling_params.or(policy.structured.sampling_params);
	policy.structured.penalties = source.penalties.or(policy.structured.penalties);
	policy.tool.strict_mode =
		parse_policy(source.tool_strict_mode.as_deref(), policy.tool.strict_mode)?;
	policy.tool.named_choice = source.named_tool_choice.or(policy.tool.named_choice);
	policy.tool.forced_choice = source.forced_tool_choice.or(policy.tool.forced_choice);
	policy.tool.flatten_root_unions = source
		.flatten_root_unions
		.or(policy.tool.flatten_root_unions);
	policy.tool.id_profile = match source.tool_call_id_profile.as_deref() {
		Some("mistral9_alnum") => Some(ToolCallIdProfile::Mistral9Alnum),
		Some("open_ai40") => Some(ToolCallIdProfile::OpenAi40),
		value => parse_policy(value, policy.tool.id_profile)?,
	};
	policy.reasoning.wire_format =
		parse_policy(source.reasoning_wire_format.as_deref(), policy.reasoning.wire_format)?;
	policy.reasoning.interleaved_thinking = source
		.interleaved_thinking
		.or(policy.reasoning.interleaved_thinking);
	policy.context.stateful_response_chaining = source
		.stateful_response_chaining
		.or(policy.context.stateful_response_chaining);
	policy.tool.thinking_conflict =
		parse_policy(source.thinking_tool_choice_conflict.as_deref(), policy.tool.thinking_conflict)?;
	policy.cache.control_format =
		parse_policy(source.cache_control_format.as_deref(), policy.cache.control_format)?;
	policy.cache.prompt_cache_mode =
		parse_policy(source.prompt_cache_mode.as_deref(), policy.cache.prompt_cache_mode)?;
	policy.cache.minimum_tokens = source
		.prompt_cache_minimum_tokens
		.or(policy.cache.minimum_tokens);
	policy.cache.maximum_checkpoints = source
		.prompt_cache_max_checkpoints
		.or(policy.cache.maximum_checkpoints);
	policy.image.encoding =
		parse_policy(source.image_encoding_format.as_deref(), policy.image.encoding)?;
	policy.structured.stop_sequences = source.stop_sequences.or(policy.structured.stop_sequences);
	policy.tool.schema_flavor =
		parse_policy(source.tool_schema_flavor.as_deref(), policy.tool.schema_flavor)?;
	policy.reasoning.leaked_healer =
		parse_policy(source.leaked_thinking_healer.as_deref(), policy.reasoning.leaked_healer)?;
	policy.reasoning.loop_guard = source.thinking_loop_guard.or(policy.reasoning.loop_guard);
	if let Some(watchdog) = source.stream_watchdog {
		policy.streaming.watchdog = Some(StreamWatchdog {
			first_event_ms: watchdog.first_event_ms,
			idle_ms:        watchdog.idle_ms,
		});
	}
	policy.streaming.protocol =
		parse_policy(source.stream_protocol.as_deref(), policy.streaming.protocol)?;
	policy.audio.api_version =
		parse_policy(source.audio_api_version.as_deref(), policy.audio.api_version)?;
	policy.role.supports_developer_role = source
		.supports_developer_role
		.or(policy.role.supports_developer_role);
	policy.role.supports_mid_conversation_system = source
		.supports_mid_conversation_system
		.or(policy.role.supports_mid_conversation_system);
	policy.tool.supports_tool_choice = source
		.supports_tool_choice
		.or(policy.tool.supports_tool_choice);
	policy.tool.escape_builtin_names = source
		.escape_builtin_tool_names
		.or(policy.tool.escape_builtin_names);
	policy.tool.requires_result_id = source
		.requires_tool_result_id
		.or(policy.tool.requires_result_id);
	policy.tool.eager_input_streaming = source
		.supports_eager_tool_input_streaming
		.or(policy.tool.eager_input_streaming);
	policy.tool.requires_assistant_content = source
		.requires_assistant_content_for_tool_calls
		.or(policy.tool.requires_assistant_content);
	policy.tool.disable_reasoning_on_choice = source
		.disable_reasoning_on_tool_choice
		.or(policy.tool.disable_reasoning_on_choice);
	policy.structured.sampling_params = source
		.supports_sampling_params
		.or(policy.structured.sampling_params);
	policy.reasoning.supports_effort = source
		.supports_reasoning_effort
		.or(policy.reasoning.supports_effort);
	policy.reasoning.supports_summary = source
		.supports_reasoning_summary
		.or(policy.reasoning.supports_summary);
	policy.reasoning.omit_effort = source
		.omit_reasoning_effort
		.or(policy.reasoning.omit_effort);
	policy.reasoning.template_reasoning_effort = source
		.template_reasoning_effort
		.or(policy.reasoning.template_reasoning_effort);
	if !source.reasoning_effort_map.is_empty() {
		policy
			.reasoning
			.effort_map
			.clone_from(&source.reasoning_effort_map);
	}
	policy.reasoning.disable_mode =
		parse_policy(source.reasoning_disable_mode.as_deref(), policy.reasoning.disable_mode)?;
	policy.reasoning.content_field = source
		.reasoning_content_field
		.clone()
		.or(policy.reasoning.content_field);
	policy.reasoning.requires_content_for_tool_calls = source
		.requires_reasoning_content_for_tool_calls
		.or(policy.reasoning.requires_content_for_tool_calls);
	policy.reasoning.requires_content_for_all_assistant_turns = source
		.requires_reasoning_content_for_all_assistant_turns
		.or(policy.reasoning.requires_content_for_all_assistant_turns);
	policy.reasoning.allows_synthetic_content_for_tool_calls = source
		.allows_synthetic_reasoning_content_for_tool_calls
		.or(policy.reasoning.allows_synthetic_content_for_tool_calls);
	policy.reasoning.filter_history = source
		.filter_reasoning_history
		.or(policy.reasoning.filter_history);
	policy.reasoning.include_encrypted = source
		.include_encrypted_reasoning
		.or(policy.reasoning.include_encrypted);
	policy.reasoning.replay_unsigned = source
		.replay_unsigned_thinking
		.or(policy.reasoning.replay_unsigned);
	policy.reasoning.requires_enabled = source
		.requires_thinking_enabled
		.or(policy.reasoning.requires_enabled);
	policy.reasoning.disable_adaptive = source
		.disable_adaptive_thinking
		.or(policy.reasoning.disable_adaptive);
	policy.reasoning.official_endpoint = source
		.official_endpoint
		.or(policy.reasoning.official_endpoint);
	policy.reasoning.signing_endpoint = source
		.signing_endpoint
		.or(policy.reasoning.signing_endpoint);
	policy.reasoning.thinking_format =
		parse_policy(source.thinking_format.as_deref(), policy.reasoning.thinking_format)?;
	if let Some(raw) = &source.extra_body {
		policy.reasoning.extra_body =
			Some(serde_json::from_str::<ReasoningBodyOverride>(raw.json())?);
	}
	if let Some(raw) = &source.when_thinking {
		policy.reasoning.when_thinking =
			Some(serde_json::from_str::<WhenThinkingPolicy>(raw.json())?);
	}
	policy.cache.supports_long_retention = source
		.supports_long_cache_retention
		.or(policy.cache.supports_long_retention);
	policy.context.supports_store = source.supports_store.or(policy.context.supports_store);
	policy.image.supports_detail_original = source
		.supports_image_detail_original
		.or(policy.image.supports_detail_original);
	if let Some(idle_ms) = source.stream_idle_timeout_ms {
		let mut watchdog = policy.streaming.watchdog.unwrap_or_default();
		watchdog.idle_ms = Some(idle_ms);
		policy.streaming.watchdog = Some(watchdog);
	}
	policy.streaming.thinking_close_max_retries = source
		.thinking_close_max_retries
		.or(policy.streaming.thinking_close_max_retries);
	Ok(policy)
}

fn parse_policy<T>(source: Option<&str>, inherited: Option<T>) -> Result<Option<T>, CompileError>
where
	T: str::FromStr,
{
	source
		.map(|value| {
			value.parse().map_err(|_| {
				CompileError::Invariant(Str::from(format!("unknown policy value `{value}`")))
			})
		})
		.transpose()
		.map(|parsed| parsed.or(inherited))
}

fn inferred_cursor_default(model: &str) -> Option<ThinkingEffort> {
	match model {
		"claude-opus-5-thinking" => Some(ThinkingEffort::XHigh),
		"gemini-3.6-flash" => Some(ThinkingEffort::Minimal),
		"glm-5.2" => Some(ThinkingEffort::High),
		"cursor-grok-4.5"
		| "cursor-grok-4.5-fast"
		| "gpt-5.4"
		| "gpt-5.4-mini"
		| "gpt-5.4-nano"
		| "gpt-5.5"
		| "gpt-5.6-luna"
		| "gpt-5.6-sol"
		| "gpt-5.6-terra" => Some(ThinkingEffort::Low),
		_ => None,
	}
}

fn compile_thinking(
	provider: &str,
	members: &[(Str, SourceModelRecord, ModelClassification)],
	profile: Option<ThinkingPolicy>,
) -> Result<(Option<ThinkingPolicy>, ThinkingRouting), CompileError> {
	let source = members.iter().find_map(|(_, row, _)| row.thinking.as_ref());
	let mut classified_efforts: SmallVec<ThinkingEffort, 6> = members
		.iter()
		.filter_map(|(_, _, classified)| classified.effort.map(translate_effort))
		.collect();
	classified_efforts.sort();
	classified_efforts.dedup();
	let tier_collapsed = classified_efforts.len() >= 2;
	let synthesize_cursor =
		supports_dynamic_effort_siblings(provider) && tier_collapsed && source.is_none();
	let mut profile = if synthesize_cursor {
		let efforts = classified_efforts
			.iter()
			.copied()
			.filter(|effort| *effort != ThinkingEffort::Off)
			.collect::<SmallVec<_, 6>>();
		let has_off_route = members.iter().any(|(_, _, classified)| {
			classified.effort == Some(EffortTier::Off)
				|| (classified.effort.is_none() && !classified.thinking_variant)
		});
		let default_level = (!has_off_route).then(|| {
			members
				.iter()
				.filter_map(|(_, _, classified)| classified.effort.map(translate_effort))
				.find(|effort| *effort != ThinkingEffort::Off)
				.expect("collapsed effort family has a non-off route")
		});
		Some(ThinkingPolicy {
			mode: ThinkingMode::Effort,
			efforts,
			default_level,
			effort_budgets: BTreeMap::new(),
			supports_display: None,
			suppress_when_off: None,
			requires_effort: (!has_off_route).then_some(true),
		})
	} else if profile.is_none()
		&& let Some(source) = source
		&& !source.efforts.is_empty()
	{
		Some(ThinkingPolicy {
			mode:              source.mode,
			efforts:           source.efforts.clone(),
			default_level:     source.default_level,
			effort_budgets:    source.effort_budgets.clone(),
			supports_display:  None,
			suppress_when_off: None,
			requires_effort:   None,
		})
	} else {
		profile
	};
	if supports_dynamic_effort_siblings(provider)
		&& let Some(profile) = profile.as_mut()
		&& profile.default_level.is_none()
		&& let Some(default) = inferred_cursor_default(members[0].2.logical_model.as_str())
		&& profile.supports(default)
	{
		profile.default_level = Some(default);
		profile.requires_effort = Some(true);
	}
	if let Some(profile) = &profile {
		profile.validate().map_err(|error| {
			CompileError::Invariant(Str::from(format!("invalid thinking profile: {error}")))
		})?;
	}
	let mut routing = ThinkingRouting::default();
	if !tier_collapsed && let Some(thinking) = source {
		routing.effort_map = thinking.effort_map.clone();
		routing.effort_routing = thinking
			.effort_routing
			.iter()
			.map(|(effort, wire)| (*effort, WireModelId::new(wire.clone())))
			.collect();
		routing.reasoning_mode = thinking.reasoning_mode;
		if provider != "cursor" && !routing.effort_routing.is_empty() {
			let (wire, row, _) = &members[0];
			routing
				.effort_routing
				.entry(ThinkingEffort::Off)
				.or_insert_with(|| {
					WireModelId::new(row.request_model_id.clone().unwrap_or_else(|| wire.clone()))
				});
		}
	}
	for (wire, row, classified) in members {
		if tier_collapsed
			&& let Some(effort) = classified.effort.map(translate_effort)
			&& profile
				.as_ref()
				.is_some_and(|policy| policy.supports(effort))
		{
			let selected =
				WireModelId::new(row.request_model_id.clone().unwrap_or_else(|| wire.clone()));
			routing.effort_routing.entry(effort).or_insert(selected);
		}
	}
	if tier_collapsed
		&& profile.is_some()
		&& let Some((wire, row, _)) = members.iter().find(|(_, _, classified)| {
			!classified.thinking_variant
				&& matches!(classified.effort, None | Some(crate::classify::EffortTier::Off))
		}) {
		routing
			.effort_routing
			.entry(ThinkingEffort::Off)
			.or_insert_with(|| {
				WireModelId::new(row.request_model_id.clone().unwrap_or_else(|| wire.clone()))
			});
	}
	if members.len() == 2
		&& let Some(profile) = &profile
		&& let Some((thinking_wire, thinking_row, _)) = members
			.iter()
			.find(|(_, _, classified)| classified.thinking_variant)
		&& let Some((base_wire, base_row, _)) = members.iter().find(|(_, _, classified)| {
			!classified.thinking_variant
				&& matches!(classified.effort, None | Some(crate::classify::EffortTier::Off))
		}) {
		let thinking_wire = WireModelId::new(
			thinking_row
				.request_model_id
				.clone()
				.unwrap_or_else(|| thinking_wire.clone()),
		);
		for effort in &profile.efforts {
			routing
				.effort_routing
				.insert(*effort, thinking_wire.clone());
		}
		routing.effort_routing.insert(
			ThinkingEffort::Off,
			WireModelId::new(
				base_row
					.request_model_id
					.clone()
					.unwrap_or_else(|| base_wire.clone()),
			),
		);
	}
	if let Some(profile) = &profile {
		routing
			.effort_map
			.retain(|effort, _| profile.supports(*effort));
		routing.effort_routing.retain(|effort, _| {
			(*effort == ThinkingEffort::Off && provider != "cursor") || profile.supports(*effort)
		});
		routing.validate(profile).map_err(|error| {
			CompileError::Invariant(Str::from(format!("invalid thinking routing: {error}")))
		})?;
	} else if !routing.effort_map.is_empty() || !routing.effort_routing.is_empty() {
		return Err(CompileError::Invariant(Str::from(format!(
			"thinking routing exists without a thinking profile: {provider}/{}",
			members.first().map_or("?", |(wire, ..)| wire.as_str())
		))));
	}
	Ok((profile, routing))
}

const fn translate_effort(effort: EffortTier) -> ThinkingEffort {
	match effort {
		EffortTier::Off => ThinkingEffort::Off,
		EffortTier::Minimal => ThinkingEffort::Minimal,
		EffortTier::Low => ThinkingEffort::Low,
		EffortTier::Medium => ThinkingEffort::Medium,
		EffortTier::High => ThinkingEffort::High,
		EffortTier::XHigh => ThinkingEffort::XHigh,
		EffortTier::Max => ThinkingEffort::Max,
	}
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CapabilityCorrection {
	Embedding,
	Operationless,
}

#[derive(Clone, Copy, Debug)]
struct ExactCapabilityOverride {
	id:            &'static str,
	provider:      &'static str,
	model:         &'static str,
	correction:    CapabilityCorrection,
	rationale:     &'static str,
	provenance:    &'static str,
	expires_at_ms: Option<u64>,
}

const fn exact_capability(
	id: &'static str,
	provider: &'static str,
	model: &'static str,
	correction: CapabilityCorrection,
	rationale: &'static str,
) -> ExactCapabilityOverride {
	ExactCapabilityOverride {
		id,
		provider,
		model,
		correction,
		rationale,
		provenance: "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	}
}

const EXACT_CAPABILITY_OVERRIDES: &[ExactCapabilityOverride] = &[
	exact_capability(
		"aimlapi-voyage-2-embedding",
		"aimlapi",
		"voyage-2",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"aimlapi-voyage-code-2-embedding",
		"aimlapi",
		"voyage-code-2",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"aimlapi-voyage-finance-2-embedding",
		"aimlapi",
		"voyage-finance-2",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"aimlapi-voyage-large-2-embedding",
		"aimlapi",
		"voyage-large-2",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"aimlapi-voyage-large-2-instruct-embedding",
		"aimlapi",
		"voyage-large-2-instruct",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"aimlapi-voyage-law-2-embedding",
		"aimlapi",
		"voyage-law-2",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"aimlapi-voyage-multilingual-2-embedding",
		"aimlapi",
		"voyage-multilingual-2",
		CapabilityCorrection::Embedding,
		"The reviewed Voyage deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"fireworks-qwen3-embedding-8b",
		"fireworks",
		"qwen3-embedding-8b",
		CapabilityCorrection::Embedding,
		"The reviewed Fireworks deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-baai-bge-m3-embedding",
		"nvidia",
		"baai/bge-m3",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-embed-qa-4-embedding",
		"nvidia",
		"nvidia/embed-qa-4",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nemoretriever-vlm-embedding",
		"nvidia",
		"nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nv-embedqa-1b-embedding",
		"nvidia",
		"nvidia/llama-3.2-nv-embedqa-1b-v1",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nemotron-embed-1b-v2",
		"nvidia",
		"nvidia/llama-nemotron-embed-1b-v2",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nemotron-embed-vl-1b-v2",
		"nvidia",
		"nvidia/llama-nemotron-embed-vl-1b-v2",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nv-embed-v1",
		"nvidia",
		"nvidia/nv-embed-v1",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nv-embedcode-7b-v1",
		"nvidia",
		"nvidia/nv-embedcode-7b-v1",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nv-embedqa-e5-v5",
		"nvidia",
		"nvidia/nv-embedqa-e5-v5",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-nv-embedqa-mistral-7b-v2",
		"nvidia",
		"nvidia/nv-embedqa-mistral-7b-v2",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"nvidia-snowflake-arctic-embed-l",
		"nvidia",
		"snowflake/arctic-embed-l",
		CapabilityCorrection::Embedding,
		"The reviewed NVIDIA deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"zenmux-gemini-embedding-2",
		"zenmux",
		"google/gemini-embedding-2",
		CapabilityCorrection::Embedding,
		"The reviewed ZenMux deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"zenmux-text-embedding-3-large",
		"zenmux",
		"openai/text-embedding-3-large",
		CapabilityCorrection::Embedding,
		"The reviewed ZenMux deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"zenmux-text-embedding-3-small",
		"zenmux",
		"openai/text-embedding-3-small",
		CapabilityCorrection::Embedding,
		"The reviewed ZenMux deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"zenmux-qwen3-vl-embedding",
		"zenmux",
		"qwen/qwen3-vl-embedding",
		CapabilityCorrection::Embedding,
		"The reviewed ZenMux deployment is an embedding model despite absent dimensional metadata",
	),
	exact_capability(
		"fireworks-qwen3-reranker-8b-operationless",
		"fireworks",
		"qwen3-reranker-8b",
		CapabilityCorrection::Operationless,
		"The reviewed reranker deployment has no supported operation in the canonical catalog \
		 vocabulary",
	),
];

fn exact_capability_override(
	provider: &str,
	model: &str,
) -> Option<&'static ExactCapabilityOverride> {
	EXACT_CAPABILITY_OVERRIDES.iter().find(|override_| {
		override_.provider == provider
			&& override_.model == model
			&& override_.expires_at_ms.is_none()
			&& !override_.rationale.is_empty()
			&& !override_.provenance.is_empty()
	})
}

fn conservative_capabilities(
	row: &SourceModelRecord,
	facets: &[SourceFacet],
	correction: Option<CapabilityCorrection>,
) -> ModelCapabilities {
	let embedding =
		row.embedding_dimensions.is_some() || correction == Some(CapabilityCorrection::Embedding);
	let operationless = correction == Some(CapabilityCorrection::Operationless);
	let mut operations = if operationless {
		OperationBits::empty()
	} else if embedding {
		OperationBits::for_kind(OperationKind::Embed)
	} else if facets.contains(&SourceFacet::Chat) {
		OperationBits::for_kind(OperationKind::Chat)
	} else {
		facet_operations(facets)
	};
	if operations == OperationBits::empty() && !operationless {
		operations.insert_kind(OperationKind::Chat);
	}
	let chat = operations
		.contains_kind(OperationKind::Chat)
		.then(|| ChatCapabilities {
			roles:             Availability::Unknown,
			mid_session_roles: Availability::Unknown,
			structured_output: Availability::Unknown,
			grammar:           Availability::Unknown,
			text_verbosity:    Availability::Unknown,
			reasoning:         if row.reasoning {
				Availability::Unknown
			} else {
				Availability::Unsupported
			},
			input_modalities:  if row.input.is_empty() {
				Availability::Unknown
			} else {
				Availability::Native(modalities(&row.input))
			},
			image_input:       if !row.input.contains(&SourceModality::Image) {
				if row.input.is_empty() {
					Availability::Unknown
				} else {
					Availability::Unsupported
				}
			} else {
				let decoder = row
					.image_input_decoder
					.unwrap_or(ImageDecoderFamily::Native);
				let formats = match decoder {
					ImageDecoderFamily::Native => ImageInputFormatBits::ALL,
					ImageDecoderFamily::Stb => ImageInputFormatBits::STB,
				};
				Availability::Native(ImageInputCapabilities { formats, decoder })
			},
			tools:             match row.supports_tools {
				Some(true) => Availability::Native(ToolCapabilities {
					features:      ToolFeatureBits::empty(),
					maximum_tools: None,
				}),
				Some(false) => Availability::Unsupported,
				None => Availability::Native(ToolCapabilities {
					features:      ToolFeatureBits::empty(),
					maximum_tools: None,
				}),
			},
			hosted_tools:      Availability::Unknown,
			prompt_caching:    Availability::Unknown,
			service_tiers:     Availability::Unknown,
			sampling:          Availability::Unknown,
			safety:            Availability::Unknown,
			determinism:       Availability::Unknown,
			server_state:      Availability::Unknown,
			logprobs:          Availability::Unknown,
		});
	let embeddings = operations
		.contains_kind(OperationKind::Embed)
		.then(|| EmbeddingCapabilities {
			input_modalities: if row.input.is_empty() {
				ModalityBits::TEXT
			} else {
				modalities(&row.input)
			},
			input_kinds:      if row.input.is_empty() || row.input.contains(&SourceModality::Text) {
				EmbeddingInputBits::TEXT
			} else {
				EmbeddingInputBits::empty()
			},
			formats:          EmbeddingFormatBits::FLOAT,
			maximum_batch:    None,
			dimensions:       row
				.embedding_dimensions
				.map_or(Availability::Unknown, |dimensions| {
					Availability::Native(DimensionRange { minimum: dimensions, maximum: dimensions })
				}),
		});
	let image = operations
		.contains_kind(OperationKind::GenerateImage)
		.then_some(ImageCapabilities {
			features:         ImageFeatureBits::GENERATE,
			input_modalities: modalities(&row.input),
			maximum_outputs:  None,
			maximum_pixels:   None,
		});
	let video = operations
		.contains_kind(OperationKind::GenerateVideo)
		.then_some(VideoCapabilities {
			features:             VideoFeatureBits::GENERATE,
			maximum_duration_ms:  None,
			maximum_frame_pixels: None,
		});
	let speech = operations
		.contains_kind(OperationKind::Speak)
		.then_some(SpeechCapabilities {
			features:                 SpeechFeatureBits::empty(),
			maximum_input_characters: None,
			output_formats:           AudioFormatBits::empty(),
		});
	let transcription = operations
		.contains_kind(OperationKind::Transcribe)
		.then_some(TranscriptionCapabilities {
			features:            TranscriptionFeatureBits::empty(),
			input_formats:       AudioFormatBits::empty(),
			maximum_duration_ms: None,
		});
	let realtime =
		operations
			.contains_kind(OperationKind::Realtime)
			.then_some(RealtimeCapabilities {
				features:           RealtimeFeatureBits::empty(),
				maximum_session_ms: None,
				audio_formats:      AudioFormatBits::empty(),
			});
	let search = operations
		.contains_kind(OperationKind::Search)
		.then_some(SearchCapabilities {
			features:        SearchFeatureBits::empty(),
			maximum_results: None,
		});
	let tokenization = (operations.contains_kind(OperationKind::CountTokens)
		|| operations.contains_kind(OperationKind::Tokenize)
		|| operations.contains_kind(OperationKind::Detokenize))
	.then_some(TokenizationCapabilities {
		features:            TokenizationFeatureBits::COUNT
			| TokenizationFeatureBits::TOKENIZE
			| TokenizationFeatureBits::DETOKENIZE,
		maximum_input_bytes: None,
	});
	ModelCapabilities {
		operations,
		chat,
		embeddings,
		image,
		video,
		speech,
		transcription,
		realtime,
		search,
		tokenization,
	}
}

fn reasoning_effort(effort: ThinkingEffort) -> ReasoningEffort {
	match effort {
		ThinkingEffort::Off => ReasoningEffort::Off,
		ThinkingEffort::Minimal => ReasoningEffort::Minimal,
		ThinkingEffort::Low => ReasoningEffort::Low,
		ThinkingEffort::Medium => ReasoningEffort::Medium,
		ThinkingEffort::High => ReasoningEffort::High,
		ThinkingEffort::XHigh => ReasoningEffort::Xhigh,
		ThinkingEffort::Max => ReasoningEffort::Max,
	}
}

fn reasoning_capabilities(
	declared: bool,
	policy: Option<&ThinkingPolicy>,
) -> Availability<ReasoningCapabilities> {
	let Some(policy) = policy else {
		return if declared {
			Availability::Native(ReasoningCapabilities {
				features:              ReasoningFeatureBits::empty(),
				efforts:               Box::new([]),
				minimum_budget_tokens: None,
				maximum_budget_tokens: None,
			})
		} else {
			Availability::Unsupported
		};
	};
	let mut features = ReasoningFeatureBits::empty();
	if !policy.efforts.is_empty() {
		features |= ReasoningFeatureBits::EFFORT;
	}
	if matches!(policy.mode, ThinkingMode::Budget | ThinkingMode::AnthropicBudgetEffort)
		|| !policy.effort_budgets.is_empty()
	{
		features |= ReasoningFeatureBits::BUDGET;
	}
	if policy.supports_display != Some(false) {
		features |= ReasoningFeatureBits::VISIBLE;
	}
	let mut budgets = policy
		.effort_budgets
		.values()
		.filter_map(|value| u32::try_from(*value).ok());
	let first_budget = budgets.next();
	let (minimum_budget_tokens, maximum_budget_tokens) =
		budgets.fold((first_budget, first_budget), |(minimum, maximum), value| {
			(
				Some(minimum.map_or(value, |current| current.min(value))),
				Some(maximum.map_or(value, |current| current.max(value))),
			)
		});
	Availability::Native(ReasoningCapabilities {
		features,
		efforts: policy
			.efforts
			.iter()
			.copied()
			.map(reasoning_effort)
			.collect(),
		minimum_budget_tokens,
		maximum_budget_tokens,
	})
}

fn prompt_cache_capabilities(
	policy: &WirePolicy,
	pricing: &Pricing,
) -> Availability<PromptCacheCapabilities> {
	let explicit = matches!(
		policy.cache.control_format,
		Some(CacheControlFormat::Anthropic | CacheControlFormat::OpenAi | CacheControlFormat::Google)
	);
	let automatic_or_explicit = policy
		.cache
		.prompt_cache_mode
		.is_some_and(|mode| matches!(mode, PromptCacheMode::Automatic | PromptCacheMode::Explicit));
	let priced = pricing.components.iter().any(|price| {
		matches!(price.unit, PriceUnit::MtokCacheRead | PriceUnit::MtokCacheWrite)
			&& price.nanos_usd > 0
	});
	if !explicit
		&& !automatic_or_explicit
		&& !priced
		&& policy.cache.supports_long_retention != Some(true)
	{
		return Availability::Unknown;
	}
	let mut retention = CacheRetentionBits::empty();
	if explicit || automatic_or_explicit {
		retention |= CacheRetentionBits::EPHEMERAL;
	}
	if priced {
		retention |= CacheRetentionBits::STANDARD;
	}
	if policy.cache.supports_long_retention == Some(true) {
		retention |= CacheRetentionBits::LONG;
	}
	Availability::Native(PromptCacheCapabilities {
		retention,
		minimum_prefix_tokens: policy
			.cache
			.minimum_tokens
			.and_then(|value| u32::try_from(value).ok()),
		maximum_breakpoints: policy.cache.maximum_checkpoints,
	})
}

fn modalities(values: &[SourceModality]) -> ModalityBits {
	values.iter().fold(ModalityBits::empty(), |bits, value| {
		bits
			| match value {
				SourceModality::Text => ModalityBits::TEXT,
				SourceModality::Image => ModalityBits::IMAGE,
				SourceModality::Audio => ModalityBits::AUDIO,
				SourceModality::Video => ModalityBits::VIDEO,
				SourceModality::Pdf => ModalityBits::DOCUMENT,
			}
	})
}

#[derive(Clone, Copy)]
struct CompleteZeroPricingPolicy {
	provider:      &'static str,
	model:         &'static str,
	rationale:     &'static str,
	provenance:    &'static str,
	expires_at_ms: Option<u64>,
}

const COMPLETE_ZERO_PRICING_POLICIES: &[CompleteZeroPricingPolicy] = &[
	CompleteZeroPricingPolicy {
		provider:      "openrouter",
		model:         "openrouter/auto",
		rationale:     "The reviewed automatic selector explicitly advertises a complete zero-price \
		                schedule.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
	CompleteZeroPricingPolicy {
		provider:      "openrouter",
		model:         "openrouter/auto-beta",
		rationale:     "The reviewed beta automatic selector explicitly advertises a complete \
		                zero-price schedule.",
		provenance:    "fixtures/llm-oracle/catalog/models.normalized.json",
		expires_at_ms: None,
	},
];

fn compile_pricing(
	provider: &str,
	model: &str,
	cost: &SourceCost,
	authored_long_context: Option<&Value>,
) -> Result<Pricing, CompileError> {
	let mut components =
		price_components(&cost.input, &cost.output, &cost.cache_read, &cost.cache_write)?;
	if COMPLETE_ZERO_PRICING_POLICIES.iter().any(|policy| {
		debug_assert!(review_metadata_is_valid(
			policy.rationale,
			policy.provenance,
			policy.expires_at_ms,
		));
		policy.provider == provider && policy.model == model
	}) {
		for unit in [
			PriceUnit::MtokInput,
			PriceUnit::MtokOutput,
			PriceUnit::MtokCacheRead,
			PriceUnit::MtokCacheWrite,
		] {
			if components.iter().all(|component| component.unit != unit) {
				components.push(Price { unit, nanos_usd: 0 });
			}
		}
	}
	let authored_long_context = authored_long_context
		.map(|value| {
			serde_json::from_value::<SourceLongContextCost>(value.clone()).map_err(|error| {
				CompileError::Invariant(Str::from(format!(
					"invalid authored long-context cost for `{provider}/{model}`: {error}"
				)))
			})
		})
		.transpose()?;
	let long_context = authored_long_context
		.as_ref()
		.or(cost.long_context.as_ref());
	let mut tiers = Vec::new();
	if let Some(tier) = long_context {
		tiers.push(PriceTier {
			prompt_tokens_above: if tier.input_threshold_inclusive {
				tier.input_threshold.saturating_sub(1)
			} else {
				tier.input_threshold
			},
			components:          price_components(
				&tier.input,
				&tier.output,
				&tier.cache_read,
				&tier.cache_write,
			)?
			.into_boxed_slice(),
		});
	}
	Pricing::new(components, tiers).map_err(|error| {
		CompileError::Invariant(Str::from(format!("invalid pricing schedule: {error}")))
	})
}

fn price_components(
	input: &Number,
	output: &Number,
	cache_read: &Number,
	cache_write: &Number,
) -> Result<Vec<Price>, CompileError> {
	[
		(PriceUnit::MtokInput, input),
		(PriceUnit::MtokOutput, output),
		(PriceUnit::MtokCacheRead, cache_read),
		(PriceUnit::MtokCacheWrite, cache_write),
	]
	.into_iter()
	.filter(|(_, number)| number.to_string() != "-1000000")
	.map(|(unit, number)| Ok(Price { unit, nanos_usd: decimal_nanos(number)? }))
	.collect()
}

fn source_price_present(number: &Number) -> bool {
	number.as_u64() != Some(0) && number.to_string() != "-1000000"
}

fn decimal_nanos(number: &Number) -> Result<u64, CompileError> {
	decimal_scaled(number, 9)
}
fn decimal_millionths(number: &Number) -> Result<u64, CompileError> {
	decimal_scaled(number, 6)
}
fn decimal_scaled(number: &Number, scale: usize) -> Result<u64, CompileError> {
	let text = number.to_string();
	if text.starts_with('-') {
		return Err(CompileError::Invariant(Str::from(format!("negative decimal `{text}`"))));
	}
	let (mantissa, exponent) = text
		.split_once(['e', 'E'])
		.map_or((text.as_str(), 0_i32), |(mantissa, exponent)| {
			(mantissa, exponent.parse::<i32>().unwrap_or(i32::MIN))
		});
	if exponent == i32::MIN {
		return Err(CompileError::Invariant(Str::from(format!("invalid decimal `{text}`"))));
	}
	let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
	let digits = format!("{whole}{fraction}");
	let coefficient: u128 = digits
		.parse()
		.map_err(|_| CompileError::Invariant(sf!("decimal is out of range")))?;
	let shift = exponent + i32::try_from(scale).expect("small fixed decimal scale")
		- i32::try_from(fraction.len())
			.map_err(|_| CompileError::Invariant(sf!("decimal is out of range")))?;
	let scaled = if shift >= 0 {
		coefficient
			.checked_mul(
				10_u128
					.checked_pow(shift as u32)
					.ok_or_else(|| CompileError::Invariant(sf!("decimal is out of range")))?,
			)
			.ok_or_else(|| CompileError::Invariant(sf!("decimal is out of range")))?
	} else {
		let divisor = 10_u128
			.checked_pow((-shift) as u32)
			.ok_or_else(|| CompileError::Invariant(sf!("decimal is out of range")))?;
		let quotient = coefficient / divisor;
		let remainder = coefficient % divisor;
		quotient
			.checked_add(u128::from(remainder >= divisor.div_ceil(2)))
			.ok_or_else(|| CompileError::Invariant(sf!("decimal is out of range")))?
	};
	u64::try_from(scaled).map_err(|_| CompileError::Invariant(sf!("decimal is out of range")))
}
fn zero_number() -> Number {
	Number::from(0)
}

impl Default for SourceCost {
	fn default() -> Self {
		Self {
			input:        zero_number(),
			output:       zero_number(),
			cache_read:   zero_number(),
			cache_write:  zero_number(),
			long_context: None,
		}
	}
}

fn compile_auth(
	source: &SourceAuth,
	oauth_ids: &BTreeMap<Str, OAuthSpecId>,
) -> Result<AuthSpec, CompileError> {
	let canonical = serde_json::to_vec(source)?;
	let id = AuthSpecId::new(content_id("auth", &canonical));
	let mut credential_sources = Vec::new();
	let (kind, header_name, query_parameter, prefix, sealed_body, account_scope, oauth, signing) =
		match source {
			SourceAuth::None => {
				(AuthSpecKind::None, None, None, None, None, AccountScope::Provider, None, None)
			},
			SourceAuth::Bearer { env } | SourceAuth::OptionalBearer { env } => {
				if !env.is_empty() {
					credential_sources.push(CredentialSourceSpec::Environment {
						ordered_names: canonical_env_names(env)?,
					});
				}
				credential_sources.push(CredentialSourceSpec::Stored);
				(
					if matches!(source, SourceAuth::OptionalBearer { .. }) {
						AuthSpecKind::OptionalBearer
					} else {
						AuthSpecKind::Bearer
					},
					Some(sf!("authorization")),
					None,
					Some(sf!("Bearer ")),
					None,
					AccountScope::Provider,
					None,
					None,
				)
			},
			SourceAuth::Basic { username_env, password_env } => {
				credential_sources.push(CredentialSourceSpec::BasicEnvironment {
					username_names: canonical_env_names(username_env)?,
					password_names: canonical_env_names(password_env)?,
				});
				(
					AuthSpecKind::Basic,
					Some(sf!("authorization")),
					None,
					Some(sf!("Basic ")),
					None,
					AccountScope::Provider,
					None,
					None,
				)
			},
			SourceAuth::DevinSession { env } => {
				if !env.is_empty() {
					credential_sources.push(CredentialSourceSpec::Environment {
						ordered_names: canonical_env_names(env)?,
					});
				}
				credential_sources.push(CredentialSourceSpec::Session);
				(
					AuthSpecKind::OmpSession,
					None,
					None,
					None,
					Some(SealedBodyPlacement::DevinMetadata),
					AccountScope::Provider,
					None,
					None,
				)
			},
			SourceAuth::Header { name, env } => {
				validate_header_name(name)?;
				if !env.is_empty() {
					credential_sources.push(CredentialSourceSpec::Environment {
						ordered_names: canonical_env_names(env)?,
					});
				}
				credential_sources.push(CredentialSourceSpec::Stored);
				(
					AuthSpecKind::ApiKey,
					Some(name.clone()),
					None,
					None,
					None,
					AccountScope::Provider,
					None,
					None,
				)
			},
			SourceAuth::Query { param, env } => {
				if !env.is_empty() {
					credential_sources.push(CredentialSourceSpec::Environment {
						ordered_names: canonical_env_names(env)?,
					});
				}
				credential_sources.push(CredentialSourceSpec::Stored);
				(
					AuthSpecKind::ApiKey,
					None,
					Some(param.clone()),
					None,
					None,
					AccountScope::Provider,
					None,
					None,
				)
			},
			SourceAuth::AwsSigV4 => {
				credential_sources.push(CredentialSourceSpec::AwsChain);
				(
					AuthSpecKind::AwsSigv4,
					None,
					None,
					None,
					None,
					AccountScope::Region,
					None,
					Some(SigV4Spec { service: sf!("bedrock"), region: RegionSource::RouteEndpoint }),
				)
			},
			SourceAuth::GoogleAdc { api_key_env, project_env, location_env } => {
				let api_key_env = canonical_env_names(api_key_env)?;
				let project_env = canonical_env_names(project_env)?;
				let location_env = canonical_env_names(location_env)?;
				let mut sources = api_key_env
					.iter()
					.cloned()
					.map(|variable| ApplicationDefaultSource::EnvironmentAccessToken { variable })
					.collect::<Vec<_>>();
				sources.push(ApplicationDefaultSource::CredentialFile {
					path_environment: Some(sf!("OMP_GOOGLE_APPLICATION_CREDENTIALS")),
					default_path:     None,
				});
				sources.push(ApplicationDefaultSource::Metadata { url: sf!("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"), headers: Box::new([StaticHeader { name: sf!("metadata-flavor"), value: sf!("Google") }]) });
				credential_sources.push(CredentialSourceSpec::ApplicationDefault {
					api_key_env,
					project_env,
					location_env,
					sources: sources.into_boxed_slice(),
				});
				(
					AuthSpecKind::GcpAdc,
					Some(sf!("authorization")),
					None,
					Some(sf!("Bearer ")),
					None,
					AccountScope::Provider,
					None,
					None,
				)
			},
			SourceAuth::Oauth { flow } => {
				let oauth = oauth_ids.get(flow).cloned().ok_or_else(|| {
					CompileError::Invariant(Str::from(format!("unknown OAuth flow `{flow}`")))
				})?;
				credential_sources.push(CredentialSourceSpec::Oauth { flow: oauth.clone() });
				credential_sources.push(CredentialSourceSpec::Stored);
				(
					AuthSpecKind::Oauth,
					Some(sf!("authorization")),
					None,
					Some(sf!("Bearer ")),
					None,
					AccountScope::Provider,
					Some(oauth),
					None,
				)
			},
		};
	Ok(AuthSpec {
		id,
		kind,
		header_name,
		query_parameter,
		prefix,
		sealed_body,
		scopes: Box::new([]),
		audience: None,
		account_scope,
		credential_sources: credential_sources.into_boxed_slice(),
		oauth,
		signing,
	})
}

fn canonical_env_names(names: &[Str]) -> Result<Box<[Str]>, CompileError> {
	for name in names {
		if !name.starts_with("OMP_") {
			return Err(CompileError::Invariant(Str::from(format!(
				"credential environment variable `{name}` must use the OMP_ prefix"
			))));
		}
	}
	Ok(names.to_vec().into_boxed_slice())
}

fn compile_headers(headers: &BTreeMap<Str, Str>) -> Result<HeaderProfile, CompileError> {
	let entries = headers
		.iter()
		.map(|(name, value)| StaticHeader { name: name.clone(), value: value.clone() });
	HeaderProfile::try_new(entries).map_err(|error| {
		CompileError::Invariant(Str::from(format!("invalid static header profile: {error}")))
	})
}

fn compile_discovery(source: &SourceDiscovery) -> Result<DiscoverySpec, CompileError> {
	let kind = match source.kind.as_str() {
		"open-ai-models" => DiscoveryKind::OpenAiModels,
		"google-models" => DiscoveryKind::GoogleModels,
		"ollama-tags" => DiscoveryKind::OllamaTags,
		"account-models" => DiscoveryKind::AccountModels,
		"specialized" => DiscoveryKind::Specialized,
		other => {
			return Err(CompileError::Invariant(Str::from(format!(
				"unknown discovery kind `{other}`"
			))));
		},
	};
	let canonical = serde_json::to_vec(source)?;
	Ok(DiscoverySpec {
		id: DiscoverySpecId::new(content_id("discovery", &canonical)),
		kind,
		label: source.label.clone(),
		path: source.path.clone().unwrap_or_else(|| sf!("/models")),
		pagination: source
			.cursor_parameter
			.clone()
			.map_or(DiscoveryPagination::SinglePage, |query_parameter| DiscoveryPagination::Cursor {
				query_parameter,
			}),
		authoritative: source.authoritative,
		interval: source.interval_ms.map(time::Duration::from_millis),
	})
}

/// Resolves a source `api` selector (including serde aliases) to its
/// canonical codec and transport, e.g. `openai-completions` →
/// (`openai-chat`, HTTP).
pub fn resolve_source_transport(name: &str) -> Option<(CodecId, TransportKind)> {
	let source: SourceTransport =
		serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()?;
	Some(translate_transport(source))
}

fn translate_transport(source: SourceTransport) -> (CodecId, TransportKind) {
	let (codec, transport) = match source {
		SourceTransport::AnthropicMessages => ("anthropic", TransportKind::Http),
		SourceTransport::AnthropicBedrock => ("anthropic-bedrock", TransportKind::AwsEventStream),
		SourceTransport::BedrockConverse => ("bedrock-converse", TransportKind::AwsEventStream),
		SourceTransport::AnthropicVertex => ("anthropic-vertex", TransportKind::Http),
		SourceTransport::OpenAiChat => ("openai-chat", TransportKind::Http),
		SourceTransport::OpenAiResponses => ("openai-responses", TransportKind::Http),
		SourceTransport::OpenAiCodex => ("openai-codex", TransportKind::Http),
		SourceTransport::GoogleGenAi => ("google-genai", TransportKind::Http),
		SourceTransport::GoogleVertex => ("google-vertex", TransportKind::Http),
		SourceTransport::GoogleCca => ("google-cca", TransportKind::Http),
		SourceTransport::OllamaChat => ("ollama", TransportKind::Http),
		SourceTransport::Cursor => ("cursor", TransportKind::Connect),
		SourceTransport::Devin => ("devin", TransportKind::Connect),
		SourceTransport::GitlabDuoWorkflow => ("gitlab-duo", TransportKind::Websocket),
		SourceTransport::Omp => ("omp", TransportKind::Http),
		SourceTransport::Embedded => ("local", TransportKind::Local),
	};
	(CodecId::new(codec), transport)
}

fn validate_header_name(name: &str) -> Result<(), CompileError> {
	if name.is_empty()
		|| !name.bytes().all(|byte| {
			byte.is_ascii_alphanumeric()
				|| matches!(
					byte,
					b'!'
						| b'#' | b'$'
						| b'%' | b'&'
						| b'\'' | b'*'
						| b'+' | b'-'
						| b'.' | b'^'
						| b'_' | b'`'
						| b'|' | b'~'
				)
		}) {
		return Err(CompileError::Invariant(Str::from(format!("invalid header name `{name}`"))));
	}
	Ok(())
}
fn validate_url(url: &str) -> Result<(), CompileError> {
	if url.starts_with("https://")
		|| url.starts_with("http://127.0.0.1")
		|| url.starts_with("http://localhost")
		|| url.starts_with("local://")
	{
		Ok(())
	} else {
		Err(CompileError::Invariant(Str::from(format!("untrusted route URL `{url}`"))))
	}
}
fn humanize(value: &str) -> Str {
	Str::from(
		value
			.split(['-', '_'])
			.filter(|part| !part.is_empty())
			.map(|part| {
				let mut chars = part.chars();
				chars
					.next()
					.map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
			})
			.collect::<Vec<_>>()
			.join(" "),
	)
}
fn content_id(prefix: &str, bytes: &[u8]) -> String {
	let digest: [u8; 32] = Sha256::digest(bytes).into();
	format!("{prefix}-{}", hex::encode_n(&digest))
}
fn revision_for(
	providers: &[ProviderDef],
	routes: &[RouteDef],
	models: &[ModelSpec],
) -> Result<CatalogRevision, CompileError> {
	let bytes = serde_json::to_vec(&(providers, routes, models))?;
	Ok(CatalogRevision::new(content_id("catalog", &bytes)))
}

#[cfg(test)]
mod tests {

	use super::*;
	use crate::pricing::{NanoUsd, UsageDimensions};
	fn compile_provider_registry() -> CompiledCatalog {
		let providers = include_str!("../../../fixtures/llm-oracle/catalog/providers.toml");
		let models = zstd::stream::encode_all(&br"{}"[..], 1).expect("fixture compression");
		compile(parse_oracle(providers, &models).expect("provider registry parses"))
			.expect("provider registry compiles")
	}
	fn source_model(value: Value) -> SourceModelRecord {
		serde_json::from_value(value).expect("source model")
	}

	fn classifications(
		provider: &str,
		rows: &BTreeMap<Str, SourceModelRecord>,
	) -> BTreeMap<Str, ModelClassification> {
		rows
			.keys()
			.map(|wire| {
				(
					wire.clone(),
					classify(ClassificationInput {
						phase: ClassificationPhase::CatalogCompiler,
						provider,
						model: wire,
						observed_at_ms: None,
					}),
				)
			})
			.collect()
	}

	#[test]
	fn cursor_collapse_groups_extra_high_and_rejects_duplicate_efforts() {
		let rows = ["low", "extra-high"]
			.into_iter()
			.map(|tier| {
				(
					Str::from(format!("review-{tier}")),
					source_model(serde_json::json!({
						"api": "cursor",
						"contextWindow": 200000,
						"maxTokens": 64000
					})),
				)
			})
			.collect::<BTreeMap<_, _>>();
		assert!(collapsible_groups(&classifications("cursor", &rows)).contains("review"));

		let duplicate = ["low", "xhigh", "extra-high"]
			.into_iter()
			.map(|tier| {
				(
					Str::from(format!("duplicate-{tier}")),
					source_model(serde_json::json!({ "api": "cursor" })),
				)
			})
			.collect::<BTreeMap<_, _>>();
		assert!(!collapsible_groups(&classifications("cursor", &duplicate)).contains("duplicate"));
	}

	#[test]
	fn matching_static_logical_row_dedupes_live_cursor_tiers() {
		let rows = BTreeMap::from([
			(
				Str::from("review"),
				source_model(serde_json::json!({
					"api": "cursor",
					"reasoning": true,
					"thinking": {
						"mode": "effort",
						"efforts": ["low", "high"],
						"effortRouting": {
							"low": "review-low",
							"high": "review-high"
						}
					}
				})),
			),
			(Str::from("review-low"), source_model(serde_json::json!({ "api": "cursor" }))),
			(Str::from("review-high"), source_model(serde_json::json!({ "api": "cursor" }))),
		]);
		assert!(collapsible_groups(&classifications("cursor", &rows)).contains("review"));
	}

	#[test]
	fn collapsed_references_retarget_only_to_live_alias_destinations() {
		let live =
			BTreeSet::from([ModelKey::from("cursor/logical"), ModelKey::from("cursor/live-tier")]);
		let aliases = BTreeMap::from([
			(Str::from("cursor/member-high"), ModelKey::from("cursor/logical")),
			(Str::from("cursor/stale"), ModelKey::from("cursor/missing")),
		]);
		let mut collapsed = Some(ModelKey::from("cursor/member-high"));
		retarget_collapsed_model_reference(&mut collapsed, &live, &aliases);
		assert_eq!(collapsed, Some(ModelKey::from("cursor/logical")));
		let mut live_tier = Some(ModelKey::from("cursor/live-tier"));
		retarget_collapsed_model_reference(&mut live_tier, &live, &aliases);
		assert_eq!(live_tier, Some(ModelKey::from("cursor/live-tier")));
		let mut stale = Some(ModelKey::from("cursor/stale"));
		retarget_collapsed_model_reference(&mut stale, &live, &aliases);
		assert_eq!(stale, Some(ModelKey::from("cursor/stale")));
	}

	#[test]
	fn rejects_header_injection_and_credentials() {
		assert!(compile_headers(&BTreeMap::from([(sf!("x-ok"), sf!("a\r\nb"))])).is_err());
		assert!(compile_headers(&BTreeMap::from([(sf!("authorization"), sf!("secret"))])).is_err());
	}

	#[test]
	fn canonical_decimal_conversion_is_exact() {
		assert_eq!(
			decimal_nanos(&Number::from_f64(1.25).expect("finite")).expect("exact decimal"),
			1_250_000_000
		);
		assert_eq!(
			decimal_nanos(&Number::from_f64(0.000_000_000_1).expect("finite"))
				.expect("deterministically rounded"),
			0
		);
	}

	#[test]
	fn bundled_codex_long_context_cost_compiles_and_prices_exactly() {
		let resolved = CompatCascade::bundled()
			.expect("bundled cascade parses")
			.resolve(&ResolveTarget {
				provider:  "openai-codex",
				class:     "openai",
				family:    None,
				revision:  Some(omp_core::SemVer::new(5, 6, 0)),
				model:     "gpt-5.6-sol",
				reasoning: true,
			})
			.expect("Codex pricing row resolves");
		let cost: SourceCost = serde_json::from_value(serde_json::json!({
			"input": 5,
			"output": 30,
			"cacheRead": 0.5,
			"cacheWrite": 6.25
		}))
		.expect("base pricing parses");
		let pricing =
			compile_pricing("openai-codex", "gpt-5.6-sol", &cost, resolved.catalog.get("longContext"))
				.expect("tier compiles");
		let boundary = pricing
			.cost(UsageDimensions {
				input_tokens: 72_000,
				output_tokens: 10_000,
				cache_read_tokens: 200_000,
				..UsageDimensions::default()
			})
			.expect("boundary price");
		assert_eq!(boundary, NanoUsd::from_nanos(760_000_000));
		let above = pricing
			.cost(UsageDimensions {
				input_tokens: 72_001,
				output_tokens: 10_000,
				cache_read_tokens: 200_000,
				..UsageDimensions::default()
			})
			.expect("premium price");
		assert_eq!(above, NanoUsd::from_nanos(1_370_010_000));
	}

	#[test]
	fn effort_collapse_requires_siblings() {
		let single = BTreeMap::from([(
			sf!("model-low"),
			classify(ClassificationInput {
				phase:          ClassificationPhase::CatalogCompiler,
				provider:       "p",
				model:          "model-low",
				observed_at_ms: None,
			}),
		)]);
		assert!(collapsible_groups(&single).is_empty());
		let siblings = BTreeMap::from([
			(
				sf!("model-low"),
				classify(ClassificationInput {
					phase:          ClassificationPhase::CatalogCompiler,
					provider:       "p",
					model:          "model-low",
					observed_at_ms: None,
				}),
			),
			(
				sf!("model-high"),
				classify(ClassificationInput {
					phase:          ClassificationPhase::CatalogCompiler,
					provider:       "p",
					model:          "model-high",
					observed_at_ms: None,
				}),
			),
		]);
		assert!(collapsible_groups(&siblings).contains("model"));
	}

	#[test]
	fn coreweave_discovery_is_authoritative() {
		// CoreWeave Serverless Inference (W&B Inference) is a reseller with a
		// rotating model menu: runtime /v1/models discovery must replace stale
		// bundled rows instead of merging over them.
		let providers = include_str!("../../../fixtures/llm-oracle/catalog/providers.toml");
		let models = zstd::stream::encode_all(&br"{}"[..], 1).expect("fixture compression");
		let source = parse_oracle(providers, &models).expect("fixture providers parse");
		let coreweave = source
			.providers
			.get("coreweave")
			.expect("coreweave provider record");
		let discovery = coreweave
			.discovery
			.as_ref()
			.expect("coreweave discovery source");
		assert!(discovery.authoritative, "coreweave dynamic discovery must be authoritative");
	}

	#[test]
	fn anthropic_discovery_uses_subscription_bootstrap_endpoint() {
		let providers = include_str!("../../../fixtures/llm-oracle/catalog/providers.toml");
		let models = zstd::stream::encode_all(&br"{}"[..], 1).expect("fixture compression");
		let source = parse_oracle(providers, &models).expect("fixture providers parse");
		let discovery = source
			.providers
			.get("anthropic")
			.and_then(|provider| provider.discovery.as_ref())
			.expect("anthropic discovery source");
		assert_eq!(discovery.kind.as_str(), "account-models");
		assert_eq!(
			discovery.path.as_deref(),
			Some("/api/claude_cli/bootstrap?model=claude-sonnet-5"),
		);
		assert_eq!(discovery.cursor_parameter, None);

		let compiled = compile(source).expect("catalog compilation");
		let route = compiled
			.routes
			.iter()
			.find(|route| route.provider.as_str() == "anthropic")
			.expect("anthropic route");
		let discovery_id = route.discovery.as_ref().expect("compiled discovery id");
		let discovery = compiled
			.discovery_specs
			.iter()
			.find(|discovery| discovery.id == *discovery_id)
			.expect("compiled discovery");
		assert_eq!(discovery.kind, DiscoveryKind::AccountModels);
		assert_eq!(discovery.path.as_str(), "/api/claude_cli/bootstrap?model=claude-sonnet-5",);
		assert_eq!(discovery.pagination, DiscoveryPagination::SinglePage);
	}

	#[test]
	fn additional_transports_are_inert_until_selected() {
		let providers = r#"
[providers.synthetic]
transport = "open-ai-chat"
additional_transports = ["open-ai-responses"]
base_url = "https://example.test/v1"
facets = ["chat"]
discovery = { kind = "open-ai-models", label = "Synthetic", authoritative = false }
"#;
		let models = br#"{"synthetic":{"model":{"input":["text"],"output":["text"]}}}"#;
		let compressed = zstd::stream::encode_all(&models[..], 1).expect("fixture compression");
		let compiled = compile(parse_oracle(providers, &compressed).expect("typed source"))
			.expect("catalog compilation");
		let provider = compiled
			.providers
			.iter()
			.find(|provider| provider.id.as_str() == "synthetic")
			.expect("compiled provider");
		assert!(
			provider
				.routes
				.iter()
				.any(|route| route.as_str() == "synthetic/openai-responses")
		);
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == "synthetic/model")
			.expect("compiled model");
		assert_eq!(model.routes.as_ref(), &[RouteId::from("synthetic/primary")]);
	}

	#[test]
	fn redundant_model_transport_metadata_reuses_the_provider_route() {
		let providers = r#"
[providers.synthetic]
transport = "open-ai-responses"
base_url = "https://example.test/v1"
facets = ["chat"]
"#;
		let models = br#"{"synthetic":{"model":{"api":"openai-responses","baseUrl":"https://example.test/v1","input":["text"]}}}"#;
		let compressed = zstd::stream::encode_all(&models[..], 1).expect("fixture compression");
		let compiled = compile(parse_oracle(providers, &compressed).expect("typed source"))
			.expect("catalog compilation");
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == "synthetic/model")
			.expect("compiled model");
		assert_eq!(model.routes.as_ref(), &[RouteId::from("synthetic/primary")]);
	}

	#[test]
	fn responses_models_admit_hosted_image_generation_by_exact_contract() {
		let providers = r#"
[providers.openai]
transport = "open-ai-responses"
base_url = "https://api.openai.test/v1"
facets = ["chat"]
"#;
		let models = br#"{"openai":{"gpt-image-chat":{"api":"openai-responses","input":["text"]},"legacy-image":{"api":"openai-responses","input":["text"]},"gpt-chat-completions":{"api":"openai-completions","input":["text"]}}}"#;
		let compressed = zstd::stream::encode_all(&models[..], 1).expect("fixture compression");
		let compiled = compile(parse_oracle(providers, &compressed).expect("typed source"))
			.expect("catalog compilation");
		for (model, expected) in [
			("openai/gpt-image-chat", true),
			("openai/legacy-image", false),
			("openai/gpt-chat-completions", false),
		] {
			let model = compiled
				.models
				.iter()
				.find(|candidate| candidate.key.as_str() == model)
				.expect("compiled model");
			assert_eq!(
				model
					.capabilities
					.operations
					.contains_kind(OperationKind::GenerateImage),
				expected,
				"{}",
				model.key
			);
			assert_eq!(model.capabilities.image.is_some(), expected, "{}", model.key);
		}
		let image_model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == "openai/gpt-image-chat")
			.expect("image model");
		for route_id in &image_model.routes {
			let route = compiled
				.routes
				.iter()
				.find(|route| route.id == *route_id)
				.expect("image route");
			assert!(
				route
					.capability_limits
					.operations
					.is_some_and(|operations| {
						operations.contains_kind(OperationKind::GenerateImage)
					})
			);
		}
	}

	#[test]
	fn provider_metadata_preserves_optional_oauth_bearer_and_azure_version() {
		let compiled = compile_provider_registry();
		let ollama = compiled
			.providers
			.iter()
			.find(|provider| provider.id.as_str() == "ollama")
			.expect("Ollama provider");
		let ollama_auth = compiled
			.auth_specs
			.iter()
			.find(|auth| auth.id == ollama.auth[0])
			.expect("Ollama auth");
		assert_eq!(ollama_auth.kind, AuthSpecKind::OptionalBearer);

		let anthropic = compiled
			.providers
			.iter()
			.find(|provider| provider.id.as_str() == "anthropic")
			.expect("Anthropic provider");
		let anthropic_auth = anthropic
			.auth
			.iter()
			.filter_map(|id| compiled.auth_specs.iter().find(|auth| &auth.id == id))
			.collect::<Vec<_>>();
		let api_key_names = anthropic_auth
			.iter()
			.find(|auth| auth.kind == AuthSpecKind::ApiKey)
			.and_then(|auth| auth.credential_sources.first())
			.and_then(|source| match source {
				CredentialSourceSpec::Environment { ordered_names } => Some(ordered_names),
				_ => None,
			})
			.expect("Anthropic API-key environment");
		assert!(
			!api_key_names
				.iter()
				.any(|name| name.as_str() == "OMP_ANTHROPIC_OAUTH_TOKEN")
		);
		let bearer_names = anthropic_auth
			.iter()
			.find(|auth| auth.kind == AuthSpecKind::Bearer)
			.and_then(|auth| auth.credential_sources.first())
			.and_then(|source| match source {
				CredentialSourceSpec::Environment { ordered_names } => Some(ordered_names),
				_ => None,
			})
			.expect("Anthropic OAuth bearer environment");
		assert_eq!(bearer_names.as_ref(), &[sf!("OMP_ANTHROPIC_OAUTH_TOKEN")]);

		let azure = compiled
			.routes
			.iter()
			.find(|route| route.id.as_str() == "azure/primary")
			.expect("Azure primary route");
		assert_eq!(azure.endpoint.api_version.as_deref(), Some("2024-10-21"));
		for route in compiled
			.routes
			.iter()
			.filter(|route| route.provider.as_str() == "azure")
		{
			assert_eq!(route.endpoint.base_url.as_str(), "https://openai.azure.com/openai");
			assert_eq!(route.trust_domain.origin.as_str(), "https://openai.azure.com");
			assert!(
				!route.endpoint.base_url.as_str().contains('{')
					&& !route.endpoint.base_url.as_str().contains('}')
			);
		}
		let gitlab = compiled
			.routes
			.iter()
			.find(|route| route.id.as_str() == "gitlab-duo-agent/primary")
			.expect("GitLab Duo agent route");
		assert_eq!(gitlab.endpoint.base_url.as_str(), "https://gitlab.com");
		assert_eq!(gitlab.codec.as_str(), "gitlab-duo");
		assert!(gitlab.discovery.is_some());
		let operations = gitlab
			.capability_limits
			.operations
			.expect("GitLab route operations");
		assert!(operations.contains_kind(OperationKind::Chat));
		assert!(operations.contains_kind(OperationKind::DiscoverModels));
	}

	#[test]
	fn device_polling_defers_attempt_limit_to_provider_expiry() {
		let (specs, _) =
			compile_oauth_specs(include_str!("../../../fixtures/llm-oracle/catalog/oauth.toml"))
				.expect("OAuth specs compile");
		for polling in specs.iter().filter_map(|spec| match &spec.flow {
			OAuthFlowSpec::DeviceCode { polling, .. } => Some(polling),
			OAuthFlowSpec::Custom { polling: Some(polling), .. } => Some(polling),
			_ => None,
		}) {
			assert_eq!(polling.maximum_polls, None);
		}
	}

	#[test]
	fn affirmative_and_default_chat_capabilities_lower_to_native_constraints() {
		let row = source_model(serde_json::json!({
			"reasoning": true,
			"input": ["text"],
			"thinking": {
				"mode": "effort",
				"efforts": ["low", "high"]
			}
		}));
		let capabilities = conservative_capabilities(&row, &[SourceFacet::Chat], None);
		let chat = capabilities.chat.expect("chat capabilities");
		assert!(chat.tools.constraints().is_some(), "absent supportsTools defaults to native");

		let thinking =
			ThinkingPolicy::new(ThinkingMode::Effort, [ThinkingEffort::Low, ThinkingEffort::High])
				.expect("thinking policy");
		let reasoning = reasoning_capabilities(true, Some(&thinking));
		let reasoning = reasoning.constraints().expect("native reasoning");
		assert!(reasoning.features.contains(ReasoningFeatureBits::EFFORT));
		assert_eq!(reasoning.efforts.as_ref(), &[ReasoningEffort::Low, ReasoningEffort::High]);

		let mut wire = WirePolicy::overrides();
		wire.cache.control_format = Some(CacheControlFormat::Anthropic);
		wire.cache.supports_long_retention = Some(true);
		wire.cache.minimum_tokens = Some(1_024);
		wire.cache.maximum_checkpoints = Some(4);
		let pricing =
			Pricing::new(vec![Price { unit: PriceUnit::MtokCacheRead, nanos_usd: 100 }], Vec::new())
				.expect("cache pricing");
		let cache_capabilities = prompt_cache_capabilities(&wire, &pricing);
		let cache = cache_capabilities
			.constraints()
			.expect("native prompt caching");
		assert!(cache.retention.contains(CacheRetentionBits::EPHEMERAL));
		assert!(cache.retention.contains(CacheRetentionBits::STANDARD));
		assert!(cache.retention.contains(CacheRetentionBits::LONG));
		assert_eq!(cache.minimum_prefix_tokens, Some(1_024));
		assert_eq!(cache.maximum_breakpoints, Some(4));
	}

	#[test]
	fn authored_operation_facets_compile_end_to_end() {
		let providers = r#"
[providers.synthetic]
transport = "open-ai-chat"
base_url = "https://example.test/v1"
facets = ["audio_speech", "audio_transcription", "realtime", "web_search", "web_extract"]
discovery = { kind = "open-ai-models", label = "Synthetic", authoritative = true }
pending_facets = ["image_generation"]
"#;
		let models = br#"{"synthetic":{"model":{"input":["text"],"output":["text"]}}}"#;
		let compressed = zstd::stream::encode_all(&models[..], 1).expect("fixture compression");
		let compiled = compile(parse_oracle(providers, &compressed).expect("typed source"))
			.expect("catalog compilation");
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == "synthetic/model")
			.expect("compiled model");
		for operation in [
			OperationKind::Speak,
			OperationKind::Transcribe,
			OperationKind::Realtime,
			OperationKind::Search,
			OperationKind::Extract,
		] {
			assert!(model.capabilities.operations.contains_kind(operation), "{operation}");
		}
		assert!(
			!model
				.capabilities
				.operations
				.contains_kind(OperationKind::GenerateImage)
		);
		assert!(model.capabilities.speech.is_some());
		assert!(model.capabilities.transcription.is_some());
		assert!(model.capabilities.realtime.is_some());
		assert!(model.capabilities.search.is_some());
		let route = compiled
			.routes
			.iter()
			.find(|route| route.provider.as_str() == "synthetic")
			.expect("compiled route");
		let route_operations = route
			.capability_limits
			.operations
			.expect("authored route operations");
		assert!(route_operations.contains(model.capabilities.operations));
		assert!(route_operations.contains_kind(OperationKind::DiscoverModels));
	}
	#[test]
	fn authored_usage_backend_grants_provider_and_route_operations() {
		let providers = r#"
[providers.synthetic]
transport = "open-ai-chat"
base_url = "https://example.test/v1"
facets = ["chat"]
usage = true
"#;
		let models = br#"{"synthetic":{"model":{"input":["text"],"output":["text"]}}}"#;
		let compressed = zstd::stream::encode_all(&models[..], 1).expect("fixture compression");
		let compiled = compile(parse_oracle(providers, &compressed).expect("typed source"))
			.expect("catalog compilation");
		let provider = compiled
			.providers
			.iter()
			.find(|provider| provider.id.as_str() == "synthetic")
			.expect("compiled provider");
		assert!(
			provider
				.management
				.operations
				.contains_kind(OperationKind::Usage)
		);
		let route = compiled
			.routes
			.iter()
			.find(|route| route.provider.as_str() == "synthetic")
			.expect("compiled route");
		assert!(
			route
				.capability_limits
				.operations
				.expect("authored route operations")
				.contains_kind(OperationKind::Usage)
		);
	}

	#[test]
	fn new_reasoning_axes_parse_and_compile_from_kdl() {
		let cascade = CompatCascade::parse(&[(
			"reasoning-axes.kdl",
			r#"class "qwen" {
				template-reasoning-effort #true
				thinking-format "chat-template"
				thinking-tool-choice-conflict "drop_thinking_when_any"
			}"#,
		)])
		.expect("KDL grammar accepts the reasoning axes");
		let resolved = cascade
			.resolve(&ResolveTarget {
				provider:  "local",
				class:     "qwen",
				family:    None,
				revision:  None,
				model:     "qwen3.8-27b",
				reasoning: true,
			})
			.expect("axes resolve");
		let source =
			axis_map_to_source_wire_policy(resolved.wire).expect("resolved axes deserialize");
		let policy = compile_wire_policy(WirePolicy::baseline(), &source).expect("axes compile");
		assert_eq!(policy.reasoning.template_reasoning_effort, Some(true));
		assert_eq!(
			policy.reasoning.thinking_format,
			Some(crate::policy::ThinkingFormat::ChatTemplate)
		);
		assert_eq!(
			policy.tool.thinking_conflict,
			Some(crate::policy::ThinkingToolChoiceConflict::DropThinkingWhenAny)
		);
	}

	#[test]
	fn exact_capability_overrides_are_auditable_and_unique() {
		let mut ids = BTreeSet::new();
		let mut identities = BTreeSet::new();
		for override_ in EXACT_CAPABILITY_OVERRIDES {
			assert!(ids.insert(override_.id), "duplicate override ID {}", override_.id);
			assert!(
				identities.insert((override_.provider, override_.model)),
				"duplicate exact capability override {}/{}",
				override_.provider,
				override_.model
			);
			assert_ne!(override_.rationale, "");
			assert_ne!(override_.provenance, "");
		}
		assert_eq!(
			exact_capability_override("aimlapi", "voyage-2").map(|override_| override_.correction),
			Some(CapabilityCorrection::Embedding)
		);
		assert_eq!(
			exact_capability_override("fireworks", "qwen3-reranker-8b")
				.map(|override_| override_.correction),
			Some(CapabilityCorrection::Operationless)
		);
		assert!(exact_capability_override("aimlapi", "voyage-2-preview").is_none());
	}
}
