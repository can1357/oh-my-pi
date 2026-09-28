/**
 * Hourly rollups of `messages` and `tool_calls`, and every range query the
 * dashboard runs over them.
 *
 * The raw tables hold millions of rows; grouping them per request made every
 * range switch cost seconds. Instead, `message_rollup` / `tool_rollup` keep one
 * row per (hour, dimensions) with additive sums, so a 90-day query reads a few
 * thousand rows.
 *
 * Freshness is trigger-driven: any INSERT/UPDATE/DELETE on the raw tables — from
 * this process, a sync worker, or another omp process sharing the database —
 * records the touched hour in `rollup_dirty`. {@link refreshRollups} recomputes
 * dirty hours newest-first in short immediate transactions.
 *
 * Reads never wait for a refresh and are exact: each query unions
 *   - clean rollup hours inside the range,
 *   - raw rows for the partial hour at the range start, and
 *   - raw rows for dirty hours (while few are dirty),
 * so live ingest shows up before its hour is re-rolled. While the initial build
 * (or a mass re-ingest) leaves many hours dirty, reads use the rollup rows as
 * they stand (stale-but-present; not-yet-built hours are missing) and
 * {@link getRollupStatus} reports the backlog so the UI can show progress.
 *
 * The 1h range needs 5-minute buckets, so it aggregates raw rows directly
 * (an hour of data is small and indexed by timestamp).
 */

import type { Database } from "bun:sqlite";
import { currentDb, unpricedRequestSql } from "./db";
import type {
	AgentType,
	AgentTypeStats,
	AggregatedStats,
	CostTimeSeriesPoint,
	FolderStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	ProviderAggregate,
	ProviderHourlyPoint,
	ProviderTimeSeriesPoint,
	TimeSeriesPoint,
	ToolModelStats,
	ToolTimeSeriesPoint,
	ToolUsageStats,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Bump when the rollup schema or fact definitions change: the tables are then
 * dropped and every hour is rebuilt from the raw tables.
 */
const ROLLUP_VERSION = "2";
const ROLLUP_VERSION_KEY = "rollup_version";
/** Bump when the dirty-marking triggers change; they are then recreated in place. */
const TRIGGER_VERSION = "3";
const TRIGGER_VERSION_KEY = "rollup_triggers_version";

/** Above this many dirty hours, reads use stale rollup rows instead of scanning dirty hours raw. */
const EXACT_DIRTY_LIMIT = 96;
/** Target wall time of one refresh transaction; batch size adapts to hit it. */
const REFRESH_TARGET_MS = 40;
const REFRESH_MAX_BATCH = 64;

// ---------------------------------------------------------------------------
// Fact definitions: one SELECT list per table, shared by the rollup writer and
// the raw read paths so both produce identical columns.
// ---------------------------------------------------------------------------

const MESSAGE_DIMENSIONS = "model, provider, folder, agent_type";

/** Additive per-bucket facts over `messages` (columns qualified by `p`). */
function messageFacts(bucketExpr: string, p: string): string {
	return `
		${bucketExpr} AS bucket,
		${p}model AS model, ${p}provider AS provider, ${p}folder AS folder, ${p}agent_type AS agent_type,
		COUNT(*) AS requests,
		SUM(CASE WHEN ${p}stop_reason = 'error' THEN 1 ELSE 0 END) AS failed,
		SUM(${p}input_tokens) AS input_tokens,
		SUM(${p}output_tokens) AS output_tokens,
		SUM(${p}cache_read_tokens) AS cache_read_tokens,
		SUM(${p}cache_write_tokens) AS cache_write_tokens,
		SUM(${p}total_tokens) AS total_tokens,
		TOTAL(${p}premium_requests) AS premium_requests,
		TOTAL(${p}cost_total) AS cost_total,
		TOTAL(${p}cost_input) AS cost_input,
		TOTAL(${p}cost_output) AS cost_output,
		TOTAL(${p}cost_cache_read) AS cost_cache_read,
		TOTAL(${p}cost_cache_write) AS cost_cache_write,
		SUM(${unpricedRequestSql(p)}) AS unpriced,
		TOTAL(CASE WHEN ${p}cost_no_cache_input > 0
			THEN ${p}cost_input + ${p}cost_cache_read + ${p}cost_cache_write ELSE 0 END) AS cached_prompt_cost,
		TOTAL(${p}cost_no_cache_input) AS no_cache_input_cost,
		TOTAL(${p}duration) AS duration_sum,
		COUNT(${p}duration) AS duration_n,
		TOTAL(${p}ttft) AS ttft_sum,
		COUNT(${p}ttft) AS ttft_n,
		TOTAL(CASE WHEN ${p}duration > 0 THEN ${p}output_tokens * 1000.0 / ${p}duration END) AS tps_sum,
		COUNT(CASE WHEN ${p}duration > 0 THEN 1 END) AS tps_n,
		MIN(${p}timestamp) AS first_ts,
		MAX(${p}timestamp) AS last_ts`;
}

const MESSAGE_ROLLUP_COLUMNS = `bucket, ${MESSAGE_DIMENSIONS}, requests, failed, input_tokens, output_tokens,
	cache_read_tokens, cache_write_tokens, total_tokens, premium_requests, cost_total, cost_input, cost_output,
	cost_cache_read, cost_cache_write, unpriced, cached_prompt_cost, no_cache_input_cost, duration_sum, duration_n,
	ttft_sum, ttft_n, tps_sum, tps_n, first_ts, last_ts`;

/**
 * Additive per-bucket facts over `tool_calls t LEFT JOIN messages m`. Provider
 * usage comes from the invoking assistant turn divided by `calls_in_turn`, so
 * per-tool token/cost shares stay additive across tools.
 */
function toolFacts(bucketExpr: string): string {
	return `
		${bucketExpr} AS bucket,
		t.tool_name AS tool_name, t.model AS model, t.provider AS provider,
		COUNT(*) AS calls,
		SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errors,
		SUM(t.args_chars) AS args_chars,
		SUM(COALESCE(t.result_chars, 0)) AS result_chars,
		TOTAL(COALESCE(m.total_tokens, 0) * 1.0 / t.calls_in_turn) AS total_tokens_share,
		TOTAL(COALESCE(m.output_tokens, 0) * 1.0 / t.calls_in_turn) AS output_tokens_share,
		TOTAL(COALESCE(m.cost_total, 0) / t.calls_in_turn) AS cost_share,
		TOTAL(${unpricedRequestSql("m.")} * 1.0 / t.calls_in_turn) AS unpriced_share,
		MAX(t.timestamp) AS last_used`;
}

const TOOL_ROLLUP_COLUMNS = `bucket, tool_name, model, provider, calls, errors, args_chars, result_chars,
	total_tokens_share, output_tokens_share, cost_share, unpriced_share, last_used`;

const TOOL_JOIN = "LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id";

function hourOf(column: string): string {
	return `((${column}) / ${HOUR_MS}) * ${HOUR_MS}`;
}

/**
 * Trigger statements marking a row's hour and transcript dirty (`row` is
 * `NEW` or `OLD`), without any conflict clause.
 */
function markDirty(row: "NEW" | "OLD"): string {
	return `INSERT INTO rollup_dirty (bucket)
		SELECT h FROM (SELECT ${hourOf(`${row}.timestamp`)} AS h) WHERE h NOT IN (SELECT bucket FROM rollup_dirty);
	INSERT INTO session_dirty (session_file)
		SELECT ${row}.session_file WHERE ${row}.session_file NOT IN (SELECT session_file FROM session_dirty);`;
}

/** Per-transcript facts over `messages` (qualified by `p`); tool calls counted by subquery. */
function sessionFacts(p: string): string {
	return `
		${p}session_file AS session_file,
		COUNT(*) AS requests,
		MIN(${p}timestamp) AS started_at,
		MAX(${p}timestamp + COALESCE(${p}duration, 0)) AS ended_at,
		SUM(${p}total_tokens) AS total_tokens,
		TOTAL(${p}cost_total) AS cost_total,
		SUM(${unpricedRequestSql(p)}) AS unpriced,
		GROUP_CONCAT(DISTINCT ${p}model) AS models,
		(SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_file = ${p}session_file) AS tool_calls`;
}

const SESSION_ROLLUP_COLUMNS =
	"session_file, requests, started_at, ended_at, total_tokens, cost_total, unpriced, models, tool_calls";
/** Dirty transcripts rolled per dirty hour in one refresh batch. */
const SESSIONS_PER_HOUR = 16;
/** Above this many dirty transcripts, session reads use stale rows instead of scanning raw. */
const EXACT_DIRTY_SESSIONS = 512;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Create (or rebuild after a version bump) the rollup tables and the triggers
 * that mark hours dirty. Called from `initDb` after the raw tables exist.
 */
export function ensureRollupSchema(database: Database): void {
	const readMeta = (key: string) =>
		(database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	const fresh = readMeta(ROLLUP_VERSION_KEY) !== ROLLUP_VERSION;
	// Steady state touches no schema: DDL on every open would contend with
	// other omp processes writing the same database.
	if (!fresh && readMeta(TRIGGER_VERSION_KEY) === TRIGGER_VERSION) return;
	database
		.transaction(() => {
			if (fresh) {
				database.run("DROP TABLE IF EXISTS message_rollup");
				database.run("DROP TABLE IF EXISTS tool_rollup");
				database.run("DROP TABLE IF EXISTS rollup_dirty");
				database.run("DROP TABLE IF EXISTS session_rollup");
				database.run("DROP TABLE IF EXISTS session_dirty");
			}
			database.run(`
			CREATE TABLE IF NOT EXISTS message_rollup (
				bucket INTEGER NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				folder TEXT NOT NULL,
				agent_type TEXT NOT NULL,
				requests INTEGER NOT NULL,
				failed INTEGER NOT NULL,
				input_tokens INTEGER NOT NULL,
				output_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				cache_write_tokens INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				premium_requests REAL NOT NULL,
				cost_total REAL NOT NULL,
				cost_input REAL NOT NULL,
				cost_output REAL NOT NULL,
				cost_cache_read REAL NOT NULL,
				cost_cache_write REAL NOT NULL,
				unpriced INTEGER NOT NULL,
				cached_prompt_cost REAL NOT NULL,
				no_cache_input_cost REAL NOT NULL,
				duration_sum REAL NOT NULL,
				duration_n INTEGER NOT NULL,
				ttft_sum REAL NOT NULL,
				ttft_n INTEGER NOT NULL,
				tps_sum REAL NOT NULL,
				tps_n INTEGER NOT NULL,
				first_ts INTEGER NOT NULL,
				last_ts INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_message_rollup_bucket ON message_rollup(bucket);
			CREATE TABLE IF NOT EXISTS tool_rollup (
				bucket INTEGER NOT NULL,
				tool_name TEXT NOT NULL,
				model TEXT NOT NULL,
				provider TEXT NOT NULL,
				calls INTEGER NOT NULL,
				errors INTEGER NOT NULL,
				args_chars INTEGER NOT NULL,
				result_chars INTEGER NOT NULL,
				total_tokens_share REAL NOT NULL,
				output_tokens_share REAL NOT NULL,
				cost_share REAL NOT NULL,
				unpriced_share REAL NOT NULL,
				last_used INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_tool_rollup_bucket ON tool_rollup(bucket);
			CREATE TABLE IF NOT EXISTS rollup_dirty (bucket INTEGER PRIMARY KEY) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS session_rollup (
				session_file TEXT PRIMARY KEY,
				requests INTEGER NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER NOT NULL,
				total_tokens INTEGER NOT NULL,
				cost_total REAL NOT NULL,
				unpriced INTEGER NOT NULL,
				models TEXT,
				tool_calls INTEGER NOT NULL
			) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS session_dirty (session_file TEXT PRIMARY KEY) WITHOUT ROWID;
		`);
			// A tool share reads its assistant message, so message changes dirty the
			// hour for both rollups (tool calls share their message's timestamp).
			// Triggers must not use `OR IGNORE`: a trigger statement inherits the
			// outer statement's conflict policy, and the UPSERTs in
			// `insertMessageStats` would turn a duplicate dirty mark into a failed ingest.
			for (const table of ["messages", "tool_calls"]) {
				const triggers = {
					insert: `AFTER INSERT ON ${table} BEGIN ${markDirty("NEW")} END`,
					delete: `AFTER DELETE ON ${table} BEGIN ${markDirty("OLD")} END`,
					update: `AFTER UPDATE ON ${table} BEGIN ${markDirty("OLD")} ${markDirty("NEW")} END`,
				};
				for (const [event, body] of Object.entries(triggers)) {
					database.run(`DROP TRIGGER IF EXISTS rollup_dirty_${table}_${event}`);
					database.run(`CREATE TRIGGER rollup_dirty_${table}_${event} ${body}`);
				}
			}
			database
				.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
				.run(TRIGGER_VERSION_KEY, TRIGGER_VERSION);
			if (fresh) {
				database.run(`
				INSERT OR IGNORE INTO rollup_dirty (bucket)
				SELECT DISTINCT ${hourOf("timestamp")} FROM messages
				UNION SELECT DISTINCT ${hourOf("timestamp")} FROM tool_calls
			`);
				database.run(`
				INSERT OR IGNORE INTO session_dirty (session_file)
				SELECT DISTINCT session_file FROM messages UNION SELECT DISTINCT session_file FROM tool_calls
			`);
				database
					.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
					.run(ROLLUP_VERSION_KEY, ROLLUP_VERSION);
			}
		})
		.immediate();
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** Backlog of hours and transcripts whose rollups are stale. */
export interface RollupStatus {
	dirtyHours: number;
	dirtySessions: number;
}

export function getRollupStatus(): RollupStatus {
	const database = currentDb();
	if (!database) return { dirtyHours: 0, dirtySessions: 0 };
	return database
		.prepare(
			"SELECT (SELECT COUNT(*) FROM rollup_dirty) AS dirtyHours, (SELECT COUNT(*) FROM session_dirty) AS dirtySessions",
		)
		.get() as RollupStatus;
}

/**
 * Recompute up to `limit` dirty hours, newest first, in one immediate
 * transaction (so no writer can dirty an hour between its read and its
 * dirty-mark removal). Returns the number of hours refreshed.
 */
export function refreshRollupBatch(limit: number): number {
	const database = currentDb();
	if (!database) return 0;
	const run = database.transaction(() => {
		const buckets = database.prepare("SELECT bucket FROM rollup_dirty ORDER BY bucket DESC LIMIT ?").all(limit) as {
			bucket: number;
		}[];
		const clearMessages = database.prepare("DELETE FROM message_rollup WHERE bucket = ?");
		const clearTools = database.prepare("DELETE FROM tool_rollup WHERE bucket = ?");
		const fillMessages = database.prepare(`
			INSERT INTO message_rollup (${MESSAGE_ROLLUP_COLUMNS})
			SELECT ${messageFacts("?1", "")}
			FROM messages WHERE timestamp >= ?1 AND timestamp < ?1 + ${HOUR_MS}
			GROUP BY ${MESSAGE_DIMENSIONS}
		`);
		const fillTools = database.prepare(`
			INSERT INTO tool_rollup (${TOOL_ROLLUP_COLUMNS})
			SELECT ${toolFacts("?1")}
			FROM tool_calls t ${TOOL_JOIN}
			WHERE t.timestamp >= ?1 AND t.timestamp < ?1 + ${HOUR_MS}
			GROUP BY t.tool_name, t.model, t.provider
		`);
		const clean = database.prepare("DELETE FROM rollup_dirty WHERE bucket = ?");
		for (const { bucket } of buckets) {
			clearMessages.run(bucket);
			clearTools.run(bucket);
			fillMessages.run(bucket);
			fillTools.run(bucket);
			clean.run(bucket);
		}

		// Transcripts are cheap (indexed by session_file); roll many per hour-batch.
		const sessions = database
			.prepare("SELECT session_file FROM session_dirty LIMIT ?")
			.all(limit * SESSIONS_PER_HOUR) as { session_file: string }[];
		const clearSession = database.prepare("DELETE FROM session_rollup WHERE session_file = ?");
		const fillSession = database.prepare(`
			INSERT INTO session_rollup (${SESSION_ROLLUP_COLUMNS})
			SELECT ${sessionFacts("m.")}
			FROM messages m WHERE m.session_file = ?1
			GROUP BY m.session_file
		`);
		const cleanSession = database.prepare("DELETE FROM session_dirty WHERE session_file = ?");
		for (const { session_file } of sessions) {
			clearSession.run(session_file);
			fillSession.run(session_file);
			cleanSession.run(session_file);
		}
		return buckets.length + sessions.length;
	});
	return run.immediate();
}

export interface RefreshOptions {
	/** Called after each committed batch with the remaining backlog. */
	onProgress?: (remaining: number) => void;
	/** Stop early (between batches). */
	signal?: AbortSignal;
}

/**
 * Drain the dirty-hour backlog in small transactions, yielding to the event
 * loop between batches so a host process (TUI, dashboard server) stays
 * responsive during the initial build. Batch size adapts so each transaction
 * takes about {@link REFRESH_TARGET_MS}; busy hours shrink it to one.
 */
export async function refreshRollups(opts?: RefreshOptions): Promise<void> {
	let batch = 4;
	while (!opts?.signal?.aborted) {
		const started = performance.now();
		const done = refreshRollupBatch(batch);
		if (done === 0) return;
		const elapsed = performance.now() - started;
		if (elapsed < REFRESH_TARGET_MS / 2) batch = Math.min(REFRESH_MAX_BATCH, batch * 2);
		else if (elapsed > REFRESH_TARGET_MS * 2) batch = Math.max(1, Math.floor(batch / 2));
		opts?.onProgress?.(getRollupStatus().dirtyHours);
		await Bun.sleep(0);
	}
}

// ---------------------------------------------------------------------------
// Range sources
// ---------------------------------------------------------------------------

/** A range query's time window. `cutoff` null = all time. */
export interface RangeWindow {
	cutoff: number | null;
	/** Bucket size for time series (5 minutes, an hour, or a day). */
	bucketMs: number;
}

interface Source {
	sql: string;
	params: number[];
}

function dirtyIsSmall(database: Database): boolean {
	const row = database
		.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM rollup_dirty LIMIT ${EXACT_DIRTY_LIMIT + 1})`)
		.get() as {
		n: number;
	};
	return row.n <= EXACT_DIRTY_LIMIT;
}

/**
 * Message facts covering `[cutoff, now]`, at hour granularity (5-minute raw
 * buckets when `fine`). See the module docs for the union's parts.
 */
function messageSource(database: Database, cutoff: number | null, fine: boolean): Source {
	const groupRaw = `GROUP BY 1, ${MESSAGE_DIMENSIONS}`;
	if (fine) {
		return {
			sql: `SELECT ${messageFacts("(timestamp / 300000) * 300000", "")} FROM messages WHERE timestamp >= ? ${groupRaw}`,
			params: [cutoff ?? 0],
		};
	}
	const hi = cutoff === null ? null : Math.ceil(cutoff / HOUR_MS) * HOUR_MS;
	const exact = dirtyIsSmall(database);
	const parts: string[] = [];
	const params: number[] = [];
	parts.push(
		`SELECT ${MESSAGE_ROLLUP_COLUMNS} FROM message_rollup
		 WHERE ${exact ? "bucket NOT IN (SELECT bucket FROM rollup_dirty)" : "1"}${hi !== null ? " AND bucket >= ?" : ""}`,
	);
	if (hi !== null) params.push(hi);
	if (cutoff !== null && hi !== null && cutoff < hi) {
		parts.push(
			`SELECT ${messageFacts(hourOf("timestamp"), "")} FROM messages
			 WHERE timestamp >= ? AND timestamp < ? ${groupRaw}`,
		);
		params.push(cutoff, hi);
	}
	if (exact) {
		parts.push(
			`SELECT ${messageFacts("d.bucket", "m.")}
			 FROM rollup_dirty d JOIN messages m ON m.timestamp >= d.bucket AND m.timestamp < d.bucket + ${HOUR_MS}
			 ${hi !== null ? "WHERE d.bucket >= ?" : ""}
			 GROUP BY d.bucket, m.model, m.provider, m.folder, m.agent_type`,
		);
		if (hi !== null) params.push(hi);
	}
	return { sql: parts.join(" UNION ALL "), params };
}

/** Tool facts covering `[cutoff, now]`; same union shape as {@link messageSource}. */
function toolSource(database: Database, cutoff: number | null, fine: boolean): Source {
	const groupRaw = "GROUP BY 1, t.tool_name, t.model, t.provider";
	if (fine) {
		return {
			sql: `SELECT ${toolFacts("(t.timestamp / 300000) * 300000")} FROM tool_calls t ${TOOL_JOIN}
				  WHERE t.timestamp >= ? ${groupRaw}`,
			params: [cutoff ?? 0],
		};
	}
	const hi = cutoff === null ? null : Math.ceil(cutoff / HOUR_MS) * HOUR_MS;
	const exact = dirtyIsSmall(database);
	const parts: string[] = [];
	const params: number[] = [];
	parts.push(
		`SELECT ${TOOL_ROLLUP_COLUMNS} FROM tool_rollup
		 WHERE ${exact ? "bucket NOT IN (SELECT bucket FROM rollup_dirty)" : "1"}${hi !== null ? " AND bucket >= ?" : ""}`,
	);
	if (hi !== null) params.push(hi);
	if (cutoff !== null && hi !== null && cutoff < hi) {
		parts.push(
			`SELECT ${toolFacts(hourOf("t.timestamp"))} FROM tool_calls t ${TOOL_JOIN}
			 WHERE t.timestamp >= ? AND t.timestamp < ? ${groupRaw}`,
		);
		params.push(cutoff, hi);
	}
	if (exact) {
		parts.push(
			`SELECT ${toolFacts("d.bucket")}
			 FROM rollup_dirty d JOIN tool_calls t ON t.timestamp >= d.bucket AND t.timestamp < d.bucket + ${HOUR_MS}
			 ${TOOL_JOIN}
			 ${hi !== null ? "WHERE d.bucket >= ?" : ""}
			 GROUP BY d.bucket, t.tool_name, t.model, t.provider`,
		);
		if (hi !== null) params.push(hi);
	}
	return { sql: parts.join(" UNION ALL "), params };
}

/** Run `select … FROM (<facts>) f <tail>` over the message facts for a window. */
function queryMessages<T>(window: Pick<RangeWindow, "cutoff"> & { bucketMs?: number }, select: string, tail = ""): T[] {
	const database = currentDb();
	if (!database) return [];
	const fine = window.bucketMs !== undefined && window.bucketMs < HOUR_MS;
	const source = messageSource(database, normalizeCutoff(window.cutoff), fine);
	return database.prepare(`SELECT ${select} FROM (${source.sql}) f ${tail}`).all(...source.params) as T[];
}

function queryTools<T>(window: Pick<RangeWindow, "cutoff"> & { bucketMs?: number }, select: string, tail = ""): T[] {
	const database = currentDb();
	if (!database) return [];
	const fine = window.bucketMs !== undefined && window.bucketMs < HOUR_MS;
	const source = toolSource(database, normalizeCutoff(window.cutoff), fine);
	return database.prepare(`SELECT ${select} FROM (${source.sql}) f ${tail}`).all(...source.params) as T[];
}

function normalizeCutoff(cutoff: number | null | undefined): number | null {
	return cutoff === undefined || cutoff === null || cutoff <= 0 ? null : cutoff;
}

function seriesBucket(bucketMs: number): string {
	return `(f.bucket / ${bucketMs}) * ${bucketMs}`;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

const AGGREGATE_COLUMNS = `
	SUM(f.requests) AS requests,
	SUM(f.failed) AS failed,
	SUM(f.input_tokens) AS input_tokens,
	SUM(f.output_tokens) AS output_tokens,
	SUM(f.cache_read_tokens) AS cache_read_tokens,
	SUM(f.cache_write_tokens) AS cache_write_tokens,
	TOTAL(f.premium_requests) AS premium_requests,
	TOTAL(f.cost_total) AS cost_total,
	SUM(f.unpriced) AS unpriced,
	TOTAL(f.cached_prompt_cost) AS cached_prompt_cost,
	TOTAL(f.no_cache_input_cost) AS no_cache_input_cost,
	TOTAL(f.duration_sum) / NULLIF(SUM(f.duration_n), 0) AS avg_duration,
	TOTAL(f.ttft_sum) / NULLIF(SUM(f.ttft_n), 0) AS avg_ttft,
	TOTAL(f.tps_sum) / NULLIF(SUM(f.tps_n), 0) AS avg_tps,
	MIN(f.first_ts) AS first_ts,
	MAX(f.last_ts) AS last_ts`;

interface AggregateRow {
	requests: number | null;
	failed: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	premium_requests: number | null;
	cost_total: number | null;
	unpriced: number | null;
	cached_prompt_cost: number | null;
	no_cache_input_cost: number | null;
	avg_duration: number | null;
	avg_ttft: number | null;
	avg_tps: number | null;
	first_ts: number | null;
	last_ts: number | null;
}

function toAggregatedStats(row: AggregateRow | undefined): AggregatedStats {
	const totalRequests = row?.requests ?? 0;
	const failedRequests = row?.failed ?? 0;
	const totalInputTokens = row?.input_tokens ?? 0;
	const totalCacheReadTokens = row?.cache_read_tokens ?? 0;
	const noCacheInputCost = row?.no_cache_input_cost ?? 0;
	const cachedPromptCost = row?.cached_prompt_cost ?? 0;
	return {
		totalRequests,
		successfulRequests: totalRequests - failedRequests,
		failedRequests,
		errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
		totalInputTokens,
		totalOutputTokens: row?.output_tokens ?? 0,
		totalCacheReadTokens,
		totalCacheWriteTokens: row?.cache_write_tokens ?? 0,
		cacheRate:
			totalInputTokens + totalCacheReadTokens > 0
				? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)
				: 0,
		cacheSavings: noCacheInputCost > 0 ? (noCacheInputCost - cachedPromptCost) / noCacheInputCost : 0,
		totalCost: row?.cost_total ?? 0,
		unpricedRequests: row?.unpriced ?? 0,
		totalPremiumRequests: row?.premium_requests ?? 0,
		avgDuration: row?.avg_duration ?? null,
		avgTtft: row?.avg_ttft ?? null,
		avgTokensPerSecond: row?.avg_tps ?? null,
		firstTimestamp: row?.first_ts ?? 0,
		lastTimestamp: row?.last_ts ?? 0,
	};
}

/** Overall request/token/cost aggregate since `cutoff` (all time when null). */
export function getOverallStats(cutoff: number | null = null): AggregatedStats {
	return toAggregatedStats(queryMessages<AggregateRow>({ cutoff }, AGGREGATE_COLUMNS)[0]);
}

/** Aggregates per (model, provider), busiest first. */
export function getStatsByModel(cutoff: number | null = null): ModelStats[] {
	return queryMessages<AggregateRow & { model: string; provider: string }>(
		{ cutoff },
		`f.model AS model, f.provider AS provider, ${AGGREGATE_COLUMNS}`,
		"GROUP BY f.model, f.provider ORDER BY requests DESC",
	).map(row => ({ model: row.model, provider: row.provider, ...toAggregatedStats(row) }));
}

/** Aggregates per project folder, busiest first; at most `limit` folders. */
export function getStatsByFolder(cutoff: number | null = null, limit = Number.MAX_SAFE_INTEGER): FolderStats[] {
	return queryMessages<AggregateRow & { folder: string }>(
		{ cutoff },
		`f.folder AS folder, ${AGGREGATE_COLUMNS}`,
		`GROUP BY f.folder ORDER BY requests DESC LIMIT ${Math.max(0, Math.floor(limit))}`,
	).map(row => ({ folder: row.folder, ...toAggregatedStats(row) }));
}

/** Token usage per agent type (main, subagent, advisor). */
export function getStatsByAgentType(cutoff: number | null = null): AgentTypeStats[] {
	return queryMessages<{
		agent_type: string | null;
		requests: number;
		input_tokens: number | null;
		output_tokens: number | null;
		cache_read_tokens: number | null;
		cache_write_tokens: number | null;
		cost_total: number | null;
	}>(
		{ cutoff },
		`f.agent_type AS agent_type, SUM(f.requests) AS requests, SUM(f.input_tokens) AS input_tokens,
		 SUM(f.output_tokens) AS output_tokens, SUM(f.cache_read_tokens) AS cache_read_tokens,
		 SUM(f.cache_write_tokens) AS cache_write_tokens, TOTAL(f.cost_total) AS cost_total`,
		"GROUP BY f.agent_type",
	).map(row => ({
		agentType: (row.agent_type as AgentType | null) ?? "main",
		totalRequests: row.requests,
		totalInputTokens: row.input_tokens ?? 0,
		totalOutputTokens: row.output_tokens ?? 0,
		totalCacheReadTokens: row.cache_read_tokens ?? 0,
		totalCacheWriteTokens: row.cache_write_tokens ?? 0,
		totalCost: row.cost_total ?? 0,
	}));
}

/** Requests, errors, tokens and cost per bucket. */
export function getTimeSeries({ cutoff, bucketMs }: RangeWindow): TimeSeriesPoint[] {
	return queryMessages<{ bucket: number; requests: number; errors: number; tokens: number; cost: number }>(
		{ cutoff, bucketMs },
		`${seriesBucket(bucketMs)} AS bucket, SUM(f.requests) AS requests, SUM(f.failed) AS errors,
		 SUM(f.total_tokens) AS tokens, TOTAL(f.cost_total) AS cost`,
		"GROUP BY 1 ORDER BY 1",
	).map(row => ({
		timestamp: row.bucket,
		requests: row.requests,
		errors: row.errors,
		tokens: row.tokens,
		cost: row.cost,
	}));
}

/** Requests per bucket per (model, provider). */
export function getModelTimeSeries({ cutoff, bucketMs }: RangeWindow): ModelTimeSeriesPoint[] {
	return queryMessages<{ bucket: number; model: string; provider: string; requests: number }>(
		{ cutoff, bucketMs },
		`${seriesBucket(bucketMs)} AS bucket, f.model AS model, f.provider AS provider, SUM(f.requests) AS requests`,
		"GROUP BY 1, f.model, f.provider ORDER BY 1",
	).map(row => ({ timestamp: row.bucket, model: row.model, provider: row.provider, requests: row.requests }));
}

/** Average TTFT and output tokens/s per bucket per (model, provider). */
export function getModelPerformanceSeries({ cutoff, bucketMs }: RangeWindow): ModelPerformancePoint[] {
	return queryMessages<{
		bucket: number;
		model: string;
		provider: string;
		requests: number;
		avg_ttft: number | null;
		avg_tps: number | null;
	}>(
		{ cutoff, bucketMs },
		`${seriesBucket(bucketMs)} AS bucket, f.model AS model, f.provider AS provider, SUM(f.requests) AS requests,
		 TOTAL(f.ttft_sum) / NULLIF(SUM(f.ttft_n), 0) AS avg_ttft,
		 TOTAL(f.tps_sum) / NULLIF(SUM(f.tps_n), 0) AS avg_tps`,
		"GROUP BY 1, f.model, f.provider ORDER BY 1",
	).map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tps,
	}));
}

/** Daily cost per (model, provider) with the per-component split. */
export function getCostTimeSeries(cutoff: number | null = null): CostTimeSeriesPoint[] {
	return queryMessages<{
		bucket: number;
		model: string;
		provider: string;
		cost: number;
		unpriced: number;
		cost_input: number;
		cost_output: number;
		cost_cache_read: number;
		cost_cache_write: number;
		requests: number;
	}>(
		{ cutoff },
		`${seriesBucket(DAY_MS)} AS bucket, f.model AS model, f.provider AS provider, TOTAL(f.cost_total) AS cost,
		 SUM(f.unpriced) AS unpriced, TOTAL(f.cost_input) AS cost_input, TOTAL(f.cost_output) AS cost_output,
		 TOTAL(f.cost_cache_read) AS cost_cache_read, TOTAL(f.cost_cache_write) AS cost_cache_write,
		 SUM(f.requests) AS requests`,
		"GROUP BY 1, f.model, f.provider ORDER BY 1",
	).map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		cost: row.cost,
		unpricedRequests: row.unpriced,
		costInput: row.cost_input,
		costOutput: row.cost_output,
		costCacheRead: row.cost_cache_read,
		costCacheWrite: row.cost_cache_write,
		requests: row.requests,
	}));
}

/** Request/token/cost totals per provider, biggest token burn first. */
export function getStatsByProvider(cutoff: number | null = null): ProviderAggregate[] {
	return queryMessages<{
		provider: string;
		requests: number;
		failed: number;
		models: number;
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_write_tokens: number;
		cost_total: number;
		unpriced: number;
		premium_requests: number;
		avg_tps: number | null;
	}>(
		{ cutoff },
		`f.provider AS provider, SUM(f.requests) AS requests, SUM(f.failed) AS failed,
		 COUNT(DISTINCT f.model) AS models, SUM(f.input_tokens) AS input_tokens, SUM(f.output_tokens) AS output_tokens,
		 SUM(f.cache_read_tokens) AS cache_read_tokens, SUM(f.cache_write_tokens) AS cache_write_tokens,
		 TOTAL(f.cost_total) AS cost_total, SUM(f.unpriced) AS unpriced, TOTAL(f.premium_requests) AS premium_requests,
		 TOTAL(f.tps_sum) / NULLIF(SUM(f.tps_n), 0) AS avg_tps`,
		"GROUP BY f.provider",
	)
		.map(row => ({
			provider: row.provider,
			totalRequests: row.requests,
			failedRequests: row.failed,
			models: row.models,
			totalInputTokens: row.input_tokens,
			totalOutputTokens: row.output_tokens,
			totalCacheReadTokens: row.cache_read_tokens,
			totalCacheWriteTokens: row.cache_write_tokens,
			totalTokens: row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens,
			totalCost: row.cost_total,
			unpricedRequests: row.unpriced,
			totalPremiumRequests: row.premium_requests,
			avgTokensPerSecond: row.avg_tps,
		}))
		.sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Token burn per provider per local hour of day (0-23). Hours use the
 * server's timezone — a localhost tool, so server and viewer coincide. Rolled
 * hours are attributed by their start, so half-hour UTC offsets shift burn by
 * up to 30 minutes.
 */
export function getProviderHourlyBurn(cutoff: number | null = null): ProviderHourlyPoint[] {
	return queryMessages<{
		provider: string;
		hour: number;
		total_tokens: number;
		output_tokens: number;
		requests: number;
	}>(
		{ cutoff },
		`f.provider AS provider, CAST(strftime('%H', f.bucket / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
		 SUM(f.input_tokens + f.output_tokens + f.cache_read_tokens + f.cache_write_tokens) AS total_tokens,
		 SUM(f.output_tokens) AS output_tokens, SUM(f.requests) AS requests`,
		"GROUP BY f.provider, hour ORDER BY f.provider, hour",
	).map(row => ({
		provider: row.provider,
		hour: row.hour,
		totalTokens: row.total_tokens,
		outputTokens: row.output_tokens,
		requests: row.requests,
	}));
}

/** Tokens/cost per bucket per provider. */
export function getProviderTimeSeries({ cutoff, bucketMs }: RangeWindow): ProviderTimeSeriesPoint[] {
	return queryMessages<{
		bucket: number;
		provider: string;
		total_tokens: number;
		cost: number;
		unpriced: number;
		requests: number;
	}>(
		{ cutoff, bucketMs },
		`${seriesBucket(bucketMs)} AS bucket, f.provider AS provider,
		 SUM(f.input_tokens + f.output_tokens + f.cache_read_tokens + f.cache_write_tokens) AS total_tokens,
		 TOTAL(f.cost_total) AS cost, SUM(f.unpriced) AS unpriced, SUM(f.requests) AS requests`,
		"GROUP BY 1, f.provider ORDER BY 1",
	).map(row => ({
		timestamp: row.bucket,
		provider: row.provider,
		totalTokens: row.total_tokens,
		cost: row.cost,
		unpricedRequests: row.unpriced,
		requests: row.requests,
	}));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Per-transcript-file rollup for the Traces session list. */
export interface SessionRollupRow {
	sessionFile: string;
	requests: number;
	startedAt: number;
	endedAt: number;
	totalTokens: number;
	costTotal: number;
	unpricedRequests: number;
	/** Comma-joined DISTINCT models. */
	models: string | null;
	toolCalls: number;
}

/**
 * One row per synced transcript file (subagents unfolded). Same exactness
 * rules as the range queries: dirty transcripts are aggregated raw while few.
 */
export function getSessionRollups(): SessionRollupRow[] {
	const database = currentDb();
	if (!database) return [];
	const { n } = database
		.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM session_dirty LIMIT ${EXACT_DIRTY_SESSIONS + 1})`)
		.get() as { n: number };
	const exact = n <= EXACT_DIRTY_SESSIONS;
	const parts = [
		`SELECT ${SESSION_ROLLUP_COLUMNS} FROM session_rollup
		 ${exact ? "WHERE session_file NOT IN (SELECT session_file FROM session_dirty)" : ""}`,
	];
	if (exact) {
		parts.push(
			`SELECT ${sessionFacts("m.")} FROM session_dirty d JOIN messages m ON m.session_file = d.session_file
			 GROUP BY m.session_file`,
		);
	}
	return database
		.prepare(
			`SELECT session_file AS sessionFile, requests, started_at AS startedAt, ended_at AS endedAt,
			 total_tokens AS totalTokens, cost_total AS costTotal, unpriced AS unpricedRequests, models,
			 tool_calls AS toolCalls
			 FROM (${parts.join(" UNION ALL ")})`,
		)
		.all() as SessionRollupRow[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOL_AGGREGATE_COLUMNS = `
	SUM(f.calls) AS calls,
	SUM(f.errors) AS errors,
	SUM(f.args_chars) AS args_chars,
	SUM(f.result_chars) AS result_chars,
	TOTAL(f.total_tokens_share) AS total_tokens_share,
	TOTAL(f.output_tokens_share) AS output_tokens_share,
	TOTAL(f.cost_share) AS cost_share,
	TOTAL(f.unpriced_share) AS unpriced_share,
	MAX(f.last_used) AS last_used`;

interface ToolAggregateRow {
	tool_name: string;
	model?: string;
	provider?: string;
	calls: number;
	errors: number;
	args_chars: number | null;
	result_chars: number | null;
	total_tokens_share: number;
	output_tokens_share: number;
	cost_share: number;
	unpriced_share: number;
	last_used: number;
}

function toToolUsage(row: ToolAggregateRow): ToolUsageStats {
	return {
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
		argsChars: row.args_chars ?? 0,
		resultChars: row.result_chars ?? 0,
		totalTokensShare: row.total_tokens_share,
		outputTokensShare: row.output_tokens_share,
		costShare: row.cost_share,
		unpricedRequestsShare: row.unpriced_share,
		lastUsed: row.last_used,
	};
}

/** Tool usage per tool name, most-called first. */
export function getToolStats(cutoff: number | null = null): ToolUsageStats[] {
	return queryTools<ToolAggregateRow>(
		{ cutoff },
		`f.tool_name AS tool_name, ${TOOL_AGGREGATE_COLUMNS}`,
		"GROUP BY f.tool_name ORDER BY calls DESC, f.tool_name",
	).map(toToolUsage);
}

/** Tool usage per (tool, model, provider), most-called first. */
export function getToolStatsByModel(cutoff: number | null = null): ToolModelStats[] {
	return queryTools<ToolAggregateRow>(
		{ cutoff },
		`f.tool_name AS tool_name, f.model AS model, f.provider AS provider, ${TOOL_AGGREGATE_COLUMNS}`,
		"GROUP BY f.tool_name, f.model, f.provider ORDER BY calls DESC, f.tool_name, f.model, f.provider",
	).map(row => ({ ...toToolUsage(row), model: row.model ?? "", provider: row.provider ?? "" }));
}

/** Calls and errors per bucket per tool. */
export function getToolTimeSeries({ cutoff, bucketMs }: RangeWindow): ToolTimeSeriesPoint[] {
	return queryTools<{ bucket: number; tool_name: string; calls: number; errors: number }>(
		{ cutoff, bucketMs },
		`${seriesBucket(bucketMs)} AS bucket, f.tool_name AS tool_name, SUM(f.calls) AS calls, SUM(f.errors) AS errors`,
		"GROUP BY 1, f.tool_name ORDER BY 1",
	).map(row => ({ timestamp: row.bucket, tool: row.tool_name, calls: row.calls, errors: row.errors }));
}
