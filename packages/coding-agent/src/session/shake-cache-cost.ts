/**
 * Prompt-cache cost of an automatic shake.
 *
 * A shake edits history behind the provider's cache breakpoints, so the next
 * request misses the cache from the first edit on and writes the rest of the
 * prompt to the cache again. What the shake buys is a smaller prompt: every
 * later request reads `tokensFreed` fewer cached tokens. A threshold shake runs
 * only when that saving, over the requests it takes the context to grow back to
 * where it was, is at least the premium of the rewrite over reading the same
 * tokens from the cache.
 */

import { calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { SessionEntry } from "./session-entries";

export interface ShakeCacheCostInput {
	model: Model;
	/** Tokens the shake removes from every later request. */
	tokensFreed: number;
	/** Tokens the next request writes to the prompt cache again because of the shake. */
	rewriteTokens: number;
	/** Mean tokens one request adds to the context on this branch; undefined when not measured. */
	growthPerRequest: number | undefined;
	/**
	 * Retention tier the next request writes, or undefined when it writes no
	 * cache entry (caching off): then every request pays full input and a shake
	 * adds no write of its own.
	 */
	cacheTier: "short" | "long" | undefined;
}

export interface ShakeCacheCost {
	/** Cost of writing `rewriteTokens` again, less the cost of reading them from the cache. */
	rewritePremium: number;
	/** Cache reads the freed tokens no longer cost before the context grows back by `tokensFreed`. */
	readSavings: number;
	/** Requests the context takes to grow back by `tokensFreed`; undefined when growth is not measured. */
	requestsToRegrow: number | undefined;
	/** Whether the shake saves at least what its rewrite costs. */
	pays: boolean;
}

function tokenUsage(fields: Partial<Usage>): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...fields,
	};
}

/** Price a shake's rewrite against the cache reads it saves, at the model's own rates. */
export function priceShakeCacheCost(input: ShakeCacheCostInput): ShakeCacheCost {
	const { model, tokensFreed, rewriteTokens, growthPerRequest, cacheTier } = input;
	const requestsToRegrow =
		growthPerRequest !== undefined && growthPerRequest > 0 ? tokensFreed / growthPerRequest : undefined;
	if (cacheTier === undefined) {
		return { rewritePremium: 0, readSavings: 0, requestsToRegrow, pays: true };
	}
	const readCost = calculateCost(model, tokenUsage({ cacheRead: rewriteTokens })).cacheRead;
	// `calculateCost` prices a long-retention write from the model's input rate;
	// the flat catalog `cacheWrite` rate is the short-tier one.
	const cttl: Usage["cttl"] = cacheTier === "long" ? { ephemeral1h: rewriteTokens } : undefined;
	// A provider without a cache-write price bills a missed prefix as plain input.
	const writeCost =
		model.cost.cacheWrite > 0
			? calculateCost(model, tokenUsage({ cacheWrite: rewriteTokens, cttl })).cacheWrite
			: calculateCost(model, tokenUsage({ input: rewriteTokens })).input;
	const rewritePremium = Math.max(0, writeCost - readCost);
	// Unmeasured growth leaves the saving unknown: nothing shows the shake loses.
	if (requestsToRegrow === undefined) {
		return { rewritePremium, readSavings: Number.POSITIVE_INFINITY, requestsToRegrow, pays: true };
	}
	const freedReadCost = calculateCost(model, tokenUsage({ cacheRead: tokensFreed })).cacheRead;
	const readSavings = freedReadCost * requestsToRegrow;
	return { rewritePremium, readSavings, requestsToRegrow, pays: readSavings >= rewritePremium };
}

/**
 * Mean prompt-token growth between consecutive requests on `entries`, or
 * undefined without two comparable requests. A prompt smaller than the one
 * before it follows a history rewrite, not growth, so that pair is left out.
 */
export function measurePromptGrowthPerRequest(entries: readonly SessionEntry[]): number | undefined {
	let previous: number | undefined;
	let total = 0;
	let pairs = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const prompt = calculatePromptTokens(message.usage);
		if (prompt <= 0) continue;
		if (previous !== undefined && prompt >= previous) {
			total += prompt - previous;
			pairs++;
		}
		previous = prompt;
	}
	return pairs > 0 ? total / pairs : undefined;
}
