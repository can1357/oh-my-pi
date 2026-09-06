/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "task";

const REVIEW_AGENT_NAMES = new Set(["reviewer", "security-reviewer"]);

function isReviewAgent(agentName: string): boolean {
	return REVIEW_AGENT_NAMES.has(agentName);
}

/**
 * Estate DEFAULT spine: when the parent omits `agent`, route to the first
 * implementation (non-reviewer) child declared in `spawns`, or the known
 * hierarchy fallback when spawns are unrestricted (`*`).
 */
export const ESTATE_IMPLEMENTATION_DEFAULTS: Readonly<Record<string, string>> = {
	"estate-sol": "task",
	task: "estate-terra",
	"estate-terra": "estate-luna",
	"estate-luna": "estate-muse",
};

/** Resolve the default child agent for an omitted `agent` field. */
export function resolveDefaultSpawnAgent(
	parentSpawns: string | boolean | null | undefined,
	parentAgentName?: string | null,
): string {
	const policy = resolveSpawnPolicy(parentSpawns);
	if (policy.allowedAgents !== null) {
		const implementation = policy.allowedAgents.find(agent => !isReviewAgent(agent));
		return implementation ?? policy.defaultAgent;
	}
	if (parentAgentName) {
		const fallback = ESTATE_IMPLEMENTATION_DEFAULTS[parentAgentName];
		if (fallback) return fallback;
	}
	return policy.defaultAgent;
}

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
