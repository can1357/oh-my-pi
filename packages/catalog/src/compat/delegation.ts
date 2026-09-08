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

/**
 * Delegation bias for a built model; `eager` when no rule assigns one.
 * Callers: system-prompt and tool-description rendering in the coding agent.
 */
export function resolveDelegationBias(model: Model): DelegationBias {
	const { identity } = model;
	const bias = resolveCascade({
		provider: model.provider,
		class: identity.class,
		model: model.id,
		reasoning: Boolean(model.reasoning),
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog.delegationBias;
	return isDelegationBias(bias) ? bias : "eager";
}
