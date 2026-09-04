//! Typed wire-lowering, recovery, and safe static-header policies.

use std::{
	collections::{BTreeMap, btree_map},
	time::Duration,
};

use omp_core::{Str, hex, sf};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{
	id::{HeaderProfileId, WirePolicyId},
	pricing::Pricing,
	provider::{HeaderProfile, StaticHeader},
	thinking::ThinkingEffort,
};

macro_rules! policy_enum {
	($(#[$meta:meta])* $name:ident {
		$(#[$first_meta:meta])* $first:ident
		$(, $(#[$variant_meta:meta])* $variant:ident)* $(,)?
	}) => {
		$(#[$meta])*
		#[derive(Clone, Copy, Debug, Display, EnumString, Eq, Hash, IntoStaticStr, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
		#[serde(rename_all = "snake_case")]
		#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
		#[derive(Default)]
		pub enum $name {
			$(#[$first_meta])*
			#[default]
			$first,
			$(
				$(#[$variant_meta])*
				$variant,
			)*
		}
	};
}

macro_rules! kebab_policy_enum {
	($(#[$meta:meta])* $name:ident {
		$(#[$first_meta:meta])* $first:ident
		$(, $(#[$variant_meta:meta])* $variant:ident)* $(,)?
	}) => {
		$(#[$meta])*
		#[derive(Clone, Copy, Debug, Display, EnumString, Eq, Hash, IntoStaticStr, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
		#[serde(rename_all = "kebab-case")]
		#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
		#[derive(Default)]
		pub enum $name {
			$(#[$first_meta])*
			#[default]
			$first,
			$(
				$(#[$variant_meta])*
				$variant,
			)*
		}
	};
}

kebab_policy_enum!(/// Kimi Code endpoint request format.
	KimiApiFormat {
		/// OpenAI-compatible requests.
		#[serde(rename = "openai")]
		#[strum(to_string = "openai", serialize = "openai")]
		OpenAi,
		/// Anthropic-compatible requests.
		Anthropic,
	}
);
kebab_policy_enum!(/// Header carrying a stable prompt-cache session identifier.
	PromptCacheSessionHeader {
		/// xAI/Grok conversation identifier header.
		#[serde(rename = "x-grok-conv-id")]
		#[strum(to_string = "x-grok-conv-id", serialize = "x-grok-conv-id")]
		XGrokConversationId,
	}
);
kebab_policy_enum!(/// Explicit prompt-cache breakpoint retention.
	PromptCacheBreakpointTtl {
		/// Thirty-minute cache retention.
		#[serde(rename = "30m")]
		#[strum(to_string = "30m", serialize = "30m")]
		ThirtyMinutes,
	}
);
kebab_policy_enum!(/// Catalog-selected streamed markup healer.
	StreamMarkupHealingPattern {
		/// Kimi markup.
		Kimi,
		/// DeepSeek markup language.
		Dsml,
		/// Qwen markup.
		Qwen,
		/// Generic thinking markup.
		Thinking,
		/// Harmony channel markup.
		Harmony,
	}
);
kebab_policy_enum!(/// Catalog-selected reasoning loop guard.
	ThinkingLoopGuardProfile {
		/// Gemini repetition behavior.
		Gemini,
		/// DeepSeek repetition behavior.
		#[serde(rename = "deepseek")]
		#[strum(to_string = "deepseek", serialize = "deepseek")]
		DeepSeek,
		/// xAI repetition behavior.
		#[serde(rename = "xai")]
		#[strum(to_string = "xai", serialize = "xai")]
		Xai,
	}
);
kebab_policy_enum!(/// Provider model-identifier transformation.
	WireModelIdMode {
		/// Preserve the resolved wire identifier.
		Raw,
		/// Cline Pass identifier convention.
		ClinePass,
		/// Firepass identifier convention.
		Firepass,
		/// Fireworks identifier convention.
		Fireworks,
		/// OpenRouter identifier convention.
		#[serde(rename = "openrouter")]
		#[strum(to_string = "openrouter", serialize = "openrouter")]
		OpenRouter,
	}
);

policy_enum!(/// API-version suffix for compatible audio endpoints.
	AudioApiVersion {
		/// No version suffix is required.
		None,
		/// Azure's April 2025 preview audio contract.
		#[serde(rename = "2025-04-01-preview")]
		#[strum(to_string = "2025-04-01-preview", serialize = "2025-04-01-preview")]
		V2025_04_01Preview,
	}
);
policy_enum!(/// Bedrock prompt-cache checkpoint mode.
	PromptCacheMode {
		/// Do not send checkpoints.
		None,
		/// Provider-managed automatic caching.
		Automatic,
		/// Emit explicit cachePoint blocks.
		Explicit,
	}
);
policy_enum!(/// Prompt-cache marker representation.
	CacheControlFormat {
		/// No explicit cache markers.
		None,
		/// Anthropic cache-control content parts.
		Anthropic,
		/// `OpenAI` prompt-cache controls.
		OpenAi,
		/// Google cached-content resource names.
		Google,
	}
);
policy_enum!(/// Encoding of image inputs.
	ImageEncodingFormat {
		/// `OpenAI` image URL or data URL parts.
		OpenAiUrl,
		/// Anthropic source blocks.
		AnthropicSource,
		/// Google inline-data parts.
		GoogleInlineData,
		/// Images cannot be represented.
		None,
	}
);
policy_enum!(/// Name of the generated-token limit field.
	MaxTokensField {
		/// The legacy `max_tokens` field.
		MaxTokens,
		/// The Chat Completions `max_completion_tokens` field.
		MaxCompletionTokens,
		/// The Responses `max_output_tokens` field.
		MaxOutputTokens,
	}
);
policy_enum!(/// Provider wire mode used for ordinary or extended context.
	ExtendedContextMode {
		/// Use the ordinary context path.
		Standard,
		/// Enable the provider's extended-context path.
		Extended,
	}
);
impl ExtendedContextMode {
	/// Converts explicit source evidence without collapsing `false` into
	/// absence.
	pub const fn from_enabled(enabled: bool) -> Self {
		if enabled {
			Self::Extended
		} else {
			Self::Standard
		}
	}

	/// Reports whether extended context must be enabled on the wire.
	pub const fn is_extended(self) -> bool {
		matches!(self, Self::Extended)
	}
}

policy_enum!(/// Whether premium-priced extended context is available to selection.
	ExtendedContextPolicy {
		/// Preserve the model's full declared context window.
		Enabled,
		/// Cap effective context at the end of standard pricing.
		StandardPricingOnly,
	}
);
impl ExtendedContextPolicy {
	/// Converts the user-facing extended-context setting into typed policy.
	pub const fn from_enabled(enabled: bool) -> Self {
		if enabled {
			Self::Enabled
		} else {
			Self::StandardPricingOnly
		}
	}

	/// Applies this policy to a declared model context window.
	///
	/// Disabling extended context only affects models with a replacement price
	/// tier. Unknown limits remain unknown rather than being invented.
	pub fn effective_context_window(
		self,
		declared_context_window: Option<u64>,
		pricing: &Pricing,
	) -> Option<u64> {
		match (self, declared_context_window, pricing.standard_pricing_boundary()) {
			(Self::StandardPricingOnly, Some(window), Some(boundary)) => Some(window.min(boundary)),
			(_, window, _) => window,
		}
	}
}

policy_enum!(/// Provider-native reasoning request and history representation.
	ReasoningWireFormat {
		/// No native reasoning fields.
		None,
		/// `OpenAI` Chat Completions fields.
		OpenAi,
		/// `OpenAI` Responses reasoning objects.
		OpenAiResponses,
		/// Anthropic thinking blocks.
		Anthropic,
		/// Google thinking configuration and thought parts.
		Google,
		/// `OpenRouter`'s nested reasoning object.
		OpenRouter,
		/// Z.AI's thinking object.
		Zai,
		/// Qwen's `enable_thinking` switch.
		QwenEnableThinking,
		/// NVIDIA chat-template keyword arguments.
		NvidiaChatTemplateKwargs,
	}
);
policy_enum!(/// Provider stream framing and terminal-event convention.
	StreamProtocol {
		/// SSE data records with a terminal sentinel.
		SseData,
		/// Named SSE events.
		SseEvents,
		/// Newline-delimited JSON.
		Ndjson,
		/// Connect framing.
		Connect,
	}
);
policy_enum!(/// Policy for reasoning controls that conflict with tool choice.
	ThinkingToolChoiceConflict {
		/// Both controls may be sent.
		None,
		/// Remove reasoning only for a forced tool.
		DropThinkingWhenForced,
		/// Remove reasoning for any explicit tool choice.
		DropThinkingWhenAny,
		/// Remove reasoning when an effort is present.
		DropThinkingWhenEffort,
	}
);
policy_enum!(/// Provider constraints on tool-call identifiers.
	ToolCallIdProfile {
		/// Preserve the canonical identifier.
		Unconstrained,
		/// Limit the identifier to forty OpenAI-compatible characters.
		#[serde(rename = "open_ai_40")]
		#[strum(to_string = "open_ai_40", serialize = "open_ai_40")]
		OpenAi40,
		/// Emit exactly nine ASCII alphanumeric characters.
		#[serde(rename = "mistral_9_alnum")]
		#[strum(to_string = "mistral_9_alnum", serialize = "mistral_9_alnum")]
		Mistral9Alnum,
	}
);
policy_enum!(/// Provider-specific tool parameter schema normalization.
	ToolSchemaFlavor {
		/// Ordinary JSON Schema.
		JsonSchema,
		/// Anthropic's supported JSON Schema subset.
		Anthropic,
		/// Google's function declaration schema subset.
		Google,
		/// Moonshot/Kimi MFJS normalization.
		#[serde(rename = "moonshot-mfjs")]
		#[strum(to_string = "moonshot-mfjs", serialize = "moonshot-mfjs")]
		MoonshotMfjs,
		/// Grammar-safe local-server schema.
		Grammar,
		/// Cloud Code Assist schema stripping.
		Cca,
		/// Do not send a tool parameter schema.
		None,
	}
);
policy_enum!(/// How tool-definition strictness is emitted.
	ToolStrictMode {
		/// Force strict mode on every tool.
		AllStrict,
		/// Honor each tool's requested strictness.
		Mixed,
		/// Never emit strictness.
		None,
	}
);
policy_enum!(/// Policy for healing leaked reasoning markup in ordinary text.
	LeakedThinkingHealer {
		/// Do not heal leaked reasoning.
		None,
		/// Heal generic thinking markup.
		Thinking,
		/// Heal Kimi reasoning markup.
		Kimi,
		/// Heal `DeepSeek` markup language reasoning.
		Dsml,
		/// Heal Qwen self-closing XML tool-call markup.
		Qwen,
	}
);
policy_enum!(/// Additional provider-specific thinking text representation.
	ThinkingFormat {
		/// OpenAI-compatible reasoning text.
		#[serde(rename = "openai")]
		#[strum(to_string = "openai", serialize = "openai")]
		OpenAi,
		/// Kimi reasoning text.
		Kimi,
		/// Z.AI reasoning text.
		Zai,
		/// Qwen chat-template reasoning text.
		#[serde(rename = "qwen-chat-template")]
		#[strum(to_string = "qwen-chat-template", serialize = "qwen-chat-template")]
		QwenChatTemplate,
		/// Generic chat-template reasoning control.
		#[serde(rename = "chat-template")]
		#[strum(to_string = "chat-template", serialize = "chat-template")]
		ChatTemplate,
		/// Qwen's native reasoning text.
		Qwen,
		/// `OpenRouter` reasoning text.
		#[serde(rename = "openrouter")]
		#[strum(to_string = "openrouter", serialize = "openrouter")]
		OpenRouter,
	}
);

policy_enum!(/// Wire operation used to explicitly disable reasoning.
	ReasoningDisableMode {
		/// Omit reasoning controls.
		Omit,
		/// Send the lowest supported effort.
		#[serde(rename = "lowest-effort")]
		#[strum(to_string = "lowest-effort", serialize = "lowest-effort")]
		LowestEffort,
		/// Send the `none` effort.
		#[serde(rename = "none-effort")]
		#[strum(to_string = "none-effort", serialize = "none-effort")]
		NoneEffort,
		/// Send OpenRouter's enabled=false shape.
		#[serde(rename = "openrouter-enabled-false")]
		#[strum(to_string = "openrouter-enabled-false", serialize = "openrouter-enabled-false")]
		OpenRouterEnabledFalse,
		/// Send Cline's enabled=false shape.
		#[serde(rename = "cline-enabled-false")]
		#[strum(to_string = "cline-enabled-false", serialize = "cline-enabled-false")]
		ClineEnabledFalse,
		/// Send `venice_parameters.disable_thinking = true`.
		#[serde(rename = "venice-disable-thinking")]
		#[strum(to_string = "venice-disable-thinking", serialize = "venice-disable-thinking")]
		VeniceDisableThinking,
		/// Send Z.AI's disabled-thinking shape.
		#[serde(rename = "zai-thinking-disabled")]
		#[strum(to_string = "zai-thinking-disabled", serialize = "zai-thinking-disabled")]
		ZaiThinkingDisabled,
		/// Send Qwen's enabled=false shape.
		#[serde(rename = "qwen-enable-thinking-false")]
		#[strum(to_string = "qwen-enable-thinking-false", serialize = "qwen-enable-thinking-false")]
		QwenEnableThinkingFalse,
		/// Send Qwen template false.
		#[serde(rename = "qwen-template-false")]
		#[strum(to_string = "qwen-template-false", serialize = "qwen-template-false")]
		QwenTemplateFalse,
		/// Send generic chat-template false.
		#[serde(rename = "chat-template-thinking-false")]
		#[strum(to_string = "chat-template-thinking-false", serialize = "chat-template-thinking-false")]
		ChatTemplateThinkingFalse,
	}
);
policy_enum!(/// Whether the output-token limit field is emitted.
	MaxOutputTokensEmission {
		/// Emit the selected output-token limit field.
		Emit,
		/// Omit the output-token limit field.
		Omit,
	}
);
policy_enum!(/// Wire representation used for the apply-patch tool.
	ApplyPatchWireKind {
		/// Emit an unwrapped custom-tool patch string.
		Freeform,
		/// Emit patch text inside JSON function arguments.
		Function,
	}
);
policy_enum!(/// Native computer-use wire capability evidence.
	ComputerUseWireSupport {
		/// Computer-use requests are explicitly unsupported.
		Unsupported,
		/// Computer-use requests are accepted natively.
		Native,
	}
);
policy_enum!(/// Computer-use configuration object support evidence.
	ComputerUseConfigSupport {
		/// The configuration object is explicitly unsupported.
		Unsupported,
		/// The configuration object is accepted.
		Supported,
	}
);

policy_enum!(/// A typed fixed reasoning-body toggle.
	ThinkingToggleKind {
		/// Explicitly enable thinking.
		Enabled,
	}
);

/// First-event and inter-event stream timeout guidance.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamWatchdog {
	/// Maximum wait for the first decoded event in milliseconds.
	pub first_event_ms: Option<u64>,
	/// Maximum idle interval between decoded events in milliseconds.
	pub idle_ms:        Option<u64>,
}

impl StreamWatchdog {
	/// Returns the configured first-event timeout.
	pub const fn first_event_timeout(self) -> Option<Duration> {
		match self.first_event_ms {
			Some(milliseconds) => Some(Duration::from_millis(milliseconds)),
			None => None,
		}
	}

	/// Returns the configured idle timeout.
	pub const fn idle_timeout(self) -> Option<Duration> {
		match self.idle_ms {
			Some(milliseconds) => Some(Duration::from_millis(milliseconds)),
			None => None,
		}
	}
}

/// Role projection policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RolePolicy {
	/// Whether a developer role may be emitted.
	pub supports_developer_role:          Option<bool>,
	/// Whether more than one system message may be emitted.
	pub multiple_system_messages:         Option<bool>,
	/// Whether a system message may occur after conversation content.
	pub supports_mid_conversation_system: Option<bool>,
	/// Whether the Claude Code instruction must be injected.
	pub inject_claude_code_instruction:   Option<bool>,
	/// Whether system instructions may be scoped to one turn.
	pub supports_turn_scoped_system:      Option<bool>,
}

policy_enum!(/// Declared cost of using a native forced-tool selector.
	NativeToolChoicePenalty {
		/// Existing prompt-cache identity is invalidated.
		CacheInvalidated,
		/// The selector can add billable usage.
		Billable,
		/// The selector can increase latency.
		Latency,
		/// A provider declares a cost that is not otherwise classified.
		Unknown,
	}
);

/// Tool definition, choice, and transcript projection policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolPolicy {
	/// Whether any tool-choice control is accepted.
	pub supports_tool_choice: Option<bool>,
	/// Whether object-form named tool choice is accepted.
	pub named_choice: Option<bool>,
	/// Whether a tool may be forced.
	pub forced_choice: Option<bool>,
	/// Declared cost of sending the native forced-tool selector. Absence means
	/// the route has affirmatively declared no penalty.
	pub forced_choice_penalty: Option<NativeToolChoicePenalty>,
	/// Strictness emission policy.
	pub strict_mode: Option<ToolStrictMode>,
	/// Tool parameter schema representation.
	pub schema_flavor: Option<ToolSchemaFlavor>,
	/// Tool-call identifier projection.
	pub id_profile: Option<ToolCallIdProfile>,
	/// Whether built-in tool names must be escaped.
	pub escape_builtin_names: Option<bool>,
	/// Whether tool results must repeat their tool-call identifier.
	pub requires_result_id: Option<bool>,
	/// Whether partial tool input may be surfaced eagerly.
	pub eager_input_streaming: Option<bool>,
	/// Whether assistant tool-call turns require non-empty content.
	pub requires_assistant_content: Option<bool>,
	/// Resolution when reasoning controls conflict with tool choice.
	pub thinking_conflict: Option<ThinkingToolChoiceConflict>,
	/// Apply-patch tool wire representation.
	pub apply_patch: Option<ApplyPatchWireKind>,
	/// Native computer-use request support.
	pub computer_use: Option<ComputerUseWireSupport>,
	/// Computer-use configuration object support.
	pub computer_use_config: Option<ComputerUseConfigSupport>,
	/// Whether choosing a tool disables reasoning.
	pub disable_reasoning_on_choice: Option<bool>,
	/// Whether forcing a tool disables reasoning.
	pub disable_reasoning_on_forced_choice: Option<bool>,
	/// Whether Antigravity uses its Claude validated-tool mode.
	pub antigravity_claude_mode: Option<bool>,
	/// Whether Cloud Code Assist uses the legacy `parameters` schema.
	pub cca_legacy_parameters_schema: Option<bool>,
	/// Whether strict tool definitions must be disabled.
	pub disable_strict_tools: Option<bool>,
	/// Whether object-root unions must be rejected rather than transformed.
	pub reject_root_object_union: Option<bool>,
	/// Whether an assistant message is required after each tool result.
	pub requires_assistant_after_result: Option<bool>,
	/// Whether Mistral-compatible tool-call identifiers are required.
	pub requires_mistral_ids: Option<bool>,
	/// Whether a missing Google thought signature uses the skip sentinel.
	pub requires_skip_thought_signature: Option<bool>,
	/// Whether only the first unsigned Google call receives the skip sentinel.
	pub requires_skip_thought_signature_on_first_function_call: Option<bool>,
	/// Whether tool results must repeat the tool name.
	pub requires_result_name: Option<bool>,
	/// Whether a grammar-size error may retry without strict tools.
	pub retry_without_strict_on_grammar_error: Option<bool>,
	/// Whether Responses history requires strict item pairing.
	pub strict_responses_pairing: Option<bool>,
	/// Whether Google function parts may carry identifiers.
	pub supports_function_part_id: Option<bool>,
	/// Whether tool definitions may change mid-conversation.
	pub supports_mid_conversation_changes: Option<bool>,
	/// Whether parallel tool calls are accepted.
	pub supports_parallel_calls: Option<bool>,
	/// Whether the endpoint accepts strict tool mode.
	pub supports_strict_mode: Option<bool>,
	/// Whether `OpenAI`'s forty-character tool-call identifier limit applies.
	pub uses_openai_id_limit: Option<bool>,
	/// Whether object-root `anyOf`/`oneOf` tool-parameter unions must be
	/// flattened when exclusive-required and withheld otherwise (xAI rejects
	/// them).
	pub flatten_root_unions: Option<bool>,
}

/// Structured-output lowering policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StructuredOutputPolicy {
	/// Whether frequency and presence penalties are accepted.
	pub penalties:               Option<bool>,
	/// Whether temperature and top-p are accepted.
	pub sampling_params:         Option<bool>,
	/// Whether stop sequences are accepted.
	pub stop_sequences:          Option<bool>,
	/// Whether both penalty and stop parameters are accepted.
	pub penalty_and_stop_params: Option<bool>,
}

/// Typed `thinking: { type: ... }` request-body override.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThinkingToggle {
	/// Toggle operation.
	#[serde(rename = "type")]
	pub kind: ThinkingToggleKind,
}

/// Fixed body fields applied to a reasoning request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasoningBodyOverride {
	/// Typed thinking object.
	pub thinking:          Option<ThinkingToggle>,
	/// Qwen-compatible thinking switch.
	pub enable_thinking:   Option<bool>,
	/// Venice request controls.
	pub venice_parameters: Option<VeniceParameters>,
}

/// Typed Venice request controls carried by compatibility policy.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VeniceParameters {
	/// Explicitly disable reasoning for this request.
	pub disable_thinking:             Option<bool>,
	/// Include Venice's provider-authored system prompt.
	pub include_venice_system_prompt: Option<bool>,
}

/// Additional body fields applied only while reasoning is enabled.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WhenThinkingPolicy {
	/// Fixed typed request-body additions.
	#[serde(default)]
	pub extra_body: Option<ReasoningBodyOverride>,
	/// Reasoning text format selected for the enabled request.
	#[serde(default)]
	pub thinking_format: Option<ThinkingFormat>,
	/// Whether reasoning text is required on tool-call turns.
	#[serde(default)]
	pub requires_reasoning_content_for_tool_calls: Option<bool>,
	/// Whether synthetic reasoning text may repair tool-call turns.
	#[serde(default)]
	pub allows_synthetic_reasoning_content_for_tool_calls: Option<bool>,
	/// Provider field carrying reasoning text.
	#[serde(default)]
	pub reasoning_content_field: Option<Str>,
}

/// Reasoning request, transcript, and recovery policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasoningPolicy {
	/// Provider-native reasoning representation.
	pub wire_format: Option<ReasoningWireFormat>,
	/// Additional reasoning text format.
	pub thinking_format: Option<ThinkingFormat>,
	/// Whether native effort controls are accepted.
	pub supports_effort: Option<bool>,
	/// Whether `reasoning.summary` is accepted by the endpoint.
	pub supports_summary: Option<bool>,
	/// Whether the effort field must be omitted.
	pub omit_effort: Option<bool>,
	/// Whether the selected effort rides
	/// `chat_template_kwargs.reasoning_effort`.
	pub template_reasoning_effort: Option<bool>,
	/// Canonical-to-native effort spelling overrides.
	pub effort_map: BTreeMap<ThinkingEffort, Str>,
	/// Explicit disable operation.
	pub disable_mode: Option<ReasoningDisableMode>,
	/// Name of the reasoning text field.
	pub content_field: Option<Str>,
	/// Whether reasoning content is required on tool-call turns.
	pub requires_content_for_tool_calls: Option<bool>,
	/// Whether reasoning content is required on every assistant turn.
	pub requires_content_for_all_assistant_turns: Option<bool>,
	/// Whether synthetic reasoning content may satisfy a transcript requirement.
	pub allows_synthetic_content_for_tool_calls: Option<bool>,
	/// Whether reasoning history must be removed from requests.
	pub filter_history: Option<bool>,
	/// Whether encrypted reasoning items are requested.
	pub include_encrypted: Option<bool>,
	/// Whether unsigned thinking blocks may be replayed.
	pub replay_unsigned: Option<bool>,
	/// Whether thinking must be explicitly enabled.
	pub requires_enabled: Option<bool>,
	/// Whether adaptive thinking must be disabled.
	pub disable_adaptive: Option<bool>,
	/// Whether thinking may be interleaved with tool-use blocks on the wire.
	pub interleaved_thinking: Option<bool>,
	/// Whether this route is an official reasoning endpoint.
	pub official_endpoint: Option<bool>,
	/// Whether this route is a thinking-signing endpoint.
	pub signing_endpoint: Option<bool>,
	/// Fixed typed reasoning request-body additions.
	pub extra_body: Option<ReasoningBodyOverride>,
	/// Conditional reasoning request-body additions.
	pub when_thinking: Option<WhenThinkingPolicy>,
	/// Leaked-reasoning text healer.
	pub leaked_healer: Option<LeakedThinkingHealer>,
	/// Whether repeated zero-progress reasoning is guarded.
	pub loop_guard: Option<bool>,
	/// Catalog-selected repeated-reasoning guard profile.
	pub loop_guard_profile: Option<ThinkingLoopGuardProfile>,
	/// Whether an effort field suppresses a conflicting thinking toggle.
	pub drop_thinking_when_effort: Option<bool>,
	/// Whether unsigned thinking blocks must be dropped.
	pub drop_unsigned: Option<bool>,
	/// Whether Kimi K3 uses its native reasoning representation.
	pub native_kimi_k3: Option<bool>,
	/// Whether Qwen thinking history must be preserved.
	pub qwen_preserve_thinking: Option<bool>,
	/// Whether reasoning content is replayed into the request.
	pub replay_content: Option<bool>,
	/// Whether reasoning-off needs an explicit zero-juice instruction.
	pub requires_off_juice_instruction: Option<bool>,
	/// Whether thinking must be projected as ordinary text.
	pub requires_thinking_as_text: Option<bool>,
	/// Whether reasoning context from every turn is accepted.
	pub supports_all_turns_context: Option<bool>,
	/// Whether Anthropic output-effort controls are accepted.
	pub supports_output_effort: Option<bool>,
	/// Whether effort may be set per message.
	pub supports_per_message_effort: Option<bool>,
	/// Whether native reasoning request parameters are accepted.
	pub supports_params: Option<bool>,
	/// Whether signed-thinking prefix binding controls are accepted.
	pub supports_binding_controls: Option<bool>,
	/// Whether Kimi thinking is retained in request history.
	pub keep: Option<bool>,
	/// Whether only explicitly marked thinking is trusted.
	pub trust_explicit_only: Option<bool>,
}

/// Prompt cache policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CachePolicy {
	/// Cache marker encoding.
	pub control_format:          Option<CacheControlFormat>,
	/// Whether long retention controls are accepted.
	pub supports_long_retention: Option<bool>,
	/// Bedrock checkpoint policy.
	pub prompt_cache_mode:       Option<PromptCacheMode>,
	/// Minimum tokens before explicit checkpoints are useful.
	pub minimum_tokens:          Option<u64>,
	/// Maximum explicit checkpoints accepted by the route.
	pub maximum_checkpoints:     Option<u8>,
	/// Explicit prompt-cache breakpoint retention.
	pub breakpoint_ttl:          Option<PromptCacheBreakpointTtl>,
	/// Whether explicit prompt-cache breakpoints are accepted.
	pub supports_breakpoints:    Option<bool>,
	/// Whether a stable prompt-cache key is accepted.
	pub supports_key:            Option<bool>,
}

/// Output limits, storage, and response continuation policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextPolicy {
	/// Generated-token limit field.
	pub max_tokens_field:           Option<MaxTokensField>,
	/// Explicit output-token limit emission policy.
	pub max_output_tokens:          Option<MaxOutputTokensEmission>,
	/// Whether provider-side response storage may be requested.
	pub supports_store:             Option<bool>,
	/// Whether a preceding provider response may be continued by identifier.
	pub stateful_response_chaining: Option<bool>,
	/// Provider wire mode used to enable an extended context path.
	pub extended_mode:              Option<ExtendedContextMode>,
	/// Whether private-use glyphs require reversible ASCII wire tokenization.
	pub glyph_tokenization:         Option<bool>,
	/// Whether a token limit must be sent even when the caller omitted one.
	pub always_send_max_tokens:     Option<bool>,
	/// Whether output tokens are clamped to the catalog model maximum.
	pub clamp_output_to_model_max:  Option<bool>,
	/// Whether provider-side context management is accepted.
	pub supports_management:        Option<bool>,
}

/// Streaming framing, timeout, and recovery policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamingPolicy {
	/// Stream framing protocol.
	pub protocol: Option<StreamProtocol>,
	/// Optional first-event and idle timeouts.
	pub watchdog: Option<StreamWatchdog>,
	/// Maximum retries for a reasoning-only stream close.
	pub thinking_close_max_retries: Option<u32>,
	/// Whether an empty length finish is classified as context exhaustion.
	pub empty_length_finish_is_context_error: Option<bool>,
	/// Whether the Gemini Flash stream-leak workaround is enabled.
	pub flash_leak_workaround: Option<bool>,
	/// Whether Harmony leaked channels are mitigated.
	pub harmony_leak_mitigation: Option<bool>,
	/// Whether reasoning deltas may repeat their complete prefix.
	pub reasoning_deltas_cumulative: Option<bool>,
	/// Catalog-selected leaked-markup healing pattern.
	pub markup_healing_pattern: Option<StreamMarkupHealingPattern>,
	/// Whether `DeepSeek` special tokens are stripped from text.
	pub strip_deepseek_special_tokens: Option<bool>,
	/// Whether Responses stream obfuscation may be disabled.
	pub supports_obfuscation_opt_out: Option<bool>,
}

/// Usage-report projection policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsagePolicy {
	/// Whether usage may be requested and decoded while streaming.
	pub in_streaming:      Option<bool>,
	/// Antigravity request label indicating Claude usage.
	pub antigravity_label: Option<Str>,
}

/// Image request and transcript projection policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImagePolicy {
	/// Image payload encoding.
	pub encoding:                     Option<ImageEncodingFormat>,
	/// Whether the `original` detail level is accepted.
	pub supports_detail_original:     Option<bool>,
	/// Whether function responses may contain multimodal payloads.
	pub multimodal_function_response: Option<bool>,
	/// Whether image input must be removed from requests.
	pub strip_input:                  Option<bool>,
}

/// Audio endpoint projection policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioPolicy {
	/// Required API-version suffix.
	pub api_version: Option<AudioApiVersion>,
}

/// Safe request-header compatibility policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderWirePolicy {
	/// Whether caller headers may replace selected Anthropic defaults.
	pub allow_anthropic_overrides: Option<bool>,
	/// Whether Google Claude requests carry the thinking beta header.
	pub claude_thinking_beta:      Option<bool>,
	/// Header carrying the prompt-cache session identifier.
	pub prompt_cache_session:      Option<PromptCacheSessionHeader>,
}

/// Host wire-dialect compatibility policy.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DialectPolicy {
	/// Kimi Code API request format.
	pub kimi_api_format:      Option<KimiApiFormat>,
	/// Whether Devin resolves the model through its router.
	pub model_router:         Option<bool>,
	/// Model-identifier rewrite convention.
	pub wire_model_id_mode:   Option<WireModelIdMode>,
	/// Whether Z.AI uses its reasoning-effort dialect.
	pub zai_reasoning_effort: Option<bool>,
}

/// Complete typed wire-lowering and stream-recovery policy.
///
/// Optional axes deliberately distinguish unspecified policy from explicit
/// `false`. [`WirePolicy::baseline`] supplies the conventional resolved
/// profile; [`WirePolicy::overrides`] supplies an all-unspecified structural
/// profile.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WirePolicy {
	/// Role projection policy.
	pub role:       RolePolicy,
	/// Tool projection policy.
	pub tool:       ToolPolicy,
	/// Structured-output projection policy.
	pub structured: StructuredOutputPolicy,
	/// Reasoning projection and recovery policy.
	pub reasoning:  ReasoningPolicy,
	/// Prompt-cache projection policy.
	pub cache:      CachePolicy,
	/// Output-limit and response-context policy.
	pub context:    ContextPolicy,
	/// Streaming framing and timeout policy.
	pub streaming:  StreamingPolicy,
	/// Usage-report policy.
	pub usage:      UsagePolicy,
	/// Image projection policy.
	pub image:      ImagePolicy,
	/// Audio endpoint policy.
	pub audio:      AudioPolicy,
	/// Request-header compatibility policy.
	pub headers:    HeaderWirePolicy,
	/// Host wire-dialect compatibility policy.
	pub dialect:    DialectPolicy,
}

impl WirePolicy {
	/// Creates an all-unspecified structural override profile.
	///
	/// `const` so neutral policies can back `static` placeholders without lazy
	/// initialization.
	pub const fn overrides() -> Self {
		Self {
			role:       RolePolicy {
				supports_developer_role:          None,
				multiple_system_messages:         None,
				supports_mid_conversation_system: None,
				inject_claude_code_instruction:   None,
				supports_turn_scoped_system:      None,
			},
			tool:       ToolPolicy {
				supports_tool_choice: None,
				named_choice: None,
				forced_choice: None,
				forced_choice_penalty: None,
				strict_mode: None,
				schema_flavor: None,
				id_profile: None,
				escape_builtin_names: None,
				requires_result_id: None,
				eager_input_streaming: None,
				requires_assistant_content: None,
				thinking_conflict: None,
				apply_patch: None,
				computer_use: None,
				computer_use_config: None,
				disable_reasoning_on_choice: None,
				disable_reasoning_on_forced_choice: None,
				antigravity_claude_mode: None,
				cca_legacy_parameters_schema: None,
				disable_strict_tools: None,
				reject_root_object_union: None,
				requires_assistant_after_result: None,
				requires_mistral_ids: None,
				requires_skip_thought_signature: None,
				requires_skip_thought_signature_on_first_function_call: None,
				requires_result_name: None,
				retry_without_strict_on_grammar_error: None,
				strict_responses_pairing: None,
				supports_function_part_id: None,
				supports_mid_conversation_changes: None,
				supports_parallel_calls: None,
				supports_strict_mode: None,
				uses_openai_id_limit: None,
				flatten_root_unions: None,
			},
			structured: StructuredOutputPolicy {
				penalties:               None,
				sampling_params:         None,
				stop_sequences:          None,
				penalty_and_stop_params: None,
			},
			reasoning:  ReasoningPolicy {
				wire_format: None,
				thinking_format: None,
				supports_effort: None,
				supports_summary: None,
				omit_effort: None,
				template_reasoning_effort: None,
				effort_map: BTreeMap::new(),
				disable_mode: None,
				content_field: None,
				requires_content_for_tool_calls: None,
				requires_content_for_all_assistant_turns: None,
				allows_synthetic_content_for_tool_calls: None,
				filter_history: None,
				include_encrypted: None,
				replay_unsigned: None,
				requires_enabled: None,
				disable_adaptive: None,
				interleaved_thinking: None,
				official_endpoint: None,
				signing_endpoint: None,
				extra_body: None,
				when_thinking: None,
				leaked_healer: None,
				loop_guard: None,
				loop_guard_profile: None,
				drop_thinking_when_effort: None,
				drop_unsigned: None,
				native_kimi_k3: None,
				qwen_preserve_thinking: None,
				replay_content: None,
				requires_off_juice_instruction: None,
				requires_thinking_as_text: None,
				supports_all_turns_context: None,
				supports_output_effort: None,
				supports_per_message_effort: None,
				supports_params: None,
				supports_binding_controls: None,
				keep: None,
				trust_explicit_only: None,
			},
			cache:      CachePolicy {
				control_format:          None,
				supports_long_retention: None,
				prompt_cache_mode:       None,
				minimum_tokens:          None,
				maximum_checkpoints:     None,
				breakpoint_ttl:          None,
				supports_breakpoints:    None,
				supports_key:            None,
			},
			context:    ContextPolicy {
				max_tokens_field:           None,
				max_output_tokens:          None,
				supports_store:             None,
				stateful_response_chaining: None,
				extended_mode:              None,
				glyph_tokenization:         None,
				always_send_max_tokens:     None,
				clamp_output_to_model_max:  None,
				supports_management:        None,
			},
			streaming:  StreamingPolicy {
				protocol: None,
				watchdog: None,
				thinking_close_max_retries: None,
				empty_length_finish_is_context_error: None,
				flash_leak_workaround: None,
				harmony_leak_mitigation: None,
				reasoning_deltas_cumulative: None,
				markup_healing_pattern: None,
				strip_deepseek_special_tokens: None,
				supports_obfuscation_opt_out: None,
			},
			usage:      UsagePolicy { in_streaming: None, antigravity_label: None },
			image:      ImagePolicy {
				encoding:                     None,
				supports_detail_original:     None,
				multimodal_function_response: None,
				strip_input:                  None,
			},
			audio:      AudioPolicy { api_version: None },
			headers:    HeaderWirePolicy {
				allow_anthropic_overrides: None,
				claude_thinking_beta:      None,
				prompt_cache_session:      None,
			},
			dialect:    DialectPolicy {
				kimi_api_format:      None,
				model_router:         None,
				wire_model_id_mode:   None,
				zai_reasoning_effort: None,
			},
		}
	}

	/// Returns the conventional fully resolved OpenAI-compatible profile.
	///
	/// `const` so the baseline can back `static` placeholders without lazy
	/// initialization; every field overwritten here is `Copy`.
	pub const fn baseline() -> Self {
		let mut policy = Self::overrides();
		policy.role.multiple_system_messages = Some(true);
		policy.tool.named_choice = Some(true);
		policy.tool.forced_choice = Some(true);
		policy.tool.strict_mode = Some(ToolStrictMode::Mixed);
		policy.tool.schema_flavor = Some(ToolSchemaFlavor::JsonSchema);
		policy.tool.id_profile = Some(ToolCallIdProfile::Unconstrained);
		policy.tool.thinking_conflict = Some(ThinkingToolChoiceConflict::None);
		policy.structured.penalties = Some(true);
		policy.structured.sampling_params = Some(true);
		policy.structured.stop_sequences = Some(true);
		policy.reasoning.wire_format = Some(ReasoningWireFormat::OpenAi);
		policy.reasoning.template_reasoning_effort = Some(false);
		policy.reasoning.leaked_healer = Some(LeakedThinkingHealer::None);
		policy.reasoning.loop_guard = Some(false);
		policy.cache.control_format = Some(CacheControlFormat::None);
		policy.context.max_tokens_field = Some(MaxTokensField::MaxCompletionTokens);
		policy.context.glyph_tokenization = Some(false);
		policy.streaming.protocol = Some(StreamProtocol::SseData);
		policy.streaming.watchdog =
			Some(StreamWatchdog { first_event_ms: None, idle_ms: None });
		policy.usage.in_streaming = Some(true);
		policy.image.encoding = Some(ImageEncodingFormat::OpenAiUrl);
		policy.audio.api_version = Some(AudioApiVersion::None);
		policy
	}

	/// Serializes the policy into deterministic structural bytes.
	pub fn canonical_bytes(&self) -> Vec<u8> {
		serde_json::to_vec(self).expect("typed wire policy always serializes")
	}

	/// Returns the stable content-derived policy identifier.
	pub fn content_id(&self) -> WirePolicyId {
		WirePolicyId::from(content_id("wire", &self.canonical_bytes()))
	}
}

impl Default for WirePolicy {
	fn default() -> Self {
		Self::baseline()
	}
}

/// Stable structural table that interns equal wire policies once.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct WirePolicyTable {
	entries: BTreeMap<WirePolicyId, WirePolicy>,
}

impl WirePolicyTable {
	/// Interns a policy and returns its stable content identifier.
	pub fn intern(&mut self, policy: WirePolicy) -> WirePolicyId {
		let id = policy.content_id();
		self.entries.entry(id.clone()).or_insert(policy);
		id
	}

	/// Gets an interned policy by identifier.
	pub fn get(&self, id: &WirePolicyId<str>) -> Option<&WirePolicy> {
		self.entries.get(id)
	}

	/// Iterates over interned policies in stable identifier order.
	pub fn iter(&self) -> btree_map::Iter<'_, WirePolicyId, WirePolicy> {
		self.entries.iter()
	}

	/// Returns the number of distinct structural policies.
	pub fn len(&self) -> usize {
		self.entries.len()
	}

	/// Reports whether no policy is interned.
	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}
}

impl<'table> IntoIterator for &'table WirePolicyTable {
	type IntoIter = btree_map::Iter<'table, WirePolicyId, WirePolicy>;
	type Item = (&'table WirePolicyId, &'table WirePolicy);

	fn into_iter(self) -> Self::IntoIter {
		self.iter()
	}
}

/// Static-header profile validation failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HeaderPolicyError {
	/// A name is empty or is not an HTTP token.
	#[error("invalid static header name `{0}`")]
	InvalidName(Str),
	/// A value contains forbidden HTTP control bytes.
	#[error("invalid static header value for `{0}`")]
	InvalidValue(Str),
	/// A credential-bearing, routing, or framing header was supplied.
	#[error("unsafe credential, routing, or framing header `{0}`")]
	UnsafeName(Str),
	/// The profile contains the same case-insensitive name more than once.
	#[error("duplicate static header name `{0}`")]
	DuplicateName(Str),
}

impl HeaderProfile {
	/// Validates, lowercases, canonically orders, and interns static headers.
	pub fn try_new(
		headers: impl IntoIterator<Item = StaticHeader>,
	) -> Result<Self, HeaderPolicyError> {
		let headers = canonicalize_headers(headers)?;
		let bytes = serde_json::to_vec(&headers)
			.map_err(|_| HeaderPolicyError::InvalidValue(sf!("<serialization>")))?;
		Ok(Self {
			id:      HeaderProfileId::from(content_id("headers", &bytes)),
			headers: headers.into_iter().collect(),
		})
	}

	/// Validates the profile and returns deterministic structural bytes.
	pub fn canonical_bytes(&self) -> Result<Vec<u8>, HeaderPolicyError> {
		let headers = canonicalize_headers(self.headers.iter().cloned())?;
		serde_json::to_vec(&headers)
			.map_err(|_| HeaderPolicyError::InvalidValue(sf!("<serialization>")))
	}

	/// Returns the stable content-derived header profile identifier.
	pub fn content_id(&self) -> Result<HeaderProfileId, HeaderPolicyError> {
		Ok(HeaderProfileId::from(content_id("headers", &self.canonical_bytes()?)))
	}
}

fn canonicalize_headers(
	headers: impl IntoIterator<Item = StaticHeader>,
) -> Result<Vec<StaticHeader>, HeaderPolicyError> {
	let mut headers: Vec<_> = headers.into_iter().collect();
	for header in &mut headers {
		validate_header(header)?;
		header.name = header.name.as_str().to_ascii_lowercase().into();
	}
	headers.sort_unstable_by(|left, right| left.name.cmp(&right.name));
	for pair in headers.windows(2) {
		if pair[0].name == pair[1].name {
			return Err(HeaderPolicyError::DuplicateName(pair[0].name.clone()));
		}
	}
	Ok(headers)
}

fn validate_header(header: &StaticHeader) -> Result<(), HeaderPolicyError> {
	let name = header.name.as_str();
	if name.is_empty() || !name.bytes().all(is_header_name_byte) {
		return Err(HeaderPolicyError::InvalidName(header.name.clone()));
	}
	let lowercase = name.to_ascii_lowercase();
	if is_unsafe_header(&lowercase) {
		return Err(HeaderPolicyError::UnsafeName(header.name.clone()));
	}
	if header.value.as_bytes().iter().any(|byte| {
		*byte == 0
			|| *byte == b'\r'
			|| *byte == b'\n'
			|| (*byte < 0x20 && *byte != b'\t')
			|| *byte == 0x7f
	}) {
		return Err(HeaderPolicyError::InvalidValue(header.name.clone()));
	}
	Ok(())
}

const fn is_header_name_byte(byte: u8) -> bool {
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
}

fn is_unsafe_header(name: &str) -> bool {
	matches!(
		name,
		"authorization"
			| "proxy-authorization"
			| "proxy-authenticate"
			| "www-authenticate"
			| "cookie"
			| "set-cookie"
			| "x-api-key"
			| "api-key"
			| "x-goog-api-key"
			| "host"
			| "connection"
			| "content-length"
			| "transfer-encoding"
			| "te" | "trailer"
			| "upgrade"
	) || name.contains("authorization")
		|| name.contains("api-key")
		|| name.contains("apikey")
		|| name.contains("credential")
		|| name.contains("secret")
		|| name.contains("token")
		|| name.contains("cookie")
}

pub(crate) fn content_id(namespace: &str, bytes: &[u8]) -> Str {
	let digest: [u8; 32] = Sha256::digest(bytes).into();
	let encoded = hex::encode_n(&digest);
	format!("{namespace}-sha256-{encoded}").into()
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeMap;

	use serde::Deserialize;

	use super::*;

	#[test]
	fn standard_pricing_policy_caps_only_tiered_known_windows() {
		use crate::pricing::{PriceTier, Pricing};

		let tiered = Pricing::new(Vec::new(), vec![PriceTier {
			prompt_tokens_above: 272_000,
			components:          Box::new([]),
		}])
		.expect("tiered pricing");
		let standard = ExtendedContextPolicy::from_enabled(false);
		assert_eq!(standard.effective_context_window(Some(1_000_000), &tiered), Some(272_000));
		assert_eq!(standard.effective_context_window(Some(128_000), &tiered), Some(128_000));
		assert_eq!(standard.effective_context_window(None, &tiered), None);
		assert_eq!(
			ExtendedContextPolicy::Enabled.effective_context_window(Some(1_000_000), &tiered),
			Some(1_000_000)
		);
		let untiered = Pricing::default();
		assert_eq!(standard.effective_context_window(Some(1_000_000), &untiered), Some(1_000_000));
	}

	#[derive(Deserialize)]
	struct CompatFixture {
		profile_count: usize,
		profiles:      Vec<CompatCase>,
	}

	#[derive(Deserialize)]
	struct CompatCase {
		shape: FlatCompatShape,
	}

	#[derive(Default, Deserialize)]
	struct FlatCompatShape {
		#[serde(rename = "wire/allows_synthetic_reasoning_content_for_tool_calls")]
		allows_synthetic_reasoning_content_for_tool_calls: Option<bool>,
		#[serde(rename = "wire/disable_adaptive_thinking")]
		disable_adaptive_thinking: Option<bool>,
		#[serde(rename = "wire/disable_reasoning_on_tool_choice")]
		disable_reasoning_on_tool_choice: Option<bool>,
		#[serde(rename = "wire/escape_builtin_tool_names")]
		escape_builtin_tool_names: Option<bool>,
		#[serde(rename = "wire/extra_body")]
		extra_body: Option<ReasoningBodyOverride>,
		#[serde(rename = "wire/filter_reasoning_history")]
		filter_reasoning_history: Option<bool>,
		#[serde(rename = "wire/flatten_root_unions")]
		flatten_root_unions: Option<bool>,
		#[serde(rename = "wire/include_encrypted_reasoning")]
		include_encrypted_reasoning: Option<bool>,
		#[serde(rename = "wire/max_tokens_field")]
		max_tokens_field: Option<MaxTokensField>,
		#[serde(rename = "wire/official_endpoint")]
		official_endpoint: Option<bool>,
		#[serde(rename = "wire/omit_reasoning_effort")]
		omit_reasoning_effort: Option<bool>,
		#[serde(rename = "wire/reasoning_content_field")]
		reasoning_content_field: Option<Str>,
		#[serde(rename = "wire/reasoning_disable_mode")]
		reasoning_disable_mode: Option<ReasoningDisableMode>,
		#[serde(rename = "wire/reasoning_effort_map", default)]
		reasoning_effort_map: BTreeMap<ThinkingEffort, Str>,
		#[serde(rename = "wire/replay_unsigned_thinking")]
		replay_unsigned_thinking: Option<bool>,
		#[serde(rename = "wire/requires_assistant_content_for_tool_calls")]
		requires_assistant_content_for_tool_calls: Option<bool>,
		#[serde(rename = "wire/requires_reasoning_content_for_all_assistant_turns")]
		requires_reasoning_content_for_all_assistant_turns: Option<bool>,
		#[serde(rename = "wire/requires_reasoning_content_for_tool_calls")]
		requires_reasoning_content_for_tool_calls: Option<bool>,
		#[serde(rename = "wire/requires_thinking_enabled")]
		requires_thinking_enabled: Option<bool>,
		#[serde(rename = "wire/requires_tool_result_id")]
		requires_tool_result_id: Option<bool>,
		#[serde(rename = "wire/signing_endpoint")]
		signing_endpoint: Option<bool>,
		#[serde(rename = "wire/stream_idle_timeout_ms")]
		stream_idle_timeout_ms: Option<u64>,
		#[serde(rename = "wire/thinking_close_max_retries")]
		thinking_close_max_retries: Option<u32>,
		#[serde(rename = "wire/supports_developer_role")]
		supports_developer_role: Option<bool>,
		#[serde(rename = "wire/supports_eager_tool_input_streaming")]
		supports_eager_tool_input_streaming: Option<bool>,
		#[serde(rename = "wire/supports_forced_tool_choice")]
		supports_forced_tool_choice: Option<bool>,
		#[serde(rename = "wire/supports_image_detail_original")]
		supports_image_detail_original: Option<bool>,
		#[serde(rename = "wire/supports_long_cache_retention")]
		supports_long_cache_retention: Option<bool>,
		#[serde(rename = "wire/supports_mid_conversation_system")]
		supports_mid_conversation_system: Option<bool>,
		#[serde(rename = "wire/supports_reasoning_effort")]
		supports_reasoning_effort: Option<bool>,
		#[serde(rename = "wire/supports_reasoning_summary")]
		supports_reasoning_summary: Option<bool>,
		#[serde(rename = "wire/supports_sampling_params")]
		supports_sampling_params: Option<bool>,
		#[serde(rename = "wire/supports_store")]
		supports_store: Option<bool>,
		#[serde(rename = "wire/supports_tool_choice")]
		supports_tool_choice: Option<bool>,
		#[serde(rename = "wire/supports_usage_in_streaming")]
		supports_usage_in_streaming: Option<bool>,
		#[serde(rename = "wire/thinking_format")]
		thinking_format: Option<ThinkingFormat>,
		#[serde(rename = "wire/when_thinking")]
		when_thinking: Option<FixtureWhenThinking>,
	}

	#[derive(Deserialize)]
	#[serde(rename_all = "camelCase")]
	struct FixtureWhenThinking {
		extra_body:      FixtureWhenThinkingBody,
		thinking_format: ThinkingFormat,
	}

	#[derive(Deserialize)]
	struct FixtureWhenThinkingBody {
		enable_thinking: Option<bool>,
	}

	impl From<FlatCompatShape> for WirePolicy {
		fn from(shape: FlatCompatShape) -> Self {
			let mut policy = Self::overrides();
			policy.role.supports_developer_role = shape.supports_developer_role;
			policy.role.supports_mid_conversation_system = shape.supports_mid_conversation_system;
			policy.tool.supports_tool_choice = shape.supports_tool_choice;
			policy.tool.forced_choice = shape.supports_forced_tool_choice;
			policy.tool.flatten_root_unions = shape.flatten_root_unions;
			policy.tool.escape_builtin_names = shape.escape_builtin_tool_names;
			policy.tool.requires_result_id = shape.requires_tool_result_id;
			policy.tool.eager_input_streaming = shape.supports_eager_tool_input_streaming;
			policy.tool.requires_assistant_content = shape.requires_assistant_content_for_tool_calls;
			policy.tool.disable_reasoning_on_choice = shape.disable_reasoning_on_tool_choice;
			policy.structured.sampling_params = shape.supports_sampling_params;
			policy.reasoning.thinking_format = shape.thinking_format;
			policy.reasoning.supports_effort = shape.supports_reasoning_effort;
			policy.reasoning.supports_summary = shape.supports_reasoning_summary;
			policy.reasoning.omit_effort = shape.omit_reasoning_effort;
			policy.reasoning.effort_map = shape.reasoning_effort_map;
			policy.reasoning.disable_mode = shape.reasoning_disable_mode;
			policy.reasoning.content_field = shape.reasoning_content_field;
			policy.reasoning.requires_content_for_tool_calls =
				shape.requires_reasoning_content_for_tool_calls;
			policy.reasoning.requires_content_for_all_assistant_turns =
				shape.requires_reasoning_content_for_all_assistant_turns;
			policy.reasoning.allows_synthetic_content_for_tool_calls =
				shape.allows_synthetic_reasoning_content_for_tool_calls;
			policy.reasoning.filter_history = shape.filter_reasoning_history;
			policy.reasoning.include_encrypted = shape.include_encrypted_reasoning;
			policy.reasoning.replay_unsigned = shape.replay_unsigned_thinking;
			policy.reasoning.requires_enabled = shape.requires_thinking_enabled;
			policy.reasoning.disable_adaptive = shape.disable_adaptive_thinking;
			policy.reasoning.official_endpoint = shape.official_endpoint;
			policy.reasoning.signing_endpoint = shape.signing_endpoint;
			policy.reasoning.extra_body = shape.extra_body;
			policy.reasoning.when_thinking = shape.when_thinking.map(|when| WhenThinkingPolicy {
				extra_body: Some(ReasoningBodyOverride {
					thinking:          None,
					enable_thinking:   when.extra_body.enable_thinking,
					venice_parameters: None,
				}),
				thinking_format: Some(when.thinking_format),
				requires_reasoning_content_for_tool_calls: None,
				allows_synthetic_reasoning_content_for_tool_calls: None,
				reasoning_content_field: None,
			});
			policy.cache.supports_long_retention = shape.supports_long_cache_retention;
			policy.context.max_tokens_field = shape.max_tokens_field;
			policy.context.supports_store = shape.supports_store;
			policy.streaming.watchdog = shape
				.stream_idle_timeout_ms
				.map(|idle_ms| StreamWatchdog { first_event_ms: None, idle_ms: Some(idle_ms) });
			policy.streaming.thinking_close_max_retries = shape.thinking_close_max_retries;
			policy.usage.in_streaming = shape.supports_usage_in_streaming;
			policy.image.supports_detail_original = shape.supports_image_detail_original;
			policy
		}
	}

	#[derive(Deserialize)]
	struct HeaderFixture {
		resolved_policy: HeaderCases,
	}

	#[derive(Deserialize)]
	struct HeaderCases {
		cases: Vec<HeaderCase>,
	}

	#[derive(Deserialize)]
	struct HeaderCase {
		accepted: bool,
		name:     Str,
	}

	#[test]
	fn all_compatibility_fixture_shapes_are_distinct_and_content_stable() {
		let fixture: CompatFixture = serde_json::from_str(include_str!(
			"../../../fixtures/llm-oracle/catalog-policy/compat-profiles.json"
		))
		.expect("compatibility fixture parses into typed cases");
		assert_eq!(fixture.profiles.len(), fixture.profile_count);

		let mut table = WirePolicyTable::default();
		for case in fixture.profiles {
			let policy = WirePolicy::from(case.shape);
			let first = policy.content_id();
			let encoded = policy.canonical_bytes();
			let decoded: WirePolicy =
				serde_json::from_slice(&encoded).expect("canonical policy bytes decode");
			assert_eq!(decoded.content_id(), first);
			assert_eq!(table.intern(policy), first);
		}
		assert_eq!(table.len(), 35);
	}

	#[test]
	fn absence_and_explicit_false_have_different_content_ids() {
		let absent = WirePolicy::overrides();
		let mut explicit = WirePolicy::overrides();
		explicit.context.supports_store = Some(false);
		assert_ne!(absent.content_id(), explicit.content_id());
	}

	#[test]
	fn header_fixture_acceptance_and_canonical_order_are_enforced() {
		let fixture: HeaderFixture = serde_json::from_str(include_str!(
			"../../../fixtures/llm-oracle/catalog-policy/header-policy.json"
		))
		.expect("header fixture parses");
		for case in fixture.resolved_policy.cases {
			let result =
				HeaderProfile::try_new([StaticHeader { name: case.name, value: sf!("fixture") }]);
			assert_eq!(result.is_ok(), case.accepted);
		}

		let left = HeaderProfile::try_new([
			StaticHeader { name: sf!("X-Model-Test"), value: sf!("a") },
			StaticHeader { name: sf!("User-Agent"), value: sf!("b") },
		])
		.expect("safe headers");
		let right = HeaderProfile::try_new([
			StaticHeader { name: sf!("user-agent"), value: sf!("b") },
			StaticHeader { name: sf!("x-model-test"), value: sf!("a") },
		])
		.expect("safe headers");
		assert_eq!(left, right);
		assert_eq!(left.id, left.content_id().expect("valid content id"));
	}
}
