import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { buildServiceTierByFamily } from "../config/service-tier";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings";
import type { SlashCommandSpec } from "./types";

/**
 * Maps a sampling setting value to the agent-field form: negative sentinels
 * mean provider default and clear the field.
 */
function optionalNumber(raw: unknown): number | undefined {
	const num = typeof raw === "number" ? raw : Number(raw);
	return num >= 0 ? num : undefined;
}

export const BUILTIN_SETTINGS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "reload-settings",
		aliases: ["reload-config"],
		description:
			"Re-read config.yml (and project/overlay settings) from disk, refresh the models.yml model catalog, and apply both without a restart",
		acpDescription: "Reload settings and models from disk",
		handle: async (_command, runtime) => {
			const before = new Map<SettingPath, unknown>();
			for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
				before.set(key, runtime.settings.get(key));
			}
			await runtime.settings.reloadFromDisk();
			await runtime.notifyConfigChanged?.();
			// Refresh AFTER the settings reload so provider discovery sees the new
			// disabled-provider set: an edit that enables a discovery-backed
			// provider must surface its models in the same reload. Then re-resolve
			// role consumers — the reload's modelRoles signal fired against the
			// pre-refresh registry, so an advisor may have recorded no_model for a
			// role that resolves fine now.
			let modelsFailure: string | undefined;
			try {
				await runtime.session?.refreshModels();
			} catch (error) {
				modelsFailure = error instanceof Error ? error.message : String(error);
			}
			runtime.session?.reapplyModelRoles();
			// Provider selection globals are module state consumed by web search
			// and image tools in every host; a layer swap alone does not update it.
			applyProviderGlobalsFromSettings(runtime.settings);
			if (runtime.session && before.get("inspect_image.mode") !== runtime.settings.get("inspect_image.mode")) {
				await runtime.session.applyInspectImageModeChange();
			}
			// Reconcile session-owned settings the reload cannot reach on its own:
			// the live session snapshots these at construction (agent/SDK fields),
			// so settings.get() alone would report them applied without changing
			// actual behavior. persist=false — the value may come from a project
			// or --config overlay, and writing it through settings.set would
			// promote an overlay-only value into global config.
			let scopeChanged = false;
			let scopeFailure: string | undefined;
			if (runtime.session) {
				// Re-resolve the settings-derived model scope AFTER reloadFromDisk (new
				// enabledModels values) and after refreshModels (fresh registry): the
				// session freezes its scope at construction, so a reload that adds a
				// model must push the rebuilt list or every scoped picker keeps the
				// startup snapshot until restart.
				try {
					scopeChanged = (await runtime.session.refreshScopedModels?.()) ?? false;
				} catch (error) {
					scopeFailure = error instanceof Error ? error.message : String(error);
				}
				const nextAdvisorEnabled = runtime.settings.get("advisor.enabled");
				if (runtime.session.isAdvisorEnabled() !== nextAdvisorEnabled) {
					runtime.session.setAdvisorEnabled(nextAdvisorEnabled);
				}
				const nextSteeringMode = runtime.settings.get("steeringMode");
				if (runtime.session.steeringMode !== nextSteeringMode) {
					runtime.session.setSteeringMode(nextSteeringMode, false);
				}
				const nextFollowUpMode = runtime.settings.get("followUpMode");
				if (runtime.session.followUpMode !== nextFollowUpMode) {
					runtime.session.setFollowUpMode(nextFollowUpMode, false);
				}
				const nextInterruptMode = runtime.settings.get("interruptMode");
				if (runtime.session.interruptMode !== nextInterruptMode) {
					runtime.session.setInterruptMode(nextInterruptMode, false);
				}
				// Agent-owned request options: written through agent fields (never
				// persisted), read per request by the SDK in every mode, so this
				// reconcile is mode-independent. Negative settings values mean
				// provider default and clear the field.
				const agent = runtime.session.agent;
				const nextTemperature = optionalNumber(runtime.settings.get("temperature"));
				if (agent.temperature !== nextTemperature) {
					agent.temperature = nextTemperature;
				}
				const nextTopP = optionalNumber(runtime.settings.get("topP"));
				if (agent.topP !== nextTopP) {
					agent.topP = nextTopP;
				}
				const nextTopK = optionalNumber(runtime.settings.get("topK"));
				if (agent.topK !== nextTopK) {
					agent.topK = nextTopK;
				}
				const nextMinP = optionalNumber(runtime.settings.get("minP"));
				if (agent.minP !== nextMinP) {
					agent.minP = nextMinP;
				}
				const nextPresencePenalty = optionalNumber(runtime.settings.get("presencePenalty"));
				if (agent.presencePenalty !== nextPresencePenalty) {
					agent.presencePenalty = nextPresencePenalty;
				}
				const nextRepetitionPenalty = optionalNumber(runtime.settings.get("repetitionPenalty"));
				if (agent.repetitionPenalty !== nextRepetitionPenalty) {
					agent.repetitionPenalty = nextRepetitionPenalty;
				}
				const nextOmitThinking = runtime.settings.get("omitThinking");
				if (agent.hideThinkingSummary !== nextOmitThinking) {
					agent.hideThinkingSummary = nextOmitThinking;
				}
				// Service tiers snapshot into ModelControls at construction; rebuild
				// the per-family map from the reloaded `tier.*` settings and apply
				// per-family changes so requests use the new tier without a restart.
				// setServiceTierFamily does not persist — it mutates the live map.
				const nextTierByFamily = buildServiceTierByFamily(
					runtime.settings.get("tier.openai"),
					runtime.settings.get("tier.anthropic"),
					runtime.settings.get("tier.google"),
				);
				for (const family of ["openai", "anthropic", "google"] as const) {
					const next = nextTierByFamily[family];
					if (runtime.session.serviceTierByFamily[family] !== next) {
						runtime.session.setServiceTierFamily(family, next);
					}
				}
				// Workspace roots snapshot into SessionManager at construction
				// (tools and the system prompt read the live list from it), so an
				// on-disk edit to additionalDirectories must be pushed into the
				// manager and the base prompt rebuilt — the same flow /add-dir
				// and /remove-dir use.
				const nextDirs = runtime.settings.get("workspace.additionalDirectories");
				const currentDirs = runtime.sessionManager.getAdditionalDirectories();
				if (!Bun.deepEquals(nextDirs, currentDirs)) {
					await runtime.sessionManager.setAdditionalDirectories(nextDirs);
					await runtime.session.refreshBaseSystemPrompt();
				}
				// The bash tool snapshots the async-execution settings into its schema
				// and description at construction, and the async job manager copies its
				// running-job cap at session start. A reloaded async or
				// bash.autoBackground value would be reported as applied while the live
				// objects kept the old value until restart, so push the new values in.
				if (
					before.get("async.enabled") !== runtime.settings.get("async.enabled") ||
					before.get("bash.autoBackground.enabled") !== runtime.settings.get("bash.autoBackground.enabled") ||
					before.get("bash.autoBackground.thresholdMs") !== runtime.settings.get("bash.autoBackground.thresholdMs")
				) {
					await runtime.session.reconcileBashToolSettings();
				}
				if (before.get("async.maxJobs") !== runtime.settings.get("async.maxJobs")) {
					runtime.session.asyncJobManager?.setMaxRunningJobs(runtime.settings.get("async.maxJobs"));
				}
			}
			const changed: SettingPath[] = [];
			for (const [key, previous] of before) {
				if (!Bun.deepEquals(previous, runtime.settings.get(key))) {
					changed.push(key);
				}
			}
			const scopeNote = scopeFailure
				? ` Model scope refresh failed: ${scopeFailure}`
				: scopeChanged
					? " Model scope re-resolved."
					: "";
			if (modelsFailure) {
				await runtime.output(`Settings reloaded from disk (models.yml failed: ${modelsFailure})${scopeNote}`);
				return;
			}
			if (changed.length === 0) {
				await runtime.output(`Settings reloaded from disk. No effective values changed.${scopeNote}`);
				return;
			}
			await runtime.output(`Settings reloaded from disk. Applied: ${changed.join(", ")}${scopeNote}`);
		},
	},
];
