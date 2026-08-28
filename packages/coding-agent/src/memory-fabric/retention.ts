/**
 * Retention scoring — which memories earn their keep.
 *
 * Scores a memory record from observable signals (verification, use rate,
 * scope relevance, age, graph centrality, contradictions, duplication) and
 * maps the score onto a storage tier: hot, warm, cold, or delete. Maintenance
 * jobs consume these scores; this module never touches storage itself.
 *
 * Deterministic by construction: the clock is injected, all signals arrive as
 * explicit inputs, and identical inputs always produce identical scores. The
 * factor breakdown is returned alongside the score so a pruning decision can
 * always be explained after the fact.
 */

import type { MemoryRecord, MemoryVerification } from "./types";

/** Storage tier implied by a retention score. */
export type RetentionTier = "hot" | "warm" | "cold" | "delete";

/** Per-record usage signals, gathered by the caller from its own telemetry. */
export interface RetentionSignals {
	/** How often the record was retrieved in the observation window. */
	retrievalCount: number;
	/** How many of those retrievals were marked useful. */
	usefulCount: number;
	/** How many times the record was contradicted. */
	contradictionCount: number;
	/** How many other records depend on this one. */
	dependentCount: number;
	/** How many other records share this record's content hash. */
	duplicateCount: number;
}

/** All-zero signals, for records with no telemetry yet. */
export function emptyRetentionSignals(): RetentionSignals {
	return {
		retrievalCount: 0,
		usefulCount: 0,
		contradictionCount: 0,
		dependentCount: 0,
		duplicateCount: 0,
	};
}

/** The score, its tier, and the factor breakdown that produced it. */
export interface RetentionScore {
	/** Normalized to [0, 1]. */
	score: number;
	tier: RetentionTier;
	factors: {
		importance: number;
		verificationStrength: number;
		successfulUseRate: number;
		scopeRelevance: number;
		uniqueness: number;
		recency: number;
		dependencyCentrality: number;
		contradictionPenalty: number;
		stalenessPenalty: number;
		duplicationPenalty: number;
	};
}

/** Scope and clock context for scoring. */
export interface RetentionContext {
	currentProjectId: string;
	currentBranchId?: string;
	/** Injectable clock; defaults to `Date.now`. */
	now?: () => number;
}

/** Retention policy knobs consumed by maintenance jobs. */
export interface RetentionPolicy {
	/** Volatile facts (command output, transient state) expire after this. */
	volatileTtlHours: number;
	/** Unpromoted candidate records expire after this many days. */
	candidateTtlDays: number;
	/** Untouched records move to cold storage after this many days. */
	archiveAfterDays: number;
	/** Derived records scoring below this become deletion candidates. */
	deleteDerivedBelowScore: number;
	/** Evidence records are never deleted by automated maintenance. */
	preserveEvidence: boolean;
	/** Audit records are never deleted by automated maintenance. */
	preserveAudit: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
	volatileTtlHours: 24,
	candidateTtlDays: 7,
	archiveAfterDays: 30,
	deleteDerivedBelowScore: 0.25,
	preserveEvidence: true,
	preserveAudit: true,
};

/** How much each verification state is worth as evidence of truth. */
const VERIFICATION_STRENGTH: Record<MemoryVerification, number> = {
	"user-confirmed": 1.0,
	observed: 0.7,
	"model-proposed": 0.3,
	archived: 0.2,
	superseded: 0.1,
	contradicted: 0.0,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Map a normalized score onto its storage tier. */
export function tierForScore(score: number): RetentionTier {
	if (score >= 0.75) return "hot";
	if (score >= 0.5) return "warm";
	if (score >= 0.25) return "cold";
	return "delete";
}

/**
 * Score one record.
 *
 * Positive factors are weighted 0.22 importance, 0.18 verification, 0.16 use
 * rate, 0.14 scope relevance, 0.10 each uniqueness/recency/centrality; the
 * three penalties subtract directly. The sum is clamped to [0, 1].
 */
export function computeRetentionScore(
	record: MemoryRecord,
	signals: RetentionSignals,
	context: RetentionContext,
): RetentionScore {
	const now = context.now ?? Date.now;

	const importance = clamp01(record.importance);
	const verificationStrength = VERIFICATION_STRENGTH[record.verification] ?? 0.5;

	const successfulUseRate = signals.retrievalCount > 0 ? clamp01(signals.usefulCount / signals.retrievalCount) : 0;

	const projectMatch = record.projectId === context.currentProjectId ? 1 : 0;
	const branchMatch = context.currentBranchId !== undefined && record.branchId === context.currentBranchId ? 1 : 0;
	const scopeRelevance = projectMatch * 0.7 + branchMatch * 0.3;

	const uniqueness = 1 / (1 + Math.max(0, signals.duplicateCount));

	const createdAt = Date.parse(record.createdAt);
	const ageDays = Number.isNaN(createdAt) ? 0 : Math.max(0, (now() - createdAt) / DAY_MS);
	const recency = Math.max(0, 1 - ageDays / 365);

	const dependencyCentrality = Math.min(1, Math.max(0, signals.dependentCount) / 10);

	const contradictionPenalty = Math.max(0, signals.contradictionCount) * 0.2;
	const stalenessPenalty = ageDays > 90 ? 0.1 : 0;
	const duplicationPenalty = Math.max(0, signals.duplicateCount) * 0.05;

	const raw =
		0.22 * importance +
		0.18 * verificationStrength +
		0.16 * successfulUseRate +
		0.14 * scopeRelevance +
		0.1 * uniqueness +
		0.1 * recency +
		0.1 * dependencyCentrality -
		contradictionPenalty -
		stalenessPenalty -
		duplicationPenalty;

	const score = clamp01(raw);

	return {
		score,
		tier: tierForScore(score),
		factors: {
			importance,
			verificationStrength,
			successfulUseRate,
			scopeRelevance,
			uniqueness,
			recency,
			dependencyCentrality,
			contradictionPenalty,
			stalenessPenalty,
			duplicationPenalty,
		},
	};
}

/**
 * Whether automated maintenance may delete this record under `policy`.
 *
 * Deletion requires a "delete"-tier score AND a record the policy does not
 * protect: evidence and audit-tagged records survive regardless of score.
 */
export function isDeletionCandidate(record: MemoryRecord, score: RetentionScore, policy: RetentionPolicy): boolean {
	if (score.score >= policy.deleteDerivedBelowScore) return false;
	if (policy.preserveEvidence && record.type === "evidence") return false;
	if (policy.preserveAudit && record.tags.includes("audit")) return false;
	return true;
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(1, value));
}
