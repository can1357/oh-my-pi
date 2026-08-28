/**
 * Contextual-Need Coverage Evaluator
 *
 * Measures whether the memory context contains every distinct category
 * of information required for the agent's next decision.
 *
 * All metrics in the coverage report are computed from the inputs that are
 * actually provided — nothing is fabricated. Freshness needs a clock, so the
 * caller injects `nowIso`; verification strength is derived from the need
 * supports (or, as a fallback, from the injected records themselves).
 */

import type { ContextTier, MemoryVerificationLevel } from "./rrf-fusion";

export type ContextNeedType =
	| "objective"
	| "constraint"
	| "current-state"
	| "decision"
	| "procedure"
	| "failure-history"
	| "code-impact"
	| "validation"
	| "environment"
	| "approval"
	| "historical-rationale"
	| "evidence";

export type NeedSatisfactionStatus = "unresolved" | "partially-satisfied" | "satisfied" | "contradicted";

export interface ContextNeed {
	id: string;
	type: ContextNeedType;

	description: string;
	required: boolean;
	critical?: boolean;
	priority: number;

	expectedScope?: {
		projectId: string;
		branchId?: string;
		worktreeId?: string;
	};

	acceptableVerification?: MemoryVerificationLevel[];

	satisfiedByMemoryIds: string[];
	partiallySatisfiedByMemoryIds: string[];

	status: NeedSatisfactionStatus;
}

export interface ContextNeedTemplate {
	type: ContextNeedType;
	description: string;
	required: boolean;
	critical?: boolean;
	priority: number;
}

export interface NeedSupport {
	needId: string;
	memoryId: string;

	support: "complete" | "partial" | "contradictory" | "none";
	supportScore: number;
	verification?: MemoryVerificationLevel;
	evidenceReferences?: string[];
}

/** Minimal view of an injected record used for provenance/verification/freshness metrics. */
export interface InjectedRecordView {
	id: string;
	verification?: MemoryVerificationLevel;
	createdAt?: string;
	sourceRefs?: string[];
}

/** Optional inputs that make the report's verification and freshness metrics computable. */
export interface CoverageReportOptions {
	/** Need supports gathered during matching; used for verificationCoverage. */
	supports?: NeedSupport[];
	/** ISO timestamp for "now", injected so the report stays pure. */
	nowIso?: string;
	/** Age window within which a record counts as fresh. Default: 14 days. */
	freshnessWindowMs?: number;
}

export interface ContextCoverageReport {
	packetId: string;

	totalNeeds: number;
	requiredNeeds: number;

	requiredCoverage: number;
	weightedCoverage: number;
	verificationCoverage: number;
	provenanceCoverage: number;
	freshnessCoverage: number;

	satisfiedNeedIds: string[];
	partiallySatisfiedNeedIds: string[];
	unresolvedNeedIds: string[];
	contradictedNeedIds: string[];

	recommendedExpansionTiers: ContextTier[];
	recommendedQueries: string[];
	missingCriticalNeedIds: string[];
	criticalNeedsSatisfied: boolean;
}

/**
 * Default Task Need Templates according to Section 3.2
 */
export const DEBUGGING_NEED_TEMPLATES: ContextNeedTemplate[] = [
	{
		type: "objective",
		description: "Clear debugging goal and target error",
		required: true,
		critical: true,
		priority: 1.0,
	},
	{
		type: "current-state",
		description: "Active stack trace and failing context",
		required: true,
		critical: true,
		priority: 1.0,
	},
	{
		type: "failure-history",
		description: "Previous similar failure patterns or fixes",
		required: false,
		priority: 0.6,
	},
	{
		type: "procedure",
		description: "Verified procedure or reproduction steps",
		required: true,
		critical: true,
		priority: 0.9,
	},
	{ type: "code-impact", description: "Affected source code files and symbols", required: true, priority: 0.8 },
	{
		type: "validation",
		description: "Test command to verify the fix",
		required: true,
		critical: true,
		priority: 1.0,
	},
];

export const ARCHITECTURE_NEED_TEMPLATES: ContextNeedTemplate[] = [
	{ type: "objective", description: "Architecture redesign goal", required: true, critical: true, priority: 1.0 },
	{
		type: "constraint",
		description: "Active project constraints and boundaries",
		required: true,
		critical: true,
		priority: 1.0,
	},
	{
		type: "decision",
		description: "Prior architectural decisions and contracts",
		required: true,
		critical: true,
		priority: 0.95,
	},
	{ type: "code-impact", description: "Code graph relationships and call paths", required: true, priority: 0.9 },
	{ type: "historical-rationale", description: "Why previous design was chosen", required: false, priority: 0.5 },
	{ type: "validation", description: "Integration test strategy", required: true, priority: 0.9 },
];

export const RECOVERY_NEED_TEMPLATES: ContextNeedTemplate[] = [
	{ type: "objective", description: "Task continuation objective", required: true, critical: true, priority: 1.0 },
	{
		type: "current-state",
		description: "Plan step and completed steps",
		required: true,
		critical: true,
		priority: 1.0,
	},
	{ type: "code-impact", description: "Recently modified files", required: true, critical: true, priority: 0.9 },
	{
		type: "failure-history",
		description: "Unresolved errors before crash",
		required: true,
		critical: true,
		priority: 0.9,
	},
	{ type: "validation", description: "Pending validation checks", required: true, critical: true, priority: 0.8 },
];

export const DEPLOYMENT_NEED_TEMPLATES: ContextNeedTemplate[] = [
	{
		type: "environment",
		description: "Target deployment environment and config",
		required: true,
		critical: true,
		priority: 1.0,
	},
	{ type: "procedure", description: "Deployment & release procedure", required: true, critical: true, priority: 1.0 },
	{
		type: "approval",
		description: "Required user approval / policy checks",
		required: true,
		critical: true,
		priority: 0.95,
	},
	{
		type: "failure-history",
		description: "Previous deployment failures or rollbacks",
		required: false,
		priority: 0.6,
	},
	{ type: "validation", description: "Post-deploy smoke test checks", required: true, critical: true, priority: 1.0 },
];

/** Task types that have a need-template set. */
export const KNOWN_NEED_TASK_TYPES = ["debugging", "architecture", "recovery", "deployment"] as const;

/**
 * Get templates for a task type.
 *
 * Returns null for unknown task types instead of silently handing back the
 * debugging templates — callers must decide their own fallback explicitly.
 */
export function getNeedTemplatesForTask(taskType: string): ContextNeedTemplate[] | null {
	switch (taskType.toLowerCase()) {
		case "debugging":
			return DEBUGGING_NEED_TEMPLATES;
		case "architecture":
			return ARCHITECTURE_NEED_TEMPLATES;
		case "recovery":
			return RECOVERY_NEED_TEMPLATES;
		case "deployment":
			return DEPLOYMENT_NEED_TEMPLATES;
		default:
			return null;
	}
}

/**
 * Unweighted coverage calculation for required needs:
 * satisfied required / total required.
 */
export function calculateRequiredCoverage(needs: ContextNeed[]): number {
	const required = needs.filter(n => n.required);
	if (required.length === 0) return 1.0;

	const satisfied = required.reduce((sum, n) => {
		if (n.status === "satisfied") return sum + 1;
		if (n.status === "partially-satisfied") return sum + 0.5;
		return sum;
	}, 0);

	return satisfied / required.length;
}

/**
 * Priority-weighted coverage calculation:
 * sum( priority_i * satisfaction_i ) / sum( priority_i ).
 */
export function calculateWeightedCoverage(needs: ContextNeed[]): number {
	const denominator = needs.reduce((sum, n) => sum + n.priority, 0);
	if (denominator === 0) return 1.0;

	const numerator = needs.reduce((sum, n) => {
		const satisfaction = n.status === "satisfied" ? 1.0 : n.status === "partially-satisfied" ? 0.5 : 0.0;
		return sum + n.priority * satisfaction;
	}, 0);

	return numerator / denominator;
}

/**
 * Verification support weight.
 */
export function verificationSupportWeight(verification?: MemoryVerificationLevel): number {
	switch (verification) {
		case "user-confirmed":
		case "test-observed":
			return 1.0;
		case "source-extracted":
			return 0.95;
		case "tool-observed":
			return 0.9;
		case "episode-derived":
			return 0.7;
		case "model-proposed":
			return 0.4;
		default:
			return 0.6;
	}
}

/**
 * Calculate support satisfaction score for a set of need supports.
 */
export function calculateNeedSatisfaction(supports: NeedSupport[]): number {
	if (supports.length === 0) return 0;
	return Math.max(0, ...supports.map(s => s.supportScore * verificationSupportWeight(s.verification)));
}

/** Threshold above which a support/record counts as strongly verified. */
const STRONG_VERIFICATION_WEIGHT = 0.9;

/**
 * Verification coverage: among the needs that are satisfied or
 * partially-satisfied, the fraction whose best supporting evidence carries a
 * verification weight of at least 0.90.
 *
 * Evidence is taken from `supports` when available; otherwise from the
 * verification level of the injected records referenced by the need. A
 * covered need with no traceable evidence counts as NOT strongly verified —
 * unknown provenance is never assumed to be strong.
 */
export function calculateVerificationCoverage(
	needs: ContextNeed[],
	injectedRecords: InjectedRecordView[],
	supports?: NeedSupport[],
): number {
	if (needs.length === 0) return 1.0;

	const covered = needs.filter(n => n.status === "satisfied" || n.status === "partially-satisfied");
	if (covered.length === 0) return 0.0;

	const recordsById = new Map(injectedRecords.map(r => [r.id, r]));

	let stronglyVerified = 0;
	for (const need of covered) {
		let bestWeight = 0;

		if (supports) {
			for (const s of supports) {
				if (s.needId !== need.id) continue;
				if (s.support === "none" || s.support === "contradictory") continue;
				bestWeight = Math.max(bestWeight, verificationSupportWeight(s.verification));
			}
		}

		if (bestWeight < STRONG_VERIFICATION_WEIGHT) {
			const supportingIds = [...need.satisfiedByMemoryIds, ...need.partiallySatisfiedByMemoryIds];
			for (const id of supportingIds) {
				const record = recordsById.get(id);
				if (!record?.verification) continue;
				bestWeight = Math.max(bestWeight, verificationSupportWeight(record.verification));
			}
		}

		if (bestWeight >= STRONG_VERIFICATION_WEIGHT) stronglyVerified += 1;
	}

	return stronglyVerified / covered.length;
}

/** Default freshness window: 14 days. */
export const DEFAULT_FRESHNESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Freshness coverage: the fraction of injected records that are fresh.
 *
 * A record is fresh when it has a parseable createdAt timestamp and — when a
 * clock (`nowIso`) is injected — its age is within the freshness window.
 * Without an injected clock, a parseable timestamp alone counts as fresh
 * because age cannot be evaluated. Records without a timestamp are never
 * counted as fresh. No records means nothing is stale: 1.0.
 */
export function calculateFreshnessCoverage(
	injectedRecords: InjectedRecordView[],
	nowIso?: string,
	freshnessWindowMs: number = DEFAULT_FRESHNESS_WINDOW_MS,
): number {
	if (injectedRecords.length === 0) return 1.0;

	const nowMs = nowIso ? Date.parse(nowIso) : Number.NaN;

	const fresh = injectedRecords.filter(r => {
		if (!r.createdAt) return false;
		const createdMs = Date.parse(r.createdAt);
		if (Number.isNaN(createdMs)) return false;
		if (Number.isNaN(nowMs)) return true;
		return nowMs - createdMs <= freshnessWindowMs;
	});

	return fresh.length / injectedRecords.length;
}

/**
 * Build a complete ContextCoverageReport from needs and memory candidates.
 */
export function generateCoverageReport(
	packetId: string,
	needs: ContextNeed[],
	injectedRecords: InjectedRecordView[],
	options?: CoverageReportOptions,
): ContextCoverageReport {
	const totalNeeds = needs.length;
	const requiredNeeds = needs.filter(n => n.required).length;

	const requiredCoverage = calculateRequiredCoverage(needs);
	const weightedCoverage = calculateWeightedCoverage(needs);

	const satisfiedNeedIds = needs.filter(n => n.status === "satisfied").map(n => n.id);
	const partiallySatisfiedNeedIds = needs.filter(n => n.status === "partially-satisfied").map(n => n.id);
	const unresolvedNeedIds = needs.filter(n => n.status === "unresolved").map(n => n.id);
	const contradictedNeedIds = needs.filter(n => n.status === "contradicted").map(n => n.id);
	const missingCriticalNeedIds = needs.filter(n => n.critical && n.status !== "satisfied").map(n => n.id);
	const criticalNeedsSatisfied = missingCriticalNeedIds.length === 0;

	const verificationCoverage = calculateVerificationCoverage(needs, injectedRecords, options?.supports);

	// Provenance coverage: fraction of records with valid sourceRefs
	const provenanceCoverage =
		injectedRecords.length > 0
			? injectedRecords.filter(r => r.sourceRefs && r.sourceRefs.length > 0).length / injectedRecords.length
			: 1.0;

	const freshnessCoverage = calculateFreshnessCoverage(injectedRecords, options?.nowIso, options?.freshnessWindowMs);

	// Determine recommended expansion tiers and query topics for unresolved needs
	const recommendedExpansionTiers = new Set<ContextTier>();
	const recommendedQueries: string[] = [];

	const unresolvedNeeds = needs.filter(n => n.status === "unresolved" || n.status === "partially-satisfied");
	for (const need of unresolvedNeeds) {
		switch (need.type) {
			case "failure-history":
			case "validation":
				recommendedExpansionTiers.add("L2");
				recommendedQueries.push(`Procedure, failure history, or validation for ${need.description}`);
				break;
			case "code-impact":
				recommendedExpansionTiers.add("L3");
				recommendedQueries.push(`Code graph impact for ${need.description}`);
				break;
			case "historical-rationale":
			case "evidence":
				recommendedExpansionTiers.add("L4");
				recommendedQueries.push(`Evidence or historical rationale for ${need.description}`);
				break;
			default:
				recommendedExpansionTiers.add("L1");
				recommendedQueries.push(`Active decision, environment, or constraint for ${need.description}`);
				break;
		}
	}

	return {
		packetId,
		totalNeeds,
		requiredNeeds,
		requiredCoverage,
		weightedCoverage,
		verificationCoverage,
		provenanceCoverage,
		freshnessCoverage,
		satisfiedNeedIds,
		partiallySatisfiedNeedIds,
		unresolvedNeedIds,
		contradictedNeedIds,
		recommendedExpansionTiers: [...recommendedExpansionTiers],
		recommendedQueries,
		missingCriticalNeedIds,
		criticalNeedsSatisfied,
	};
}
