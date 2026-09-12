import { reconcileProviderSets } from "../capability";
import { bucketRules } from "../capability/rule-buckets";
import { MAIN_AGENT_RULE_NAME, ruleCapability, setActiveRules, type Rule } from "../capability/rule";
import { applyProviderGlobalsFromSettings } from "../config/provider-globals";
import { serviceTierSettingToTier } from "../config/service-tier";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings";
import { loadCapability } from "../discovery";
import { additionalWorkspaceDirectories, normalizeSessionWorkspace } from "../session/session-workspace";
import type { SlashCommandSpec } from "./types";

/**
 * Maps a sampling setting value to the agent-field form: negative sentinels
 * mean provider default and clear the field.
 */
function optionalNumber(raw: unknown): number | undefined {
	const num = typeof raw === "number" ? raw : Number(raw);
	return num >= 0 ? num : undefined;
}

/**
 * Settings consumed only while the base system prompt is being rebuilt: their
 * readers pull the live values at rebuild time, so a reloaded value needs
 * exactly one prompt rebuild to take effect.
 */
const PROMPT_KEYS: Partial<Record<SettingPath, true>> = {
	skillful: true,
	"task.batch": true,
	"task.maxConcurrency": true,
	"task.disabledAgents": true,
	"security.enabled": true,
	// The prompt rebuild reads the live obfuscator state (slice C makes the
	// sdk closure read it live instead of the construction-time constant),
	// and this handler reconciles the obfuscator before the prompt pass, so
	// a flipped gate reaches the prompt without a restart.
	"secrets.enabled": true,
	includeModelInPrompt: true,
	personality: true,
	"tui.reactions": true,
	"tools.xdevDocs": true,
	// The inline allowlist feeds xdevDocsAll() at prompt-rebuild time exactly
	// like tools.xdevDocs does (sdk.ts passes both live), so an edited
	// allowlist needs the same one rebuild to reach the model.
	"tools.xdevInlineDevices": true,
};

/**
 * Settings snapshotted into private Agent fields at session construction with
 * no live setter: sdk.ts reads each once while building the Agent and the
 * value rides every later request from that snapshot, so a reload cannot
 * apply them. They are reported as restart-required instead of "Applied".
 */
const RESTART_REQUIRED_KEYS: Partial<Record<SettingPath, true>> = {
	// sdk.ts construction → Agent `#kimiApiFormat` (packages/agent/src/agent.ts).
	"providers.kimiApiFormat": true,
	// sdk.ts construction → Agent `#preferWebsockets`.
	"providers.openaiWebsockets": true,
	// sdk.ts construction → Agent `#dialect` via resolveDialect.
	"tools.format": true,
	// sdk.ts construction → Agent `#abortOnFabricatedToolResult`.
	"tools.abortOnFabricatedResult": true,
	// createTools() filters the default tool roster through isToolAllowed
	// (tools/index.ts) once at session start and no live registry rebuild
	// exists, so a flipped gate leaves the startup roster until restart.
	// security.enabled also feeds the prompt (PROMPT_KEYS), which still
	// applies live; the restart note covers the roster half.
	"bash.enabled": true,
	"glob.enabled": true,
	"grep.enabled": true,
	"github.enabled": true,
	"astGrep.enabled": true,
	"astEdit.enabled": true,
	"web_search.enabled": true,
	"security.enabled": true,
	"ask.enabled": true,
	"debug.enabled": true,
	"todo.enabled": true,
	"lsp.enabled": true,
	"checkpoint.enabled": true,
	"autolearn.enabled": true,
	// sdk.ts mounts the image-generation tools and the TTS tool into the
	// session's custom-tools extension only while building the initial
	// registry (createAgentSessionScoped); no reload reconciler adds or
	// removes custom tools, so a flipped gate keeps the startup tool set
	// until restart.
	"generate_image.enabled": true,
	"speechgen.enabled": true,
	// The rebucketed rule set reaches stream matching and rule:// live
	// (setActiveRules in the handler below), but the sdk prompt closure keeps
	// its construction-time buckets: bucketRules routes TTSR-conditioned
	// rules through TtsrManager.addRule, which rejects every rule while
	// ttsr.enabled is false, so the always-apply/rulebook split — and with it
	// the injected prompt content — differs per key and stays stale until
	// restart. Deliberately absent: task.maxRecursionDepth and goal.enabled
	// (live spawn-time/lazy-registration paths) and memory.backend and
	// externalThinking (live via the host setting replay).
	"ttsr.enabled": true,
	"ttsr.builtinRules": true,
	"ttsr.disabledRules": true,
	// sdk.ts captures includeWorkspaceTree once at startup: the flag decides
	// whether workspaceTreePromise builds a tree (empty placeholder when off),
	// and the prompt closure keeps its own construction-time copy, so a
	// flipped flag leaves the startup tree and prompt block until restart.
	includeWorkspaceTree: true,
	// SnapcompactInlineTransformer is constructed once from the startup
	// snapcompact group; neither its render modes nor its shape re-read
	// settings, so imaged prompt/tool-result output keeps the startup
	// behavior until restart.
	"snapcompact.systemPrompt": true,
	"snapcompact.toolResults": true,
	"snapcompact.shape": true,
	// SDK-init-time closure constants (see session-tools.ts): the prompt
	// rebuild reads the captured values, not the live settings, and the
	// first two also snapshot into private Agent request fields, so prompt
	// rebuilds and requests keep the construction-time decisions.
	// task.eager's eager-task prelude re-reads live, but the prompt's
	// delegation-guidance half (eagerTasks/eagerTasksAlways) stays stale.
	inlineToolDescriptors: true,
	"tools.intentTracing": true,
	"task.eager": true,
};

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
			// Capability providers filter through module-level Sets seeded once at
			// startup (initializeWithSettings); a reloaded disabledProviders or
			// enabledProviders is reported as applied while loadCapability keeps
			// filtering on the stale sets until restart. Re-seed before the
			// catalog refresh so provider discovery sees the new enablement.
			if (
				!Bun.deepEquals(before.get("disabledProviders"), runtime.settings.get("disabledProviders")) ||
				!Bun.deepEquals(before.get("enabledProviders"), runtime.settings.get("enabledProviders"))
			) {
				reconcileProviderSets(runtime.settings);
			}
			// Plugin/extension surfaces (skills, file slash commands, task
			// agents, capability caches, MCP servers) are discovered through
			// caches seeded at startup; an edited extensions path list or
			// disabledExtensions set keeps filtering on the startup view. The
			// runtime hook is the same pipeline /reload-plugins runs, and the
			// session refreshSkills inside it rebuilds the base prompt, so
			// extension-driven skill changes reach the prompt in the same pass.
			// (Extension tools/hooks bound to the runner at session construction
			// still need a restart; the discovery-driven surfaces do not.)
			// mcp.enableProjectConfig rides the same pipeline: initial MCP
			// discovery snapshots the flag into the manager, while the TUI
			// reload pipeline's MCP re-discovery (MCPCommandController) re-reads
			// it live, so a flipped flag re-discovers project MCP servers under
			// the current value instead of waiting for a restart. ACP/RPC wire
			// reloadPlugins to a plugin-only pipeline that never touches MCP, so
			// there the trigger is a no-op and the flag still needs a restart.
			if (
				!Bun.deepEquals(before.get("extensions"), runtime.settings.get("extensions")) ||
				!Bun.deepEquals(before.get("disabledExtensions"), runtime.settings.get("disabledExtensions")) ||
				!Bun.deepEquals(before.get("mcp.enableProjectConfig"), runtime.settings.get("mcp.enableProjectConfig"))
			) {
				await runtime.reloadPlugins();
			}
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
			// Advertise AFTER the catalog refresh: hosts read the model list from
			// this push, and a catalog-only change emits no later model_changed,
			// so a pre-refresh push would advertise the stale catalog.
			await runtime.notifyConfigChanged?.();
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
				// Sync only when the setting itself changed: isAdvisorEnabled() also
				// tracks a session-level /advisor off override, and comparing live
				// state to the settings value on every reload would reset that
				// override even when nothing changed on disk.
				if (before.get("advisor.enabled") !== nextAdvisorEnabled) {
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
				// Service tiers snapshot into ModelControls at construction; apply
				// per-family changes from the reloaded `tier.*` settings so requests
				// use the new tier without a restart. setServiceTierFamily does not
				// persist — it mutates the live map. Gated per family on that
				// family's own setting changing: the live serviceTierByFamily also
				// carries session-only /fast overrides that a sibling family's edit
				// (or a no-op reload) must not reset to the settings default.
				for (const family of ["openai", "anthropic", "google"] as const) {
					const key: SettingPath = `tier.${family}`;
					if (before.get(key) === runtime.settings.get(key)) continue;
					const next = serviceTierSettingToTier(runtime.settings.get(key));
					if (runtime.session.serviceTierByFamily[family] !== next) {
						runtime.session.setServiceTierFamily(family, next);
					}
				}
				// Workspace roots snapshot into SessionManager at construction
				// (tools and the system prompt read the live list from it), so an
				// on-disk edit to additionalDirectories must reach the manager and
				// rebuild the base prompt — through the same per-directory flow
				// /add-dir and /remove-dir use. Only the settings-derived delta is
				// applied: getAdditionalDirectories() also holds session-added
				// roots (--add-dir, /add-dir), and a wholesale replace would drop
				// them and rewrite the session header on every reload.
				const nextRoots = additionalWorkspaceDirectories(
					normalizeSessionWorkspace({
						cwd: runtime.cwd,
						directories: runtime.settings.get("workspace.additionalDirectories"),
					}),
				);
				const previousRoots = additionalWorkspaceDirectories(
					normalizeSessionWorkspace({
						cwd: runtime.cwd,
						directories: before.get("workspace.additionalDirectories") as string[] | undefined,
					}),
				);
				const previousRootSet = new Set(previousRoots);
				const nextRootSet = new Set(nextRoots);
				let rootsChanged = false;
				for (const root of nextRoots) {
					if (previousRootSet.has(root)) continue;
					// "settings" source: a delta add must not claim the root as
					// session-supplied — only /add-dir and header restores do.
					if ((await runtime.sessionManager.addWorkspaceDirectory(root, "settings")) !== null) {
						rootsChanged = true;
					}
				}
				for (const root of previousRoots) {
					if (nextRootSet.has(root)) continue;
					// A root another source still supplies (--add-dir, a resumed
					// session header, a later /add-dir) is deduplicated into the same
					// manager entry; withdrawing it from settings must not revoke
					// that other source's claim.
					if (runtime.sessionManager.isSessionSuppliedDirectory(root)) continue;
					if ((await runtime.sessionManager.removeWorkspaceDirectory(root)) !== null) rootsChanged = true;
				}
				if (rootsChanged) {
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
				// The read and write tools snapshot their limits and LSP write
				// behavior at construction, so a reloaded value would be reported
				// as applied while the live tools kept the old one.
				if (
					before.get("read.defaultLimit") !== runtime.settings.get("read.defaultLimit") ||
					before.get("images.autoResize") !== runtime.settings.get("images.autoResize") ||
					before.get("lsp.formatOnWrite") !== runtime.settings.get("lsp.formatOnWrite") ||
					before.get("lsp.diagnosticsOnWrite") !== runtime.settings.get("lsp.diagnosticsOnWrite") ||
					before.get("lsp.diagnosticsDeduplicate") !== runtime.settings.get("lsp.diagnosticsDeduplicate")
				) {
					await runtime.session.reconcileToolSettings();
				}
				if (before.get("async.maxJobs") !== runtime.settings.get("async.maxJobs")) {
					runtime.session.asyncJobManager?.setMaxRunningJobs(runtime.settings.get("async.maxJobs"));
				}
				// The Agent snapshots the thinkingBudgets group at construction and
				// forwards the cached value on every request, so a reloaded budget
				// would be reported as applied while reasoning kept the old tokens.
				const nextThinkingBudgets = runtime.settings.getGroup("thinkingBudgets");
				if (!Bun.deepEquals(agent.thinkingBudgets, nextThinkingBudgets)) {
					agent.thinkingBudgets = nextThinkingBudgets;
				}
				// The owned browser idle-close deadline is armed from the
				// browser.idleCloseSec effective-change listener, which
				// reloadFromDisk does not emit: re-arm it here or an armed timer
				// keeps closing tabs on the old delay.
				if (before.get("browser.idleCloseSec") !== runtime.settings.get("browser.idleCloseSec")) {
					runtime.session.reconcileBrowserIdleClose();
				}
				// The browser MCP filter, MCP tools, and base prompt are reconciled
				// by the browser.enabled/computer.enabled effective-change
				// listeners, which reloadFromDisk does not emit: re-run them here
				// or a flipped eval prelude keeps the old tool set until restart.
				if (before.get("browser.enabled") !== runtime.settings.get("browser.enabled")) {
					await runtime.session.reconcileBrowserEnabled();
				}
				if (before.get("computer.enabled") !== runtime.settings.get("computer.enabled")) {
					await runtime.session.reconcileComputerEnabled();
				}
				// The broker-shared LSP attach flag is process-global module state
				// written once at session creation from enableLsp && lsp.shared and
				// consulted on every LSP client cold-start: without a re-apply, a
				// reloaded lsp.shared is reported as applied while cold-starts keep
				// the old decision until restart.
				if (before.get("lsp.shared") !== runtime.settings.get("lsp.shared")) {
					runtime.session.reconcileSharedLsp();
				}
				// The session builds its secret obfuscator once at construction, and the
				// settings hook only flips global redaction: without a rebuild here,
				// secrets newly enabled by this reload still ship to the provider unredacted.
				if (before.get("secrets.enabled") !== runtime.settings.get("secrets.enabled")) {
					await runtime.session.reconcileSecretObfuscator();
				}
				// Skill discovery and every prompt-affecting input are read live by
				// the prompt rebuild, but only when something asks for one:
				// refreshSkills() re-reads the skill directories AND rebuilds the
				// base prompt in the same pass, so it absorbs a simultaneously
				// reloaded prompt key and the two paths never double-rebuild. A
				// prompt key without a skills change rebuilds directly.
				let skillsChanged = false;
				let promptChanged = false;
				for (const [key, previous] of before) {
					if (Bun.deepEquals(previous, runtime.settings.get(key))) {
						continue;
					}
					// Provider-filter changes re-seed the discovery sets earlier in
					// this handler, but already-loaded skills keep their
					// provider-filtered content until a capability refresh, so
					// they ride the same refreshSkills() pass as skills.* keys.
					if (key === "enabledProviders" || key === "disabledProviders" || key.startsWith("skills.")) {
						skillsChanged = true;
					} else if (PROMPT_KEYS[key]) {
						promptChanged = true;
					}
					if (skillsChanged && promptChanged) {
						break;
					}
				}
				if (!skillsChanged && promptChanged) {
					await runtime.session.refreshBaseSystemPrompt();
				}
				if (skillsChanged) {
					await runtime.session.refreshSkills();
				}
				// The TtsrManager merges the ttsr group once in its constructor and
				// reads that snapshot on every match/repeat decision, so a reloaded
				// manager-level key would keep the old behavior until restart.
				if (
					before.get("ttsr.enabled") !== runtime.settings.get("ttsr.enabled") ||
					before.get("ttsr.contextMode") !== runtime.settings.get("ttsr.contextMode") ||
					before.get("ttsr.interruptMode") !== runtime.settings.get("ttsr.interruptMode") ||
					before.get("ttsr.repeatMode") !== runtime.settings.get("ttsr.repeatMode") ||
					before.get("ttsr.repeatGap") !== runtime.settings.get("ttsr.repeatGap")
				) {
					runtime.session.updateTtsrSettings(runtime.settings.getGroup("ttsr"));
				}
				// Registration settings were baked into the rule set once at session
				// construction: bucketRules ran while the manager was still disabled,
				// so flipping ttsr.enabled on left the rule map empty, and
				// builtinRules/disabledRules never re-bucketed the discovered
				// inventory. Re-run the same discovery + bucketRules funnel the
				// session used at construction and replace the active rule snapshot.
				// Slash commands only run in main sessions, so the main agent name
				// matches the construction pass. Stream matching and rule:// go
				// live immediately; the sdk prompt closure keeps its
				// construction-time buckets, so these keys are reported
				// restart-required (see RESTART_REQUIRED_KEYS) while the
				// rebucket itself still applies.
				const ttsrRegistrationChanged =
					before.get("ttsr.enabled") !== runtime.settings.get("ttsr.enabled") ||
					before.get("ttsr.builtinRules") !== runtime.settings.get("ttsr.builtinRules") ||
					!Bun.deepEquals(before.get("ttsr.disabledRules"), runtime.settings.get("ttsr.disabledRules"));
				if (ttsrRegistrationChanged && runtime.session.ttsrManager) {
					const manager = runtime.session.ttsrManager;
					const rulesResult = await loadCapability<Rule>(ruleCapability.id, { cwd: runtime.cwd });
					manager.clearRules();
					const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, manager, {
						builtinRules: runtime.settings.get("ttsr.builtinRules"),
						disabledRules: runtime.settings.get("ttsr.disabledRules"),
						agentName: MAIN_AGENT_RULE_NAME,
					});
					setActiveRules([...rulebookRules, ...alwaysApplyRules, ...manager.getRules()]);
				}
			}
			const changed: SettingPath[] = [];
			const restartRequired: SettingPath[] = [];
			for (const [key, previous] of before) {
				if (Bun.deepEquals(previous, runtime.settings.get(key))) {
					continue;
				}
				// Construction-snapshotted Agent fields have no live setter, so a
				// reload cannot apply them — report them honestly instead of
				// claiming they took effect.
				if (RESTART_REQUIRED_KEYS[key]) {
					restartRequired.push(key);
				} else {
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
			if (changed.length === 0 && restartRequired.length === 0) {
				await runtime.output(`Settings reloaded from disk. No effective values changed.${scopeNote}`);
				return;
			}
			const appliedNote = changed.length > 0 ? ` Applied: ${changed.join(", ")}` : "";
			const restartNote = restartRequired.length > 0 ? ` Restart required: ${restartRequired.join(", ")}` : "";
			await runtime.output(`Settings reloaded from disk.${appliedNote}${restartNote}${scopeNote}`);
		},
	},
];
