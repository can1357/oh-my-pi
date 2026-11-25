import type { Api, Model } from "@oh-my-pi/pi-ai";
import { factoryDroidRefusalTargets } from "@oh-my-pi/pi-catalog/discovery/factory-droid";
import {
	type DisabledModelMatcher,
	disabledModelMatcher,
	formatDisabledModelError,
	NO_DISABLED_MODELS,
} from "./disabled-models";
import type { Settings } from "./settings";

/** Restrict a request only when a rule denies a possible target. Discovery limits the account separately. */
export function allowedFactoryDroidFallbacks(
	model: Model,
	isDisabled: DisabledModelMatcher,
	onDisabledFallback?: (message: string) => void,
): readonly string[] | undefined {
	if (isDisabled === NO_DISABLED_MODELS) return undefined;
	const targets = factoryDroidRefusalTargets(model);
	let kept = 0;
	for (const id of targets) {
		const target = { provider: model.provider, providerType: model.providerType, id };
		const rule = isDisabled(target);
		if (rule === undefined) targets[kept++] = id;
		else onDisabledFallback?.(formatDisabledModelError(target, rule));
	}
	if (kept === targets.length) return undefined;
	targets.length = kept;
	return targets;
}

/** Apply current policy to one dispatch, never to a catalog or selected model. */
export function withDisabledModelFallbackPolicy<TApi extends Api>(
	model: Model<TApi>,
	policy: Settings | DisabledModelMatcher | undefined,
	onDisabledFallback?: (message: string) => void,
): Model<TApi> {
	if (model.api !== "factory-droid-agent") return model;
	const matcher = typeof policy === "function" ? policy : disabledModelMatcher(policy);
	const allowed = allowedFactoryDroidFallbacks(model, matcher, onDisabledFallback);
	return allowed === model.factoryDroidAllowedRefusalFallbacks
		? model
		: { ...model, factoryDroidAllowedRefusalFallbacks: allowed };
}
