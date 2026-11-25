import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelResolveOptions } from "@oh-my-pi/pi-ai/auth-gateway";
import { deniedWireIdentity, disabledModelMatcher, NO_DISABLED_MODELS } from "../config/disabled-models";
import { withDisabledModelFallbackPolicy } from "../config/model-fallback-policy";
import type { Settings } from "../config/settings";

/** Apply the gateway host's policy to the resolved model and the routing options it will forward. */
export function gatewayModelForDispatch(
	model: Model | undefined,
	settings: Settings,
	options: ModelResolveOptions | undefined,
): Model | undefined {
	if (!model) return undefined;
	const isDisabled = disabledModelMatcher(settings);
	if (isDisabled === NO_DISABLED_MODELS) return model;
	if (deniedWireIdentity(model, options, isDisabled)) return undefined;
	return withDisabledModelFallbackPolicy(model, isDisabled);
}
