import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

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

	const fallback = resolveModelPolicy(toModelSpec(model)).catalog.maxContextWindow;
	return typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
}
