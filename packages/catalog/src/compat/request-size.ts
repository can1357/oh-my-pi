import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveCatalogAxes } from "./resolve";

const imageBudgetCache = new Map<string, number | null>();
const IMAGE_BUDGET_CACHE_MAX = 8192;

/**
 * Maximum encoded inline-image bytes retained per request for a deployment with a documented body-size limit.
 * The axis is a host contract: a rerouted `baseUrl` (proxy, gateway) imposes its own limit, so the budget
 * applies only while the model targets its official endpoint.
 */
export function resolveInlineImageByteBudget(model: Model): number | undefined {
	const compat = model.compat;
	if (!compat || !("officialEndpoint" in compat) || !compat.officialEndpoint) return undefined;
	const key = `${model.provider} ${model.id} ${model.api}`;
	let budget = imageBudgetCache.get(key);
	if (budget === undefined) {
		const value = resolveCatalogAxes(toModelSpec(model)).inlineImageByteBudget;
		budget = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
		if (imageBudgetCache.size >= IMAGE_BUDGET_CACHE_MAX) imageBudgetCache.clear();
		imageBudgetCache.set(key, budget);
	}
	return budget ?? undefined;
}
