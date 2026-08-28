import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { isKimiModelId } from "@oh-my-pi/pi-catalog/identity";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { $env, logger, parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import { getEnvApiKey } from "../stream";
import type {
	AssistantMessage,
	Context,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, resolveCacheRetention } from "../utils";
import { createAbortSourceTracker } from "../utils/abort";
import { isDemotedThinking, kStreamingLastParseLen } from "../utils/block-symbols";
import { hasVisibleAssistantContent, withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	iterateWithTerminalGrace,
} from "../utils/idle-iterator";
import { OpenAIHttpError, postOpenAIStream } from "../utils/openai-http";
import { notifyProviderResponse } from "../utils/provider-response";
import { callWithCopilotModelRetry } from "../utils/retry";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	flattenExclusiveRequiredRootUnion,
	NO_STRICT,
	normalizeSchemaForMoonshot,
	sanitizeSchemaForGrammar,
	toolWireSchema,
} from "../utils/schema";
import {
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { isForcedToolChoice, mapToOpenAICompletionsToolChoice } from "../utils/tool-choice";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionMessageParam,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
} from "./openai-chat-wire";
import {
	applyOpenAIReasoningEffortFallback,
	clearOpenAIReasoningEffortFallbackState,
	createOpenAIReasoningEffortFallbackKey,
	createOpenAIReasoningEffortFallbackState,
	getOpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallback,
	type OpenAIReasoningEffortFallbackState,
	rememberOpenAIReasoningEffortFallback,
	resolveOpenAIReasoningEffortFallback,
} from "./openai-reasoning-fallback";
import {
	applyChatCompletionsCompatPolicy,
	applyChatCompletionsToolStream,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyOpenAIServiceTier,
	applyOpenRouterReportedCost,
	applyWireModelIdTransform,
	calculateOpenAIUsageAccounting,
	clearOpenAIStrictToolsState,
	createInitialResponsesAssistantMessage,
	createOpenAIStrictToolsState,
	disableStrictToolsForScope,
	getOpenAIPromptCacheKey,
	getOpenAIStrictToolsScope,
	isCompiledGrammarTooLargeStrictError,
	isOpenRouterAnthropicModel,
	isStrictToolsDisabledForScope,
	type OpenAICompatPolicy,
	type OpenAICompletionsParams,
	type OpenAIPromptCacheOptions,
	type OpenAIRequestSetup,
	type OpenAIStrictToolsState,
	parseAzureDeploymentNameMap,
	resolveOpenAICompatPolicy,
	resolveOpenAICompletionsOutputClamp,
	resolveOpenAIOutputTokenParam,
	resolveOpenAIRequestSetup,
	shouldDropAutoToolChoiceForReasoning,
	shouldRetryWithoutStrictTools,
} from "./openai-shared";
import { transformMessages } from "./transform-messages";
import {
	isOpenAICompletionsVisionSupported,
	joinTextWithImagePlaceholder,
	NON_VISION_IMAGE_PLACEHOLDER,
} from "./vision-guard";

export { applyOpenRouterRoutingVariant } from "./openai-shared";

type OpenAICompletionsReasoningField = NonNullable<ResolvedOpenAICompat["reasoningContentField"]>;

type ProviderAttributedChatCompletionChunk = ChatCompletionChunk & {
	provider?: unknown;
};

type OpenAICompletionsChoiceUsage = ChatCompletionChunk.Choice & {
	usage?: unknown;
};

type OpenAICompletionsDeltaWithReasoningDetails = ChatCompletionChunk.Choice["delta"] & {
	reasoning_details?: unknown;
};

type OpenAICompletionsAssistantMessageParam = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: unknown[];
	};

type OpenAICompletionsToolMessageParam = ChatCompletionToolMessageParam & {
	name?: string;
};

type OpenAICompletionsUsageLike = {
	completion_tokens?: unknown;
	prompt_tokens?: unknown;
	cached_tokens?: unknown;
	prompt_cache_hit_tokens?: unknown;
	prompt_cache_miss_tokens?: unknown;
	prompt_tokens_details?: unknown;
	completion_tokens_details?: unknown;
	// Vertex/Gemini reports cache hits here (camelCase) when fronted by an
	// OpenAI-compatible gateway; the OpenAI-shaped cached fields stay absent.
	cachedContentTokenCount?: unknown;
};

type OpenAICompletionsPromptTokenDetails = {
	cached_tokens?: unknown;
	cache_write_tokens?: unknown;
};

type OpenAICompletionsCompletionTokenDetails = {
	reasoning_tokens?: unknown;
};

function firstPositiveNumber(...values: unknown[]): number {
	for (const value of values) {
		if (typeof value === "number" && value > 0) return value;
	}
	return 0;
}

function hasPositiveCacheReadTokenField(rawUsage: object): boolean {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	if (typeof usageLike.cached_tokens === "number" && usageLike.cached_tokens > 0) return true;
	if (typeof usageLike.prompt_cache_hit_tokens === "number" && usageLike.prompt_cache_hit_tokens > 0) return true;
	if (typeof usageLike.cachedContentTokenCount === "number" && usageLike.cachedContentTokenCount > 0) return true;

	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	if (typeof rawPromptTokenDetails !== "object" || rawPromptTokenDetails === null) return false;

	const promptTokenDetails = rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails;
	return typeof promptTokenDetails.cached_tokens === "number" && promptTokenDetails.cached_tokens > 0;
}

/**
 * Normalize tool call ID for Mistral.
 * Mistral requires tool IDs to be exactly 9 alphanumeric characters (a-z, A-Z, 0-9).
 */
function normalizeMistralToolId(id: string, isMistral: boolean): string {
	if (!isMistral) return id;
	// Remove non-alphanumeric characters
	let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// Mistral requires exactly 9 characters
	if (normalized.length < 9) {
		// Pad with deterministic characters based on original ID to ensure matching
		const padding = "ABCDEFGHI";
		normalized = normalized + padding.slice(0, 9 - normalized.length);
	} else if (normalized.length > 9) {
		normalized = normalized.slice(0, 9);
	}
	return normalized;
}
// Direct DeepSeek model ids on NanoGPT are routed via the default tools-capable
// path. We deliberately do NOT append `:tools` here: with `:tools`, NanoGPT
// performs server-side tool-call parsing on the upstream DeepSeek stream and
// 502s with `code: "malformed_tool_call"` on more complex tool schemas (issue
// #1488). The default route forwards `delta.content` (including DSML
// envelope leaks) which `StreamMarkupHealing` heals into a structured call
// client-side.
function resolveOpenAICompletionsRoutingEffort(
	model: Model<"openai-completions">,
	effort: Effort | undefined,
): Effort | undefined {
	if (!effort) return undefined;
	if (model.thinking?.efforts.includes(effort)) return effort;
	const compatMappedEffort = model.compat.reasoningEffortMap?.[effort] as Effort | undefined;
	if (compatMappedEffort && model.thinking?.efforts.includes(compatMappedEffort)) return compatMappedEffort;
	const thinkingMappedEffort = model.thinking?.effortMap?.[effort] as Effort | undefined;
	if (thinkingMappedEffort && model.thinking?.efforts.includes(thinkingMappedEffort)) return thinkingMappedEffort;
	return effort;
}

function resolveOpenAICompletionsModelId(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): string {
	// Effort-tier variants route per request effort (off → bare id, efforts →
	// the thinking backing id); catalog variants (Copilot long-context `-1m`
	// entries) pin via `requestModelId`; everything else serializes `model.id`.
	const requestedEffort =
		options?.reasoning && !options.disableReasoning && model.reasoning ? (options.reasoning as Effort) : undefined;
	const effort = resolveOpenAICompletionsRoutingEffort(model, requestedEffort);
	const wireId = resolveWireModelId(model, effort);
	return applyWireModelIdTransform(wireId, model.compat.wireModelIdMode, options?.openrouterVariant);
}

/**
 * Normalize OpenAI-compatible streaming `delta.content` into plain text.
 * Most providers stream `delta.content` as a string, but some (notably Mistral
 * Medium 3.5 / `mistral-medium-2604`) return an array of typed content parts
 * — e.g. `[{ type: "text", text: "Hello" }]`. Without normalization those
 * parts get string-coerced via `text += array`, producing the literal
 * `[object Object]` sequences observed in issue #911.
 *
 * Returns the joined text. Non-text parts and unknown shapes are skipped so
 * we never emit JS object sigils as visible output.
 */
function normalizeStreamingContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const part of content) {
			if (typeof part === "string") {
				out += part;
			} else if (part && typeof part === "object") {
				const obj = part as { type?: unknown; text?: unknown };
				if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
					out += obj.text;
				}
			}
		}
		return out;
	}
	if (content && typeof content === "object") {
		const obj = content as { type?: unknown; text?: unknown };
		if ((obj.type === undefined || obj.type === "text") && typeof obj.text === "string") {
			return obj.text;
		}
	}
	return "";
}

function serializeToolArguments(value: unknown): string {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return "{}";
		}
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return "{}";
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return JSON.stringify(parsed);
			}
		} catch {}
		return "{}";
	}

	return "{}";
}

function cloneStreamingArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneStreamingArgumentValue);
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return mergeStreamingArgumentObjects(undefined, value as Record<string, unknown>);
	}
	return value;
}

function streamingArgumentValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!streamingArgumentValuesEqual(left[i], right[i])) return false;
		}
		return true;
	}
	if (
		left !== null &&
		typeof left === "object" &&
		!Array.isArray(left) &&
		right !== null &&
		typeof right === "object" &&
		!Array.isArray(right)
	) {
		const leftObject = left as Record<string, unknown>;
		const rightObject = right as Record<string, unknown>;
		let leftKeys = 0;
		for (const key in leftObject) {
			if (!Object.hasOwn(leftObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			leftKeys++;
			if (!Object.hasOwn(rightObject, key) || !streamingArgumentValuesEqual(leftObject[key], rightObject[key])) {
				return false;
			}
		}
		let rightKeys = 0;
		for (const key in rightObject) {
			if (!Object.hasOwn(rightObject, key) || key === "__proto__" || key === "constructor" || key === "prototype")
				continue;
			rightKeys++;
		}
		return leftKeys === rightKeys;
	}
	return false;
}

function streamingArgumentArrayStartsWith(value: unknown[], prefix: unknown[]): boolean {
	if (prefix.length > value.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!streamingArgumentValuesEqual(value[i], prefix[i])) return false;
	}
	return true;
}

function mergeStreamingArgumentArrays(prev: unknown[], fragment: unknown[]): unknown[] {
	if (streamingArgumentArrayStartsWith(fragment, prev)) {
		return fragment.map(cloneStreamingArgumentValue);
	}
	if (streamingArgumentArrayStartsWith(prev, fragment)) {
		return prev.map(cloneStreamingArgumentValue);
	}
	const merged = prev.map(cloneStreamingArgumentValue);
	for (const value of fragment) {
		merged.push(cloneStreamingArgumentValue(value));
	}
	return merged;
}

function mergeStreamingArgumentValues(prev: unknown, fragment: unknown): unknown {
	if (typeof prev === "string" && typeof fragment === "string") {
		return fragment.startsWith(prev) ? fragment : prev + fragment;
	}
	if (Array.isArray(prev) && Array.isArray(fragment)) {
		return mergeStreamingArgumentArrays(prev, fragment);
	}
	if (
		prev !== null &&
		typeof prev === "object" &&
		!Array.isArray(prev) &&
		fragment !== null &&
		typeof fragment === "object" &&
		!Array.isArray(fragment)
	) {
		return mergeStreamingArgumentObjects(prev as Record<string, unknown>, fragment as Record<string, unknown>);
	}
	return cloneStreamingArgumentValue(fragment);
}

function mergeStreamingArgumentObjects(
	prev: Record<string, unknown> | undefined,
	fragment: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (prev) {
		for (const key in prev) {
			if (!Object.hasOwn(prev, key) || key === "__proto__" || key === "constructor" || key === "prototype") continue;
			merged[key] = cloneStreamingArgumentValue(prev[key]);
		}
	}
	for (const key in fragment) {
		if (!Object.hasOwn(fragment, key) || key === "__proto__" || key === "constructor" || key === "prototype")
			continue;
		merged[key] = Object.hasOwn(merged, key)
			? mergeStreamingArgumentValues(merged[key], fragment[key])
			: cloneStreamingArgumentValue(fragment[key]);
	}
	return merged;
}

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some(block => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}
/**
 * Identify "real progress" stream chunks vs. keepalives, role-only preambles,
 * and empty `{choices:[]}` no-ops emitted by some OpenAI-compatible endpoints.
 * Without this filter, every keepalive resets `iterateWithIdleTimeout`'s
 * deadline, so a provider that streams nothing but pings keeps the watchdog
 * asleep indefinitely — observed against z.ai/GLM via OpenRouter where a
 * subagent stalled for hours with no error surfaced.
 *
 * A chunk counts as progress when it carries terminal usage, a finish reason,
 * or a model-produced delta (content / tool calls / reasoning / refusal).
 * Role-only `delta: { role: "assistant" }` preambles do NOT count; we want the
 * (longer) first-event timeout to keep governing until real output appears.
 */
export function isOpenAICompletionsProgressChunk(chunk: unknown): boolean {
	if (!chunk || typeof chunk !== "object") return false;
	const record = chunk as {
		usage?: unknown;
		choices?: ReadonlyArray<{
			finish_reason?: unknown;
			usage?: unknown;
			delta?: {
				content?: unknown;
				tool_calls?: unknown;
				reasoning?: unknown;
				reasoning_content?: unknown;
				reasoning_text?: unknown;
				refusal?: unknown;
			};
		}>;
	};
	if (record.usage) return true;
	const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
	if (!choice) return false;
	if (choice.finish_reason) return true;
	if (choice.usage) return true;
	const delta = choice.delta;
	if (!delta) return false;
	const content = delta.content;
	if (typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0) return true;
	if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
	if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
	if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
	if (typeof delta.reasoning_text === "string" && delta.reasoning_text.length > 0) return true;
	if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
	return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ToolChoice;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Force-disable reasoning where supported, or request the lowest effort on generic effort endpoints. */
	disableReasoning?: boolean;
	serviceTier?: ServiceTier;
	/** @internal True when maxTokens came from the caller, not the model default. */
	maxTokensExplicit?: boolean;
	/**
	 * Routing-variant suffix appended to OpenRouter model IDs when none is
	 * already present (`anthropic/claude-haiku-latest` → `…:nitro`). Common
	 * values: `"nitro"`, `"floor"`, `"online"`, `"exacto"`. Ignored when the
	 * resolved `model.id` already contains a colon-suffix after the last
	 * provider segment (explicit `:nitro` in the selector or a catalog entry
	 * with the variant baked in).
	 */
	openrouterVariant?: string;
	/** Opt-in GPT-5.6+ prompt-cache policy. Unsupported explicit mode fails locally. */
	promptCache?: OpenAIPromptCacheOptions;
}

type AppliedToolStrictMode = "mixed" | "all_strict" | "none";
type ToolStrictModeOverride = Exclude<ResolvedOpenAICompat["toolStrictMode"], "mixed"> | undefined;

type BuiltOpenAICompletionTools = {
	tools: ChatCompletionTool[];
	toolStrictMode: AppliedToolStrictMode;
	/** True when at least one wire tool was sent with `strict: true`. */
	strictToolsApplied: boolean;
};

const OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX = "openai-completions:";

type OpenAICompletionsProviderSessionState = ProviderSessionState &
	OpenAIStrictToolsState &
	OpenAIReasoningEffortFallbackState;

function createOpenAICompletionsProviderSessionState(): OpenAICompletionsProviderSessionState {
	const strictToolsState = createOpenAIStrictToolsState();
	const reasoningEffortFallbackState = createOpenAIReasoningEffortFallbackState();
	const state: OpenAICompletionsProviderSessionState = {
		...strictToolsState,
		...reasoningEffortFallbackState,
		close: () => {
			clearOpenAIStrictToolsState(state);
			clearOpenAIReasoningEffortFallbackState(state);
		},
	};
	return state;
}

function getOpenAICompletionsProviderSessionState(
	model: Model<"openai-completions">,
	baseUrl: string | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): OpenAICompletionsProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = `${OPENAI_COMPLETIONS_PROVIDER_SESSION_STATE_PREFIX}${model.provider}:${baseUrl ?? ""}:${model.id}`;
	const existing = providerSessionState.get(key) as OpenAICompletionsProviderSessionState | undefined;
	if (existing) return existing;
	const created = createOpenAICompletionsProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

// DeepSeek models leak chat-template special tokens (e.g. `<｜tool_calls_begin｜>`,
// `<｜DSML｜tool_calls｜>`) into visible `content` deltas when hosted behind providers
// (such as NVIDIA NIM) that don't strip them server-side. The structured `tool_calls`
// payload is still emitted correctly — we only need to filter the leaked markers from
// user-visible text. Tokens use either fullwidth pipes (｜, U+FF5C) or ASCII pipes.
// Body is restricted to identifier-like chars (with the DeepSeek tokenizer's `▁`),
// capped at a sane length to avoid swallowing legitimate angle-bracket text.
const DEEPSEEK_SPECIAL_TOKEN_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/g;
const DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX = /^\s*<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>/;
const DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX = /<(?:｜|\|)[A-Za-z0-9_.｜|▁]{1,64}(?:｜|\|)>\s*$/;
const DEEPSEEK_OPEN_DELIMS = ["<｜", "<|"] as const;

function stripDeepseekSpecialTokens(text: string): string {
	const stripped = text.replace(DEEPSEEK_SPECIAL_TOKEN_REGEX, "");
	if (stripped === text) return text;

	let normalized = stripped;
	if (DEEPSEEK_SPECIAL_TOKEN_AT_START_REGEX.test(text)) normalized = normalized.replace(/^\s+/u, "");
	if (DEEPSEEK_SPECIAL_TOKEN_AT_END_REGEX.test(text)) normalized = normalized.replace(/\s+$/u, "");
	return normalized;
}

// Find a trailing partial `<｜...` (or `<|...`) that has not yet been closed by a
// matching `｜>`/`|>`, so it can be held back until the next chunk arrives. A solo
// trailing `<` is also held in case it is the start of a new token.
function getTrailingPartialDeepseekToken(text: string): string {
	let bestIdx = -1;
	for (const delim of DEEPSEEK_OPEN_DELIMS) {
		const idx = text.lastIndexOf(delim);
		if (idx > bestIdx) bestIdx = idx;
	}
	if (bestIdx === -1) {
		return text.endsWith("<") ? "<" : "";
	}
	const tail = text.slice(bestIdx);
	if (tail.includes("｜>") || tail.includes("|>")) return "";
	// Cap the held-back length so a stray `<｜` in normal prose can't grow unboundedly.
	if (tail.length > 256) return "";
	return tail;
}
const OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE =
	"OpenAI completions stream timed out while waiting for the first event";
// How long to keep draining the stream after a `finish_reason` chunk arrived.
// Compliant hosts follow it (almost) immediately with an optional usage-only
// chunk and the `[DONE]` sentinel, so the window only ever elapses on hosts
// that hold the connection open after the response logically completed —
// without it the turn parks on `iterator.next()` until the idle watchdog
// converts the already-successful response into a timeout error.
const OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS = 2_500;

const streamOpenAICompletionsOnce = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const policy = resolveOpenAICompatForRequest(model, options);

		const output: AssistantMessage = createInitialResponsesAssistantMessage(model.api, model.provider, model.id);
		let rawRequestDump: RawHttpRequestDump | undefined;
		const abortTracker = createAbortSourceTracker(options?.signal);
		const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
			OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
		);
		const { requestAbortController, requestSignal } = abortTracker;
		const onSseEvent = options?.onSseEvent;
		// Track the OpenAI `[DONE]` sentinel independently of `onSseEvent`: it is
		// the streaming protocol's terminal signal, so a stream that ends with it
		// completed by server agreement even when no `finish_reason` chunk arrived.
		let sawDoneSentinel = false;
		const rawSseObserver = (event: RawSseEvent) => {
			if (event.data === "[DONE]") sawDoneSentinel = true;
			if (onSseEvent) {
				if (!event.event && event.data && event.data !== "[DONE]") {
					try {
						const parsed = JSON.parse(event.data);
						const resolvedEvent =
							typeof parsed.type === "string"
								? parsed.type
								: typeof parsed.object === "string"
									? parsed.object
									: null;
						if (resolvedEvent) {
							event.event = resolvedEvent;
							event.raw = [`event: ${resolvedEvent}`, ...event.raw];
						}
					} catch {}
				}
				onSseEvent(event, model);
			}
		};
		// Assigned once the block helpers exist (they are scoped to the `try`);
		// the catch handler uses it to close open blocks before emitting the
		// terminal error so both exit paths obey the same block lifecycle.
		let finishOpenBlocksOnError: () => void = () => {};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const idleTimeoutFallbackMs = model.compat.streamIdleTimeoutMs;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs(idleTimeoutFallbackMs);
			const firstEventTimeoutMs =
				options?.streamFirstEventTimeoutMs ??
				getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs, model.compat.streamFirstEventTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const { copilotPremiumRequests, baseUrl, headers, query, requestHeaders } = createRequestSetup(
				model,
				context,
				apiKey,
				options?.headers,
				options?.initiatorOverride,
				getOpenAIPromptCacheKey(options),
			);
			const premiumRequestsTotal = copilotPremiumRequests;
			let appliedStrictTools = false;
			const requestReasoningEffortFallbacks = new Map<string, OpenAIReasoningEffortFallback>();
			const attemptedReasoningEffortFallbacks = new Set<string>();
			let activeReasoningEffortFallbackKey: string | undefined;
			let activeRequestParams: OpenAICompletionsParams | undefined;
			const providerSessionState = getOpenAICompletionsProviderSessionState(
				model,
				baseUrl,
				options?.providerSessionState,
			);
			const strictToolsScope = getOpenAIStrictToolsScope(model, baseUrl);
			let disableStrictTools = isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
			const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");
			const completionsUrl = query
				? `${trimmedBaseUrl}/chat/completions?${new URLSearchParams(query)}`
				: `${trimmedBaseUrl}/chat/completions`;
			const createCompletionsStream = async (toolStrictModeOverride?: ToolStrictModeOverride) => {
				const effectiveToolStrictModeOverride = disableStrictTools ? "none" : toolStrictModeOverride;
				let { params, strictToolsApplied } = buildParams(model, context, options, effectiveToolStrictModeOverride);
				appliedStrictTools = strictToolsApplied;
				const reasoningEffortFallbackKey = createOpenAIReasoningEffortFallbackKey(
					"chat-completions",
					trimmedBaseUrl,
					params.model,
				);
				const requestReasoningEffortFallback = requestReasoningEffortFallbacks.has(reasoningEffortFallbackKey)
					? requestReasoningEffortFallbacks.get(reasoningEffortFallbackKey)
					: getOpenAIReasoningEffortFallback(providerSessionState, reasoningEffortFallbackKey);
				if (requestReasoningEffortFallback !== undefined) {
					applyOpenAIReasoningEffortFallback(params, requestReasoningEffortFallback);
				}
				activeReasoningEffortFallbackKey = reasoningEffortFallbackKey;
				const replacedParams = await options?.onPayload?.(params, model);
				if (replacedParams !== undefined) params = replacedParams as typeof params;
				activeRequestParams = params;
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: completionsUrl,
					headers: requestHeaders,
					body: params,
				};
				let requestTimeout: NodeJS.Timeout | undefined;
				if (requestTimeoutMs !== undefined) {
					requestTimeout = setTimeout(
						() => abortTracker.abortLocally(firstEventTimeoutAbortError),
						requestTimeoutMs,
					);
				}
				try {
					const headersWithTimeout = { ...headers };
					if (requestTimeoutMs !== undefined) {
						headersWithTimeout["X-Stainless-Timeout"] = Math.floor(requestTimeoutMs / 1000).toString();
					}
					const { events, response, requestId } = await postOpenAIStream<ChatCompletionChunk>({
						url: completionsUrl,
						headers: headersWithTimeout,
						body: params,
						signal: requestSignal,
						fetch: options?.fetch,
						// Transient 408/429/5xx get Retry-After-aware transport retries.
						// The first-event watchdog above aborts `requestSignal`, which
						// bounds every attempt and backoff sleep — retries cannot
						// extend the deadline.
						onSseEvent: rawSseObserver,
					});
					await notifyProviderResponse(options, response, model, requestId);
					return events;
				} finally {
					// Headers arrived (or the request failed); from here the
					// first-event deadline is enforced by `iterateWithIdleTimeout`.
					if (requestTimeout !== undefined) clearTimeout(requestTimeout);
				}
			};
			let openaiStream: AsyncIterable<ChatCompletionChunk>;
			try {
				openaiStream = await callWithCopilotModelRetry(() => createCompletionsStream(), {
					provider: model.provider,
					signal: requestSignal,
				});
			} catch (error) {
				const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
				const reasoningEffortFallback =
					activeReasoningEffortFallbackKey && activeRequestParams && !requestSignal.aborted
						? resolveOpenAIReasoningEffortFallback(error, capturedErrorResponse, activeRequestParams, {
								explicitDisable: options?.disableReasoning === true && options.reasoning === undefined,
							})
						: undefined;
				if (reasoningEffortFallback !== undefined && activeReasoningEffortFallbackKey) {
					const retryMarker = `${activeReasoningEffortFallbackKey}:${String(reasoningEffortFallback)}`;
					if (attemptedReasoningEffortFallbacks.has(retryMarker)) throw error;
					attemptedReasoningEffortFallbacks.add(retryMarker);
					requestReasoningEffortFallbacks.set(activeReasoningEffortFallbackKey, reasoningEffortFallback);
					openaiStream = await createCompletionsStream();
					rememberOpenAIReasoningEffortFallback(
						providerSessionState,
						activeReasoningEffortFallbackKey,
						reasoningEffortFallback,
					);
				} else if (
					isOpenRouterAnthropicModel(model) &&
					!disableStrictTools &&
					isCompiledGrammarTooLargeStrictError(error, capturedErrorResponse)
				) {
					disableStrictToolsForScope(providerSessionState, strictToolsScope);
					disableStrictTools = true;
					openaiStream = await createCompletionsStream("none");
				} else {
					if (
						!shouldRetryWithoutStrictTools(error, capturedErrorResponse, {
							model,
							strictToolsApplied: appliedStrictTools,
							tools: context.tools,
						})
					) {
						throw error;
					}
					// Remember the rejection for the rest of the session so every
					// subsequent request doesn't pay a strict-400 + retry round-trip.
					disableStrictToolsForScope(providerSessionState, strictToolsScope);
					disableStrictTools = true;
					openaiStream = await createCompletionsStream("none");
				}
			}
			if (premiumRequestsTotal !== undefined) {
				output.usage.premiumRequests = premiumRequestsTotal;
			}
			stream.push({ type: "start", partial: output });

			// Some OpenAI-compatible DeepSeek hosts (including NVIDIA NIM and DeepSeek's
			// native API) leak chat-template tool-call markers in `delta.content` even
			// though tool calls are also surfaced structurally. Strip the leaked markers
			// so users don't see raw `<｜...｜>` tokens.
			const stripDeepseekChatTemplateTokens = policy.stream.stripSpecialTokens === "deepseek";
			type ToolCallStreamBlock = ToolCall & {
				partialArgs?: string | Record<string, unknown>;
				streamIndex?: number;
				[kStreamingLastParseLen]?: number;
			};
			type OpenAIStreamBlock = TextContent | ThinkingContent | ToolCallStreamBlock;
			const pendingToolCallBlocks: ToolCallStreamBlock[] = [];
			const toolCallBlockByIndex = new Map<number, ToolCallStreamBlock>();
			// Blocks born from an unkeyed multi-entry `tool_calls` array (no `id`,
			// no `index`), tracked by array offset so continuation chunks that omit
			// the entry name still route back to the sibling created earlier
			// instead of collapsing onto `currentBlock`.
			const unkeyedBatchBlocks: (ToolCallStreamBlock | undefined)[] = [];
			const clearUnkeyedBatchSlot = (block: ToolCallStreamBlock): void => {
				for (let index = 0; index < unkeyedBatchBlocks.length; index++) {
					if (unkeyedBatchBlocks[index] === block) unkeyedBatchBlocks[index] = undefined;
				}
			};
			let currentBlock: OpenAIStreamBlock | undefined;
			const blockIndex = (block: OpenAIStreamBlock | undefined): number => {
				if (!block) return Math.max(0, output.content.length - 1);
				return output.content.indexOf(block);
			};
			const finishToolCallBlock = (block: ToolCallStreamBlock): void => {
				if (block.partialArgs === undefined) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				// Object-shaped `partialArgs` came from MiniMax-compatible hosts that stream
				// `function.arguments` as an object. The per-chunk handler holds them with an
				// empty wire delta (see the object branch below) because emitting each chunk's
				// `JSON.stringify(rawArgs)` would feed concat-based downstream consumers
				// (proxy.ts, openai-chat-server, openai-responses-server, anthropic-messages-server)
				// an invalid concatenation like `{"input":"a"}{"input":"b"}`. Flush the final
				// merged object as one concat-safe delta now so those consumers reconstruct the
				// args correctly before observing `toolcall_end`.
				if (typeof block.partialArgs === "object" && !Array.isArray(block.partialArgs)) {
					const fullJson = JSON.stringify(block.partialArgs);
					if (fullJson.length > 0 && fullJson !== "{}") {
						stream.push({ type: "toolcall_delta", contentIndex, delta: fullJson, partial: output });
					}
				}
				block.arguments =
					typeof block.partialArgs === "string" ? parseStreamingJson(block.partialArgs) : block.partialArgs;
				delete block.partialArgs;
				if (block.streamIndex !== undefined) {
					toolCallBlockByIndex.delete(block.streamIndex);
					delete block.streamIndex;
				}
				const pendingIndex = pendingToolCallBlocks.indexOf(block);
				if (pendingIndex >= 0) pendingToolCallBlocks.splice(pendingIndex, 1);
				clearUnkeyedBatchSlot(block);
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			};
			const finishPendingToolCallBlocks = (): void => {
				for (const block of [...pendingToolCallBlocks]) {
					finishToolCallBlock(block);
				}
			};
			const finishCurrentBlock = (block: OpenAIStreamBlock | undefined): void => {
				if (!block) return;
				const contentIndex = blockIndex(block);
				if (contentIndex < 0) return;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
					return;
				}
				if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
					return;
				}
				finishToolCallBlock(block);
			};
			finishOpenBlocksOnError = () => {
				if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
				finishPendingToolCallBlocks();
			};
			const appendText = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				text: string,
			): void => {
				if (currentBlock?.type !== "text") {
					// Leave toolCall blocks pending across text transitions: chunks after
					// the first typically carry only `index`, so a finished (de-registered)
					// call would be reborn as a nameless phantom block when its arguments
					// resume. The stream-end sweep finalizes pending calls.
					if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
					currentBlock = { type: "text", text: "" };
					message.content.push(currentBlock);
					eventStream.push({ type: "text_start", contentIndex: blockIndex(currentBlock), partial: message });
				}
				currentBlock.text += text;
				eventStream.push({
					type: "text_delta",
					contentIndex: blockIndex(currentBlock),
					delta: text,
					partial: message,
				});
			};
			const appendThinking = (
				message: AssistantMessage,
				eventStream: AssistantMessageEventStream,
				thinking: string,
				signature?: string,
			): void => {
				if (
					currentBlock?.type !== "thinking" ||
					(signature !== undefined && currentBlock.thinkingSignature !== signature)
				) {
					// Same as appendText: leave toolCall blocks pending so index-only
					// continuation deltas can still find them.
					if (currentBlock?.type !== "toolCall") finishCurrentBlock(currentBlock);
					currentBlock = { type: "thinking", thinking: "", thinkingSignature: signature };
					message.content.push(currentBlock);
					eventStream.push({
						type: "thinking_start",
						contentIndex: blockIndex(currentBlock),
						partial: message,
					});
				}
				if (signature !== undefined && !currentBlock.thinkingSignature) {
					currentBlock.thinkingSignature = signature;
				}
				currentBlock.thinking += thinking;
				eventStream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(currentBlock),
					delta: thinking,
					partial: message,
				});
			};

			const appendTextDelta = (text: string): void => {
				if (!text) return;
				if (!firstTokenTime) firstTokenTime = performance.now();
				appendText(output, stream, text);
			};
			// Tracks the last full cumulative reasoning snapshot per signature (the
			// reasoning field name) so dedup survives block transitions. Required
			// for MiniMax-M3: once `</think>` and visible text arrive, currentBlock
			// flips to "text", but later chunks keep carrying the same cumulative
			// `reasoning_content` snapshot. Without an external tracker the guard
			// below misses and the snapshot gets re-emitted as a fresh thinking
			// block after the answer has started.
			const lastCumulativeReasoningBySignature = new Map<string, string>();
			const appendThinkingDelta = (
				thinking: string,
				signature?: string,
				source: "delta" | "cumulative" = "delta",
			): void => {
				if (!thinking) return;
				let emittedThinking = thinking;
				if (source === "cumulative") {
					const key = signature ?? "";
					const lastSnapshot = lastCumulativeReasoningBySignature.get(key) ?? "";
					if (thinking.startsWith(lastSnapshot)) {
						emittedThinking = thinking.slice(lastSnapshot.length);
					}
					lastCumulativeReasoningBySignature.set(key, thinking);
					if (!emittedThinking) return;
				}
				if (!firstTokenTime) firstTokenTime = performance.now();
				appendThinking(output, stream, emittedThinking, signature);
			};

			let deepseekStripBuffer = "";
			const flushDeepseekStripBuffer = (final: boolean): void => {
				if (deepseekStripBuffer.length === 0) return;
				let flushable: string;
				if (final) {
					flushable = deepseekStripBuffer;
					deepseekStripBuffer = "";
				} else {
					const trailing = getTrailingPartialDeepseekToken(deepseekStripBuffer);
					flushable = deepseekStripBuffer.slice(0, deepseekStripBuffer.length - trailing.length);
					deepseekStripBuffer = trailing;
				}
				const stripped = stripDeepseekSpecialTokens(flushable);
				if (stripped && (stripped === flushable || stripped.trim().length > 0)) appendTextDelta(stripped);
			};
			const appendProcessedText = (processedText: string): void => {
				if (processedText.length === 0) return;
				if (stripDeepseekChatTemplateTokens) {
					deepseekStripBuffer += processedText;
					flushDeepseekStripBuffer(false);
				} else {
					appendTextDelta(processedText);
				}
			};
			const streamMarkupHealingPattern = policy.stream.markupHealingPattern;
			const streamMarkupHealing = streamMarkupHealingPattern
				? new StreamMarkupHealing({ pattern: streamMarkupHealingPattern })
				: undefined;
			const explicitReasoningDeltasMayBeCumulative = policy.stream.reasoningDeltasMayBeCumulative;
			let suppressHealedThinking = false;
			let healedToolCallEmitted = false;
			const emitHealedToolCall = (call: HealedToolCall): void => {
				finishCurrentBlock(currentBlock);
				const block: ToolCall & { partialArgs: string } = {
					type: "toolCall",
					id: call.id,
					name: call.name,
					arguments: {},
					partialArgs: call.arguments,
				};
				block.arguments = parseStreamingJson(call.arguments);
				currentBlock = block;
				output.content.push(block);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(block), partial: output });
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(block),
					delta: call.arguments,
					partial: output,
				});
				finishCurrentBlock(block);
				currentBlock = undefined;
				healedToolCallEmitted = true;
			};
			const emitHealingEvent = (event: StreamMarkupHealingEvent, suppressThinking: boolean): void => {
				if (event.type === "text") {
					appendProcessedText(event.text);
				} else if (event.type === "thinking") {
					if (!suppressThinking) appendThinkingDelta(event.thinking);
				} else {
					emitHealedToolCall(event.call);
				}
			};
			const flushHealedToolCalls = (): void => {
				if (!streamMarkupHealing) return;
				const calls = streamMarkupHealing.drainCompleted();
				for (const call of calls) emitHealedToolCall(call);
			};

			// Terminal-chunk bookkeeping for the post-finish grace window below.
			// `streamFinishedAt` flips when a chunk carries `finish_reason`;
			// `sawUsagePayload` flips when a usage payload was parsed. Some
			// OpenAI-compatible servers send basic usage with `finish_reason` and
			// cache-read details in a trailing usage-only chunk, so only the
			// no-choice terminal path may break while those details are pending.
			let streamFinishedAt: number | undefined;
			let sawUsagePayload = false;
			let awaitTrailingUsageDetails = false;
			const applyUsagePayload = (rawUsage: object): void => {
				output.usage = parseChunkUsage(rawUsage, model, premiumRequestsTotal);
				sawUsagePayload = true;
				awaitTrailingUsageDetails = !hasPositiveCacheReadTokenField(rawUsage);
			};
			const timedOpenaiStream = iterateWithIdleTimeout(openaiStream, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				firstItemErrorMessage: OPENAI_COMPLETIONS_FIRST_EVENT_TIMEOUT_MESSAGE,
				errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				onIdle: () => requestAbortController.abort(),
				onFirstItemTimeout: () => abortTracker.abortLocally(firstEventTimeoutAbortError),
				abortSignal: options?.signal,
				isProgressItem: isOpenAICompletionsProgressChunk,
			});
			const terminalAwareStream = iterateWithTerminalGrace(timedOpenaiStream, {
				finishedAtMs: () => streamFinishedAt,
				graceMs: OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS,
				// The inner idle-timeout generator is parked mid-`next()` when the
				// grace window closes, so abort the transport to settle that read
				// and release the socket immediately (a queued `.return()` alone
				// would wait on the never-arriving next chunk).
				onGraceEnd: () => requestAbortController.abort(),
			});
			for await (const chunk of terminalAwareStream) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
				// and each chunk in a streamed completion carries the same id.
				output.responseId ||= chunk.id;

				// Aggregators (OpenRouter, Vercel AI Gateway, …) report the upstream
				// provider that actually served the request via a top-level `provider`
				// field present on every chunk. Capture the first non-empty value so
				// callers can attribute routing without re-parsing the raw stream.
				if (!output.upstreamProvider) {
					const upstreamProvider = (chunk as ProviderAttributedChatCompletionChunk).provider;
					output.upstreamProvider =
						typeof upstreamProvider === "string" && upstreamProvider.length > 0 ? upstreamProvider : undefined;
				}

				if (chunk.usage) {
					applyUsagePayload(chunk.usage);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) {
					// Trailing usage-only chunk (`stream_options.include_usage`) after
					// `finish_reason`: the response is complete — stop pulling instead
					// of waiting for `[DONE]`/close from hosts that never send either.
					if (streamFinishedAt !== undefined && sawUsagePayload) break;
					continue;
				}

				if (!chunk.usage) {
					const choiceUsage = (choice as OpenAICompletionsChoiceUsage).usage;
					if (typeof choiceUsage === "object" && choiceUsage !== null) {
						applyUsagePayload(choiceUsage);
					}
				}

				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					streamFinishedAt ??= Date.now();
				}

				if (choice.delta) {
					// Some endpoints return reasoning in reasoning_content (llama.cpp),
					// or reasoning (other openai compatible endpoints). Use the first
					// non-empty reasoning field to avoid duplication when a chunk carries
					// multiple aliases for the same reasoning text.
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaRecord = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | undefined;
					let foundReasoningDelta = "";
					for (const field of reasoningFields) {
						const reasoningDelta = deltaRecord[field];
						if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
							foundReasoningField = field;
							foundReasoningDelta = reasoningDelta;
							break;
						}
					}

					if (foundReasoningField) {
						appendThinkingDelta(
							foundReasoningDelta,
							foundReasoningField,
							explicitReasoningDeltasMayBeCumulative ? "cumulative" : "delta",
						);
						suppressHealedThinking = true;
					}

					const normalizedDeltaText = normalizeStreamingContentText(choice.delta.content);
					if (normalizedDeltaText.length > 0) {
						if (!firstTokenTime) firstTokenTime = performance.now();
						const hasStructuredToolCalls =
							Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0;

						if (streamMarkupHealing) {
							const healingEvents = hasStructuredToolCalls
								? streamMarkupHealing.feedEventsWithoutCalls(normalizedDeltaText)
								: streamMarkupHealing.feedEvents(normalizedDeltaText);
							for (const event of healingEvents) {
								emitHealingEvent(event, suppressHealedThinking);
							}
						} else {
							appendProcessedText(normalizedDeltaText);
						}
					}

					if (choice?.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
						const toolCalls = choice.delta.tool_calls;
						for (let toolCallOffset = 0; toolCallOffset < toolCalls.length; toolCallOffset++) {
							const toolCall = toolCalls[toolCallOffset]!;
							const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
							const incomingName = toolCall.function?.name || "";
							// Multi-entry `tool_calls` arrays without `id`/`index` — either the
							// opening chunk that carries per-entry names, or a continuation whose
							// entries are argument-only. Either way, route by array offset so
							// sibling calls stay isolated.
							const unkeyedBatchedArrayEntry = toolCalls.length > 1 && streamIndex === undefined && !toolCall.id;
							let block = streamIndex !== undefined ? toolCallBlockByIndex.get(streamIndex) : undefined;
							if (!block && toolCall.id) {
								block = pendingToolCallBlocks.find(candidate => candidate.id === toolCall.id);
							}
							if (!block && unkeyedBatchedArrayEntry) {
								const offsetBlock = unkeyedBatchBlocks[toolCallOffset];
								if (offsetBlock && offsetBlock.partialArgs !== undefined) block = offsetBlock;
							}
							if (
								!block &&
								!unkeyedBatchedArrayEntry &&
								currentBlock?.type === "toolCall" &&
								(!toolCall.id || currentBlock.id === toolCall.id)
							) {
								block = currentBlock;
							}

							if (!block) {
								if (currentBlock?.type !== "toolCall") {
									finishCurrentBlock(currentBlock);
								}
								block = {
									type: "toolCall",
									id: toolCall.id || "",
									name: incomingName,
									arguments: {},
									partialArgs: "",
									streamIndex,
								};
								if (streamIndex !== undefined) toolCallBlockByIndex.set(streamIndex, block);
								pendingToolCallBlocks.push(block);
								currentBlock = block;
								output.content.push(block);
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(block),
									partial: output,
								});
								if (unkeyedBatchedArrayEntry) unkeyedBatchBlocks[toolCallOffset] = block;
							} else {
								// Resuming a pending call after interleaved text/thinking:
								// close the text/thinking block we drifted into.
								if (currentBlock !== block && currentBlock && currentBlock.type !== "toolCall") {
									finishCurrentBlock(currentBlock);
								}
								currentBlock = block;
								if (streamIndex !== undefined && block.streamIndex === undefined) {
									block.streamIndex = streamIndex;
									toolCallBlockByIndex.set(streamIndex, block);
								}
							}

							if (toolCall.id) block.id = toolCall.id;
							if (incomingName) block.name = incomingName;
							let delta = "";
							// The OpenAI SDK types `function.arguments` as a JSON string, but MiniMax-compatible
							// hosts stream a fully-formed object instead. Model both shapes so the branches below
							// narrow honestly rather than widening through `unknown`.
							const rawArgs = toolCall.function?.arguments as string | Record<string, unknown> | undefined;
							if (typeof rawArgs === "string") {
								if (rawArgs.length > 0) {
									delta = rawArgs;
									const prev = typeof block.partialArgs === "string" ? block.partialArgs : "";
									block.partialArgs = prev + rawArgs;
									const throttled = parseStreamingJsonThrottled(
										block.partialArgs,
										block[kStreamingLastParseLen] ?? 0,
									);
									if (throttled) {
										block.arguments = throttled.value;
										block[kStreamingLastParseLen] = throttled.parsedLen;
									}
								}
							} else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
								// MiniMax-compatible hosts stream `function.arguments` as an object instead of the
								// OpenAI JSON-string contract. Most chunks carry the complete object in one delta,
								// but cannot rely on that: replacing per-chunk drops earlier keys (and earlier
								// string content for the same key) when the host fragments the args across deltas.
								// Deep-merge into the accumulated object. Strings and arrays detect
								// cumulative-vs-delta semantics by prefix, nested objects merge by key, and
								// prototype-polluting keys are ignored before storing or comparing values.
								//
								// `delta` stays empty here: emitting `JSON.stringify(rawArgs)` per chunk feeds
								// downstream concat-based accumulators (proxy.ts, openai-chat-server,
								// openai-responses-server, anthropic-messages-server) an invalid sequence like
								// `{"input":"a"}{"input":"b"}`. The merged object is flushed as a single
								// concat-safe delta in `finishToolCallBlock` before `toolcall_end` instead.
								const prev =
									block.partialArgs !== null &&
									typeof block.partialArgs === "object" &&
									!Array.isArray(block.partialArgs)
										? (block.partialArgs as Record<string, unknown>)
										: undefined;
								const merged = mergeStreamingArgumentObjects(prev, rawArgs);
								block.partialArgs = merged;
								block.arguments = merged;
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(block),
								delta,
								partial: output,
							});
						}
					}

					const reasoningDetails = (choice.delta as OpenAICompletionsDeltaWithReasoningDetails).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!detail || typeof detail !== "object") continue;
							const detailObject = detail as { type?: unknown; id?: unknown; data?: unknown };
							if (detailObject.type === "reasoning.encrypted" && detailObject.id && detailObject.data) {
								const matchingToolCall = output.content.find(
									b => b.type === "toolCall" && b.id === detailObject.id,
								) as ToolCall | undefined;
								if (matchingToolCall) {
									matchingToolCall.thoughtSignature = JSON.stringify(detailObject);
								}
							}
						}
					}
				}

				// If usage arrived on the finish chunk without cache-read fields,
				// keep draining through the grace window for vLLM-style trailing
				// usage details instead of finalizing the incomplete accounting.
				if (streamFinishedAt !== undefined && sawUsagePayload && !awaitTrailingUsageDetails) break;
			}

			if (streamMarkupHealing) {
				for (const event of streamMarkupHealing.flushEvents()) {
					emitHealingEvent(event, suppressHealedThinking);
				}
				flushHealedToolCalls();
				if (healedToolCallEmitted && output.stopReason === "stop") {
					// Hosts that leak tool-call templates often still report
					// `finish_reason: stop` for the surrounding turn. Promote
					// only that natural-completion finish — leave `error`,
					// `length`, `aborted`, etc. untouched.
					output.stopReason = "toolUse";
				}
			}

			if (stripDeepseekChatTemplateTokens) {
				flushDeepseekStripBuffer(true);
			}

			// Detect premature stream closure before the normal block-finalization
			// sweep. Throwing after that sweep would make the error handler emit a
			// second text_end/thinking_end for the same partial block.
			//
			// Only a genuine truncation — transport EOF with neither a
			// `finish_reason` chunk nor the `[DONE]` sentinel — is incomplete. A
			// stream terminated by `[DONE]` completed by server agreement; some
			// OpenAI-compatible hosts omit or `null` the `finish_reason` and rely on
			// `[DONE]` alone, so finalize those as the default `stop`
			// (mapStopReason(null)) instead of surfacing a false incomplete-stream
			// error and retrying every turn.
			if (streamFinishedAt === undefined && !sawDoneSentinel && output.content.length > 0) {
				throw new AIError.ProviderResponseError(
					"OpenAI completions stream closed before a finish_reason was received",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}

			if (currentBlock?.type === "toolCall") {
				finishPendingToolCallBlocks();
			} else {
				finishCurrentBlock(currentBlock);
				finishPendingToolCallBlocks();
			}

			// Some OpenAI-compatible hosts stream structured `tool_calls` but report
			// `finish_reason: "stop"` instead of `"tool_calls"`. In the OpenAI contract a
			// tool call always means "execute and continue", so promote that
			// natural-completion finish to `toolUse` whenever the turn produced tool-call
			// blocks — the agent loop gates execution on the stop reason. `error`,
			// `length`, and `aborted` are intentionally left untouched. (Anthropic's
			// distinct `end_turn`-with-tool-calls "abandon" semantics live in its own
			// provider and correctly keep `stop`.)
			if (output.stopReason === "stop" && output.content.some(b => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			}

			if (
				policy.stream.emptyLengthFinishIsContextError &&
				output.stopReason === "length" &&
				!hasVisibleAssistantContent(output)
			) {
				output.stopReason = "error";
				output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
			}
			const localAbortReason = abortTracker.getLocalAbortReason();
			if (localAbortReason) {
				throw localAbortReason;
			}
			if (abortTracker.wasCallerAbort()) {
				throw new AIError.AbortError();
			}

			if (output.stopReason === "aborted") {
				throw new AIError.AbortError();
			}
			if (output.stopReason === "error") {
				throw new AIError.ProviderResponseError(output.errorMessage || "Provider returned an error stop reason", {
					provider: model.provider,
					kind: "runtime",
				});
			}

			output.errorMessage = undefined;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Close open blocks first so consumers tracking text_/thinking_/toolcall_
			// lifecycles never see orphaned starts on the error path. Best-effort: a
			// throw here must not prevent the terminal error event below.
			try {
				finishOpenBlocksOnError();
			} catch {}
			const capturedErrorResponse = error instanceof OpenAIHttpError ? error.captured : undefined;
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker,
				rawRequestDump,
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			// Some providers via OpenRouter include extra details here.
			const rawMetadata = (error as { error?: { metadata?: { raw?: string } } })?.error?.metadata?.raw;
			if (rawMetadata) output.errorMessage += `\n${rawMetadata}`;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Retries benign empty completions and transient provider failures only before
 * assistant output commits the attempt.
 */
export const streamOpenAICompletions: StreamFunction<"openai-completions"> = (model, context, options) =>
	withReplaySafeStreamRetry(model, context, options, streamOpenAICompletionsOnce, {
		retryEmptyCompletion: true,
		retryProviderErrors: true,
		maxProviderErrorRetries: 1,
	});

function createRequestSetup(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
	initiatorOverride?: MessageAttribution,
	promptCacheSessionId?: string,
): OpenAIRequestSetup & { baseUrl: string } {
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "2024-10-21";
	const deploymentName = parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(model.id) ?? model.id;
	const setup = resolveOpenAIRequestSetup(model, {
		apiKey,
		extraHeaders,
		initiatorOverride,
		promptCacheSessionId,
		messages: context.messages,
		defaultBaseUrl: "https://api.openai.com/v1",
		// Provider auth/header overlay: Kimi-code hosts require shared client
		// attribution headers prepended before caller headers. Kept here (not in
		// the shared helper) because it is provider-specific request setup.
		prependHeaders: model.provider === "kimi-code" ? getKimiCommonHeaders : undefined,
		alibabaCodingPlanAuth: true,
		azureChatCompletions: { apiVersion, deploymentName },
	});
	if (!setup.baseUrl) {
		throw new AIError.ConfigurationError("OpenAI request setup did not resolve a base URL");
	}
	return setup as OpenAIRequestSetup & { baseUrl: string };
}

function resolveOpenAICompatForRequest(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): OpenAICompatPolicy {
	return resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: mapToOpenAICompletionsToolChoice(options?.toolChoice),
	});
}

function dropOpenRouterKimiForcedToolReasoning(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	policy: OpenAICompatPolicy,
): void {
	if (
		policy.reasoning.disableReason === "forced-tool-choice" &&
		policy.reasoning.disableMode === "openrouter-enabled-false" &&
		policy.compat.isOpenRouterHost &&
		isKimiModelId(model.id)
	) {
		delete params.reasoning;
	}
}

function hasActiveNativeKimiK3Reasoning(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): boolean {
	if (model.provider !== "kimi-code" || model.id.toLowerCase() !== "k3" || !model.reasoning) return false;
	if (options?.reasoning === undefined || options.disableReasoning) return false;
	try {
		const url = new URL(model.baseUrl);
		return url.hostname === "api.kimi.com" && (url.pathname === "/coding" || url.pathname.startsWith("/coding/"));
	} catch {
		return false;
	}
}

function isChatCompletionsPromptCacheableContentBlock(
	block: unknown,
): block is { type: "text" | "image_url" | "input_audio" | "file"; prompt_cache_breakpoint?: { mode: "explicit" } } {
	if (typeof block !== "object" || block === null || !("type" in block)) return false;
	return block.type === "text" || block.type === "image_url" || block.type === "input_audio" || block.type === "file";
}

function markLatestStableChatCompletionsCacheBreakpoint(messages: ChatCompletionMessageParam[]): boolean {
	let latestInputMessage = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "developer") {
			latestInputMessage = i;
			break;
		}
	}
	if (latestInputMessage <= 0) return false;

	for (let i = latestInputMessage - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" && message.role !== "developer" && message.role !== "system") continue;
		if (typeof message.content === "string") {
			messages[i] = {
				...message,
				content: [{ type: "text", text: message.content, prompt_cache_breakpoint: { mode: "explicit" } }],
			};
			return true;
		}
		for (let j = message.content.length - 1; j >= 0; j--) {
			const block = message.content[j];
			if (!isChatCompletionsPromptCacheableContentBlock(block)) continue;
			Object.assign(block, { prompt_cache_breakpoint: { mode: "explicit" } });
			return true;
		}
	}
	return false;
}

function applyOpenAIChatCompletionsPromptCachePolicy(
	params: OpenAICompletionsParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): void {
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	if (model.provider === "kimi-code" && promptCacheKey !== undefined) {
		params.prompt_cache_key = promptCacheKey;
	}

	const promptCache = options?.promptCache;
	if (!promptCache || resolveCacheRetention(options?.cacheRetention) === "none") return;
	if (!model.compat.supportsPromptCacheBreakpoints) {
		if (promptCache.mode === "explicit") {
			throw new AIError.ConfigurationError(
				`OpenAI explicit prompt caching is unsupported for ${model.provider}/${model.id}; enable compat.supportsPromptCacheBreakpoints only for a compatible endpoint.`,
			);
		}
		return;
	}

	params.prompt_cache_key = promptCacheKey;
	params.prompt_cache_options = {
		mode: promptCache.mode,
		ttl: promptCache.ttl ?? model.compat.promptCacheBreakpointTtl,
	};
	if (promptCache.mode === "explicit" && promptCache.breakpoint !== "none")
		markLatestStableChatCompletionsCacheBreakpoint(params.messages);
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	toolStrictModeOverride?: ToolStrictModeOverride,
): {
	params: OpenAICompletionsParams;
	toolStrictMode: AppliedToolStrictMode;
	strictToolsApplied: boolean;
} {
	const initialPolicy = resolveOpenAICompatForRequest(model, options);
	const initialCompat = initialPolicy.compat as ResolvedOpenAICompat;
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);

	const requestModelId = resolveOpenAICompletionsModelId(model, options);
	const params: OpenAICompletionsParams = {
		model: requestModelId,
		messages: [],
		stream: true,
	};
	let toolStrictMode: AppliedToolStrictMode = "none";
	let strictToolsApplied = false;

	if (initialCompat.supportsUsageInStreaming !== false) {
		params.stream_options = { include_usage: true };
	}

	if (initialCompat.supportsStore) {
		params.store = false;
	}

	// OpenAI proprietary reasoning models (o-series, gpt-5+) reject explicit
	// sampling params with a 400 on every serving host (#5606).
	if (initialCompat.supportsSamplingParams) {
		if (options?.temperature !== undefined) {
			params.temperature = options.temperature;
		}
		if (options?.topP !== undefined) {
			params.top_p = options.topP;
		}
		if (options?.topK !== undefined) {
			params.top_k = options.topK;
		}
		if (options?.minP !== undefined) {
			params.min_p = options.minP;
		}
		if (initialCompat.supportsPenaltyAndStopParams) {
			if (options?.presencePenalty !== undefined) {
				params.presence_penalty = options.presencePenalty;
			}
			if (options?.repetitionPenalty !== undefined) {
				params.repetition_penalty = options.repetitionPenalty;
			}
			if (options?.frequencyPenalty !== undefined) {
				params.frequency_penalty = options.frequencyPenalty;
			}
		}
	}
	if (options?.stopSequences?.length && initialCompat.supportsPenaltyAndStopParams) {
		const seqs = options.stopSequences;
		params.stop = seqs.length === 1 ? seqs[0] : seqs.slice(0, 4);
	}
	applyOpenAIServiceTier(params, options?.serviceTier, model);

	if (context.tools?.length) {
		const builtTools = convertTools(context.tools, initialCompat, toolStrictModeOverride, model.provider);
		params.tools = builtTools.tools;
		toolStrictMode = builtTools.toolStrictMode;
		strictToolsApplied = builtTools.strictToolsApplied;
	} else if (context.tools === undefined && hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires the `tools` param when the conversation
		// contains tool_calls/tool_results, even when no tools are offered this turn.
		// Only inject the sentinel when the caller passed `context.tools = undefined`
		// (i.e. tools were not specified at all). An explicit `context.tools = []` means
		// the caller opted out of tools for this turn (as /btw and IRC background replies
		// do via AgentSession.runEphemeralTurn) — honour that intent and emit nothing,
		// so LiteLLM → Bedrock never sees an empty `toolConfig` block.
		params.tools = [];
	}

	if (options?.toolChoice && initialCompat.supportsToolChoice) {
		params.tool_choice = mapToOpenAICompletionsToolChoice(options.toolChoice);
	}
	const forcedToolName =
		typeof params.tool_choice === "object" && params.tool_choice !== null && "function" in params.tool_choice
			? params.tool_choice.function.name
			: undefined;
	if (
		typeof params.tool_choice === "object" &&
		params.tool_choice !== null &&
		!initialCompat.supportsNamedToolChoice
	) {
		// String-only hosts (llama.cpp, LM Studio) accept only none/auto/required,
		// so a named object degrades to "required". "required" alone lets the host
		// satisfy the hard choice with ANY advertised tool, defeating the named
		// force. When the forced tool is present, narrow the advertised tools to it
		// so "required" still enforces that specific call (mirrors the Ollama chat
		// transport's selectToolsForToolChoice). When it is absent, leave the full
		// list intact and let the absent-tool guard below drop the choice for an
		// unforced turn.
		if (
			forcedToolName !== undefined &&
			Array.isArray(params.tools) &&
			params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName)
		) {
			params.tools = params.tools.filter(tool => tool.type === "function" && tool.function.name === forcedToolName);
		}
		params.tool_choice = "required";
	}
	if (
		forcedToolName !== undefined &&
		Array.isArray(params.tools) &&
		params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName) &&
		hasActiveNativeKimiK3Reasoning(model, options)
	) {
		// Native K3 reasoning is incompatible with selecting a specific function.
		// Preserve the hard tool-use contract while letting K3 choose among tools.
		params.tool_choice = "required";
	}
	if (isForcedToolChoice(params.tool_choice) && !initialCompat.supportsForcedToolChoice) {
		// Some thinking-required OpenAI-compatible models reject forced
		// `tool_choice` while still accepting tools with the default auto
		// selector. Keep the tool available and let the model choose it.
		params.tool_choice = "auto";
	}

	if (
		(!Array.isArray(params.tools) || params.tools.length === 0) &&
		(params.tool_choice === "none" || isForcedToolChoice(params.tool_choice))
	) {
		// `tool_choice: "none"` with no tools to gate is redundant and also
		// trips LiteLLM → Bedrock: the proxy serializes the directive into a
		// `toolConfig` block, and Bedrock requires `toolConfig.tools` to be
		// non-empty whenever the conversation already holds `toolUse`/`toolResult`
		// content. Drop it whenever the resolved tools list is missing or empty.
		// Side-channel turns hit this: `/btw` and IRC background replies route
		// through `AgentSession.runEphemeralTurn`, which sets `context.tools = []`
		// and `toolChoice: "none"` (see packages/coding-agent/src/session/agent-session.ts).
		// The same empty-tools case applies after leftover-union quarantine: a
		// leftover `"required"` / named force would 400 just like the bad schema.
		delete params.tool_choice;
	}

	if (
		forcedToolName !== undefined &&
		(!Array.isArray(params.tools) ||
			!params.tools.some(tool => tool.type === "function" && tool.function.name === forcedToolName))
	) {
		// A forced named tool_choice is only valid when the same request offers
		// that function in `tools`. Active-tool filtering normally enforces this
		// before provider dispatch; this guard keeps raw provider callers from
		// emitting a self-inconsistent OpenAI-compatible payload.
		delete params.tool_choice;
	}

	if (shouldDropAutoToolChoiceForReasoning(model, initialCompat, params.tool_choice, options)) {
		delete params.tool_choice;
	}

	const finalPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "chat-completions",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
	});
	const compat = finalPolicy.compat as ResolvedOpenAICompat;
	const messages = convertMessages(model, context, compat);
	maybeAddAnthropicCacheControl(compat, messages);
	params.messages = messages;
	const outputToken = resolveOpenAIOutputTokenParam({
		field: compat.maxTokensField,
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		isOpenRouterHost: compat.isOpenRouterHost,
		alwaysSendMaxTokens: compat.alwaysSendMaxTokens,
		providerOutputClamp: resolveOpenAICompletionsOutputClamp(model, compat),
	});
	if (outputToken) {
		if (outputToken.field === "max_tokens") {
			params.max_tokens = outputToken.value;
		} else if (outputToken.field === "max_completion_tokens") {
			params.max_completion_tokens = outputToken.value;
		}
	}
	applyChatCompletionsToolStream(params, model, compat);

	applyChatCompletionsCompatPolicy(params, finalPolicy);
	dropOpenRouterKimiForcedToolReasoning(params, model, finalPolicy);

	applyOpenAIGatewayRouting(params, compat, cacheRetention !== "none");

	applyOpenAIExtraBody(params, compat.extraBody, {
		dropThinkingWhenReasoningEffort: compat.dropThinkingWhenReasoningEffort,
	});
	applyOpenAIChatCompletionsPromptCachePolicy(params, model, options);

	return { params, toolStrictMode, strictToolsApplied };
}

export function parseChunkUsage(
	rawUsage: object,
	model: Model<"openai-completions">,
	premiumRequests: number | undefined,
): AssistantMessage["usage"] {
	const usageLike = rawUsage as OpenAICompletionsUsageLike;
	const rawPromptTokenDetails = usageLike.prompt_tokens_details;
	const promptTokenDetails =
		typeof rawPromptTokenDetails === "object" && rawPromptTokenDetails !== null
			? (rawPromptTokenDetails as OpenAICompletionsPromptTokenDetails)
			: undefined;
	const rawCompletionTokenDetails = usageLike.completion_tokens_details;
	const completionTokenDetails =
		typeof rawCompletionTokenDetails === "object" && rawCompletionTokenDetails !== null
			? (rawCompletionTokenDetails as OpenAICompletionsCompletionTokenDetails)
			: undefined;
	const completionTokens = usageLike.completion_tokens;
	const promptTokens = usageLike.prompt_tokens;
	const cachedTokens = usageLike.cached_tokens;
	const promptCacheHitTokens = usageLike.prompt_cache_hit_tokens;
	const promptCacheMissTokens = usageLike.prompt_cache_miss_tokens;
	const promptTokenCachedTokens = promptTokenDetails?.cached_tokens;
	const cachedContentTokenCount = usageLike.cachedContentTokenCount;
	const completionReasoningTokens = completionTokenDetails?.reasoning_tokens;
	const cacheWriteTokens = promptTokenDetails?.cache_write_tokens;
	const outputTokens = typeof completionTokens === "number" ? completionTokens : 0;
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: typeof promptTokens === "number" ? promptTokens : 0,
		outputTokens,
		cachedTokens: firstPositiveNumber(
			cachedTokens,
			promptCacheHitTokens,
			promptTokenCachedTokens,
			cachedContentTokenCount,
		),
		reasoningTokens: typeof completionReasoningTokens === "number" ? completionReasoningTokens : 0,
		cacheWriteOpenRouter: typeof cacheWriteTokens === "number" ? cacheWriteTokens : undefined,
		cacheWriteDeepSeek: typeof promptCacheMissTokens === "number" ? promptCacheMissTokens : undefined,
		hasDeepSeekCacheHitAndMiss: typeof promptCacheHitTokens === "number" && typeof promptCacheMissTokens === "number",
	});
	const usage: AssistantMessage["usage"] = {
		...accounting,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...(premiumRequests !== undefined ? { premiumRequests } : {}),
	};
	calculateCost(model, usage);
	applyOpenRouterReportedCost(model, usage, rawUsage);
	return usage;
}

function maybeAddAnthropicCacheControl(compat: ResolvedOpenAICompat, messages: ChatCompletionMessageParam[]): void {
	if (compat.cacheControlFormat !== "anthropic") return;
	// Anthropic-style caching requires cache_control on a text part. Add a breakpoint
	// on the last user/assistant message (walking backwards until we find text content).
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "developer") continue;

		const content = msg.content;
		if (typeof content === "string") {
			if (content.trim().length === 0) continue;
			msg.content = [
				Object.assign({ type: "text" as const, text: content }, { cache_control: { type: "ephemeral" } }),
			];
			return;
		}

		if (!Array.isArray(content)) continue;

		// Find last non-empty text part and add cache_control. Empty assistant
		// content is valid for tool-call replay, but Anthropic/OpenRouter reject
		// empty text blocks once cache_control turns it into structured content.
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part?.type === "text" && part.text.trim().length > 0) {
				Object.assign(part, { cache_control: { type: "ephemeral" } });
				return;
			}
		}
	}
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	const maxNormalizedToolCallIdLength = compat.requiresMistralToolIds
		? 9
		: compat.usesOpenAIToolCallIdLimit
			? 40
			: undefined;
	const duplicateToolCallIdSuffixPrefix = compat.requiresMistralToolIds ? "dup" : undefined;
	const normalizeToolCallId = (id: string, source?: AssistantMessage): string => {
		if (compat.requiresMistralToolIds) return normalizeMistralToolId(id, true);

		const isSameModelSource =
			source !== undefined &&
			source.provider === model.provider &&
			source.api === model.api &&
			source.model === model.id;
		// Cross-model replay converts OpenAI Responses composite IDs from
		// `{call_id}|{item_id}` to the Chat Completions `call_id`. Same-model
		// Chat Completions IDs are provider-issued opaque correlation tokens.
		if (!isSameModelSource && id.includes("|")) {
			const [callId] = id.split("|");
			return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		}

		if (compat.usesOpenAIToolCallIdLimit) return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(
		context.messages,
		model,
		(id, _target, source) => normalizeToolCallId(id, source),
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
		compat,
	);

	const remappedToolCallIds = new Map<string, string[]>();
	let generatedToolCallIdCounter = 0;

	const generateFallbackToolCallId = (seed: string): string => {
		generatedToolCallIdCounter += 1;
		const hash = Bun.hash(`${model.provider}:${model.id}:${seed}:${generatedToolCallIdCounter}`).toString(36);
		return `call_${hash}`;
	};

	const rememberToolCallId = (originalId: string, normalizedId: string): void => {
		const queue = remappedToolCallIds.get(originalId);
		if (queue) {
			queue.push(normalizedId);
			return;
		}
		remappedToolCallIds.set(originalId, [normalizedId]);
	};

	const consumeToolCallId = (originalId: string): string | null => {
		const queue = remappedToolCallIds.get(originalId);
		if (!queue || queue.length === 0) return null;
		const nextId = queue.shift() ?? null;
		if (queue.length === 0) remappedToolCallIds.delete(originalId);
		return nextId;
	};

	const ensureToolCallId = (rawId: string, seed: string, source?: AssistantMessage): string => {
		const normalized = normalizeToolCallId(rawId, source);
		if (normalized.trim().length > 0) return normalized;
		return generateFallbackToolCallId(seed);
	};

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		// Default to one block per ordered system prompt so the leading prefix
		// stays byte-identical between turns and the provider's KV cache can
		// reuse it. Hosts whose chat templates reject follow-up system messages
		// (Qwen via vLLM, MiniMax, Alibaba Dashscope, Qwen Portal, …) opt out
		// via `compat.supportsMultipleSystemMessages = false`; in that mode we
		// coalesce into a single message joined by `\n\n`.
		if (compat.supportsMultipleSystemMessages) {
			for (const systemPrompt of systemPrompts) {
				params.push({ role, content: systemPrompt });
			}
		} else {
			params.push({ role, content: systemPrompts.join("\n\n") });
		}
	}

	let lastRole: string | null = null;

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// Some providers (e.g. Mistral/Devstral) don't allow user messages directly after tool results
		// Insert a synthetic assistant message to bridge the gap
		if (
			compat.requiresAssistantAfterToolResult &&
			lastRole === "toolResult" &&
			(msg.role === "user" || msg.role === "developer")
		) {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		const devAsUser = !compat.supportsDeveloperRole;
		if (msg.role === "user" || msg.role === "developer") {
			const role = !devAsUser && msg.role === "developer" ? "developer" : "user";
			if (typeof msg.content === "string") {
				const text = msg.content.toWellFormed();
				if (text.trim().length === 0) continue;
				params.push({
					role: role,
					content: text,
				});
			} else {
				const supportsImages = isOpenAICompletionsVisionSupported(model);
				const content: ChatCompletionContentPart[] = [];
				let omittedImages = false;
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						content.push({
							type: "text",
							text,
						} satisfies ChatCompletionContentPartText);
					} else if (supportsImages) {
						content.push({
							type: "image_url",
							image_url: {
								url: item.url ?? `data:${item.mimeType};base64,${item.data}`,
								// Chat Completions has no "original"; omit it (provider default).
								...(item.detail && item.detail !== "original" ? { detail: item.detail } : {}),
							},
						} satisfies ChatCompletionContentPartImage);
					} else {
						omittedImages = true;
					}
				}
				if (omittedImages) {
					content.push({
						type: "text",
						text: NON_VISION_IMAGE_PLACEHOLDER,
					} satisfies ChatCompletionContentPartText);
				}
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg: OpenAICompletionsAssistantMessageParam = {
				role: "assistant",
				content: null,
			};

			const textBlocks = msg.content.filter(b => b.type === "text") as TextContent[];
			// Filter out empty text blocks to avoid API validation errors
			const nonEmptyTextBlocks = textBlocks.filter(b => b.text && b.text.trim().length > 0);
			if (nonEmptyTextBlocks.length > 0) {
				// Always send assistant content as a plain string. Some OpenAI-compatible
				// backends mirror array-of-text-block payloads back to the model literally,
				// causing recursive nested content in subsequent turns.
				// Join ordinary adjacent text blocks with no separator so bridge
				// stitching, imported transcripts, and streaming chunks keep their
				// original byte sequence. Demoted-thinking blocks (kDemotedThinking,
				// synthesized by transformMessages) are the one exception: bare
				// Anthropic-dialect reasoning would otherwise glue onto the first word
				// of the visible answer. Insert a paragraph break after them — only
				// when another block actually follows, so a trailing demoted block
				// never ships trailing whitespace.
				assistantMsg.content = nonEmptyTextBlocks
					.map((b, i) => {
						const text = b.text.toWellFormed();
						return isDemotedThinking(b) && i < nonEmptyTextBlocks.length - 1 ? `${text}\n` : text;
					})
					.join("");
			}

			// Handle thinking blocks
			const thinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
			// Filter out empty thinking blocks to avoid API validation errors
			const nonEmptyThinkingBlocks = thinkingBlocks.filter(b => b.thinking && b.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					const thinkingText = nonEmptyThinkingBlocks
						.map(b => renderDemotedThinking(model.id, b.thinking))
						.join(" ");
					// `content` is a plain string at this point (set above) or null —
					// never an array. Prepend the demoted thinking to the string form.
					assistantMsg.content =
						typeof assistantMsg.content === "string" && assistantMsg.content.length > 0
							? `${thinkingText} ${assistantMsg.content}`
							: thinkingText;
				} else if (compat.requiresReasoningContentForToolCalls) {
					// Use the streamed signature when the backend accepts whichever
					// recognized field name was emitted (allowsSynthetic=true). Backends
					// like opencode-kimi-with-thinking and DeepSeek demand the exact
					// configured `reasoningContentField` instead, so honor that here
					// rather than echoing the upstream field name.
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const wireField =
						compat.allowsSyntheticReasoningContentForToolCalls &&
						(signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text")
							? signature
							: signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
								? (compat.reasoningContentField ?? "reasoning_content")
								: undefined;
					if (wireField) {
						assistantMsg[wireField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				} else if (compat.thinkingFormat === "zai" && model.reasoning) {
					// Z.AI / Zhipu / Moonshot Kimi (native) / Xiaomi MiMo accept
					// `reasoning_content` as a continuation hint even when they don't
					// strictly require it. Surfacing the preserved thinking text here
					// keeps cross-API replays (Z.AI Anthropic → Z.AI OpenAI, etc.)
					// shipping reasoning as structured `reasoning_content` rather than
					// folded into conversation text (#3434). Signature is irrelevant on
					// this path: `transform-messages` strips the source wire-format
					// signature on cross-API replays before the block reaches us.
					const reasoningField = compat.reasoningContentField ?? "reasoning_content";
					assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
				} else if (compat.replayReasoningContent) {
					// Local llama.cpp-style servers (llama.cpp, LM Studio, vLLM, Ollama
					// in openai-completions mode, custom providers pointed at a
					// loopback baseUrl) re-tokenize the entire prompt every request.
					// Qwen3 / DeepSeek-R1 / GLM chat templates reconstruct the prior
					// assistant turn's `<think>` block from `reasoning_content`; if we
					// drop the field the template re-renders the assistant turn
					// without thinking content, the rendered tokens diverge from the
					// slot's existing KV cache, and llama.cpp falls back to full
					// prompt re-processing (#3528). Honor the streamed signature when
					// it identifies a recognized wire field so a model that emitted
					// `reasoning` (some llama.cpp builds) round-trips to the same
					// field; otherwise fall back to the configured
					// `reasoningContentField`. Gated by the new compat flag rather
					// than the existing `requires*` flags because local servers
					// accept but don't validate the field — they just need it to
					// preserve cache locality.
					const signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					const reasoningField: OpenAICompletionsReasoningField =
						signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text"
							? signature
							: (compat.reasoningContentField ?? "reasoning_content");
					assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
				}
			}

			if (compat.requiresReasoningContentForToolCalls) {
				const streamedReasoningField = nonEmptyThinkingBlocks[0]?.thinkingSignature;
				const reasoningField =
					compat.allowsSyntheticReasoningContentForToolCalls &&
					(streamedReasoningField === "reasoning_content" ||
						streamedReasoningField === "reasoning" ||
						streamedReasoningField === "reasoning_text")
						? streamedReasoningField
						: (compat.reasoningContentField ?? "reasoning_content");
				const reasoningContent = assistantMsg[reasoningField];
				if (!reasoningContent) {
					const reasoning = assistantMsg.reasoning;
					const reasoningText = assistantMsg.reasoning_text;
					if (reasoning && reasoningField !== "reasoning") {
						assistantMsg[reasoningField] = reasoning;
					} else if (reasoningText && reasoningField !== "reasoning_text") {
						assistantMsg[reasoningField] = reasoningText;
					} else if (nonEmptyThinkingBlocks.length > 0) {
						assistantMsg[reasoningField] = nonEmptyThinkingBlocks.map(b => b.thinking).join("\n");
					}
				}
			}

			const toolCalls = msg.content.filter(b => b.type === "toolCall") as ToolCall[];
			// Replay reasoning_content on assistant turns for backends that validate
			// thinking-mode history. DeepSeek V4 requires reasoning_content on EVERY
			// assistant turn once a prior turn included it — not just tool-call turns.
			// The replay logic has three tiers:
			//   1. Recover from thinking blocks with valid signatures (covers same-model replay
			//      where nonEmptyThinkingBlocks may have filtered out empty-text blocks)
			//   2. For providers that require the field but returned no reasoning at all
			//      (e.g. proxy-stripped reasoning_content), emit an empty string
			//   3. For providers that accept synthetic placeholders (Kimi, OpenRouter), emit "."
			// DeepSeek V4 rejects synthetic "." placeholders — it validates the exact value —
			// so the allowsSyntheticReasoningContentForToolCalls flag controls tier 3.
			const canUseSyntheticReasoningContent =
				compat.requiresReasoningContentForToolCalls &&
				compat.allowsSyntheticReasoningContentForToolCalls &&
				(compat.thinkingFormat === "openai" ||
					compat.thinkingFormat === "openrouter" ||
					compat.thinkingFormat === "zai");
			// DeepSeek-compatible reasoning models require reasoning_content on all
			// assistant turns. Providers that allow placeholders only need it on
			// tool-call turns.
			const needsReasoningOnAllTurns = compat.requiresReasoningContentForAllAssistantTurns;
			const needsReasoningField = needsReasoningOnAllTurns || toolCalls.length > 0;
			let hasReasoningField =
				assistantMsg.reasoning_content !== undefined ||
				assistantMsg.reasoning !== undefined ||
				assistantMsg.reasoning_text !== undefined;
			// Tier 1: Recover reasoning_content from ALL thinking blocks (including empty-text
			// ones) when the provider requires exact replay and rejects synthetic placeholders.
			// This covers the case where thinking blocks have valid signatures but were excluded
			// by the nonEmptyThinkingBlocks filter above, or where thinking text is empty but
			// the signature identifies the correct field name for replay.
			// Only recognized OpenAI-compat reasoning field names qualify — opaque signatures
			// from other providers (Anthropic encrypted, OpenAI Responses JSON, etc.) are not
			// valid property names for the wire message.
			if (
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const allThinkingBlocks = msg.content.filter(b => b.type === "thinking") as ThinkingContent[];
				if (allThinkingBlocks.length > 0) {
					const signature = allThinkingBlocks[0].thinkingSignature;
					if (signature === "reasoning_content" || signature === "reasoning" || signature === "reasoning_text") {
						const reasoningField = compat.reasoningContentField ?? "reasoning_content";
						assistantMsg[reasoningField] = allThinkingBlocks.map(b => b.thinking).join("\n");
						hasReasoningField = true;
					}
				}
			}
			// Tier 2: When the provider requires reasoning_content but there are genuinely no
			// thinking blocks at all (e.g. proxy stripped reasoning_content from the response),
			// emit an empty string. The field must be present; an empty string is the most honest
			// representation of "no reasoning was captured."
			if (
				needsReasoningField &&
				!hasReasoningField &&
				compat.requiresReasoningContentForToolCalls &&
				!compat.allowsSyntheticReasoningContentForToolCalls
			) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = "";
				hasReasoningField = true;
			}
			// Tier 3: For providers that accept synthetic placeholders (Kimi, OpenRouter).
			if (toolCalls.length > 0 && canUseSyntheticReasoningContent && !hasReasoningField) {
				const reasoningField = compat.reasoningContentField ?? "reasoning_content";
				assistantMsg[reasoningField] = ".";
				hasReasoningField = true;
			}
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc, toolCallIndex) => {
					const toolCallId = ensureToolCallId(tc.id, `${i}:${toolCallIndex}:${tc.name}`, msg);
					rememberToolCallId(tc.id, toolCallId);
					return {
						id: normalizeMistralToolId(toolCallId, compat.requiresMistralToolIds),
						type: "function" as const,
						function: {
							name: tc.name,
							arguments: serializeToolArguments(tc.arguments),
						},
					};
				});
				const reasoningDetails = toolCalls
					.filter(tc => tc.thoughtSignature)
					.map(tc => {
						try {
							const parsed: unknown = JSON.parse(tc.thoughtSignature!);
							return parsed;
						} catch {
							return null;
						}
					})
					.filter(Boolean);
				if (reasoningDetails.length > 0) {
					assistantMsg.reasoning_details = reasoningDetails;
				}
			}
			// Some OpenAI-compatible backends concatenate assistant content as a
			// string even for tool-call replay. OpenAI accepts an empty string here;
			// null trips strict/proxy implementations before the tool result is read.
			if (assistantMsg.content === null && (hasReasoningField || assistantMsg.tool_calls)) {
				assistantMsg.content = "";
			}
			// Skip assistant messages that have no content, no tool calls, and no reasoning payload.
			// Some OpenAI-compatible backends require replaying reasoning-only assistant turns
			// so follow-up requests preserve the provider-specific reasoning field name.
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && assistantMsg.tool_calls && compat.requiresAssistantContentForToolCalls) {
				assistantMsg.content = ".";
			}
			if (!hasContent && !assistantMsg.tool_calls && !hasReasoningField) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// Batch consecutive tool results and collect all images
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let j = i;

			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// Extract text and image content
				const textResult = toolMsg.content
					.filter(c => c.type === "text")
					.map(c => (c as TextContent).text)
					.join("\n");
				const supportsImages = isOpenAICompletionsVisionSupported(model);
				const hasImages = toolMsg.content.some(c => c.type === "image");
				const omittedImages = hasImages && !supportsImages;

				// Always send tool result with text (or placeholder if only images)
				const hasText = textResult.length > 0;
				const remappedToolCallId = consumeToolCallId(toolMsg.toolCallId);
				const resolvedToolCallId =
					remappedToolCallId ?? ensureToolCallId(toolMsg.toolCallId, `${j}:${toolMsg.toolName ?? "tool"}`);
				const toolResultContent = omittedImages
					? joinTextWithImagePlaceholder(textResult, true)
					: hasText
						? textResult
						: hasImages
							? "(see attached image)"
							: "";
				const toolResultMsg: OpenAICompletionsToolMessageParam = {
					role: "tool",
					content: toolResultContent.toWellFormed(),
					tool_call_id: normalizeMistralToolId(resolvedToolCallId, compat.requiresMistralToolIds),
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					toolResultMsg.name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				if (hasImages && supportsImages) {
					for (const block of toolMsg.content) {
						if (block.type === "image") {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: block.url ?? `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			// After all consecutive tool results, add a single user message with all images
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}
			continue;
		}

		lastRole =
			msg.role === "developer"
				? model.reasoning && compat.supportsDeveloperRole
					? "developer"
					: "system"
				: msg.role;
	}

	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompat,
	toolStrictModeOverride?: ToolStrictModeOverride,
	provider?: string,
): BuiltOpenAICompletionTools {
	const rejectXaiRootObjectUnion = provider === "xai" || provider === "xai-oauth";
	const adaptedTools = tools.map(tool => {
		const strict = !NO_STRICT && compat.supportsStrictMode !== false && tool.strict !== false;
		const baseParameters = rejectXaiRootObjectUnion
			? flattenExclusiveRequiredRootUnion(toolWireSchema(tool))
			: toolWireSchema(tool);
		const adapted = adaptSchemaForStrict(baseParameters, strict);
		return {
			tool,
			baseParameters,
			parameters: adapted.schema,
			strict: adapted.strict,
		};
	});

	const requestedStrictMode = toolStrictModeOverride ?? compat.toolStrictMode;
	const toolStrictMode =
		requestedStrictMode === "none"
			? "none"
			: requestedStrictMode === "all_strict"
				? adaptedTools.every(tool => tool.strict)
					? "all_strict"
					: "none"
				: "mixed";

	const wireTools: ChatCompletionTool[] = [];
	let anyStrictEmitted = false;
	for (const { tool, baseParameters, parameters, strict } of adaptedTools) {
		const includeStrict = toolStrictMode === "all_strict" || (toolStrictMode === "mixed" && strict);
		// `strict: false` is semantically distinct from omitted `strict` on some
		// backends: with it absent, optional properties may be over-filled with
		// placeholder values (#4336). Preserve the author's explicit `false`,
		// but only in "mixed" mode against a provider that understands the
		// field — the `all_strict → none` collapse and `supportsStrictMode:
		// false` paths deliberately keep the wire flag uniformly absent.
		const includeExplicitFalse =
			!includeStrict && tool.strict === false && toolStrictMode === "mixed" && compat.supportsStrictMode !== false;
		const wireParameters = includeStrict ? parameters : baseParameters;
		// Moonshot/Kimi native hosts validate against the stricter MFJS subset
		// (const→enum, typed enums, no validators) and 400 otherwise.
		// Grammar-constrained local backends (llama.cpp, LM Studio, vLLM)
		// build a GBNF grammar from the schema and 400 with
		// `Unrecognized schema: true` on the bare boolean subschema
		// `toolWireSchema` emits for open fields (issue #5914).
		const emittedParameters =
			compat.toolSchemaFlavor === "moonshot-mfjs"
				? (normalizeSchemaForMoonshot(wireParameters) as Record<string, unknown>)
				: compat.toolSchemaFlavor === "grammar"
					? sanitizeSchemaForGrammar(wireParameters)
					: wireParameters;
		const violation = findStrictToolSchemaViolation(emittedParameters, "#", { rejectXaiRootObjectUnion });
		if (violation) {
			logger.warn(
				`Tool "${tool.name}" omitted from the openai-completions request: its parameter schema is invalid for this provider at ${violation} (an enum/const value cannot match its declared type, or leftover xAI object-root union). Other tools are unaffected.`,
			);
			continue;
		}
		if (includeStrict) anyStrictEmitted = true;
		wireTools.push({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description || "",
				parameters: emittedParameters,
				// Only include strict if provider supports it. Some reject unknown fields.
				...(includeStrict ? { strict: true } : includeExplicitFalse ? { strict: false } : {}),
			},
		});
	}

	return {
		tools: wireTools,
		toolStrictMode,
		strictToolsApplied: wireTools.length > 0 && anyStrictEmitted,
	};
}

const EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE =
	"Model returned no content: prompt filled the context window; raise Ollama num_ctx or shorten the prompt.";

function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	// Some OpenAI-compatible gateways fronting Google Gemini backends emit the
	// native uppercase finish reasons (`STOP`, `MAX_TOKENS`) instead of the
	// lowercase OpenAI contract values. Fold case so a clean completion isn't
	// misclassified as a provider error.
	const normalized = typeof reason === "string" ? reason.toLowerCase() : reason;
	switch (normalized) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
		case "max_tokens":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		case "error":
			// Gateways (OpenRouter, Vercel AI Gateway, …) report upstream model
			// failures as a bare `finish_reason: "error"` with no detail. These are
			// almost always transient (e.g. Gemini MALFORMED_FUNCTION_CALL), so word
			// the message to match the session retry classifier's transient-transport
			// pattern (`provider.?returned.?error`) and get the turn auto-retried.
			return { stopReason: "error", errorMessage: "Provider returned error finish_reason" };
		case "insufficient_system_resource":
			// DeepSeek kills the generation mid-stream when its inference system runs
			// out of resources (docs: "the request is interrupted due to insufficient
			// resource of the inference system"). Server-side capacity failure — like
			// the bare `error` case, word the message to match the transient-transport
			// retry pattern so the turn is auto-retried instead of pinned as an error.
			return {
				stopReason: "error",
				errorMessage: "Provider returned error finish_reason: insufficient_system_resource",
			};
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}
