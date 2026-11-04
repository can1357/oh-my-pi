/**
 * Prompt-cache cost of an automatic shake.
 *
 * A shake edits history behind the provider's cache breakpoints, so the next
 * request misses the cache from the first edit on and writes the rest of the
 * prompt to the cache again. What the shake buys is a smaller prompt: every
 * later request reads fewer cached tokens. A threshold shake runs only when
 * that saving, over the requests it takes the context to grow back, is at
 * least the premium of the rewrite over reading the same tokens from the cache.
 *
 * Every rate is taken from the model's own catalog entry at the size of the
 * request that pays it, so a model with size-tiered prices (a long-context
 * rate above some prompt size) prices both sides of the comparison on the same
 * tier.
 */

import { calculatePromptTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { SessionEntry } from "./session-entries";

export interface ShakeCacheCostInput {
	model: Model;
	/** Tokens the shake removes from the request the provider receives. */
	tokensFreed: number;
	/** Tokens the next request writes to the prompt cache again because of the shake. */
	rewriteTokens: number;
	/** Size of the next request, which decides the model's rate tier. */
	requestTokens: number;
	/** Mean tokens one request adds to the context on this branch; undefined when not measured. */
	growthPerRequest: number | undefined;
	/**
	 * Retention tier the next request writes, or undefined when it writes no
	 * cache entry: then nothing is cached, the shake invalidates nothing, and
	 * the smaller prompt is a saving with no premium against it.
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
	const { model, tokensFreed, rewriteTokens, requestTokens, growthPerRequest, cacheTier } = input;
	const requestsToRegrow =
		growthPerRequest !== undefined && growthPerRequest > 0 ? tokensFreed / growthPerRequest : undefined;
	// Rates at the size of the request that pays them, so a size-tiered model
	// prices the rewrite and the saving on the same tier. A request of this size
	// is what each component is billed inside.
	const size = Math.max(1, requestTokens);
	const readRate = calculateCost(model, tokenUsage({ cacheRead: size })).cacheRead / size;
	// This provider writes no cache entry for the next request, so the shake
	// invalidates nothing: no premium, and every later request is simply smaller.
	if (cacheTier === undefined || readRate <= 0) {
		return { rewritePremium: 0, readSavings: Number.POSITIVE_INFINITY, requestsToRegrow, pays: true };
	}
	// `calculateCost` prices a long-retention write from the model's input rate;
	// the flat catalog `cacheWrite` rate is the short-tier one. A model with no
	// cache-write price bills a missed prefix as plain input.
	const writeRate =
		model.cost.cacheWrite > 0
			? calculateCost(
					model,
					tokenUsage({ cacheWrite: size, cttl: cacheTier === "long" ? { ephemeral1h: size } : undefined }),
				).cacheWrite / size
			: calculateCost(model, tokenUsage({ input: size })).input / size;
	const rewritePremium = Math.max(0, (writeRate - readRate) * rewriteTokens);
	// Unmeasured growth leaves the saving unknown: nothing shows the shake loses.
	if (requestsToRegrow === undefined) {
		return { rewritePremium, readSavings: Number.POSITIVE_INFINITY, requestsToRegrow, pays: true };
	}
	const readSavings = readRate * tokensFreed * requestsToRegrow;
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
