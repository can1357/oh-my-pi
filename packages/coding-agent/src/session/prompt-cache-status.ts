/**
 * What the next request finds in the prompt cache, for the status line's
 * `cache` chip and its details. Display only: nothing here changes a request.
 */
import { isPromptCachePersistent } from "@oh-my-pi/pi-catalog/compat/prompt-cache-persistent";
import type { PromptCacheColdReason, PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import type { CacheWarmingStatus, ConfirmedPromptCacheEntry } from "./cache-warmer";

/**
 * A cache entry the session knows of: confirmed by a response this process saw, or inferred from the transcript.
 * A replaced transcript is read off its own branch instead, so no `history` change reaches here.
 */
export interface ObservedPromptCacheEntry extends Omit<ConfirmedPromptCacheEntry, "change"> {
	change?: Exclude<PromptCacheColdReason, { kind: "expired" | "refresh-missed" }>;
	inferred: boolean;
}

export interface PromptCacheStatusInputs {
	nowMs: number;
	/** The warmer's state for a confirmed entry; absent for an inferred one. */
	warming?: CacheWarmingStatus;
	/** Estimated prompt tokens of the next request. */
	nextTokens: number;
}

/**
 * Status of `entry` at `nowMs`; undefined when its model declares no lifetime
 * for the tier and the provider does not keep entries forever. A lapsed
 * lifetime is the reason whenever it holds: it is certain, and a change in the
 * next request only matters while the entry would otherwise still be live. A
 * refresh in flight holds expiry off: it was sent before the entry lapsed and
 * moves the touch once it hits.
 */
export function promptCacheStatus(
	entry: ObservedPromptCacheEntry,
	inputs: PromptCacheStatusInputs,
): PromptCacheStatus | undefined {
	const persistent = isPromptCachePersistent(entry.model);
	const ttlMs = persistent ? undefined : entry.ttlMs;
	if (!persistent && ttlMs === undefined) return undefined;
	const warming = persistent ? undefined : inputs.warming;
	let reason: PromptCacheColdReason | undefined;
	if (ttlMs !== undefined && warming?.state !== "refreshing") {
		const expiresAt = entry.touchedAt + ttlMs;
		if (inputs.nowMs >= expiresAt) reason = { kind: "expired", at: expiresAt };
	}
	reason ??= entry.change ?? (entry.refreshMissed ? { kind: "refresh-missed" } : undefined);
	return {
		state: reason ? "cold" : "warm",
		reason,
		inferred: entry.inferred,
		tier: entry.tier,
		touchedAt: entry.touchedAt,
		ttlMs,
		cachedTokens: entry.promptTokens,
		nextTokens: inputs.nextTokens,
		warming: warming && {
			state: warming.state,
			nextWarmAt: warming.state === "scheduled" ? warming.nextWarmAt : undefined,
			stopsAt: warming.stopsAt,
			reason: warming.reason,
		},
	};
}
