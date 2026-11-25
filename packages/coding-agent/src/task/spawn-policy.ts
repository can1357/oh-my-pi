import { $env } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { cfgTaskMaxRecursionDepth } from "./settings";
import { canSpawnAtDepth } from "./types";

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

/** Why a session cannot use an agent kind under its depth, recursion, and spawn policy. */
export function spawnDenial(
	session: Pick<ToolSession, "settings" | "taskDepth" | "getSessionSpawns">,
	agent: string,
	blockedAgent = $env.PI_BLOCKED_AGENT,
): string | undefined {
	const depth = session.taskDepth ?? 0;
	const maxDepth = cfgTaskMaxRecursionDepth.get(session.settings);
	if (!canSpawnAtDepth(maxDepth, depth)) {
		return `Cannot spawn another agent at task depth ${depth}; maximum depth is ${maxDepth}.`;
	}
	if (blockedAgent && blockedAgent === agent) {
		return `Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`;
	}
	const policy = resolveSpawnPolicy(session.getSessionSpawns());
	if (!policy.enabled || (policy.allowedAgents !== null && !policy.allowedAgents.includes(agent))) {
		return `Cannot spawn '${agent}'. Allowed: ${policy.allowedErrorText}`;
	}
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
