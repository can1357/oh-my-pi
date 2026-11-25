import type { Api, Model } from "../../types";

// Local model projections (headers, thinking, etc.) copy enumerable symbols. JSON
// and structured clone omit them: each process uses its own registry's live policy.
const kRequestPolicy = Symbol.for("@oh-my-pi/pi-ai/factory-droid.requestPolicy");
type RequestPolicy = (model: Model) => readonly string[] | undefined;
type ScopedModel<TApi extends Api> = Model<TApi> & { [kRequestPolicy]?: RequestPolicy };

export function bindFactoryDroidRequestPolicy<TApi extends Api>(
	model: ScopedModel<TApi>,
	policy: RequestPolicy,
): ScopedModel<TApi> {
	return model[kRequestPolicy] === policy ? model : { ...model, [kRequestPolicy]: policy };
}

/** Materialize the registry's current bound without changing discovery data or widening a caller's bound. */
export function factoryDroidRequestModel<TApi extends Api>(model: ScopedModel<TApi>): Model<TApi> {
	const allowed = model[kRequestPolicy]?.(model);
	if (allowed === undefined) return model;
	const requested = model.factoryDroidAllowedRefusalFallbacks;
	return {
		...model,
		factoryDroidAllowedRefusalFallbacks: requested ? allowed.filter(id => requested.includes(id)) : allowed,
	};
}
