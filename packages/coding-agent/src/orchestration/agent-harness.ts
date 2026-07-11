/**
 * Orchestration-selected agent harness.
 *
 * Lighter agents receive a bounded tools + skills + decision surface chosen here
 * — children do not invent their own full catalog. Heavier agents keep a fuller
 * surface. Builds on {@link AgentExecutionProfile}, tool profiles, and
 * collaboration policy; does not allocate sessions or mutate settings.
 */

import type { Skill } from "../extensibility/skills";
import { type ResolvedToolProfile, resolveToolProfile, type ToolProfileInput } from "../tools/tool-profiles";
import {
	type AgentExecutionProfile,
	type AgentPolicyFields,
	type AgentTier,
	type CollaborationMode,
	resolveAgentExecutionProfile,
	type WorkClass,
} from "./agent-execution-profile";
import { type CollaborationPolicy, resolveCollaborationPolicy } from "./collaboration-policy";

/** How wide the child's operable surface is. */
export type AgentHarnessKind = "simple" | "standard" | "full";

/** Skill ceiling chosen by orchestration for this spawn. */
export interface SkillHarnessPolicy {
	readonly mode: "none" | "allowlist" | "all";
	/** When mode is allowlist, only these skill names may load. */
	readonly allowNames: readonly string[];
	/** Soft cap on skills passed into the child; `0` means unlimited. */
	readonly maxSkills: number;
}

/**
 * Decision burden the child is allowed to carry. Mechanical filtering (tools /
 * collaboration) enforces this; the guidance string is for operators/prompts.
 */
export interface DecisionSurface {
	readonly allowAsk: boolean;
	readonly allowTaskSpawn: boolean;
	readonly allowToolDiscovery: boolean;
	readonly allowSkillBrowse: boolean;
	readonly collaboration: CollaborationMode;
	readonly guidance: string;
}

/**
 * Immutable harness snapshot applied at spawn. Orchestration owns selection;
 * the child session consumes the ceilings.
 */
export interface AgentHarness {
	readonly kind: AgentHarnessKind;
	readonly profile: AgentExecutionProfile;
	readonly toolProfile: ResolvedToolProfile;
	readonly skillPolicy: SkillHarnessPolicy;
	readonly decisionSurface: DecisionSurface;
	readonly collaborationPolicy: CollaborationPolicy;
}

export interface AgentHarnessInput {
	/** Already-resolved execution profile. When omitted, resolved from `profileInput`. */
	execution?: AgentExecutionProfile;
	/** Used only when `execution` is absent. */
	profileInput?: Parameters<typeof resolveAgentExecutionProfile>[0];
	/** Agent type name (e.g. explore, quick_task) — seeds light defaults when set. */
	agentName?: string;
	/** Specialist role label from the parent spawn (informational; does not widen). */
	role?: string;
	agentTools?: ToolProfileInput["agentTools"];
	workflowTools?: ToolProfileInput["workflowTools"];
	declaredCapabilities?: ToolProfileInput["declaredCapabilities"];
	/** Explicit skill allowlist from the agent definition (`autoloadSkills`). */
	autoloadSkills?: readonly string[];
	/** Parent id for collaboration policy. */
	parentId?: string;
	requireYield?: boolean;
}

/**
 * Built-in type → restrictive seed. Only known light/mechanical workers are
 * listed; general-purpose agents (`task`, `oracle`, …) stay unrestricted until
 * settings or an assignment contract narrow them.
 */
const DEFAULT_AGENT_TYPE_HARNESS_SEEDS: Readonly<Record<string, AgentPolicyFields>> = Object.freeze({
	explore: Object.freeze({
		tier: "light" as const,
		autonomy: "bound" as const,
		collaboration: "report-only" as const,
		workClass: "mechanical" as const,
		editMode: "none" as const,
	}),
	quick_task: Object.freeze({
		tier: "mid" as const,
		autonomy: "bound" as const,
		collaboration: "report-only" as const,
		workClass: "mechanical" as const,
		editMode: "replace" as const,
	}),
	"mr-worker": Object.freeze({
		tier: "mid" as const,
		autonomy: "bound" as const,
		collaboration: "report-only" as const,
		workClass: "mechanical" as const,
		editMode: "none" as const,
	}),
	"mr-reducer": Object.freeze({
		tier: "mid" as const,
		autonomy: "supervised" as const,
		collaboration: "message-peers" as const,
		workClass: "judgment" as const,
		editMode: "none" as const,
	}),
});

const SIMPLE_SKILL_CAP = 2;
const STANDARD_SKILL_CAP = 8;

/**
 * Restrictive seed for a bundled agent type. Returns `undefined` when the type
 * keeps legacy unrestricted defaults (parent/settings must opt into a ceiling).
 */
export function defaultAgentTypeHarnessPolicy(agentName: string | undefined): AgentPolicyFields | undefined {
	if (!agentName) return undefined;
	const seed = DEFAULT_AGENT_TYPE_HARNESS_SEEDS[agentName.trim()];
	return seed ? { ...seed } : undefined;
}

function selectHarnessKind(
	tier: AgentTier,
	workClass: WorkClass,
	autonomy: AgentExecutionProfile["autonomy"],
): AgentHarnessKind {
	if (tier === "light") return "simple";
	if (tier === "mid") return "standard";
	// Frontier mechanical+bound still gets a standard surface — not the full catalog.
	if (workClass === "mechanical" && autonomy === "bound") return "standard";
	return "full";
}

function selectSkillPolicy(kind: AgentHarnessKind, autoloadSkills: readonly string[] | undefined): SkillHarnessPolicy {
	const allowNames = Object.freeze([...new Set((autoloadSkills ?? []).map(name => name.trim()).filter(Boolean))]);

	switch (kind) {
		case "simple":
			if (allowNames.length === 0) {
				return Object.freeze({ mode: "none" as const, allowNames: Object.freeze([] as string[]), maxSkills: 0 });
			}
			return Object.freeze({
				mode: "allowlist" as const,
				allowNames,
				maxSkills: SIMPLE_SKILL_CAP,
			});
		case "standard":
			if (allowNames.length > 0) {
				return Object.freeze({
					mode: "allowlist" as const,
					allowNames,
					maxSkills: STANDARD_SKILL_CAP,
				});
			}
			// No declared allowlist: still withhold the full catalog so mid agents
			// do not browse every skill; parents can pass skills explicitly later.
			return Object.freeze({
				mode: "none" as const,
				allowNames: Object.freeze([] as string[]),
				maxSkills: 0,
			});
		case "full":
			return Object.freeze({
				mode: "all" as const,
				allowNames: Object.freeze([] as string[]),
				maxSkills: 0,
			});
	}
}

function selectDecisionSurface(
	kind: AgentHarnessKind,
	profile: AgentExecutionProfile,
	toolProfile: ResolvedToolProfile,
): DecisionSurface {
	const collaboration = profile.collaboration;
	switch (kind) {
		case "simple":
			return Object.freeze({
				allowAsk: false,
				allowTaskSpawn: false,
				allowToolDiscovery: false,
				allowSkillBrowse: false,
				collaboration,
				guidance:
					"Simple harness: mechanical lookup/edit only. No nested task spawn, ask, tool discovery, or skill catalog browse. Report to parent; do not widen scope.",
			});
		case "standard":
			return Object.freeze({
				allowAsk: toolProfile.maximum.some(cap => cap.source === "builtin" && cap.name === "ask"),
				allowTaskSpawn: toolProfile.maximum.some(cap => cap.source === "builtin" && cap.name === "task"),
				allowToolDiscovery: toolProfile.allowDiscovery,
				allowSkillBrowse: false,
				collaboration,
				guidance:
					"Standard harness: bounded tools and skills. Prefer declared autoload skills; do not assume the full skill catalog or frontier tool set.",
			});
		case "full":
			return Object.freeze({
				allowAsk: true,
				allowTaskSpawn: true,
				allowToolDiscovery: toolProfile.allowDiscovery,
				allowSkillBrowse: true,
				collaboration,
				guidance: "Full harness: unrestricted within the resolved execution profile and tool ceiling.",
			});
	}
}

/**
 * Resolve the orchestration-owned harness for a spawn.
 *
 * Selection rules (restrictive; never widens a supplied profile):
 * - `tier: light` → simple (read/find/search + control tools; no skill catalog; report-only decisions)
 * - `tier: mid` or frontier+mechanical+bound → standard
 * - otherwise → full
 * - Known light agent types (`explore`) supply a simple seed via
 *   {@link defaultAgentTypeHarnessPolicy}; `quick_task` seeds mid/bound
 *   (standard harness with replace edits). Callers merge the seed into profile input.
 */
export function resolveAgentHarness(input: AgentHarnessInput = {}): AgentHarness {
	const profile = input.execution ?? resolveAgentExecutionProfile(input.profileInput ?? {});
	const kind = selectHarnessKind(profile.tier, profile.workClass, profile.autonomy);
	const toolProfile = resolveToolProfile({
		execution: profile,
		agentTools: input.agentTools,
		workflowTools: input.workflowTools,
		declaredCapabilities: input.declaredCapabilities,
		requireYield: input.requireYield ?? true,
	});
	const skillPolicy = selectSkillPolicy(kind, input.autoloadSkills);
	const decisionSurface = selectDecisionSurface(kind, profile, toolProfile);
	const collaborationPolicy = resolveCollaborationPolicy({
		mode: profile.collaboration,
		parentId: input.parentId,
	});

	return Object.freeze({
		kind,
		profile,
		toolProfile,
		skillPolicy,
		decisionSurface,
		collaborationPolicy,
	});
}

/**
 * Filter the parent skill catalog down to the harness ceiling.
 * Autoload names are always eligible when present in `skills` and allowed.
 */
export function filterSkillsForHarness(
	harness: AgentHarness,
	skills: readonly Skill[],
	autoloadNames?: readonly string[],
): Skill[] {
	const policy = harness.skillPolicy;
	if (policy.mode === "none") {
		return [];
	}

	const autoloadSet = new Set((autoloadNames ?? []).map(name => name.trim()).filter(Boolean));
	const allowSet = new Set(policy.allowNames);

	let filtered: Skill[];
	if (policy.mode === "all") {
		filtered = [...skills];
	} else {
		filtered = skills.filter(skill => allowSet.has(skill.name) || autoloadSet.has(skill.name));
	}

	if (policy.maxSkills > 0 && filtered.length > policy.maxSkills) {
		// Prefer autoload hits in declared order, then stable name order for the rest.
		const byName = new Map(filtered.map(skill => [skill.name, skill]));
		const preferred: Skill[] = [];
		for (const name of autoloadSet) {
			const hit = byName.get(name);
			if (hit) {
				preferred.push(hit);
				byName.delete(name);
			}
		}
		const rest = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
		filtered = [...preferred, ...rest].slice(0, policy.maxSkills);
	}

	return filtered;
}
