/**
 * Immutable agent execution-profile contracts.
 *
 * Tier, autonomy, collaboration, and work class are independent axes. Restrictive
 * inputs compose by intersection/minimum and never widen. Legacy/no-policy inputs
 * resolve to today's unrestricted behavior.
 */

export type AgentTier = "light" | "mid" | "frontier";
export type AgentAutonomy = "bound" | "supervised" | "independent";
export type CollaborationMode = "report-only" | "message-peers" | "self-coordinate";
export type WorkClass = "mechanical" | "judgment";
export type AgentEditMode = "none" | "replace" | "hashline" | "apply-patch";

/** How to enforce the judgment work-class mid-tier floor. */
export type JudgmentFloorPolicy = "raise" | "reject";

/**
 * Partial policy fields accepted from settings, agent-type maps, workflows, or
 * call-site overrides. Absent fields mean "no additional restriction".
 */
export interface AgentPolicyFields {
	tier?: AgentTier;
	autonomy?: AgentAutonomy;
	collaboration?: CollaborationMode;
	workClass?: WorkClass;
	editMode?: AgentEditMode;
	/** Soft request budget; `0` means unlimited. */
	maxRequests?: number;
	/** Hard wall-clock budget in ms; `0` means unlimited. */
	maxRuntimeMs?: number;
	/** Ordered eligible model selectors for this policy layer. */
	modelPool?: readonly string[];
}

/**
 * Settings/agent/workflow inputs for profile resolution.
 *
 * Precedence of named layers is agent-id → agent-type → workflow/default, then
 * call-site override. Every supplied layer may only narrow the result.
 */
export interface AgentExecutionProfileInput {
	agentIdPolicy?: AgentPolicyFields;
	agentTypePolicy?: AgentPolicyFields;
	workflowPolicy?: AgentPolicyFields;
	override?: AgentPolicyFields;
	/** Defaults to `"raise"` — judgment + light becomes mid. `"reject"` throws. */
	judgmentFloor?: JudgmentFloorPolicy;
}

/**
 * Immutable resolved execution envelope consumed by spawn planning and
 * downstream tool/collaboration policy.
 */
export interface AgentExecutionProfile {
	readonly tier: AgentTier;
	readonly autonomy: AgentAutonomy;
	readonly collaboration: CollaborationMode;
	readonly workClass: WorkClass;
	readonly editMode: AgentEditMode;
	readonly maxRequests: number;
	readonly maxRuntimeMs: number;
	readonly modelPool: readonly string[];
	/**
	 * True when a policy layer supplied `modelPool` (including an explicit empty
	 * list). False means unrestricted legacy behavior — callers may use their
	 * own modelPatterns/eligible snapshots.
	 */
	readonly modelPoolConstrained: boolean;
}

const TIER_RANK: Record<AgentTier, number> = {
	light: 0,
	mid: 1,
	frontier: 2,
};

const AUTONOMY_RANK: Record<AgentAutonomy, number> = {
	bound: 0,
	supervised: 1,
	independent: 2,
};

const COLLABORATION_RANK: Record<CollaborationMode, number> = {
	"report-only": 0,
	"message-peers": 1,
	"self-coordinate": 2,
};

const EDIT_MODE_RANK: Record<AgentEditMode, number> = {
	none: 0,
	replace: 1,
	hashline: 2,
	"apply-patch": 3,
};

/** Unrestricted legacy defaults — preserve current independent-swarm behavior. */
export const DEFAULT_AGENT_EXECUTION_PROFILE: AgentExecutionProfile = Object.freeze({
	tier: "frontier",
	autonomy: "independent",
	collaboration: "self-coordinate",
	workClass: "mechanical",
	editMode: "hashline",
	maxRequests: 0,
	maxRuntimeMs: 0,
	modelPool: Object.freeze([] as string[]),
	modelPoolConstrained: false,
});

export class JudgmentTierViolationError extends Error {
	readonly code = "judgment-tier-floor";

	constructor(message = 'workClass "judgment" requires minimum tier "mid"') {
		super(message);
		this.name = "JudgmentTierViolationError";
	}
}

function minByRank<T extends string>(left: T, right: T, rank: Record<T, number>): T {
	return rank[left] <= rank[right] ? left : right;
}

/** Budgets compose by minimum; `0` means unlimited and loses to any positive cap. */
export function minBudget(left: number, right: number): number {
	if (!Number.isFinite(left) || left < 0) {
		throw new Error(`Invalid budget value: ${left}`);
	}
	if (!Number.isFinite(right) || right < 0) {
		throw new Error(`Invalid budget value: ${right}`);
	}
	if (left <= 0) return right;
	if (right <= 0) return left;
	return Math.min(left, right);
}

function assertValidBudget(value: number | undefined, field: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid ${field}: ${String(value)}`);
	}
}

/**
 * `undefined` means unrestricted. An explicit empty array is restrictive and
 * intersects to no selectors.
 */
function intersectModelPools(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): readonly string[] | undefined {
	if (left === undefined) {
		return right === undefined ? undefined : Object.freeze([...right]);
	}
	if (right === undefined) {
		return Object.freeze([...left]);
	}
	const rightSet = new Set(right);
	return Object.freeze(left.filter(selector => rightSet.has(selector)));
}

function mergePolicy(base: AgentPolicyFields, layer: AgentPolicyFields | undefined): AgentPolicyFields {
	if (!layer) return base;
	assertValidBudget(layer.maxRequests, "maxRequests");
	assertValidBudget(layer.maxRuntimeMs, "maxRuntimeMs");

	const workClass: WorkClass | undefined =
		base.workClass === "judgment" || layer.workClass === "judgment"
			? "judgment"
			: (layer.workClass ?? base.workClass);

	return {
		tier:
			base.tier && layer.tier
				? minByRank(base.tier, layer.tier, TIER_RANK)
				: (layer.tier ?? base.tier),
		autonomy:
			base.autonomy && layer.autonomy
				? minByRank(base.autonomy, layer.autonomy, AUTONOMY_RANK)
				: (layer.autonomy ?? base.autonomy),
		collaboration:
			base.collaboration && layer.collaboration
				? minByRank(base.collaboration, layer.collaboration, COLLABORATION_RANK)
				: (layer.collaboration ?? base.collaboration),
		workClass,
		editMode:
			base.editMode && layer.editMode
				? minByRank(base.editMode, layer.editMode, EDIT_MODE_RANK)
				: (layer.editMode ?? base.editMode),
		maxRequests:
			base.maxRequests === undefined
				? layer.maxRequests
				: layer.maxRequests === undefined
					? base.maxRequests
					: minBudget(base.maxRequests, layer.maxRequests),
		maxRuntimeMs:
			base.maxRuntimeMs === undefined
				? layer.maxRuntimeMs
				: layer.maxRuntimeMs === undefined
					? base.maxRuntimeMs
					: minBudget(base.maxRuntimeMs, layer.maxRuntimeMs),
		modelPool: intersectModelPools(base.modelPool, layer.modelPool),
	};
}

function applyJudgmentFloor(
	fields: AgentPolicyFields,
	policy: JudgmentFloorPolicy,
): AgentPolicyFields {
	if (fields.workClass !== "judgment") return fields;
	const tier = fields.tier ?? DEFAULT_AGENT_EXECUTION_PROFILE.tier;
	if (TIER_RANK[tier] >= TIER_RANK.mid) return fields;
	if (policy === "reject") {
		throw new JudgmentTierViolationError();
	}
	return { ...fields, tier: "mid" };
}

function freezeProfile(profile: AgentExecutionProfile): AgentExecutionProfile {
	return Object.freeze({
		tier: profile.tier,
		autonomy: profile.autonomy,
		collaboration: profile.collaboration,
		workClass: profile.workClass,
		editMode: profile.editMode,
		maxRequests: profile.maxRequests,
		maxRuntimeMs: profile.maxRuntimeMs,
		modelPool: Object.freeze([...profile.modelPool]),
		modelPoolConstrained: profile.modelPoolConstrained,
	});
}

/**
 * Compose partial policy layers without applying defaults or the judgment floor.
 * Precedence is restrictive merge across workflow → type → id → override.
 */
export function composeAgentPolicyFields(
	input: Pick<
		AgentExecutionProfileInput,
		"workflowPolicy" | "agentTypePolicy" | "agentIdPolicy" | "override"
	>,
): AgentPolicyFields {
	let merged: AgentPolicyFields = {};
	merged = mergePolicy(merged, input.workflowPolicy);
	merged = mergePolicy(merged, input.agentTypePolicy);
	merged = mergePolicy(merged, input.agentIdPolicy);
	merged = mergePolicy(merged, input.override);
	return {
		...merged,
		...(merged.modelPool !== undefined ? { modelPool: Object.freeze([...merged.modelPool]) } : {}),
	};
}

/**
 * Resolve an immutable execution profile from layered restrictive inputs.
 *
 * Axes remain independent: `independent` does not imply `frontier`, and
 * `frontier` does not imply `independent`.
 */
export function resolveAgentExecutionProfile(input: AgentExecutionProfileInput = {}): AgentExecutionProfile {
	const merged = composeAgentPolicyFields(input);
	const floored = applyJudgmentFloor(merged, input.judgmentFloor ?? "raise");
	assertValidBudget(floored.maxRequests, "maxRequests");
	assertValidBudget(floored.maxRuntimeMs, "maxRuntimeMs");

	return freezeProfile({
		tier: floored.tier ?? DEFAULT_AGENT_EXECUTION_PROFILE.tier,
		autonomy: floored.autonomy ?? DEFAULT_AGENT_EXECUTION_PROFILE.autonomy,
		collaboration: floored.collaboration ?? DEFAULT_AGENT_EXECUTION_PROFILE.collaboration,
		workClass: floored.workClass ?? DEFAULT_AGENT_EXECUTION_PROFILE.workClass,
		editMode: floored.editMode ?? DEFAULT_AGENT_EXECUTION_PROFILE.editMode,
		maxRequests: floored.maxRequests ?? DEFAULT_AGENT_EXECUTION_PROFILE.maxRequests,
		maxRuntimeMs: floored.maxRuntimeMs ?? DEFAULT_AGENT_EXECUTION_PROFILE.maxRuntimeMs,
		modelPool: floored.modelPool ?? DEFAULT_AGENT_EXECUTION_PROFILE.modelPool,
		modelPoolConstrained: floored.modelPool !== undefined,
	});
}
