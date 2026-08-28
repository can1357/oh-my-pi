/**
 * Practical Reciprocal Rank Fusion (RRF) & Quality-Adjusted Diversity Selection
 *
 * Implements heterogeneous lane ranking fusion using candidate rank positions
 * rather than raw scores, followed by multiplicative quality adjustments and
 * coverage-aware diversity selection.
 *
 * Rank-based fusion is used because lanes score on incomparable scales: a
 * lexical lane emits BM25-style magnitudes, a graph lane emits centrality, and
 * a temporal lane emits recency decay. Ranks are the only commensurable signal.
 */

/**
 * Lifecycle state of a memory record.
 *
 * Ordering is meaningful: `active` records are fully trusted, `candidate`
 * records are still being corroborated, and the terminal states
 * (`quarantined`, `tombstoned`) are retained for auditability but contribute
 * nothing to ranking.
 */
export type MemoryRecordStatus =
	| "candidate"
	| "active"
	| "stale"
	| "contradicted"
	| "superseded"
	| "archived"
	| "quarantined"
	| "tombstoned";

/**
 * Provenance of a memory record, strongest evidence first.
 *
 * This is the dominant quality signal: a claim the user confirmed outranks one
 * the model merely proposed, regardless of retrieval rank.
 */
export type MemoryVerificationLevel =
	| "user-confirmed"
	| "test-observed"
	| "source-extracted"
	| "tool-observed"
	| "episode-derived"
	| "model-proposed";

export type MemoryLane = "canonical" | "memvid-lexical" | "memvid-temporal" | "graphify" | "mempalace";

export type ContextTier = "L0" | "L1" | "L2" | "L3" | "L4";

/**
 * Memory Relationship Types
 *
 * The same information may appear under different IDs:
 *   - Identity equivalence: same underlying claim, fusible as one candidate.
 *   - Evidence relationship: one record supports another, keep separate but link.
 */
export type MemoryRelationshipKind =
	| "supports"
	| "derived-from"
	| "contradicts"
	| "supersedes"
	| "validates"
	| "related-to";

export interface MemoryRelationship {
	sourceMemoryId: string;
	targetMemoryId: string;
	relationship: MemoryRelationshipKind;
}

/**
 * Identity key for collapsing duplicate records into a single fused candidate.
 * Two records are identity-equivalent when any of these fields match.
 */
export interface IdentityEquivalenceKey {
	canonicalMemoryId?: string;
	contentHash?: string;
	evidenceReferenceId?: string;
	normalizedTriple?: string;
}

/** True when two identity keys share any durable equivalence field. */
export function isIdentityEquivalent(a: IdentityEquivalenceKey, b: IdentityEquivalenceKey): boolean {
	if (
		a.canonicalMemoryId !== undefined &&
		b.canonicalMemoryId !== undefined &&
		a.canonicalMemoryId === b.canonicalMemoryId
	) {
		return true;
	}
	if (a.contentHash !== undefined && b.contentHash !== undefined && a.contentHash === b.contentHash) {
		return true;
	}
	if (
		a.evidenceReferenceId !== undefined &&
		b.evidenceReferenceId !== undefined &&
		a.evidenceReferenceId === b.evidenceReferenceId
	) {
		return true;
	}
	return (
		a.normalizedTriple !== undefined && b.normalizedTriple !== undefined && a.normalizedTriple === b.normalizedTriple
	);
}

/**
 * Classify the relationship between two ranked records.
 * Returns whether they should be fused, kept-but-linked, or kept separate.
 */
export function classifyMemoryRelationship(
	a: RankedMemoryItem,
	b: RankedMemoryItem,
): "identity-equivalent" | "evidence-related" | "unrelated" {
	const identityKey = isIdentityEquivalent(
		{ canonicalMemoryId: a.memoryId, contentHash: a.contentHash },
		{ canonicalMemoryId: b.memoryId, contentHash: b.contentHash },
	);
	if (identityKey) return "identity-equivalent";
	if (a.contentHash === b.contentHash) return "identity-equivalent";
	if (a.sourceReferences.some(ref => b.sourceReferences.includes(ref))) {
		return "evidence-related";
	}
	return "unrelated";
}

/**
 * Detect semantic duplicates (high overlap with already-loaded records).
 * Caller passes the loaded set; the function returns true when the candidate
 * already appears in identity-equivalent form or has matching source evidence.
 */
export function isAlreadyLoaded(
	candidate: RankedMemoryItem,
	loadedIds: ReadonlySet<string>,
	loadedContentHashes: ReadonlySet<string>,
): boolean {
	if (loadedIds.has(candidate.memoryId)) return true;
	if (candidate.contentHash && loadedContentHashes.has(candidate.contentHash)) return true;
	for (const ref of candidate.sourceReferences) {
		if (loadedIds.has(ref)) return true;
	}
	return false;
}

export interface RankedMemoryItem {
	memoryId: string;
	lane: MemoryLane;
	rank: number;

	rawScore?: number;
	contentHash: string;

	type:
		| "continuity"
		| "constraint"
		| "decision"
		| "fact"
		| "procedure"
		| "failure"
		| "graph-path"
		| "episode"
		| "evidence";

	tier: ContextTier;

	projectId: string;
	branchId?: string;
	worktreeId?: string;
	taskId?: string;
	agentId?: string;
	sessionId?: string;

	verification: MemoryVerificationLevel;
	status: MemoryRecordStatus;

	relevance: number;
	freshness: number;
	confidence: number;
	usefulness: number;
	scopeScore: number;
	tokenEstimate: number;

	sourceReferences: string[];
	content: string;
}

export interface RankedList {
	lane: MemoryLane;
	items: RankedMemoryItem[];
}

export interface LaneContribution {
	lane: MemoryLane;
	rank: number;
	weight: number;
	contribution: number;
}

export interface FusedMemoryItem {
	memoryId: string;
	candidate: RankedMemoryItem;

	rrfScore: number;
	finalScore: number;

	laneContributions: LaneContribution[];
	appearedInLanes: number;
}

export interface RRFOptions {
	rankConstant: number;
	laneWeights?: Partial<Record<MemoryLane, number>>;
}

export const DEFAULT_RRF_CONFIG = {
	rankConstant: 60,
	rankWindowPerLane: 30,
	laneWeights: {
		canonical: 1.0,
		"memvid-lexical": 1.0,
		"memvid-temporal": 0.85,
		graphify: 1.0,
		mempalace: 0.9,
	} satisfies Record<MemoryLane, number>,
} as const;

/**
 * Fuse heterogeneous ranked lists using Reciprocal Rank Fusion (RRF).
 * Formula: RRF(d) = sum( w_r / (k + rank_r(d)) )
 */
export function fuseWithRrf(lists: RankedList[], options: Partial<RRFOptions> = {}): FusedMemoryItem[] {
	const k = options.rankConstant ?? DEFAULT_RRF_CONFIG.rankConstant;
	const weights = { ...DEFAULT_RRF_CONFIG.laneWeights, ...options.laneWeights };
	const byId = new Map<string, FusedMemoryItem>();

	for (const list of lists) {
		const laneWeight = weights[list.lane] ?? 1.0;

		list.items.forEach((item, index) => {
			const rank = index + 1;
			const contribution = laneWeight / (k + rank);
			const existing = byId.get(item.memoryId);

			if (existing) {
				existing.rrfScore += contribution;
				existing.appearedInLanes += 1;
				existing.laneContributions.push({
					lane: list.lane,
					rank,
					weight: laneWeight,
					contribution,
				});
				existing.candidate = choosePreferredVersion(existing.candidate, item);
			} else {
				byId.set(item.memoryId, {
					memoryId: item.memoryId,
					candidate: item,
					rrfScore: contribution,
					finalScore: contribution,
					appearedInLanes: 1,
					laneContributions: [
						{
							lane: list.lane,
							rank,
							weight: laneWeight,
							contribution,
						},
					],
				});
			}
		});
	}

	return [...byId.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Select preferred record version when same memory ID appears in multiple lanes.
 * Prefers higher verification confidence and completeness.
 */
export function choosePreferredVersion(a: RankedMemoryItem, b: RankedMemoryItem): RankedMemoryItem {
	const weightA = getVerificationWeight(a.verification);
	const weightB = getVerificationWeight(b.verification);
	if (weightA !== weightB) {
		return weightA > weightB ? a : b;
	}
	return a.content.length >= b.content.length ? a : b;
}

/**
 * Verification quality weight mapping.
 */
export function getVerificationWeight(verification: MemoryVerificationLevel): number {
	switch (verification) {
		case "user-confirmed":
			return 1.15;
		case "test-observed":
			return 1.12;
		case "source-extracted":
			return 1.1;
		case "tool-observed":
			return 1.05;
		case "episode-derived":
			return 0.95;
		case "model-proposed":
			return 0.75;
		default:
			return 1.0;
	}
}

/**
 * Status weight mapping.
 */
export function getStatusWeight(status: MemoryRecordStatus): number {
	switch (status) {
		case "active":
			return 1.0;
		case "candidate":
			return 0.75;
		case "stale":
			return 0.45;
		case "archived":
			return 0.25;
		case "contradicted":
			return 0.2;
		case "superseded":
			return 0.1;
		case "quarantined":
		case "tombstoned":
			return 0.0;
		default:
			return 0.5;
	}
}

/**
 * Apply multiplicative quality adjustments after RRF fusion.
 * Final = RRF * verification * scope * freshness * confidence * usefulness * status * agreementBoost
 */
export function applyQualityAdjustment(item: FusedMemoryItem): FusedMemoryItem {
	const c = item.candidate;

	const verificationFactor = getVerificationWeight(c.verification);
	const scopeFactor = Math.max(0, Math.min(1, c.scopeScore));
	const freshnessFactor = 0.5 + 0.5 * Math.max(0, Math.min(1, c.freshness));
	const confidenceFactor = 0.6 + 0.4 * Math.max(0, Math.min(1, c.confidence));
	const usefulnessFactor = 0.8 + 0.2 * Math.max(0, Math.min(1, c.usefulness));
	const statusFactor = getStatusWeight(c.status);
	const agreementBoost = Math.min(1.15, 1 + 0.04 * (item.appearedInLanes - 1));

	const finalScore =
		item.rrfScore *
		verificationFactor *
		scopeFactor *
		freshnessFactor *
		confidenceFactor *
		usefulnessFactor *
		statusFactor *
		agreementBoost;

	return {
		...item,
		finalScore,
	};
}

export interface SelectionNeed {
	type: string;
	required: boolean;
	priority: number;
	satisfiedBy?: string[];
}

/**
 * Coverage-aware greedy selection after RRF fusion and quality scoring.
 * Maximizes Value = finalScore + 0.25 * coverageGain - 0.20 * redundancyPenalty.
 */
export function selectWithCoverage(
	ranked: FusedMemoryItem[],
	needs: SelectionNeed[],
	maximumItems: number,
	maximumTokens: number,
): FusedMemoryItem[] {
	const selected: FusedMemoryItem[] = [];
	const selectedHashes = new Set<string>();
	const satisfiedNeeds = new Set<string>();
	let usedTokens = 0;

	while (selected.length < maximumItems) {
		let best: { item: FusedMemoryItem; value: number } | undefined;

		for (const item of ranked) {
			if (selected.some(s => s.memoryId === item.memoryId)) {
				continue;
			}
			if (selectedHashes.has(item.candidate.contentHash)) {
				continue;
			}
			if (usedTokens + item.candidate.tokenEstimate > maximumTokens) {
				continue;
			}

			const newlySatisfied = needs.filter(need => !satisfiedNeeds.has(need.type) && itemSatisfiesNeed(item, need));
			const coverageGain = newlySatisfied.reduce((sum, n) => sum + n.priority, 0);
			const redundancyPenalty = calculateRedundancyPenalty(item, selected);

			const value = item.finalScore + 0.25 * coverageGain - 0.2 * redundancyPenalty;

			if (!best || value > best.value) {
				best = { item, value };
			}
		}

		if (!best) {
			break;
		}

		const chosen = best.item;
		selected.push(chosen);
		selectedHashes.add(chosen.candidate.contentHash);
		usedTokens += chosen.candidate.tokenEstimate;

		for (const need of needs) {
			if (itemSatisfiesNeed(chosen, need)) {
				satisfiedNeeds.add(need.type);
			}
		}
	}

	return selected;
}

/**
 * Check if a fused item satisfies an information need.
 */
export function itemSatisfiesNeed(item: FusedMemoryItem, need: SelectionNeed): boolean {
	const c = item.candidate;
	if (need.satisfiedBy?.length) {
		return need.satisfiedBy.includes(c.memoryId);
	}
	const typeMatch = c.type.toLowerCase().includes(need.type.toLowerCase());
	const contentMatch = c.content.toLowerCase().includes(need.type.toLowerCase());
	return typeMatch || contentMatch;
}

/**
 * Calculate redundancy penalty based on content overlap with already selected items.
 */
export function calculateRedundancyPenalty(candidate: FusedMemoryItem, selected: FusedMemoryItem[]): number {
	if (selected.length === 0) return 0;
	let maxOverlap = 0;
	const candContent = candidate.candidate.content.toLowerCase();

	for (const s of selected) {
		const selContent = s.candidate.content.toLowerCase();
		if (candContent === selContent) return 1.0;
		if (candidate.candidate.type === s.candidate.type) {
			maxOverlap = Math.max(maxOverlap, 0.4);
		}
	}

	return maxOverlap;
}

/**
 * Format RRF explanation for diagnostic commands.
 */
export function formatRRFExplanation(fusedItem: FusedMemoryItem): string {
	const c = fusedItem.candidate;
	const lines = [
		`Memory: ${fusedItem.memoryId}`,
		`RRF score: ${fusedItem.rrfScore.toFixed(4)}`,
		`Final score: ${fusedItem.finalScore.toFixed(4)}`,
		`Appeared in ${fusedItem.appearedInLanes} lane(s):`,
	];

	for (const contrib of fusedItem.laneContributions) {
		lines.push(
			`  - ${contrib.lane} rank ${contrib.rank} (weight ${contrib.weight}): +${contrib.contribution.toFixed(5)}`,
		);
	}

	lines.push("Quality factors:");
	lines.push(`  - scope: ${c.scopeScore.toFixed(2)}`);
	lines.push(`  - verification: ${getVerificationWeight(c.verification).toFixed(2)} (${c.verification})`);
	lines.push(`  - freshness: ${c.freshness.toFixed(2)}`);
	lines.push(`  - usefulness: ${c.usefulness.toFixed(2)}`);
	lines.push(`  - status: ${getStatusWeight(c.status).toFixed(2)} (${c.status})`);

	return lines.join("\n");
}
