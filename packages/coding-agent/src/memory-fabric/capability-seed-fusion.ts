/**
 * Capability Seed Fusion — RRF seed producer.
 *
 * Heterogeneous candidate sources (lexical BM25, semantic vector, project
 * affinity, workflow steps, historical co-occurrence) must be fused into a
 * single ranked seed set *before* graph expansion (`capability-bundle.ts`).
 *
 * This module implements Reciprocal Rank Fusion (RRF):
 *
 *   score(c) = sum_{s in sources} weight(s) / (k + rank(c, s))
 *
 * Features:
 *   - Preserves per-source contribution breakdowns for explainability.
 *   - Aggregates `needId` annotations so downstream coverage checks know
 *     which required needs each candidate claims to satisfy.
 *   - Supports custom per-source weights (defaults: workflow > project >
 *     lexical/semantic > historical > kind-match).
 *   - Optional historical outcome feedback boosting.
 *   - Pure, observe-only, fail-open, disabled by default.
 */

export type CapabilitySeedSource = "lexical" | "semantic" | "project" | "workflow" | "historical" | "kind-match";

export interface RankedCapabilityList {
	source: CapabilitySeedSource;
	items: readonly string[];
	needId?: string;
}

export interface SeedSourceContribution {
	source: CapabilitySeedSource;
	rank: number;
	weight: number;
	contribution: number;
}

export interface FusedSeedCandidate {
	capabilityId: string;
	rrfScore: number;
	contributions: SeedSourceContribution[];
	sources: CapabilitySeedSource[];
	needIds: string[];
	appearedInSources: number;
	matchedNeedIds: string[];
}

export interface SeedFusionResult {
	mode: "observe";
	enabled: boolean;
	candidates: FusedSeedCandidate[];
}

export interface HistoricalOutcomeFeedback {
	/** Success rate 0-1 for this capability. */
	successRate: number;
	/** Number of historical uses. */
	totalUses: number;
	/** Co-occurrence frequency/bonus map for co-retrieved capabilities. */
	coOccurrenceBonus?: Record<string, number>;
}

export interface SeedFusionOptions {
	/** Disabled by default. When false, an inert (empty) result is returned. */
	enabled?: boolean;
	/** RRF rank constant `k`. Larger `k` flattens the rank curve. Default: 60. */
	rankConstant?: number;
	/** Per-source weights; merged over `DEFAULT_SOURCE_WEIGHTS`. */
	sourceWeights?: Partial<Record<CapabilitySeedSource, number>>;
	/** Only fuse the first `rankWindow` items of each list. Default: unlimited. */
	rankWindow?: number;
	/** Keep only the top `topK` fused candidates. Default: unlimited. */
	topK?: number;
	/** Historical outcome feedback for dynamic score boosting. */
	outcomeFeedback?: Record<string, HistoricalOutcomeFeedback>;
}

export const DEFAULT_SOURCE_WEIGHTS: Record<CapabilitySeedSource, number> = {
	lexical: 1.0,
	semantic: 1.0,
	project: 1.05,
	workflow: 1.1,
	historical: 0.9,
	"kind-match": 0.85,
};

const DEFAULT_RANK_CONSTANT = 60;

const KNOWN_SOURCES: ReadonlySet<CapabilitySeedSource> = new Set([
	"lexical",
	"semantic",
	"project",
	"workflow",
	"historical",
	"kind-match",
]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

interface MutableCandidate {
	capabilityId: string;
	rrfScore: number;
	contributions: SeedSourceContribution[];
	sources: Set<CapabilitySeedSource>;
	needIds: Set<string>;
}

/**
 * Fuse ranked candidate lists into a single RRF-scored seed set. Pure;
 * deterministic (score desc, then id asc); never throws.
 */
export function fuseCapabilitySeeds(
	lists: readonly RankedCapabilityList[],
	options: SeedFusionOptions = {},
): SeedFusionResult {
	if (options.enabled !== true) {
		return { mode: "observe", enabled: false, candidates: [] };
	}

	try {
		const k = positiveIntOr(options.rankConstant, DEFAULT_RANK_CONSTANT);
		const weights = { ...DEFAULT_SOURCE_WEIGHTS, ...(options.sourceWeights ?? {}) };
		const rankWindow = positiveIntOr(options.rankWindow, Number.POSITIVE_INFINITY);

		const byId = new Map<string, MutableCandidate>();

		for (const list of lists ?? []) {
			if (!list || !KNOWN_SOURCES.has(list.source) || !Array.isArray(list.items)) {
				continue;
			}
			const weight = Number.isFinite(weights[list.source]) ? weights[list.source] : 1;
			const needId = isNonEmptyString(list.needId) ? list.needId : undefined;

			const seenInList = new Set<string>();
			let rank = 0;
			for (const rawId of list.items) {
				if (!isNonEmptyString(rawId)) continue;
				if (seenInList.has(rawId)) continue;
				seenInList.add(rawId);
				rank += 1;
				if (rank > rankWindow) break;

				const contribution = weight / (k + rank);
				let candidate = byId.get(rawId);
				if (!candidate) {
					candidate = {
						capabilityId: rawId,
						rrfScore: 0,
						contributions: [],
						sources: new Set(),
						needIds: new Set(),
					};
					byId.set(rawId, candidate);
				}

				candidate.rrfScore += contribution;
				candidate.contributions.push({
					source: list.source,
					rank,
					weight,
					contribution,
				});
				candidate.sources.add(list.source);
				if (needId) candidate.needIds.add(needId);
			}
		}

		// Apply historical outcome feedback boost if present.
		if (options.outcomeFeedback && byId.size > 0) {
			const feedback = options.outcomeFeedback;
			const candidateIds = Array.from(byId.keys());

			for (const candidate of byId.values()) {
				const fb = feedback[candidate.capabilityId];
				if (!fb) continue;

				const confidence = Math.min(1, fb.totalUses / 10);
				const rateBoost = 1 + 0.25 * (fb.successRate - 0.5) * confidence;
				candidate.rrfScore *= rateBoost;

				if (fb.coOccurrenceBonus) {
					for (const otherId of candidateIds) {
						if (otherId === candidate.capabilityId) continue;
						const coBonus = fb.coOccurrenceBonus[otherId];
						if (typeof coBonus === "number" && Number.isFinite(coBonus)) {
							candidate.rrfScore += 0.02 * coBonus * confidence;
						}
					}
				}
			}
		}

		const candidates: FusedSeedCandidate[] = Array.from(byId.values())
			.map(c => {
				const sources = Array.from(c.sources);
				const needIds = Array.from(c.needIds);
				return {
					capabilityId: c.capabilityId,
					rrfScore: c.rrfScore,
					contributions: c.contributions,
					sources,
					needIds,
					appearedInSources: sources.length,
					matchedNeedIds: needIds,
				};
			})
			.sort((a, b) => {
				if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
				return a.capabilityId.localeCompare(b.capabilityId);
			});

		const topK = positiveIntOr(options.topK, Number.POSITIVE_INFINITY);
		return {
			mode: "observe",
			enabled: true,
			candidates: candidates.slice(0, topK),
		};
	} catch {
		return { mode: "observe", enabled: false, candidates: [] };
	}
}

/** Convenience projection: fused candidate ids only, best-first. */
export function toSeedIds(lists: readonly RankedCapabilityList[], options: SeedFusionOptions = {}): string[] {
	return fuseCapabilitySeeds(lists, options).candidates.map(c => c.capabilityId);
}

/** Human-readable explanation of a fused candidate. Pure; fail-safe to "". */
export function formatSeedExplanation(candidate: FusedSeedCandidate): string {
	if (!candidate?.capabilityId) return "";
	const parts: string[] = [`Capability: ${candidate.capabilityId} (RRF score: ${candidate.rrfScore.toFixed(4)})`];
	if (candidate.contributions.length > 0) {
		const contribs = candidate.contributions.map(c => `${c.source} rank ${c.rank}`).join(", ");
		parts.push(`Sources: ${contribs}`);
	}
	if (candidate.needIds.length > 0) {
		parts.push(`Covers needs: ${candidate.needIds.join(", ")}`);
	}
	return parts.join("\n");
}
