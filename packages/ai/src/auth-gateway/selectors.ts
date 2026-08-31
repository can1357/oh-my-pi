/**
 * Pure route-candidate ranking for the auth-gateway.
 *
 * Diversity filtering is opt-in: selectors call {@link applyDiversity} only when
 * `ctx.diversity` is set, then rank the survivors.
 */

export interface RouteCandidate {
	id: string;
	weight?: number;
	inFlight?: number;
	latencyMs?: number;
	provider?: string;
	family?: string;
	model?: string;
	credentialId?: number;
}

export interface RankedCandidate {
	id: string;
	score: number;
}

export interface DiversityConstraint {
	avoidModel?: string;
	avoidFamily?: string;
	avoidProvider?: string;
	avoidCredential?: number;
}

export interface RouteSelectionContext {
	diversity?: DiversityConstraint;
}

export interface RouteSelector {
	rank(candidates: readonly RouteCandidate[], ctx: RouteSelectionContext): readonly RankedCandidate[];
}

type CandidateScore = (candidate: RouteCandidate) => number;

function matchesAvoid(candidate: RouteCandidate, d: DiversityConstraint): boolean {
	if (d.avoidModel !== undefined && candidate.model === d.avoidModel) return true;
	if (d.avoidFamily !== undefined && candidate.family === d.avoidFamily) return true;
	if (d.avoidProvider !== undefined && candidate.provider === d.avoidProvider) return true;
	if (d.avoidCredential !== undefined && candidate.credentialId === d.avoidCredential) return true;
	return false;
}

/** Drop candidates whose fields match any set `avoid*` constraint. */
export function applyDiversity(candidates: readonly RouteCandidate[], d: DiversityConstraint): RouteCandidate[] {
	const kept: RouteCandidate[] = [];
	for (const candidate of candidates) {
		if (matchesAvoid(candidate, d)) continue;
		kept.push(candidate);
	}
	return kept;
}

function selectedCandidates(
	candidates: readonly RouteCandidate[],
	ctx: RouteSelectionContext,
): readonly RouteCandidate[] {
	const diversity = ctx.diversity;
	if (diversity === undefined) return candidates;
	return applyDiversity(candidates, diversity);
}

function rankByScore(candidates: readonly RouteCandidate[], scoreOf: CandidateScore): RankedCandidate[] {
	const ranked: RankedCandidate[] = [];
	for (const candidate of candidates) {
		ranked.push({ id: candidate.id, score: scoreOf(candidate) });
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked;
}

/** Preserve input order. Score is `n - i` (first candidate scores `n`). */
export const orderedSelector: RouteSelector = {
	rank(candidates: readonly RouteCandidate[], ctx: RouteSelectionContext): readonly RankedCandidate[] {
		const selected = selectedCandidates(candidates, ctx);
		const n = selected.length;
		const ranked: RankedCandidate[] = [];
		for (let i = 0; i < n; i++) {
			ranked.push({ id: selected[i].id, score: n - i });
		}
		return ranked;
	},
};

/** Score is `weight ?? 1`. Stable sort, highest score first. */
export const weightedSelector: RouteSelector = {
	rank(candidates: readonly RouteCandidate[], ctx: RouteSelectionContext): readonly RankedCandidate[] {
		return rankByScore(selectedCandidates(candidates, ctx), candidate => candidate.weight ?? 1);
	},
};

/** Score is `-(inFlight ?? 0)`. Lower in-flight count ranks first. */
export const leastBusySelector: RouteSelector = {
	rank(candidates: readonly RouteCandidate[], ctx: RouteSelectionContext): readonly RankedCandidate[] {
		return rankByScore(selectedCandidates(candidates, ctx), candidate => 0 - (candidate.inFlight ?? 0));
	},
};
