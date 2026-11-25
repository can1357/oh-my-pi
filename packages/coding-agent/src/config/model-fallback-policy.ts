import type { Api, Model } from "@oh-my-pi/pi-ai";
import { factoryDroidRefusalTargets } from "@oh-my-pi/pi-catalog/discovery/factory-droid";
import {
	type DisabledModelMatcher,
	disabledModelMatcher,
	formatDisabledModelError,
	NO_DISABLED_MODELS,
} from "./disabled-models";
import type { Settings } from "./settings";

/** Narrow Factory's provider-generated refusal chain without changing the shared catalog model. */
export function withDisabledModelFallbackPolicy<TApi extends Api>(
	model: Model<TApi>,
	policy: Settings | DisabledModelMatcher | undefined,
	onDisabledFallback?: (message: string) => void,
): Model<TApi> {
	if (model.api !== "factory-droid-agent") return model;
	const isDisabled = typeof policy === "function" ? policy : disabledModelMatcher(policy);
	if (isDisabled === NO_DISABLED_MODELS) return model;
	const targets = model.factoryDroidRefusalFallbacks ?? factoryDroidRefusalTargets(model);
	const allowed = targets.filter(id => {
		const target = { provider: model.provider, providerType: model.providerType, id };
		const rule = isDisabled(target);
		if (rule === undefined) return true;
		onDisabledFallback?.(formatDisabledModelError(target, rule));
		return false;
	});
	// A provider or gateway resolves the final route later. Freeze the upper bound,
	// including an empty one, so it cannot introduce an unchecked target.
	if (model.factoryDroidRefusalFallbacks !== undefined && allowed.length === targets.length) return model;
	return { ...model, factoryDroidRefusalFallbacks: allowed };
}
