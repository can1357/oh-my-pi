import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

/**
 * Rule-owned maxima by provider/id/api. Resolve once per process rather than
 * walking the static policy cascade on every catalog rebuild. Null caches the
 * absence of a curated maximum; undefined means the key has not been resolved.
 */
const ruleMaximumCache = new Map<string, number | null>();

/**
 * Extended-context capacity. Curated maxima correct stale lower discovery
 * values; a higher live maximum still wins. The registry applies this capacity
 * only when extended context is enabled, before explicit user overrides.
 */
export function resolveMaxContextWindow(model: Model): number | undefined {
	const key = `${model.provider} ${model.id} ${model.api}`;
	let curated = ruleMaximumCache.get(key);
	if (curated === undefined) {
		const maximum = resolveModelPolicy(toModelSpec(model)).catalog.maxContextWindow;
		curated = typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0 ? maximum : null;
		ruleMaximumCache.set(key, curated);
	}

	const maximum = model.maxContextWindow;
	if (typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0) {
		return Math.max(maximum, curated ?? 0);
	}
	return curated ?? undefined;
}
