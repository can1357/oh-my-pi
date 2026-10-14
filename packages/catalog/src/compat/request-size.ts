import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";
import { resolveCatalogAxes } from "./resolve";

const imageBudgetCache = new Map<string, number | null>();
const IMAGE_BUDGET_CACHE_MAX = 8192;

/**
 * Maximum encoded inline-image bytes retained per request for a deployment with a documented body-size limit.
 * The axis is a host contract: a rerouted endpoint (proxy, gateway) imposes its own limit, so the budget applies
 * only when `officialEndpoint` says the request reaches the model's official endpoint. `compat.officialEndpoint`
 * classifies only the configured `baseUrl`; pi-ai's `reachesOfficialEndpoint` also follows request-time reroutes.
 */
export function resolveInlineImageByteBudget(model: Model, officialEndpoint: boolean): number | undefined {
	if (!officialEndpoint) return undefined;
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

/**
 * Most images one request to this deployment may carry, or `undefined` when no rule names the host. The
 * `official-image-count-budget` axis replaces `image-count-budget` only when `officialEndpoint` says the request
 * reaches the model's official endpoint (see {@link resolveInlineImageByteBudget}); a rerouted endpoint keeps the
 * provider's generic budget.
 */
export function resolveImageCountBudget(model: Model, officialEndpoint: boolean): number | undefined {
	const policy = resolveCatalogPolicy(model);
	const value = (officialEndpoint && policy.officialImageCountBudget) || policy.imageCountBudget;
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
