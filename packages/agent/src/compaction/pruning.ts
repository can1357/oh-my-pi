/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Tokenizer } from "../tokenizer";
import type { AgentMessage, AgentToolCall } from "../types";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";
import { splitReadSelector } from "./utils";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/**
	 * Optional supersede key function (see {@link SupersedePruneConfig.supersedeKey}).
	 * When provided, superseded tool results are pruned first — even inside the
	 * `protectTokens` window — before age-based victims. Absent, behavior is
	 * unchanged.
	 */
	supersedeKey?: SupersedeKeyFn;
	/** Useless-flagged results bypass the protect window (see {@link USELESS_NOTICE}). Default true. */
	pruneUseless?: boolean;
	/**
	 * Compaction boundary: the `firstKeptEntryId` of the latest compaction on
	 * the branch. Entries at indices BEFORE this id are summarized away and never
	 * sent to the model, so mutating them only churns persisted history without
	 * shrinking the prompt — they are skipped. Undefined = no compaction (the
	 * whole branch is sent).
	 */
	keepBoundaryId?: string;
	/**
	 * Prompt-cache guard. When set, a tool result whose all-message suffix
	 * (tokens of every message after it) EXCEEDS this is part of the warm,
	 * already-sent cache prefix: mutating it forces the provider to re-write the
	 * whole suffix (cacheWrite premium). Such results — including superseded and
	 * useless ones, which otherwise bypass {@link protectTokens} — are left for
	 * compaction/shake (which rebuild the cache anyway) to reclaim. Undefined =
	 * no cache guard (legacy: superseded/useless prune at any depth).
	 */
	cacheWarmSuffixTokens?: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: ["skill", isSkillReadToolResult],
	pruneUseless: true,
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/**
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which every result except the newest is a supersede candidate. A key `K`
 * additionally supersedes keys with prefix `K + "\u0000"` (selector-free read
 * supersedes selector-carrying reads of the same base path). Return
 * `undefined` to exempt a call from supersede grouping.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

export interface SupersedePruneConfig {
	/** Supersede key function; results sharing a key supersede older ones. */
	supersedeKey?: SupersedeKeyFn;
	/** Also prune results flagged useless by their tool. Default false. */
	pruneUseless?: boolean;
	/** Prune a candidate now when all messages after it total at most this many estimated tokens. Default 8 000. */
	suffixTokenLimit?: number;
	/**
	 * Prune all candidates when the last message is at least this old: the
	 * provider prompt cache is then cold, so re-writing it is free. MUST exceed
	 * the cache retention (Anthropic "long" = 1h) or a still-warm prefix is busted
	 * by the flush. Default 30 min — callers on long retention override it.
	 */
	idleFlushMs?: number;
	/** Clock override for tests. */
	now?: number;
	/**
	 * Compaction boundary (`firstKeptEntryId` of the latest compaction). Entries
	 * before it are summarized away and never sent, so they are skipped in every
	 * path — including the idle flush — to avoid pointless history churn.
	 * Undefined = no compaction (the whole branch is sent).
	 */
	keepBoundaryId?: string;
	/** Tool-result protection matchers (same contract as {@link PruneConfig.protectedTools}). */
	protectedTools: ProtectedToolMatcher[];
}

const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;
const DEFAULT_IDLE_FLUSH_MS = 30 * 60_000;

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

/**
 * Generic age-based pruning floor. Below this, blanking a result to
 * `[Output truncated - N tokens]` recovers nothing — the placeholder itself
 * costs ~8 tokens, so a sub-floor result grows the context (and churns the
 * prompt cache) instead of shrinking it. Superseded/useless results keep their
 * own rules: useless already drops no-savings candidates, superseded prunes for
 * correctness regardless of size.
 */
const MIN_PRUNE_TOKENS = 50;

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

/**
 * For each entry index, the estimated token total of all *message* entries
 * strictly after it — how much prompt-cache content the provider must re-write
 * (cacheWrite premium) if that entry is mutated in place. Used to keep prune
 * mutations inside the cheap-to-recache tail.
 */
function computeMessageSuffixTokens(entries: readonly SessionEntry[], tokenizer: Tokenizer): number[] {
	const suffix = new Array<number>(entries.length);
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		suffix[i] = accumulated;
		const entry = entries[i];
		if (entry.type === "message") accumulated += tokenizer.countMessage(entry.message as AgentMessage);
	}
	return suffix;
}

/**
 * Resolve the array index of the compaction boundary (`keepBoundaryId`). Entries
 * before this index are summarized away by the latest compaction and never sent,
 * so prune passes must not mutate them. Returns 0 when there is no boundary (no
 * compaction → whole branch is sent) or the id is absent from `entries`.
 */
function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	const index = entries.findIndex(entry => entry.id === keepBoundaryId);
	return index < 0 ? 0 : index;
}

interface SupersedeCandidate {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
	/** Index of the entry within the `entries` array. */
	index: number;
	tokens: number;
	/** Placeholder text written over the blanked result. */
	notice: string;
}

/**
 * Collect superseded tool results: for every unpruned, unprotected tool result
 * whose paired call resolves a supersede key, a LATER result with the same key
 * — or with a key that is the `"\u0000"`-prefix parent of this one — marks it
 * superseded. Returned in message order.
 */
function collectSupersededResults(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	supersedeKey: SupersedeKeyFn,
	protectedTools: readonly ProtectedToolMatcher[],
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	const seenKeys = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCallsById.get(message.toolCallId);
		if (!toolCall) continue;
		if (isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const key = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
		if (key === undefined) continue;
		const separator = key.indexOf("\u0000");
		const superseded = seenKeys.has(key) || (separator >= 0 && seenKeys.has(key.slice(0, separator)));
		seenKeys.add(key);
		if (!superseded) continue;
		candidates.push({
			entry: entry as SessionMessageEntry,
			message,
			index: i,
			tokens: tokenizer.countMessage(message as AgentMessage),
			notice: SUPERSEDED_NOTICE,
		});
	}
	return candidates.reverse();
}

/**
 * Collect tool results their tool flagged contextually useless (zero matches,
 * elapsed wait): unpruned, non-error, unprotected, not in `exclude`, and large
 * enough that blanking to {@link USELESS_NOTICE} actually saves tokens.
 * Returned in message order.
 */
function collectUselessResults(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (message?.useless !== true || message.prunedAt !== undefined || message.isError === true) continue;
		if (exclude.has(message)) continue;
		if (isProtectedToolResult(message, toolCallsById.get(message.toolCallId), protectedTools)) continue;
		const tokens = tokenizer.countMessage(message as AgentMessage);
		if (estimatePrunedSavings(tokens, USELESS_NOTICE) <= 0) continue;
		candidates.push({ entry: entry as SessionMessageEntry, message, index: i, tokens, notice: USELESS_NOTICE });
	}
	return candidates;
}

/**
 * Prune superseded tool results (e.g. stale `read` outputs replaced by a newer
 * read of the same file) and, when `pruneUseless` is set, results their tool
 * flagged contextually useless. Cheap, incremental, and prompt-cache-aware: a
 * candidate is pruned now only when the suffix after it is small (tail case —
 * the read→edit→read loop) or when the context has been idle long enough that
 * the provider cache is cold anyway (then all still-sent candidates flush).
 * Never mutates entries before `keepBoundaryId` (summarized away — not sent).
 */
export function pruneSupersededToolResults(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	config: SupersedePruneConfig,
): PruneResult {
	const toolCallsById = collectToolCallsById(entries);
	const candidates = config.supersedeKey
		? collectSupersededResults(entries, tokenizer, toolCallsById, config.supersedeKey, config.protectedTools)
		: [];
	if (config.pruneUseless) {
		const exclude = new Set(candidates.map(candidate => candidate.message));
		candidates.push(...collectUselessResults(entries, tokenizer, toolCallsById, config.protectedTools, exclude));
		candidates.sort((a, b) => a.index - b.index);
	}
	if (candidates.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const now = config.now ?? Date.now();
	let lastMessageTimestamp: number | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp === "number") lastMessageTimestamp = timestamp;
		break;
	}
	const idle =
		lastMessageTimestamp !== undefined && now - lastMessageTimestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);

	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);

	let toPrune: SupersedeCandidate[];
	if (idle) {
		// Provider cache is cold (idle exceeds the retention TTL), so re-writing
		// the sent region costs nothing. Entries before the compaction boundary
		// are summarized away and never sent — skip them to avoid pointless churn.
		toPrune = candidates.filter(candidate => candidate.index >= boundaryIndex);
	} else {
		const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
		// suffixTokens[i] = estimated tokens of all messages strictly after entry i.
		// Mutating a candidate re-writes its suffix in the warm cache, so prune only
		// when that suffix is small (cheap-to-recache tail) and the candidate sits
		// at/after the compaction boundary.
		const suffixTokens = computeMessageSuffixTokens(entries, tokenizer);
		toPrune = candidates.filter(
			candidate => candidate.index >= boundaryIndex && suffixTokens[candidate.index] <= suffixTokenLimit,
		);
	}
	if (toPrune.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const prunedAt = Date.now();
	let tokensSaved = 0;
	for (const candidate of toPrune) {
		candidate.message.content = [{ type: "text", text: candidate.notice }];
		candidate.message.prunedAt = prunedAt;
		invalidateMessageCache(candidate.message as AgentMessage);
		tokensSaved += estimatePrunedSavings(candidate.tokens, candidate.notice);
	}
	return { prunedCount: toPrune.length, tokensSaved };
}

export function pruneToolOutputs(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number; superseded: boolean; useless: boolean }> = [];
	const toolCallsById = collectToolCallsById(entries);
	const supersededMessages = config.supersedeKey
		? new Set(
				collectSupersededResults(entries, tokenizer, toolCallsById, config.supersedeKey, config.protectedTools).map(
					candidate => candidate.message,
				),
			)
		: undefined;
	const uselessMessages =
		config.pruneUseless !== false
			? new Set(
					collectUselessResults(
						entries,
						tokenizer,
						toolCallsById,
						config.protectedTools,
						supersededMessages ?? new Set(),
					).map(candidate => candidate.message),
				)
			: undefined;

	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	// All-message suffix per index, only when the cache guard is armed.
	const messageSuffix =
		cacheWarmSuffixTokens === undefined ? undefined : computeMessageSuffixTokens(entries, tokenizer);

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = tokenizer.countMessage(message as AgentMessage);
		const isProtected = isProtectedToolResult(message, toolCallsById.get(message.toolCallId), config.protectedTools);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		// Prompt-cache guard: a result whose all-message suffix exceeds the
		// warm-cache window sits in the already-sent cached prefix — mutating it
		// re-writes the whole suffix (cacheWrite premium). Entries before the
		// compaction boundary are summarized away (never sent). Both are skipped
		// before any prune decision, so superseded/useless cannot reach a deep,
		// still-cached copy; compaction/shake reclaim those when they rebuild.
		const inWarmPrefix =
			messageSuffix !== undefined && cacheWarmSuffixTokens !== undefined && messageSuffix[i] > cacheWarmSuffixTokens;
		if (inWarmPrefix || i < boundaryIndex) {
			accumulatedTokens += tokens;
			continue;
		}

		// Superseded and useless results bypass the age-based protect window
		// (a stale re-read copy, or a result the tool flagged as uninformative,
		// is dead weight at any age) — but only within the cache-warm tail: the
		// guard above already excluded deeper, still-cached copies.
		const superseded = supersededMessages?.has(message) ?? false;
		const useless = uselessMessages?.has(message) ?? false;
		const tooSmall = tokens < MIN_PRUNE_TOKENS;
		if (!superseded && !useless && (accumulatedTokens < config.protectTokens || isProtected || tooSmall)) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens, superseded, useless });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(
			candidate.tokens,
			candidate.superseded
				? SUPERSEDED_NOTICE
				: candidate.useless
					? USELESS_NOTICE
					: createPrunedNotice(candidate.tokens),
		);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		const notice = candidate.superseded
			? SUPERSEDED_NOTICE
			: candidate.useless
				? USELESS_NOTICE
				: createPrunedNotice(candidate.tokens);
		message.content = [{ type: "text", text: notice }];
		message.prunedAt = prunedAt;
		invalidateMessageCache(message as AgentMessage);
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}

/**
 * Supersede key for the `read` tool: the file path with the trailing line/raw
 * selector stripped (the read tool's own splitter grammar via
 * {@link splitReadSelector}, e.g. `src/foo.ts:50-200`, `:2-4:raw`).
 * Internal/URL-scheme paths (`skill://…`, `https://…`) are exempt.
 * Selector-free reads key on the bare path; selector-carrying reads key on
 * `path + "\u0000" + selector`, so two reads collide only when the newer is
 * selector-free or the selectors are identical (the pass's prefix rule lets a
 * bare-path read supersede selector-carrying reads of the same file).
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	return sel === undefined ? base : `${base}\u0000${sel}`;
}
