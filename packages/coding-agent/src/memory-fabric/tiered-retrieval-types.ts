/**
 * Tiered Retrieval Types
 *
 * Contracts for tiered memory retrieval: storage lanes, context tiers, lane
 * adapters, and the request/result shapes the broker fulfils.
 *
 * Two different "lane" concepts exist in this fabric, and they are deliberately
 * kept as distinct types:
 *
 *   - {@link MemoryLane} is a *storage* lane: where a record physically lives.
 *   - `MemoryLane` in `./rrf-fusion` is a *retrieval* lane: a ranking strategy.
 *     It is imported here under the clearer name {@link RetrievalLane}.
 *
 * One storage lane may be read by several retrieval strategies -- `memvid` is
 * ranked both lexically and temporally. {@link RETRIEVAL_LANE_TO_STORAGE_LANE}
 * is the total mapping between the two, checked exhaustively by the compiler,
 * so the unions cannot drift apart silently.
 */

import type { MemoryLane as RetrievalLane } from "./rrf-fusion";

export type { RetrievalLane };

/**
 * Storage lanes -- where a memory record physically lives.
 */
export type MemoryLane = "working-state" | "canonical" | "memvid" | "graphify" | "mempalace";

/**
 * Lane query priority: most authoritative and cheapest first.
 * `selectMemoryLanes` returns lanes in this order.
 */
export const LANE_PRIORITY_ORDER: readonly MemoryLane[] = [
	"working-state",
	"canonical",
	"graphify",
	"memvid",
	"mempalace",
];

/**
 * Total mapping from a retrieval strategy to the storage lane it reads.
 *
 * Typed as a full `Record`, so adding a retrieval lane in `./rrf-fusion`
 * without deciding where it reads from is a compile error rather than a
 * silent gap.
 */
export const RETRIEVAL_LANE_TO_STORAGE_LANE: Record<RetrievalLane, MemoryLane> = {
	canonical: "canonical",
	graphify: "graphify",
	mempalace: "mempalace",
	"memvid-lexical": "memvid",
	"memvid-temporal": "memvid",
};

/**
 * Context tiers -- how much detail is retrieved and injected.
 *
 * L0 continuity, L1 active truth, L2 procedures and failures, L3 structural
 * and evidential detail, L4 history.
 */
export type ContextTier = "L0" | "L1" | "L2" | "L3" | "L4";

/** Tier order, most to least continuity-critical. */
export const CONTEXT_TIER_ORDER: readonly ContextTier[] = ["L0", "L1", "L2", "L3", "L4"];

/**
 * Historical alias for {@link ContextTier}.
 *
 * The original fabric declared `MemoryTier` and `ContextTier` as two names for
 * the same union; this alias preserves both spellings without duplicating the
 * definition.
 */
export type MemoryTier = ContextTier;

/** Task categories that drive budget and retrieval behaviour. */
export type TaskCategory = "trivial" | "normal" | "debugging" | "architecture" | "recovery" | "repository-wide";

/** Lifecycle state of a retrieved candidate. */
export type CandidateStatus =
	| "candidate"
	| "active"
	| "stale"
	| "contradicted"
	| "superseded"
	| "archived"
	| "quarantined"
	| "tombstoned";

/** Provenance of a retrieved candidate, strongest evidence first. */
export type CandidateVerification =
	| "user-confirmed"
	| "test-observed"
	| "source-extracted"
	| "tool-observed"
	| "episode-derived"
	| "model-proposed";

/**
 * Scope coordinates. Shared by requests and candidates so that scope matching
 * compares like with like.
 */
export interface MemoryScope {
	projectId: string;
	worktreeId?: string;
	branchId?: string;
	sessionId?: string;
	taskId?: string;
	agentId?: string;
}

/** Entities extracted from a query. */
export interface ExtractedEntities {
	files: string[];
	symbols: string[];
	errors: string[];
	taskNames: string[];
	commands: string[];
}

/** A request for tiered retrieval. */
export interface TieredRetrievalRequest {
	query: string;

	/** Task categorisation driving budget and lane choice. */
	taskType: TaskCategory;

	/** Mandatory project, optional worktree/branch/session/task/agent. */
	scope: MemoryScope;

	entities: ExtractedEntities;

	/** Which context tiers are wanted. An empty array means "no tier filter". */
	requestedTiers: ContextTier[];

	/** Lanes to consult in addition to the deterministically selected ones. */
	preferredLanes?: MemoryLane[];

	files?: string[];
	symbols?: string[];
	errorSignatures?: string[];
	topics?: string[];

	/** Overrides the configured total cap when present. */
	maximumTotalCandidates?: number;

	/** Token budget for this retrieval. */
	maximumTokens?: number;

	/** Memory IDs already loaded this turn. */
	excludeMemoryIds?: string[];

	/** Include superseded and archived records. */
	includeHistorical?: boolean;

	/** Include model-proposed records. */
	includeProvisional?: boolean;
}

/**
 * Per-call execution options.
 *
 * These are transport concerns -- deadlines, caps, sensitivity ceiling. Content
 * selection lives on {@link TieredRetrievalRequest}, so `requestedTiers` is
 * deliberately not duplicated here.
 */
export interface TieredRetrievalOptions {
	maximumCandidatesPerLane: number;
	deadlineMs: number;
	minConfidence: number;
	includeProvisional: boolean;
	maxSensitivity: "public" | "project" | "private" | "secret";
}

/** Health of a single lane. */
export interface LaneHealth {
	healthy: boolean;
	latencyMs: number;
}

/** Per-lane adapter contract. Every lane implements this. */
export interface MemoryLaneAdapter {
	id: MemoryLane;
	name: string;

	/** Retrieve candidates from this lane. */
	retrieve(request: TieredRetrievalRequest, options: TieredRetrievalOptions): Promise<RetrievedMemoryCandidate[]>;

	/** Liveness and latency probe. */
	healthCheck(): Promise<LaneHealth>;
}

/** Outcome of querying one lane. Never throws: a failed lane reports `error`. */
export interface LaneRetrievalResult {
	laneId: MemoryLane;
	candidates: RetrievedMemoryCandidate[];
	latencyMs: number;
	error?: string;
}

/** A candidate normalised into a single shape by its lane adapter. */
export interface RetrievedMemoryCandidate {
	memoryId: string;
	lane: MemoryLane;
	tier: ContextTier;

	type: string;
	subject?: string;
	content: string;

	/** Scope the record was written under; drives scope scoring. */
	scope: MemoryScope;

	lexicalScore?: number;
	semanticScore?: number;
	temporalScore?: number;
	graphScore?: number;

	scopeScore: number;
	confidence: number;
	freshness: number;
	usefulness: number;
	importance: number;

	status: CandidateStatus;
	verification: CandidateVerification;

	/** Memory ID that replaces this record, when it has been superseded. */
	supersededBy?: string;

	sourceReferences: string[];
	contentHash: string;
	tokenEstimate: number;

	/** Set by the broker during fusion. Absent until `postProcess` has run. */
	fusedScore?: number;

	/** Set by the broker after quality adjustment. */
	finalScore?: number;
}

/** Complete retrieval result after fusion and ranking. */
export interface TieredRetrievalResult {
	candidates: RetrievedMemoryCandidate[];

	/**
	 * Every lane the broker actually queried, including lanes that returned
	 * nothing or failed -- so a silent lane stays visible to callers.
	 */
	lanesQueried: MemoryLane[];

	laneLatencies: Partial<Record<MemoryLane, number>>;
	laneErrors: Partial<Record<MemoryLane, string>>;
	totalTimeMs: number;

	stats: {
		totalCandidates: number;
		byLane: Partial<Record<MemoryLane, number>>;
		byTier: Partial<Record<ContextTier, number>>;
	};
}

/** Broker configuration. */
export interface TieredRetrievalConfig {
	maximumCandidatesPerLane: number;
	maximumTotalCandidates: number;
	rrfK: number;
}

export const DEFAULT_TIERED_RETRIEVAL_CONFIG: TieredRetrievalConfig = {
	maximumCandidatesPerLane: 30,
	maximumTotalCandidates: 80,
	rrfK: 60,
};

export const DEFAULT_TIERED_RETRIEVAL_OPTIONS: TieredRetrievalOptions = {
	maximumCandidatesPerLane: 30,
	deadlineMs: 250,
	minConfidence: 0,
	includeProvisional: false,
	maxSensitivity: "project",
};

/**
 * Signals that drive progressive expansion decisions.
 *
 * Consumed here by `selectExpansionTiers`; the full expansion engine arrives
 * with a later stage.
 */
export interface ExpansionSignals {
	taskComplexity: number;
	graphImpact: number;
	retrievalConfidence: number;
	retrievalCoverage: number;
	contradictionCount: number;
	unresolvedIssueCount: number;
	repeatedFailureCount: number;
	unfamiliarSymbolCount: number;
	missingProcedureCount: number;
	planBreadth: number;
	currentContextSaturation: number;

	isCrashRecovery: boolean;
	isCompactionRecovery: boolean;
	isExternalWrite: boolean;
	isDestructiveOperation: boolean;
	modelRequestedExpansion: boolean;
	userRequestedHistory: boolean;
}
