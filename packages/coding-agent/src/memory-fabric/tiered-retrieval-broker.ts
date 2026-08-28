/**
 * Tiered Retrieval Broker
 *
 * Fans a retrieval request across the registered storage lanes, then applies
 * deduplication, eligibility filtering, reciprocal rank fusion, and quality
 * ranking to produce one ordered candidate list.
 *
 * A lane that fails or exceeds its deadline degrades to an empty result with a
 * recorded error; it never fails the batch.
 */

import {
	calculateScopeScore,
	candidateMatchesTier,
	deduplicateCandidates,
	isStatusEligible,
	selectMemoryLanes,
} from "./lane-selection";
import type {
	CandidateVerification,
	ContextTier,
	LaneHealth,
	LaneRetrievalResult,
	MemoryLane,
	MemoryLaneAdapter,
	RetrievedMemoryCandidate,
	TieredRetrievalConfig,
	TieredRetrievalOptions,
	TieredRetrievalRequest,
	TieredRetrievalResult,
} from "./tiered-retrieval-types";
import { DEFAULT_TIERED_RETRIEVAL_CONFIG } from "./tiered-retrieval-types";

export class TieredRetrievalBroker {
	readonly #adapters = new Map<MemoryLane, MemoryLaneAdapter>();
	readonly #config: TieredRetrievalConfig;

	constructor(config?: Partial<TieredRetrievalConfig>) {
		this.#config = { ...DEFAULT_TIERED_RETRIEVAL_CONFIG, ...config };
	}

	registerAdapter(adapter: MemoryLaneAdapter): void {
		this.#adapters.set(adapter.id, adapter);
	}

	unregisterAdapter(laneId: MemoryLane): void {
		this.#adapters.delete(laneId);
	}

	getAdapter(laneId: MemoryLane): MemoryLaneAdapter | undefined {
		return this.#adapters.get(laneId);
	}

	getRegisteredLanes(): MemoryLane[] {
		return [...this.#adapters.keys()];
	}

	/** Main retrieval entry point. */
	async retrieve(request: TieredRetrievalRequest, options: TieredRetrievalOptions): Promise<TieredRetrievalResult> {
		const startTime = Date.now();

		// 1. Deterministic lane selection, narrowed to lanes we can actually query.
		const lanes: MemoryLaneAdapter[] = [];
		for (const laneId of selectMemoryLanes(request)) {
			const adapter = this.#adapters.get(laneId);
			if (adapter) lanes.push(adapter);
		}

		// 2. Query every lane in parallel.
		const laneResults = await Promise.all(lanes.map(lane => this.#queryLane(lane, request, options)));

		// 3. Collect. `lanesQueried` records what was asked, not what answered, so
		//    a lane that returned nothing is still distinguishable from one that
		//    was never consulted.
		const lanesQueried = lanes.map(lane => lane.id);
		const laneLatencies: Partial<Record<MemoryLane, number>> = {};
		const laneErrors: Partial<Record<MemoryLane, string>> = {};
		const allCandidates: RetrievedMemoryCandidate[] = [];

		for (const result of laneResults) {
			laneLatencies[result.laneId] = result.latencyMs;
			if (result.error !== undefined) laneErrors[result.laneId] = result.error;
			allCandidates.push(...result.candidates);
		}

		// 4. Tier filter, deduplicate, then eligibility.
		const excluded = new Set(request.excludeMemoryIds ?? []);
		const eligibility = {
			includeProvisional: options.includeProvisional,
			includeHistorical: request.includeHistorical ?? false,
			requestedTiers: request.requestedTiers,
		};
		const tierMatched = allCandidates.filter(candidate => candidateMatchesTier(candidate, request.requestedTiers));
		const eligible = deduplicateCandidates(tierMatched).filter(candidate => {
			if (excluded.has(candidate.memoryId)) return false;
			if (candidate.confidence < options.minConfidence) return false;
			return isStatusEligible(candidate, eligibility);
		});

		// 5. Fuse and rank, then apply the total cap.
		const ranked = this.postProcess(eligible, request);
		const limit = request.maximumTotalCandidates ?? this.#config.maximumTotalCandidates;
		const finalCandidates = ranked.slice(0, limit);

		return {
			candidates: finalCandidates,
			lanesQueried,
			laneLatencies,
			laneErrors,
			totalTimeMs: Date.now() - startTime,
			stats: {
				totalCandidates: finalCandidates.length,
				byLane: countBy(finalCandidates, candidate => candidate.lane),
				byTier: countBy(finalCandidates, candidate => candidate.tier),
			},
		};
	}

	/**
	 * Query one lane under a deadline.
	 *
	 * The timeout handle is always cleared. An uncleared timer keeps the event
	 * loop alive for the remainder of the deadline after the answer is already
	 * known, which turns every fast lane into a `deadlineMs` stall.
	 */
	async #queryLane(
		lane: MemoryLaneAdapter,
		request: TieredRetrievalRequest,
		options: TieredRetrievalOptions,
	): Promise<LaneRetrievalResult> {
		const laneStart = Date.now();
		let timer: Timer | undefined;

		try {
			const { promise: deadline, reject } = Promise.withResolvers<never>();
			timer = setTimeout(() => reject(new Error(`Lane timeout: ${lane.id}`)), options.deadlineMs);
			const candidates = await Promise.race([lane.retrieve(request, options), deadline]);

			return {
				laneId: lane.id,
				candidates: candidates.slice(0, options.maximumCandidatesPerLane),
				latencyMs: Date.now() - laneStart,
			};
		} catch (error) {
			return {
				laneId: lane.id,
				candidates: [],
				latencyMs: Date.now() - laneStart,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * Fuse per-lane rankings and apply multiplicative quality adjustments.
	 *
	 * Returns a new array of new objects: neither the input array nor its
	 * elements are mutated, so a caller can rank the same candidates under
	 * different requests.
	 */
	postProcess(candidates: RetrievedMemoryCandidate[], request: TieredRetrievalRequest): RetrievedMemoryCandidate[] {
		if (candidates.length === 0) return [];

		const fused = this.reciprocalRankFusion(this.#groupByLane(candidates), this.#config.rrfK);

		const scored = candidates.map(candidate => {
			const scopeScore = calculateScopeScore(candidate, request.scope);
			const fusedScore = fused.get(candidate.memoryId) ?? 0;

			let score = fusedScore;
			score *= scopeScore;
			score *= 0.5 + 0.5 * candidate.freshness;
			score *= verificationMultiplier(candidate.verification);
			score *= 0.5 + 0.5 * candidate.usefulness;
			score *= tierRelevance(candidate.tier, request.requestedTiers);

			// Status penalties. `model-proposed` is not penalised again here: it is
			// already the lowest verification multiplier, and an earlier revision
			// applied both, charging the same signal twice.
			if (candidate.status === "superseded") score *= 0.5;
			if (candidate.status === "archived") score *= 0.3;
			if (candidate.status === "contradicted") score *= 0.2;

			return {
				...candidate,
				scopeScore,
				fusedScore,
				finalScore: Math.max(0, Math.min(1, score)),
			};
		});

		return scored.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
	}

	/** Group candidates into one ranked list per lane. */
	#groupByLane(candidates: RetrievedMemoryCandidate[]): RetrievedMemoryCandidate[][] {
		const byLane = new Map<MemoryLane, RetrievedMemoryCandidate[]>();

		for (const candidate of candidates) {
			const bucket = byLane.get(candidate.lane);
			if (bucket) bucket.push(candidate);
			else byLane.set(candidate.lane, [candidate]);
		}

		return [...byLane.values()];
	}

	/**
	 * Reciprocal Rank Fusion: RRF(d) = sum over lanes of 1 / (k + rank(d)).
	 *
	 * Rank-based rather than score-based because lanes score on incomparable
	 * scales -- BM25 magnitudes, graph centrality, recency decay.
	 */
	reciprocalRankFusion(
		rankedLists: RetrievedMemoryCandidate[][],
		k: number = DEFAULT_TIERED_RETRIEVAL_CONFIG.rrfK,
	): Map<string, number> {
		const scores = new Map<string, number>();

		for (const list of rankedLists) {
			for (const [index, candidate] of list.entries()) {
				const rank = index + 1;
				const previous = scores.get(candidate.memoryId) ?? 0;
				scores.set(candidate.memoryId, previous + 1 / (k + rank));
			}
		}

		return scores;
	}

	/** Probe every registered lane in parallel. A throwing lane reports unhealthy. */
	async healthCheck(): Promise<Partial<Record<MemoryLane, LaneHealth>>> {
		const lanes = [...this.#adapters.entries()];
		const probes = lanes.map(async ([laneId, adapter]): Promise<[MemoryLane, LaneHealth]> => {
			try {
				return [laneId, await adapter.healthCheck()];
			} catch {
				return [laneId, { healthy: false, latencyMs: -1 }];
			}
		});

		const entries = await Promise.all(probes);
		return Object.fromEntries(entries) as Partial<Record<MemoryLane, LaneHealth>>;
	}
}

/**
 * Partition ranked candidates so continuity tiers lead, then explicitly
 * requested tiers, each group preserving its score order.
 *
 * This is lossy: candidates in neither group are dropped. It is exported
 * separately rather than folded into `postProcess` so that callers choose
 * whether to pay that cost, instead of silently losing candidates they ranked.
 */
export function selectTierAware(
	candidates: RetrievedMemoryCandidate[],
	requestedTiers: ContextTier[],
): RetrievedMemoryCandidate[] {
	const core: RetrievedMemoryCandidate[] = [];
	const requested: RetrievedMemoryCandidate[] = [];

	for (const candidate of candidates) {
		if (candidate.tier === "L0" || candidate.tier === "L1") core.push(candidate);
		else if (requestedTiers.includes(candidate.tier)) requested.push(candidate);
	}

	return [...core, ...requested];
}

/** Verification quality multiplier, strongest evidence first. */
export function verificationMultiplier(verification: CandidateVerification): number {
	switch (verification) {
		case "user-confirmed":
			return 1.0;
		case "test-observed":
			return 0.9;
		case "source-extracted":
			return 0.85;
		case "tool-observed":
			return 0.8;
		case "episode-derived":
			return 0.7;
		case "model-proposed":
			return 0.5;
	}
}

/**
 * Tier relevance multiplier.
 *
 * L0 continuity and L1 active truth are never down-weighted -- losing them
 * costs the agent its place in the task. Deeper tiers count only when asked for.
 */
export function tierRelevance(tier: ContextTier, requestedTiers: ContextTier[]): number {
	if (tier === "L0" || tier === "L1") return 1.0;
	if (!requestedTiers.includes(tier)) return 0.5;

	switch (tier) {
		case "L2":
			return 0.9;
		case "L3":
			return 0.8;
		case "L4":
			return 0.7;
	}
}

function countBy<T, K extends string>(items: T[], key: (item: T) => K): Partial<Record<K, number>> {
	const counts: Partial<Record<K, number>> = {};

	for (const item of items) {
		const bucket = key(item);
		counts[bucket] = (counts[bucket] ?? 0) + 1;
	}

	return counts;
}
