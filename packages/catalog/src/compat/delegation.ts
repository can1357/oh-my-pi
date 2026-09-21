/**
 * Delegation bias: how hard the coding agent's prompts push subagent
 * delegation for a model lineage. Authored on the `delegation-bias` catalog
 * axis in `rules/classes/*.kdl` so appetite corrections live beside the other
 * lineage truths instead of as revision compares in TypeScript.
 *
 * Resolved through the cascade at prompt-build time (session start, model
 * switch) rather than baked onto `Model`: bundled rows are frozen by the
 * generator, and the bias is read once per prompt rebuild, not per request.
 */
import type { Model } from "../types";
import { DELEGATION_BIASES } from "./axes";
import { resolveCascade } from "./cascade";

/** One of `DELEGATION_BIASES`; see that constant for the semantics of each tier. */
export type DelegationBias = (typeof DELEGATION_BIASES)[number];

function isDelegationBias(value: unknown): value is DelegationBias {
	return typeof value === "string" && (DELEGATION_BIASES as readonly string[]).includes(value);
}

interface DelegationBiasCacheEntry {
	provider: Model["provider"];
	api: Model["api"];
	id: string;
	reasoning: boolean;
	identity: Model["identity"];
	identityClass: string;
	family: string | undefined;
	revision: string | undefined;
	bias: DelegationBias;
}

const delegationBiasCache = new WeakMap<Model, DelegationBiasCacheEntry>();

/**
 * Delegation bias for a built model; `eager` when no rule assigns one.
 * Callers: system-prompt and tool-description rendering in the coding agent.
 *
 * Results are cached by model object. Every cascade input is checked before a
 * hit, including fields on a reused/mutated identity object, so model metadata
 * refreshes and policy-relevant replacements cannot return stale bias.
 */
export function resolveDelegationBias(model: Model): DelegationBias {
	const { identity } = model;
	const cached = delegationBiasCache.get(model);
	if (
		cached &&
		cached.provider === model.provider &&
		cached.api === model.api &&
		cached.id === model.id &&
		cached.reasoning === Boolean(model.reasoning) &&
		cached.identity === identity &&
		cached.identityClass === identity.class &&
		cached.family === identity.family &&
		cached.revision === identity.revision
	) {
		return cached.bias;
	}

	const resolved = resolveCascade({
		provider: model.provider,
		api: model.api,
		class: identity.class,
		model: model.id,
		reasoning: Boolean(model.reasoning),
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog.delegationBias;
	const bias = isDelegationBias(resolved) ? resolved : "eager";
	delegationBiasCache.set(model, {
		provider: model.provider,
		api: model.api,
		id: model.id,
		reasoning: Boolean(model.reasoning),
		identity,
		identityClass: identity.class,
		family: identity.family,
		revision: identity.revision,
		bias,
	});
	return bias;
}
