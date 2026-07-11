/**
 * Shared type definitions consumed by both the server-side stats code and the
 * standalone client bundle. Keep this file free of any imports from server-only
 * packages (e.g. `@pk-nerdsaver-ai/pi-ai`, `bun:sqlite`) so the client can import it
 * without dragging server dependencies into its bundle.
 */

/**
 * Aggregated stats for a model or folder.
 */
export interface AggregatedStats {
	/** Total number of requests */
	totalRequests: number;
	/** Number of successful requests */
	successfulRequests: number;
	/** Number of failed requests */
	failedRequests: number;
	/** Error rate (0-1) */
	errorRate: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
	/** Total cache read tokens */
	totalCacheReadTokens: number;
	/** Total cache write tokens */
	totalCacheWriteTokens: number;
	/** Cache hit rate (0-1) */
	cacheRate: number;
	/** Total cost */
	totalCost: number;
	/** Total premium requests */
	totalPremiumRequests: number;
	/** Average duration in ms */
	avgDuration: number | null;
	/** Average TTFT in ms */
	avgTtft: number | null;
	/** Average tokens per second (output tokens / duration) */
	avgTokensPerSecond: number | null;
	/** Time range */
	firstTimestamp: number;
	lastTimestamp: number;
}

/**
 * Stats grouped by model.
 */
export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

/**
 * Stats grouped by folder.
 */
export interface FolderStats extends AggregatedStats {
	folder: string;
}

/**
 * Time series data point.
 */
export interface TimeSeriesPoint {
	/** Bucket timestamp (start of hour/day) */
	timestamp: number;
	/** Request count */
	requests: number;
	/** Error count */
	errors: number;
	/** Total tokens */
	tokens: number;
	/** Total cost */
	cost: number;
}

/**
 * Model usage time series data point (daily buckets).
 */
export interface ModelTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Request count */
	requests: number;
}

/**
 * Model performance time series data point (daily buckets).
 */
export interface ModelPerformancePoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Request count */
	requests: number;
	/** Average TTFT in ms */
	avgTtft: number | null;
	/** Average tokens per second */
	avgTokensPerSecond: number | null;
}

/**
 * Cost time series data point (daily buckets).
 */
export interface CostTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Model name */
	model: string;
	/** Provider name */
	provider: string;
	/** Total cost for this bucket */
	cost: number;
	/** Cost breakdown */
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	/** Request count */
	requests: number;
}

/**
 * Overall dashboard stats.
 */
export interface DashboardStats {
	overall: AggregatedStats;
	byModel: ModelStats[];
	byFolder: FolderStats[];
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
	costSeries: CostTimeSeriesPoint[];
}

/**
 * Which agent produced a message, derived from its transcript file location
 * inside the session directory: the top-level `<project>/<file>.jsonl` is the
 * `main` agent, an `__advisor.jsonl` is the passive `advisor`, and any other
 * nested transcript is a task `subagent`.
 */
export type AgentType = "main" | "subagent" | "advisor";

/**
 * Token usage aggregated by {@link AgentType} over the active range. Token
 * columns are explicit so the dashboard's share denominator matches the
 * counts it renders (input + output + cache read + cache write).
 */
export interface AgentTypeStats {
	agentType: AgentType;
	/** Total number of requests */
	totalRequests: number;
	/** Total input tokens */
	totalInputTokens: number;
	/** Total output tokens */
	totalOutputTokens: number;
	/** Total cache read tokens */
	totalCacheReadTokens: number;
	/** Total cache write tokens */
	totalCacheWriteTokens: number;
	/** Total cost */
	totalCost: number;
}

/**
 * Behavior time-series point (daily bucket, per responding model).
 */
export interface BehaviorTimeSeriesPoint {
	/** Bucket timestamp (start of day) */
	timestamp: number;
	/** Responding model ("unknown" if user msg never got a reply) */
	model: string;
	/** Responding provider */
	provider: string;
	/** Number of user messages in bucket */
	messages: number;
	/** Total yelling sentences in bucket */
	yelling: number;
	/** Total profanity hits in bucket */
	profanity: number;
	/** Total anguish signal in bucket */
	anguish: number;
	/** Total corrective-negation hits in bucket */
	negation: number;
	/** Total user-repeating-themselves hits in bucket */
	repetition: number;
	/** Total second-person blame hits in bucket */
	blame: number;
	/** Total characters in bucket */
	chars: number;
}

export interface BehaviorOverallStats {
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
	firstTimestamp: number;
	lastTimestamp: number;
}

/**
 * Per-model behavioral aggregate over the active range.
 */
export interface BehaviorModelStats {
	model: string;
	provider: string;
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
	lastTimestamp: number;
}

export interface BehaviorDashboardStats {
	overall: BehaviorOverallStats;
	byModel: BehaviorModelStats[];
	behaviorSeries: BehaviorTimeSeriesPoint[];
}

/** Token savings from a single source type. */
export interface GainSourceTotals {
	savedTokens: number;
	savedBytes: number;
	hits: number;
	/** originalBytes - savedBytes, when original is known */
	outputBytes: number;
	/** Total original bytes before compression, when known */
	originalBytes: number;
	/** savedBytes / originalBytes when both are known, else null */
	reductionPercent: number | null;
}

/** Per-source breakdown. */
export type GainSource = "snapcompact";

/** Time-series point for gain (daily bucket). */
export interface GainTimeSeriesPoint {
	date: string;
	snapcompact: number;
	total: number;
}

/** Complete gain dashboard payload. */
export interface GainDashboardStats {
	/** Aggregate across all sources for the active range. */
	overall: GainSourceTotals;
	/** Per-source breakdown. */
	bySource: Record<GainSource, GainSourceTotals>;
	/** Daily time series. */
	timeSeries: GainTimeSeriesPoint[];
	/** Active project filter (cwd prefix), or null for all projects. */
	project: string | null;
	/** All distinct projects seen in the data, for the selector. */
	projects: string[];
}
