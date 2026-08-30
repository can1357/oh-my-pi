/**
 * In-session roster reload — re-scan skills + rules from disk and swap the
 * process-global snapshots without tearing down the session.
 *
 * Everything the harness reads once at session-start is otherwise frozen for
 * that session's life. A mid-wave change to a skill or rule (a nix sync of a
 * new skill, an edited rulebook entry) is invisible to already-running sessions
 * until a full restart. This primitive re-runs the exact discovery pipeline
 * `createAgentSession` runs at init (`sdk.ts` `discoverSkills` +
 * `loadCapability(ruleCapability)` + `bucketRules`) and re-publishes the
 * `activeSkills`/`activeRules` globals with a pointer swap.
 *
 * The caller (`AgentSession.refresh`) is responsible for the parts a global
 * swap does NOT reach: the per-session `#skills` snapshot that `skill://`
 * actually binds (see `AgentSession.applyReloadedSkills`) and the system-prompt
 * rebuild that re-renders the advertised roster.
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { type Rule, ruleCapability, setActiveRules } from "../capability/rule";
import { bucketRules } from "../capability/rule-buckets";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { SkillsSettings } from "../config/settings";
import { loadCapability } from "../discovery";
import type { TtsrManager } from "../export/ttsr";
import { loadSkills, type Skill, setActiveSkills } from "./skills";

/**
 * Config surface(s) an in-session refresh re-reads from disk. Single-sourced:
 * the union type, the tool's arktype schema, and the slash-command validator
 * all derive from this one tuple, so adding a scope can't leave a runtime guard
 * silently stale.
 */
export const REFRESH_SCOPES = ["skills", "rules", "settings", "mcp", "all"] as const;
export type RefreshScope = (typeof REFRESH_SCOPES)[number];

/**
 * Outcome of an in-session refresh. Each field is populated only for the
 * surfaces the requested scope touched; an untouched surface stays `undefined`.
 */
export interface RefreshResult {
	/** Number of skills active after a roster reload. */
	skills?: number;
	/** Number of rules addressable via `rule://` after a roster reload. */
	rules?: number;
	/** Whether the merged settings view changed on a settings reload. */
	settingsChanged?: boolean;
	/** Whether the active default model was swapped on a settings reload. */
	modelSwapped?: boolean;
	/** Whether MCP servers were rediscovered and their tools rebound. `true` when the reconnect ran; `undefined` when no MCP manager existed. */
	mcp?: true;
	/** MCP servers that failed to reconnect on this refresh, message keyed by server name. Empty/undefined when every server connected. */
	mcpErrors?: Map<string, string>;
}

/** Inputs for a roster reload, sourced from the live session/settings. */
export interface ReloadSkillsAndRulesOptions {
	/** Working directory for project-local skills/rules. Default: `getProjectDir()`. */
	cwd?: string;
	/** Skills settings group (`settings.getGroup("skills")`), as at session init. */
	skillsSettings?: SkillsSettings;
	/** Disabled extension ids (`settings.get("disabledExtensions")`). */
	disabledExtensions?: string[];
	/**
	 * The live session's effective extension roots (explicit + mode + configured),
	 * forwarded to BOTH the skills and rules discovery so a post-startup roster
	 * reload honors the same extension scope the session started with — the same
	 * source the MCP reconnect path threads. Omitted here, discovery falls back to
	 * process-level roots: sessions with `additionalExtensionPaths` /
	 * `disableExtensionDiscovery` / session-local roots would lose explicitly
	 * supplied plugin skills/rules or load ambient extensions they excluded.
	 */
	extensionRoots?: EffectiveExtensionRoots;
	/**
	 * The live session's TTSR manager. Reused (not replaced) so a rule reload
	 * preserves in-flight injected/trigger state. New TTSR rules register via
	 * `addRule`; an EDITED condition on an already-registered rule is not
	 * re-read (`addRule` is name-idempotent) — that sub-case still needs a
	 * restart. Rulebook/always-apply changes and brand-new rules are picked up.
	 */
	ttsrManager: TtsrManager;
	/** TTSR gating from `settings.getGroup("ttsr")` — mirrors `bucketRules` at init. */
	ttsrSettings?: { builtinRules?: boolean; disabledRules?: readonly string[] };
	/**
	 * The session's resolved agent name (`sdk.ts` `resolvedAgentName`), forwarded
	 * to `bucketRules` exactly as init does. Omitted, `ruleAppliesToAgent` treats
	 * scoping as disabled and admits EVERY `agents`-scoped rule, so a refresh in
	 * a `main` session would activate rules scoped to other agents.
	 */
	agentName?: string;
	/**
	 * Caller-supplied rule policy (SDK `rules` array / `--no-rules`, which passes
	 * `rules: []`). When provided, these rules are re-bucketed instead of scanning
	 * disk, so a refresh cannot re-discover and re-enable ambient rules the
	 * session explicitly excluded — mirroring init (`sdk.ts`), which buckets
	 * `options.rules` when set rather than reading the rules capability. Omitted
	 * (`undefined`), the rules capability is re-scanned as before.
	 */
	rules?: readonly Rule[];
	/** Fresh skills, if the caller already discovered them (skips re-scan). */
	skills?: readonly Skill[];
}

/** Fresh roster produced by a reload — counts plus the swapped skills/rule buckets. */
export interface ReloadSkillsAndRulesResult {
	/** Number of skills now active. */
	skills: number;
	/** Number of rules addressable via `rule://` (rulebook + always + TTSR). */
	rules: number;
	/** The fresh skills, so the caller can fan them into per-session snapshots. */
	activeSkills: readonly Skill[];
	/** Fresh rulebook (described) rules, for threading into the prompt rebuild. */
	rulebookRules: Rule[];
	/** Fresh always-apply rules, for threading into the prompt rebuild. */
	alwaysApplyRules: Rule[];
	/**
	 * The COMPLETE, UNGATED rule set this reload discovered — before
	 * `disabledRules`/`builtinRules` dropped any of them. The caller re-snapshots
	 * it so a later settings-only refresh can apply gating in both directions
	 * (see `AgentSession.#sourceRosterRules`).
	 */
	sourceRules: readonly Rule[];
}

/**
 * Re-scan skills + rules from disk and swap the `activeSkills`/`activeRules`
 * process globals. Pure re-READ: no config file is written.
 *
 * `rule://` resolution reads `getActiveRules()` directly, so the `setActiveRules`
 * swap self-heals a rule miss with no further work. `skill://` binds a
 * per-session snapshot instead, so the returned `activeSkills` must be threaded
 * into the live sessions by the caller (`AgentSession.applyReloadedSkills`).
 */
export async function reloadSkillsAndRules(options: ReloadSkillsAndRulesOptions): Promise<ReloadSkillsAndRulesResult> {
	const cwd = options.cwd ?? getProjectDir();

	// Skills: re-run the same discovery `sdk.ts` runs at init (`discoverSkills`
	// is a thin wrapper over `loadSkills`; called directly here to avoid a cycle
	// back through the sdk entry point). Only cwd + the skills settings matter.
	const skills =
		options.skills ??
		(
			await loadSkills({
				...options.skillsSettings,
				disabledExtensions: options.disabledExtensions,
				extensionRoots: options.extensionRoots,
				cwd,
			})
		).skills;
	setActiveSkills(skills);

	// Rules: re-bucket through the LIVE ttsr manager (preserving injected state),
	// exactly as `sdk.ts` does at init. A caller-supplied rule policy (SDK `rules`
	// / `--no-rules`) is re-bucketed as-is; only when it is absent do we re-scan
	// the rules capability — otherwise a refresh would re-discover and re-enable
	// ambient rules the session explicitly excluded.
	const ruleItems =
		options.rules ??
		(await loadCapability<Rule>(ruleCapability.id, { cwd, extensionRoots: options.extensionRoots })).items;
	const { rulebookRules, alwaysApplyRules, ttsrRuleNames } = bucketRules(ruleItems, options.ttsrManager, {
		builtinRules: options.ttsrSettings?.builtinRules,
		disabledRules: options.ttsrSettings?.disabledRules,
		agentName: options.agentName,
	});
	// Reconcile the reused manager against the rules still discovered AND enabled.
	// A condition-bearing rule deleted from disk or newly disabled is absent from
	// `ttsrRuleNames`, so its stale registration is dropped here — otherwise the
	// `getRules()` spread below would republish it into `activeRules` (still
	// reachable via `rule://`, still triggering).
	options.ttsrManager.retainRules(ttsrRuleNames);
	const activeRules = [...rulebookRules, ...alwaysApplyRules, ...options.ttsrManager.getRules()];
	setActiveRules(activeRules);

	return {
		skills: skills.length,
		rules: activeRules.length,
		activeSkills: skills,
		rulebookRules,
		alwaysApplyRules,
		sourceRules: ruleItems,
	};
}
