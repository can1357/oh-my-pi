import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

/**
 * Rule-owned fallback maxima by `provider/id/api`. The rule table is static
 * per process (compiled into rules.json), so one resolution per model key is
 * enough — composition calls this per model on every rebuild while extended
 * context is enabled, and the full policy resolve (identity classification
 * plus cascade walk) is wasted work per call.
 */
const ruleFallbackCache = new Map<string, number | undefined>();

/**
 * Maximum prompt window for extended context. Live discovery takes precedence
 * over rule-owned fallbacks for older bundled or cached model metadata. Resolve
 * at catalog composition time so frozen bundled rows need no runtime mutation.
 */
export function resolveMaxContextWindow(model: Model): number | undefined {
	const maximum = model.maxContextWindow;
	if (typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0) {
		return maximum;
	}

	const key = `${model.provider} ${model.id} ${model.api}`;
	if (ruleFallbackCache.has(key)) return ruleFallbackCache.get(key);
	const fallback = resolveModelPolicy(toModelSpec(model)).catalog.maxContextWindow;
	const resolved = typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
	ruleFallbackCache.set(key, resolved);
	return resolved;
}
