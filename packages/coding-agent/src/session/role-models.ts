import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	type ResolvedModelRoleValue,
	resolveExplicitModelRole,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { cfgCompactionModel } from "./context-settings";

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
		isLiteralModelId: (provider, id) => {
			if (provider !== undefined) return modelRegistry.find(provider, id) !== undefined;
			const lowerId = id.toLowerCase();
			return modelRegistry.getAll("all").some(candidate => candidate.id.toLowerCase() === lowerId);
		},
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
		isLiteralModelId: (provider, id) => availableModels.some(model => model.provider === provider && model.id === id),
	});
	if (parsed) {
		const explicitModel = availableModels.find(model => model.provider === parsed.provider && model.id === parsed.id);
		if (explicitModel) return explicitModel;
	}
	return availableModels.find(model => model.provider === currentModel.provider && model.id === trimmedTarget);
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

/**
 * Resolves the operator-level `compaction.model` selector against the caller's
 * available models. The value accepts an exact `provider/model` selector (with
 * an optional thinking suffix) or a `@role` alias; unset, whitespace-only, and
 * bare tokens resolve to undefined.
 *
 * Project settings are deliberately excluded: repository files are writable by
 * the agent, and this key decides which provider receives compaction summaries.
 * Role aliases and match preferences resolve from the same operator view.
 */
export function resolveGlobalCompactionTarget(settings: Settings, availableModels: Model[]): Model | undefined {
	const authority = settings.grantAuthority();
	const configured = cfgCompactionModel.get(authority)?.trim();
	if (!configured) return undefined;
	if (configured.startsWith("@")) {
		if (!resolveExplicitModelRole(configured, authority)) return undefined;
		const roleValue = configured === "@default" ? authority.getModelRole("default") : configured;
		if (!roleValue) return undefined;
		return resolveModelRoleValue(roleValue, availableModels, { settings: authority }).model;
	}
	const parsed = parseModelString(configured, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) =>
			provider !== undefined && availableModels.some(model => model.provider === provider && model.id === id),
	});
	if (!parsed) return undefined;
	return availableModels.find(model => model.provider === parsed.provider && model.id === parsed.id);
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
