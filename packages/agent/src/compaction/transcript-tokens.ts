/**
 * Provider-anchored transcript token accounting.
 *
 * Local tokenization is the expensive way to answer "how big is this
 * conversation?" — and usually the wrong one, because the provider already
 * answered it. Every settled assistant turn carries `usage` covering the exact
 * prompt it was sent: the system prompt, the tool schemas, and every message up
 * to and including itself. The only genuinely unaccounted-for text is the tail
 * appended *after* that turn.
 *
 * These helpers locate the newest trustworthy usage report and tokenize only
 * that tail, so a long session pays counting proportional to one turn instead
 * of to the whole transcript, every turn.
 *
 * Trust rules for an anchor (mirroring the provider contract):
 * - Assistant role only — nothing else carries `usage`.
 * - Not `aborted` / `error`: those turns report partial or zero usage.
 * - `hasContextTokenUsage(usage)`: the report must carry usable context numbers.
 */

import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import type { MessageCountOptions, Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import { calculateContextTokens, hasContextTokenUsage } from "./compaction";

/** A provider usage report that accounts for a prefix of the transcript. */
export interface TranscriptUsageAnchor {
	/** Index in the scanned array; messages at or before it are provider-accounted. */
	index: number;
	/** The anchoring assistant turn. */
	message: AssistantMessage;
	/** Conversation tokens the provider reported for that prompt. */
	tokens: number;
}

/**
 * Whether this message's provider usage may anchor transcript accounting.
 *
 * The single home for the trust rules — every anchor scan MUST route through
 * it so a stale-usage rule can never drift between the transcript walkers and
 * the session-entry walkers.
 */
export function isTranscriptUsageAnchor(message: AgentMessage): message is AssistantMessage {
	if (message.role !== "assistant") return false;
	const assistant = message as AssistantMessage;
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return false;
	return assistant.usage !== undefined && hasContextTokenUsage(assistant.usage);
}

/**
 * Newest `prunedAt` in `messages`, or `-Infinity` when nothing was pruned.
 *
 * A pruned tool result was rewritten in place, so every usage report made at
 * or before this time still counts the removed bytes.
 */
function newestPrunedAt(messages: readonly AgentMessage[]): number {
	let rewriteAt = Number.NEGATIVE_INFINITY;
	for (const message of messages) {
		if (message.role === "toolResult" && message.prunedAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.prunedAt);
		}
	}
	return rewriteAt;
}

/** Options for {@link findTranscriptUsageAnchor}. */
export interface TranscriptUsageAnchorOptions {
	/**
	 * Also treat usage reported at or before the newest `prunedAt` as stale,
	 * the same rule {@link findRequestUsageAnchor} applies to request contexts.
	 */
	skipPrunedAnchors?: boolean;
}

/**
 * Newest assistant turn in `messages[fromIndex..]` whose usage can anchor the
 * transcript, or `undefined` when none qualifies (fresh context, or every
 * recent turn aborted/errored).
 *
 * `fromIndex` excludes turns whose usage is stale — anything a compaction
 * summarized away describes a prompt that is no longer sent.
 */
export function findTranscriptUsageAnchor(
	messages: readonly AgentMessage[],
	fromIndex = 0,
	options?: TranscriptUsageAnchorOptions,
): TranscriptUsageAnchor | undefined {
	const rewriteAt = options?.skipPrunedAnchors === true ? newestPrunedAt(messages) : Number.NEGATIVE_INFINITY;
	for (let index = messages.length - 1; index >= fromIndex; index--) {
		const message = messages[index];
		if (!isTranscriptUsageAnchor(message) || message.timestamp <= rewriteAt) continue;
		return { index, message, tokens: calculateContextTokens(message.usage) };
	}
	return undefined;
}

/**
 * Newest assistant turn in a provider request's `messages` whose usage still
 * describes the prefix it sits on, or `undefined` when none does.
 *
 * Request contexts carry no compaction index, so staleness is read from the
 * rewrite markers themselves: a compaction/branch summary or pruned tool result
 * (`prunedAt`) replaced text that every report made at or before the rewrite
 * already counted. A summary's rewrite time is its `timestamp` (commit time);
 * its `historyRewriteAt` may be predated before a natively replayed retained
 * tail so that tail's bound thinking survives, but the tail's usage still
 * counted the summarized prefix.
 */
export function findRequestUsageAnchor(messages: readonly Message[]): TranscriptUsageAnchor | undefined {
	let rewriteAt = Number.NEGATIVE_INFINITY;
	let anchorIndex = -1;
	let anchor: AssistantMessage | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user" && message.historyRewriteAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.historyRewriteAt, message.timestamp);
		} else if (message.role === "toolResult" && message.prunedAt !== undefined) {
			rewriteAt = Math.max(rewriteAt, message.prunedAt);
		} else if (isTranscriptUsageAnchor(message) && message.timestamp > rewriteAt) {
			anchorIndex = index;
			anchor = message;
		}
	}
	return anchor && { index: anchorIndex, message: anchor, tokens: calculateContextTokens(anchor.usage) };
}

/** Options for {@link estimateTranscriptTokens}. */
export interface TranscriptTokenOptions {
	/**
	 * Gates the anchor search only: usage at or before this index is stale (a
	 * compaction rewrote the prompt it describes) and must not anchor. Content
	 * accounting is governed separately by {@link countFromIndex}.
	 */
	anchorFromIndex?: number;
	/** Forwarded to {@link findTranscriptUsageAnchor}. */
	skipPrunedAnchors?: boolean;
	/**
	 * First message whose content is counted locally when no anchor is found.
	 * Defaults to 0 (count the whole transcript), which is what a floor
	 * estimate wants; pass the compaction boundary to skip summarized-away
	 * messages entirely.
	 */
	countFromIndex?: number;
	/** Forwarded to {@link Tokenizer.countMessage} for every locally counted message. */
	excludeEncryptedReasoning?: boolean;
}

/**
 * Conversation tokens for `messages`: the provider's own report for everything
 * it already covers, plus a local count of only the unaccounted-for tail.
 *
 * An anchored result already includes the non-message prefix (system prompt +
 * tool schemas) because the provider charged it; an unanchored result is a
 * message-only sum. Callers that add non-message tokens on top MUST branch on
 * {@link findTranscriptUsageAnchor} rather than assuming one shape.
 */
export function estimateTranscriptTokens(
	messages: readonly AgentMessage[],
	tokenizer: Tokenizer,
	options?: TranscriptTokenOptions,
): number {
	const estimateOptions: MessageCountOptions | undefined =
		options?.excludeEncryptedReasoning === true ? { excludeEncryptedReasoning: true } : undefined;
	const anchor = findTranscriptUsageAnchor(messages, options?.anchorFromIndex ?? 0, {
		skipPrunedAnchors: options?.skipPrunedAnchors,
	});
	let total = anchor?.tokens ?? 0;
	for (let index = anchor ? anchor.index + 1 : (options?.countFromIndex ?? 0); index < messages.length; index++) {
		total += tokenizer.countMessage(messages[index], estimateOptions);
	}
	return total;
}
