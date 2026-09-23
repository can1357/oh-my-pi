/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { Api, ApiKey, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { preferredDialect } from "@oh-my-pi/pi-catalog/identity";
import { prompt } from "@oh-my-pi/pi-utils";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import type { ReadonlySessionManager, SessionEntry } from "./entries";
import {
	type ConvertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	defaultConvertToLlm,
} from "./messages";
import branchSummaryPrompt from "./prompts/branch-summary.md" with { type: "text" };
import branchSummaryPreamble from "./prompts/branch-summary-preamble.md" with { type: "text" };
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	truncateToolResultForSummary,
	upsertFileOperations,
} from "./utils";

// ============================================================================
// Types
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model;
	/** API key for the model */
	apiKey: ApiKey;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
	/** Optional metadata forwarded to the underlying API request (e.g. user_id for session attribution). */
	metadata?: Record<string, unknown>;
	/** Convert app-specific messages before serializing the branch summary prompt. */
	convertToLlm?: ConvertToLlm;
	/**
	 * Optional telemetry handle. When provided, the branch summary LLM call is
	 * wrapped in an OTEL chat span tagged with `pi.gen_ai.oneshot.kind = "branch_summary"`.
	 */
	telemetry?: AgentTelemetry;
	/**
	 * Optional completion transport override (same contract as
	 * {@link SummaryOptions.completeImpl}). Lets the host route the branch
	 * summary HTTP request through its provider-concurrency limiter instead
	 * of the default `completeSimple` transport.
	 */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map(e => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// Useless non-error tool results are dropped by serializeConversation()
			// downstream. Skip them here so a large useless payload can't eat the
			// branch-summary token budget and starve older useful entries.
			if (entry.message.role === "toolResult" && entry.message.useless === true && entry.message.isError !== true) {
				return undefined;
			}
			return entry.message;

		case "custom_message":
			return createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.attribution,
			);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, {
				shortSummary: entry.shortSummary,
			});

		// These don't contribute to conversation content
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "service_tier_change":
		case "ttsr_injection":
		case "session_init":
		case "mode_change":
			return undefined;
	}
}

function estimateBranchSummaryTokens(message: AgentMessage, tokenizer: Tokenizer): number {
	if (message.role !== "toolResult") return tokenizer.countMessage(message);
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("");
	if (!text) return 0;
	return tokenizer.countMessage({
		...message,
		content: [{ type: "text", text: truncateToolResultForSummary(text) }],
	});
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	tokenBudget: number = 0,
): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromExtension !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromExtension && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateBranchSummaryTokens(message, tokenizer);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = prompt.render(branchSummaryPreamble);

const BRANCH_SUMMARY_PROMPT = prompt.render(branchSummaryPrompt);

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, signal, customInstructions, reserveTokens = 16384, metadata } = options;

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;
	const tokenizer = new Tokenizer(model);

	const { messages, fileOps } = prepareBranchEntries(entries, tokenizer, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));

	// Build prompt
	const instructions = customInstructions || BRANCH_SUMMARY_PROMPT;
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// Call LLM for summarization
	let response: AssistantMessage;
	try {
		response = await instrumentedCompleteSimple(
			model,
			{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
			{ apiKey, signal, maxTokens: 2048, metadata },
			{ telemetry: options.telemetry, oneshotKind: "branch_summary", completeImpl: options.completeImpl, retry: {} },
		);
	} catch (error) {
		if (signal.aborted) return { aborted: true };
		throw error;
	}

	// Check if aborted or errored
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	// Prepend preamble to provide context about the branch summary
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
