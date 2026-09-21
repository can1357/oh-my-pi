import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";

/** Supply live model-overlay preferences and runtime resolution from the host. */
export function createModelBrowserSource(settings: Settings): ModelHubSource {
	return {
		get defaultThinkingLevel() {
			return settings.get("defaultThinkingLevel");
		},
		get modelProviderOrder() {
			return settings.get("modelProviderOrder");
		},
		get knownRoleIds() {
			return getKnownRoleIds(settings);
		},
		get mruOrder() {
			return settings.getStorage()?.getModelUsageOrder() ?? [];
		},
		get modelPerf() {
			return settings.getStorage()?.getModelPerf() ?? new Map();
		},
		get disabledProviders() {
			return settings.get("disabledProviders");
		},
		get fallbackChains() {
			return settings.get("retry.fallbackChains");
		},
		get modelRoleStorage() {
			return settings.get("modelRoleStorage");
		},
		get cycleOrder() {
			return settings.get("cycleOrder");
		},
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
	};
}
