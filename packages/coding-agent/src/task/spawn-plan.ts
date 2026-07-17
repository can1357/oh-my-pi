/**
 * Allocation-free spawn-plan contracts.
 *
 * `createSpawnPlan` resolves an immutable execution profile and ordered eligible
 * route candidates without allocating agent ids, jobs, worktrees, or sessions.
 * Lane E adapts {@link SpawnPlan} to hooks and performs real allocation only
 * after a successful plan.
 */

import {
	type AgentAutonomy,
	type AgentExecutionProfile,
	type AgentExecutionProfileInput,
	type AgentTier,
	JudgmentTierViolationError,
	minBudget,
	resolveAgentExecutionProfile,
	type WorkClass,
} from "../orchestration/agent-execution-profile";

export type SpawnRouteLabel = "light" | "mid" | "heavy";

export interface SpawnRouteCandidate {
	selector: string;
	tier: AgentTier;
	provider?: string;
	modelId?: string;
	maxRequests: number;
	maxRuntimeMs: number;
}

/**
 * Pre-allocation policy input. `correlationId` is caller-generated and must not
 * come from AgentOutputManager or registry allocation.
 */
export interface TaskSpawnPolicyInput {
	correlationId: string;
	agentName: string;
	assignment: string;
	workClass: WorkClass;
	autonomy: AgentAutonomy;
	eligible: readonly SpawnRouteCandidate[];
	requestedModel?: string;
	fusionSidekick: boolean;
	manualModelSelection: boolean;
}

export interface TaskSpawnPolicyResult {
	allow: boolean;
	reasonCode?: string;
	candidateSelectors?: readonly string[];
	maxRequests?: number;
	maxRuntimeMs?: number;
	routeLabel?: SpawnRouteLabel;
}

export interface TaskSpawnPolicyHook {
	beforeSpawn(input: Readonly<TaskSpawnPolicyInput>, signal?: AbortSignal): Promise<TaskSpawnPolicyResult>;
}

export interface SpawnPlanDiagnostic {
	code: string;
	message: string;
	selector?: string;
}

export interface SpawnPlanInput {
	/** Caller-provided correlation id — never allocated here. */
	correlationId: string;
	agentName: string;
	assignment: string;
	description?: string;
	/** Layered profile inputs; ignored when `profile` is provided. */
	profileInput?: AgentExecutionProfileInput;
	/** Already-resolved profile snapshot. */
	profile?: AgentExecutionProfile;
	/** Ordered eligible candidates from registry/settings snapshot. */
	eligible?: readonly SpawnRouteCandidate[];
	/** Selector intent when candidates are not precomputed. */
	modelPatterns?: readonly string[];
	requestedModel?: string;
	manualModelSelection?: boolean;
	fusionSidekick?: boolean;
	softRequestBudget?: number;
	maxRuntimeMs?: number;
	/**
	 * Injectable provider/auth availability predicate. Do not import the task
	 * executor or AgentRegistry from this module.
	 */
	isSelectorAvailable?: (selector: string) => boolean;
	/**
	 * Test/observability hooks. Successful and failed planning alike must never
	 * invoke these — they exist so callers can prove allocation-free behavior.
	 */
	onAllocateId?: () => void;
	onAllocateJob?: () => void;
	onAllocateWorktree?: () => void;
	onAllocateSession?: () => void;
}

export interface SpawnPlan {
	readonly correlationId: string;
	readonly agentName: string;
	readonly assignment: string;
	readonly description?: string;
	readonly profile: AgentExecutionProfile;
	readonly eligible: readonly SpawnRouteCandidate[];
	readonly maxRequests: number;
	readonly maxRuntimeMs: number;
	readonly fusionSidekick: boolean;
	readonly manualModelSelection: boolean;
	readonly requestedModel?: string;
}

export type SpawnPlanResult = { ok: true; plan: SpawnPlan } | { ok: false; diagnostics: SpawnPlanDiagnostic[] };

const TIER_TO_ROUTE: Record<AgentTier, SpawnRouteLabel> = {
	light: "light",
	mid: "mid",
	frontier: "heavy",
};

export function tierToRouteLabel(tier: AgentTier): SpawnRouteLabel {
	return TIER_TO_ROUTE[tier];
}

function freezeCandidate(candidate: SpawnRouteCandidate): SpawnRouteCandidate {
	return Object.freeze({ ...candidate });
}

function candidatesFromPatterns(
	patterns: readonly string[] | undefined,
	profile: AgentExecutionProfile,
	maxRequests: number,
	maxRuntimeMs: number,
): SpawnRouteCandidate[] {
	if (!patterns || patterns.length === 0) return [];
	return patterns.map(selector =>
		freezeCandidate({
			selector,
			tier: profile.tier,
			maxRequests,
			maxRuntimeMs,
		}),
	);
}

function narrowCandidates(
	candidates: readonly SpawnRouteCandidate[],
	profile: AgentExecutionProfile,
	maxRequests: number,
	maxRuntimeMs: number,
	isSelectorAvailable?: (selector: string) => boolean,
): { eligible: SpawnRouteCandidate[]; diagnostics: SpawnPlanDiagnostic[] } {
	const diagnostics: SpawnPlanDiagnostic[] = [];
	const pool = profile.modelPool;
	const poolSet = pool.length > 0 ? new Set(pool) : undefined;
	const eligible: SpawnRouteCandidate[] = [];

	for (const candidate of candidates) {
		const selector = candidate.selector.trim();
		if (!selector) {
			diagnostics.push({
				code: "empty-selector",
				message: "Spawn candidate selector must be non-empty.",
				selector: candidate.selector,
			});
			continue;
		}
		if (poolSet && !poolSet.has(selector)) {
			diagnostics.push({
				code: "selector-not-in-pool",
				message: `Selector "${selector}" is outside the resolved model pool.`,
				selector,
			});
			continue;
		}
		if (isSelectorAvailable && !isSelectorAvailable(selector)) {
			diagnostics.push({
				code: "selector-unavailable",
				message: `Selector "${selector}" is unavailable or unauthenticated.`,
				selector,
			});
			continue;
		}
		eligible.push(
			freezeCandidate({
				...candidate,
				selector,
				maxRequests: minBudget(candidate.maxRequests, maxRequests),
				maxRuntimeMs: minBudget(candidate.maxRuntimeMs, maxRuntimeMs),
			}),
		);
	}

	return { eligible, diagnostics };
}

/**
 * Compose a hook result onto an existing plan. Denial is sticky; candidate
 * selectors intersect current eligibility; budgets take the minimum; unknown
 * selectors reject the composition.
 */
export function composeTaskSpawnPolicyResult(plan: SpawnPlan, result: TaskSpawnPolicyResult): SpawnPlanResult {
	if (!result.allow) {
		return {
			ok: false,
			diagnostics: [
				{
					code: result.reasonCode ?? "spawn-denied",
					message: result.reasonCode ?? "Spawn policy denied this spawn.",
				},
			],
		};
	}

	const diagnostics: SpawnPlanDiagnostic[] = [];
	let eligible = [...plan.eligible];

	if (result.candidateSelectors) {
		const allowed = new Set(result.candidateSelectors);
		const known = new Set(plan.eligible.map(candidate => candidate.selector));
		for (const selector of result.candidateSelectors) {
			if (!known.has(selector)) {
				diagnostics.push({
					code: "unknown-selector",
					message: `Policy returned unknown selector "${selector}".`,
					selector,
				});
			}
		}
		if (diagnostics.some(diagnostic => diagnostic.code === "unknown-selector")) {
			return { ok: false, diagnostics };
		}
		eligible = eligible.filter(candidate => allowed.has(candidate.selector));
	}

	const maxRequests =
		result.maxRequests === undefined ? plan.maxRequests : minBudget(plan.maxRequests, result.maxRequests);
	const maxRuntimeMs =
		result.maxRuntimeMs === undefined ? plan.maxRuntimeMs : minBudget(plan.maxRuntimeMs, result.maxRuntimeMs);

	if (eligible.length === 0) {
		diagnostics.push({
			code: "no-eligible-candidates",
			message: "Spawn policy intersection removed every eligible candidate.",
		});
		return { ok: false, diagnostics };
	}

	const next = Object.freeze({
		...plan,
		eligible: Object.freeze(
			eligible.map(candidate =>
				freezeCandidate({
					...candidate,
					maxRequests: minBudget(candidate.maxRequests, maxRequests),
					maxRuntimeMs: minBudget(candidate.maxRuntimeMs, maxRuntimeMs),
				}),
			),
		),
		maxRequests,
		maxRuntimeMs,
	}) satisfies SpawnPlan;

	return { ok: true, plan: next };
}

/**
 * Build a pure spawn plan. Never allocates ids/jobs/worktrees/sessions and never
 * mutates settings or global model roles.
 */
export function createSpawnPlan(input: SpawnPlanInput): SpawnPlanResult {
	const diagnostics: SpawnPlanDiagnostic[] = [];

	if (!input.correlationId.trim()) {
		diagnostics.push({
			code: "missing-correlation-id",
			message: "correlationId is required and must be generated without allocation callbacks.",
		});
	}
	if (!input.agentName.trim()) {
		diagnostics.push({
			code: "missing-agent-name",
			message: "agentName is required.",
		});
	}
	if (!input.assignment.trim()) {
		diagnostics.push({
			code: "missing-assignment",
			message: "assignment is required.",
		});
	}

	let profile: AgentExecutionProfile;
	try {
		// Always re-validate/freeze, including caller-supplied snapshots, so the
		// judgment floor and immutability invariants cannot be bypassed.
		profile = resolveAgentExecutionProfile(
			input.profile
				? {
						override: {
							tier: input.profile.tier,
							autonomy: input.profile.autonomy,
							collaboration: input.profile.collaboration,
							workClass: input.profile.workClass,
							editMode: input.profile.editMode,
							maxRequests: input.profile.maxRequests,
							maxRuntimeMs: input.profile.maxRuntimeMs,
							...(input.profile.modelPoolConstrained || input.profile.modelPool.length > 0
								? { modelPool: input.profile.modelPool }
								: {}),
						},
						judgmentFloor: input.profileInput?.judgmentFloor ?? "raise",
					}
				: (input.profileInput ?? {}),
		);
	} catch (error) {
		const message =
			error instanceof JudgmentTierViolationError
				? error.message
				: error instanceof Error
					? error.message
					: "Invalid execution profile.";
		diagnostics.push({
			code: error instanceof JudgmentTierViolationError ? error.code : "invalid-profile",
			message,
		});
		return { ok: false, diagnostics };
	}

	const maxRequests = minBudget(profile.maxRequests, input.softRequestBudget ?? 0);
	const maxRuntimeMs = minBudget(profile.maxRuntimeMs, input.maxRuntimeMs ?? 0);

	const seedSelectors = (() => {
		if (profile.modelPoolConstrained) {
			return profile.modelPool;
		}
		if (profile.modelPool.length > 0) {
			return profile.modelPool;
		}
		return input.modelPatterns;
	})();

	const seedCandidates =
		input.eligible && input.eligible.length > 0
			? input.eligible
			: candidatesFromPatterns(seedSelectors, profile, maxRequests, maxRuntimeMs);

	const narrowed = narrowCandidates(seedCandidates, profile, maxRequests, maxRuntimeMs, input.isSelectorAvailable);
	diagnostics.push(...narrowed.diagnostics);

	if (
		diagnostics.some(
			diagnostic =>
				diagnostic.code === "missing-correlation-id" ||
				diagnostic.code === "missing-agent-name" ||
				diagnostic.code === "missing-assignment",
		)
	) {
		return { ok: false, diagnostics };
	}

	if (narrowed.eligible.length === 0) {
		const unconstrained =
			input.eligible === undefined && seedSelectors === undefined && !profile.modelPoolConstrained;
		if (!unconstrained) {
			diagnostics.push({
				code: "no-eligible-candidates",
				message: "No eligible spawn candidates remained after validation.",
			});
			return { ok: false, diagnostics };
		}
	}

	// Allocation callbacks are intentionally never invoked — including on success.
	void input.onAllocateId;
	void input.onAllocateJob;
	void input.onAllocateWorktree;
	void input.onAllocateSession;

	const plan: SpawnPlan = Object.freeze({
		correlationId: input.correlationId,
		agentName: input.agentName,
		assignment: input.assignment,
		description: input.description,
		profile,
		eligible: Object.freeze(narrowed.eligible),
		maxRequests,
		maxRuntimeMs,
		fusionSidekick: input.fusionSidekick ?? false,
		manualModelSelection: input.manualModelSelection ?? false,
		requestedModel: input.requestedModel,
	});

	return { ok: true, plan };
}
