import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkpointWal, getDbBusyTimeoutMs, getHistoryDbPath, logger, postmortem } from "@oh-my-pi/pi-utils";

/** A unique prompt with provenance from its most recent submission. */
export interface HistoryEntry {
	/** Stable row identifier used by the full-text index. */
	id: number;
	/** Trimmed prompt text, unique across the history database. */
	prompt: string;
	/** Unix timestamp of the most recent submission. */
	created_at: number;
	/** Project working directory of the most recent submission. */
	cwd?: string;
	/** Session ID of the most recent submission, if known. */
	sessionId?: string;
}

type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
	session_id: string | null;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

// Escape LIKE wildcards so user input is treated as literal text.
// Matches the `ESCAPE '\\'` clause used by substring-search statements.
function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

/**
 * Canonical stored form of a prompt: CRLF/CR folded to LF, trailing whitespace
 * stripped from every line, outer whitespace trimmed. Terminal copies pad each
 * line with spaces to the screen width, so without this a resubmitted copy of
 * an existing prompt lands as a byte-distinct duplicate row.
 */
function normalizePrompt(prompt: string): string {
	return prompt
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+\n/g, "\n")
		.trim();
}
/** Bumped when stored rows need the one-time dump-and-rebuild pass on open; see `#rebuildHistory`. */
const HISTORY_DATA_VERSION = 1;

/** Canonical `history` schema; `#rebuildHistory` recreates the table from this exact DDL. */
const HISTORY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT,
	session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
`;

let cancelExitCleanup: (() => void) | undefined;

/** Stores searchable prompts with only their latest project and session metadata. */
export class HistoryStorage {
	#db: Database;
	static #instance?: HistoryStorage;
	#sessionResolver?: () => string | undefined;

	// Prepared statements
	#upsertRowStmt: Statement;
	#recentStmt: Statement;
	#searchStmt: Statement;
	// Cache substring-fallback prepared statements keyed by token count.
	#substringStmts = new Map<number, Statement>();

	private constructor(dbPath: string) {
		this.#ensureDir(dbPath);

		this.#db = new Database(dbPath);

		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		// Headless hosts bound the wait so lock contention cannot freeze the
		// protocol loop for the full interactive timeout.
		this.#db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);

		const hadFts = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
${HISTORY_TABLE_DDL}
		`);

		const rebuilt = this.#rebuildHistory();

		this.#db.run(`
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
		`);

		if (rebuilt || !hadFts) {
			try {
				this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
			}
		}
		this.#recentStmt = this.#db.prepare(
			"SELECT id, prompt, created_at, cwd, session_id FROM history ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#searchStmt = this.#db.prepare(
			"SELECT h.id, h.prompt, h.created_at, h.cwd, h.session_id FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ? ORDER BY h.created_at DESC, h.id DESC LIMIT ?",
		);
		this.#upsertRowStmt = this.#db.prepare(`
INSERT INTO history (prompt, created_at, cwd, session_id)
VALUES (?, ${SQLITE_NOW_EPOCH}, ?, ?)
ON CONFLICT(prompt) DO UPDATE SET
	created_at = excluded.created_at,
	cwd = excluded.cwd,
	session_id = excluded.session_id
		`);
	}

	/** Opens the process-wide prompt history database. */
	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		const existing = HistoryStorage.#instance;
		if (existing) return existing;

		const instance = new HistoryStorage(dbPath);
		// Exit-only: a keep-alive cleanup leaves the handle valid so the editor can
		// keep submitting prompts; the real exit closes. Register before publishing
		// so a real-exit-in-progress late registration cannot close this instance.
		cancelExitCleanup = postmortem.register("history-storage", () => HistoryStorage.close(), { exitOnly: true });
		HistoryStorage.#instance = instance;
		return instance;
	}

	/** Checkpoints and closes the process-wide database, and permits reopening it. */
	static close(): void {
		const instance = HistoryStorage.#instance;
		HistoryStorage.#instance = undefined;
		cancelExitCleanup?.();
		cancelExitCleanup = undefined;
		if (instance) instance.#close();
	}

	#close(): void {
		checkpointWal(this.#db);
		for (const stmt of this.#substringStmts.values()) stmt.finalize();
		this.#substringStmts.clear();
		this.#upsertRowStmt.finalize();
		this.#recentStmt.finalize();
		this.#searchStmt.finalize();
		this.#db.close();
	}

	#insertBatch(rows: Array<Pick<HistoryEntry, "prompt" | "cwd" | "sessionId">>): void {
		this.#db.transaction((rows: Array<Pick<HistoryEntry, "prompt" | "cwd" | "sessionId">>) => {
			for (const row of rows) {
				this.#upsertRowStmt.run(row.prompt, row.cwd ?? null, row.sessionId ?? null);
			}
		})(rows);
	}

	/**
	 * Register a resolver that supplies the current session ID for prompts added
	 * without an explicit `sessionId`. Evaluated synchronously at `add()` time so
	 * each write captures the session active when the prompt was submitted.
	 */
	setSessionResolver(resolver: () => string | undefined): void {
		this.#sessionResolver = resolver;
	}

	/**
	 * Stores a prompt and replaces its provenance with the latest submission.
	 * The write is synchronous: prompt submission is human-paced, not a hot
	 * path, so the row is durable the moment `add()` returns and can never be
	 * lost to an exit racing a deferred flush. Failures are logged, not thrown.
	 */
	add(prompt: string, cwd?: string, sessionId?: string): Promise<void> {
		const trimmed = normalizePrompt(prompt);
		if (!trimmed) return Promise.resolve();
		const session = sessionId ?? this.#sessionResolver?.();
		try {
			this.#insertBatch([{ prompt: trimmed, cwd: cwd ?? undefined, sessionId: session || undefined }]);
		} catch (error) {
			logger.error("HistoryStorage add failed", { error: String(error) });
		}
		return Promise.resolve();
	}

	/** Returns unique prompts ordered by their most recent submission. */
	getRecent(limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		try {
			const rows = this.#recentStmt.all(safeLimit) as HistoryRow[];
			return rows.map(row => this.#toEntry(row));
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	/** Finds unique prompts matching every query token, newest first. */
	search(query: string, limit: number): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = this.#tokenize(query);
		if (tokens.length === 0) return [];

		// 1. FTS5 prefix match (token AND, prefix-wildcard per token).
		//    Handles punctuation by tokenizing query the same way unicode61 tokenizer
		//    indexed the stored text, so "git-commit" -> "git"* "commit"*.
		const ftsQuery = tokens.map(tok => `"${tok.replace(/"/g, '""')}"*`).join(" ");
		let ftsRows: HistoryRow[] = [];
		try {
			ftsRows = this.#searchStmt.all(ftsQuery, safeLimit) as HistoryRow[];
		} catch (error) {
			// Malformed FTS expression - fall through to substring path.
			logger.debug("HistoryStorage FTS query failed, using substring only", { error: String(error) });
		}

		// 2. Substring fallback (token-AND LIKE). Catches infix matches FTS5's
		//    prefix-only wildcard cannot reach (e.g. "mit" -> "commit"). Bounded
		//    by safeLimit, ordered by recency - no full-table load into JS.
		let subRows: HistoryRow[] = [];
		try {
			subRows = this.#searchSubstring(tokens, safeLimit);
		} catch (error) {
			logger.error("HistoryStorage substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return subRows.map(row => this.#toEntry(row));
		}

		const rowsById = new Map<number, HistoryRow>();
		for (const row of ftsRows) {
			rowsById.set(row.id, row);
		}
		for (const row of subRows) {
			if (!rowsById.has(row.id)) rowsById.set(row.id, row);
		}

		return [...rowsById.values()]
			.sort((a, b) => b.created_at - a.created_at || b.id - a.id)
			.slice(0, safeLimit)
			.map(row => this.#toEntry(row));
	}

	/**
	 * IDs of the sessions whose stored prompts match `query`, ordered by prompt
	 * recency and de-duplicated. Used to augment session ranking in the resume
	 * picker with prompts that the 4KB session-list prefix never sees.
	 */
	matchingSessionIds(query: string, limit = 500): string[] {
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const entry of this.search(query, limit)) {
			const id = entry.sessionId;
			if (!id || seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
		return ids;
	}

	#ensureDir(dbPath: string): void {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });
	}

	#historySchemaHasColumn(column: string): boolean {
		const columns = this.#db.prepare("PRAGMA table_info(history)").all() as Array<{ name: string }>;
		return columns.some(col => col.name === column);
	}

	/**
	 * One-time dump-and-rebuild pass, gated by `PRAGMA user_version` (owned by
	 * this pass — nothing else versions history.db). Dumps every row, folds each
	 * prompt through {@link normalizePrompt} in JS, keeps the most recent
	 * submission per normalized prompt (the upsert's "latest wins" rule), and
	 * recreates the table from {@link HISTORY_TABLE_DDL}. Subsumes every legacy
	 * shape at once — unixepoch defaults, missing session_id, non-unique prompt,
	 * per-line trailing padding — without per-shape SQL migrations. Returns
	 * whether it ran so the caller can rebuild the FTS index.
	 */
	#rebuildHistory(): boolean {
		const versionRow = this.#db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version >= HISTORY_DATA_VERSION) return false;
		let rows: HistoryRow[];
		try {
			const sessionIdSelection = this.#historySchemaHasColumn("session_id") ? "session_id" : "NULL AS session_id";
			rows = this.#db
				.prepare(`SELECT id, prompt, created_at, cwd, ${sessionIdSelection} FROM history`)
				.all() as HistoryRow[];
		} catch (error) {
			logger.error("HistoryStorage rebuild dump failed", { error: String(error) });
			return false;
		}
		const winners = new Map<string, HistoryRow>();
		for (const row of rows) {
			const prompt = normalizePrompt(row.prompt);
			if (!prompt) continue;
			const incumbent = winners.get(prompt);
			// Most recent submission wins, matching the upsert's "latest provenance" rule.
			const rowWins =
				!incumbent ||
				row.created_at > incumbent.created_at ||
				(row.created_at === incumbent.created_at && row.id > incumbent.id);
			if (rowWins) winners.set(prompt, { ...row, prompt });
		}
		this.#db.transaction(() => {
			this.#db.run("DROP INDEX IF EXISTS idx_history_created_at");
			this.#db.run("DROP TRIGGER IF EXISTS history_ai");
			this.#db.run("DROP TABLE IF EXISTS history_fts");
			this.#db.run("DROP TABLE history");
			this.#db.run(HISTORY_TABLE_DDL);
			const insert = this.#db.prepare(
				"INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)",
			);
			for (const row of winners.values()) {
				insert.run(row.id, row.prompt, row.created_at, row.cwd, row.session_id);
			}
			this.#db.run(`PRAGMA user_version = ${HISTORY_DATA_VERSION}`);
		})();
		if (winners.size < rows.length) {
			logger.debug("HistoryStorage collapsed rows during rebuild", { before: rows.length, after: winners.size });
		}
		return true;
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	/**
	 * Split on non-alphanumeric runs, mirroring FTS5's `unicode61` tokenizer so
	 * query tokens align with how stored prompts were indexed. Lowercases for
	 * stable substring matching.
	 */
	#tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(tok => tok.length > 0);
	}

	#searchSubstring(tokens: string[], limit: number): HistoryRow[] {
		const stmt = this.#getSubstringStmt(tokens.length);
		const params: unknown[] = tokens.map(tok => `%${escapeLikePattern(tok)}%`);
		params.push(limit);
		return stmt.all(...(params as [string, ...unknown[]])) as HistoryRow[];
	}

	#getSubstringStmt(tokenCount: number): Statement {
		let stmt = this.#substringStmts.get(tokenCount);
		if (stmt) return stmt;
		const whereClause = Array(tokenCount).fill("prompt LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" AND ");
		stmt = this.#db.prepare(
			`SELECT id, prompt, created_at, cwd, session_id FROM history WHERE ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		this.#substringStmts.set(tokenCount, stmt);
		return stmt;
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: row.id,
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
			sessionId: row.session_id ?? undefined,
		};
	}
}
