import type { Settings } from "../config/settings";
import { cfgTaskIsolationAllowNested, cfgTaskIsolationEnabled } from "./settings";

/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "task";

/** Spawn policy derived from a parent agent's `spawns` frontmatter. */
export interface ResolvedSpawnPolicy {
	/** True when at least one subagent may be spawned. */
	enabled: boolean;
	/** Agent used when the caller omits the agent field. */
	defaultAgent: string;
	/** Explicitly allowed agents, or `null` when the policy is unrestricted. */
	allowedAgents: readonly string[] | null;
	/** Text used in spawn rejection messages. */
	allowedErrorText: string;
	/** Backtick-quoted explicit agents for prompt descriptions. */
	allowedPromptText?: string;
}

/** Resolves spawn frontmatter into the default and prompt/error surfaces. */
export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}

/** Session surface the nested-isolation gate consults. */
export interface IsolationGateSession {
	readonly settings: Settings;
	readonly isIsolated?: boolean;
}

/**
 * Whether `isolated` controls may be exposed for this session — on the task
 * wire schema, task/eval prompts, and the spawn preflight. Off when plan mode
 * is active (plan-mode agents never spawn isolated), when
 * `task.isolation.enabled` is false, or when the calling session is itself
 * isolated without `task.isolation.allowNested` (the nested-isolation gate).
 * Centralized so the task schema, task description, and eval description
 * cannot drift apart.
 */
/** Why {@link isIsolationAvailable} is off — lets the preflight fail fast with the matching message. */
export type IsolationUnavailableReason = "plan-mode" | "disabled" | "nested";

/**
 * Reason isolation controls are unavailable, or `undefined` when available.
 * Same predicate as {@link isIsolationAvailable}; prefer this in error paths
 * so the message cannot drift from the gate.
 */
export function isolationUnavailableReason(
	session: IsolationGateSession,
	planMode: boolean,
): IsolationUnavailableReason | undefined {
	if (planMode) return "plan-mode";
	if (cfgTaskIsolationEnabled.get(session.settings) !== true) return "disabled";
	if (session.isIsolated === true && cfgTaskIsolationAllowNested.get(session.settings) !== true) return "nested";
	return undefined;
}
export function isIsolationAvailable(session: IsolationGateSession, planMode: boolean): boolean {
	return (
		!planMode &&
		cfgTaskIsolationEnabled.get(session.settings) === true &&
		(cfgTaskIsolationAllowNested.get(session.settings) === true || session.isIsolated !== true)
	);
}

/**
 * Whether the `scout` agent is spawnable in a session: not disabled via
 * `task.disabledAgents`, and permitted by the session spawn policy.
 */
export function isScoutSpawnable(
	disabledAgents: readonly string[] | undefined,
	spawns: string | boolean | null | undefined,
): boolean {
	if (disabledAgents?.includes("scout")) return false;
	const policy = resolveSpawnPolicy(spawns);
	if (!policy.enabled) return false;
	return policy.allowedAgents === null || policy.allowedAgents.includes("scout");
}
