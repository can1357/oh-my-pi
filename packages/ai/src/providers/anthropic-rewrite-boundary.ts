import { resolvePromptCacheLookback } from "@oh-my-pi/pi-catalog/compat/prompt-cache-lookback";
import type { Message, Model } from "../types";
import type { MessageParam } from "./anthropic-wire";

/**
 * Marks a tool_result wire message that carries a history rewrite no request
 * has billed yet. Symbol-keyed so the mark never reaches the wire and never
 * persists across the JSONL round-trip.
 */
const kUnbilledRewrite = Symbol("anthropic.message.unbilledRewrite");

/** Carries the unbilled-rewrite mark without exposing a string-keyed property. */
type UnbilledRewriteCarrier = object & { [kUnbilledRewrite]?: true };

/**
 * Billing cutoff for history rewrites: the newest assistant timestamp in
 * `messages`. A rewrite whose `prunedAt` is older was already sent by the
 * request that produced that turn; that request paid for it and wrote its own
 * tail entry, which every later tail reaches.
 */
export function rewritesBilledThrough(messages: readonly Message[]): number {
	let billedThrough = Number.NEGATIVE_INFINITY;
	for (const message of messages) {
		if (message.role === "assistant" && message.timestamp > billedThrough) billedThrough = message.timestamp;
	}
	return billedThrough;
}

/** Marks `target` when `source` was rewritten after `billedThrough` (see `rewritesBilledThrough`). */
export function markUnbilledRewrite(
	target: UnbilledRewriteCarrier,
	source: { readonly prunedAt?: number },
	billedThrough: number,
): void {
	if (source.prunedAt !== undefined && source.prunedAt >= billedThrough) target[kUnbilledRewrite] = true;
}

/** Whether a wire content block can carry `cache_control` (shared with `applyCacheControlToLastBlock`). */
export type AcceptsCacheControl = (block: Exclude<MessageParam["content"], string>[number]) => boolean;

/** Index of the block that receives a message breakpoint's `cache_control`, or -1 when none can. */
function cacheControlBlockIndex(message: MessageParam, acceptsCacheControl: AcceptsCacheControl): number {
	const content = message.content;
	if (typeof content === "string") return 0;
	for (let index = content.length - 1; index >= 0; index--) {
		if (acceptsCacheControl(content[index])) return index;
	}
	return -1;
}

/**
 * Cache-lookback positions from just after the `cache_control` block of
 * `messages[after]` (exclusive; `after < 0` starts at the first message)
 * through the `cache_control` block of `messages[through]` (inclusive): one per
 * content block, except that a run of consecutive `tool_use` blocks, or of
 * consecutive `tool_result` blocks, is one position.
 */
function countLookbackPositions(
	messages: readonly MessageParam[],
	after: number,
	through: number,
	acceptsCacheControl: AcceptsCacheControl,
): number {
	let positions = 0;
	let previousType: string | undefined;
	for (let index = Math.max(after, 0); index <= through; index++) {
		const message = messages[index];
		if (!message) continue;
		const content = typeof message.content === "string" ? [{ type: "text" }] : message.content;
		// Without a cc-capable block, use the whole message: start at its first
		// block and end at its last, which overstates the distance (adds breakpoints).
		const ccIndex = cacheControlBlockIndex(message, acceptsCacheControl);
		const first = index === after ? ccIndex + 1 : 0;
		const last = index === through && ccIndex >= 0 ? ccIndex : content.length - 1;
		for (let blockIndex = first; blockIndex <= last; blockIndex++) {
			const type = content[blockIndex].type;
			if (type === previousType && (type === "tool_use" || type === "tool_result")) continue;
			positions++;
			previousType = type;
		}
	}
	return positions;
}

/**
 * Message breakpoints a history rewrite adds after the trailing one, highest
 * priority first; `applyPromptCaching` decorates them while its budget lasts,
 * ahead of the decimation anchors.
 *
 * An in-place rewrite (advisor stale-result eviction, shake, snapcompact
 * retracts, tool-output pruning) changes every prefix hash from the first
 * rewritten message on. The region starts at the earliest message among all
 * unbilled rewrites (`markUnbilledRewrite`); rewrites a previous request
 * already sent never count. The tail breakpoint then has to look back past
 * the whole region for a live entry. The model's prompt cache checks a fixed
 * number of block positions behind a breakpoint, the breakpoint included
 * (catalog `prompt-cache-lookback`; Claude: 20). Past that the lookup falls
 * back to the previous explicit breakpoint and everything in between is
 * re-billed at the cache-write premium.
 *
 * The boundary is the last message before the region that `isAnchorable`
 * accepts (the filter `applyPromptCaching` applies to its trailing
 * candidates). The nearest entry that can still be live ends the message
 * before it: the tail an earlier request wrote before the boundary turn was
 * generated. Spans run between `cache_control` blocks (the last block
 * `acceptsCacheControl` admits; trailing thinking is outside them). The tail
 * reaches that entry while fewer positions than the lookback separate it from
 * the tail's block; then nothing is added. Otherwise a breakpoint on the
 * boundary has its own lookback and limits the re-bill to the bytes after the
 * entry it finds. That entry lives for the TTL `getCacheControl` picks; when it
 * has expired the boundary only writes a fresh one. The boundary is needed by
 * this request alone: its tail entry covers the rewrite for every later
 * request, and the rewrite counts as billed from then on.
 *
 * The newest decimation anchor before the region (`decimationCheckpoints`
 * yields them newest first) is refreshed by every request, so it is a
 * guaranteed hit. When it sits within the lookback behind the boundary, the
 * boundary's lookup reaches its entry and the boundary ranks first; when it
 * sits farther back, the anchor ranks ahead of the boundary. Anchors inside
 * or after the region rank below the boundary.
 *
 * Returns nothing when there is no trailing breakpoint (`tail`), no unbilled
 * rewrite before it, no anchorable message before the region, or the model
 * has no known lookback.
 */
export function rewriteBoundaryBreakpoints(
	messages: readonly (MessageParam & UnbilledRewriteCarrier)[],
	tail: number | undefined,
	model: Model,
	isAnchorable: (message: MessageParam) => boolean,
	acceptsCacheControl: AcceptsCacheControl,
	decimationCheckpoints: Iterable<number>,
): number[] {
	if (tail === undefined) return [];
	let regionStart = 0;
	while (regionStart <= tail && messages[regionStart]?.[kUnbilledRewrite] !== true) regionStart++;
	if (regionStart > tail) return [];
	let boundary = regionStart - 1;
	for (; boundary >= 0; boundary--) {
		const message = messages[boundary];
		if (message && isAnchorable(message)) break;
	}
	if (boundary < 0) return [];
	const lookback = resolvePromptCacheLookback(model);
	if (lookback === undefined || countLookbackPositions(messages, boundary - 1, tail, acceptsCacheControl) < lookback)
		return [];
	for (const checkpoint of decimationCheckpoints) {
		if (checkpoint >= regionStart) continue;
		return countLookbackPositions(messages, checkpoint, boundary, acceptsCacheControl) < lookback
			? [boundary]
			: [checkpoint, boundary];
	}
	return [boundary];
}
