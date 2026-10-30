import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveCatalogPolicy } from "./catalog-policy";
import { resolveCatalogAxes } from "./resolve";

const imageBudgetCache = new Map<string, number | null>();
const IMAGE_BUDGET_CACHE_MAX = 8192;

/**
 * Maximum encoded inline-image bytes retained per request for a deployment with a documented body-size limit.
 * The axis is a host contract: a rerouted endpoint (proxy, gateway) imposes its own limit, so the budget applies
 * only when `budgetedHost` says the request reaches the host the rules describe: pi-ai's `reachesBudgetedHost`
 * (the model's official endpoint, following request-time reroutes, or Factory's hosted API for a Factory Droid model).
 */
export function resolveInlineImageByteBudget(model: Model, budgetedHost: boolean): number | undefined {
	if (!budgetedHost) return undefined;
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
 * Largest request body the deployment accepts (`request-body-byte-limit`), or `undefined` when no rule names it.
 * Same gate as {@link resolveInlineImageByteBudget}.
 */
export function resolveRequestBodyByteLimit(model: Model, budgetedHost: boolean): number | undefined {
	if (!budgetedHost) return undefined;
	const value = resolveCatalogPolicy(model).requestBodyByteLimit;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Most images one request to this deployment may carry, or `undefined` when no rule names the host. A configured
 * `model.imageCountBudget` wins: the user knows the host behind a custom gateway. Otherwise the
 * `official-image-count-budget` axis replaces `image-count-budget` only when `budgetedHost` says the request
 * reaches the host the rules describe (see {@link resolveInlineImageByteBudget}); a rerouted endpoint keeps the
 * provider's generic budget.
 */
export function resolveImageCountBudget(model: Model, budgetedHost: boolean): number | undefined {
	if (model.imageCountBudget !== undefined) return model.imageCountBudget;
	const policy = resolveCatalogPolicy(model);
	const value = (budgetedHost && policy.officialImageCountBudget) || policy.imageCountBudget;
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
