/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import {
	type ApiKey,
	type AssistantMessage,
	type Context,
	Effort,
	type FetchImpl,
	type Message,
	type MessageAttribution,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type Usage,
	withAuth,
} from "@pk-nerdsaver-ai/pi-ai";
import { ProviderHttpError } from "@pk-nerdsaver-ai/pi-ai/error";
import { preferredDialect } from "@pk-nerdsaver-ai/pi-catalog/identity";
import { clampThinkingLevelForModel } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { logger, prompt } from "@pk-nerdsaver-ai/pi-utils";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import { ThinkingLevel } from "../thinking";
import { countTokens } from "../tokenizer";
import type { AgentMessage } from "../types";
import type { CompactionEntry, SessionEntry } from "./entries";
import { type ConvertToLlm, createBranchSummaryMessage, createCustomMessage, defaultConvertToLlm } from "./messages";
import {
	buildOpenAiNativeHistory,
	getPreservedOpenAiRemoteCompactionData,
	requestOpenAiRemoteCompaction,
	requestRemoteCompaction,
	shouldUseOpenAiRemoteCompaction,
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
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
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
	reserveTokens: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	remoteEnabled?: boolean;
	remoteEndpoint?: string;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1,
	thresholdTokens: -1,
	midTurnEnabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	autoContinue: true,
	remoteEnabled: true,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function calculatePromptTokens(usage: Usage): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
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
 * Effective reserve: at least 15% of context window or the configured floor, whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens);
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

	// Percentage-based threshold
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return contextWindow - effectiveReserveTokens(contextWindow, settings);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Estimate token count for a message using cl100k_base via the native
 * tokenizer. This is not Claude's first-party tokenizer (Anthropic doesn't
 * publish one) but is within ~5–10% across English/code text.
 *
 * `excludeEncryptedReasoning` drops opaque provider reasoning payloads
 * (`thinkingSignature`, `redactedThinking`) from the estimate. Those are billed
 * by the provider on replay, so the default counts them — but their *local*
 * byte size can diverge wildly from what the provider charges, so the
 * compaction floor (which only needs the reliably-countable, on-wire-compressible
 * content) excludes them to avoid false triggers on thinking-heavy turns.
 */
export function estimateTokens(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	const fragments: string[] = [];
	let extra = 0;
	if ((message as { role?: string }).role === "bashExecution") {
		const bash = message as { command?: unknown; output?: unknown };
		if (typeof bash.command === "string") fragments.push(bash.command);
		if (typeof bash.output === "string") fragments.push(bash.output);
		return fragments.length === 0 ? 0 : countTokens(fragments);
	}

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				fragments.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					}
				}
			}
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					fragments.push(block.text);
				} else if (block.type === "thinking") {
					fragments.push(block.thinking);
					// Providers charge for the opaque signature/reasoning payload that
					// rides alongside the thinking text (OpenAI Responses encrypted
					// reasoning items, Anthropic signed thinking blocks, etc.). Without
					// counting it, this estimator can read ~half of the provider-reported
					// usage on thinking-heavy turns — see #2275 for the resulting
					// compaction-trigger / post-check metric divergence. The compaction
					// floor excludes it (its local byte size diverges from provider billing).
					if (block.thinkingSignature && !options?.excludeEncryptedReasoning) {
						fragments.push(block.thinkingSignature);
					}
				} else if (block.type === "toolCall") {
					fragments.push(block.name);
					fragments.push(JSON.stringify(block.arguments));
				} else if (block.type === "redactedThinking") {
					// Encrypted reasoning blob the provider still bills for on replay;
					// excluded from the compaction floor for the same reason as above.
					if (!options?.excludeEncryptedReasoning) fragments.push(block.data);
				}
			}
			break;
		}
		case "hookMessage":
		case "toolResult": {
			if (typeof message.content === "string") {
				fragments.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			fragments.push(message.summary);
			if (message.role === "compactionSummary") {
				if (message.blocks) {
					for (const block of message.blocks) {
						if (block.type === "text") fragments.push(block.text);
						else extra += snapcompact.FRAME_TOKEN_ESTIMATE;
					}
				} else if (message.images) {
					// Snapcompact frames render at ≥1568px; providers bill the downscaled cap.
					extra += message.images.length * snapcompact.FRAME_TOKEN_ESTIMATE;
				}
			}
			break;
		}
		default:
			return 0;
	}

	if (fragments.length === 0) return extra;
	return extra + countTokens(fragments);
}

function estimateEntriesTokens(entries: SessionEntry[], startIndex: number, endIndex: number): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i]);
		if (msg) {
			total += estimateTokens(msg);
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
		const messageTokens = estimateTokens(entry.message);
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
	return response.errorStatus === undefined ? new Error(text) : new ProviderHttpError(text, response.errorStatus);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	remoteInstructions?: string;
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
	/** Optional fetch implementation threaded into remote compaction calls. */
	fetch?: FetchImpl;
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
	const maxTokens = Math.floor(0.8 * reserveTokens);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom app messages when caller provides a transformer).
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(currentMessages);
	const conversationText = serializeConversation(llmMessages, preferredDialect(model.id));

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
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
		const remote = await requestRemoteCompaction(
			options.remoteEndpoint,
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				prompt: promptText,
			},
			signal,
			{ fetch: options.fetch },
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
		},
		{ telemetry: options?.telemetry, oneshotKind: "compaction_summary" },
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
 * `toolChoice: "none"`, clamped reasoning effort, oneshot telemetry, text-only
 * extraction, and provider-error mapping.
 */
export async function generateHandoffFromContext(
	context: Context,
	model: Model,
	options: HandoffFromContextOptions,
): Promise<string> {
	const response = await instrumentedCompleteSimple(
		model,
		context,
		{
			...options.streamOptions,
			reasoning: resolveCompactionEffort(model, options.thinkingLevel),
			toolChoice: "none",
		},
		{ telemetry: options.telemetry, oneshotKind: "handoff" },
	);

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
	const conversationText = serializeConversation(llmMessages, preferredDialect(model.id));

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (historySummary) {
		promptText += `<previous-summary>\n${historySummary}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += SHORT_SUMMARY_PROMPT;

	if (options?.remoteEndpoint) {
		const remote = await requestRemoteCompaction(
			options.remoteEndpoint,
			{
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				prompt: promptText,
			},
			signal,
			{ fetch: options?.fetch },
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
		},
		{ telemetry: options?.telemetry, oneshotKind: "compaction_short_summary" },
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

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, boundaryStart, boundaryEnd);
		const promptTokens = calculatePromptTokens(lastUsage);
		const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens);

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

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEnabled === false ? undefined : settings.remoteEndpoint,
		remoteInstructions: options?.remoteInstructions,
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
		fetch: options?.fetch,
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
	if (settings.remoteEnabled !== false && shouldUseOpenAiRemoteCompaction(model)) {
		const previousRemoteCompaction = getPreservedOpenAiRemoteCompactionData(previousPreserveData);
		const remoteMessages: AgentMessage[] = [
			...(snapcompactArchiveMigrationMessage ? [snapcompactArchiveMigrationMessage] : []),
			...messagesToSummarize,
			...turnPrefixMessages,
			...recentMessages,
		];
		const previousReplacementHistory =
			previousRemoteCompaction?.provider === model.provider
				? previousRemoteCompaction.replacementHistory
				: undefined;
		const remoteHistory = buildOpenAiNativeHistory(
			(summaryOptions.convertToLlm ?? defaultConvertToLlm)(remoteMessages),
			model,
			previousReplacementHistory,
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
							summaryOptions.remoteInstructions ?? SUMMARIZATION_SYSTEM_PROMPT,
							signal,
							{ fetch: summaryOptions.fetch },
						),
					{ signal },
				);
				preserveData = withOpenAiRemoteCompactionPreserveData(previousPreserveData, remote);
			} catch (err) {
				// A user/session abort is a cancellation, not a remote failure —
				// swallowing it here would downgrade Esc into "fall back to local
				// summarization" and keep compaction running on an aborted signal.
				if (signal?.aborted) throw err;
				logger.warn("OpenAI remote compaction failed, falling back to local summarization", {
					error: err instanceof Error ? err.message : String(err),
					model: model.id,
					provider: model.provider,
				});
			}
		}
	}

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0 || previousSummaryForCompaction
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummaryForCompaction,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal, summaryOptions),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		// Generate history summary from messages to summarize
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
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

	const shortSummary = await generateShortSummary(
		recentMessages,
		summary,
		model,
		settings.reserveTokens,
		apiKey,
		signal,
		{
			extraContext: options?.extraContext,
			remoteEndpoint: summaryOptions.remoteEndpoint,
			initiatorOverride: summaryOptions.initiatorOverride,
			metadata: summaryOptions.metadata,
			telemetry: summaryOptions.telemetry,
			// Same propagation as summaryOptions above — generateShortSummary
			// resolves its own reasoning via resolveCompactionEffort.
			thinkingLevel: options?.thinkingLevel,
			fetch: summaryOptions.fetch,
		},
	);

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
	const maxTokens = Math.floor(0.5 * reserveTokens); // Smaller budget for turn prefix

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversation(llmMessages, preferredDialect(model.id));
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
		},
		{ telemetry: options?.telemetry, oneshotKind: "compaction_turn_prefix" },
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Turn prefix summarization failed", response);
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
