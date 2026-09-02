/**
 * The closed compat-axis vocabulary: every KDL cascade directive, the resolved
 * camelCase field it assigns, its value shape, and — for wire axes — the
 * compat records it applies to.
 *
 * Single source of truth shared by the compile-time rule compiler
 * (`scripts/compat-compiler`) and the runtime engine (`./resolve`). The
 * compiler rejects any directive absent from this table; the runtime assigns
 * a wire axis onto a model's compat record only when the model's API maps to
 * one of the axis's declared records.
 */
import type { Effort } from "../effort";
import type { ThinkingControlMode } from "../types";

/** Value shape a directive accepts (see `rules/README.md`). */
export type AxisShape = "scalar" | "array" | "object";

/** Axis namespace: request-wire compat, thinking control surface, or catalog metadata. */
export type AxisSet = "wire" | "thinking" | "catalog";

/** Resolved compat record families a wire axis may be assigned onto. */
export type CompatRecordName = "openai" | "openai-responses" | "anthropic" | "bedrock" | "devin" | "google";

/** One axis definition: resolved key, namespace, shape, and applicability. */
export interface AxisDef {
	/** Resolved camelCase field the directive assigns. */
	key: string;
	set: AxisSet;
	shape: AxisShape;
	/** Wire axes only: records this key exists on. */
	records?: readonly CompatRecordName[];
	/** Closed value vocabulary for string scalars / string arrays. */
	values?: readonly string[];
	/**
	 * Object axes only: payload child names are literal wire JSON keys copied
	 * verbatim (`extra-body`). Default object payloads author kebab-case names
	 * that compile to camelCase resolved keys.
	 */
	verbatimKeys?: true;
}

const OAI = ["openai", "openai-responses"] as const;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Effort tiers accepted by taxonomy collapse/override vocabulary (`Effort` ∪ `"off"`). */
export const EFFORT_TIERS: readonly string[] = [...EFFORTS, "off"];
const THINKING_MODES = [
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
] as const satisfies readonly ThinkingControlMode[];

/** Narrow a KDL string to an effort tier (`Effort` ∪ `"off"`). */
export function isEffortTier(value: string): value is Effort | "off" {
	return EFFORT_TIERS.includes(value);
}

/** Narrow a KDL string to a thinking control mode. */
export function isThinkingMode(value: string): value is ThinkingControlMode {
	return (THINKING_MODES as readonly string[]).includes(value);
}

function wire(
	key: string,
	records: readonly CompatRecordName[],
	shape: AxisShape = "scalar",
	values?: readonly string[],
): AxisDef {
	return { key, set: "wire", shape, records, values };
}

/**
 * KDL directive → axis definition. Keys are the kebab-case directive
 * spellings accepted inside `classes/*.kdl` and `providers/*.kdl` rule
 * blocks.
 */
export const AXES: Readonly<Record<string, AxisDef>> = {
	// ── wire: OpenAI-compatible surfaces (chat completions + Responses) ──
	"allows-synthetic-reasoning-content-for-tool-calls": wire("allowsSyntheticReasoningContentForToolCalls", OAI),
	"always-send-max-tokens": wire("alwaysSendMaxTokens", OAI),
	"cache-control-format": wire("cacheControlFormat", OAI, "scalar", ["anthropic"]),
	"clamp-output-to-model-max": wire("clampOutputToModelMax", ["openai"]),
	"disable-reasoning-on-forced-tool-choice": wire("disableReasoningOnForcedToolChoice", OAI),
	"disable-reasoning-on-tool-choice": wire("disableReasoningOnToolChoice", OAI),
	"drop-thinking-when-reasoning-effort": wire("dropThinkingWhenReasoningEffort", ["openai"]),
	"empty-length-finish-is-context-error": wire("emptyLengthFinishIsContextError", OAI),
	"extra-body": { ...wire("extraBody", ["openai"], "object"), verbatimKeys: true },
	"filter-reasoning-history": wire("filterReasoningHistory", OAI),
	"include-encrypted-reasoning": wire("includeEncryptedReasoning", OAI),
	"kimi-api-format": wire("kimiApiFormat", ["openai"], "scalar", ["openai", "anthropic"]),
	"max-tokens-field": wire("maxTokensField", ["openai"], "scalar", ["max_completion_tokens", "max_tokens"]),
	"native-kimi-k3-reasoning": wire("nativeKimiK3Reasoning", ["openai"]),
	"omit-reasoning-effort": wire("omitReasoningEffort", OAI),
	"prompt-cache-breakpoint-ttl": wire("promptCacheBreakpointTtl", OAI, "scalar", ["30m"]),
	"prompt-cache-session-header": wire("promptCacheSessionHeader", OAI, "scalar", ["x-grok-conv-id"]),
	"qwen-preserve-thinking": wire("qwenPreserveThinking", ["openai"]),
	"reject-root-object-union": wire("rejectRootObjectUnion", OAI),
	"retry-without-strict-on-grammar-error": wire("retryWithoutStrictOnGrammarError", OAI),
	"reasoning-content-field": wire("reasoningContentField", OAI, "scalar", [
		"reasoning_content",
		"reasoning",
		"reasoning_text",
	]),
	"reasoning-deltas-may-be-cumulative": wire("reasoningDeltasMayBeCumulative", OAI),
	"reasoning-disable-mode": wire("reasoningDisableMode", OAI, "scalar", [
		"omit",
		"lowest-effort",
		"none-effort",
		"openrouter-enabled-false",
		"cline-enabled-false",
		"venice-disable-thinking",
		"zai-thinking-disabled",
		"qwen-enable-thinking-false",
		"qwen-template-false",
		"chat-template-thinking-false",
	]),
	"reasoning-effort-map": wire("reasoningEffortMap", OAI, "object"),
	"replay-reasoning-content": wire("replayReasoningContent", ["openai"]),
	"requires-assistant-after-tool-result": wire("requiresAssistantAfterToolResult", ["openai"]),
	"requires-assistant-content-for-tool-calls": wire("requiresAssistantContentForToolCalls", OAI),
	"requires-mistral-tool-ids": wire("requiresMistralToolIds", ["openai"]),
	"requires-reasoning-content-for-all-assistant-turns": wire("requiresReasoningContentForAllAssistantTurns", OAI),
	"requires-reasoning-content-for-tool-calls": wire("requiresReasoningContentForToolCalls", OAI),
	"requires-thinking-as-text": wire("requiresThinkingAsText", ["openai"]),
	"requires-tool-result-name": wire("requiresToolResultName", ["openai"]),
	"strict-responses-pairing": wire("strictResponsesPairing", ["openai-responses"]),
	"requires-reasoning-off-juice-instruction": wire("requiresReasoningOffJuiceInstruction", ["openai-responses"]),
	"supports-all-turns-reasoning-context": wire("supportsAllTurnsReasoningContext", ["openai-responses"]),
	"strip-deepseek-special-tokens": wire("stripDeepseekSpecialTokens", OAI),
	"stream-markup-healing-pattern": wire("streamMarkupHealingPattern", OAI, "scalar", [
		"kimi",
		"dsml",
		"qwen",
		"thinking",
		"harmony",
	]),
	"supports-developer-role": wire("supportsDeveloperRole", OAI),
	"supports-image-detail-original": wire("supportsImageDetailOriginal", ["openai-responses"]),
	"supports-long-prompt-cache-retention": wire("supportsLongPromptCacheRetention", [...OAI, "bedrock"]),
	"supports-multiple-system-messages": wire("supportsMultipleSystemMessages", ["openai"]),
	"supports-named-tool-choice": wire("supportsNamedToolChoice", OAI),
	"supports-obfuscation-opt-out": wire("supportsObfuscationOptOut", ["openai-responses"]),
	"harmony-leak-mitigation": wire("harmonyLeakMitigation", ["openai-responses"]),
	"supports-penalty-and-stop-params": wire("supportsPenaltyAndStopParams", OAI),
	"supports-prompt-cache-breakpoints": wire("supportsPromptCacheBreakpoints", OAI),
	"supports-prompt-cache-key": wire("supportsPromptCacheKey", ["openai"]),
	"supports-reasoning-effort": wire("supportsReasoningEffort", OAI),
	"supports-reasoning-params": wire("supportsReasoningParams", OAI),
	"supports-reasoning-summary": wire("supportsReasoningSummary", ["openai-responses"]),
	"supports-store": wire("supportsStore", ["openai"]),
	"supports-strict-mode": wire("supportsStrictMode", OAI),
	"supports-tool-choice": wire("supportsToolChoice", OAI),
	"supports-usage-in-streaming": wire("supportsUsageInStreaming", ["openai"]),
	"template-reasoning-effort": wire("qwenTemplateReasoningEffort", ["openai"]),
	"thinking-format": wire("thinkingFormat", OAI, "scalar", [
		"openai",
		"openrouter",
		"zai",
		"kimi",
		"qwen",
		"qwen-chat-template",
		"chat-template",
	]),
	"thinking-keep": wire("thinkingKeep", ["openai"]),
	"tool-schema-flavor": wire("toolSchemaFlavor", OAI, "scalar", ["moonshot-mfjs", "grammar", "none"]),
	"tool-strict-mode": wire("toolStrictMode", ["openai"], "scalar", ["all_strict", "none", "mixed"]),
	"uses-openai-tool-call-id-limit": wire("usesOpenAIToolCallIdLimit", OAI),
	"when-thinking": wire("whenThinking", ["openai"], "object"),
	"wire-model-id-mode": wire("wireModelIdMode", OAI, "scalar", [
		"raw",
		"cline-pass",
		"firepass",
		"fireworks",
		"openrouter",
	]),
	"zai-reasoning-effort-dialect": wire("zaiReasoningEffortDialect", ["openai"]),

	// ── wire: anthropic-messages ──
	"allow-anthropic-header-overrides": wire("allowAnthropicHeaderOverrides", ["anthropic"]),
	"disable-adaptive-thinking": wire("disableAdaptiveThinking", ["anthropic"]),
	"disable-strict-tools": wire("disableStrictTools", ["anthropic"]),
	"escape-builtin-tool-names": wire("escapeBuiltinToolNames", ["anthropic"]),
	"inject-claude-code-instruction": wire("injectClaudeCodeInstruction", ["anthropic"]),
	"official-endpoint": wire("officialEndpoint", ["anthropic", "openai-responses"]),
	"replay-unsigned-thinking": wire("replayUnsignedThinking", ["anthropic"]),
	"requires-thinking-enabled": wire("requiresThinkingEnabled", ["anthropic"]),
	"requires-tool-result-id": wire("requiresToolResultId", ["anthropic"]),
	"signing-endpoint": wire("signingEndpoint", ["anthropic"]),
	"supports-context-management": wire("supportsContextManagement", ["anthropic"]),
	"supports-output-effort": wire("supportsOutputEffort", ["anthropic"]),
	"supports-eager-tool-input-streaming": wire("supportsEagerToolInputStreaming", ["anthropic"]),
	"supports-long-cache-retention": wire("supportsLongCacheRetention", ["anthropic"]),
	"supports-mid-conversation-system": wire("supportsMidConversationSystem", ["anthropic"]),
	"supports-mid-conversation-tool-changes": wire("supportsMidConversationToolChanges", ["anthropic"]),
	"supports-per-message-effort": wire("supportsPerMessageEffort", ["anthropic"]),
	"supports-thinking-binding-controls": wire("supportsThinkingBindingControls", ["anthropic"]),
	"supports-turn-scoped-system": wire("supportsTurnScopedSystem", ["anthropic"]),

	// ── wire: bedrock-converse-stream ──
	"prompt-cache-maximum-checkpoints": wire("promptCacheMaximumCheckpoints", ["bedrock"]),
	"prompt-cache-minimum-tokens": wire("promptCacheMinimumTokens", ["bedrock"]),
	"prompt-cache-mode": wire("promptCacheMode", ["bedrock"], "scalar", ["none", "automatic", "explicit"]),

	// ── wire: devin-agent ──
	"model-router": wire("modelRouter", ["devin"]),
	"supports-parallel-tool-calls": wire("supportsParallelToolCalls", ["devin"]),
	"trust-explicit-thinking-only": wire("trustExplicitThinkingOnly", ["devin"]),

	// ── wire: google APIs ──
	"antigravity-claude-tool-mode": wire("antigravityClaudeToolMode", ["google"]),
	"antigravity-usage-label": wire("antigravityUsageLabel", ["google"]),
	"cca-legacy-parameters-schema": wire("ccaLegacyParametersSchema", ["google"]),
	"claude-thinking-beta-header": wire("claudeThinkingBetaHeader", ["google"]),
	"drop-unsigned-thinking": wire("dropUnsignedThinking", ["google"]),
	"flash-stream-leak-workaround": wire("flashStreamLeakWorkaround", ["google"]),
	"multimodal-function-response": wire("multimodalFunctionResponse", ["google"]),
	"requires-skip-thought-signature": wire("requiresSkipThoughtSignature", ["google"]),
	"supports-function-part-id": wire("supportsFunctionPartId", ["google"]),

	// ── wire: shared across surfaces ──
	"stream-first-event-timeout-ms": wire("streamFirstEventTimeoutMs", [...OAI, "google"]),
	"stream-idle-timeout-ms": wire("streamIdleTimeoutMs", [...OAI, "anthropic", "bedrock", "google"]),
	"strip-image-input": wire("stripImageInput", [...OAI, "anthropic", "google"]),
	"supports-forced-tool-choice": wire("supportsForcedToolChoice", [...OAI, "anthropic"]),
	"supports-sampling-params": wire("supportsSamplingParams", [...OAI, "anthropic"]),
	"thinking-loop-guard": wire("thinkingLoopGuard", [...OAI, "anthropic", "google"], "scalar", [
		"gemini",
		"deepseek",
		"xai",
	]),

	// ── thinking control surface ──
	"thinking-default-level": { key: "defaultLevel", set: "thinking", shape: "scalar", values: EFFORTS },
	"thinking-effort-budgets": { key: "effortBudgets", set: "thinking", shape: "object" },
	"thinking-effort-map": { key: "effortMap", set: "thinking", shape: "object" },
	"thinking-efforts": { key: "efforts", set: "thinking", shape: "array", values: EFFORTS },
	"thinking-mode": {
		key: "mode",
		set: "thinking",
		shape: "scalar",
		values: THINKING_MODES,
	},
	"thinking-requires-effort": { key: "requiresEffort", set: "thinking", shape: "scalar" },
	"thinking-prefix-binding": { key: "prefixBinding", set: "thinking", shape: "scalar" },
	"thinking-suppress-when-off": { key: "suppressWhenOff", set: "thinking", shape: "scalar" },
	"thinking-supports-display": { key: "supportsDisplay", set: "thinking", shape: "scalar" },

	// ── catalog metadata ──
	"apply-patch-tool-type": {
		key: "applyPatchToolType",
		set: "catalog",
		shape: "scalar",
		values: ["freeform", "function"],
	},
	"context-promotion-target": { key: "contextPromotionTarget", set: "catalog", shape: "scalar" },
	"context-window-floor": { key: "contextWindowFloor", set: "catalog", shape: "scalar" },
	"cost-patch": { key: "costPatch", set: "catalog", shape: "object" },
	"edit-revision": { key: "editRevision", set: "catalog", shape: "scalar" },
	"input-modalities": { key: "inputModalities", set: "catalog", shape: "array", values: ["text", "image"] },
	"limits-patch": { key: "limitsPatch", set: "catalog", shape: "object" },
	"long-context-cost": { key: "longContext", set: "catalog", shape: "object" },
	"long-usage-limit-fallback": { key: "longUsageLimitFallback", set: "catalog", shape: "scalar" },
	priority: { key: "priority", set: "catalog", shape: "scalar" },
	"service-tier-cost": { key: "serviceTierCost", set: "catalog", shape: "object" },
};

/** Records applicable to each API family; used by `resolve.ts` when applying wire axes. */
export const API_COMPAT_RECORDS: Readonly<Record<string, readonly CompatRecordName[]>> = {
	"openai-completions": ["openai"],
	openrouter: ["openai", "openai-responses"],
	"openai-responses": ["openai-responses"],
	"azure-openai-responses": ["openai-responses"],
	"openai-codex-responses": ["openai-responses"],
	"anthropic-messages": ["anthropic"],
	"bedrock-converse-stream": ["bedrock"],
	"devin-agent": ["devin"],
	"google-generative-ai": ["google"],
	"google-vertex": ["google"],
	"google-gemini-cli": ["google"],
};
