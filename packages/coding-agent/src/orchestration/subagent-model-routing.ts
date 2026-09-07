/**
 * Centralized, deterministic subagent model-routing contract.
 *
 * A subtask's requested `difficulty` (`low` | `medium` | `high`) is an
 * independent axis from {@link AgentTier} (a restrictive
 * capability/tool/model-pool envelope, see `orchestration/agent-execution-profile.ts`).
 * Difficulty never widens or substitutes for a restrictive tier; it only
 * expresses a *model-selection preference* that is resolved through the same
 * named `agent.profile` / `agent.profiles` model-role bundles every other
 * role-based selector already uses.
 *
 * Precedence (highest to lowest):
 *   1. explicit requested model            → source "explicit"
 *   2. requested difficulty                → source "difficulty-profile"
 *   3. `task.agentModelOverrides[agent]`    → source "agent-override"
 *   4. agent definition's `model` field     → source "agent-definition"
 *   5. parent's active model                → source "parent-active"
 *   6. session default model                → source "session-default"
 *
 * An explicit model and a requested difficulty may coexist: the explicit
 * model wins, and the decision still records the requested difficulty for
 * provenance. An unresolved explicit selector or an unavailable difficulty
 * role fails clearly (a typed {@link SubagentModelRoutingError}) before
 * allocation — routing NEVER silently falls back to a lower difficulty.
 *
 * This module is deliberately caller-agnostic: it accepts primitives (a
 * requested model/difficulty, agent name/default patterns, settings, a model
 * registry, and the parent/session fallback selectors) and returns a
 * provenance-bearing decision plus the resolved model-pattern priority list.
 * It does not read `TaskItem`/`TaskParams` or spawn anything itself.
 */

import {
	canonicalizeRoleSelector,
	isSessionInheritedAgentPattern,
	type ModelLookupRegistry,
	resolveAgentModelPatterns,
	resolveConfiguredModelPatterns,
	resolveKnownModelRole,
	resolveModelOverride,
} from "../config/model-resolver";
import type { Settings } from "../config/settings";
import {
	mergeSubagentModelAliases,
	resolveSubagentModelAlias,
	type SubagentAliasRegistry,
} from "../config/subagent-model-aliases";
import { isTokenSavingsFusionActive } from "../session/fusion-router";

/** Independent difficulty vocabulary for a fresh subagent spawn. Never aliased to {@link AgentTier}. */
export type SubagentTaskDifficulty = "low" | "medium" | "high";

/** Model role a difficulty maps to. A strict subset of the full `ModelRole` union. */
export type SubagentDifficultyModelRole = "smol" | "task" | "slow";

/** Fixed, non-configurable difficulty → model-role mapping. */
export const SUBAGENT_DIFFICULTY_ROLE: Readonly<Record<SubagentTaskDifficulty, SubagentDifficultyModelRole>> =
	Object.freeze({
		low: "smol",
		medium: "task",
		high: "slow",
	});

/** Where a routing decision's model selection ultimately came from. */
export type SubagentModelSelectionSource =
	| "explicit"
	| "difficulty-profile"
	| "agent-override"
	| "agent-definition"
	| "parent-active"
	| "session-default"
	| "fusion-token-savings";

/**
 * Machine-readable provenance for a resolved (or attempted) subagent model
 * route. Frozen; callers MUST NOT mutate a decision belonging to a running
 * route. Never carries assignment text, credentials, or secrets.
 */
export interface SubagentModelRoutingDecision {
	readonly requestedDifficulty?: SubagentTaskDifficulty;
	readonly source: SubagentModelSelectionSource;
	readonly profileName?: string;
	readonly role?: SubagentDifficultyModelRole;
	readonly requestedModel?: string | readonly string[];
	readonly candidateSelectors: readonly string[];
}

/** Why a route could not be resolved. */
export type SubagentModelRoutingErrorKind = "explicit-model-unresolved" | "difficulty-role-unavailable";

/** Typed diagnostic returned before allocation when a route cannot be resolved. Never a thrown exception. */
export interface SubagentModelRoutingError {
	readonly kind: SubagentModelRoutingErrorKind;
	readonly message: string;
	readonly requestedDifficulty?: SubagentTaskDifficulty;
	readonly requestedModel?: string | readonly string[];
	readonly candidateSelectors: readonly string[];
}

/** Minimum registry surface the resolver needs: catalog availability plus alias/role matching. */
export type SubagentModelRoutingRegistry = ModelLookupRegistry & SubagentAliasRegistry;

/** Inputs to {@link resolveSubagentModelRouting}. No assignment text belongs here. */
export interface SubagentModelRoutingRequest {
	/** Explicit per-spawn model selector(s); wins over everything else when resolvable. */
	readonly requestedModel?: string | readonly string[];
	/** Requested subtask difficulty; independent from `AgentTier`. */
	readonly requestedDifficulty?: SubagentTaskDifficulty;
	/** Explicit semantic workload; never inferred from assignment prose or a specialist's display name. */
	readonly taskKind?: "evidence-digest";
	/** Agent type name, used to look up `task.agentModelOverrides[agentName]`. */
	readonly agentName?: string;
	/** Agent definition's own `model` field (frontmatter default). */
	readonly agentModelDefault?: string | readonly string[];
	readonly settings: Settings;
	/** Catalog/alias registry. Omit for legacy sessions that predate model-aware spawning: no-model/no-difficulty routes still resolve; an explicit model or a requested difficulty fails with its typed diagnostic instead of guessing. */
	readonly modelRegistry?: SubagentModelRoutingRegistry;
	/** The parent session's currently active model selector, if any. */
	readonly parentActiveModelPattern?: string;
	/** Session default model selector, the final fallback. */
	readonly sessionDefaultModelPattern?: string;
}

export type SubagentModelRoutingResult =
	| { readonly ok: true; readonly decision: SubagentModelRoutingDecision; readonly modelPatterns: readonly string[] }
	| { readonly ok: false; readonly error: SubagentModelRoutingError };

function freezeList(values: readonly string[]): readonly string[] {
	return Object.freeze([...values]);
}

function normalizeRequestedTokens(requestedModel: string | readonly string[] | undefined): string[] {
	if (!requestedModel) return [];
	const list = Array.isArray(requestedModel) ? requestedModel : [requestedModel as string];
	return list
		.flatMap(value => value.split(","))
		.map(value => value.trim())
		.filter(Boolean);
}

/** The active `agent.profile` name, but ONLY when it actually supplies `role` — i.e. explicit `modelRoles.<role>` does not already win, and the profile itself configures that role. Pure provenance; never changes which concrete model is picked. */
function profileNameForRole(settings: Settings, role: SubagentDifficultyModelRole): string | undefined {
	if (settings.get("modelRoles")[role]) return undefined;
	const profileName = settings.get("agent.profile");
	if (!profileName) return undefined;
	const profile = settings.get("agent.profiles")[profileName];
	return profile?.[role] ? profileName : undefined;
}
/** Resolve one explicit token through the known-role chain, else the subagent alias/catalog chain. Mirrors the native task spawn's explicit-model resolution. */
function resolveExplicitToken(
	raw: string,
	settings: Settings,
	modelRegistry: SubagentModelRoutingRegistry,
): { selector: string; role?: SubagentDifficultyModelRole } | undefined {
	const canonical = canonicalizeRoleSelector(raw);
	const knownRole = resolveKnownModelRole(canonical);
	if (knownRole) {
		const roleResolution = resolveModelOverride([canonical], modelRegistry, settings);
		if (!roleResolution.model) return undefined;
		const difficultyRole = isDifficultyModelRole(knownRole) ? knownRole : undefined;
		return { selector: canonical, role: difficultyRole };
	}
	const aliases = mergeSubagentModelAliases(settings.get("subagent.modelAliases"));
	const resolved = resolveSubagentModelAlias(raw, aliases, modelRegistry);
	return resolved ? { selector: resolved } : undefined;
}

function isDifficultyModelRole(role: string): role is SubagentDifficultyModelRole {
	return role === "smol" || role === "task" || role === "slow";
}

function resolveExplicitRoute(
	requestedModel: string | readonly string[] | undefined,
	tokens: readonly string[],
	requestedDifficulty: SubagentTaskDifficulty | undefined,
	settings: Settings,
	modelRegistry: SubagentModelRoutingRegistry | undefined,
): SubagentModelRoutingResult {
	const frozenRequestedModel = Array.isArray(requestedModel) ? freezeList(requestedModel) : requestedModel;
	if (!modelRegistry) {
		return {
			ok: false,
			error: {
				kind: "explicit-model-unresolved",
				message: `Model "${tokens.join(", ")}" cannot be resolved for subagent spawn: no model registry is available.`,
				requestedDifficulty,
				requestedModel: frozenRequestedModel,
				candidateSelectors: freezeList(tokens),
			},
		};
	}
	const resolvedSelectors: string[] = [];
	let role: SubagentDifficultyModelRole | undefined;
	for (const token of tokens) {
		const resolved = resolveExplicitToken(token, settings, modelRegistry);
		if (resolved) {
			resolvedSelectors.push(resolved.selector);
			if (role === undefined) role = resolved.role;
		}
	}

	if (resolvedSelectors.length === 0) {
		return {
			ok: false,
			error: {
				kind: "explicit-model-unresolved",
				message: `Model "${tokens.join(", ")}" not found for subagent spawn. Configure subagent.modelAliases or use a concrete catalog selector.`,
				requestedDifficulty,
				requestedModel: frozenRequestedModel,
				candidateSelectors: freezeList(tokens),
			},
		};
	}

	return {
		ok: true,
		decision: Object.freeze({
			requestedDifficulty,
			source: "explicit",
			profileName: role ? profileNameForRole(settings, role) : undefined,
			role,
			requestedModel: frozenRequestedModel,
			candidateSelectors: freezeList(resolvedSelectors),
		}),
		modelPatterns: freezeList(resolvedSelectors),
	};
}

function resolveDifficultyRoute(
	requestedDifficulty: SubagentTaskDifficulty,
	settings: Settings,
	modelRegistry: SubagentModelRoutingRegistry | undefined,
): SubagentModelRoutingResult {
	const role = SUBAGENT_DIFFICULTY_ROLE[requestedDifficulty];
	const roleSelector = `pi/${role}`;
	const expandedPatterns = resolveConfiguredModelPatterns(roleSelector, settings);
	const candidateSelectors = expandedPatterns.length > 0 ? expandedPatterns : [roleSelector];

	if (!modelRegistry) {
		return {
			ok: false,
			error: {
				kind: "difficulty-role-unavailable",
				message: `No model registry is available to resolve difficulty "${requestedDifficulty}" (role "${roleSelector}"). Routing never falls back to a lower difficulty.`,
				requestedDifficulty,
				candidateSelectors: freezeList(candidateSelectors),
			},
		};
	}

	const roleResolution = resolveModelOverride([roleSelector], modelRegistry, settings);
	const profileName = profileNameForRole(settings, role);

	if (!roleResolution.model) {
		return {
			ok: false,
			error: {
				kind: "difficulty-role-unavailable",
				message: `No available model for difficulty "${requestedDifficulty}" (role "${roleSelector}"). Configure modelRoles.${role} or an active agent.profile before requesting this difficulty; routing never falls back to a lower difficulty.`,
				requestedDifficulty,
				candidateSelectors: freezeList(candidateSelectors),
			},
		};
	}

	return {
		ok: true,
		decision: Object.freeze({
			requestedDifficulty,
			source: "difficulty-profile",
			profileName,
			role,
			candidateSelectors: freezeList(candidateSelectors),
		}),
		modelPatterns: freezeList([roleSelector]),
	};
}

/** Widen the agent definition's readonly `model` field to the mutable `string | string[]` shape the resolver primitives expect. */
function normalizeAgentModelDefault(
	agentModelDefault: string | readonly string[] | undefined,
): string | string[] | undefined {
	if (agentModelDefault === undefined) return undefined;
	return Array.isArray(agentModelDefault) ? (agentModelDefault as string[]).slice() : (agentModelDefault as string);
}

function resolveFallbackRoute(request: SubagentModelRoutingRequest): SubagentModelRoutingResult {
	const { agentName, agentModelDefault, settings, parentActiveModelPattern, sessionDefaultModelPattern } = request;
	const agentModelPattern = normalizeAgentModelDefault(agentModelDefault);
	const settingsOverride = agentName ? settings.get("task.agentModelOverrides")[agentName] : undefined;
	const overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);
	const agentPatterns = resolveConfiguredModelPatterns(agentModelPattern, settings);
	const finalPatterns = resolveAgentModelPatterns({
		settingsOverride,
		agentModel: agentModelPattern,
		settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: sessionDefaultModelPattern,
	});

	let source: SubagentModelSelectionSource;
	if (
		overridePatterns.length > 0 &&
		overridePatterns.length === finalPatterns.length &&
		overridePatterns.every((value, index) => value === finalPatterns[index])
	) {
		source = "agent-override";
	} else if (
		agentPatterns.length > 0 &&
		agentPatterns.length === finalPatterns.length &&
		agentPatterns.every((value, index) => value === finalPatterns[index])
	) {
		source = "agent-definition";
	} else if (parentActiveModelPattern?.trim()) {
		source = "parent-active";
	} else {
		source = "session-default";
	}

	return {
		ok: true,
		decision: Object.freeze({
			source,
			candidateSelectors: freezeList(finalPatterns),
		}),
		modelPatterns: freezeList(finalPatterns),
	};
}

/** Whether the agent name indicates a browser worker. */
export function isBrowserAgent(agentName: string | undefined): boolean {
	if (!agentName) return false;
	const lower = agentName.toLowerCase();
	return lower.includes("browser");
}

/** Whether the agent name indicates a planning or high-intelligence specialist. */
export function isPlanningOrIntelligenceAgent(agentName: string | undefined): boolean {
	if (!agentName) return false;
	const lower = agentName.toLowerCase();
	return (
		lower === "plan" ||
		lower === "oracle" ||
		lower === "tot-reasoner" ||
		lower === "synthesize" ||
		lower === "falsify" ||
		lower === "reviewer" ||
		lower === "audit"
	);
}

/** Whether the agent is a low-key context-gathering or tool-less worker. */
export function isLowKeyOrContextAgent(agentName: string | undefined): boolean {
	if (!agentName) return false;
	const lower = agentName.toLowerCase();
	return lower === "explore" || lower === "mr-worker" || lower === "quick_task";
}

/** Whether a model pattern or role represents a thinking / max-intelligence model. */
export function isThinkingOrMaxIntelligencePattern(pattern: string | undefined, settings?: Settings): boolean {
	if (!pattern) return false;
	const lower = pattern.toLowerCase();
	if (
		lower === "pi/slow" ||
		lower === "slow" ||
		lower === "pi/max-intelligence" ||
		lower === "max-intelligence" ||
		lower === "pi/plan" ||
		lower === "plan" ||
		lower === "pi/advisor" ||
		lower === "advisor"
	) {
		return true;
	}
	if (settings) {
		const slow = settings.getModelRole("slow")?.toLowerCase();
		const maxInt = settings.getModelRole("max-intelligence")?.toLowerCase();
		const plan = settings.getModelRole("plan")?.toLowerCase();
		if (slow && (lower === slow || lower.includes(slow))) return true;
		if (maxInt && (lower === maxInt || lower.includes(maxInt))) return true;
		if (plan && (lower === plan || lower.includes(plan))) return true;
	}
	return false;
}

/**
 * In explicit Token Savings Mode:
 * - The default model is restricted to two calls and simple tasks (never used for subagents).
 * - Planning and intelligence route to thinking (pi/slow) and max-intelligence (pi/max-intelligence).
 * - Tasks/work delegated by those models (or general delegated tasks) go to the task model (pi/task).
 * - Browser work goes to browser models (pi/browser-control / pi/browser-operation).
 * - Low-key context gathering or tool-less work goes to the SMOL fast model (pi/smol).
 * - Explicit bulk evidence-digest assignments use the task role, not the low-key lookup route.
 */
function resolveTokenSavingsFallbackRoute(request: SubagentModelRoutingRequest): SubagentModelRoutingResult {
	const { agentName, agentModelDefault, settings, parentActiveModelPattern } = request;
	const settingsOverride = agentName ? settings.get("task.agentModelOverrides")[agentName] : undefined;
	const overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);
	if (overridePatterns.length > 0) {
		return {
			ok: true,
			decision: Object.freeze({
				source: "agent-override",
				candidateSelectors: freezeList(overridePatterns),
			}),
			modelPatterns: freezeList(overridePatterns),
		};
	}

	let targetSelectors: string[];
	if (request.taskKind === "evidence-digest") {
		// Bulk evidence synthesis is task work even when a context-gathering agent performs it.
		targetSelectors = ["pi/task"];
	} else if (isBrowserAgent(agentName)) {
		// Browser work goes to browser models
		targetSelectors = ["pi/browser-control", "pi/browser-operation"];
	} else if (isPlanningOrIntelligenceAgent(agentName)) {
		// Any actual planning or intelligence comes from thinking and max-intelligence models
		targetSelectors = ["pi/slow", "pi/max-intelligence", "pi/plan"];
	} else if (isLowKeyOrContextAgent(agentName)) {
		// Anything super low-key, like context gathering or tool-less, uses SMOL fast model
		targetSelectors = ["pi/smol"];
	} else if (isThinkingOrMaxIntelligencePattern(parentActiveModelPattern, settings)) {
		// Tasks/work delegated by thinking/max-intelligence models goes to task model
		targetSelectors = ["pi/task"];
	} else {
		const agentModelPattern = normalizeAgentModelDefault(agentModelDefault);
		const agentPatterns = resolveConfiguredModelPatterns(agentModelPattern, settings);
		const single = Array.isArray(agentModelPattern) ? agentModelPattern[0] : agentModelPattern;
		if (agentPatterns.length > 0 && single && !isSessionInheritedAgentPattern(single)) {
			return {
				ok: true,
				decision: Object.freeze({
					source: "agent-definition",
					candidateSelectors: freezeList(agentPatterns),
				}),
				modelPatterns: freezeList(agentPatterns),
			};
		}
		// General delegated work goes to the task model
		targetSelectors = ["pi/task"];
	}

	const resolved = targetSelectors.flatMap(sel => resolveConfiguredModelPatterns(sel, settings));
	const candidateSelectors = resolved.length > 0 ? resolved : targetSelectors;

	return {
		ok: true,
		decision: Object.freeze({
			source: "fusion-token-savings",
			...(request.taskKind === "evidence-digest" ? { role: "task" as const } : {}),
			candidateSelectors: freezeList(candidateSelectors),
		}),
		modelPatterns: freezeList(targetSelectors),
	};
}

/**
 * Resolve one subagent spawn's model route. Pure and synchronous; performs no
 * allocation. `requestedModel` wins over `requestedDifficulty`, which wins
 * over the per-agent override / agent definition / parent-active /
 * session-default fallback chain. An unresolved explicit selector or an
 * unavailable difficulty role returns `{ ok: false }` with a typed
 * diagnostic instead of allocating with a degraded route.
 */
export function resolveSubagentModelRouting(request: SubagentModelRoutingRequest): SubagentModelRoutingResult {
	const { requestedModel, requestedDifficulty, settings, modelRegistry } = request;

	const requestedTokens = normalizeRequestedTokens(requestedModel);

	if (requestedTokens.length > 0) {
		return resolveExplicitRoute(requestedModel, requestedTokens, requestedDifficulty, settings, modelRegistry);
	}

	if (requestedDifficulty) {
		return resolveDifficultyRoute(requestedDifficulty, settings, modelRegistry);
	}

	if (isTokenSavingsFusionActive(settings)) {
		return resolveTokenSavingsFallbackRoute(request);
	}

	return resolveFallbackRoute(request);
}
