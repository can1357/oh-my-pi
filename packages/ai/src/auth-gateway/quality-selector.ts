import type { RoutePerformanceStore } from "./route-performance";
import type { RankedCandidate, RouteCandidate, RouteSelectionContext, RouteSelector } from "./selectors";

/**
 * Rank route candidates by historical success rate for a single routeId.
 * Missing summaries score 0.5 so untested targets are not treated as dead.
 */
export function qualitySelector(store: RoutePerformanceStore, routeId: string): RouteSelector {
	return {
		rank(candidates: readonly RouteCandidate[], _ctx: RouteSelectionContext): readonly RankedCandidate[] {
			const ranked: RankedCandidate[] = [];
			for (const candidate of candidates) {
				const summary = store.summary(routeId, candidate.id);
				const score = summary === undefined ? 0.5 : summary.successes / summary.attempts;
				ranked.push({ id: candidate.id, score });
			}
			ranked.sort((a, b) => b.score - a.score);
			return ranked;
		},
	};
}
