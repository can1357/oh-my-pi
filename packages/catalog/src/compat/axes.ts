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
import { MODEL_KINDS, type ThinkingControlMode } from "../types";
import { FACTORY_DROID_UPSTREAMS } from "../wire/factory-droid";

/** Value shape a directive accepts (see `rules/README.md`). */
export type AxisShape = "scalar" | "array" | "object";

/** Axis namespace: request-wire compat, thinking control surface, or catalog metadata. */
export type AxisSet = "wire" | "thinking" | "catalog";

/** Resolved compat record families a wire axis may be assigned onto. */
export type CompatRecordName =
	| "openai"
	| "openai-responses"
	| "anthropic"
	| "bedrock"
	| "devin"
	| "google"
	| "request"
	| "ollama";

/** One axis definition: resolved key, namespace, shape, and applicability. */
export interface AxisDef {
	/** Resolved camelCase field the directive assigns. */
	key: string;
	set: AxisSet;
	shape: AxisShape;
	/** Wire axes only: records this key exists on. */
	records?: readonly CompatRecordName[];
	/** Closed value vocabulary for scalars / arrays (strings, and booleans on flag axes). */
	values?: readonly (string | boolean)[];
	/**
	 * Object axes only: payload child names are literal wire JSON keys copied
	 * verbatim (`extra-body`). Default object payloads author kebab-case names
	 * that compile to camelCase resolved keys.
	 */
	verbatimKeys?: true;
	/** Array axes only: a bare directive assigns an empty list (an explicit "none"). */
	emptyArray?: true;
}

const OAI = ["openai", "openai-responses"] as const;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Effort tiers accepted by taxonomy collapse/override vocabulary (`Effort` ∪ `"off"`). */
export const EFFORT_TIERS: readonly string[] = [...EFFORTS, "off"];

/**
 * How hard agent prompts push subagent delegation for a model lineage
 * (`delegation-bias` axis). `eager` is the unassigned default: the prompt
 * actively pushes fan-out. `restrained` keeps fan-out for genuinely parallel
 * slices but forbids reflexive scouts and single-agent babysitting. `gated`
 * forbids subagents unless the user or a skill asks.
 */
export const DELEGATION_BIASES = ["eager", "restrained", "gated"] as const;
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
	// Selected-route request shaping, resolved alongside shared adapter compat.
	"completions-reasoning-mode": wire("completionsReasoningMode", ["request"], "scalar", [
		"none",
		"effort",
		"opt-in",
		"forced-on",
	]),
	"completions-reasoning-history": wire("completionsReasoningHistory", ["request"], "scalar", [
		"omit",
		"preserved",
		"interleaved",
	]),
	"anthropic-thinking": wire("anthropicThinking", ["request"], "scalar", [
		"adaptive",
		"adaptive-summarized",
		"budget-interleaved",
		"budget-effort",
	]),
	"anthropic-tool-streaming-beta": wire("anthropicToolStreamingBeta", ["request"]),
	"openai-platform-header": wire("openaiPlatformHeader", ["request"]),
	"responses-cache-retention": wire("responsesCacheRetention", ["request"]),
	"responses-verbosity": wire("responsesVerbosity", ["request"], "scalar", ["low"]),
	"responses-service-tier": wire("responsesServiceTier", ["request"], "scalar", ["priority"]),
	"responses-parallel-tool-calls": wire("responsesParallelToolCalls", ["request"]),
	"responses-safety-identifier": wire("responsesSafetyIdentifier", ["request"]),
	"responses-tool-choice-auto": wire("responsesToolChoiceAuto", ["request"]),
	"routing-session-lock": wire("routingSessionLock", ["request"]),
	"google-thinking": wire("googleThinking", ["request"], "scalar", ["level", "level-medium"]),
	// ── wire: OpenAI-compatible surfaces (chat completions + Responses) ──
	"allows-synthetic-reasoning-content-for-tool-calls": wire("allowsSyntheticReasoningContentForToolCalls", OAI),
	"always-send-max-tokens": wire("alwaysSendMaxTokens", OAI),
	"cache-control-format": wire("cacheControlFormat", OAI, "scalar", ["anthropic"]),
	"clamp-output-to-model-max": wire("clampOutputToModelMax", OAI),
	"disable-reasoning-on-forced-tool-choice": wire("disableReasoningOnForcedToolChoice", OAI),
	"disable-reasoning-on-tool-choice": wire("disableReasoningOnToolChoice", OAI),
	"disable-reasoning-with-tools": wire("disableReasoningWithTools", ["openai"]),
	"drop-thinking-when-reasoning-effort": wire("dropThinkingWhenReasoningEffort", ["openai"]),
	"empty-length-finish-is-context-error": wire("emptyLengthFinishIsContextError", OAI),
	"extra-body": { ...wire("extraBody", ["openai"], "object"), verbatimKeys: true },
	"filter-reasoning-history": wire("filterReasoningHistory", OAI),
	"include-encrypted-reasoning": wire("includeEncryptedReasoning", OAI),
	"kimi-api-format": wire("kimiApiFormat", ["openai"], "scalar", ["openai", "anthropic"]),
	"max-tokens-field": wire("maxTokensField", ["openai"], "scalar", ["max_completion_tokens", "max_tokens"]),
	"mistral-reasoning-content-parts": wire("mistralReasoningContentParts", ["openai"]),
	"native-kimi-k3-reasoning": wire("nativeKimiK3Reasoning", ["openai"]),
	"omit-reasoning-effort": wire("omitReasoningEffort", OAI),
	"prompt-cache-breakpoint-ttl": wire("promptCacheBreakpointTtl", OAI, "scalar", ["30m"]),
	"prompt-cache-session-header": wire("promptCacheSessionHeader", OAI, "scalar", ["x-grok-conv-id"]),
	"qwen-preserve-thinking": wire("qwenPreserveThinking", ["openai"]),
	"reject-root-object-union": wire("rejectRootObjectUnion", OAI),
	"retry-without-strict-on-grammar-error": wire("retryWithoutStrictOnGrammarError", OAI),
	"session-header": wire("sessionHeader", OAI, "scalar", ["x-litellm-session-id"]),
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
	"synthetic-reasoning-content-fallback": wire("syntheticReasoningContentFallback", ["openai"]),
	"requires-assistant-after-tool-result": wire("requiresAssistantAfterToolResult", ["openai"]),
	"requires-assistant-content-for-tool-calls": wire("requiresAssistantContentForToolCalls", OAI),
	"requires-mistral-tool-ids": wire("requiresMistralToolIds", ["openai"]),
	"requires-reasoning-content-for-all-assistant-turns": wire("requiresReasoningContentForAllAssistantTurns", OAI),
	"requires-reasoning-content-for-tool-calls": wire("requiresReasoningContentForToolCalls", OAI),
	"requires-thinking-as-text": wire("requiresThinkingAsText", ["openai"]),
	"requires-tool-result-name": wire("requiresToolResultName", ["openai"]),
	"strict-responses-pairing": wire("strictResponsesPairing", ["openai-responses"]),
	"connection-bound-native-history": wire("connectionBoundNativeHistory", ["openai-responses"]),
	"stateful-responses": wire("statefulResponses", ["openai-responses"]),
	"requires-reasoning-off-juice-instruction": wire("requiresReasoningOffJuiceInstruction", ["openai-responses"]),
	"supports-all-turns-reasoning-context": wire("supportsAllTurnsReasoningContext", ["openai-responses"]),
	"supports-configuration-update": wire("supportsConfigurationUpdate", ["openai-responses"]),
	"supports-steering": wire("supportsSteering", ["openai-responses"]),
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
	"store-responses": wire("storeResponses", ["openai-responses"]),
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
	"bedrock-messages-api": wire("bedrockMessagesApi", ["anthropic"]),
	"allow-anthropic-header-overrides": wire("allowAnthropicHeaderOverrides", ["anthropic"]),
	"disable-adaptive-thinking": wire("disableAdaptiveThinking", ["anthropic"]),
	"disable-strict-tools": wire("disableStrictTools", ["anthropic"]),
	"between-tools-effort": wire("betweenToolsEffort", ["anthropic"], "scalar", ["low", "medium", "high"]),
	"disabled-thinking": wire("disabledThinking", ["anthropic", "bedrock"], "scalar", [
		"omit",
		"disabled",
		"adaptive",
		"between-tools",
	]),
	"effort-beta": wire("effortBeta", ["anthropic"]),
	"escape-builtin-tool-names": wire("escapeBuiltinToolNames", ["anthropic"]),
	"extended-cache-ttl-beta": wire("extendedCacheTtlBeta", ["anthropic"]),
	"fast-mode": wire("fastMode", ["anthropic"]),
	"first-party-provider": wire("firstPartyProvider", ["anthropic"]),
	"honors-claude-code-beta-kill-switch": wire("honorsClaudeCodeBetaKillSwitch", ["anthropic"]),
	"inject-claude-code-instruction": wire("injectClaudeCodeInstruction", ["anthropic"]),
	"max-image-dimension": wire("maxImageDimension", ["anthropic", "google"]),
	"max-image-payload-bytes": wire("maxImagePayloadBytes", ["anthropic", "google"]),
	"official-endpoint": wire("officialEndpoint", ["anthropic", "openai-responses"]),
	"replay-unsigned-thinking": wire("replayUnsignedThinking", ["anthropic"]),
	"requires-thinking-enabled": wire("requiresThinkingEnabled", ["anthropic"]),
	"requires-thinking-presence": wire("requiresThinkingPresence", ["anthropic"]),
	"requires-tool-result-id": wire("requiresToolResultId", ["anthropic"]),
	"signing-endpoint": wire("signingEndpoint", ["anthropic"]),
	"strip-thinking-history": wire("stripThinkingHistory", ["openai", "anthropic", "ollama"]),
	"supports-context-management": wire("supportsContextManagement", ["anthropic"]),
	"supports-output-effort": wire("supportsOutputEffort", ["anthropic"]),
	"supports-eager-tool-input-streaming": wire("supportsEagerToolInputStreaming", ["anthropic"]),
	"supports-long-cache-retention": wire("supportsLongCacheRetention", ["anthropic"]),
	"supports-mid-conversation-system": wire("supportsMidConversationSystem", ["anthropic"]),
	"supports-mid-conversation-tool-changes": wire("supportsMidConversationToolChanges", ["anthropic"]),
	"supports-per-message-effort": wire("supportsPerMessageEffort", ["anthropic"]),
	"supports-server-compaction": wire("supportsServerCompaction", ["anthropic", "bedrock"]),
	"supports-between-tools-thinking": wire("supportsBetweenToolsThinking", ["anthropic"]),
	"supports-thinking-binding-controls": wire("supportsThinkingBindingControls", ["anthropic", "bedrock"]),
	"supports-turn-scoped-system": wire("supportsTurnScopedSystem", ["anthropic"]),

	// ── wire: bedrock-converse-stream ──
	"prompt-cache-maximum-checkpoints": wire("promptCacheMaximumCheckpoints", ["bedrock"]),
	"prompt-cache-minimum-tokens": wire("promptCacheMinimumTokens", ["bedrock"]),
	"prompt-cache-mode": wire("promptCacheMode", ["bedrock"], "scalar", ["none", "automatic", "explicit"]),

	// ── wire: devin-agent ──
	"model-router": wire("modelRouter", ["devin"]),
	"supports-parallel-tool-calls": wire("supportsParallelToolCalls", ["devin"]),
	"trust-explicit-thinking-only": wire("trustExplicitThinkingOnly", [...OAI, "devin"]),

	// ── wire: google APIs ──
	"antigravity-claude-tool-mode": wire("antigravityClaudeToolMode", ["google"]),
	"antigravity-usage-label": wire("antigravityUsageLabel", ["google"]),
	"cca-legacy-parameters-schema": wire("ccaLegacyParametersSchema", ["google"]),
	"claude-thinking-beta-header": wire("claudeThinkingBetaHeader", ["google"]),
	"drop-unsigned-thinking": wire("dropUnsignedThinking", ["google"]),
	"flash-stream-leak-workaround": wire("flashStreamLeakWorkaround", ["google"]),
	"multimodal-function-response": wire("multimodalFunctionResponse", ["google"]),
	"requires-skip-thought-signature": wire("requiresSkipThoughtSignature", ["google"]),
	"requires-skip-thought-signature-on-first-function-call": wire("requiresSkipThoughtSignatureOnFirstFunctionCall", [
		"google",
	]),
	"supports-function-part-id": wire("supportsFunctionPartId", ["google"]),

	// ── wire: shared across surfaces ──
	/**
	 * Whether this wire may revise text it has already streamed: bytes
	 * reclassified out of the visible channel (a leaned-on thinking opener),
	 * carved into a tool call, reordered by content-block index, or replaced
	 * wholesale by an authoritative final payload. Unassigned means the wire
	 * only appends, so the transcript may retire finished lines into native
	 * scrollback while the turn is still streaming (see
	 * `AssistantMessageComponent`). Declare `possible` only with a citable
	 * mechanism: the renderer also verifies published rows every frame and stops
	 * retiring the block on the first mismatch, so this axis decides where
	 * mid-stream retirement is attempted, not whether it is safe.
	 */
	"stream-revision": wire("streamRevision", [...OAI, "bedrock"], "scalar", ["none", "possible"]),
	"stream-first-event-timeout-ms": wire("streamFirstEventTimeoutMs", [...OAI, "google"]),
	"stream-idle-timeout-ms": wire("streamIdleTimeoutMs", [...OAI, "anthropic", "bedrock", "google"]),
	"strip-image-input": wire("stripImageInput", [...OAI, "anthropic", "google"]),
	"supports-forced-tool-choice": wire("supportsForcedToolChoice", [...OAI, "anthropic", "bedrock"]),
	"supports-sampling-params": wire("supportsSamplingParams", [...OAI, "anthropic", "bedrock", "devin", "google"]),
	"thinking-loop-guard": wire("thinkingLoopGuard", [...OAI, "anthropic", "google"], "scalar", [
		"gemini",
		"deepseek",
		"xai",
	]),

	// ── thinking control surface ──
	"thinking-default-level": { key: "defaultLevel", set: "thinking", shape: "scalar", values: EFFORTS },
	"thinking-effort-budgets": { key: "effortBudgets", set: "thinking", shape: "object" },
	"thinking-effort-map": { key: "effortMap", set: "thinking", shape: "object" },
	"thinking-efforts": { key: "efforts", set: "thinking", shape: "array", values: EFFORTS, emptyArray: true },
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
	"thinking-upgrade-neutral": { key: "upgradeNeutral", set: "thinking", shape: "scalar" },
	/** Unclassified neutral ids here are capability-unknown: offer the ladder as opt-in. */
	"thinking-unverified": { key: "unverified", set: "thinking", shape: "scalar" },

	// ── catalog metadata ──
	"apply-patch-tool-type": {
		key: "applyPatchToolType",
		set: "catalog",
		shape: "scalar",
		values: ["freeform", "function"],
	},
	"requires-native-tools": { key: "requiresNativeTools", set: "catalog", shape: "scalar", values: [true, false] },
	"tool-schemas-in-context": { key: "toolSchemasInContext", set: "catalog", shape: "scalar", values: [true, false] },
	"requires-tool-free-history-for-tool-opt-out": {
		key: "requiresToolFreeHistoryForToolOptOut",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/** Replayed tool calls must satisfy the target wire's declaration charset and length. */
	"tool-call-name-charset": {
		key: "toolCallNameCharset",
		set: "catalog",
		shape: "scalar",
		values: ["ascii", "google"],
	},
	"tool-call-name-max-length": { key: "toolCallNameMaxLength", set: "catalog", shape: "scalar" },
	"preserves-max-output-tokens": {
		key: "preservesMaxOutputTokens",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	"omit-max-output-tokens": {
		key: "omitMaxOutputTokens",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/**
	 * The host accepts a prompt plus `max_tokens` beyond the context window and
	 * ends generation at the window (Anthropic `model_context_window_exceeded`)
	 * instead of rejecting the request, so callers must not lower the output cap
	 * to fit the window.
	 */
	"stops-output-at-context-window": {
		key: "stopsOutputAtContextWindow",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/**
	 * The model's input classifier refuses requests that reproduce assistant
	 * reasoning as quoted text (`reasoning_extraction`), so reasoning must not
	 * be replayed as text into its input: compaction archives, summarizer
	 * transcripts and demoted interrupted turns leave it out. Declared per class
	 * in `classes/*.kdl`.
	 */
	"classifier-cot-extraction": {
		key: "classifierCotExtraction",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	"clamp-context-override": { key: "clampContextOverride", set: "catalog", shape: "scalar" },
	"context-promotion-target": { key: "contextPromotionTarget", set: "catalog", shape: "scalar" },
	"context-window-floor": { key: "contextWindowFloor", set: "catalog", shape: "scalar" },
	"context-window-authoritative": {
		key: "contextWindowAuthoritative",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/**
	 * The model's long-context price tier does not bound its runtime context
	 * window: with extended context off, the window is not capped at the
	 * tier's input threshold (subscription hosts carrying API-equivalent tier
	 * prices, or a model served at its full window). Explicit user context
	 * overrides still apply.
	 */
	"long-context-window-uncapped": {
		key: "longContextWindowUncapped",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	"cost-patch": { key: "costPatch", set: "catalog", shape: "object" },
	"cost-fallback": { key: "costFallback", set: "catalog", shape: "object" },
	/**
	 * The host bills cache-hit input tokens at the full input rate (no cache
	 * discount), so the built row's `cacheRead` tracks its live `input` price.
	 */
	"cache-read-at-input-rate": {
		key: "cacheReadAtInputRate",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/**
	 * The host bills cache writes at this multiple of the row's live `input`
	 * price, for hosts whose discovery reports cache-write tokens but no
	 * cache-write rate. It replaces any `cacheWrite` the row carries, including
	 * a `cost-patch`/`cost-fallback` value and an absolute long-context tier's
	 * `cacheWrite` (rebased on the tier's `input`).
	 */
	"cache-write-rate": { key: "cacheWriteRate", set: "catalog", shape: "scalar" },
	/**
	 * How the model line bills a replayed signed thinking block as input:
	 * `output` bills the reasoning its signature carries, at the size the turn
	 * billed as output, and not the signature's bytes. Unassigned: estimated
	 * from the signature's bytes. Read through `./thinking-replay`.
	 */
	"thinking-replay-tokens": {
		key: "thinkingReplayTokens",
		set: "catalog",
		shape: "scalar",
		values: ["output", "signature"],
	},
	"delegation-bias": { key: "delegationBias", set: "catalog", shape: "scalar", values: DELEGATION_BIASES },
	"discovery-api": { key: "discoveryApi", set: "catalog", shape: "scalar" },
	"edit-prompt-variant": { key: "editPromptVariant", set: "catalog", shape: "scalar", values: ["full", "compact"] },
	"edit-revision": { key: "editRevision", set: "catalog", shape: "scalar" },
	"input-modalities": { key: "inputModalities", set: "catalog", shape: "array", values: ["text", "image"] },
	kind: { key: "kind", set: "catalog", shape: "scalar", values: MODEL_KINDS },
	"web-search": {
		key: "webSearch",
		set: "catalog",
		shape: "scalar",
		values: ["gemini", "anthropic", "codex", "xai", "openrouter", "openai"],
	},
	"web-search-model": { key: "webSearchModel", set: "catalog", shape: "scalar" },
	/**
	 * Revision suffix the host appends to the model's id (Vertex `@default`): a
	 * `provider/id` selector written without it names this model exactly.
	 * Unassigned: the id has no implied revision and must be written in full.
	 */
	"selector-revision-suffix": { key: "selectorRevisionSuffix", set: "catalog", shape: "scalar" },
	"hosted-image": { key: "hostedImage", set: "catalog", shape: "scalar", values: [true, false] },
	/** How the model line bills an input image; shape and formulas in `./image-tokenization`. */
	"image-tokenization": { key: "imageTokenization", set: "catalog", shape: "object" },
	/**
	 * Most images one request may carry, documents included where the host
	 * counts them. Unassigned: unknown host, held to a conservative floor.
	 */
	"image-count-budget": { key: "imageCountBudget", set: "catalog", shape: "scalar" },
	/**
	 * Replaces `image-count-budget` while the request reaches the official
	 * endpoint (pi-ai `reachesBudgetedHost`): a limit measured or documented
	 * for the host's own endpoint, which a custom `baseUrl` or an
	 * `ANTHROPIC_BASE_URL`/`FOUNDRY_BASE_URL` reroute (proxy, gateway) need not share.
	 */
	"official-image-count-budget": { key: "officialImageCountBudget", set: "catalog", shape: "scalar" },
	/**
	 * Opt-in: the reader may get a fresh `read` result as snapcompact frames
	 * (`snapcompact.toolResults`), because it edits as exactly from frames as
	 * from text. Unassigned: `read` results stay text, since a reader that
	 * misreads indentation in frames makes inexact edits.
	 */
	"snapcompact-image-reads": { key: "snapcompactImageReads", set: "catalog", shape: "scalar", values: [true, false] },
	"image-model": { key: "imageModel", set: "catalog", shape: "scalar" },
	/** Longest image edge the host passes to the model: it downscales larger images to fit first. */
	"image-max-edge": { key: "imageMaxEdge", set: "catalog", shape: "scalar" },
	"inline-image-byte-budget": { key: "inlineImageByteBudget", set: "catalog", shape: "scalar" },
	/**
	 * Largest request body the host accepts. Where set, the inline-image byte clamp keeps images within what the
	 * request's other bytes leave of it, and keeps the newest user message's and newest tool result's images past
	 * `inline-image-byte-budget` while they fit that room.
	 */
	"request-body-byte-limit": { key: "requestBodyByteLimit", set: "catalog", shape: "scalar" },
	/**
	 * Opt-in: the host budgets above apply whenever the request reaches the provider's own catalog endpoint
	 * (`endpoint-hosts`, or an unset `baseUrl`), for a hosted gateway whose compat names no official endpoint.
	 * Unassigned: they apply only on the official endpoint (pi-ai `reachesOfficialEndpoint`).
	 */
	"catalog-endpoint-budgets": {
		key: "catalogEndpointBudgets",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/**
	 * Supported formats and size bounds for judgment-request images; `mime-types`
	 * is comma-separated because object payloads have no array shape.
	 */
	"judgment-image-input": { key: "judgmentImageInput", set: "catalog", shape: "object" },
	/**
	 * `Content-Encoding`s the host decodes on request bodies, most preferred
	 * first. Applied only while the request reaches the provider's own endpoint
	 * (see `endpoint-hosts`), so a proxy or rerouted endpoint never receives
	 * bytes it cannot read. Unassigned: bodies are sent uncompressed.
	 */
	"request-encodings": { key: "requestEncodings", set: "catalog", shape: "array", values: ["zstd", "gzip"] },
	/**
	 * HTTPS hostnames the provider itself serves besides its bundled base URL's
	 * host — per-account endpoints such as Copilot's plan hosts. Together with
	 * that host they define the provider's own endpoint, which tells first-party
	 * traffic from a custom gateway that reuses the provider id.
	 */
	"endpoint-hosts": { key: "endpointHosts", set: "catalog", shape: "array" },
	/**
	 * Pattern of the JSON 400/415 error body the host returns when it cannot
	 * decode a compressed request body. Unassigned: every JSON 400/415 is a
	 * possible rejection and is re-checked with an uncompressed resend. Either
	 * way, a 400/403/415 whose body is not JSON (presumed a proxy's answer, not
	 * the host's) is re-checked too.
	 */
	"request-encoding-rejection": { key: "requestEncodingRejection", set: "catalog", shape: "scalar" },
	/**
	 * Most questions one System One judgment request may carry; the judge
	 * splits larger requests. Unassigned: the endpoint takes any batch size.
	 */
	"judgment-questions-max": { key: "judgmentQuestionsMax", set: "catalog", shape: "scalar" },
	"limits-patch": { key: "limitsPatch", set: "catalog", shape: "object" },
	/** Seeds `maxTokens` only when the row reports none; applied after `limits-patch`. */
	"max-tokens-fallback": { key: "maxTokensFallback", set: "catalog", shape: "scalar" },
	/** Most output tokens the host serves: a larger reported `maxTokens` (and Antigravity per-SKU `maxOutputTokens`) is lowered to it; an unknown one stays unknown. */
	"max-tokens-ceiling": { key: "maxTokensCeiling", set: "catalog", shape: "scalar" },
	"long-context-cost": { key: "longContext", set: "catalog", shape: "object" },
	"prompt-cache": { key: "promptCache", set: "catalog", shape: "object" },
	/**
	 * The lane rewards routing related requests — Task siblings, forks, explicit
	 * `--prompt-cache-key` callers — under one shared prompt-cache key instead of
	 * each conversation's own identity. Unassigned: per-conversation routing.
	 */
	"shared-prompt-cache": {
		key: "sharedPromptCache",
		set: "catalog",
		shape: "scalar",
		values: [true, false],
	},
	/**
	 * Prompt-cache lookback in block positions: how far back from a cache
	 * breakpoint the provider looks for an earlier request's cache entry.
	 * Unassigned: no known lookback bound.
	 */
	"prompt-cache-lookback": { key: "promptCacheLookback", set: "catalog", shape: "scalar" },
	/**
	 * The provider's own endpoint keeps prompt-cache entries indefinitely
	 * (logged-in Codex subscriptions): an idle gap never cools the prefix, so
	 * rewriting it while idle only discards a warm cache. Read through
	 * `compat/prompt-cache-persistent.ts`. Unassigned: entries expire.
	 */
	"prompt-cache-persistent": { key: "promptCachePersistent", set: "catalog", shape: "scalar", values: [true, false] },
	"long-usage-limit-fallback": { key: "longUsageLimitFallback", set: "catalog", shape: "scalar" },
	"max-context-window": { key: "maxContextWindow", set: "catalog", shape: "scalar" },
	/**
	 * Every host of the model returns its full plaintext trace wherever the
	 * wire does not mark reasoning as a summary (`ThinkingContent.summary ===
	 * false` vouches for nothing more), and its identity (class + family +
	 * revision) pins one set of weights, so a turn's reasoning may replay
	 * natively on another host serving the same model. Marked summaries never
	 * carry; do not declare it where a host serves summaries unmarked.
	 * Declared per family in `classes/*.kdl`; a host whose reasoning must not be
	 * carried in or out sets `#false` in its `providers/*.kdl`. Read through
	 * `compat/reasoning-carry.ts`.
	 */
	"portable-reasoning": { key: "portableReasoning", set: "catalog", shape: "scalar", values: [true, false] },
	"pricing-status": {
		key: "pricingStatus",
		set: "catalog",
		shape: "scalar",
		values: ["free", "included", "variable", "unknown"],
	},
	"requires-cursor-tool-schema-projection": {
		key: "requiresCursorToolSchemaProjection",
		set: "catalog",
		shape: "scalar",
	},
	"requires-tool-result-image-hoisting": {
		key: "requiresToolResultImageHoisting",
		set: "catalog",
		shape: "scalar",
	},
	"supports-assistant-prefill": { key: "supportsAssistantPrefill", set: "catalog", shape: "scalar" },
	/**
	 * Ordered Anthropic model ids forwarded as the server-side `fallbacks`
	 * chain when the user opts in. Each must appear in the requested model's
	 * `allowed_fallback_models` (GET /v1/models/{id}); anything else is a 400.
	 */
	"server-side-fallback-models": { key: "serverSideFallbackModels", set: "catalog", shape: "array" },
	/**
	 * Anthropic model ids a refusal's `fallback_credit_token` may be redeemed
	 * on (the refused model's permitted fallback targets). Unordered; a retry
	 * on any other model cannot redeem the credit.
	 */
	"fallback-credit-targets": { key: "fallbackCreditTargets", set: "catalog", shape: "array" },
	priority: { key: "priority", set: "catalog", shape: "scalar" },
	"service-tier-cost": { key: "serviceTierCost", set: "catalog", shape: "object" },
	"time-based-cost": { key: "timeBased", set: "catalog", shape: "object" },

	// ── catalog: routed-subscription registry ──
	// A gateway whose proxy fans one model out to several upstreams (Factory
	// Droid). Consumed through `./factory-droid`; `api-routes` picks the wire
	// and `quota-tiers` the billing pool.
	/** Ordered upstream rotation; the first entry is the default `x-api-provider`. */
	"upstream-rotation": { key: "upstreamRotation", set: "catalog", shape: "array", values: FACTORY_DROID_UPSTREAMS },
	/**
	 * Upstreams eligible to serve one inference region. The provider-wide rule
	 * is the upstream serving table; a model rule replaces it (the native
	 * region override), and a bare directive means the region never serves it.
	 */
	"region-upstreams-global": {
		key: "regionUpstreamsGlobal",
		set: "catalog",
		shape: "array",
		values: FACTORY_DROID_UPSTREAMS,
		emptyArray: true,
	},
	"region-upstreams-us": {
		key: "regionUpstreamsUs",
		set: "catalog",
		shape: "array",
		values: FACTORY_DROID_UPSTREAMS,
		emptyArray: true,
	},
	"region-upstreams-eu": {
		key: "regionUpstreamsEu",
		set: "catalog",
		shape: "array",
		values: FACTORY_DROID_UPSTREAMS,
		emptyArray: true,
	},
	/** EU inference limits (`context-window`, `max-tokens`) where the region narrows the default. */
	"region-limits-eu": { key: "regionLimitsEu", set: "catalog", shape: "object" },
	/**
	 * Subscription credit rates: `input` is the per-token credit weight shown
	 * as the model's multiplier; `output` and `cache-read` multiply it.
	 */
	"credit-rates": { key: "creditRates", set: "catalog", shape: "object" },
	/**
	 * List price borrowed from a bundled catalog row: provider id, then the
	 * row id when it differs from the model's own. Absent means no list price.
	 */
	"list-price-from": { key: "listPriceFrom", set: "catalog", shape: "array" },
	/** Provider family whose live routing defaults apply to the model. */
	"routing-family": {
		key: "routingFamily",
		set: "catalog",
		shape: "scalar",
		values: ["anthropic", "openai", "google", "factory", "xai"],
	},
	/** Other ids organization policy may use for the model. */
	"policy-aliases": { key: "policyAliases", set: "catalog", shape: "array" },
	/**
	 * Account gates: `feature-flag` must be on to list the model,
	 * `deprecation-flag` hides it once on, `requires-explicit-opt-in` hides it
	 * without an org policy, and `base-variant` marks a fast tier of that model.
	 */
	entitlement: { key: "entitlement", set: "catalog", shape: "object" },
	/** The native default when the caller picks no effort is thinking off. */
	"default-reasoning-off": { key: "defaultReasoningOff", set: "catalog", shape: "scalar", values: [true, false] },
};

/** Records applicable to each API family; used by `resolve.ts` when applying wire axes. */
export const API_COMPAT_RECORDS: Readonly<Record<string, readonly CompatRecordName[]>> = {
	"ollama-chat": ["ollama"],
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
