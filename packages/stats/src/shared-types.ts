/**
 * Shared type definitions consumed by both the server-side stats code and the
 * standalone client bundle. Keep this file free of any imports from server-only
 * packages (e.g. `@oh-my-pi/pi-ai`, `bun:sqlite`) so the client can import it
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
	/** Percentage of prompt input tokens served from cache (0-1). */
	cacheRate: number;
	/**
	 * Prompt-input cost saved relative to billing the same tokens uncached
	 * (0-1; negative when cache writes cost more than reads save).
	 */
	cacheSavings: number;
	/** Total cost */
	totalCost: number;
	/** Requests with token usage but no public-equivalent subscription price. */
	unpricedRequests: number;
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
	/** Requests excluded because no public-equivalent subscription price exists. */
	unpricedRequests: number;
	/** Cost breakdown */
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	/** Request count */
	requests: number;
}

/**
 * One local calendar day of aggregate request activity, for the `/usage`
 * activity heatmap in the coding-agent TUI.
 */
export interface DailyActivityPoint {
	/** Local calendar date, `YYYY-MM-DD`. */
	day: string;
	/** Summed API-equivalent cost for the day. */
	cost: number;
	/** Request count for the day. */
	requests: number;
	/** Total tokens (input + output + cache) for the day. */
	totalTokens: number;
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
 * Frustration tallies over a set of user messages. Each message counts once,
 * classified by its cached judge verdict when one exists, else by the regex
 * behavior signals stored at ingest (see `frustration.ts` for both rules).
 */
export interface FrustrationCounts {
	/** User messages with non-empty prose. */
	messages: number;
	/** Messages whose prose has a cached judge verdict; the rest use regex fallback. */
	judged: number;
	/** Annoyed at anything (the assistant, tooling, other people, ...). */
	annoyed: number;
	/** Annoyed and aimed at the assistant. Subset of `annoyed`. */
	atAssistant: number;
	/** Aimed at the assistant and hostile/angry. Subset of `atAssistant`. */
	angry: number;
}

/**
 * Frustration tallies for one model version. Provider/spelling variants of the
 * same model (`claude-opus-4.6`, `anthropic/claude-opus-4-6`) merge under one
 * catalog identity.
 */
export interface FrustrationModelStats extends FrustrationCounts {
	/** Stable key: `class/family/revision` when classified, else the raw model id. */
	key: string;
	/** Display label, e.g. `opus 4.5`; the raw model id when unclassified. */
	label: string;
	/** Catalog identity class, e.g. `anthropic`; `unknown` when unclassified. */
	modelClass: string;
	/** Catalog family within the class, e.g. `opus`. */
	family: string | null;
	/** Canonical `major.minor.patch`, e.g. `4.5.0`. */
	revision: string | null;
	/** Raw model ids merged into this row. */
	models: string[];
	/** Earliest message timestamp (ms) in range. */
	firstSeen: number;
}

/** Lifecycle of the dashboard-host judge run that classifies unjudged messages. */
export type FrustrationJobState = "idle" | "running" | "done" | "cancelled" | "failed";

/** Progress of the (single, process-wide) frustration judge run. */
export interface FrustrationJobStatus {
	state: FrustrationJobState;
	/** Unique prose texts queued for judgment. */
	total: number;
	/** Texts judged successfully. */
	done: number;
	/** Texts that exhausted their retries. */
	failed: number;
	/** Accumulated USD cost of every judge attempt, retries included. */
	cost: number;
	/** Judge label (`provider/model`) of the run, when known. */
	judge: string | null;
	/** Why the run failed; null otherwise. */
	error: string | null;
	startedAt: number | null;
	finishedAt: number | null;
	/** Judge requests the run currently keeps in flight (adapts to the judge's rate limits). */
	concurrency: number;
}

/** Payload of `GET /api/stats/frustration`. */
export interface FrustrationDashboardStats {
	overall: FrustrationCounts;
	/** Every model with messages in range, ordered by class, then revision, then family. */
	byModel: FrustrationModelStats[];
	/** Whether this dashboard host can run the judge (standalone `omp-stats` cannot). */
	judgeAvailable: boolean;
	job: FrustrationJobStatus;
}

/** Payload of `GET /api/frustration/estimate`: the pre-run cost quote shown before judging. */
export type FrustrationEstimate =
	| {
			available: true;
			/** Unique unjudged prose texts in range (identical messages share one verdict). */
			messages: number;
			/** Total prose characters sent. */
			chars: number;
			/** Estimated billed input tokens. */
			inputTokens: number;
			/** Estimated USD cost. */
			cost: number;
			/** Judge label (`provider/model`) the run will route to first. */
			judge: string;
	  }
	| { available: false; reason: string };

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

/**
 * Aggregated usage for a single tool over the active range.
 *
 * Token/cost fields are the *real* provider usage of the assistant turns that
 * invoked the tool, split evenly across that turn's tool calls so the numbers
 * stay additive (a turn with 3 calls contributes a third of its usage to each
 * tool). Payload fields (`argsChars`/`resultChars`) are raw character counts
 * of the serialized arguments and the text fed back into context — a size
 * proxy, not provider-counted tokens.
 */
export interface ToolUsageStats {
	/** Tool name as recorded on the tool call. */
	tool: string;
	/** Number of tool calls. */
	calls: number;
	/** Calls whose result came back with `isError`. */
	errors: number;
	/** Serialized tool-call argument characters. */
	argsChars: number;
	/** Text characters of tool results fed back into context. */
	resultChars: number;
	/** Total provider tokens of invoking turns, attributed per call share. */
	totalTokensShare: number;
	/** Output tokens of invoking turns, attributed per call share. */
	outputTokensShare: number;
	/** Cost (USD) of invoking turns, attributed per call share. */
	costShare: number;
	/** Share of unpriced subscription requests attributed to this tool. */
	unpricedRequestsShare: number;
	/** Unix ms of the most recent call in range. */
	lastUsed: number;
}

/** Per-(tool, model) breakdown with the same attribution as {@link ToolUsageStats}. */
export interface ToolModelStats extends ToolUsageStats {
	model: string;
	provider: string;
}

/** Tool-call time-series point (one bucket per tool). */
export interface ToolTimeSeriesPoint {
	timestamp: number;
	tool: string;
	calls: number;
	errors: number;
}

/** Complete tools dashboard payload. */
export interface ToolDashboardStats {
	byTool: ToolUsageStats[];
	byToolModel: ToolModelStats[];
	series: ToolTimeSeriesPoint[];
}

/**
 * Aggregated request/token/cost totals for one provider over the active range.
 */
export interface ProviderAggregate {
	provider: string;
	totalRequests: number;
	failedRequests: number;
	/** Distinct models used through this provider in the range. */
	models: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** Uncached input + cache reads + cache writes + output. */
	totalTokens: number;
	totalCost: number;
	/** Requests excluded because no public-equivalent subscription price exists. */
	unpricedRequests: number;
	totalPremiumRequests: number;
	avgTokensPerSecond: number | null;
}

/**
 * Token burn attributed to one local hour-of-day (0-23) for one provider.
 * Powers the "peak burn hours" histogram.
 */
export interface ProviderHourlyPoint {
	provider: string;
	/** Local hour of day, 0-23. */
	hour: number;
	totalTokens: number;
	outputTokens: number;
	requests: number;
}

/** Provider token/cost time-series point (bucketed like the model series). */
export interface ProviderTimeSeriesPoint {
	timestamp: number;
	provider: string;
	totalTokens: number;
	cost: number;
	/** Requests excluded because no public-equivalent subscription price exists. */
	unpricedRequests: number;
	requests: number;
}

/** One recorded usage-limit snapshot for an (account, window) series. */
export interface UsageWindowPoint {
	timestamp: number;
	/** Used fraction 0..1 (>1 = overage) when the provider reported one. */
	usedFraction: number | null;
	exhausted: boolean;
}

/**
 * Utilization history for one (account, limit window) pair of a provider,
 * sourced from the auth store's recorded usage-limit snapshots.
 */
export interface UsageWindowSeries {
	provider: string;
	accountKey: string;
	/** Email/account id when known, else the stable account key. */
	accountLabel: string;
	/** Groups the same limit window across accounts (the provider limit id). */
	windowKey: string;
	/** Human label of the limit (distinguishes same-duration windows). */
	windowLabel: string;
	points: UsageWindowPoint[];
}

/**
 * Derived subscription insight for one provider limit window across all
 * accounts: how much of the window was consumed, what one window is worth in
 * tokens, and how many accounts peak demand would have needed.
 */
export interface ProviderWindowInsight {
	provider: string;
	/** Groups the same limit window across accounts (the provider limit id). */
	windowKey: string;
	/** Human label of the limit (distinguishes same-duration windows). */
	windowLabel: string;
	/** Accounts with at least one snapshot for this window in range. */
	accounts: number;
	/** Window resets observed (drops in used fraction). */
	cycles: number;
	/**
	 * Subscription-window equivalents consumed in range: sum of positive
	 * used-fraction deltas across accounts (1.0 = one full window burned).
	 */
	fractionConsumed: number;
	/**
	 * Estimated tokens one full window buys: provider tokens burned in range
	 * divided by {@link fractionConsumed}. Null when too little of the window
	 * was consumed to extrapolate.
	 */
	estTokensPerWindow: number | null;
	/** Peak of sum-across-accounts used fraction at any sampled instant. */
	peakConcurrentFraction: number;
	/**
	 * Accounts needed to keep peak demand under 90% of fleet capacity:
	 * max(1, ceil(peakConcurrentFraction / 0.9)).
	 */
	idealAccounts: number;
	/** Transitions into an exhausted state observed in range. */
	exhaustedEvents: number;
}

/** Ingest state of the dashboard host's background session sync. */
export interface LiveSyncStatus {
	phase: "idle" | "syncing" | "error";
	/** Files completed in the running sync (0 when not yet known). */
	current: number;
	/** Files in the running sync's work set (0 while listing → indeterminate). */
	total: number;
	/** Rows inserted by the running (or last) sync. */
	processed: number;
	/** Wall-clock time the last sync finished, if any. */
	lastSyncedAt: number | null;
	/** Failure message of the last sync when `phase` is `"error"`. */
	error: string | null;
}

/**
 * Payload of every `GET /api/events` server-sent event (and `GET /api/status`).
 * `version` increases whenever stored stats may have changed, so clients
 * revalidate their queries when it moves.
 */
export interface LiveStatus {
	version: number;
	sync: LiveSyncStatus;
	/** Hours whose rollups are still being (re)built; ranges covering them may be incomplete. */
	indexingHours: number;
}

/** Providers dashboard payload: local request stats only (fast, DB-backed). */
export interface ProviderDashboardStats {
	providers: ProviderAggregate[];
	hourly: ProviderHourlyPoint[];
	series: ProviderTimeSeriesPoint[];
}

/**
 * Subscription-window payload (`GET /api/stats/provider-windows`). Snapshots
 * may come from the auth broker over the network, so it is fetched separately
 * from {@link ProviderDashboardStats}. `usageSeries` only carries the
 * requested provider's series (empty without a provider) — all of them can be
 * thousands of series.
 */
export interface ProviderWindowStats {
	windowInsights: ProviderWindowInsight[];
	usageSeries: UsageWindowSeries[];
}
/**
 * One row of the Traces session list: a root session with every child
 * transcript (task subagents, advisors) folded in.
 */
export interface SessionSummary {
	/** Absolute root session file path (trace key). */
	file: string;
	/** Decoded project path (e.g. `/work/pi`). */
	folder: string;
	title: string | null;
	/** ms epoch of first activity. */
	startedAt: number;
	/** ms epoch of last activity, children included. */
	endedAt: number;
	/** Assistant messages, children folded in. */
	requests: number;
	toolCalls: number;
	/** Child transcript count. */
	subagents: number;
	totalTokens: number;
	costTotal: number;
	/** Requests whose zero cost is unknown spend (scheduled card, no timestamp). */
	unpricedRequests: number;
	models: string[];
}

export type TraceSpanKind = "turn" | "model" | "tool" | "subagent" | "background";

/** One rendered block on a trace track lane. */
export interface TraceSpan {
	/** `${track.id}:${entryId}` (+`:${toolCallId}` for tool spans); stable across refetch. */
	id: string;
	kind: TraceSpanKind;
	/** ms epoch. */
	start: number;
	/** ms epoch, >= start. */
	end: number;
	/** ≤80 chars: tool name / model id / user-text head / agent name. */
	label: string;
	/** ≤160 chars: args projection / result head / task text. */
	detail?: string;
	/** Journal entry id for /api/session/entry. */
	entryId?: string;
	toolCallId?: string;
	model?: string;
	/** usage.totalTokens (model spans). */
	tokens?: number;
	/** usage.cost.total (model spans). */
	cost?: number;
	/** Time to first token, ms offset from start. */
	ttft?: number;
	isError?: boolean;
	/** End synthesized (no result / pending at session exit). */
	unterminated?: boolean;
	/** Set on `subagent` spans whose child transcript became a track. */
	childTrackId?: string;
}

/** Point event drawn on a track header row. */
export interface TraceMarker {
	/** ms epoch. */
	time: number;
	kind: "compaction" | "model_change" | "mode_change" | "reset" | "session_exit";
	/** e.g. "compaction 142k→38k", model id, mode name, exit kind. */
	label: string;
}

/** One transcript (main session, subagent, advisor) in a trace. */
export interface TraceTrack {
	/** "main" or slash-joined child key: "Scout1", "Scout1/Nested2", "__advisor". */
	id: string;
	parentId: string | null;
	label: string;
	/** session_init.agent when recorded. */
	agent: string | null;
	/** session_init.resolvedModel ?? first assistant model. */
	model: string | null;
	/** Absolute transcript path (for entry fetch). */
	file: string;
	/** Sorted by start. */
	spans: TraceSpan[];
	markers: TraceMarker[];
}

/** Per-tool duration aggregate across all tracks of one trace. */
export interface TraceToolStat {
	tool: string;
	calls: number;
	errors: number;
	totalMs: number;
	maxMs: number;
}

/** Headline aggregates for one trace. */
export interface TraceSummary {
	wallMs: number;
	/** Summed model-span duration on the main track. */
	modelMs: number;
	/** Summed tool-span duration on the main track. */
	toolMs: number;
	/** Wall time not covered by any span on any track. */
	idleMs: number;
	turns: number;
	requests: number;
	toolCalls: number;
	subagents: number;
	totalTokens: number;
	costTotal: number;
	/** Model requests whose zero cost is unknown spend, not free usage. */
	unpricedRequests: number;
	/** Sorted totalMs desc. */
	toolStats: TraceToolStat[];
}

/** Complete span tree for one session, `/api/session/trace` payload. */
export interface SessionTrace {
	file: string;
	title: string | null;
	cwd: string | null;
	startedAt: number;
	endedAt: number;
	/** Root transcript mtime; doubles as the ETag. */
	mtimeMs: number;
	/**
	 * Conditional-request fingerprint `"<rootMs>:<childHighMs>"` (see
	 * traceFingerprintForEtag): the server ETag is built from this, so a
	 * subagent-only append changes the ETag even when the root is untouched.
	 */
	etag: string;
	/** DFS order, main first. */
	tracks: TraceTrack[];
	summary: TraceSummary;
}
