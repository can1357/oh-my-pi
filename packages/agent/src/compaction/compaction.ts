/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	type CodexCompactionContext,
	type Context,
	Effort,
	type FetchImpl,
	type Message,
	type MessageAttribution,
	type Model,
	type OneshotRetryOptions,
	type ProviderSessionState,
	type SimpleStreamOptions,
	type Tool,
	type Usage,
	withAuth,
} from "@oh-my-pi/pi-ai";
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	buildTransformedCodexRequestBody,
	createOpenAICodexCompactionRequestContext,
	type OpenAICodexCompactionBody,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { InputItem as CodexInputItem } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildResponsesInput, resolveOpenAICompatPolicy } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { stripOpenAIResponsesOutputOnlyStatusesForReplay } from "@oh-my-pi/pi-ai/utils";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import { ThinkingLevel } from "../thinking";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import {
	buildCompactionV2Request,
	buildCompactionV2RequestFromBody,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
	shouldUseCompactionV2Streaming,
	storeCompactionV2PreserveData,
	V2_RETAINED_MESSAGE_TOKEN_BUDGET,
} from "./compaction-v2-streaming";
import type { CompactionEntry, SessionEntry } from "./entries";
import { NativeCompactionError } from "./errors";
import { type ConvertToLlm, createBranchSummaryMessage, createCustomMessage, defaultConvertToLlm } from "./messages";
import {
	buildOpenAiNativeHistory,
	getPreservedOpenAiRemoteCompactionData,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
	shouldUseOpenAiRemoteCompaction,
	trimRemoteCompactionInputToContextWindow,
	withOpenAiRemoteCompactionPreserveData,
} from "./openai";
import autoHandoffThresholdFocusPrompt from "./prompts/auto-handoff-threshold-focus.md" with { type: "text" };
import compactionShortSummaryPrompt from "./prompts/compaction-short-summary.md" with { type: "text" };
import compactionSummaryPrompt from "./prompts/compaction-summary.md" with { type: "text" };
import compactionTurnPrefixPrompt from "./prompts/compaction-turn-prefix.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "./prompts/compaction-update-summary.md" with { type: "text" };
import handoffDocumentPrompt from "./prompts/handoff-document.md" with { type: "text" };
import snapcompactArchiveContextPrompt from "./prompts/snapcompact-archive-context.md" with { type: "text" };

import {
	computeFileLists,
	createFileOps,
	escapeSummaryBoundaryTags,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	upsertFileOperations,
} from "./utils";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.attribution,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	/** Short PR-style summary for display purposes. */
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Hook-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist alongside compaction entry. */
	preserveData?: Record<string, unknown>;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "context-full" | "handoff" | "shake" | "snapcompact" | "off";
	thresholdPercent?: number;
	thresholdTokens?: number;
	midTurnEnabled?: boolean;
	/**
	 * Tokens reserved below the context window for the next prompt + response.
	 *
	 * Leave unset to use {@link DEFAULT_RESERVE_TOKENS}; the unset state is the
	 * provenance signal that lets small-window recovery replace the default with
	 * a proportional reserve (see {@link resolveBudgetReserveTokens}). An
	 * explicit value — even one equal to the default — is always honored.
	 */
	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEnabled?: boolean;
	remoteEndpoint?: string;
	remoteStreamingV2Enabled?: boolean;
	v2RetainedMessageBudget?: number;
}

/** Reserve applied when {@link CompactionSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/**
 * Hard ceiling on a generated compaction summary.
 *
 * The summary budget is `floor(0.8 * reserveTokens)`, and the effective reserve is
 * at least 15% of the declared context window, so a 1M-token window authorizes a
 * ~120k-token summary. At that size the model copies rather than compresses, and
 * output is the slowest and most expensive token class. Capping absolutely keeps
 * the compression ratio improving with window size instead of degrading. The value
 * mirrors {@link DEFAULT_RESERVE_TOKENS} so this adds no new tuning constant.
 */
export const MAX_SUMMARY_TOKENS = DEFAULT_RESERVE_TOKENS;

// reserveTokens is deliberately absent: an unset reserve is what marks it as
// defaulted, which resolveBudgetReserveTokens needs to distinguish "user never
// chose a reserve" from "user explicitly configured the default value".
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1,
	thresholdTokens: -1,
	midTurnEnabled: true,
	keepRecentTokens: 20000,
	autoContinue: true,
	remoteEnabled: true,
	remoteStreamingV2Enabled: true,
	v2RetainedMessageBudget: V2_RETAINED_MESSAGE_TOKEN_BUDGET,
};

/** Whether a compaction candidate preserves provider-native transport under the effective settings. */
export function shouldUseProviderNativeCompaction(
	model: Model,
	settings: Pick<CompactionSettings, "remoteEnabled" | "remoteStreamingV2Enabled">,
): boolean {
	if (settings.remoteEnabled === false) return false;
	return (
		shouldUseOpenAiRemoteCompaction(model) ||
		(settings.remoteStreamingV2Enabled !== false && shouldUseCompactionV2Streaming(model))
	);
}

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Prefers an explicit provider-reported context occupancy when available.
 * Otherwise uses totalTokens and falls back to computing from billable
 * components. Provider-side orchestration tokens are billable but never replay
 * into the conversation prefix, so they are excluded from context sizing.
 */
export function calculateContextTokens(usage: Usage): number {
	if (usage.contextTokens !== undefined) {
		return Math.max(0, usage.contextTokens);
	}
	const orchestration = usage.orchestration;
	const orchestrationTotal = orchestration
		? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
		: 0;
	const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(0, raw - orchestrationTotal);
}

export function calculatePromptTokens(usage: Usage): number {
	if (usage.contextTokens !== undefined) {
		return Math.max(0, usage.contextTokens);
	}
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

export function hasContextTokenUsage(usage: Usage): boolean {
	return (
		(usage.contextTokens ?? 0) > 0 ||
		usage.input + usage.cacheRead + usage.cacheWrite > 0 ||
		calculateContextTokens(usage) > usage.output
	);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/**
 * Effective reserve: at least 15% of context window or the configured floor
 * (defaulting to {@link DEFAULT_RESERVE_TOKENS} when unset), whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/**
 * Reserve used when deciding whether a prompt still fits inside the model window.
 *
 * The default absolute reserve predates small bundled windows and can leave no
 * practical budget there; recover a DEFAULTED reserve that is impossible for
 * the window with the 15% proportional reserve (clamped to >= 1 so the derived
 * threshold stays strictly below the window even for tiny test windows).
 * Explicit valid reserves — including one that happens to equal the default —
 * still win, because they intentionally shrink the usable prompt budget;
 * provenance is carried by `settings.reserveTokens` being unset, never by
 * comparing values against the default.
 */
export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

/**
 * Context tokens to feed the compaction decision, floored by a local estimate of
 * the stored conversation.
 *
 * The provider-reported usage is normally ground truth, but a
 * `before_provider_request` payload transform — a compression extension (e.g.
 * Headroom), an obfuscator, or inline snapcompact — can shrink the request below
 * the real stored conversation. The provider then reports deflated prompt
 * tokens, so anchoring compaction purely on that usage lets the real history
 * grow unbounded until it overflows and native compaction can no longer run.
 * Flooring by the agent's own estimate of the stored conversation keeps the
 * compaction trigger honest regardless of on-wire compression. (Display/cost
 * accounting still uses the exact provider usage; only the compaction decision
 * takes the floor.)
 */
export function compactionContextTokens(providerContextTokens: number, storedConversationEstimate: number): number {
	return Math.max(Math.max(0, providerContextTokens), Math.max(0, storedConversationEstimate));
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	// Fixed token limit takes priority over percentage
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		// Clamp to [1, contextWindow - 1] so there's always room
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}

	// Percentage-based threshold. The default absolute reserve can exceed bundled
	// small-context windows, or nearly consume a 16k-class window; in those
	// known-impossible default configurations, fall back to the proportional
	// reserve so threshold/recovery-band checks stay usable. Explicit valid
	// configured reserves still define the usable prompt budget. Cap at
	// contextWindow - 1 (matching the fixed-token clamp above) so the threshold
	// never reaches the whole window even when the reserve resolves to 0.
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return Math.max(
			0,
			Math.min(contextWindow - 1, contextWindow - resolveBudgetReserveTokens(contextWindow, settings)),
		);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

// ============================================================================
// Cut point detection
// ============================================================================

function estimateEntriesTokens(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	startIndex: number,
	endIndex: number,
): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i]);
		if (msg) {
			total += tokenizer.countMessage(msg);
		}
	}
	return total;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role as string;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role as string;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = tokenizer.countMessage(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = prompt.render(compactionSummaryPrompt);

const UPDATE_SUMMARIZATION_PROMPT = prompt.render(compactionUpdateSummaryPrompt);

const SHORT_SUMMARY_PROMPT = prompt.render(compactionShortSummaryPrompt);

const HANDOFF_DOCUMENT_PROMPT = prompt.render(handoffDocumentPrompt);

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

/**
 * Maps the non-special `ThinkingLevel` values to their `Effort` counterparts.
 * Exhaustive over the union; throws for `Off`/`Inherit` to surface logic
 * errors in callers that forgot to filter those out. Never use a TS cast for
 * this — `ThinkingLevel` is a string-union over distinct concepts (Off /
 * Inherit are not Efforts), and a cast hides the contract.
 */
function effortFromThinkingLevel(level: ThinkingLevel): Effort {
	switch (level) {
		case ThinkingLevel.Minimal:
			return Effort.Minimal;
		case ThinkingLevel.Low:
			return Effort.Low;
		case ThinkingLevel.Medium:
			return Effort.Medium;
		case ThinkingLevel.High:
			return Effort.High;
		case ThinkingLevel.XHigh:
			return Effort.XHigh;
		case ThinkingLevel.Max:
			return Effort.Max;
		case ThinkingLevel.Off:
		case ThinkingLevel.Inherit:
			throw new Error(`effortFromThinkingLevel: ${level} must be handled by caller`);
	}
}

/**
 * Resolves the reasoning effort to send on a compaction LLM call.
 *
 * - Explicit `Off` → `undefined` (omit reasoning entirely; the user said no thinking).
 * - `undefined` / `Inherit` → historical `Effort.High` default → clamped per model
 *   (preserves current behavior for users who never touched the dial).
 * - Explicit effort → respect user choice → clamped per model.
 *
 * The clamp routes through `clampThinkingLevelForModel`, which returns
 * `undefined` for reasoning models without a thinking config — the build-time
 * encoding of `compat.supportsReasoningEffort: false` (e.g.
 * `xai-oauth/grok-build`). That `undefined` then flows through to the
 * openai-responses mapper, which omits the wire param — no
 * `requireSupportedEffort` throw.
 */
function resolveCompactionEffort(model: Model, level: ThinkingLevel | undefined): Effort | undefined {
	if (level === ThinkingLevel.Off) return undefined;
	const requested: Effort =
		level === undefined || level === ThinkingLevel.Inherit ? Effort.High : effortFromThinkingLevel(level);
	return clampThinkingLevelForModel(model, requested);
}

/**
 * Build the error thrown when an LLM summarization call ends with
 * `stopReason === "error"`. Carries the provider's HTTP `errorStatus`
 * onto a top-level `.status` field so callers (notably
 * `AgentSession.#isCompactionAuthFailure`) can branch on 401/403 without
 * regex-scraping `error.message`. The `auth_unavailable` synthetic
 * (pi-native gateway) does not populate `errorStatus`, hence the legacy
 * message-based check is still required upstream — see issue #986.
 */
function createSummarizationError(prefix: string, response: AssistantMessage): Error {
	const text = `${prefix}: ${response.errorMessage || "Unknown error"}`;
	return response.errorStatus === undefined
		? new Error(text)
		: new AIError.ProviderHttpError(text, response.errorStatus);
}

function shouldRetryHandoffWithAutoToolChoice(response: AssistantMessage): boolean {
	if (response.errorStatus !== 400) return false;
	const message = response.errorMessage ?? "";
	return /\btool_choice\b/i.test(message) && /\bauto\b/i.test(message) && /\bsupported\b/i.test(message);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	/** Stable system-prompt segments from the live turn, preserved for provider cache reuse. */
	remoteSystemPrompt?: string[];
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;
	/**
	 * Optional telemetry handle. When provided, every LLM call emitted during
	 * compaction is wrapped in an OTEL chat span tagged with
	 * `pi.gen_ai.oneshot.kind` (`compaction_summary`, `compaction_short_summary`,
	 * or `compaction_turn_prefix`). `undefined` keeps the call paths zero-cost.
	 */
	telemetry?: AgentTelemetry;
	/**
	 * Active session thinking level. Threaded from `agent-session.ts` so
	 * compaction honors the user's `/model` thinking selection instead of
	 * silently overriding it with `Effort.High` (the historical default).
	 * `undefined` / `ThinkingLevel.Inherit` falls back to that historical
	 * default; `ThinkingLevel.Off` omits reasoning entirely. See
	 * `resolveCompactionEffort` for the conversion contract.
	 */
	thinkingLevel?: ThinkingLevel;
	/** Session routing key for remote compaction transports with sticky provider sessions. */
	sessionId?: string;
	/** Prompt-cache key for remote compaction transports that support provider prefix caching. */
	promptCacheKey?: string;
	/** Mutable provider state used to keep Codex compaction on the live session identity. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Whether Codex remote compaction should prefer the provider WebSocket transport. */
	preferWebsockets?: boolean;
	/** Classification shared by every provider request in this logical compaction. */
	codexCompaction?: CodexCompactionContext;
	/** Provider-visible tools for remote compaction transports that replay native tool history. */
	tools?: Tool[];
	/** Optional fetch implementation threaded into remote compaction calls. */
	fetch?: FetchImpl;
	/**
	 * Optional completion transport override for host-level request wrappers
	 * (e.g. the coding-agent provider-concurrency limiter). When provided,
	 * every local summarization oneshot (`generateSummary`,
	 * `generateTurnPrefixSummary`, `generateShortSummary`) routes through it
	 * instead of the default `completeSimple`, so cap policies enforced on
	 * the live agent turn also bracket compaction HTTP requests.
	 */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/**
	 * Transient-failure retry for the summarization oneshots (`generateSummary`,
	 * `generateShortSummary`, `generateTurnPrefixSummary`).
	 *
	 * Defaults to enabled, which is what a one-shot caller such as manual
	 * `/compact` needs: a single Anthropic `overloaded_error` / 429 / 529 should
	 * not abort compaction and leave the context full.
	 *
	 * Pass `false` when the CALLER already owns a retry loop around the whole
	 * compaction attempt — auto-compaction does — otherwise the two budgets
	 * multiply (10 outer attempts x 3 inner = 30 requests) and each outer wait
	 * stacks on top of the inner backoff.
	 */
	oneshotRetry?: OneshotRetryOptions | false;
}

/**
 * Resolve the oneshot retry policy for a summarization call. Enabled by default
 * so a lone transient blip cannot abort compaction; `false` opts out for callers
 * that already retry the whole attempt (see `SummaryOptions.oneshotRetry`).
 */
function summaryOneshotRetry(options: SummaryOptions | undefined): OneshotRetryOptions | undefined {
	const configured = options?.oneshotRetry;
	if (configured === false) return undefined;
	return configured ?? {};
}

function localCodexCompaction(options: SummaryOptions | undefined) {
	return createOpenAICodexCompactionRequestContext({
		context: options?.codexCompaction,
		implementation: "responses",
	});
}

function formatPreviousSnapcompactArchive(archiveText: string): string {
	return prompt.render(snapcompactArchiveContextPrompt, { archiveText });
}

function mergePreviousSummaryWithSnapcompactArchive(
	previousSummary: string | undefined,
	archiveText: string | undefined,
): string | undefined {
	if (!archiveText) return previousSummary;
	const archiveSummary = formatPreviousSnapcompactArchive(archiveText);
	return previousSummary ? `${previousSummary}\n\n${archiveSummary}` : archiveSummary;
}

function createSnapcompactArchiveMigrationMessage(archiveText: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text: formatPreviousSnapcompactArchive(archiveText) }],
		timestamp: Date.now(),
	};
}

/**
 * Fallback window for a model whose catalog entry carries no usable context
 * window; matches the smallest window any compaction-capable model ships with.
 */
const DEFAULT_SUMMARY_INPUT_WINDOW = 200_000;

/**
 * Floor for one summarization window, so a tiny model still makes progress.
 * Scaled down (never below 1k) for models whose window cannot host the full
 * floor next to the carried summary and output reserves.
 */
const MIN_SUMMARY_INPUT_TOKENS = 16_384;

/** Smallest window worth planning for `model`; below this, overflow recovery gives up. */
function minSummaryInputTokens(model: Model): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	return Math.min(MIN_SUMMARY_INPUT_TOKENS, Math.max(1_024, Math.floor(window / 8)));
}

/**
 * Usable conversation input for ONE summarization call: the summarizer's window
 * minus the summary it must emit, the previous summary it carries forward, and
 * prompt scaffolding. Providers tokenize differently from the local cl100k
 * estimate, so the window is discounted before the fixed reserves come off.
 */
function summaryInputBudgetTokens(model: Model, maxTokens: number): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	// 0.8, not "window minus reserves": provider tokenizers disagree with the
	// local cl100k estimate by a few percent, and being wrong here is a hard
	// 400 on the one call that is supposed to rescue an oversized session.
	return Math.max(minSummaryInputTokens(model), Math.floor(window * 0.8) - maxTokens - MAX_SUMMARY_TOKENS);
}

/**
 * Clamp one serialized window to the budget. Only reachable when a SINGLE
 * message serializes above the budget (an oversized paste): the alternative is
 * a provider rejection that no retry can clear, which strands the session with
 * a full window forever.
 */
function clampConversationToBudget(text: string, budgetTokens: number, tokens: number): string {
	if (tokens <= budgetTokens) return text;
	const keep = Math.max(1024, Math.floor((text.length * budgetTokens * 0.95) / tokens));
	if (keep >= text.length) return text;
	return `${text.slice(0, keep)}\n\n[... ${text.length - keep} more characters truncated]`;
}

/** One planned summarization call: its messages and the budget they were packed for. */
interface SummaryWindow {
	messages: Message[];
	budgetTokens: number;
	/** Serialization reused from the fit check, so the common path serializes once. */
	text?: string;
}

/**
 * Partition a conversation into windows that each fit `budgetTokens`, splitting
 * on message boundaries. Only called when the whole conversation does not fit —
 * the common single-window path never pays this per-message sizing pass.
 */
function planSummaryWindows(
	messages: Message[],
	tokenizer: Tokenizer,
	dialect: Dialect | undefined,
	budgetTokens: number,
): Message[][] {
	const windows: Message[][] = [];
	let current: Message[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const tokens = tokenizer.countTokens(serializeConversationForSummary([message], dialect));
		if (currentTokens > 0 && currentTokens + tokens > budgetTokens) {
			windows.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(message);
		currentTokens += tokens;
	}
	if (current.length > 0) windows.push(current);
	return windows;
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), MAX_SUMMARY_TOKENS);

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom app messages when caller provides a transformer).
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(currentMessages);
	const dialect = preferredDialect(model.id);
	const tokenizer = new Tokenizer(model);
	const wholeConversation = serializeConversationForSummary(llmMessages, dialect);
	const budgetTokens = summaryInputBudgetTokens(model, maxTokens);
	// A span that outgrew the summarizer's window is summarized as a fold: each
	// window updates the summary carried out of the previous one, which is the
	// same contract the update prompt already implements for iterative
	// compaction. The alternative is a hard provider rejection on a prompt no
	// retry can shrink — the state a cross-provider compaction boundary
	// (see `prepareCompaction`) puts a long session into. One window is the
	// common case and costs exactly the one call it always did.
	const pending: SummaryWindow[] = tokenizer.checkTokenBudget(wholeConversation, budgetTokens).fits
		? [{ messages: llmMessages, budgetTokens, text: wholeConversation }]
		: planSummaryWindows(llmMessages, tokenizer, dialect, budgetTokens).map(messages => ({ messages, budgetTokens }));

	let carriedSummary = previousSummary;
	while (pending.length > 0) {
		const window = pending[0];
		const text = window.text ?? serializeConversationForSummary(window.messages, dialect);
		// A budget probe, not a raw count: a window whose bytes already fit needs
		// neither an exact count nor the clamp, and the bust path hands back the
		// exact count the proportional clamp needs as its denominator.
		const budget = tokenizer.checkTokenBudget(text, window.budgetTokens);
		try {
			carriedSummary = await summarizeConversationWindow(
				budget.fits ? text : clampConversationToBudget(text, window.budgetTokens, budget.tokens),
				carriedSummary,
				model,
				maxTokens,
				apiKey,
				signal,
				customInstructions,
				options,
			);
		} catch (error) {
			// The catalog window can overstate what the provider actually accepts:
			// `claude-sonnet-4-5` advertises 1M but is beta-gated to 200k on OAuth
			// credentials (see `anthropic.ts` — the 1M beta is never advertised).
			// Halve and re-plan rather than failing the whole compaction on a
			// window size only the provider can tell us is wrong.
			// Halve what was actually SENT, not the budget it was planned against:
			// the rejection proves the plan was fiction, so converging on the real
			// cap must not spend a call per level of an imaginary ladder. The cheap
			// fit path never counted this window, so pay for the exact size here —
			// one tokenization is nothing against the provider round trip already lost.
			const sentTokens = budget.exact ? budget.tokens : tokenizer.countTokens(text, "strict");
			const halved = Math.floor(Math.min(window.budgetTokens, sentTokens) / 2);
			if (
				!AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow) ||
				halved < minSummaryInputTokens(model)
			) {
				throw error;
			}
			pending.splice(
				0,
				1,
				...planSummaryWindows(window.messages, tokenizer, dialect, halved).map(messages => ({
					messages,
					budgetTokens: halved,
				})),
			);
			continue;
		}
		pending.shift();
	}
	return carriedSummary ?? "";
}

/** One summarization call over a single conversation window. */
async function summarizeConversationWindow(
	conversationText: string,
	previousSummary: string | undefined,
	model: Model,
	maxTokens: number,
	apiKey: ApiKey,
	signal: AbortSignal | undefined,
	customInstructions: string | undefined,
	options: SummaryOptions | undefined,
): Promise<string> {
	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${escapeSummaryBoundaryTags(previousSummary)}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	if (options?.remoteEndpoint) {
		const endpoint = options.remoteEndpoint;
		const remote = await withAuth(
			apiKey,
			key =>
				requestRemoteCompaction(
					endpoint,
					{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, prompt: promptText, maxTokens },
					signal,
					{ fetch: options.fetch, model, apiKey: key },
				),
			{ signal, missingKeyMessage: "Remote compaction credentials unavailable" },
		);
		return remote.summary;
	}

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
			providerSessionState: options?.providerSessionState,
			codexCompaction: localCodexCompaction(options),
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_summary",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Summarization failed", response);
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// Handoff generation
// ============================================================================

export interface HandoffOptions {
	/** Live agent system prompt — passed verbatim so providers hit the cached prefix. */
	systemPrompt: string[];
	/** Live agent tool list — same purpose. Forced to `toolChoice: "none"`. */
	tools?: Tool[];
	customInstructions?: string;
	convertToLlm?: ConvertToLlm;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	/**
	 * Optional telemetry handle. When provided, the handoff LLM call is
	 * wrapped in an OTEL chat span tagged with `pi.gen_ai.oneshot.kind = "handoff"`.
	 */
	telemetry?: AgentTelemetry;
	/**
	 * Active session thinking level. Threaded from `agent-session.ts` so
	 * handoff generation honors the user's `/model` thinking selection
	 * instead of silently overriding it with `Effort.High`. See
	 * `resolveCompactionEffort` for the conversion contract.
	 */
	thinkingLevel?: ThinkingLevel;
}

export function renderHandoffPrompt(customInstructions?: string): string {
	if (!customInstructions) return HANDOFF_DOCUMENT_PROMPT;
	return prompt.render(handoffDocumentPrompt, {
		additionalFocus: customInstructions,
	});
}

export interface HandoffFromContextOptions {
	/**
	 * Stream options mirrored from the live agent turn: `apiKey`, `signal`, the
	 * `sessionId`/`promptCacheKey` cache-routing pair, `serviceTier`, and the
	 * session's payload/response hooks. Sending the same routing + payload shape
	 * the main loop uses is what lets the handoff oneshot READ the provider
	 * prompt cache the live turn populated instead of cold-missing the whole
	 * prefix. `reasoning` and `toolChoice` are set internally and override
	 * anything provided here.
	 */
	streamOptions: SimpleStreamOptions;
	/** Optional completion transport override for host-level request wrappers. */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/** See {@link HandoffOptions.telemetry}. */
	telemetry?: AgentTelemetry;
	/** See {@link HandoffOptions.thinkingLevel}. */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Run the handoff oneshot against a fully-built provider {@link Context}.
 *
 * The caller assembles `context` exactly like a live agent turn — same system
 * prompt, normalized tools, transformed + obfuscated message history, with the
 * trailing handoff-prompt message already appended — and supplies
 * `streamOptions` that mirror the live turn's cache routing. That keeps the
 * cache-preserving context construction in the host (which owns the transform
 * pipeline) while this function centralizes the handoff request contract:
 * cache-first `toolChoice: "none"`, clamped reasoning effort, one retry for
 * auto-only `tool_choice` providers, oneshot telemetry, text-only extraction,
 * and provider-error mapping.
 */
export async function generateHandoffFromContext(
	context: Context,
	model: Model,
	options: HandoffFromContextOptions,
): Promise<string> {
	const requestOptions = {
		...options.streamOptions,
		reasoning: resolveCompactionEffort(model, options.thinkingLevel),
		toolChoice: "none" as const,
	};
	let response = await instrumentedCompleteSimple(model, context, requestOptions, {
		telemetry: options.telemetry,
		oneshotKind: "handoff",
		completeImpl: options.completeImpl,
		retry: {},
	});
	if (response.stopReason === "error" && shouldRetryHandoffWithAutoToolChoice(response)) {
		response = await instrumentedCompleteSimple(
			model,
			context,
			{ ...requestOptions, toolChoice: "auto" },
			{ telemetry: options.telemetry, oneshotKind: "handoff", completeImpl: options.completeImpl, retry: {} },
		);
	}

	if (response.stopReason === "error") {
		throw createSummarizationError("Handoff generation failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(options.customInstructions) }],
			attribution: "agent",
			timestamp: Date.now(),
		},
	];

	return generateHandoffFromContext(
		{ systemPrompt: options.systemPrompt, messages: requestMessages, tools: options.tools },
		model,
		{
			streamOptions: {
				apiKey,
				signal,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
			},
			telemetry: options.telemetry,
			thinkingLevel: options.thinkingLevel,
		},
	);
}

async function generateShortSummary(
	recentMessages: AgentMessage[],
	historySummary: string | undefined,
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(512, Math.floor(0.2 * reserveTokens));
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(recentMessages);
	const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (historySummary) {
		promptText += `<previous-summary>\n${escapeSummaryBoundaryTags(historySummary)}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += SHORT_SUMMARY_PROMPT;

	if (options?.remoteEndpoint) {
		const endpoint = options.remoteEndpoint;
		const remote = await withAuth(
			apiKey,
			key =>
				requestRemoteCompaction(
					endpoint,
					{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, prompt: promptText, maxTokens },
					signal,
					{ fetch: options?.fetch, model, apiKey: key },
				),
			{ signal, missingKeyMessage: "Remote compaction credentials unavailable" },
		);
		return remote.summary;
	}

	const response = await instrumentedCompleteSimple(
		model,
		{
			systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT],
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
		},
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
			providerSessionState: options?.providerSessionState,
			codexCompaction: localCodexCompaction(options),
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_short_summary",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Short summary failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

// ============================================================================
// Compaction Preparation (for hooks)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Messages kept in full after compaction (recent history) */
	recentMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

/**
 * Whether a prior remote compaction's provider-native replay can still be read
 * by the active model — the model that assembles the request context on every
 * turn. A local compaction (no remote preserve) always can: it holds a real
 * textual summary. A remote compaction (V2 or V1) only can when the active model
 * shares the blob's provider AND remote replay is still enabled; otherwise the
 * active model's encoder drops the payload (see `getOpenAIResponsesHistoryPayload`)
 * and only the opaque placeholder summary survives, so the caller must re-expand
 * the originals into a portable local summary rather than strand that history.
 *
 * Judged against the ACTIVE model, not the compaction candidate set: a role
 * model (e.g. `modelRoles.smol`) that still maps to the blob's provider does not
 * let the active model replay it, so keying reuse on "any candidate shares the
 * provider" left a provider-switched session permanently context-less (#6343).
 */
export function remotePreserveReusable(
	preserveData: Record<string, unknown> | undefined,
	activeModel: Model,
	settings: CompactionSettings,
): boolean {
	const remote = getCompactionV2PreserveData(preserveData) ?? getPreservedOpenAiRemoteCompactionData(preserveData);
	if (!remote) return true;
	if (settings.remoteEnabled === false) return false;
	if (remote.provider !== activeModel.provider) return false;
	const v2Ok = settings.remoteStreamingV2Enabled !== false && shouldUseCompactionV2Streaming(activeModel);
	return v2Ok || shouldUseOpenAiRemoteCompaction(activeModel);
}

/**
 * Index of the newest compaction entry the active model can actually read, or
 * `-1` when none can.
 *
 * A provider-native remote compaction (V2 or V1) stores an opaque replay payload
 * and only a placeholder summary, so for any OTHER provider that entry
 * summarizes nothing and the history behind it is still live context. Callers
 * must therefore treat it as absent: `prepareCompaction` re-expands past it and
 * summarizes those messages locally, and the maintenance ops that use the
 * compaction boundary to skip "already summarized away" entries must not skip
 * entries that no summary covers.
 */
export function findReadableCompactionIndex(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	activeModel?: Model,
): number {
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type !== "compaction") continue;
		const entry = pathEntries[i] as CompactionEntry;
		if (activeModel && !remotePreserveReusable(entry.preserveData, activeModel, settings)) continue;
		return i;
	}
	return -1;
}

/**
 * Pass the caller's warm `tokenizer` (the Agent's for the active model) so the
 * full-branch estimate walk hits its memo; the cold default is for one-shot
 * callers that have no live agent.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	activeModel?: Model,
	tokenizer: Tokenizer = new Tokenizer(activeModel),
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = findReadableCompactionIndex(pathEntries, settings, activeModel);

	// Honor the latest `/clear` reset boundary. `/clear` records a
	// `reset_boundary` marker and reports the model context empty, so compaction
	// must not resurrect the dropped pre-clear turns into its summary — matching
	// how buildSessionContext starts the model-context rebuild after the boundary.
	// A boundary after the last reusable compaction supersedes it: the pre-reset
	// summary was cleared too, so drop the previous-compaction reuse and start
	// fresh after the boundary. A boundary at or before that compaction is already
	// superseded by it, so only scan newer entries.
	let resetBoundaryIndex = -1;
	for (let i = pathEntries.length - 1; i > prevCompactionIndex; i--) {
		if (pathEntries[i].type === "reset_boundary") {
			resetBoundaryIndex = i;
			break;
		}
	}
	if (resetBoundaryIndex > prevCompactionIndex) {
		prevCompactionIndex = -1;
	}
	const boundaryStart = Math.max(prevCompactionIndex, resetBoundaryIndex) + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, tokenizer, boundaryStart, boundaryEnd);
		const promptTokens = calculatePromptTokens(lastUsage);
		const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, tokenizer, boundaryStart, boundaryEnd, keepRecentTokens);

	// Get ID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Messages kept after compaction (recent history)
	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i]);
		if (msg) recentMessages.push(msg);
	}
	// Nothing to summarize means compaction would be a no-op.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// Get previous summary and preserved data for iterative updates
	let previousSummary: string | undefined;
	let previousPreserveData: Record<string, unknown> | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousPreserveData = prevCompaction.preserveData;
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(compactionTurnPrefixPrompt);
function isCodexResponsesModel(model: Model): model is Model<"openai-codex-responses"> {
	return model.api === "openai-codex-responses";
}

function isCodexInputItem(item: Record<string, unknown>): item is CodexInputItem & Record<string, unknown> {
	return (
		(item.id === undefined || item.id === null || typeof item.id === "string") &&
		(item.type === undefined || item.type === null || typeof item.type === "string") &&
		(item.role === undefined || typeof item.role === "string") &&
		(item.call_id === undefined || item.call_id === null || typeof item.call_id === "string") &&
		(item.name === undefined || typeof item.name === "string")
	);
}

function openAiCompatSupportsImageDetailOriginal(model: Model): boolean {
	const compat = model.compat;
	return !!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === true;
}

function buildOpenAiResponsesCompactionInput(
	messages: Message[],
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	previousReplacementHistory: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> {
	const input = buildResponsesInput({
		model,
		context: { messages },
		strictResponsesPairing: model.compat.strictResponsesPairing,
		supportsImageDetailOriginal: openAiCompatSupportsImageDetailOriginal(model),
		nativeHistory: { replay: true, filterReasoning: false },
		includeThinkingSignatures: true,
		repairOrphanOutputs: true,
	});
	const nativeInput: Array<Record<string, unknown>> = [];
	for (const item of input) {
		if (!isRecord(item)) {
			throw new Error("OpenAI Responses compaction input contains a non-object item");
		}
		nativeInput.push(item);
	}
	return stripOpenAIResponsesOutputOnlyStatusesForReplay(
		previousReplacementHistory ? [...previousReplacementHistory, ...nativeInput] : nativeInput,
	);
}

/**
 * Resolve the Responses `reasoning` param for a V2 compaction request the same
 * way a normal turn does — through {@link resolveOpenAICompatPolicy}, so it
 * honors per-model effort support, `omitReasoningEffort`, disable modes, and the
 * wire-effort mapping. Returns `undefined` for non-reasoning models or when the
 * user selected `Off` (matching the normal-turn omission, not a fabricated shape).
 */
function buildCompactionV2Reasoning(
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	thinkingLevel: ThinkingLevel | undefined,
): { effort: string; summary: string } | undefined {
	const policy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: resolveCompactionEffort(model, thinkingLevel),
	});
	const reasoning = policy.reasoning;
	if (!reasoning.modelSupported || reasoning.disabled || reasoning.omitReasoningEffort) return undefined;
	if (reasoning.requestedEffort === undefined) return undefined;
	return { effort: reasoning.wireEffort ?? reasoning.requestedEffort, summary: "auto" };
}

/**
 * Keep any non-auth native protocol failure ahead of authentication failures.
 * Downstream may retry compaction with another provider only when every native
 * protocol failed authentication, so a later auth error must not hide an
 * earlier transport or protocol failure.
 */
function selectNativeCompactionError(previousError: unknown, nextError: unknown): unknown {
	if (previousError === undefined) return nextError;
	return AIError.is(AIError.classify(previousError), AIError.Flag.AuthFailed) ? nextError : previousError;
}

/**
 * User-facing placeholder summary for a provider-native remote compaction.
 *
 * `inputTokens` is the compaction request's provider-reported input usage
 * (persisted as `openaiRemoteCompaction.usedTokens`), NOT the size of the
 * retained replacement history — so the wording describes processed input, not
 * retained context, to avoid implying the number is the post-compaction size.
 */
function formatRemoteCompactionSummary(inputTokens: number): string {
	return (
		"Remote compaction preserved provider-native history for this session." +
		(inputTokens > 0 ? ` Compaction processed ${inputTokens} input tokens.` : "")
	);
}

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds id/parentId when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const reserveTokens = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEnabled === false ? undefined : settings.remoteEndpoint,
		remoteSystemPrompt: options?.remoteSystemPrompt,
		initiatorOverride: options?.initiatorOverride,
		metadata: options?.metadata,
		convertToLlm: options?.convertToLlm,
		telemetry: options?.telemetry,
		// Honor /model thinking selection on every fan-out summarizer.
		// Without this propagation, generateSummary / generateTurnPrefixSummary
		// see options?.thinkingLevel === undefined and resolveCompactionEffort
		// silently falls back to Effort.High — the same defect e07b47ee4 fixed
		// at the call sites, leaked back in here. See resolveCompactionEffort.
		thinkingLevel: options?.thinkingLevel,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		providerSessionState: options?.providerSessionState,
		preferWebsockets: options?.preferWebsockets,
		codexCompaction: options?.codexCompaction,
		tools: options?.tools,
		fetch: options?.fetch,
		completeImpl: options?.completeImpl,
	};

	const previousSnapcompactArchive = snapcompact.getPreservedArchive(previousPreserveData);
	const previousSnapcompactArchiveText = previousSnapcompactArchive
		? snapcompact.archiveSourceText(previousSnapcompactArchive)
		: undefined;
	const previousSummaryForCompaction = mergePreviousSummaryWithSnapcompactArchive(
		previousSummary,
		previousSnapcompactArchiveText,
	);
	const snapcompactArchiveMigrationMessage = previousSnapcompactArchiveText
		? createSnapcompactArchiveMigrationMessage(previousSnapcompactArchiveText)
		: undefined;

	let preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, undefined);
	const remoteMessages: AgentMessage[] = [
		...(snapcompactArchiveMigrationMessage ? [snapcompactArchiveMigrationMessage] : []),
		...messagesToSummarize,
		...turnPrefixMessages,
		...recentMessages,
	];
	let usedRemoteCompaction = false;
	let nativeCompactionError: unknown;
	if (
		settings.remoteEnabled !== false &&
		settings.remoteStreamingV2Enabled !== false &&
		shouldUseCompactionV2Streaming(model)
	) {
		const previousRemoteCompaction = getCompactionV2PreserveData(previousPreserveData);
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: undefined;
		const messages = (summaryOptions.convertToLlm ?? defaultConvertToLlm)(remoteMessages);
		const remoteSystemPrompt = summaryOptions.remoteSystemPrompt ?? [SUMMARIZATION_SYSTEM_PROMPT];
		let codexBody: OpenAICodexCompactionBody | undefined;
		let remoteHistory: Array<Record<string, unknown>>;
		if (isCodexResponsesModel(model)) {
			const previousCodexInput: CodexInputItem[] = [];
			for (const item of previousReplacementHistory ?? []) {
				if (!isCodexInputItem(item)) {
					throw new Error("Stored Codex V2 compaction history contains an invalid input item");
				}
				previousCodexInput.push(item);
			}
			codexBody = await buildTransformedCodexRequestBody(
				model,
				{ systemPrompt: remoteSystemPrompt, messages, tools: summaryOptions.tools },
				{
					reasoning: resolveCompactionEffort(model, summaryOptions.thinkingLevel),
					forceReasoningOff: summaryOptions.thinkingLevel === ThinkingLevel.Off,
					responsesLite: model.useResponsesLite,
					sessionId: summaryOptions.sessionId,
					promptCacheKey: summaryOptions.promptCacheKey,
					providerSessionState: summaryOptions.providerSessionState,
					codexCompaction: createOpenAICodexCompactionRequestContext({
						context: summaryOptions.codexCompaction,
						implementation: "responses_compaction_v2",
					}),
				},
				undefined,
				previousCodexInput,
			);
			const input = Array.isArray(codexBody.input) ? codexBody.input : [];
			const nativeInput: Array<Record<string, unknown>> = [];
			for (const item of input) {
				if (!isRecord(item)) {
					throw new Error("Codex V2 compaction input contains a non-object item");
				}
				nativeInput.push(item);
			}
			remoteHistory = stripOpenAIResponsesOutputOnlyStatusesForReplay(nativeInput);
			codexBody.input = remoteHistory;
		} else {
			remoteHistory = buildOpenAiResponsesCompactionInput(messages, model, previousReplacementHistory);
		}
		if (remoteHistory.length > 0) {
			try {
				const instructions = codexBody
					? typeof codexBody.instructions === "string"
						? codexBody.instructions
						: ""
					: remoteSystemPrompt.join("\n\n");
				const tools = codexBody
					? Array.isArray(codexBody.tools)
						? codexBody.tools
						: undefined
					: summaryOptions.tools
						? convertTools(summaryOptions.tools, model.compat.supportsStrictMode, model)
						: undefined;
				const trimmed = trimRemoteCompactionInputToContextWindow(
					remoteHistory,
					new Tokenizer(model),
					model.contextWindow,
					instructions,
					tools,
				);
				if (trimmed.rewrittenOutputs > 0) {
					logger.info("Rewrote trailing tool outputs before OpenAI V2 remote compaction", {
						model: model.id,
						provider: model.provider,
						rewrittenOutputs: trimmed.rewrittenOutputs,
						estimatedTokensBefore: trimmed.estimatedTokensBefore,
						estimatedTokensAfter: trimmed.estimatedTokensAfter,
						contextWindow: model.contextWindow,
					});
				}
				const requestOptions = {
					sessionId: summaryOptions.sessionId,
					promptCacheKey: summaryOptions.promptCacheKey,
					retainedMessageBudget: settings.v2RetainedMessageBudget,
				};
				const request = codexBody
					? buildCompactionV2RequestFromBody(model, { ...codexBody, input: trimmed.input }, requestOptions)
					: buildCompactionV2Request(model, trimmed.input, instructions, {
							...requestOptions,
							tools,
							reasoning: buildCompactionV2Reasoning(model, summaryOptions.thinkingLevel),
						});
				const remote = await withAuth(
					apiKey,
					key =>
						requestCompactionV2Streaming(model, key, request, signal, {
							fetch: summaryOptions.fetch,
							providerSessionState: summaryOptions.providerSessionState,
							preferWebsockets: summaryOptions.preferWebsockets,
							codexCompaction: summaryOptions.codexCompaction,
						}),
					{ signal },
				);
				preserveData = { ...preserveData, ...storeCompactionV2PreserveData(remote, model) };
				usedRemoteCompaction = true;
			} catch (err) {
				// A user/session abort is a cancellation, not a remote failure —
				// swallowing it here would downgrade Esc into "fall back to local
				// summarization" and keep compaction running on an aborted signal.
				if (signal?.aborted) throw err;
				nativeCompactionError = selectNativeCompactionError(nativeCompactionError, err);
				logger.warn("OpenAI V2 remote compaction failed, falling back to V1 remote compaction", {
					error: err instanceof Error ? err.message : String(err),
					model: model.id,
					provider: model.provider,
				});
			}
		}
	}

	if (!usedRemoteCompaction && settings.remoteEnabled !== false && shouldUseOpenAiRemoteCompaction(model)) {
		const previousRemoteCompaction = getPreservedOpenAiRemoteCompactionData(previousPreserveData);
		const previousV2Compaction = getCompactionV2PreserveData(previousPreserveData);
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: previousV2Compaction?.provider === model.provider
					? previousV2Compaction.replacementHistory
					: undefined;
		const remoteHistory = buildOpenAiNativeHistory(
			(summaryOptions.convertToLlm ?? defaultConvertToLlm)(remoteMessages),
			model,
			previousReplacementHistory,
			openAiCompatSupportsImageDetailOriginal(model),
		);
		if (remoteHistory.length > 0) {
			try {
				const remote = await withAuth(
					apiKey,
					key =>
						requestOpenAiRemoteCompaction(
							model,
							key,
							remoteHistory,
							summaryOptions.remoteSystemPrompt?.join("\n\n") ?? SUMMARIZATION_SYSTEM_PROMPT,
							signal,
							{
								fetch: summaryOptions.fetch,
								sessionId: summaryOptions.sessionId,
								providerSessionState: summaryOptions.providerSessionState,
								codexCompaction: summaryOptions.codexCompaction,
							},
						),
					{ signal },
				);
				preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, remote);
				usedRemoteCompaction = true;
			} catch (err) {
				// A user/session abort is a cancellation, not a remote failure —
				// swallowing it here would downgrade Esc into "fall back to local
				// summarization" and keep compaction running on an aborted signal.
				if (signal?.aborted) throw err;
				nativeCompactionError = selectNativeCompactionError(nativeCompactionError, err);
				logger.warn("OpenAI remote compaction failed", {
					error: err instanceof Error ? err.message : String(err),
					model: model.id,
					provider: model.provider,
				});
			}
		}
	}

	if (!usedRemoteCompaction && nativeCompactionError !== undefined && !summaryOptions.remoteEndpoint) {
		throw new NativeCompactionError(nativeCompactionError);
	}

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (usedRemoteCompaction) {
		// Remote compaction (V2 or V1) already compacted remotely; the durable
		// history lives in the provider replay payload (preserveData). Skip local
		// summarization so a successful remote compaction never pays for a second,
		// redundant LLM round. If a LATER compaction cannot reuse this payload,
		// prepareCompaction re-expands the original messages and summarizes them
		// locally then (see remotePreserveReusable).
		const inputTokens = getCompactionV2PreserveData(preserveData)?.usedTokens ?? 0;
		summary = formatRemoteCompactionSummary(inputTokens);
	} else if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0 || previousSummaryForCompaction
				? generateSummary(
						messagesToSummarize,
						model,
						reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummaryForCompaction,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, reserveTokens, apiKey, signal, summaryOptions),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		// Generate history summary from messages to summarize
		summary = await generateSummary(
			messagesToSummarize,
			model,
			reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummaryForCompaction,
			summaryOptions,
		);
	} else if (previousSummaryForCompaction) {
		// No new messages to summarize, preserve previous summary
		summary = previousSummaryForCompaction;
	} else {
		// No messages and no previous summary
		summary = "No prior history.";
	}

	const shortSummary = usedRemoteCompaction
		? "Remote compaction"
		: await generateShortSummary(recentMessages, summary, model, reserveTokens, apiKey, signal, {
				...summaryOptions,
				extraContext: options?.extraContext,
				thinkingLevel: options?.thinkingLevel,
			});

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	// This LLM-summary path migrated any prior snapcompact frames into the summary
	// text above; strip the now-stale frame archive from preserveData so it cannot
	// re-attach to the rebuilt context. Only the legacy-frame case needs stripping —
	// when there was no previous archive, preserveData carries no frames to drop.
	const finalPreserveData = previousSnapcompactArchive
		? snapcompact.stripPreservedArchive(preserveData)
		: preserveData;

	return {
		summary,
		shortSummary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData: finalPreserveData,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), MAX_SUMMARY_TOKENS); // Smaller budget for turn prefix

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
			providerSessionState: options?.providerSessionState,
			codexCompaction: localCodexCompaction(options),
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_turn_prefix",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Turn prefix summarization failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
