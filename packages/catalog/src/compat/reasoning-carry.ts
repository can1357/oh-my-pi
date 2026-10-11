/**
 * Reasoning carry: whether reasoning a model produced on one host may replay
 * natively on another host serving the same model.
 *
 * The model-side half is declared with the `portable-reasoning` catalog axis
 * per family in `rules/classes/*.kdl`: the family's stored reasoning is its own
 * full plaintext trace, and its identity pins one set of weights. A host whose
 * reasoning must neither be carried in nor out overrides it to `#false` in its
 * `rules/providers/*.kdl`. Whether the target host has a native slot for
 * earlier reasoning is derived by the request encoders in `@oh-my-pi/pi-ai`,
 * not declared here.
 *
 * Resolved through the cascade on demand (like delegation bias) because
 * bundled rows are frozen by the generator; results are memoized per
 * deployment.
 */
import { resolveCascade } from "./cascade";
import { classifyModel } from "./taxonomy";
import type { ModelIdentity } from "./types";

/** `null` records a deployment that does not carry reasoning. */
const portableIdentityMemo = new Map<string, ModelIdentity | null>();

/**
 * The identity a deployment's reasoning is carried under, or `undefined` when
 * the deployment's model family is not declared portable there. Class-only
 * identities never qualify: they name a lineage, not a set of weights.
 */
export function portableReasoningIdentity(provider: string, api: string, modelId: string): ModelIdentity | undefined {
	const key = `${provider}\0${api}\0${modelId}`;
	const memo = portableIdentityMemo.get(key);
	if (memo !== undefined) return memo ?? undefined;
	const identity = classifyModel(provider, modelId, { lenient: true });
	let portable: ModelIdentity | null = null;
	if (identity.family !== undefined || identity.revision !== undefined) {
		const declared = resolveCascade({
			provider,
			api,
			class: identity.class,
			model: modelId,
			reasoning: true,
			...(identity.family !== undefined && { family: identity.family }),
			...(identity.revision !== undefined && { revision: identity.revision }),
		}).catalog.portableReasoning;
		if (declared === true) portable = identity;
	}
	portableIdentityMemo.set(key, portable);
	return portable ?? undefined;
}

/**
 * Whether reasoning recorded on `source` may replay natively on `target`:
 * both deployments declare the family portable and classify to the same
 * class, family, and revision.
 */
export function carriesReasoning(
	source: { provider: string; api: string; model: string },
	target: { provider: string; api: string; id: string },
): boolean {
	const to = portableReasoningIdentity(target.provider, target.api, target.id);
	if (!to) return false;
	const from = portableReasoningIdentity(source.provider, source.api, source.model);
	return from !== undefined && from.class === to.class && from.family === to.family && from.revision === to.revision;
}
