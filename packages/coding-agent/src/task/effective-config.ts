/**
 * What a task or eval spawn of one agent runs with, and which layer set each
 * value. Every value comes from the resolver the spawn itself calls, evaluated
 * as a spawn from a new top-level session in this directory: a caller's
 * `model`/`effort`, a live `/model` or `/fast` change, plan mode and
 * `before_subagent_spawn` handlers can still change it.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { resolveModelServiceTier, type ServiceTierFamily, serviceTierFamily } from "@oh-my-pi/pi-ai/types";
import {
	automaticThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveThinkingLevelForModel,
} from "@oh-my-pi/pi-tui/thinking";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { type DiscoveredAdvisors, discoverAdvisorConfigs } from "../advisor/config";
import type { OAuthAccountPools } from "../config/account-pools";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	pickStartupFallbackModel,
	resolveAdvisorRoleSelection,
	resolveAgentModelSelection,
	resolveAllowedModels,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import type { AnySetting } from "../config/registry";
import { buildServiceTierByFamily, resolveAgentServiceTierOverride } from "../config/service-tier";
import type { SettingProvenance, Settings } from "../config/settings";
import {
	cfgCompactionEnabled,
	cfgCompactionModelThresholds,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
} from "../session/context-settings";
import { describeModelCompactionPoint } from "../session/model-compaction-threshold";
import { resolveDefaultRoleRetryFallback } from "../session/retry-fallback-chains";
import {
	cfgDefaultThinkingLevel,
	cfgRetryFallbackChains,
	cfgTierAnthropic,
	cfgTierGoogle,
	cfgTierOpenai,
	cfgTierSubagent,
} from "../session/settings";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, resolveBuiltinToolPlan, type ToolFactory, type ToolSession } from "../tools";
import { cfgToolsXdev } from "../tools/settings";
import {
	inheritedSubagentServiceTiers,
	resolveSoftRequestBudget,
	resolveSubagentPrewalk,
	resolveSubagentSettings,
	resolveSubagentThinkingLevel,
	resolveSubagentToolNames,
	SOFT_REQUEST_BUDGET,
	subagentSpawnsEnv,
} from "./executor";
import { agentPrewalkPattern } from "./prewalk";
import { isBundledSeance } from "./seance";
import {
	cfgTaskAgentAdvisor,
	cfgTaskAgentIdleTtlMs,
	cfgTaskAgentPrewalk,
	cfgTaskAgentSoftRequestBudget,
	cfgTaskDisabledAgents,
	cfgTaskEnableLsp,
	cfgTaskMaxRecursionDepth,
	cfgTaskPrewalk,
	cfgTaskSoftRequestBudget,
	cfgTaskStructured,
} from "./settings";
import { resolveAgentSettingsEntries } from "./structured-subagent";
import { type AgentDefinition, canSpawnAtDepth } from "./types";

/** Layer that set one effective value. */
export type AgentConfigLayer =
	/** The agent's exact-name `task.agent*` settings entry. */
	| "agent-entry"
	/** A field of the agent definition's frontmatter. */
	| "frontmatter"
	/** A setting configured in the settings layer named by `scope`. */
	| "setting"
	/** A setting left at its default, or a built-in value. */
	| "default"
	/** The spawning session: its model, or its default tool set. */
	| "session";

export interface AgentConfigSource {
	layer: AgentConfigLayer;
	/** The deciding key: `task.agentModelOverrides.scout`, frontmatter `model`, `tier.subagent`. */
	key?: string;
	/** Settings layer of a `setting` source. */
	scope?: SettingProvenance;
}

export interface AgentConfigEntry {
	/** Effective value; null when the feature is off or nothing resolves. */
	value: string | number | readonly string[] | OAuthAccountPools | null;
	source: AgentConfigSource;
	/** What the source alone does not say: a role alias, an auth fallback, the trigger basis, a skipped hand-off. */
	note?: string;
}

/** Spawn-time values `resolveEffectiveAgentConfig` reports. */
export type AgentConfigField =
	| "model"
	| "thinking"
	| "serviceTier"
	| "compaction"
	| "requestBudget"
	| "tools"
	| "prewalk"
	| "advisor"
	| "accountPools"
	| "idleTtlMs";

export interface EffectiveAgentConfig extends Record<AgentConfigField, AgentConfigEntry> {
	name: string;
	definedIn: AgentSource;
	filePath?: string;
	/** Listed in `task.disabledAgents`: a spawn is refused before any value below applies. */
	disabled: boolean;
}

const TIER_SETTING_BY_FAMILY: Record<ServiceTierFamily, AnySetting> = {
	openai: cfgTierOpenai,
	anthropic: cfgTierAnthropic,
	google: cfgTierGoogle,
};

function settingSource(setting: AnySetting, settings: Settings): AgentConfigSource {
	const scope = setting.provenance(settings);
	return scope === "default" ? { layer: "default", key: setting.id } : { layer: "setting", key: setting.id, scope };
}

/**
 * Model a new top-level session starts on: the `default` role when it resolves
 * among the allowed models, else its retry fallback chain's first usable entry,
 * else the startup fallback pick. Like session start, a configured role that
 * misses (or no pick at all) awaits one discovery pass first, so a cold
 * models.yml cache cannot hand the role's slot to a fallback.
 */
async function resolveParentModel(
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<{ pattern: string | undefined; source: AgentConfigSource; note?: string }> {
	const preferences = getModelMatchPreferences(settings);
	const defaultRole = settings.getModelRole("default");
	let refreshed = false;
	while (true) {
		const allowed = await resolveAllowedModels(modelRegistry, settings, preferences);
		if (defaultRole) {
			const role = resolveModelRoleValue(defaultRole, allowed, { settings, matchPreferences: preferences });
			// A real parent hands its spawn the concrete model it runs on, without the role's thinking suffix.
			if (role.model) {
				return { pattern: formatModelString(role.model), source: { layer: "session", key: "modelRoles.default" } };
			}
		}
		const pick = pickStartupFallbackModel(modelRegistry, allowed);
		if (!refreshed && (defaultRole || !pick) && modelRegistry.getDiscoverableProviders().length > 0) {
			await modelRegistry.refresh("online-if-uncached");
			refreshed = true;
			continue;
		}
		const chainFallback = resolveDefaultRoleRetryFallback(settings, modelRegistry, allowed, preferences);
		if (chainFallback) {
			return {
				pattern: formatModelString(chainFallback.model),
				source: settingSource(cfgRetryFallbackChains, settings),
				note: `modelRoles.default ${defaultRole} unavailable`,
			};
		}
		const enabled = cfgEnabledModels.get(settings);
		return {
			pattern: pick ? `${pick.provider}/${pick.id}` : undefined,
			source: { layer: "default", key: "first available model" },
			note: enabled && enabled.length > 0 ? `within enabledModels (${enabled.join(", ")})` : undefined,
		};
	}
}

/** Model a spawn of `agent` resolves from its settings entry, frontmatter and the parent session's model. */
async function resolveSpawnModel(
	agent: AgentDefinition,
	modelOverride: string | string[] | undefined,
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<{ entry: AgentConfigEntry; model: Model | undefined; resolved: SpawnModelResolution }> {
	const { name } = agent;
	// The auth probe runs as the spawn's, under a child session id, so session-sticky OAuth resolves as it would there.
	const probeSessionId = `agents-show-${name}`;
	let parent = await resolveParentModel(settings, modelRegistry);
	let selection = resolveAgentModelSelection({
		settingsOverride: modelOverride,
		agentModel: agent.model,
		activeModelPattern: parent.pattern,
		settings,
	});
	let resolved = await resolveModelOverrideWithAuthFallback(
		selection.patterns,
		parent.pattern,
		modelRegistry,
		settings,
		probeSessionId,
	);
	// A cold models.yml discovery cache resolves nothing until one discovery pass runs, as at session start.
	if (!resolved.model && modelRegistry.getDiscoverableProviders().length > 0) {
		await modelRegistry.refresh("online-if-uncached");
		parent = await resolveParentModel(settings, modelRegistry);
		selection = resolveAgentModelSelection({
			settingsOverride: modelOverride,
			agentModel: agent.model,
			activeModelPattern: parent.pattern,
			settings,
		});
		resolved = await resolveModelOverrideWithAuthFallback(
			selection.patterns,
			parent.pattern,
			modelRegistry,
			settings,
			probeSessionId,
		);
	}
	const sessionModel = parent.source;
	// Session start refreshes a lazily discovered model's live metadata (context window, thinking) before using it.
	const model = resolved.model && (await modelRegistry.refreshSelectedModelMetadata(resolved.model));
	// The role note names a role only when the selector that matched came from it.
	const matchedRole = resolved.patternIndex !== undefined ? selection.patternRoles[resolved.patternIndex] : undefined;
	const usesParent = resolved.authFallbackUsed || (selection.from !== "settings" && selection.from !== "agent");
	const entry: AgentConfigEntry = {
		value: model ? formatModelStringWithRouting(model) : null,
		source: usesParent
			? sessionModel
			: selection.from === "settings"
				? { layer: "agent-entry", key: `task.agentModelOverrides.${name}` }
				: { layer: "frontmatter", key: "model" },
		note: !model
			? `no available model matches ${selection.patterns.join(", ") || "the session model"}`
			: resolved.authFallbackUsed
				? `${selection.patterns.join(", ")} has no working credentials`
				: (matchedRole && `@${matchedRole} via modelRoles.${matchedRole}`) ||
					(usesParent ? parent.note : undefined),
	};
	return { entry, model, resolved };
}

type SpawnModelResolution = Parameters<typeof resolveSubagentThinkingLevel>[0];

export async function resolveEffectiveAgentConfig(
	agent: AgentDefinition,
	settings: Settings,
	modelRegistry: ModelRegistry,
	cwd: string,
): Promise<EffectiveAgentConfig> {
	const { name } = agent;
	const entries = resolveAgentSettingsEntries(settings, name);
	// The bundled seance forks a saved source session: it runs on that session's saved model (or the call's
	// `model`), with no advisor or prewalk, on its restricted tool list, so no setting here picks its model.
	const seance = isBundledSeance(agent);
	const spawnModel = seance ? undefined : await resolveSpawnModel(agent, entries.model, settings, modelRegistry);
	const model = spawnModel?.model;
	const resolved: SpawnModelResolution = spawnModel?.resolved ?? { explicitThinkingLevel: false };
	const modelEntry: AgentConfigEntry = spawnModel?.entry ?? {
		value: null,
		source: { layer: "session", key: "seance source" },
		note: "the source session's saved model, or the call's model",
	};

	const spawnThinking = resolveSubagentThinkingLevel(resolved, agent.thinkingLevel);
	const modelThinking = model?.thinking?.defaultLevel;
	// A spawn that sets no level leaves the new session to the model's own default, then `defaultThinkingLevel`.
	const chosenThinking: AgentConfigEntry =
		spawnThinking !== undefined
			? resolved.explicitThinkingLevel || agent.thinkingLevel === undefined
				? { value: spawnThinking, source: modelEntry.source, note: "level on the model selector" }
				: { value: spawnThinking, source: { layer: "frontmatter", key: "thinkingLevel" } }
			: modelThinking !== undefined
				? { value: modelThinking, source: { layer: "default", key: "model thinking default" } }
				: {
						// As session start: the global default, except on a model whose thinking ladder is unverified (opt-in only).
						value:
							automaticThinkingLevel(
								model,
								parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings)),
							) ?? null,
						source: settingSource(cfgDefaultThinkingLevel, settings),
						note: model?.thinking?.unverified
							? "not applied: the model's thinking levels are unverified"
							: undefined,
					};
	// The session clamps a concrete level to what the model supports; `auto` resolves per turn.
	const thinking = clampThinking(chosenThinking, model);
	const { settings: childSettings, advisor } = resolveSubagentSettings(agent, settings, {
		compactionThresholdOverride: entries.compactionThreshold,
		isolated: false,
		preparedSession: seance,
	});

	const family = model && serviceTierFamily(model);
	const tiers =
		entries.serviceTier !== undefined
			? resolveAgentServiceTierOverride(entries.serviceTier, model, inheritedSubagentServiceTiers(settings))
			: buildServiceTierByFamily(
					cfgTierOpenai.get(childSettings),
					cfgTierAnthropic.get(childSettings),
					cfgTierGoogle.get(childSettings),
				);
	const serviceTier: AgentConfigEntry = {
		value: (model && resolveModelServiceTier(tiers, model)) ?? null,
		source:
			entries.serviceTier !== undefined
				? { layer: "agent-entry", key: `task.agentServiceTierOverrides.${name}` }
				: family && cfgTierSubagent.get(settings) === "inherit"
					? settingSource(TIER_SETTING_BY_FAMILY[family], settings)
					: settingSource(cfgTierSubagent, settings),
		note: model && !family ? "the model has no service-tier control" : undefined,
	};

	const point = model
		? describeModelCompactionPoint(childSettings, modelRegistry.fitContextWindow(model, childSettings))
		: undefined;
	const compaction: AgentConfigEntry = {
		value: point?.tokens ?? null,
		// Disabled compaction wins over any threshold, the agent's own entry included.
		source: !cfgCompactionEnabled.get(childSettings)
			? settingSource(cfgCompactionEnabled, settings)
			: entries.compactionThreshold
				? { layer: "agent-entry", key: `task.agentCompactionThresholdOverrides.${name}` }
				: point && point.source !== "global" && point.source !== "default"
					? {
							...settingSource(cfgCompactionModelThresholds, settings),
							key: `compaction.modelThresholds.${point.source}`,
						}
					: settingSource(
							cfgCompactionThresholdTokens.get(childSettings) > 0
								? cfgCompactionThresholdTokens
								: cfgCompactionThresholdPercent,
							settings,
						),
		note: point?.basis,
	};

	const configuredBudget = cfgTaskSoftRequestBudget.get(settings);
	const agentBudgets = cfgTaskAgentSoftRequestBudget.get(settings);
	const budget = resolveSoftRequestBudget(name, configuredBudget, agentBudgets);
	const builtInBudget = SOFT_REQUEST_BUDGET[name];
	const requestBudget: AgentConfigEntry = {
		value: budget,
		source:
			typeof agentBudgets[name] === "number"
				? { layer: "agent-entry", key: `task.agentSoftRequestBudget.${name}` }
				: budget > 0 && builtInBudget !== undefined && builtInBudget < configuredBudget
					? { layer: "default", key: `built-in ${name} budget` }
					: settingSource(cfgTaskSoftRequestBudget, settings),
	};

	const prewalkPattern = seance ? undefined : agentPrewalkPattern(agent, settings);
	let prewalkResolution = prewalkPattern
		? resolveSubagentPrewalk(prewalkPattern, modelRegistry, settings, { model, thinkingLevel: spawnThinking })
		: undefined;
	// A spawn awaits model discovery before resolving its prewalk target, so an uncached discovered target still arms.
	if (
		prewalkPattern &&
		prewalkResolution?.kind === "unavailable" &&
		modelRegistry.getDiscoverableProviders().length > 0
	) {
		await modelRegistry.refresh("online-if-uncached");
		prewalkResolution = resolveSubagentPrewalk(prewalkPattern, modelRegistry, settings, {
			model,
			thinkingLevel: spawnThinking,
		});
	}

	const atMaxDepth = !canSpawnAtDepth(cfgTaskMaxRecursionDepth.get(settings), 1);
	// A task spawn gets the `yield` tool only under `task.structured`; otherwise its final message is the result.
	const structured = cfgTaskStructured.get(settings);
	const toolNames = resolveSubagentToolNames(agent, settings, {
		atMaxDepth,
		restrictToolNames: seance,
		structured,
	});
	// The child session a task spawn starts, under the child's settings: no UI, and LSP only under task.enableLsp
	// (never for a seance).
	const childToolSession: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => subagentSpawnsEnv(agent, atMaxDepth),
		settings: childSettings,
		taskDepth: 1,
		requireYieldTool: structured,
		// A yield-gated child gets `todo` only while a prewalk hand-off is armed; an unstructured one always may.
		prewalkArmed: prewalkResolution?.kind === "armed",
		enableLsp: !seance && cfgTaskEnableLsp.get(settings),
		modelRegistry,
		getActiveModel: () => model,
		skipPythonPreflight: Array.isArray(toolNames) && !toolNames.includes("eval"),
	};
	const toolPlan = await resolveBuiltinToolPlan(childToolSession, toolNames);
	// createTools drops every planned tool whose factory declines this session (`ask` without a UI, `lsp` without LSP).
	const factories: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const constructed = await Promise.all(toolPlan.names.map(toolName => factories[toolName](childToolSession)));
	const childToolNames = toolPlan.names.filter((_, index) => constructed[index] !== null);
	// createTools also builds a device-only `write` (the xd:// transport, inactive until a device mounts)
	// for an explicit list with `read` but no `write`.
	const deviceOnlyWrite =
		cfgToolsXdev.get(childSettings) &&
		toolPlan.requestedTools !== undefined &&
		childToolNames.includes("read") &&
		!childToolNames.includes("write");

	const prewalk: AgentConfigEntry = {
		value:
			prewalkResolution?.kind === "armed" ? formatModelStringWithRouting(prewalkResolution.prewalk.target) : null,
		source: cfgTaskAgentPrewalk.get(settings)[name]?.trim()
			? { layer: "agent-entry", key: `task.agentPrewalk.${name}` }
			: agent.prewalk !== undefined
				? { layer: "frontmatter", key: "prewalk" }
				: prewalkPattern ||
					  (agent.source === "bundled" && name === "task" && cfgTaskPrewalk.provenance(settings) !== "default")
					? settingSource(cfgTaskPrewalk, settings)
					: { layer: "default" },
		note: seance
			? "a seance never hands off"
			: prewalkResolution?.kind === "unavailable"
				? `skipped: no available model with credentials matches ${prewalkPattern}`
				: prewalkResolution?.kind === "noop"
					? "skipped: same model and thinking level as the start"
					: undefined,
	};

	const advisorEntries = advisor ? await resolveAdvisorRoster(cwd, childSettings, modelRegistry) : undefined;

	return {
		name,
		definedIn: agent.source,
		filePath: agent.filePath,
		disabled: cfgTaskDisabledAgents.get(settings).includes(name),
		model: modelEntry,
		thinking,
		serviceTier,
		compaction,
		requestBudget,
		tools: {
			value: childToolNames,
			source: agent.tools ? { layer: "frontmatter", key: "tools" } : { layer: "session" },
			note: `built-ins only; ${seance ? "a seance gets no MCP or extension tools" : "MCP and extension tools come from the session"}${deviceOnlyWrite ? "; write is granted for xd:// devices only" : ""}`,
		},
		prewalk,
		advisor: {
			value: advisorEntries?.value.length ? advisorEntries.value : null,
			source: cfgTaskAgentAdvisor.get(settings)[name]?.trim()
				? { layer: "agent-entry", key: `task.agentAdvisor.${name}` }
				: agent.advisor !== undefined
					? { layer: "frontmatter", key: "advisor" }
					: { layer: "default" },
			note: seance ? "a seance runs unadvised" : advisorEntries?.note,
		},
		accountPools: {
			value: entries.accountPools ?? null,
			source: entries.accountPools
				? { layer: "agent-entry", key: `task.agentAccountPools.${name}` }
				: { layer: "default" },
		},
		idleTtlMs: {
			value: Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(settings)) || 0),
			source: settingSource(cfgTaskAgentIdleTtlMs, settings),
		},
	};
}

/**
 * Advisors the child session starts: each enabled WATCHDOG.yml roster entry on
 * its explicit model or the advisor role, or the role alone when no roster exists.
 * Like the session, which retries a `no_model` advisor once its initial discovery
 * settles, an advisor left without a model awaits one discovery pass and resolves again.
 */
async function resolveAdvisorRoster(
	cwd: string,
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<{ value: string[]; note?: string }> {
	const { advisors } = await discoverAdvisorConfigs(cwd, getAgentDir());
	let roster = resolveAdvisorModels(advisors, settings, modelRegistry);
	if (roster.unresolved.length > 0 && modelRegistry.getDiscoverableProviders().length > 0) {
		await modelRegistry.refresh("online-if-uncached");
		roster = resolveAdvisorModels(advisors, settings, modelRegistry);
	}
	if (advisors.length === 0) {
		return roster.value.length > 0 ? roster : { value: [], note: "no available model for the advisor role" };
	}
	const notes = ["roster from WATCHDOG.yml"];
	if (roster.unresolved.length > 0) notes.push(`no model for ${roster.unresolved.join(", ")}`);
	return { value: roster.value, note: notes.join("; ") };
}

function resolveAdvisorModels(
	advisors: DiscoveredAdvisors["advisors"],
	settings: Settings,
	modelRegistry: ModelRegistry,
): { value: string[]; unresolved: string[] } {
	const roleModel = resolveAdvisorRoleSelection(settings, modelRegistry.getAvailable())?.model;
	if (advisors.length === 0) {
		return roleModel
			? { value: [formatModelStringWithRouting(roleModel)], unresolved: [] }
			: { value: [], unresolved: ["advisor role"] };
	}
	const value: string[] = [];
	const unresolved: string[] = [];
	for (const config of advisors) {
		if (config.enabled === false) continue;
		const model = config.model ? resolveModelOverride([config.model], modelRegistry, settings).model : roleModel;
		if (model) value.push(`${config.name}: ${formatModelStringWithRouting(model)}`);
		else unresolved.push(config.name);
	}
	return { value, unresolved };
}

function clampThinking(entry: AgentConfigEntry, model: Model | undefined): AgentConfigEntry {
	const level = typeof entry.value === "string" ? parseThinkingLevel(entry.value) : undefined;
	if (!model || level === undefined) return entry;
	const clamped = resolveThinkingLevelForModel(model, level);
	if (clamped === level) return entry;
	const clampNote = `clamped from ${level}`;
	return { ...entry, value: clamped ?? null, note: entry.note ? `${entry.note}; ${clampNote}` : clampNote };
}
