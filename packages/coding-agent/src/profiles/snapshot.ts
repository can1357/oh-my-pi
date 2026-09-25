import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { orderedSettings } from "../config/all-settings";
import { getKnownRoleIds, getRoleInfo, roleCandidatePool } from "../config/model-roles";
import {
	pickDefaultAvailableModel,
	resolveAgentModelPatterns,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { AnySetting } from "../config/registry";
import type { Settings } from "../config/settings";
import { cfgHindsightBankId, cfgHindsightBankIdPrefix, cfgHindsightScoping } from "../hindsight/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgMnemopiBank, cfgMnemopiDbPath, cfgMnemopiScoping } from "../mnemopi/settings";
import { cfgTaskAgentModelOverrides, cfgTaskDisabledAgents } from "../task/settings";
import { discoverAgents } from "../task/discovery";
import type { ProfileAgentRow, ProfileRoleRow, ProfileSettingRow, ProfileSnapshot } from "./types";

const UNRESOLVED_MODEL_WARNING = "Configured model is not available with the current providers.";

export interface BuildProfileSnapshotOptions {
	cwd: string;
	/** Effective settings to describe: the live session, or a read-only preview with a setup applied. */
	settings: Settings;
	modelRegistry: ModelRegistry;
	/** Live session model, reported as the default role for the current setup. */
	currentModel?: Model<Api>;
	/** Live session thinking selector; preserves `auto` rather than the per-turn resolved effort. */
	currentThinkingLevel?: ConfiguredThinkingLevel;
}

function withModel(available: Model<Api>[], model: Model<Api> | undefined): Model<Api>[] {
	if (!model || available.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) {
		return available;
	}
	return [...available, model];
}

function projectCost(model: Model<Api> | undefined): ProfileRoleRow["cost"] {
	const cost = model?.cost;
	if (!cost) return undefined;
	const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
	// Registry rows use an all-zero card for both unknown and free pricing; leave those unpriced.
	if (rates.some(rate => !Number.isFinite(rate) || rate < 0) || rates.every(rate => rate === 0)) return undefined;
	return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
}

function finite(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectRoles(options: BuildProfileSnapshotOptions, availableChatModels: Model<Api>[]): ProfileRoleRow[] {
	const { settings, modelRegistry, currentModel, currentThinkingLevel } = options;
	const performance = settings.getStorage()?.getModelPerf();
	const automaticDefault =
		currentModel ??
		pickDefaultAvailableModel(availableChatModels, provider => modelRegistry.hasConcreteAuth(provider));
	const rows: ProfileRoleRow[] = [];
	for (const role of getKnownRoleIds(settings)) {
		const roleInfo = getRoleInfo(role, settings);
		if (roleInfo.hidden) continue;
		const selector = settings.getModelRole(role);
		const automatic = selector === undefined;
		const candidates =
			role === "default"
				? availableChatModels
				: withModel(
						roleCandidatePool(role, settings, modelRegistry),
						currentModel && roleInfo.accepts(currentModel) ? currentModel : undefined,
					);
		let resolved: { model: Model<Api> | undefined; thinkingLevel?: ConfiguredThinkingLevel; warning?: string };
		if (role === "default" && currentModel) {
			const thinkingLevel =
				currentThinkingLevel ??
				(automatic ? undefined : resolveModelRoleValue(selector, candidates, { settings }).thinkingLevel);
			resolved = { model: currentModel, thinkingLevel };
		} else if (automatic) {
			resolved = { model: role === "default" ? automaticDefault : undefined };
		} else {
			resolved = resolveModelRoleValue(selector, candidates, { settings });
		}
		const model = resolved.model;
		const perf = model ? performance?.get(`${model.provider}/${model.id}`) : undefined;
		rows.push({
			role,
			selector,
			provider: model?.provider,
			modelId: model?.id,
			thinkingLevel: resolved.thinkingLevel,
			cost: projectCost(model),
			int: finite(model?.int),
			tps: finite(model?.tps),
			contextWindow: finite(model?.contextWindow),
			perf: perf && perf.samples > 0 && perf.tps > 0 ? perf : undefined,
			automatic,
			warning: automatic || model ? resolved.warning : (resolved.warning ?? UNRESOLVED_MODEL_WARNING),
		});
	}
	return rows;
}

function configuredSelector(value: string | string[] | undefined): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!Array.isArray(value)) return undefined;
	const selectors = value.map(item => item.trim()).filter(Boolean);
	return selectors.length > 0 ? selectors.join(",") : undefined;
}

async function projectAgents(
	options: BuildProfileSnapshotOptions,
	defaultModel: Model<Api> | undefined,
): Promise<ProfileAgentRow[]> {
	const { cwd, settings, modelRegistry, currentModel } = options;
	const { agents } = await discoverAgents(cwd);
	const disabled = new Set(cfgTaskDisabledAgents.get(settings));
	const overrides = cfgTaskAgentModelOverrides.get(settings);
	const activeModelPattern = currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined;
	const fallbackModelPattern = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : undefined;
	return agents.map(agent => {
		const override = Object.hasOwn(overrides, agent.name) ? overrides[agent.name] : undefined;
		const patterns = resolveAgentModelPatterns({
			settingsOverride: override,
			agentModel: agent.model,
			settings,
			activeModelPattern,
			fallbackModelPattern,
		});
		const resolved = resolveModelOverride(patterns, modelRegistry, settings);
		return {
			name: agent.name,
			enabled: !disabled.has(agent.name),
			source: agent.source,
			selector: configuredSelector(override) ?? configuredSelector(agent.model),
			provider: resolved.model?.provider,
			modelId: resolved.model?.id,
			thinkingLevel: resolved.thinkingLevel ?? agent.thinkingLevel,
			warning:
				patterns.length === 0 || resolved.model ? resolved.warning : (resolved.warning ?? UNRESOLVED_MODEL_WARNING),
		};
	});
}

function projectSetting(setting: AnySetting, settings: Settings): ProfileSettingRow {
	const { ui, type } = setting;
	const value = setting.get(settings);
	const displayable =
		ui !== undefined &&
		((type === "boolean" && typeof value === "boolean") ||
			(type === "number" && typeof value === "number" && Number.isFinite(value)) ||
			(type === "enum" && typeof value === "string"));
	return {
		id: setting.id,
		label: ui?.label ?? setting.id,
		value: displayable ? (value as boolean | number | string) : null,
		hidden: !displayable,
		configured: setting.isConfigured(settings),
	};
}

function hideUrls(value: string): string {
	return sanitizeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim()
		.replace(/https?:\/\/[^\s)}>]+/giu, candidate => {
			try {
				return new URL(candidate).hostname || "[endpoint hidden]";
			} catch {
				return "[endpoint hidden]";
			}
		});
}

function projectMemory(settings: Settings): ProfileSnapshot["memory"] {
	const backend = cfgMemoryBackend.get(settings);
	if (backend === "hindsight") {
		const bank = cfgHindsightBankId.get(settings)?.trim();
		const bankPrefix = cfgHindsightBankIdPrefix.get(settings)?.trim();
		return {
			backend,
			scope: cfgHindsightScoping.get(settings),
			storageLabel: bank
				? `Custom storage — may be shared · Bank ${hideUrls(bank)}`
				: bankPrefix
					? `Custom storage — may be shared · Bank prefix ${hideUrls(bankPrefix)}`
					: "Custom storage — may be shared · Default bank",
		};
	}
	if (backend === "mnemopi") {
		const scope = cfgMnemopiScoping.get(settings);
		const bank = cfgMnemopiBank.get(settings)?.trim();
		const custom = Boolean(cfgMnemopiDbPath.get(settings)?.trim() || bank || scope !== "per-project");
		return {
			backend,
			scope,
			storageLabel: custom
				? `Custom storage — may be shared${bank ? ` · Bank ${hideUrls(bank)}` : ""}`
				: "Default local storage",
		};
	}
	if (backend === "sharpshooter") {
		return { backend, scope: "per-project", storageLabel: "Custom storage — may be shared" };
	}
	return { backend, storageLabel: backend === "local" ? "Default local storage" : "No memory storage" };
}

/**
 * Resolve every visible model role the way the preview shows it, including
 * the "not available" warning. Synchronous, so editors can re-check a draft
 * after each change.
 */
export function projectProfileRoles(options: BuildProfileSnapshotOptions): ProfileRoleRow[] {
	return projectRoles(options, withModel(options.modelRegistry.getAvailable(), options.currentModel));
}

/** Describe the model roles, agents, memory, and settings a configuration resolves to. */
export async function buildProfileSnapshot(options: BuildProfileSnapshotOptions): Promise<ProfileSnapshot> {
	const { settings, modelRegistry, currentModel } = options;
	const availableChatModels = withModel(modelRegistry.getAvailable(), currentModel);
	const roles = projectRoles(options, availableChatModels);
	const defaultRole = roles.find(role => role.role === "default");
	const defaultModel = availableChatModels.find(
		model => model.provider === defaultRole?.provider && model.id === defaultRole.modelId,
	);
	return {
		generatedAt: Date.now(),
		roles,
		agents: await projectAgents(options, defaultModel),
		memory: projectMemory(settings),
		settings: orderedSettings().map(setting => projectSetting(setting, settings)),
		warnings: [],
	};
}
