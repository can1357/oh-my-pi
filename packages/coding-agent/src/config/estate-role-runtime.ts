import type { AgentDefinition } from "../task/types";
import type { Settings } from "./settings";
import {
	type EstateRoleCoordinationEntry,
	type EstateRoleCoordinationRegistry,
	loadWorkspaceEstateRoleCoordination,
} from "./estate-role-coordination";

/** Agent types that participate in review fan-in (parallel adversarial review, not blocking delivery). */
export const REVIEW_AGENT_NAMES = new Set(["reviewer", "security-reviewer"]);

/** Load the workspace role-coordination registry from settings + cwd. */
export function loadTaskRoleCoordination(settings: Settings, cwd: string): EstateRoleCoordinationRegistry | undefined {
	const override = settings.get("task.roleCoordinationFile");
	return loadWorkspaceEstateRoleCoordination(cwd, override || undefined);
}

/** Merge agent frontmatter `blocking` with the `task.agentBlocking` settings overlay. */
export function resolveEffectiveAgentBlocking(
	agent: AgentDefinition,
	settingsBlocking: Record<string, boolean>,
): boolean {
	return agent.blocking === true || settingsBlocking[agent.name] === true;
}

export function isReviewAgent(agentName: string): boolean {
	return REVIEW_AGENT_NAMES.has(agentName);
}

/** Resolve a coordination entry for an agent name (direct role key or slug-normalized role). */
export function lookupCoordinationForAgent(
	registry: EstateRoleCoordinationRegistry | undefined,
	agentName: string,
): EstateRoleCoordinationEntry | undefined {
	if (!registry) return undefined;
	const direct = registry.byRole.get(agentName);
	if (direct) return direct;
	const slug = agentName.toLowerCase();
	for (const entry of registry.roles) {
		if (entry.role.toLowerCase().replace(/\s+/g, "-") === slug) return entry;
	}
	return undefined;
}

export interface SpawnFanInPartition {
	blockingIndices: number[];
	asyncIndices: number[];
	reviewIndices: number[];
}

/** Classify a batch spawn into blocking sync, async detached, and review-branch indices. */
export function partitionSpawnFanIn(agents: readonly string[], itemBlocking: readonly boolean[]): SpawnFanInPartition {
	const blockingIndices: number[] = [];
	const asyncIndices: number[] = [];
	const reviewIndices: number[] = [];
	for (let index = 0; index < agents.length; index++) {
		const agentName = agents[index]!;
		if (isReviewAgent(agentName)) reviewIndices.push(index);
		if (itemBlocking[index]) blockingIndices.push(index);
		else asyncIndices.push(index);
	}
	return { blockingIndices, asyncIndices, reviewIndices };
}

/**
 * Advisory for mixed implementation + reviewer batches: review runs alongside
 * delivery and fans findings back to the owning lead via hub, not serial relay.
 */
export function buildReviewFanInAdvisory(
	partition: SpawnFanInPartition,
	agents: readonly string[],
): string | undefined {
	if (partition.reviewIndices.length === 0) return undefined;
	const implementationIndices = agents
		.map((_, index) => index)
		.filter(index => !partition.reviewIndices.includes(index));
	if (implementationIndices.length === 0) return undefined;
	const reviewers = partition.reviewIndices.map(index => agents[index]!).join(", ");
	const implementers = implementationIndices.map(index => agents[index]!).join(", ");
	return (
		`Review fan-in: \`${reviewers}\` runs alongside \`${implementers}\`; ` +
		`send findings to the owning technical lead via \`hub\` — parallel review, not a serial gate.`
	);
}

/** Format requested model patterns for HUD / progress surfaces. */
export function formatRequestedModelRoute(patterns: readonly string[] | undefined): string | undefined {
	if (!patterns || patterns.length === 0) return undefined;
	return patterns.map(pattern => pattern.replace(/^@/, "")).join(">");
}

/** Advisory when spawned agents map to coordination-registry roles (thread ownership). */
export function buildCoordinationRegistryAdvisory(
	registry: EstateRoleCoordinationRegistry | undefined,
	agents: readonly string[],
): string | undefined {
	if (!registry) return undefined;
	const threads = agents
		.map(agent => lookupCoordinationForAgent(registry, agent)?.thread)
		.filter((thread): thread is string => Boolean(thread));
	const unique = [...new Set(threads)];
	if (unique.length === 0) return undefined;
	return `Coordination registry: active roles map to thread(s) ${unique.map(t => `\`${t}\``).join(", ")} — use \`hub\` for cross-role handoff.`;
}
