import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type { ServiceTier, Usage } from "@oh-my-pi/pi-ai";
import {
	calculateUncachedInputCost,
	calculateUsageCost,
	type GeneratedProvider,
	getBundledModel,
} from "@oh-my-pi/pi-catalog/models";
import type { ModelCost } from "@oh-my-pi/pi-catalog/types";
import { getConfigRootDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import { classifyAgentType, type ParseSessionResult, type SessionParserState } from "./parser";
import { ensureRollupSchema } from "./rollup";
import type {
	AgentType,
	DailyActivityPoint,
	FrustrationCounts,
	MessageStats,
	MessageStatsInput,
	ToolCallStats,
	ToolResultLink,
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

/**
 * Predicate counting one stored request as "unpriced" — the public rate card
 * has no charge for it, so its zero is unknown spend rather than free usage.
 * Two shapes store that zero:
 *   - `xai-oauth` bills through the SuperGrok subscription, so ingestion
 *     deliberately records no per-request price;
 *   - `cost_unpriced = 1`, set by `insertMessageStats` when `resolveStoredCost`
 *     refuses to price a scheduled (time-based) card whose entry carried no
 *     recoverable request timestamp — the epoch would silently become the
 *     tariff. Such a row keeps its real tokens and its zero until a re-parse
 *     recovers the time.
 *
 * Nothing else sets the marker: an explicit recorded zero, a free flat card,
 * and a model with no catalog card at all keep `cost_unpriced = 0` even at the
 * parser's timestamp sentinel, because their zero is a real price.
 * `prefix` qualifies the columns for queries that alias `messages`.
 */
export function unpricedRequestSql(prefix = ""): string {
	return `CASE WHEN ${prefix}total_tokens > 0 AND ${prefix}cost_total = 0
		AND (${prefix}provider = 'xai-oauth' OR ${prefix}cost_unpriced = 1) THEN 1 ELSE 0 END`;
}

interface CostBackfillRow {
	id: number;
	provider: string;
	model: string;
	timestamp: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

interface NoCacheInputCostBackfillRow {
	id: number;
	provider: string;
	model: string;
	timestamp: number;
	input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

let db: Database | null = null;

/** The open stats database, or null before {@link initDb}. Used by the rollup query layer. */
export function currentDb(): Database | null {
	return db;
}

const BACKFILL_COMPLETE = "complete";
const BACKFILL_PENDING = "pending";
const USER_MESSAGES_BACKFILL_KEY = "user_messages_v9";
const USER_MESSAGE_LINKS_REPAIR_KEY = "user_message_links_v1";
// v2: the parser also records the served service tier per message, so a full
// re-parse fills `service_tier` and re-derives ultrafast premium counts that the
// v1 pass (priority only) left at zero.
const PRIORITY_PREMIUM_REQUESTS_BACKFILL_KEY = "premium_requests_priority_v2";
const AGENT_TYPE_BACKFILL_KEY = "agent_type_v1";
const FORK_DEDUPE_KEY = "fork_dedupe_v1";
// v2: tool-name sanitization at ingest (see `sanitizeToolName` in parser.ts)
// collapses provider-side garbage names; a full re-parse replaces the polluted
// rows already stored in existing databases.
const TOOL_CALLS_BACKFILL_KEY = "tool_calls_v2";
// Older ingests dropped `Usage.orchestration` (never a stored column) when
// pricing, so subscription models billed on orchestration tokens — multi-agent
// Grok most notably — were priced from conversation buckets alone and could not
// reach the inclusive 200K tier. A one-time full re-parse repairs them through
// the cost-refreshing UPSERT in `insertMessageStats`.
const COST_REINGEST_BACKFILL_KEY = "messages_cost_reingest_v1";
// The absence-aware `resolveStoredCost` and the `cost_unpriced` marker only
// reach already-ingested rows through a re-parse, and the reingest sentinel
// above is already spent for them — without this one, every historical row
// keeps `cost_unpriced = 0` and unknown scheduled spend reports as free.
const COST_UNPRICED_BACKFILL_KEY = "messages_cost_unpriced_v1";
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
			cost_unpriced INTEGER NOT NULL DEFAULT 0,
			agent_type TEXT NOT NULL DEFAULT 'main',
			service_tier TEXT,
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_entry_timestamp ON messages(entry_id, timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_folder ON messages(timestamp, folder);
		CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL,
			parser_state TEXT
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
			prose TEXT NOT NULL DEFAULT '',
			prose_hash TEXT NOT NULL DEFAULT '',
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
		CREATE INDEX IF NOT EXISTS idx_user_messages_entry_timestamp ON user_messages(entry_id, timestamp);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);

		-- Judge verdicts keyed by prose hash: identical messages share one verdict,
		-- and verdicts outlive user_messages re-parses. No backfill wipes this table.
		CREATE TABLE IF NOT EXISTS frustration_verdicts (
			prose_hash TEXT PRIMARY KEY,
			p_annoyed REAL NOT NULL,
			p_angry REAL NOT NULL,
			target TEXT NOT NULL,
			judge TEXT NOT NULL,
			judged_at INTEGER NOT NULL
		);

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
		CREATE INDEX IF NOT EXISTS idx_tool_calls_entry_timestamp ON tool_calls(entry_id, timestamp);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	const offsetColumns = db.prepare("PRAGMA table_info(file_offsets)").all() as { name: string }[];
	if (!offsetColumns.some(column => column.name === "parser_state")) {
		db.run("ALTER TABLE file_offsets ADD COLUMN parser_state TEXT");
	}
	const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
	if (!messageColumns.some(column => column.name === "premium_requests")) {
		db.run("ALTER TABLE messages ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0");
	}
	if (!messageColumns.some(column => column.name === "cost_no_cache_input")) {
		db.run("ALTER TABLE messages ADD COLUMN cost_no_cache_input REAL");
	}
	// Rows ingested before this column existed carry no served tier; a re-parse
	// fills them from the session's assistant messages.
	if (!messageColumns.some(column => column.name === "service_tier")) {
		db.run("ALTER TABLE messages ADD COLUMN service_tier TEXT");
	}
	// Rows ingested before this column existed default to 0 (not unpriced), so
	// their epoch-sentinel zeros read as free until a re-parse rewrites them.
	if (!messageColumns.some(column => column.name === "cost_unpriced")) {
		db.run("ALTER TABLE messages ADD COLUMN cost_unpriced INTEGER NOT NULL DEFAULT 0");
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
				prose TEXT NOT NULL DEFAULT '',
				prose_hash TEXT NOT NULL DEFAULT '',
				UNIQUE(session_file, entry_id)
			);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp ON user_messages(timestamp);
			CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);
		`);
	} else if (!userMessageColumns.some(column => column.name === "prose")) {
		// v9 judge prose: the backfill below clears the rows, so defaults are
		// only placeholders until the re-parse repopulates them.
		db.run("ALTER TABLE user_messages ADD COLUMN prose TEXT NOT NULL DEFAULT ''");
		db.run("ALTER TABLE user_messages ADD COLUMN prose_hash TEXT NOT NULL DEFAULT ''");
	}
	db.run("CREATE INDEX IF NOT EXISTS idx_user_messages_prose_hash ON user_messages(prose_hash)");
	backfillUserMessages(db);
	backfillToolCalls(db);
	backfillReingestCosts(db);
	backfillUnpricedCosts(db);
	repairUserMessageLinks(db);
	backfillPriorityPremiumRequests(db);
	backfillAgentType(db);
	backfillMissingCatalogCosts(db);
	backfillNoCacheInputCosts(db);
	backfillForkDuplicates(db);
	ensureRollupSchema(db);
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

/** Whether the catalog prices this model on a time-based (scheduled) card. */
export function isScheduledCatalogModel(provider: string, modelId: string): boolean {
	return getCatalogCost(provider, modelId)?.timeBased != null;
}

function calculateCatalogCost(
	provider: string,
	modelId: string,
	tokens: CostTokens,
	timestamp: number,
): UsageCost | null {
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
	return calculateUsageCost(cost, usage, timestamp);
}

function normalizeUsageCost(cost: Partial<UsageCost>): UsageCost {
	const input = cost.input ?? 0;
	const output = cost.output ?? 0;
	const cacheRead = cost.cacheRead ?? 0;
	const cacheWrite = cost.cacheWrite ?? 0;
	const total = cost.total ?? input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, total };
}

/**
 * The parser records no timestamp for an entry that carries neither a numeric
 * message timestamp nor a parseable entry timestamp, leaving this sentinel.
 * Pricing such a request from the clock would bill it as a 1970 request.
 */
function hasRequestTimestamp(timestamp: number): boolean {
	return Number.isFinite(timestamp) && timestamp > 0;
}

interface ResolvedCost {
	cost: UsageCost;
	/**
	 * The stored zero is unknown spend rather than a price: a scheduled card
	 * with no recoverable request timestamp to select a tariff from. Persisted
	 * as `cost_unpriced` so the aggregates do not have to infer it.
	 */
	unpriced: boolean;
}

function resolveStoredCost(stats: MessageStatsInput): ResolvedCost {
	// `usage.cost` is absent when the session entry recorded no price at all, and
	// legacy payloads can carry a partially-populated cost object (e.g. only
	// `total`). The messages table declares every cost_* column as REAL NOT NULL,
	// so any missing field must be normalised here before binding into SQLite.
	const raw: Partial<UsageCost> | undefined = stats.usage.cost;
	const storedCost = raw ? normalizeUsageCost(raw) : undefined;
	const catalogCost = getCatalogCost(stats.provider, stats.model);

	// Scheduled prices are frozen per request, including explicitly free usage.
	// Preserve legacy zero-cost subscription correction for unscheduled models.
	if (storedCost && Number.isFinite(storedCost.total) && (storedCost.total !== 0 || catalogCost?.timeBased)) {
		return { cost: storedCost, unpriced: false };
	}

	// Without a request timestamp a scheduled card has no tariff to select, and
	// the epoch would silently become one. Leave the request unpriced; a re-parse
	// of the session file repairs it once the timestamp is recoverable.
	if (!hasRequestTimestamp(stats.timestamp) && catalogCost?.timeBased) {
		return { cost: storedCost ?? ZERO_USAGE_COST, unpriced: true };
	}

	return {
		cost:
			calculateCatalogCost(stats.provider, stats.model, stats.usage, stats.timestamp) ??
			storedCost ??
			ZERO_USAGE_COST,
		unpriced: false,
	};
}

function calculateNoCacheInputCost(
	provider: string,
	modelId: string,
	tokens: CostTokens,
	timestamp: number,
): number | null {
	const cost = getCatalogCost(provider, modelId);
	if (!cost) return null;
	// Mirrors `resolveStoredCost`: an unpriced scheduled request must not report
	// its whole prompt as cache savings just because the clock could be read.
	if (!hasRequestTimestamp(timestamp) && cost.timeBased) return null;
	const promptInputTokens =
		tokens.input +
		tokens.cacheRead +
		tokens.cacheWrite +
		(tokens.orchestration?.input ?? 0) +
		(tokens.orchestration?.cacheRead ?? 0);
	return calculateUncachedInputCost(cost, promptInputTokens, timestamp);
}

function backfillMissingCatalogCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
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
			// A stored zero cannot distinguish missing historical prices from an
			// explicitly free request. Never reprice recorded scheduled usage: a
			// zero ingested for a scheduled card is permanent, because this
			// backfill skips those rows. Re-parsing the session file is the only
			// repair, and it works only once the entry's absent `cost` reaches
			// `resolveStoredCost` as absence rather than as a synthesized zero.
			if (getCatalogCost(row.provider, row.model)?.timeBased) continue;
			const cost = calculateCatalogCost(
				row.provider,
				row.model,
				{
					input: row.input_tokens,
					output: row.output_tokens,
					cacheRead: row.cache_read_tokens,
					cacheWrite: row.cache_write_tokens,
				},
				row.timestamp,
			);

			if (!cost || cost.total === 0) continue;

			update.run(cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total, row.id);
		}
	});

	applyBackfill();
}

function backfillNoCacheInputCosts(database: Database): void {
	const rows = database
		.prepare(`
			SELECT id, provider, model, timestamp, input_tokens, cache_read_tokens, cache_write_tokens
			FROM messages
			WHERE cost_no_cache_input IS NULL
		`)
		.all() as NoCacheInputCostBackfillRow[];
	if (rows.length === 0) return;

	const update = database.prepare("UPDATE messages SET cost_no_cache_input = ? WHERE id = ?");
	const applyBackfill = database.transaction(() => {
		for (const row of rows) {
			const cost = calculateNoCacheInputCost(
				row.provider,
				row.model,
				{
					input: row.input_tokens,
					output: 0,
					cacheRead: row.cache_read_tokens,
					cacheWrite: row.cache_write_tokens,
				},
				row.timestamp,
			);
			update.run(cost ?? 0, row.id);
		}
	});
	applyBackfill();
}

/** Persisted transcript identity and parser cursor used to resume stats ingestion. */
export interface FileOffset {
	offset: number;
	lastModified: number;
	parserState?: SessionParserState;
}

interface FileOffsetRow {
	session_file: string;
	offset: number;
	last_modified: number;
	parser_state: string | null;
}

function decodeFileOffset(row: FileOffsetRow): FileOffset {
	let parserState: SessionParserState | undefined;
	if (row.parser_state) {
		try {
			const state: SessionParserState = JSON.parse(row.parser_state);
			if (state?.version === 1 && state.offset === row.offset) parserState = state;
		} catch {
			/* A missing cursor is reconstructed from the transcript. */
		}
	}
	return { offset: row.offset, lastModified: row.last_modified, parserState };
}

/** Read one persisted cursor for callers inspecting an individual transcript. */
export function getFileOffset(sessionFile: string): FileOffset | null {
	if (!db) return null;
	const row = db
		.query<FileOffsetRow, [string]>(
			"SELECT session_file, offset, last_modified, parser_state FROM file_offsets WHERE session_file = ?",
		)
		.get(sessionFile);
	return row ? decodeFileOffset(row) : null;
}

/** Read a bounded sync work set's cursors with one SQLite snapshot instead of one lookup per file. */
export function getFileOffsets(sessionFiles: string[]): Map<string, FileOffset> {
	const offsets = new Map<string, FileOffset>();
	if (!db || sessionFiles.length === 0) return offsets;
	const placeholders = sessionFiles.map(() => "?").join(",");
	const rows = db
		.query<FileOffsetRow, string[]>(
			`SELECT session_file, offset, last_modified, parser_state FROM file_offsets WHERE session_file IN (${placeholders})`,
		)
		.all(...sessionFiles);
	for (const row of rows) offsets.set(row.session_file, decodeFileOffset(row));
	return offsets;
}

/**
 * Update the stored offset for a session file.
 */
export function setFileOffset(
	sessionFile: string,
	offset: number,
	lastModified: number,
	parserState?: SessionParserState,
): void {
	if (!db) return;

	const stmt = db.query(`
		INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified, parser_state)
		VALUES (?, ?, ?, ?)
	`);
	stmt.run(sessionFile, offset, lastModified, parserState ? JSON.stringify(parserState) : null);
}

/** Parsed transcript queued by the sync loop for an atomic database batch. */
export interface ParsedSession {
	sessionFile: string;
	result: ParseSessionResult;
	rebuild: boolean;
	/** Recover missing rows from a full-history scan without rewriting unchanged records. */
	replay: boolean;
}

function* parsedRows<T>(
	results: ParseSessionResult[],
	select: (result: ParseSessionResult) => Iterable<T>,
): Generator<T> {
	for (const result of results) yield* select(result);
}

/** Commit distinct transcripts' rows, reconciliation state, and cursors together; failure rolls back the batch. */
export function applySessionParseResults(sessions: ParsedSession[]): {
	processed: number;
	files: number;
	reconcile: boolean;
} {
	if (!db) return { processed: 0, files: 0, reconcile: false };
	const database = db;
	return database.transaction(() => {
		let processed = 0;
		let files = 0;
		let reconcile = false;
		const writes: ParseSessionResult[] = [];
		for (const { sessionFile, result, rebuild, replay } of sessions) {
			const parserState = result.parserState;
			if (!parserState) continue;
			let rows = result;
			if (result.reset || rebuild || replay) {
				const messages = database
					.query<{ entry_id: string; timestamp: number }, [string]>(
						"SELECT entry_id, timestamp FROM messages WHERE session_file = ?",
					)
					.all(sessionFile);
				const users = database
					.query<{ entry_id: string; timestamp: number; model: string | null }, [string]>(
						"SELECT entry_id, timestamp, model FROM user_messages WHERE session_file = ?",
					)
					.all(sessionFile);
				const tools = database
					.query<
						{ entry_id: string; timestamp: number; tool_call_id: string; result_chars: number | null },
						[string]
					>("SELECT entry_id, timestamp, tool_call_id, result_chars FROM tool_calls WHERE session_file = ?")
					.all(sessionFile);
				const replace = result.reset || rebuild;
				if (replace) {
					// Only removed owners require another full replay, not an identity-only file replacement.
					if (!reconcile && (messages.length > 0 || users.length > 0 || tools.length > 0)) {
						const retainedMessages = new Set(
							result.stats.map(row => JSON.stringify([row.entryId, row.timestamp])),
						);
						const retainedUsers = new Set(
							result.userStats.map(row => JSON.stringify([row.entryId, row.timestamp])),
						);
						const retainedTools = new Set(
							result.toolCalls.map(row => JSON.stringify([row.entryId, row.timestamp, row.toolCallId])),
						);
						reconcile =
							messages.some(row => !retainedMessages.has(JSON.stringify([row.entry_id, row.timestamp]))) ||
							users.some(row => !retainedUsers.has(JSON.stringify([row.entry_id, row.timestamp]))) ||
							tools.some(
								row => !retainedTools.has(JSON.stringify([row.entry_id, row.timestamp, row.tool_call_id])),
							);
					}
				} else {
					// A reconciliation replay only needs missing rows and unfinished links. Keep stable request
					// IDs and avoid rewriting every table/index for transcripts whose contents did not change.
					const messageById = new Map(messages.map(row => [row.entry_id, row.timestamp]));
					const userById = new Map(users.map(row => [row.entry_id, row]));
					const toolById = new Map(tools.map(row => [row.tool_call_id, row]));
					const absentMessages = new Set(messageById.keys());
					const absentUsers = new Set(userById.keys());
					const absentTools = new Set(toolById.keys());
					const stats = result.stats.filter(row => {
						if (messageById.get(row.entryId) !== row.timestamp) return true;
						absentMessages.delete(row.entryId);
						return false;
					});
					const userStats = result.userStats.filter(row => {
						if (userById.get(row.entryId)?.timestamp !== row.timestamp) return true;
						absentUsers.delete(row.entryId);
						return false;
					});
					const toolCalls = result.toolCalls.filter(row => {
						const stored = toolById.get(row.toolCallId);
						if (stored?.entry_id !== row.entryId || stored.timestamp !== row.timestamp) return true;
						absentTools.delete(row.toolCallId);
						return false;
					});
					rows = {
						...result,
						stats,
						userStats,
						toolCalls,
						// A reused ID needs fresh linkage after its old identity is removed.
						userLinks: result.userLinks.filter(
							row => absentUsers.has(row.entryId) || userById.get(row.entryId)?.model == null,
						),
						toolResults: result.toolResults.filter(
							row => absentTools.has(row.toolCallId) || toolById.get(row.toolCallId)?.result_chars == null,
						),
					};
					// Repair stale owners without invalidating IDs of records still present in the transcript.
					if (absentMessages.size > 0 || absentUsers.size > 0 || absentTools.size > 0) {
						reconcile = true;
						for (const id of absentMessages) {
							database
								.query("DELETE FROM messages WHERE session_file = ? AND entry_id = ?")
								.run(sessionFile, id);
						}
						for (const id of absentUsers) {
							database
								.query("DELETE FROM user_messages WHERE session_file = ? AND entry_id = ?")
								.run(sessionFile, id);
						}
						for (const id of absentTools) {
							database
								.query("DELETE FROM tool_calls WHERE session_file = ? AND tool_call_id = ?")
								.run(sessionFile, id);
						}
					}
				}
				if (replace) {
					if (messages.length > 0) database.query("DELETE FROM messages WHERE session_file = ?").run(sessionFile);
					if (users.length > 0)
						database.query("DELETE FROM user_messages WHERE session_file = ?").run(sessionFile);
					if (tools.length > 0) database.query("DELETE FROM tool_calls WHERE session_file = ?").run(sessionFile);
				}
			}
			writes.push(rows);
			const count = rows.stats.length + rows.userStats.length;
			processed += count;
			if (count > 0) files++;
		}
		// Remove replaced rows before choosing new fork owners, then write each table once per batch.
		insertMessageStats(parsedRows(writes, result => result.stats));
		insertUserMessageStats(parsedRows(writes, result => result.userStats));
		updateUserMessageLinks(parsedRows(writes, result => result.userLinks));
		insertToolCalls(parsedRows(writes, result => result.toolCalls));
		updateToolResults(parsedRows(writes, result => result.toolResults));
		for (const { sessionFile, result } of sessions) {
			if (result.parserState) {
				setFileOffset(sessionFile, result.newOffset, result.parserState.mtimeMs, result.parserState);
			}
		}
		if (reconcile) {
			database.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('session_reconciliation', 'pending')").run();
		}
		return { processed, files, reconcile };
	})();
}

export function prepareSessionSync(): boolean {
	return Boolean(db?.prepare("SELECT 1 FROM meta WHERE key = 'session_reconciliation'").get());
}

export function completeSessionSync(reconcile: boolean): void {
	if (!reconcile) db?.prepare("DELETE FROM meta WHERE key = 'session_reconciliation'").run();
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
export function insertMessageStats(stats: Iterable<MessageStatsInput>): number {
	if (!db) return 0;

	const stmt = db.query(`
		INSERT INTO messages (
			session_file, entry_id, folder, model, provider, api, timestamp,
			duration, ttft, stop_reason, error_message,
			input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
			cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input,
			cost_unpriced, agent_type, service_tier
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
			cost_no_cache_input = excluded.cost_no_cache_input,
			cost_unpriced = excluded.cost_unpriced,
			service_tier = excluded.service_tier
	`);

	let inserted = 0;
	const insert = db.transaction(() => {
		for (const s of stats) {
			const { cost, unpriced } = resolveStoredCost(s);
			const noCacheInputCost = calculateNoCacheInputCost(s.provider, s.model, s.usage, s.timestamp) ?? 0;
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
				unpriced ? 1 : 0,
				s.agentType,
				s.serviceTier ?? null,
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
		serviceTier: (row.service_tier as ServiceTier | null) ?? null,
		costUnpriced: row.cost_unpriced === 1,
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
/**
 * Per-local-day activity aggregates for the last `days` days, oldest first.
 * Self-initializing (opens the stats DB on first use) so the coding-agent TUI
 * can query without the dashboard server's init flow. Days use the machine's
 * timezone — this is a localhost tool, same rationale as
 * {@link getProviderHourlyBurn}.
 */
export async function getDailyActivity(days = 371): Promise<DailyActivityPoint[]> {
	const database = await initDb();
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const stmt = database.prepare(`
		SELECT
			date(timestamp / 1000, 'unixepoch', 'localtime') as day,
			SUM(cost_total) as cost,
			COUNT(*) as requests,
			SUM(total_tokens) as total_tokens
		FROM messages
		WHERE timestamp >= ?
		GROUP BY day
		ORDER BY day ASC
	`);
	const rows = stmt.all(cutoff) as Array<{
		day: string;
		cost: number | null;
		requests: number;
		total_tokens: number | null;
	}>;
	return rows.map(row => ({
		day: row.day,
		cost: row.cost ?? 0,
		requests: row.requests,
		totalTokens: row.total_tokens ?? 0,
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
 * - v9: stored judge prose (`prose` / `prose_hash`) for the frustration
 *   judge, so every session re-parses once to populate it. Verdicts live in
 *   `frustration_verdicts`, keyed by prose hash, which this reset never touches.
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
 * One-shot `file_offsets` wipe so the next sync re-parses every session and
 * re-derives `cost_unpriced` from `resolveStoredCost`. Rows ingested before the
 * marker existed defaulted to 0, and `INSERT ... ON CONFLICT DO UPDATE` only
 * refreshes them when the session is re-parsed — which the spent reingest
 * sentinel above will never do again. The re-parse also re-prices the
 * previously absent legacy `cost` charges, since `resolveStoredCost` now reads
 * absence as absence. Same sentinel protocol as {@link backfillReingestCosts}.
 */
function backfillUnpricedCosts(database: Database): void {
	const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(COST_UNPRICED_BACKFILL_KEY) as
		| { value: string }
		| undefined;
	if (!shouldResetBackfill(row?.value)) return;

	database.run("DELETE FROM file_offsets");
	database
		.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
		.run(COST_UNPRICED_BACKFILL_KEY, BACKFILL_PENDING);
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
			COST_UNPRICED_BACKFILL_KEY,
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
export function insertUserMessageStats(stats: Iterable<UserMessageStats>): number {
	if (!db) return 0;

	const stmt = db.query(`
		INSERT OR IGNORE INTO user_messages (
			session_file, entry_id, folder, timestamp, model, provider,
			chars, words, yelling, profanity, anguish,
			negation, repetition, blame, prose, prose_hash
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
				s.prose,
				s.proseHash,
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
 * persisted before their assistant reply was parsed by an incremental tail
 * read. Each row is updated at most once because the `model IS NULL` guard
 * short-circuits subsequent passes.
 *
 * Returns the number of rows actually updated.
 */
export function updateUserMessageLinks(links: Iterable<UserMessageLink>): number {
	if (!db) return 0;

	const stmt = db.query(`
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

/** Frustration tallies of one responding (model, provider) pair, before identity merging. */
export interface FrustrationModelRow extends FrustrationCounts {
	model: string;
	provider: string | null;
	/** Earliest message timestamp (ms) in range. */
	firstSeen: number;
}

/** One unique unjudged prose text: identical messages share a hash and one verdict. */
export interface PendingProse {
	hash: string;
	prose: string;
}

/** Cached judge verdict for one prose hash. */
export interface FrustrationVerdict {
	proseHash: string;
	/** P(clearly annoyed) + P(angry) on the `annoyed` score question. */
	pAnnoyed: number;
	/** P(angry, hostile, or swearing). */
	pAngry: number;
	/** Most likely `target` choice: `assistant`, `other`, or `none`. */
	target: string;
	/** `provider/model` that produced the verdict. */
	judge: string;
	judgedAt: number;
}

interface FrustrationCountsRow {
	messages: number;
	judged: number;
	annoyed: number;
	at_assistant: number;
	angry: number;
}

interface FrustrationModelSqlRow extends FrustrationCountsRow {
	model: string;
	provider: string | null;
	first_seen: number;
}

// Each message is classified once: by its cached verdict when `v` joined,
// else by the regex signals stored at ingest. Keep in sync with the rules
// documented on `FrustrationCounts` / `frustration.ts`.
const JUDGED_SQL = "v.prose_hash IS NOT NULL";
const JUDGED_ANNOYED_SQL = "v.p_annoyed >= 0.5";
const JUDGED_AT_ASSISTANT_SQL = `${JUDGED_ANNOYED_SQL} AND v.target = 'assistant'`;
const REGEX_AT_ASSISTANT_SQL = "u.negation + u.repetition + u.blame > 0";
const FRUSTRATION_COUNTS_SQL = `
	COUNT(*) AS messages,
	COALESCE(SUM(${JUDGED_SQL}), 0) AS judged,
	COALESCE(SUM(CASE WHEN ${JUDGED_SQL} THEN ${JUDGED_ANNOYED_SQL}
		ELSE u.yelling + u.profanity + u.anguish + u.negation + u.repetition + u.blame > 0 END), 0) AS annoyed,
	COALESCE(SUM(CASE WHEN ${JUDGED_SQL} THEN ${JUDGED_AT_ASSISTANT_SQL}
		ELSE ${REGEX_AT_ASSISTANT_SQL} END), 0) AS at_assistant,
	COALESCE(SUM(CASE WHEN ${JUDGED_SQL} THEN ${JUDGED_AT_ASSISTANT_SQL} AND v.p_angry >= 0.5
		ELSE ${REGEX_AT_ASSISTANT_SQL} AND (u.profanity > 0 OR u.yelling > 0) END), 0) AS angry
`;

function hasRangeCutoff(cutoff: number | null | undefined): cutoff is number {
	return cutoff !== null && cutoff !== undefined && cutoff > 0;
}

function toFrustrationCounts(row: FrustrationCountsRow | undefined): FrustrationCounts {
	return {
		messages: row?.messages ?? 0,
		judged: row?.judged ?? 0,
		annoyed: row?.annoyed ?? 0,
		atAssistant: row?.at_assistant ?? 0,
		angry: row?.angry ?? 0,
	};
}

/** Frustration tallies over every user message with prose in range, linked to a model or not. */
export function getFrustrationOverall(cutoff?: number | null): FrustrationCounts {
	if (!db) return toFrustrationCounts(undefined);
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.prepare(`
		SELECT ${FRUSTRATION_COUNTS_SQL}
		FROM user_messages u
		LEFT JOIN frustration_verdicts v ON v.prose_hash = u.prose_hash
		WHERE u.prose != ''${hasCutoff ? " AND u.timestamp >= ?" : ""}
	`);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as FrustrationCountsRow | undefined;
	return toFrustrationCounts(row);
}

/**
 * Frustration tallies per responding (model, provider) over the range. User
 * messages that never got a reply (null model) are only in the overall tally.
 */
export function getFrustrationByModel(cutoff?: number | null): FrustrationModelRow[] {
	if (!db) return [];
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.prepare(`
		SELECT u.model AS model, u.provider AS provider, MIN(u.timestamp) AS first_seen, ${FRUSTRATION_COUNTS_SQL}
		FROM user_messages u
		LEFT JOIN frustration_verdicts v ON v.prose_hash = u.prose_hash
		WHERE u.prose != '' AND u.model IS NOT NULL${hasCutoff ? " AND u.timestamp >= ?" : ""}
		GROUP BY u.model, u.provider
	`);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as FrustrationModelSqlRow[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		firstSeen: row.first_seen,
		...toFrustrationCounts(row),
	}));
}

/** Unique unjudged prose in range, one row per prose hash. */
function pendingProseSql(hasCutoff: boolean): string {
	return `
		SELECT u.prose_hash AS hash, MIN(u.prose) AS prose
		FROM user_messages u
		WHERE u.prose != ''${hasCutoff ? " AND u.timestamp >= ?" : ""}
		  AND NOT EXISTS (SELECT 1 FROM frustration_verdicts v WHERE v.prose_hash = u.prose_hash)
		GROUP BY u.prose_hash
	`;
}

/** Unique prose texts in range that have no cached verdict yet. */
export function getPendingFrustrationProse(cutoff?: number | null): PendingProse[] {
	if (!db) return [];
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.prepare(pendingProseSql(hasCutoff));
	return (hasCutoff ? stmt.all(cutoff) : stmt.all()) as PendingProse[];
}

/** Count and total characters of {@link getPendingFrustrationProse} without loading the text. */
export function getPendingFrustrationTotals(cutoff?: number | null): { messages: number; chars: number } {
	if (!db) return { messages: 0, chars: 0 };
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.prepare(
		`SELECT COUNT(*) AS messages, COALESCE(SUM(LENGTH(prose)), 0) AS chars FROM (${pendingProseSql(hasCutoff)})`,
	);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as { messages: number; chars: number } | undefined;
	return { messages: row?.messages ?? 0, chars: row?.chars ?? 0 };
}

/**
 * Cache (or replace) verdicts, all in one transaction: a judge run lands
 * dozens per second, and a commit per verdict would contend with ingest for
 * the write lock every time.
 */
export function upsertFrustrationVerdicts(verdicts: readonly FrustrationVerdict[]): void {
	if (!db || verdicts.length === 0) return;
	const database = db;
	const stmt = database.query(
		`INSERT OR REPLACE INTO frustration_verdicts (prose_hash, p_annoyed, p_angry, target, judge, judged_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	database.transaction(() => {
		for (const v of verdicts) stmt.run(v.proseHash, v.pAnnoyed, v.pAngry, v.target, v.judge, v.judgedAt);
	})();
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
export function insertToolCalls(calls: Iterable<ToolCallStats>): number {
	if (!db) return 0;

	const stmt = db.query(`
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
export function updateToolResults(links: Iterable<ToolResultLink>): number {
	if (!db) return 0;

	const stmt = db.query(`
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
