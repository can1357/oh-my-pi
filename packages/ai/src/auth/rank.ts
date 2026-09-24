import type { PlanGate, UsageReport } from "../usage";
import type { AuthCredential, ApiKeyCredential, OAuthCredential } from "./types";

/** Selected stored credential and its pool index. */
export type CredentialSelection<T extends AuthCredential> = {
	credential: T;
	index: number;
};
/** Selected OAuth credential for routing. */
export type OAuthSelection = CredentialSelection<OAuthCredential>;
/** Selected API-key credential for routing. */
export type ApiKeySelection = CredentialSelection<ApiKeyCredential>;

/** Selected credential with its observed usage. */
export type UsageCandidate<T extends AuthCredential> = {
	selection: CredentialSelection<T>;
	usage: UsageReport | null;
	usageChecked: boolean;
	/** Present after policy-aware ranking; used to decide whether a warm automatic pin may be evicted. */
	inReserve?: boolean;
	/** True only when reserve ranking had a usable remaining-fraction measurement. */
	reserveMeasured?: boolean;
};

/** OAuth credential eligible for usage ranking. */
export type OAuthCandidate = UsageCandidate<OAuthCredential>;
/** API-key credential eligible for usage ranking. */
export type ApiKeyCandidate = UsageCandidate<ApiKeyCredential>;
/** Ranked candidate with a possible block deadline. */
export type UsageRankingResult<T extends AuthCredential> = UsageCandidate<T> & {
	blockedUntil: number | undefined;
};

/** Candidate with all account-policy and usage ranking metrics. */
export type UsageRankedCandidate<T extends AuthCredential> = UsageCandidate<T> & {
	blocked: boolean;
	blockedUntil?: number;
	inReserve: boolean;
	reserveMeasured?: boolean;
	accountPriority: number;
	hasPriorityBoost: boolean;
	usageMeasured: boolean;
	planPriority: number;
	secondaryUsed: number;
	secondaryRequiredDrain: number;
	primaryUsed: number;
	primaryRequiredDrain: number;
	orderPos: number;
};
/** OAuth candidate with complete ranking metrics. */
export type RankedOAuthCandidate = UsageRankedCandidate<OAuthCredential>;
/** API-key candidate with complete ranking metrics. */
export type RankedApiKeyCandidate = UsageRankedCandidate<ApiKeyCredential>;

const USAGE_RANKING_METRIC_EPSILON = 1e-9;
/**
 * Primary (short, e.g. 5h) window used-fraction at or above which a candidate
 * is demoted behind cooler siblings during ranking: a nearly exhausted short
 * window means an imminent mid-session block, so drain urgency defers to it.
 */
const PRIMARY_WINDOW_HOT_FRACTION = 0.85;

/** Rank accounts by model-plan eligibility when a plan gate applies. */
export function planPriority(gate: PlanGate | undefined, report: UsageReport | null): number {
	if (!gate) return 0;
	const eligibility = gate(report);
	return eligibility === true ? 0 : eligibility === undefined ? 1 : 2;
}

function compareUsageRankingMetric(left: number, right: number): number {
	if (left === right) return 0;
	if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
	const delta = left - right;
	const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
	return Math.abs(delta) <= tolerance ? 0 : delta;
}

function compareUsageRankedCandidatePriority(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planGated: boolean,
): number {
	if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
	if (left.blocked && right.blocked) {
		const leftBlockedUntil = left.blockedUntil ?? Number.POSITIVE_INFINITY;
		const rightBlockedUntil = right.blockedUntil ?? Number.POSITIVE_INFINITY;
		if (leftBlockedUntil !== rightBlockedUntil) return leftBlockedUntil - rightBlockedUntil;
		return 0;
	}
	if (planGated && left.planPriority !== right.planPriority) {
		return left.planPriority - right.planPriority;
	}
	if (left.inReserve !== right.inReserve) return left.inReserve ? 1 : -1;
	if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
	// Short-window guard: candidates whose primary (e.g. 5h) window is
	// nearly exhausted rank behind cool ones regardless of drain urgency —
	// overflow lands on the next-most-urgent cool account instead.
	const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
	if (leftHot !== rightHot) return leftHot ? 1 : -1;
	// Usage-backed candidates outrank unmeasured ones: required-drain
	// scores are only comparable between measured windows, and the
	// clockless headroom fallback (0..1) must not let an account whose
	// usage fetch failed shadow a measured sibling.
	const leftMeasured = left.usageMeasured;
	const rightMeasured = right.usageMeasured;
	if (leftMeasured !== rightMeasured) return leftMeasured ? -1 : 1;
	if (left.accountPriority !== right.accountPriority) return right.accountPriority - left.accountPriority;
	// Required drain, descending: the account whose remaining quota must
	// burn fastest to avoid expiring unused at its reset comes first, so
	// staggered resets land at ~100% utilization instead of stranding
	// headroom that a cooler sibling could have absorbed.
	let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
	if (metric !== 0) return metric;
	metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
	if (metric !== 0) return metric;
	return 0;
}

function compareUsageRankedCandidates(
	left: UsageRankedCandidate<AuthCredential>,
	right: UsageRankedCandidate<AuthCredential>,
	planGated: boolean,
): number {
	const priority = compareUsageRankedCandidatePriority(left, right, planGated);
	return priority !== 0 ? priority : left.orderPos - right.orderPos;
}

/** Sort ranked candidates by blocks, plan, reserve, boost, hot window, usage and drain. */
export function orderUsageRankedCandidates<T extends AuthCredential>(
	candidates: UsageRankedCandidate<T>[],
	planGated: boolean,
): UsageCandidate<T>[] {
	candidates.sort((left, right) => compareUsageRankedCandidates(left, right, planGated));
	return candidates.map(candidate => ({
		selection: candidate.selection,
		usage: candidate.usage,
		usageChecked: candidate.usageChecked,
		inReserve: candidate.inReserve,
		reserveMeasured: candidate.reserveMeasured,
	}));
}
