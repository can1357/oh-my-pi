import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveCatalogAxes } from "./resolve";

const lookbackCache = new Map<string, number | null>();
const LOOKBACK_CACHE_MAX = 8192;

/**
 * Block positions the provider's prompt cache checks back from a breakpoint for
 * an earlier request's entry (`prompt-cache-lookback` axis), or `undefined` when
 * the model has no known lookback bound.
 */
export function resolvePromptCacheLookback(model: Model): number | undefined {
	const key = `${model.provider} ${model.id} ${model.api}`;
	let lookback = lookbackCache.get(key);
	if (lookback === undefined) {
		const value = resolveCatalogAxes(toModelSpec(model)).promptCacheLookback;
		lookback = typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
		if (lookbackCache.size >= LOOKBACK_CACHE_MAX) lookbackCache.clear();
		lookbackCache.set(key, lookback);
	}
	return lookback ?? undefined;
}
