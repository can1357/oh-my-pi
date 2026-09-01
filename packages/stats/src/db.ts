import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	calculateUncachedInputCost,
	calculateUsageCost,
	type GeneratedProvider,
	getBundledModel,
} from "@oh-my-pi/pi-catalog/models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import { getConfigRootDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { classifyAgentType } from "./parser";
import type {
	AgentType,
	AgentTypeStats,
	AggregatedStats,
	BehaviorModelStats,
	BehaviorOverallStats,
	BehaviorTimeSeriesPoint,
	CostTimeSeriesPoint,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	ProviderAggregate,
	ProviderHourlyPoint,
	ProviderTimeSeriesPoint,
	TimeSeriesPoint,
	ToolCallStats,
	ToolModelStats,
	ToolResultLink,
	ToolTimeSeriesPoint,
	ToolUsageStats,
	UserMessageLink,
	UserMessageStats,
} from "./types";

type UsageCost = Usage["cost"];
type CostTokens = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "orchestration" | "cttl">;

const ZERO_USAGE_COST: UsageCost = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
};

const UNPRICED_XAI_OAUTH_SQL =
	"CASE WHEN provider = 'xai-oauth' AND total_tokens > 0 AND cost_total = 0 THEN 1 ELSE 0 END";

interface CostBackfillRow {
	id: number;
	provider: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

interface NoCacheInputCostBackfillRow {
	id: number;
	provider: string;
	model: string;
	input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

interface AggregatedStatsRow {
	total_requests: number;
	failed_requests: number | null;
	total_input_tokens: number | null;
	total_output_tokens: number | null;
	total_cache_read_tokens: number | null;
	total_cache_write_tokens: number | null;
	total_premium_requests: number | null;
	total_cost: number | null;
	unpriced_requests: number | null;
	total_cached_prompt_cost: number | null;
	total_no_cache_input_cost: number | null;
	avg_duration: number | null;
	avg_ttft: number | null;
	avg_tokens_per_second: number | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

interface ModelStatsRow extends AggregatedStatsRow {
	model: string;
	provider: string;
}

interface FolderStatsRow extends AggregatedStatsRow {
	folder: string;
}

interface CostTimeSeriesRow {
	bucket: number;
	model: string;
	provider: string;
	cost: number | null;
	unpriced_requests: number | null;
	cost_input: number | null;
	cost_output: number | null;
	cost_cache_read: number | null;
	cost_cache_write: number | null;
	requests: number;
}

let db: Database | null = null;

const BACKFILL_COMPLETE = "complete";
const BACKFILL_PENDING = "pending";
const USER_MESSAGES_BACKFILL_KEY = "user_messages_v8";
const USER_MESSAGE_LINKS_REPAIR_KEY = "user_message_links_v1";
const PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY = "premium_requests_priority_v1";
const AGENT_TYPE_BACKFILL_KEY = "agent_type_v1";
const FORK_DEDUPE_KEY = "fork_dedupe_v1";
const TOOL_CALLS_BACKFILL_KEY = "tool_calls_v1";
// Older ingests dropped `Usage.orchestration` (never a stored column) when
// pricing, so subscription models billed on orchestration tokens — multi-agent
// Grok most notably — were priced from conversation buckets alone and could not
// reach the inclusive 200K tier. A one-time full re-parse repairs them through
// the cost-refreshing UPSERT in `insertMessageStats`.
const COST_REINGEST_BACKFILL_KEY = "messages_cost_reingest_v1";
function shouldResetBackfill(value: string | undefined): boolean {
	return value !== BACKFILL_COMPLETE && value !== BACKFILL_PENDING;
}
/**
 * Initialize the database and create tables.
 */
export async function initDb(): Promise<Database> {
	if (db) return db;

	// Ensure directory exists
	await fs.mkdir(getConfigRootDir(), { recursive: true });

	db = new Database(getStatsDbPath());
	// Install the busy handler BEFORE any lock-taking statement. See
	// https://github.com/can1357/oh-my-pi/issues/2421.
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");

	// Whether `messages` predates this init — drives the one-time agent_type
	// backfill below, so it must be sampled before CREATE TABLE adds the table.
	const messagesTableExisted =
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get() !== undefined;

	// Create tables
	db.run(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			cost_no_cache_input REAL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_folder ON messages(timestamp, folder);
		CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);

		CREATE TABLE IF NOT EXISTS tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			calls_in_turn INTEGER NOT NULL DEFAULT 1,
			args_chars INTEGER NOT NULL DEFAULT 0,
			result_chars INTEGER,
			is_error INTEGER,
			UNIQUE(session_file, tool_call_id)
		);

		CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
	if (!messageColumns.some(column => column.name === "premium_requests")) {
		db.run("ALTER TABLE messages ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0");
	}
	if (!messageColumns.some(column => column.name === "cost_no_cache_input")) {
		db.run("ALTER TABLE messages ADD COLUMN cost_no_cache_input REAL");
	}
	db.run("UPDATE messages SET premium_requests = 0 WHERE premium_requests IS NULL");
	// Token-usage-by-agent: each message is classified main / subagent / advisor
	// from its transcript path. A brand-new table gets the column from CREATE
	// TABLE and the parser labels rows at insert time; a pre-existing table gets
	// the column here (defaulting every prior row to 'main') and enrolls the
	// one-time path-based reclassification, gated by a meta sentinel.
	const hasAgentTypeColumn = messageColumns.some(column => column.name === "agent_type");
	if (!hasAgentTypeColumn) {
		db.run("ALTER TABLE messages ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'main'");
	}
	// For any pre-existing table, enroll the backfill PENDING unless a prior run
	// already settled the sentinel — `OR IGNORE` leaves an existing
	// COMPLETE/PENDING value intact, so an ALTER that committed before its
	// sentinel write (process killed in between) still reclassifies on the next
	// init instead of silently leaving every row as the 'main' default. A
	// brand-new empty table has nothing to reclassify, so it settles COMPLETE.
	db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
		AGENT_TYPE_BACKFILL_KEY,
		messagesTableExisted ? BACKFILL_PENDING : BACKFILL_COMPLETE,
	);
	db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp_agent_type ON messages(timestamp, agent_type)");
	// Each behavior-metric bump invalidates previously-ingested rows. We detect
	// the stale schema by column name and drop the table; `IF NOT EXISTS` above
	// already produced the new schema, but we want a clean wipe + re-ingest.
	// `backfillUserMessages` then clears `file_offsets` so the next sync
	// re-parses every session under the current metric definitions.
	//   v1 -> v2: yelling sentences replace `caps_words`.
	//   v2 -> v3: `drama_runs` folded into a single `anguish` signal that
	//             also captures elongated interjections, `dude`, and dot runs,
	//             gated on a stripped prose-line budget.
	//   v3 -> v4: added `negation`, `repetition`, `blame` frustration signals
	//             plus profanity dictionary expansion + word-boundary fix.
	//   v4 -> v5: column `yelling_sentences` renamed to `yelling` to match
	//             the other single-word signal columns.
	//   v5 -> v6: dropped `git` from the profanity word list.
	//   v6 -> v7: dropped dot runs from `anguish`, technical-collision and
	//             opinion words from the profanity list; gated yelling on
	//             multi-word caps and bare `no` on interjection use.
	//   v7 -> v8: `no-op` compounds no longer count as negation; recovered
	//             measured false negatives: `:(` emoticons -> anguish,
	//             `why (would|did) you` -> blame, `makes no sense` -> negation.
	const userMessageColumns = db.prepare("PRAGMA table_info(user_messages)").all() as {
		name: string;
	}[];
	const hasStaleColumn =
		userMessageColumns.length > 0 &&
		(userMessageColumns.some(column => column.name === "caps_words") ||
			userMessageColumns.some(column => column.name === "drama_runs") ||
			userMessageColumns.some(column => column.name === "yelling_sentences"));
	const hasV4Columns = userMessageColumns.some(column => column.name === "negation");
	const hasOldUserMessages = userMessageColumns.length > 0;
	if (hasStaleColumn || (hasOldUserMessages && !hasV4Columns)) {
		db.run("DROP TABLE user_messages");
		db.run(`
			CREATE TABLE user_messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_file TEXT NOT NULL,
				entry_id TEXT NOT NULL,
				folder TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				model TEXT,
				provider TEXT,
				chars INTEGER NOT NULL,
				words INTEGER NOT NULL,
				yelling INTEGER NOT NULL,
				profanity INTEGER NOT NULL,
				anguish INTEGER NOT NULL,
				negation INTEGER NOT NULL DEFAULT 0,
				repetition INTEGER NOT NULL DEFAULT 0,
				blame INTEGER NOT NULL DEFAULT 0,
				UNIQUE(session_file, entry_id)
			);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);
		`);
	}
	backfillUserMessages(db);
	backfillToolCalls(db);
	backfillReingestCosts(db);
	repairUserMessageLinks(db);
	backfillPriorityPremiumRequests(db);
	backfillAgentType(db);
	backfillMissingCatalogCosts(db);
	backfillNoCacheInputCosts(db);
	backfillForkDuplicates(db);
	return db;
}

function hasBillableCost(cost: ModelCost): boolean {
	return cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
}

function getBundledModelCost(provider: string, modelId: string): ModelCost | null {
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	return model?.cost ?? null;
}

function getCatalogCost(provider: string, modelId: string): ModelCost | null {
	const primaryCost = getBundledModelCost(provider, modelId);
	if (primaryCost && hasBillableCost(primaryCost)) {
		return primaryCost;
	}

	const fallbackProvider = provider === "openai-codex" ? "openai" : provider === "xai-oauth" ? "xai" : null;
	if (fallbackProvider) {
		const fallbackCost = getBundledModelCost(fallbackProvider, modelId);
		if (fallbackCost && hasBillableCost(fallbackCost)) {
			return fallbackCost;
		}
	}

	return null;
}

function calculateCatalogCost(provider: string, modelId: string, tokens: CostTokens): UsageCost | null {
	const cost = getCatalogCost(provider, modelId);
	if (!cost) return null;

	const orchestration = tokens.orchestration;
	const usage: Usage = {
		...tokens,
		totalTokens:
			tokens.input +
			tokens.output +
			tokens.cacheRead +
			tokens.cacheWrite +
			(orchestration?.input ?? 0) +
			(orchestration?.output ?? 0) +
			(orchestration?.cacheRead ?? 0),
		cost: { ...ZERO_USAGE_COST },
	};
	return calculateUsageCost(cost, usage);
}

function normalizeUsageCost(cost: UsageCost): UsageCost {
	const input = cost.input ?? 0;
	const output = cost.output ?? 0;
	const cacheRead = cost.cacheRead ?? 0;
	const cacheWrite = cost.cacheWrite ?? 0;
	const total = cost.total ?? input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, total };
}

function resolveStoredCost(stats: MessageStats): UsageCost {
	// `usage.cost` was optional in older session files, and legacy payloads
	// can carry a partially-populated cost object (e.g. only `total`). The
	// messages table declares every cost_* column as REAL NOT NULL, so any
	// missing field must be normalised here before binding into SQLite.
	const raw: UsageCost | undefined = stats.usage.cost;
	const storedCost = raw ? normalizeUsageCost(raw) : undefined;

	// A missing total is derived from the stored components. An explicit zero
	// remains the sentinel for catalog-based correction.
	if (storedCost && (raw?.total ?? storedCost.total) !== 0) return storedCost;

	return calculateCatalogCost(stats.provider, stats.model, stats.usage) ?? storedCost ?? ZERO_USAGE_COST;
}

function calculateNoCacheInputCost(provider: string, modelId: string, tokens: CostTokens): number | null {
	const cost = getCatalogCost(provider, modelId);
	if (!cost) return null;
	const promptInputTokens =
		tokens.input +
		tokens.cacheRead +
		tokens.cacheWrite +
		(tokens.orchestration?.input ?? 0) +
		(tokens.orchestration?.cacheRead ?? 0);
	return calculateUncachedInputCost(cost, promptInputTokens);
}

function backfillMissingCatalogCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
			FROM messages
			WHERE cost_total = 0 AND total_tokens > 0
		`)
		.all() as CostBackfillRow[];

	if (rows.length === 0) return;

	const update = database.prepare(`
		UPDATE messages
		SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?
		WHERE id = ?
	`);

	const applyBackfill = database.transaction(() => {
		for (const row of rows) {
			const cost = calculateCatalogCost(row.provider, row.model, {
				input: row.input_tokens,
				output: row.output_tokens,
				cacheRead: row.cache_read_tokens,
				cacheWrite: row.cache_write_tokens,
			});

			if (!cost || cost.total === 0) continue;

			update.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, row.id);
		}
	});

	applyBackfill();
}

function backfillNoCacheInputCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, input_tokens, cache_read_tokens, cache_write_tokens
			FROM messages
			WHERE cost_no_cache_input IS NULL
		`)
		.all() as NoCacheInputCostBackfillRow[];
	if (rows.length === 0) return;

	const update = database.prepare("UPDATE messages SET cost_no_cache_input = ? WHERE id = ?");
	const applyBackfill = database.transaction(() => {
		for (const row of rows) {
			const cost = calculateNoCacheInputCost(row.provider, row.model, {
				input: row.input_tokens,
				output: 0,
				cacheRead: row.cache_read_tokens,
				cacheWrite: row.cache_write_tokens,
			});
			update.run(cost ?? 0, row.id);
		}
	});
	applyBackfill();
}

/**
 * Get the stored offset for a session file.
 */
export function getFileOffset(sessionFile: string): { offset: number; lastModified: number } | null {
	if (!db) return null;

	const stmt = db.prepare("SELECT offset, last_modified FROM file_offsets WHERE session_file = ?");
	const row = stmt.get(sessionFile) as { offset: number; last_modified: number } | undefined;

	return row ? { offset: row.offset, lastModified: row.last_modified } : null;
}

/**
 * Update the stored offset for a session file.
 */
export function setFileOffset(sessionFile: string, offset: number, lastModified: number): void {
	if (!db) return;

	const stmt = db.prepare(`
		INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified)
		VALUES (?, ?, ?)
	`);
	stmt.run(sessionFile, offset, lastModified);
}

/**
 * Insert message stats into the database.
 *
 * Forked / branched sessions (see `SessionManager.fork()` and
 * `createBranchedSession()` in `@oh-my-pi/pi-coding-agent`) deep-copy a parent
 * session's entries into a new JSONL — same `entry_id`, `timestamp`, `model`,
 * `provider`, token counts, and `responseId`. The `UNIQUE(session_file,
 * entry_id)` constraint alone keys each row by file, so without the guard
 * below the same provider request would land twice and inflate every
 * aggregate. The `WHERE NOT EXISTS` clause skips inserts whose
 * `(entry_id, timestamp)` already exists under a different `session_file` —
 * first-write-wins across the lineage. Same-file re-syncs still hit the
 * `ON CONFLICT(session_file, entry_id)` upsert below, which re-derives the
 * stored cost (orchestration-aware) and keeps `premium_requests` monotonic, so
 * a forced re-parse repairs historical `premium_requests` and cost fix-ups.
 */
export function insertMessageStats(stats: MessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			premium_requests = MAX(messages.premium_requests, excluded.premium_requests),
			cost_input = excluded.cost_input,
			cost_output = excluded.cost_output,
			cost_cache_read = excluded.cost_cache_read,
			cost_cache_write = excluded.cost_cache_write,
			cost_total = excluded.cost_total,
			cost_no_cache_input = excluded.cost_no_cache_input
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const cost = resolveStoredCost(s);
			const noCacheInputCost = calculateNoCacheInputCost(s.provider, s.model, s.usage) ?? 0;
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.model,
				s.provider,
				s.api,
				s.timestamp,
				s.duration,
				s.ttft,
				s.stopReason,
				s.errorMessage,
				s.usage.input,
				s.usage.output,
				s.usage.cacheRead,
				s.usage.cacheWrite,
				s.usage.totalTokens,
				s.usage.premiumRequests ?? 0,
				cost.input,
				cost.output,
				cost.cacheRead,
				cost.cacheWrite,
				cost.total,
				noCacheInputCost,
				s.agentType,
				// `WHERE NOT EXISTS` binds: skip when a different session_file
				// already holds this (entry_id, timestamp).
				s.entryId,
				s.timestamp,
				s.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});

	insert();
	return inserted;
}

/**
 * Build aggregated stats from query results.
 */
function buildAggregatedStats(rows: AggregatedStatsRow[]): AggregatedStats {
	if (rows.length === 0) {
		return {
			totalRequests: 0,
			successfulRequests: 0,
			failedRequests: 0,
			errorRate: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			cacheRate: 0,
			cacheSavings: 0,
			totalCost: 0,
			unpricedRequests: 0,
			totalPremiumRequests: 0,
			avgDuration: null,
			avgTtft: null,
			avgTokensPerSecond: null,
			firstTimestamp: 0,
			lastTimestamp: 0,
		};
	}

	const row = rows[0];
	const totalRequests = row.total_requests || 0;
	const failedRequests = row.failed_requests || 0;
	const successfulRequests = totalRequests - failedRequests;
	const totalInputTokens = row.total_input_tokens || 0;
	const totalCacheReadTokens = row.total_cache_read_tokens || 0;
	const totalPremiumRequests = row.total_premium_requests || 0;
	const noCacheInputCost = row.total_no_cache_input_cost || 0;
	const cachedPromptCost = row.total_cached_prompt_cost || 0;

	return {
		totalRequests,
		successfulRequests,
		failedRequests,
		errorRate: totalRequests > 0 ? failedRequests / totalRequests : 0,
		totalInputTokens,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		cacheRate:
			totalInputTokens + totalCacheReadTokens > 0
				? totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)
				: 0,
		cacheSavings: noCacheInputCost > 0 ? (noCacheInputCost - cachedPromptCost) / noCacheInputCost : 0,
		totalCost: row.total_cost || 0,
		unpricedRequests: row.unpriced_requests || 0,
		totalPremiumRequests,
		avgDuration: row.avg_duration,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
		firstTimestamp: row.first_timestamp || 0,
		lastTimestamp: row.last_timestamp || 0,
	};
}

/**
 * Get overall aggregated stats.
 */
export function getOverallStats(cutoff?: number): AggregatedStats {
	if (!db) return buildAggregatedStats([]);

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			SUM(${UNPRICED_XAI_OAUTH_SQL}) as unpriced_requests,
			SUM(CASE WHEN cost_no_cache_input > 0
				THEN cost_input + cost_cache_read + cost_cache_write
				ELSE 0 END) as total_cached_prompt_cost,
			SUM(cost_no_cache_input) as total_no_cache_input_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`);

	const rows = hasCutoff ? stmt.all(cutoff) : stmt.all();
	return buildAggregatedStats(rows as AggregatedStatsRow[]);
}
/**
 * Get stats grouped by model.
 */
export function getStatsByModel(cutoff?: number): ModelStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			model,
			provider,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			SUM(${UNPRICED_XAI_OAUTH_SQL}) as unpriced_requests,
			SUM(CASE WHEN cost_no_cache_input > 0
				THEN cost_input + cost_cache_read + cost_cache_write
				ELSE 0 END) as total_cached_prompt_cost,
			SUM(cost_no_cache_input) as total_no_cache_input_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_requests DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ModelStatsRow[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get stats grouped by folder.
 */
export function getStatsByFolder(cutoff?: number): FolderStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			folder,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(premium_requests) as total_premium_requests,
			SUM(cost_total) as total_cost,
			SUM(${UNPRICED_XAI_OAUTH_SQL}) as unpriced_requests,
			SUM(CASE WHEN cost_no_cache_input > 0
				THEN cost_input + cost_cache_read + cost_cache_write
				ELSE 0 END) as total_cached_prompt_cost,
			SUM(cost_no_cache_input) as total_no_cache_input_cost,
			AVG(duration) as avg_duration,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY folder
		ORDER BY total_requests DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as FolderStatsRow[];
	return rows.map(row => ({
		folder: row.folder,
		...buildAggregatedStats([row]),
	}));
}

/**
 * Get token usage grouped by agent type (main agent, task subagents, advisor).
 * Token columns are explicit so the dashboard's share denominator matches the
 * counts it renders. Rows missing `agent_type` (defensive) fall back to "main".
 */
export function getStatsByAgentType(cutoff?: number): AgentTypeStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			agent_type,
			COUNT(*) as total_requests,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(cost_total) as total_cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY agent_type
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as any[];
	return rows.map(row => ({
		agentType: (row.agent_type as AgentType) ?? "main",
		totalRequests: row.total_requests || 0,
		totalInputTokens: row.total_input_tokens || 0,
		totalOutputTokens: row.total_output_tokens || 0,
		totalCacheReadTokens: row.total_cache_read_tokens || 0,
		totalCacheWriteTokens: row.total_cache_write_tokens || 0,
		totalCost: row.total_cost || 0,
	}));
}

/**
 * Get time series data.
 */
export function getTimeSeries(hours = 24, cutoff?: number | null, bucketMs = 60 * 60 * 1000): TimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - hours * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			COUNT(*) as requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as errors,
			SUM(total_tokens) as tokens,
			SUM(cost_total) as cost
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket
		ORDER BY bucket ASC
	`);

	const rows = hasCutoff
		? (stmt.all(bucketMs, bucketMs, seriesCutoff) as any[])
		: (stmt.all(bucketMs, bucketMs) as any[]);
	return rows.map(row => ({
		timestamp: row.bucket,
		requests: row.requests,
		errors: row.errors,
		tokens: row.tokens,
		cost: row.cost,
	}));
}

/**
 * Get daily performance time series data for the last N days.
 */
/**
 * Get daily model usage time series data for the last N days.
 */
export function getModelTimeSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ModelTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			model,
			provider,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{ bucket: number; model: string; provider: string; requests: number }>;
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
	}));
}

/**
 * Get request/token/cost totals grouped by provider.
 */
export function getStatsByProvider(cutoff?: number | null): ProviderAggregate[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff !== null && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			provider,
			COUNT(*) as total_requests,
			SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) as failed_requests,
			COUNT(DISTINCT model) as models,
			SUM(input_tokens) as total_input_tokens,
			SUM(output_tokens) as total_output_tokens,
			SUM(cache_read_tokens) as total_cache_read_tokens,
			SUM(cache_write_tokens) as total_cache_write_tokens,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
			SUM(cost_total) as total_cost,
			SUM(${UNPRICED_XAI_OAUTH_SQL}) as unpriced_requests,
			SUM(premium_requests) as total_premium_requests,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY provider
		ORDER BY total_tokens DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as Array<{
		provider: string;
		total_requests: number;
		failed_requests: number;
		models: number;
		total_input_tokens: number | null;
		total_output_tokens: number | null;
		total_cache_read_tokens: number | null;
		total_cache_write_tokens: number | null;
		total_tokens: number | null;
		total_cost: number | null;
		unpriced_requests: number | null;
		total_premium_requests: number | null;
		avg_tokens_per_second: number | null;
	}>;
	return rows.map(row => ({
		provider: row.provider,
		totalRequests: row.total_requests,
		failedRequests: row.failed_requests,
		models: row.models,
		totalInputTokens: row.total_input_tokens ?? 0,
		totalOutputTokens: row.total_output_tokens ?? 0,
		totalCacheReadTokens: row.total_cache_read_tokens ?? 0,
		totalCacheWriteTokens: row.total_cache_write_tokens ?? 0,
		totalTokens: row.total_tokens ?? 0,
		totalCost: row.total_cost ?? 0,
		unpricedRequests: row.unpriced_requests ?? 0,
		totalPremiumRequests: row.total_premium_requests ?? 0,
		avgTokensPerSecond: row.avg_tokens_per_second,
	}));
}

/**
 * Get token burn grouped by provider and local hour of day (0-23).
 * Hours use the server's timezone — the dashboard is a localhost tool, so
 * server-local and viewer-local time coincide.
 */
export function getProviderHourlyBurn(cutoff?: number | null): ProviderHourlyPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff !== null && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			provider,
			CAST(strftime('%H', timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) as hour,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
			SUM(output_tokens) as output_tokens,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY provider, hour
		ORDER BY provider, hour
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as Array<{
		provider: string;
		hour: number;
		total_tokens: number | null;
		output_tokens: number | null;
		requests: number;
	}>;
	return rows.map(row => ({
		provider: row.provider,
		hour: row.hour,
		totalTokens: row.total_tokens ?? 0,
		outputTokens: row.output_tokens ?? 0,
		requests: row.requests,
	}));
}

/**
 * Get token/cost time series grouped by provider (bucketed like the model series).
 */
export function getProviderTimeSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ProviderTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			provider,
			SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) as total_tokens,
			SUM(cost_total) as cost,
			SUM(${UNPRICED_XAI_OAUTH_SQL}) as unpriced_requests,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{
		bucket: number;
		provider: string;
		total_tokens: number | null;
		cost: number | null;
		unpriced_requests: number | null;
		requests: number;
	}>;
	return rows.map(row => ({
		timestamp: row.bucket,
		provider: row.provider,
		totalTokens: row.total_tokens ?? 0,
		cost: row.cost ?? 0,
		unpricedRequests: row.unpriced_requests ?? 0,
		requests: row.requests,
	}));
}

/**
 * Get daily model performance time series data for the last N days.
 */
export function getModelPerformanceSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ModelPerformancePoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			model,
			provider,
			COUNT(*) as requests,
			AVG(ttft) as avg_ttft,
			AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration ELSE NULL END) as avg_tokens_per_second
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{
		bucket: number;
		model: string;
		provider: string;
		requests: number;
		avg_ttft: number | null;
		avg_tokens_per_second: number | null;
	}>;
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		requests: row.requests,
		avgTtft: row.avg_ttft,
		avgTokensPerSecond: row.avg_tokens_per_second,
	}));
}

/**
 * Get total message count.
 */
export function getMessageCount(): number {
	if (!db) return 0;
	const stmt = db.prepare("SELECT COUNT(*) as count FROM messages");
	const row = stmt.get() as { count: number };
	return row.count;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

function rowToMessageStats(row: any): MessageStats {
	return {
		id: row.id,
		sessionFile: row.session_file,
		entryId: row.entry_id,
		folder: row.folder,
		model: row.model,
		provider: row.provider,
		api: row.api,
		timestamp: row.timestamp,
		duration: row.duration,
		ttft: row.ttft,
		stopReason: row.stop_reason as any,
		errorMessage: row.error_message,
		usage: {
			input: row.input_tokens,
			output: row.output_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_write_tokens,
			totalTokens: row.total_tokens,
			premiumRequests: row.premium_requests ?? 0,
			cost: {
				input: row.cost_input,
				output: row.cost_output,
				cacheRead: row.cost_cache_read,
				cacheWrite: row.cost_cache_write,
				total: row.cost_total,
			},
		},
		agentType: (row.agent_type as AgentType) ?? "main",
	};
}

export function getRecentRequests(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT * FROM messages 
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return (stmt.all(limit) as any[]).map(rowToMessageStats);
}

export function getRecentErrors(limit = 100, cutoff?: number | null): MessageStats[] {
	if (!db) return [];
	const hasCutoff = cutoff !== undefined && cutoff !== null;
	const stmt = db.prepare(`
		SELECT * FROM messages
		WHERE stop_reason = 'error'
		${hasCutoff ? "AND timestamp >= ?" : ""}
		ORDER BY timestamp DESC
		LIMIT ?
	`);
	const rows = hasCutoff ? stmt.all(cutoff, limit) : stmt.all(limit);
	return rows.map(rowToMessageStats);
}

export function getMessageById(id: number): MessageStats | null {
	if (!db) return null;
	const stmt = db.prepare("SELECT * FROM messages WHERE id = ?");
	const row = stmt.get(id);
	return row ? rowToMessageStats(row) : null;
}
/** Per-transcript-file rollup for the Traces session list. */
export interface SessionRollupRow {
	sessionFile: string;
	requests: number;
	startedAt: number;
	endedAt: number;
	totalTokens: number;
	costTotal: number;
	/** Comma-joined DISTINCT models. */
	models: string;
}

/** Aggregate every synced transcript file into one row (subagents unfolded). */
export function getSessionRollups(): SessionRollupRow[] {
	if (!db) return [];
	const stmt = db.prepare(`
		SELECT session_file AS sessionFile,
		       COUNT(*) AS requests,
		       MIN(timestamp) AS startedAt,
		       MAX(timestamp + COALESCE(duration, 0)) AS endedAt,
		       SUM(total_tokens) AS totalTokens,
		       SUM(cost_total) AS costTotal,
		       GROUP_CONCAT(DISTINCT model) AS models
		FROM messages
		GROUP BY session_file
	`);
	return stmt.all() as SessionRollupRow[];
}

/** Tool-call counts keyed by transcript file, for the Traces session list. */
export function getToolCallCountsBySession(): Map<string, number> {
	const counts = new Map<string, number>();
	if (!db) return counts;
	const stmt = db.prepare(
		"SELECT session_file AS sessionFile, COUNT(*) AS calls FROM tool_calls GROUP BY session_file",
	);
	for (const row of stmt.all() as Array<{ sessionFile: string; calls: number }>) {
		counts.set(row.sessionFile, row.calls);
	}
	return counts;
}

/**
 * Get daily cost time series data for the last N days, broken down by model.
 */
export function getCostTimeSeries(days = 90, cutoff?: number | null): CostTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			model,
			provider,
			SUM(cost_total) as cost,
			SUM(${UNPRICED_XAI_OAUTH_SQL}) as unpriced_requests,
			SUM(cost_input) as cost_input,
			SUM(cost_output) as cost_output,
			SUM(cost_cache_read) as cost_cache_read,
			SUM(cost_cache_write) as cost_cache_write,
			COUNT(*) as requests
		FROM messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);

	const rows = (hasCutoff ? stmt.all(seriesCutoff) : stmt.all()) as CostTimeSeriesRow[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		cost: row.cost ?? 0,
		unpricedRequests: row.unpriced_requests ?? 0,
		costInput: row.cost_input ?? 0,
		costOutput: row.cost_output ?? 0,
		costCacheRead: row.cost_cache_read ?? 0,
		costCacheWrite: row.cost_cache_write ?? 0,
		requests: row.requests,
	}));
}

/**
 * Reset `file_offsets` (and any existing `user_messages` rows) so the next
 * successful sync re-parses every session and re-derives behavioral metrics.
 * Run once per metric-definition bump; the meta sentinel is only marked
 * complete after `syncAllSessions` finishes. Older timestamp sentinel values
 * are treated as pending so a failed compiled-binary sync cannot permanently
 * suppress the backfill.
 *
 * - v1: initial introduction of `user_messages`.
 * - v2: yelling-sentence metric replaces caps-word counts; existing rows are
 *   computed under the old definition and must be discarded.
 * - v3: drama runs collapsed into `anguish` (drama + elongated interjections
 *   + `dude` + dot runs), scored on a stripped prose body and gated on
 *   line count. Existing rows used the narrower definition.
 * - v4: added `negation` / `repetition` / `blame` signals and fixed a
 *   latent word-boundary bug in the profanity / anguish regexes that had
 *   left those metrics matching nothing in real prose.
 * - v5: renamed `yelling_sentences` column to `yelling` to match the other
 *   single-word signal columns (profanity, anguish, negation, ...).
 * - v6: dropped `git` from the profanity word list - it collided with the
 *   version-control tool name, so existing rows over-counted profanity.
 * - v7: false-positive trim measured against the real corpus: dot runs
 *   (`..`/`...`) no longer count as anguish; profanity list dropped
 *   technical-collision words (`dummy`, `blast`, `knob`, `trash`, `crud`,
 *   `garbage`, ...), opinion/dislike words (`useless`, `awful`, `hate`,
 *   `meh`, ...) and moved `ugh`/`argh`/`grr` interjections to anguish;
 *   yelling now requires multi-word caps (filenames like `AGENTS.md` no
 *   longer fragment into all-caps sentences); bare leading `no` only
 *   counts as negation when used as an interjection, not a determiner.
 * - v8: `no-op`-style compounds no longer count as corrective negation
 *   (hyphen after bare `no` only counts as a separator when it isn't
 *   gluing a compound word), and three measured false-negative clusters
 *   were recovered: sad emoticons (`:(`) score anguish, `why (would|did)
 *   you` scores blame, `makes (no|zero) sense` scores negation. v7
 *   shipped briefly without these, so any database that completed the v7
 *   backfill needs one more re-derive.
 *
 * Existing `messages` rows are unaffected - `INSERT OR IGNORE` keeps them.
 */
function backfillUserMessages(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(USER_MESSAGES_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM user_messages");
	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(USER_MESSAGES_BACKFILL_KEY, BACKFILL_PENDING);
}

/**
 * One-shot wipe of `tool_calls` + `file_offsets` when the `tool_calls` table
 * is introduced (or its schema version bumps), so the next sync re-parses
 * every session and ingests historical tool calls. `messages` and
 * `user_messages` re-inserts are idempotent, so the offset reset is safe.
 * Same sentinel protocol as {@link backfillUserMessages}: the PENDING value
 * written here prevents re-wiping on subsequent inits.
 */
function backfillToolCalls(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(TOOL_CALLS_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM tool_calls");
	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(TOOL_CALLS_BACKFILL_KEY, BACKFILL_PENDING);
}

/**
 * One-shot `file_offsets` wipe so the next sync re-parses every session and
 * re-prices `messages` from source. Pre-fix ingests priced subscription rows
 * from the four stored token buckets only, dropping `Usage.orchestration`
 * (never a stored column), so multi-agent Grok and any other orchestration-
 * billed model were understated and could not reach the inclusive 200K tier.
 * The re-parse reruns the orchestration-aware pricing in `resolveStoredCost`
 * and the cost-refreshing UPSERT in {@link insertMessageStats} writes it back.
 * `messages`/`user_messages`/`tool_calls` re-inserts are idempotent, so the
 * offset reset is safe. Same sentinel protocol as {@link backfillToolCalls}.
 */
function backfillReingestCosts(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(COST_REINGEST_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(COST_REINGEST_BACKFILL_KEY, BACKFILL_PENDING);
}

/**
 * Reclassify pre-existing `messages` rows by agent type once, after the
 * `agent_type` column is added to an older database (every prior row defaulted
 * to 'main' on the ALTER). Classification is purely path-based — derived from
 * the stored `session_file` — so no session re-parse is needed. Idempotent and
 * crash-safe: enrolled (PENDING) only at migration time in {@link initDb} and
 * marked COMPLETE inside the same transaction that applies the updates, so an
 * interrupted run rolls back and retries on the next init.
 */
function backfillAgentType(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(AGENT_TYPE_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (row?.value !== BACKFILL_PENDING) return;

	const sessionFiles = database.prepare("SELECT DISTINCT session_file FROM messages").all() as {
		session_file: string;
	}[];
	const update = database.prepare("UPDATE messages SET agent_type = ? WHERE session_file = ?");
	const markComplete = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
	const apply = database.transaction(() => {
		for (const { session_file } of sessionFiles) {
			const agentType = classifyAgentType(session_file);
			// Rows already default to 'main'; only the nested transcripts move.
			if (agentType !== "main") update.run(agentType, session_file);
		}
		markComplete.run(AGENT_TYPE_BACKFILL_KEY, BACKFILL_COMPLETE);
	});
	apply();
}

/**
 * One-shot collapse of forked-session duplicates that landed under the old
 * `UNIQUE(session_file, entry_id)`-only invariant. `SessionManager.fork()`
 * and `createBranchedSession()` deep-copy a parent's entries into the new
 * JSONL — same `entry_id`, `timestamp`, `model`, `responseId`, token counts,
 * cost — and the previous insert path counted both files toward request /
 * token / cost totals. The migration keeps the lowest-`id` row per
 * `(entry_id, timestamp)` group (almost always the parent — sessions are
 * filename-timestamped and sync processes them in name order, so the
 * originating file lands first) and drops every other copy. Same fix on
 * `user_messages` since forks copy user entries too. Idempotent and
 * crash-safe: enrolled at module-load via the `meta` sentinel, marked
 * COMPLETE inside the same transaction so an aborted run rolls back and
 * retries on the next init.
 */
function backfillForkDuplicates(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(FORK_DEDUPE_KEY) as
		| { value: string }
		| undefined;
	if (row?.value === BACKFILL_COMPLETE) return;

	const markComplete = database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
	const apply = database.transaction(() => {
		database.run(`
			DELETE FROM messages
			WHERE id NOT IN (
				SELECT MIN(id) FROM messages GROUP BY entry_id, timestamp
			)
		`);
		database.run(`
			DELETE FROM user_messages
			WHERE id NOT IN (
				SELECT MIN(id) FROM user_messages GROUP BY entry_id, timestamp
			)
		`);
		markComplete.run(FORK_DEDUPE_KEY, BACKFILL_COMPLETE);
	});
	apply();
}

/**
 * One-shot wipe of `file_offsets` to force `parseSessionFile` to re-parse
 * every session from byte zero. We don't touch `user_messages`; the parser
 * now emits a `UserMessageLink` for every assistant->parent pair, and the
 * guarded `updateUserMessageLinks` UPDATE fixes any row whose `model` was
 * left NULL by the old in-pass-only linking logic. Idempotent: gated by a
 * sentinel row in `meta`.
 */
function repairUserMessageLinks(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(USER_MESSAGE_LINKS_REPAIR_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(USER_MESSAGE_LINKS_REPAIR_KEY, BACKFILL_PENDING);
}

/**
 * One-shot wipe of `file_offsets` so the next sync re-parses every session
 * and re-derives `premium_requests` from recorded `service_tier_change`
 * entries. Earlier ingestions captured priority OpenAI traffic with
 * `premium_requests = 0` because the AI layer only set the field for GitHub
 * Copilot traffic. The parser now folds priority requests into the same
 * counter; combined with the UPSERT in `insertMessageStats`, a single sync
 * pass brings the messages table up to date without touching any other
 * column. Idempotent: gated by a sentinel row in `meta`.
 */
function backfillPriorityPremiumRequests(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY, BACKFILL_PENDING);
}

/**
 * Settle every full-session backfill after a successful sync pass.
 */
export function markSessionBackfillsComplete(): void {
	if (!db) return;
	const markComplete = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
	const apply = db.transaction(() => {
		for (const key of [
			USER_MESSAGES_BACKFILL_KEY,
			TOOL_CALLS_BACKFILL_KEY,
			USER_MESSAGE_LINKS_REPAIR_KEY,
			PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY,
			COST_REINGEST_BACKFILL_KEY,
		]) {
			markComplete.run(key, BACKFILL_COMPLETE);
		}
	});
	apply();
}

/**
 * Insert user-message stats. Idempotent via UNIQUE(session_file, entry_id).
 * The `WHERE NOT EXISTS` clause matches {@link insertMessageStats}: forks
 * copy user entries verbatim into the child JSONL, so the same
 * `(entry_id, timestamp)` must not land twice across different session files.
 */
export function insertUserMessageStats(stats: UserMessageStats[]): number {
	if (!db || stats.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT OR IGNORE INTO user_messages (
			session_file, entry_id, folder, timestamp, model, provider,
			chars, words, yelling, profanity, anguish,
			negation, repetition, blame
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM user_messages
			WHERE entry_id = ? AND timestamp = ? AND session_file <> ?
		)
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const result = stmt.run(
				s.sessionFile,
				s.entryId,
				s.folder,
				s.timestamp,
				s.model,
				s.provider,
				s.chars,
				s.words,
				s.yelling,
				s.profanity,
				s.anguish,
				s.negation,
				s.repetition,
				s.blame,
				// `WHERE NOT EXISTS` binds: skip when a different session_file
				// already holds this (entry_id, timestamp).
				s.entryId,
				s.timestamp,
				s.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

/**
 * Backfill the responding `model`/`provider` on user-message rows that were
 * persisted before their assistant reply was parsed (a side effect of
 * incremental `fromOffset` syncing: the `userByEntryId` map in
 * `parseSessionFile` only spans a single pass). Each row is updated at most
 * once because the `model IS NULL` guard short-circuits subsequent passes.
 *
 * Returns the number of rows actually updated.
 */
export function updateUserMessageLinks(links: UserMessageLink[]): number {
	if (!db || links.length === 0) return 0;

	const stmt = db.prepare(`
		UPDATE user_messages
		   SET model = ?, provider = ?
		 WHERE session_file = ? AND entry_id = ? AND model IS NULL
	`);

	let updated = 0;
	const apply = db.transaction(() => {
		for (const link of links) {
			const result = stmt.run(link.model, link.provider, link.sessionFile, link.entryId);
			if (result.changes > 0) updated++;
		}
	});
	apply();
	return updated;
}

const UNKNOWN_MODEL = "unknown";

interface BehaviorSeriesRow {
	bucket: number;
	model: string;
	provider: string;
	messages: number;
	yelling: number | null;
	profanity: number | null;
	anguish: number | null;
	negation: number | null;
	repetition: number | null;
	blame: number | null;
	chars: number | null;
}

/**
 * Daily behavioral time series, grouped by responding model+provider.
 */
export function getBehaviorTimeSeries(cutoff?: number | null): BehaviorTimeSeriesPoint[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			(timestamp / 86400000) * 86400000 as bucket,
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as messages,
			SUM(yelling) as yelling,
			SUM(profanity) as profanity,
			SUM(anguish) as anguish,
			SUM(negation) as negation,
			SUM(repetition) as repetition,
			SUM(blame) as blame,
			SUM(chars) as chars
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, model, provider
		ORDER BY bucket ASC
	`);
	const rows = (
		hasCutoff ? stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff) : stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL)
	) as BehaviorSeriesRow[];
	return rows.map(row => ({
		timestamp: row.bucket,
		model: row.model,
		provider: row.provider,
		messages: row.messages,
		yelling: row.yelling ?? 0,
		profanity: row.profanity ?? 0,
		anguish: row.anguish ?? 0,
		negation: row.negation ?? 0,
		repetition: row.repetition ?? 0,
		blame: row.blame ?? 0,
		chars: row.chars ?? 0,
	}));
}

interface BehaviorOverallRow {
	total_messages: number;
	total_yelling: number | null;
	total_profanity: number | null;
	total_anguish: number | null;
	total_negation: number | null;
	total_repetition: number | null;
	total_blame: number | null;
	total_chars: number | null;
	first_timestamp: number | null;
	last_timestamp: number | null;
}

/**
 * Overall behavioral totals across the cutoff window.
 */
export function getBehaviorOverall(cutoff?: number | null): BehaviorOverallStats {
	const empty: BehaviorOverallStats = {
		totalMessages: 0,
		totalYelling: 0,
		totalProfanity: 0,
		totalAnguish: 0,
		totalNegation: 0,
		totalRepetition: 0,
		totalBlame: 0,
		totalChars: 0,
		firstTimestamp: 0,
		lastTimestamp: 0,
	};
	if (!db) return empty;
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MIN(timestamp) as first_timestamp,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
	`);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as BehaviorOverallRow | undefined;
	if (!row?.total_messages) return empty;
	return {
		totalMessages: row.total_messages,
		totalYelling: row.total_yelling ?? 0,
		totalProfanity: row.total_profanity ?? 0,
		totalAnguish: row.total_anguish ?? 0,
		totalNegation: row.total_negation ?? 0,
		totalRepetition: row.total_repetition ?? 0,
		totalBlame: row.total_blame ?? 0,
		totalChars: row.total_chars ?? 0,
		firstTimestamp: row.first_timestamp ?? 0,
		lastTimestamp: row.last_timestamp ?? 0,
	};
}

interface BehaviorByModelRow {
	model: string;
	provider: string;
	total_messages: number;
	total_yelling: number | null;
	total_profanity: number | null;
	total_anguish: number | null;
	total_negation: number | null;
	total_repetition: number | null;
	total_blame: number | null;
	total_chars: number | null;
	last_timestamp: number | null;
}

/**
 * Per-model behavioral totals over the cutoff window. "Unknown" represents
 * user messages that never received an assistant reply.
 */
export function getBehaviorByModel(cutoff?: number | null): BehaviorModelStats[] {
	if (!db) return [];
	const hasCutoff = cutoff !== null && cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT
			COALESCE(model, ?) as model,
			COALESCE(provider, ?) as provider,
			COUNT(*) as total_messages,
			SUM(yelling) as total_yelling,
			SUM(profanity) as total_profanity,
			SUM(anguish) as total_anguish,
			SUM(negation) as total_negation,
			SUM(repetition) as total_repetition,
			SUM(blame) as total_blame,
			SUM(chars) as total_chars,
			MAX(timestamp) as last_timestamp
		FROM user_messages
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY model, provider
		ORDER BY total_messages DESC
	`);
	const rows = (
		hasCutoff ? stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL, cutoff) : stmt.all(UNKNOWN_MODEL, UNKNOWN_MODEL)
	) as BehaviorByModelRow[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		totalMessages: row.total_messages,
		totalYelling: row.total_yelling ?? 0,
		totalProfanity: row.total_profanity ?? 0,
		totalAnguish: row.total_anguish ?? 0,
		totalNegation: row.total_negation ?? 0,
		totalRepetition: row.total_repetition ?? 0,
		totalBlame: row.total_blame ?? 0,
		totalChars: row.total_chars ?? 0,
		lastTimestamp: row.last_timestamp ?? 0,
	}));
}

/**
 * Insert tool-call rows. Idempotent via UNIQUE(session_file, tool_call_id);
 * the `WHERE NOT EXISTS` guard mirrors {@link insertMessageStats}: forked
 * sessions deep-copy assistant entries (same `entry_id`, `timestamp`, and
 * tool-call ids under a new file), so first-write-wins across the lineage
 * keeps aggregates from double counting. Keyed on the assistant entry
 * identity, not the call id alone — provider call ids are not a global
 * namespace across unrelated sessions.
 */
export function insertToolCalls(calls: ToolCallStats[]): number {
	if (!db || calls.length === 0) return 0;

	const stmt = db.prepare(`
		INSERT OR IGNORE INTO tool_calls (
			session_file, entry_id, tool_call_id, folder, tool_name,
			model, provider, timestamp, agent_type, calls_in_turn, args_chars
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM tool_calls
			WHERE entry_id = ? AND timestamp = ? AND tool_call_id = ? AND session_file <> ?
		)
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const c of calls) {
			const result = stmt.run(
				c.sessionFile,
				c.entryId,
				c.toolCallId,
				c.folder,
				c.toolName,
				c.model,
				c.provider,
				c.timestamp,
				c.agentType,
				c.callsInTurn,
				c.argsChars,
				// `WHERE NOT EXISTS` binds: skip when a different session_file
				// already holds this (entry_id, timestamp, tool_call_id).
				c.entryId,
				c.timestamp,
				c.toolCallId,
				c.sessionFile,
			);
			if (result.changes > 0) inserted++;
		}
	});
	insert();
	return inserted;
}

/**
 * Attach result size / error flag to persisted tool-call rows. Results can
 * land in a later incremental sync pass than the call that produced them, so
 * this is an UPDATE keyed by (session_file, tool_call_id). The `IS NULL`
 * guard makes re-syncs idempotent; rows skipped by the fork guard simply
 * never match.
 */
export function updateToolResults(links: ToolResultLink[]): number {
	if (!db || links.length === 0) return 0;

	const stmt = db.prepare(`
		UPDATE tool_calls
		SET result_chars = ?, is_error = ?
		WHERE session_file = ? AND tool_call_id = ? AND result_chars IS NULL
	`);

	let updated = 0;
	const apply = db.transaction(() => {
		for (const link of links) {
			const result = stmt.run(link.resultChars, link.isError ? 1 : 0, link.sessionFile, link.toolCallId);
			updated += result.changes;
		}
	});
	apply();
	return updated;
}

/**
 * Shared SELECT list for tool aggregates. Real provider usage comes from the
 * invoking assistant turn (`messages` join) divided by `calls_in_turn`, so
 * per-tool token/cost shares stay additive across tools.
 */
const TOOL_AGGREGATE_COLUMNS = `
	COUNT(*) as calls,
	SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) as errors,
	SUM(t.args_chars) as args_chars,
	SUM(COALESCE(t.result_chars, 0)) as result_chars,
	SUM(COALESCE(m.total_tokens, 0) * 1.0 / t.calls_in_turn) as total_tokens_share,
	SUM(COALESCE(m.output_tokens, 0) * 1.0 / t.calls_in_turn) as output_tokens_share,
	SUM(COALESCE(m.cost_total, 0) / t.calls_in_turn) as cost_share,
	SUM(CASE WHEN t.provider = 'xai-oauth' AND COALESCE(m.total_tokens, 0) > 0 AND COALESCE(m.cost_total, 0) = 0
		THEN 1.0 / t.calls_in_turn ELSE 0 END) as unpriced_requests_share,
	MAX(t.timestamp) as last_used
`;

interface ToolAggregateRow {
	tool_name: string;
	model?: string;
	provider?: string;
	calls: number;
	errors: number;
	args_chars: number | null;
	result_chars: number | null;
	total_tokens_share: number | null;
	output_tokens_share: number | null;
	cost_share: number | null;
	unpriced_requests_share: number | null;
	last_used: number;
}

function rowToToolUsage(row: ToolAggregateRow): ToolUsageStats {
	return {
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
		argsChars: row.args_chars ?? 0,
		resultChars: row.result_chars ?? 0,
		totalTokensShare: row.total_tokens_share ?? 0,
		outputTokensShare: row.output_tokens_share ?? 0,
		costShare: row.cost_share ?? 0,
		unpricedRequestsShare: row.unpriced_requests_share ?? 0,
		lastUsed: row.last_used,
	};
}

/**
 * Get tool usage aggregated by tool name.
 */
export function getToolStats(cutoff?: number): ToolUsageStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT t.tool_name, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name
		ORDER BY calls DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ToolAggregateRow[];
	return rows.map(rowToToolUsage);
}

/**
 * Get tool usage aggregated by (tool, model, provider).
 */
export function getToolStatsByModel(cutoff?: number): ToolModelStats[] {
	if (!db) return [];

	const hasCutoff = cutoff !== undefined && cutoff > 0;
	const stmt = db.prepare(`
		SELECT t.tool_name, t.model, t.provider, ${TOOL_AGGREGATE_COLUMNS}
		FROM tool_calls t
		LEFT JOIN messages m ON m.session_file = t.session_file AND m.entry_id = t.entry_id
		${hasCutoff ? "WHERE t.timestamp >= ?" : ""}
		GROUP BY t.tool_name, t.model, t.provider
		ORDER BY calls DESC
	`);

	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as ToolAggregateRow[];
	return rows.map(row => ({
		...rowToToolUsage(row),
		model: row.model ?? "",
		provider: row.provider ?? "",
	}));
}

/**
 * Get tool-call time series (one point per bucket per tool).
 */
export function getToolTimeSeries(
	days = 14,
	cutoff?: number | null,
	bucketMs = 24 * 60 * 60 * 1000,
): ToolTimeSeriesPoint[] {
	if (!db) return [];

	const hasCutoff = cutoff !== null;
	const seriesCutoff = hasCutoff ? (cutoff ?? Date.now() - days * 24 * 60 * 60 * 1000) : 0;

	const stmt = db.prepare(`
		SELECT
			(timestamp / ?) * ? as bucket,
			tool_name,
			COUNT(*) as calls,
			SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors
		FROM tool_calls
		${hasCutoff ? "WHERE timestamp >= ?" : ""}
		GROUP BY bucket, tool_name
		ORDER BY bucket ASC
	`);

	const rowsRaw = hasCutoff ? stmt.all(bucketMs, bucketMs, seriesCutoff) : stmt.all(bucketMs, bucketMs);
	const rows = rowsRaw as Array<{ bucket: number; tool_name: string; calls: number; errors: number }>;
	return rows.map(row => ({
		timestamp: row.bucket,
		tool: row.tool_name,
		calls: row.calls,
		errors: row.errors,
	}));
}
