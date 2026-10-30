import { withoutUnverifiedThinking } from "../model-thinking";
import type { CatalogPolicyInputs } from "../types";
import { resolveCatalogAxes } from "./resolve";

/**
 * Rule-owned catalog-axis policy by model. Resolve once per process rather
 * than walking the static policy cascade on every accessor call. The key
 * mirrors the cascade target inputs — `providerType ?? provider`, api, the
 * logical id plus `requestModelId` (the wire id `policyModelId` resolves
 * unknown logical ids under), and the reasoning flag; identity-derived
 * class/family/revision facts are a pure function of provider + id. Bounded:
 * one entry per distinct model.
 */
const catalogPolicyCache = new Map<string, Readonly<Record<string, unknown>>>();
const CATALOG_POLICY_CACHE_MAX = 8192;

/**
 * The `catalog` axis bag authored in the KDL cascade rules for a model,
 * memoized per distinct model. Frozen: the bag is shared across callers, so it
 * must stay read-only — extract the value you need rather than handing it on.
 */
export function resolveCatalogPolicy(model: CatalogPolicyInputs): Readonly<Record<string, unknown>> {
	const key = `${model.provider}\u0000${model.providerType ?? ""}\u0000${model.api}\u0000${model.id}\u0000${model.requestModelId ?? ""}\u0000${model.reasoning ? 1 : 0}`;
	const cached = catalogPolicyCache.get(key);
	if (cached !== undefined) return cached;
	const policy = Object.freeze({ ...resolveCatalogAxes(withoutUnverifiedThinking(model)) });
	if (catalogPolicyCache.size >= CATALOG_POLICY_CACHE_MAX) catalogPolicyCache.clear();
	catalogPolicyCache.set(key, policy);
	return policy;
}
