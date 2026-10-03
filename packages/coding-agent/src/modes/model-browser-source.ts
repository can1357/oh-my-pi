import type { ModelHubSource } from "@oh-my-pi/pi-tui/overlays/model-hub";
import {
	buildDefaultModelRolePreset,
	getModelRolePreset,
	getModelRolePresetDefault,
	getModelRolePresetDefaultName,
	getModelRolePresetNames,
	isModelRolePresetName,
	modelRolePresetKeyExists,
	modelRolePresetRoles,
} from "../config/model-role-presets";
import {
	filterAvailableModelsByEnabledPatterns,
	formatModelStringWithRouting,
	rolePriorityDefaults,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds, getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";

import {
	cfgCycleOrder,
	cfgDisabledProviders,
	cfgModelProviderOrder,
	cfgModelRoleStorage,
} from "../config/model-settings";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";

/** Supply live model-overlay preferences and runtime resolution from the host. */
export function createModelBrowserSource(settings: Settings): ModelHubSource {
	return {
		get revision() {
			return settings.revision;
		},
		get defaultThinkingLevel() {
			return cfgDefaultThinkingLevel.get(settings);
		},
		get modelProviderOrder() {
			return cfgModelProviderOrder.get(settings);
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
			return cfgDisabledProviders.get(settings);
		},
		get fallbackChains() {
			return cfgRetryFallbackChains.get(settings);
		},
		get globalFallbackChains() {
			return settings.getGlobalRetryFallbackChains();
		},
		get modelRoleStorage() {
			return cfgModelRoleStorage.get(settings);
		},
		get cycleOrder() {
			return cfgCycleOrder.get(settings);
		},
		get presetsApplyOnSelect() {
			return settings.get("modelRolePresets.applyOnSelect");
		},
		get presetsAutoSave() {
			return settings.get("modelRolePresets.autoSave");
		},
		get presetsKeepRolesWhenUnset() {
			return settings.get("modelRolePresets.keepRolesWhenUnset");
		},
		get globalDefaultThinkingLevel() {
			return (settings.getGlobalSettings().defaultThinkingLevel as string | undefined) ?? "";
		},
		getModelRole: role => settings.getModelRole(role),
		getProjectModelRole: role => settings.getProjectModelRole(role),
		getGlobalModelRole: role => settings.getGlobalModelRole(role),
		getModelRoleSource: role => settings.getModelRoleSource(role),
		getModelRoleProvenance: role => settings.getModelRoleProvenance(role),
		getModelRolePresetProvenance: (model, name) =>
			settings.getModelRolePresetProvenance(`${model.provider}/${model.id}`, name),
		getProjectModelRoles: () => ({ ...settings.getProjectModelRoles() }),
		getGlobalModelRoles: () => ({ ...settings.getGlobalModelRoles() }),
		getRoleInfo: role => getRoleInfo(role, settings),
		defaultRoleChain: role => rolePriorityDefaults(role),
		resolveRoleValue: (value, models, roleLookup) => resolveModelRoleValue(value, models, { settings, roleLookup }),
		formatWithRouting: model => formatModelStringWithRouting(model),
		filterEnabledModels: available => {
			const patterns = settings.get("enabledModels");
			return patterns.length > 0 ? filterAvailableModelsByEnabledPatterns(available, patterns, settings) : available;
		},
		isValidPresetName: name => isModelRolePresetName(name),
		presetRoles: (profile, extraRoleKeys) => modelRolePresetRoles(profile, extraRoleKeys),
		buildBuiltInDefaultPreset: (model, available) => buildDefaultModelRolePreset(model, available),
		presetNames: model => getModelRolePresetNames(settings.get("modelRolePresets"), model),
		preset: (model, name) => getModelRolePreset(settings.get("modelRolePresets"), model, name),
		presetDefault: model => getModelRolePresetDefault(settings.get("modelRolePresets"), model),
		presetDefaultName: model => getModelRolePresetDefaultName(settings.get("modelRolePresets"), model),
		presetKeyExists: (model, name) => modelRolePresetKeyExists(settings.get("modelRolePresets"), model, name),
		globalPreset: (model, name) => getModelRolePreset(settings.getGlobalModelRolePresets(), model, name),
		globalPresetDefault: model => getModelRolePresetDefault(settings.getGlobalModelRolePresets(), model),
		globalPresetDefaultName: model => getModelRolePresetDefaultName(settings.getGlobalModelRolePresets(), model),
	};
}
