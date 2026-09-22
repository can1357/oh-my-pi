import { toModelSpec } from "../provider-models/bundled-references";
import type { Model } from "../types";
import { resolveModelPolicy } from "./resolve";

/**
 * Rule-owned catalog-axis policy by model. Resolve once per process rather
 * than walking the static policy cascade on every accessor call. The key
 * mirrors the cascade target inputs — `providerType ?? provider`, api, model
 * id, and the reasoning flag; identity-derived class/family/revision facts are
 * a pure function of provider + id. Bounded: one entry per distinct model.
 */
const catalogPolicyCache = new Map<string, Readonly<Record<string, unknown>>>();
const CATALOG_POLICY_CACHE_MAX = 8192;

/**
 * The `catalog` axis bag authored in the KDL cascade rules for a model,
 * memoized per distinct model. Frozen: the bag is shared across callers, so it
 * must stay read-only — extract the value you need rather than handing it on.
 */
export function resolveCatalogPolicy(model: Model): Readonly<Record<string, unknown>> {
	const key = `${model.provider}\u0000${model.providerType ?? ""}\u0000${model.api}\u0000${model.id}\u0000${model.reasoning ? 1 : 0}`;
	const cached = catalogPolicyCache.get(key);
	if (cached !== undefined) return cached;
	const policy = Object.freeze({ ...resolveModelPolicy(toModelSpec(model)).catalog });
	if (catalogPolicyCache.size >= CATALOG_POLICY_CACHE_MAX) catalogPolicyCache.clear();
	catalogPolicyCache.set(key, policy);
	return policy;
}
