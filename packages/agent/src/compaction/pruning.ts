/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { Tokenizer } from "../tokenizer";
import type { AgentMessage, AgentToolCall } from "../types";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";
import { type ConvertToLlm, defaultConvertToLlm, getMessageFromEntry } from "./messages";
import {
	collectToolCallsById,
	getToolResultMessage,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";
import { isAlternateFormReadSelector, splitReadSelector } from "./utils";

/** Bound warm-cache pruning by the provider's prompt-cache lookback window. */
export interface CacheLookbackConfig {
	/**
	 * Prompt-cache lookback of the model the next request goes to, in block
	 * positions (catalog `prompt-cache-lookback`; Anthropic: 20). When set,
	 * warm-cache pruning also leaves a result whose rewrite would put the next
	 * request's cache lookup out of reach, whatever its token suffix (see
	 * `cacheLookbackFloor`). Undefined = no lookback bound.
	 */
	cacheLookbackPositions?: number;
	/**
	 * Projects context messages to what the provider receives, so lookback
	 * positions count app roles (file mentions, command output, custom
	 * messages) as sent. Default {@link defaultConvertToLlm}.
	 */
	convertToLlm?: ConvertToLlm;
}

export interface PruneConfig extends CacheLookbackConfig {
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
	/** Whether a keyed result shows its whole target (see {@link SupersedePruneConfig.supersedeComplete}). */
	supersedeComplete?: SupersedeCompleteFn;
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
	 * compaction/shake (which rebuild the cache anyway) to reclaim, as are
	 * results beyond {@link CacheLookbackConfig.cacheLookbackPositions}. Undefined =
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
	/**
	 * Restore every result this pass blanked. Pruning mutates entries in place,
	 * so a caller whose persistence of the pruned history fails calls this to keep
	 * memory matching what is durable.
	 */
	undo(): void;
}

const NOTHING_PRUNED: PruneResult = { prunedCount: 0, tokensSaved: 0, undo: () => {} };

/** Blank `message` to `notice`, returning the step that restores it. */
function blankToolResult(message: ToolResultMessage, notice: string, prunedAt: number): () => void {
	const { content, prunedAt: previousPrunedAt } = message;
	message.content = [{ type: "text", text: notice }];
	message.prunedAt = prunedAt;
	invalidateMessageCache(message as AgentMessage);
	return () => {
		message.content = content;
		message.prunedAt = previousPrunedAt;
		invalidateMessageCache(message as AgentMessage);
	};
}

/** Combine per-message restore steps into one {@link PruneResult.undo}. */
function undoAll(steps: Array<() => void>): () => void {
	return () => {
		for (const step of steps) step();
	};
}

/** Exact placeholder written over a superseded tool result. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/**
 * Maps a tool call to a supersede key. Results sharing a key form a group in
 * which a newer successful result supersedes every older one. A key `K` also
 * covers keys with prefix `K + "\u0000"`: they are superseded only when the
 * newest successful result for `K` is complete (see
 * {@link SupersedeCompleteFn}). Return `undefined` to exempt a call from
 * supersede grouping.
 */
export type SupersedeKeyFn = (toolName: string, args: Record<string, unknown>) => string | undefined;

/**
 * Whether a successful keyed result shows its whole target, so a result for a
 * parent key (e.g. a selector-free read) may supersede child-key results (e.g.
 * range reads). A summary, truncated page, or notice is not complete.
 */
export type SupersedeCompleteFn = (message: ToolResultMessage) => boolean;

export interface SupersedePruneConfig extends CacheLookbackConfig {
	/** Supersede key function; a newer successful result with the same key supersedes older ones (see {@link SupersedeKeyFn}). */
	supersedeKey?: SupersedeKeyFn;
	/**
	 * Whether a successful keyed result is complete. Absent, every successful
	 * result is complete. Child-key results are superseded only when the parent
	 * key's newest successful result is complete; same-key results follow
	 * newest-wins, since a same-key re-read that shows a different view means
	 * the target changed. A failed result supersedes only older failed results.
	 *
	 * Trade-off, by design: after `read foo.ts:50-200` → edit → a bare
	 * `read foo.ts` that returns a summary, the pre-edit range stays in context
	 * until a complete bare read or a same-range re-read. Keeping possibly stale
	 * detail is preferred over losing detail the summary does not show.
	 */
	supersedeComplete?: SupersedeCompleteFn;
	/** Also prune results flagged useless by their tool. Default false. */
	pruneUseless?: boolean;
	/**
	 * Prune a candidate now when all messages after it total at most this many
	 * estimated tokens and it sits within
	 * {@link CacheLookbackConfig.cacheLookbackPositions}. Default 8 000.
	 */
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

/**
 * Positions kept free for the next request's own input (prompt, date/cwd
 * reminder, attachments) and for request projections the count below does not
 * model (orphan-result notes, replayed compaction file metadata, tool-change
 * controls): with Anthropic's 20, stored history gets at most 13.
 */
const RESERVED_LOOKBACK_POSITIONS = 6;

type LookbackBlock = "tool_use" | "tool_result" | undefined;

/**
 * Index of the oldest tool result that can be rewritten while the next request
 * still reaches a cache entry, given the model's prompt-cache `lookback` in
 * block positions (a breakpoint counts itself; a run of consecutive `tool_use`
 * blocks, or of consecutive `tool_result` blocks, is one position). A
 * conservative estimate, not an exact count: a skipped prune costs its tokens,
 * a missed lookup the whole cache.
 *
 * Each request writes its tail cache entry at its last block, so rewriting a
 * result invalidates every entry from its issuing assistant turn on, and once a
 * request has 15 user turns its other breakpoint sits on an older decimation
 * checkpoint. The next request's tail breakpoint then reaches the newest
 * surviving entry, which ends the message before the issuing turn, only when
 * the issuing turn, its tool-result batch, everything after and the next input
 * fit in the lookback window; otherwise the lookup falls back to that
 * checkpoint and the whole conversation since is re-written, not the small
 * suffix the token limits budget for. Each entry is projected through
 * `convertToLlm` and counted the way the Anthropic request converter emits it.
 */
function cacheLookbackFloor(
	entries: readonly SessionEntry[],
	start: number,
	lookback: number | undefined,
	convertToLlm: ConvertToLlm,
): number {
	if (lookback === undefined) return start;
	let positions = RESERVED_LOOKBACK_POSITIONS;
	let later: LookbackBlock;
	let runHoistsImages = false;
	let newerIsAssistant = false;
	const add = (block: LookbackBlock): void => {
		if (block === undefined || block !== later) positions++;
		later = block;
	};
	let floor = entries.length;
	for (let i = entries.length - 1; i >= start; i--) {
		const message = getMessageFromEntry(entries[i]);
		const sent = message === undefined ? [] : convertToLlm([message]);
		for (let m = sent.length - 1; m >= 0; m--) {
			const llm = sent[m];
			if (llm.role === "toolResult") {
				if (later !== "tool_result") runHoistsImages = false;
				add("tool_result");
				// Anthropic rejects images in error results, so the converter moves
				// them after the result run behind one explanatory text block.
				let images = 0;
				if (llm.isError) {
					for (const block of llm.content) if (block.type === "image") images++;
				}
				if (images > 0) {
					positions += runHoistsImages ? images : images + 1;
					runHoistsImages = true;
				}
				newerIsAssistant = false;
			} else if (llm.role === "assistant") {
				// The converter pads consecutive assistant turns with a user turn and
				// drops assistant images, blank text, and turns left empty.
				let pad = newerIsAssistant;
				for (let b = llm.content.length - 1; b >= 0; b--) {
					const block = llm.content[b];
					if (block.type === "image" || (block.type === "text" && block.text.trim().length === 0)) continue;
					if (pad) {
						add(undefined);
						pad = false;
					}
					add(block.type === "toolCall" ? "tool_use" : undefined);
					newerIsAssistant = true;
				}
			} else {
				// The converter drops blank user/developer turns.
				const blocks =
					typeof llm.content === "string" ? (llm.content.trim().length > 0 ? 1 : 0) : llm.content.length;
				if (blocks === 0) continue;
				for (let b = blocks; b > 0; b--) add(undefined);
				newerIsAssistant = false;
			}
		}
		if (positions >= lookback) return floor;
		if (message?.role === "assistant") floor = i;
	}
	return start;
}

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
export const MIN_PRUNE_TOKENS = 50;

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

/**
 * Resolve the array index of the compaction boundary (`keepBoundaryId`). Entries
 * before this index are summarized away by the latest compaction and never sent,
 * so prune passes must not mutate them. Returns 0 when there is no boundary (no
 * compaction → whole branch is sent) or the id is absent from `entries`.
 */
function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].id === keepBoundaryId) return i;
	}
	return 0;
}

/**
 * Tool-call lookup for results in the sent region `entries[start, end)`.
 * Calls there are indexed eagerly; the summarized-away prefix is indexed only
 * on the first miss, so lookups match a whole-branch scan while the common
 * case never walks history the boundary already excludes.
 */
class SentToolCalls {
	readonly #entries: readonly SessionEntry[];
	readonly #start: number;
	readonly #sent: Map<string, AgentToolCall>;
	#prefix: Map<string, AgentToolCall> | undefined;

	constructor(entries: readonly SessionEntry[], start: number) {
		this.#entries = entries;
		this.#start = start;
		this.#sent = collectToolCallsById(entries, start);
	}

	get(id: string): AgentToolCall | undefined {
		const call = this.#sent.get(id);
		if (call !== undefined || this.#start === 0) return call;
		this.#prefix ??= collectToolCallsById(this.#entries, 0, this.#start);
		return this.#prefix.get(id);
	}
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
 * Newer results of one key. An entry exists once any newer result (even a
 * failed one) was seen. `complete` describes the newest successful result
 * only: older successes of the key are superseded, so they cannot vouch for
 * child keys.
 */
interface NewerResults {
	success: boolean;
	complete: boolean;
}

/**
 * Collect superseded tool results: for every unpruned, unprotected tool result
 * whose paired call resolves a supersede key, a LATER successful result of the
 * same key supersedes it, as does its `"\u0000"`-prefix parent key when that
 * key's newest successful result is complete. A failed result supersedes only
 * older failed results; an older failed result is superseded by any later
 * result of its key or a later successful result of its parent key.
 */
function collectSupersededResults(
	entries: readonly SessionEntry[],
	start: number,
	tokenizer: Tokenizer,
	toolCalls: SentToolCalls,
	supersedeKey: SupersedeKeyFn,
	supersedeComplete: SupersedeCompleteFn | undefined,
	protectedTools: readonly ProtectedToolMatcher[],
): SupersedeCandidate[] {
	// Walk newest → oldest: supersession only depends on NEWER results, so
	// stopping at `start` yields exactly the full scan's candidates at/after it.
	const candidates: SupersedeCandidate[] = [];
	const newerByKey = new Map<string, NewerResults>();
	for (let i = entries.length - 1; i >= start; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message || message.prunedAt !== undefined) continue;
		const toolCall = toolCalls.get(message.toolCallId);
		if (!toolCall) continue;
		if (isProtectedToolResult(message, toolCall, protectedTools)) continue;
		const key = supersedeKey(toolCall.name, toolCall.arguments as Record<string, unknown>);
		if (key === undefined) continue;
		const separator = key.indexOf("\u0000");
		const sameKey = newerByKey.get(key);
		const parent = separator >= 0 ? newerByKey.get(key.slice(0, separator)) : undefined;
		const superseded = message.isError
			? sameKey !== undefined || parent?.success === true
			: sameKey?.success === true || parent?.complete === true;
		const newer = sameKey ?? { success: false, complete: false };
		if (!message.isError && !newer.success) {
			newer.success = true;
			newer.complete = supersedeComplete?.(message) ?? true;
		}
		newerByKey.set(key, newer);
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
	start: number,
	tokenizer: Tokenizer,
	toolCalls: SentToolCalls,
	protectedTools: readonly ProtectedToolMatcher[],
	exclude: ReadonlySet<ToolResultMessage>,
): SupersedeCandidate[] {
	const candidates: SupersedeCandidate[] = [];
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (message?.useless !== true || message.prunedAt !== undefined || message.isError === true) continue;
		if (exclude.has(message)) continue;
		if (isProtectedToolResult(message, toolCalls.get(message.toolCallId), protectedTools)) continue;
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
 * Never mutates entries before `keepBoundaryId` (summarized away — not sent),
 * and never walks them unless a sent result's call lives there.
 */
export function pruneSupersededToolResults(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	config: SupersedePruneConfig,
): PruneResult {
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const toolCalls = new SentToolCalls(entries, boundaryIndex);
	const candidates = config.supersedeKey
		? collectSupersededResults(
				entries,
				boundaryIndex,
				tokenizer,
				toolCalls,
				config.supersedeKey,
				config.supersedeComplete,
				config.protectedTools,
			)
		: [];
	if (config.pruneUseless) {
		const exclude = new Set(candidates.map(candidate => candidate.message));
		for (const candidate of collectUselessResults(
			entries,
			boundaryIndex,
			tokenizer,
			toolCalls,
			config.protectedTools,
			exclude,
		)) {
			candidates.push(candidate);
		}
		candidates.sort((a, b) => a.index - b.index);
	}
	if (candidates.length === 0) return NOTHING_PRUNED;

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

	let toPrune: SupersedeCandidate[];
	if (idle) {
		// Provider cache is cold (idle exceeds the retention TTL), so re-writing
		// the sent region costs nothing. Candidates already start at the
		// compaction boundary (summarized-away entries are never sent).
		toPrune = candidates;
	} else {
		// Mutating a candidate re-writes its suffix (tokens of every message
		// strictly after it) in the warm cache, so prune only when that suffix is
		// small and the next request's cache lookup stays in reach. The suffix
		// only grows walking back, so stop at the first index past either limit
		// instead of measuring the whole branch.
		const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
		const lookbackFloor = cacheLookbackFloor(
			entries,
			boundaryIndex,
			config.cacheLookbackPositions,
			config.convertToLlm ?? defaultConvertToLlm,
		);
		toPrune = [];
		let suffixTokens = 0;
		let next = candidates.length - 1;
		for (let i = entries.length - 1; next >= 0 && suffixTokens <= suffixTokenLimit && i >= lookbackFloor; i--) {
			while (next >= 0 && candidates[next].index === i) toPrune.push(candidates[next--]);
			const entry = entries[i];
			if (entry.type === "message") suffixTokens += tokenizer.countMessage(entry.message as AgentMessage);
		}
		toPrune.reverse();
	}
	if (toPrune.length === 0) return NOTHING_PRUNED;

	let tokensSaved = 0;
	for (const candidate of toPrune) tokensSaved += estimatePrunedSavings(candidate.tokens, candidate.notice);

	const prunedAt = Date.now();
	const steps = toPrune.map(candidate => blankToolResult(candidate.message, candidate.notice, prunedAt));
	return { prunedCount: toPrune.length, tokensSaved, undo: undoAll(steps) };
}

export function pruneToolOutputs(
	entries: readonly SessionEntry[],
	tokenizer: Tokenizer,
	config: PruneConfig = DEFAULT_PRUNE_CONFIG,
): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number; superseded: boolean; useless: boolean }> = [];
	// Entries before the compaction boundary are summarized away (never sent)
	// and are never prune candidates, so no pass below walks them.
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const toolCalls = new SentToolCalls(entries, boundaryIndex);
	const supersededMessages = config.supersedeKey
		? new Set(
				collectSupersededResults(
					entries,
					boundaryIndex,
					tokenizer,
					toolCalls,
					config.supersedeKey,
					config.supersedeComplete,
					config.protectedTools,
				).map(candidate => candidate.message),
			)
		: undefined;
	const uselessMessages =
		config.pruneUseless !== false
			? new Set(
					collectUselessResults(
						entries,
						boundaryIndex,
						tokenizer,
						toolCalls,
						config.protectedTools,
						supersededMessages ?? new Set(),
					).map(candidate => candidate.message),
				)
			: undefined;

	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	const lookbackFloor =
		cacheWarmSuffixTokens === undefined
			? boundaryIndex
			: cacheLookbackFloor(
					entries,
					boundaryIndex,
					config.cacheLookbackPositions,
					config.convertToLlm ?? defaultConvertToLlm,
				);
	// Tokens of every message strictly after entry `i` (cache guard only).
	let messageSuffix = 0;

	for (let i = entries.length - 1; i >= boundaryIndex; i--) {
		const entry = entries[i];
		const suffixAfter = messageSuffix;
		const message = getToolResultMessage(entry);
		if (!message) {
			if (cacheWarmSuffixTokens !== undefined && entry.type === "message") {
				messageSuffix += tokenizer.countMessage(entry.message as AgentMessage);
			}
			continue;
		}

		const tokens = tokenizer.countMessage(message as AgentMessage);
		messageSuffix += tokens;

		// Prompt-cache guard: a result whose all-message suffix exceeds the
		// warm-cache window sits in the already-sent cached prefix — mutating it
		// re-writes the whole suffix (cacheWrite premium), or the whole
		// conversation once the next request's cache lookup is out of reach.
		// Both only worsen walking back, so every older result is in the warm
		// prefix too. Deeper, still-cached superseded/useless copies are left for
		// compaction/shake.
		if (cacheWarmSuffixTokens !== undefined && (suffixAfter > cacheWarmSuffixTokens || i < lookbackFloor)) break;

		if (message.prunedAt !== undefined) {
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
		if (
			!superseded &&
			!useless &&
			(accumulatedTokens < config.protectTokens ||
				tooSmall ||
				isProtectedToolResult(message, toolCalls.get(message.toolCallId), config.protectedTools))
		) {
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
		return NOTHING_PRUNED;
	}

	const prunedAt = Date.now();
	const steps = candidates.map(candidate => {
		const notice = candidate.superseded
			? SUPERSEDED_NOTICE
			: candidate.useless
				? USELESS_NOTICE
				: createPrunedNotice(candidate.tokens);
		return blankToolResult(candidate.entry.message as ToolResultMessage, notice, prunedAt);
	});

	return { prunedCount: candidates.length, tokensSaved, undo: undoAll(steps) };
}

/**
 * Supersede key for the `read` tool: the file path with the trailing line/raw
 * selector stripped (the read tool's own splitter grammar via
 * {@link splitReadSelector}, e.g. `src/foo.ts:50-200`, `:2-4:raw`).
 * Internal/URL-scheme paths (`skill://…`, `https://…`) are exempt.
 * Selector-free reads key on the bare path; line-range reads key on
 * `path + "\u0000" + selector`, so a complete bare-path read can supersede them.
 * `raw` and `conflicts` reads show a different form than a plain read (e.g. raw
 * notebook JSON vs converted notebook text), so they key on
 * `path + "\u0001" + selector` and are superseded only by the same selector.
 */
export function readToolSupersedeKey(toolName: string, args: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const path = args.path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	if (path.includes("://")) return undefined;
	const { path: base, sel } = splitReadSelector(path);
	if (sel === undefined) return base;
	return `${base}${isAlternateFormReadSelector(sel) ? "\u0001" : "\u0000"}${sel}`;
}
