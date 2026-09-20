import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	resolveProviderModelReference,
	type ResolvedModelRoleValue,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";

/** Formats a role assignment while preserving its explicit thinking selector. */
export function formatRoleModelValue(
	settings: Settings,
	modelRegistry: ModelRegistry,
	role: string,
	model: Model,
	selectorOverride?: string,
	thinkingLevelOverride?: ThinkingLevel,
): string {
	const modelKey = selectorOverride ?? `${model.provider}/${model.id}`;
	if (thinkingLevelOverride !== undefined) return formatModelSelectorValue(modelKey, thinkingLevelOverride);
	const existingRoleValue = settings.getModelRole(role);
	if (!existingRoleValue) return modelKey;
	const thinkingLevel = extractExplicitThinkingSelector(existingRoleValue, settings, {
		isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
	});
	return formatModelSelectorValue(modelKey, thinkingLevel);
}

/** Resolves a configured model target relative to the current provider. */
export function resolveConfiguredModelTarget(
	configuredTarget: string | undefined,
	currentModel: Model,
	availableModels: Model[],
): Model | undefined {
	const trimmedTarget = configuredTarget?.trim();
	if (!trimmedTarget) return undefined;
	const parsed = parseModelString(trimmedTarget, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => resolveProviderModelReference(provider, id, availableModels) !== undefined,
	});
	if (parsed) {
		const explicitModel = resolveProviderModelReference(parsed.provider, parsed.id, availableModels);
		if (explicitModel) return explicitModel;
	}
	return resolveProviderModelReference(currentModel.provider, trimmedTarget, availableModels);
}

/** Resolves a model's configured context-promotion target. */
export function resolveContextPromotionConfiguredTarget(
	currentModel: Model,
	availableModels: Model[],
): Model | undefined {
	return resolveConfiguredModelTarget(currentModel.contextPromotionTarget, currentModel, availableModels);
}

/** Resolves a model's configured compaction target. */
export function resolveCompactionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
	return resolveConfiguredModelTarget(currentModel.compactionModel, currentModel, availableModels);
}

/** Resolves a model role and its explicit thinking selection. */
export function resolveRoleModelFull(
	settings: Settings,
	role: string,
	availableModels: Model[],
	currentModel: Model | undefined,
): ResolvedModelRoleValue {
	const roleModelStr =
		role === "default"
			? (settings.getModelRole("default") ??
				(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
			: settings.getModelRole(role);
	if (!roleModelStr) {
		return { model: undefined, thinkingLevel: undefined, explicitThinkingLevel: false, warning: undefined };
	}
	return resolveModelRoleValue(roleModelStr, availableModels, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	});
}
