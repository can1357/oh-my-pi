import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { serviceTierFamily, type Model, type ServiceTier } from "@oh-my-pi/pi-ai/types";

import { isServiceTierForFamily } from "./service-tier";
import { toReasoningEffort } from "../thinking";

export type ModelServiceTierOverrideResolution = { matched: false } | { matched: true; tier: ServiceTier | undefined };

const NO_MODEL_SERVICE_TIER_OVERRIDE = Object.freeze({ matched: false as const });

/**
 * Try provider/model:effort before provider/model, using the concrete model ID
 * verbatim. Off, inherit and undefined add no effort suffix. Unsupported family
 * values are inert. A matched "none" is authoritative off; no match leaves
 * the caller's baseline unchanged.
 */
export function resolveModelServiceTierOverride(
	overrides: Readonly<Record<string, string>>,
	model: Model,
	thinkingLevel: ThinkingLevel | undefined,
): ModelServiceTierOverrideResolution {
	const family = serviceTierFamily(model);
	if (!family) return NO_MODEL_SERVICE_TIER_OVERRIDE;
	const baseKey = `${model.provider}/${model.id}`;
	const effort = toReasoningEffort(thinkingLevel);
	if (effort) {
		const effortKey = `${baseKey}:${effort}`;
		if (Object.hasOwn(overrides, effortKey)) {
			const tier = overrides[effortKey];
			if (tier === "none") return { matched: true, tier: undefined };
			if (isServiceTierForFamily(family, tier)) return { matched: true, tier };
		}
	}
	if (Object.hasOwn(overrides, baseKey)) {
		const tier = overrides[baseKey];
		if (tier === "none") return { matched: true, tier: undefined };
		if (isServiceTierForFamily(family, tier)) return { matched: true, tier };
	}
	return NO_MODEL_SERVICE_TIER_OVERRIDE;
}
