/**
 * Scribe-model resolution for the auto-learn session-settle pass.
 *
 * Mirrors `resolveSharpshooterModel`: an explicit `autolearn.model` selector
 * wins outright, otherwise the `smol` role. Undefined means the pass is skipped
 * — the scribe never borrows the primary model, whose tokens the primary turn
 * already spent.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";

import { cfgAutolearnModel } from "./settings";

export async function resolveAutolearnScribeModel(
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<Model | undefined> {
	const selector = cfgAutolearnModel.get(settings);
	if (selector) {
		const resolved = resolveModelRoleValue(selector, modelRegistry.getAll(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (resolved.model) return resolved.model;
		logger.debug("Auto-learn scribe model selector did not resolve", { selector });
	}

	const fallback = resolveRoleSelection(["smol"], settings, modelRegistry.getAvailable())?.model;
	if (!fallback) logger.debug("Auto-learn scribe skipped: no model available");
	return fallback;
}
