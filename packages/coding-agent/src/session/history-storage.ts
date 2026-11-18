import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AsyncDrain,
	checkpointWal,
	getHistoryDbPath,
	logger,
	pathIdentityKey,
	openSqliteDatabaseSync,
	postmortem,
	readSalvageableRows,
} from "@oh-my-pi/pi-utils";
import { primaryRootOrCwd } from "../utils/active-repo-context";
import { closeSessionIndex, salvageSessionIndex } from "./session-index";

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
	/** Number of times this prompt has been submitted, including the first. */
	useCount: number;
}

/** Narrows history reads by exact metadata; omitted fields match every prompt. */
export interface HistoryFilter {
	/** Exact stored project directory, without path normalization. */
	cwd?: string;
	/** Exact session id of the prompt's latest submission. */
	sessionId?: string;
}

/**
 * Recall scopes, narrowest first. Single source for the settings enum, the Ctrl+R scope ring
 * and the labels both render, so they never drift apart.
 */
export const HISTORY_SCOPE_KINDS = ["session", "cwd", "repo", "global"] as const;

export type HistoryScopeKind = (typeof HISTORY_SCOPE_KINDS)[number];

/** Human-facing name of each scope, phrased to read mid-sentence (`History (this session)`). */
export const HISTORY_SCOPE_LABELS: Record<HistoryScopeKind, string> = {
	session: "this session",
	cwd: "current folder",
	repo: "this repository",
	global: "all projects",
};

/**
 * Recall filter for {@link HistoryStorage.getRecent} / {@link HistoryStorage.search}.
 * Omitting the scope, or passing `global`, reads the whole table (the pre-#4331 behavior).
 */
export interface HistoryScope {
	/** `session`: one conversation; `cwd`: one directory; `repo`: one repository; `global`: everything. */
	kind: HistoryScopeKind;
	/** Session id (`session`), directory (`cwd`), or primary repository root (`repo`). */
	value?: string;
}

type HistoryRow = {
	id: number;
	prompt: string;
	created_at: number;
	cwd: string | null;
	session_id: string | null;
	use_count: number;
};

/** Bound scope predicate appended after each read's row-validity guard. */
type ScopeClause = { and: string; params: SQLQueryBindings[] };

/** A submitted prompt awaiting the deferred write, with its provenance bound at submission. */
interface QueuedPrompt {
	prompt: string;
	cwd: string | undefined;
	sessionId: string | undefined;
	/** Unix seconds at submission, written as `created_at` so the row keeps its submission time. */
	createdAt: number;
}

/**
 * Delay before submitted prompts are written. The write is a disk-bound
 * transaction; deferring it past the submit keystroke lets the frame answering
 * Enter paint first and coalesces prompts submitted in quick succession.
 * {@link HistoryStorage.close} and the exit-only postmortem hook flush the
 * queue, so only a hard kill inside this window loses a prompt.
 */
const HISTORY_FLUSH_DELAY_MS = 100;

const EMPTY_SCOPE_CLAUSE: ScopeClause = { and: "", params: [] };

// A bare directory is not a list, so directory scopes expand to stored spellings and bind them
// with `json_each`; the array travels as JSON, keeping the statement text (and its cache key)
// constant no matter how many directories match.
const DIRS_AND = "AND cwd IN (SELECT value FROM json_each(?))";

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/**
 * Rows a reader may hand to callers. A damaged page cross-linked into
 * `history` decodes foreign bytes as rows (BLOB prompts and counters), which
 * would reach the editor as `Uint8Array`s.
 */
function readableRowClause(table: string): string {
	return `typeof(${table}prompt) = 'text' AND typeof(${table}created_at) = 'integer' AND typeof(${table}use_count) = 'integer'`;
}

/** A query term's letter and digit runs, as FTS5's unicode61 tokenizer splits stored prompts. */
function ftsTokens(term: string): string[] {
	return term.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0);
}

/** `text` case-folded with Latin diacritics removed, as the unicode61 tokenizer indexes it. */
function ftsFold(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
		.normalize("NFC");
}

/** Whether `phrase` occurs as consecutive `tokens`, its last token as a prefix: an FTS5 `"…"*` phrase. */
function hasPhrasePrefix(tokens: string[], phrase: string[]): boolean {
	const last = phrase.length - 1;
	if (last < 0) return false;
	for (let start = 0; start + last < tokens.length; start++) {
		if (!tokens[start + last].startsWith(phrase[last])) continue;
		let index = 0;
		while (index < last && tokens[start + index] === phrase[index]) index++;
		if (index === last) return true;
	}
	return false;
}

/**
 * Whether a queued `prompt` answers `terms` as {@link HistoryStorage.search}
 * matches stored rows: every term as an FTS phrase prefix, or every term as a
 * literal substring under LIKE's ASCII-only case folding.
 */
function promptMatchesTerms(prompt: string, terms: string[]): boolean {
	const likeText = prompt.replace(/[A-Z]+/g, run => run.toLowerCase());
	if (terms.every(term => likeText.includes(term))) return true;
	const tokens = ftsTokens(ftsFold(prompt));
	return terms.every(term => hasPhrasePrefix(tokens, ftsTokens(ftsFold(term))));
}

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
/**
 * Bumped only when stored rows need the one-time dump-and-rebuild pass on open;
 * see `#rebuildHistory`. Purely additive columns go through `#ensureColumn`
 * instead so existing stores are never rewritten for them.
 */
const HISTORY_DATA_VERSION = 1;

/** Canonical `history` schema; `#rebuildHistory` recreates the table from this exact DDL. */
const HISTORY_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	cwd TEXT,
	session_id TEXT,
	use_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC);
`;

/** Rows {@link HistoryStorage.getRecent} reads first; checked on open for decoded foreign rows. */
const RECENT_WINDOW = 100;

let cancelExitCleanup: (() => void) | undefined;

/** Stores searchable prompts with only their latest project and session metadata. */
export class HistoryStorage {
	#db: Database;
	static #instance?: HistoryStorage;
	#sessionResolver?: () => string | undefined;
	#addListener?: () => void;
	#errorListener?: (error: unknown) => void;
	#writeFailureReported = false;
	/** Prompts accepted by {@link add} and not yet written, oldest first: always the drain's pending batch. */
	#queued: QueuedPrompt[] = [];
	/** Coalesces submitted prompts into one deferred transaction off the submit keystroke. */
	#drain = new AsyncDrain<QueuedPrompt>(HISTORY_FLUSH_DELAY_MS, { unref: true });
	/** Negative stand-in ids handed out for queued prompts without a stored row, keyed by prompt. */
	#provisionalIds = new Map<string, number>();

	// Prepared statements
	#upsertRowStmt: Statement;
	// Only constant SQL texts are cached — scope values travel as bound parameters inside the
	// text, never as text — so this map is bounded by the number of query shapes in this file,
	// not by user input. `#searchSubstring` builds one LIKE term per token, so it prepares its
	// statement per call instead of growing a key per token count ever searched.
	#stmts = new Map<string, Statement>();
	// Cache only raw stored paths; normalization and Git topology stay live on every read.
	#storedDirsCache?: { dataVersion: number; dirs: string[] };

	private constructor(db: Database) {
		this.#db = db;

		// One-shot statements go through the query cache, which close() finalizes; a
		// stray prepare() would turn close() into a zombie that keeps the files open.
		const hadFts = this.#db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_fts'").get();
		this.#db.run(`
	PRAGMA journal_mode=WAL;
	PRAGMA synchronous=NORMAL;
	${HISTORY_TABLE_DDL}
		`);

		// Additive column on stores created before the counter existed; runs before
		// the rebuild so the dump below always sees it.
		this.#ensureColumn("use_count", "INTEGER NOT NULL DEFAULT 1");
		const rebuilt = this.#rebuildHistory();

		// A `session` scope filters on an unindexed column, which turns the ordered index walk
		// the other scopes get into a full table scan plus a temp sort — measured 3.5 ms against
		// 0.1 ms at 50 000 rows. This runs after `#rebuildHistory` on purpose: a store predating
		// the session column has none until the rebuild, and the table DDL above would fail on it.
		this.#db.run("CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id, created_at DESC, id DESC)");

		this.#db.run(`
	CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(prompt, content='history', content_rowid='id');

	CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
	INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
	INSERT INTO history_fts(history_fts, rowid, prompt) VALUES ('delete', old.id, old.prompt);
END;
		`);

		if (rebuilt || !hadFts) {
			try {
				this.#db.run("INSERT INTO history_fts(history_fts) VALUES('rebuild')");
			} catch (error) {
				logger.warn("HistoryStorage FTS rebuild failed", { error: String(error) });
			}
		}
		this.#assertRecentWindowReadable();
		this.#upsertRowStmt = this.#db.prepare(`
	INSERT INTO history (prompt, created_at, cwd, session_id)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(prompt) DO UPDATE SET
	created_at = excluded.created_at,
	cwd = excluded.cwd,
	session_id = excluded.session_id,
	use_count = history.use_count + 1
		`);
	}

	/**
	 * Opens the process-wide prompt history database. A corrupt store is
	 * quarantined once and the rows it can still decode are copied into the
	 * replacement.
	 */
	static open(dbPath: string = getHistoryDbPath()): HistoryStorage {
		const existing = HistoryStorage.#instance;
		if (existing) return existing;

		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		// Windows cannot move history.db aside while the session index holds it open.
		closeSessionIndex();
		let backupPath = undefined as string | undefined;
		const instance = openSqliteDatabaseSync(
			dbPath,
			db => {
				const instance = new HistoryStorage(db);
				// Exit-only: a keep-alive cleanup leaves the handle valid so the editor can
				// keep submitting prompts; the real exit closes. Register before publishing
				// so a real-exit-in-progress late registration cannot close this instance.
				cancelExitCleanup = postmortem.register("history-storage", () => HistoryStorage.close(), {
					exitOnly: true,
				});
				HistoryStorage.#instance = instance;
				return instance;
			},
			{
				recoverCorruption: true,
				onCorruptionPreserved: preserved => {
					backupPath = preserved;
				},
			},
		);
		if (backupPath) instance.#salvage(backupPath);
		return instance;
	}

	/** Writes queued prompts, checkpoints and closes the process-wide database, and permits reopening it. */
	static close(): void {
		const instance = HistoryStorage.#instance;
		HistoryStorage.#instance = undefined;
		cancelExitCleanup?.();
		cancelExitCleanup = undefined;
		if (instance) instance.#close();
	}

	#close(): void {
		// The drain handler runs synchronously, so queued prompts are committed
		// before the checkpoint and before their statement is finalized, including
		// in process.on("exit").
		void this.#drain.flush();
		checkpointWal(this.#db);
		for (const stmt of this.#stmts.values()) stmt.finalize();
		this.#stmts.clear();
		this.#upsertRowStmt.finalize();
		this.#db.close();
	}

	#insertBatch(rows: QueuedPrompt[]): void {
		this.#storedDirsCache = undefined;
		this.#db.transaction((rows: QueuedPrompt[]) => {
			for (const row of rows) {
				this.#upsertRowStmt.run(row.prompt, row.createdAt, row.cwd ?? null, row.sessionId ?? null);
			}
		})(rows);
	}

	/** Writes one drained batch in a single transaction; failures are logged and reported once per outage. */
	#write(rows: QueuedPrompt[]): void {
		this.#queued = [];
		try {
			this.#insertBatch(rows);
		} catch (error) {
			logger.error("HistoryStorage add failed", { error: String(error) });
			if (!this.#writeFailureReported) {
				this.#writeFailureReported = true;
				this.#errorListener?.(error);
			}
			return;
		}
		this.#writeFailureReported = false;
		this.#addListener?.();
	}

	/**
	 * Register a resolver that supplies the current session ID for prompts added
	 * without an explicit `sessionId`. Evaluated synchronously at `add()` time so
	 * each write captures the session active when the prompt was submitted.
	 */
	setSessionResolver(resolver: () => string | undefined): void {
		this.#sessionResolver = resolver;
	}

	/** Register a callback run after each successful write of queued prompts, once their rows are durable. */
	setAddListener(listener: () => void): void {
		this.#addListener = listener;
	}

	/** Register a callback for the first failed write in each outage, reset by a successful write. */
	setErrorListener(listener: (error: unknown) => void): void {
		this.#errorListener = listener;
	}

	/**
	 * Stores a prompt, replaces its provenance with the latest submission, and
	 * bumps its use count on resubmission.
	 * Recall and search see the prompt as soon as `add()` returns, but the write
	 * is queued so the submit keystroke never waits on disk: queued prompts are
	 * written in one transaction {@link HISTORY_FLUSH_DELAY_MS} later, or at once
	 * by {@link flush}, {@link delete}, {@link HistoryStorage.close}, and the
	 * exit-only postmortem hook. Resolves once the write is done. Failures are
	 * logged, not thrown; the error listener is notified once per outage until a
	 * write succeeds.
	 */
	add(prompt: string, cwd?: string, sessionId?: string): Promise<void> {
		const trimmed = normalizePrompt(prompt);
		if (!trimmed) return Promise.resolve();
		const session = sessionId ?? this.#sessionResolver?.();
		const row: QueuedPrompt = {
			prompt: trimmed,
			cwd,
			sessionId: session || undefined,
			createdAt: Math.floor(Date.now() / 1000),
		};
		this.#queued.push(row);
		return this.#drain.push(row, rows => this.#write(rows));
	}

	/** Writes every queued prompt now; resolves once they are persisted or their failure is reported. */
	flush(): Promise<void> {
		return this.#drain.flush();
	}

	/**
	 * Deletes a stored prompt and its search index entry. Queued prompts are
	 * written first, so a queued resubmission cannot re-insert the prompt, and a
	 * provisional id from {@link getRecent} or {@link search} deletes the row its
	 * queued write created.
	 */
	delete(id: number): void {
		void this.#drain.flush();
		if (id >= 0) {
			this.#db.query("DELETE FROM history WHERE id = ?").run(id);
			return;
		}
		for (const [prompt, provisional] of this.#provisionalIds) {
			if (provisional !== id) continue;
			this.#db.query("DELETE FROM history WHERE prompt = ?").run(prompt);
			return;
		}
	}

	/** Returns recent unique prompts, degrading to no results when storage is unavailable. */
	getRecent(limit: number, scope?: HistoryScope | HistoryFilter): HistoryEntry[] {
		try {
			return this.getRecentOrThrow(limit, scope);
		} catch (error) {
			logger.error("HistoryStorage getRecent failed", { error: String(error) });
			return [];
		}
	}

	/**
	 * Strict recent read for callers that can retry a failed seed without committing an empty list.
	 * Accepts the same scopes and legacy exact metadata filters as {@link getRecent}.
	 */
	getRecentOrThrow(limit: number, scope?: HistoryScope | HistoryFilter): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const queued = this.#queuedEntries();
		const clause = this.#scopeClause(scope);
		// Each queued prompt can displace its own stored row, so read that many more.
		const rows = this.#prepare(
			`SELECT id, prompt, created_at, cwd, session_id, use_count FROM history WHERE ${readableRowClause("")} ${clause.and} ORDER BY created_at DESC, id DESC LIMIT ?`,
		).all(...clause.params, safeLimit + queued.length) as HistoryRow[];
		return this.#withQueued(queued, rows, scope, safeLimit);
	}

	/** Stable signature of the raw stored directories currently selected by this directory scope. */
	getDirectoryScopeKey(kind: "cwd" | "repo", target?: string): string {
		return JSON.stringify(this.#scopeDirs(kind, target).sort());
	}

	/** Finds unique prompts matching every whitespace-delimited query term, newest first, restricted to a scope or exact metadata filter. */
	search(query: string, limit: number, scope?: HistoryScope | HistoryFilter): HistoryEntry[] {
		const safeLimit = this.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const terms = this.#terms(query);
		if (terms.length === 0) return [];
		const queued = this.#queuedEntries().filter(entry => promptMatchesTerms(entry.prompt, terms));
		// Each matching queued prompt can displace its own stored row, so read that many more.
		const fetchLimit = safeLimit + queued.length;

		// Resolved before the query paths, like `getRecent`: a scope that cannot be rendered
		// means an unusable handle, and reading unscoped is never an option — fail closed.
		let clause: ScopeClause;
		try {
			clause = this.#scopeClause(scope);
		} catch (error) {
			logger.error("HistoryStorage search scope failed", { error: String(error) });
			return [];
		}

		// 1. FTS5 prefix match (term AND). Each term is one phrase of its letter
		//    and digit runs, split the way the unicode61 tokenizer indexed the
		//    stored text, so "git-commit" -> "git commit"*: the runs must be
		//    adjacent tokens, not two words anywhere in the prompt.
		const ftsQuery = terms.map(term => `"${ftsTokens(term).join(" ")}"*`).join(" ");
		let ftsRows: HistoryRow[] = [];
		try {
			ftsRows = this.#prepare(
				`SELECT h.id, h.prompt, h.created_at, h.cwd, h.session_id, h.use_count FROM history_fts f JOIN history h ON h.id = f.rowid WHERE history_fts MATCH ? AND ${readableRowClause("h.")} ${clause.and} ORDER BY h.created_at DESC, h.id DESC LIMIT ?`,
			).all(ftsQuery, ...clause.params, fetchLimit) as HistoryRow[];
		} catch (error) {
			// Malformed FTS expression - fall through to substring path.
			logger.debug("HistoryStorage FTS query failed, using substring only", { error: String(error) });
		}

		// 2. Substring fallback (term-AND LIKE, each term literal). Catches infix
		//    matches FTS5's prefix-only wildcard cannot reach (e.g. "mit" ->
		//    "commit"). Bounded by fetchLimit, ordered by recency - no full-table
		//    load into JS.
		let subRows: HistoryRow[] = [];
		try {
			subRows = this.#searchSubstring(terms, fetchLimit, clause);
		} catch (error) {
			logger.error("HistoryStorage substring search failed", { error: String(error) });
		}

		if (ftsRows.length === 0) {
			return this.#withQueued(queued, subRows, scope, safeLimit);
		}

		const rowsById = new Map<number, HistoryRow>();
		for (const row of ftsRows) {
			rowsById.set(row.id, row);
		}
		for (const row of subRows) {
			if (!rowsById.has(row.id)) rowsById.set(row.id, row);
		}

		const rows = [...rowsById.values()].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
		return this.#withQueued(queued, rows, scope, safeLimit);
	}

	/**
	 * Queued prompts as recall lists them once written: one entry per prompt,
	 * newest submission first, with its latest provenance and its stored use
	 * count plus the queued submissions. A prompt without a stored row gets a
	 * negative provisional id that {@link delete} accepts.
	 */
	#queuedEntries(): HistoryEntry[] {
		const entries = new Map<string, HistoryEntry>();
		for (let index = this.#queued.length - 1; index >= 0; index--) {
			const row = this.#queued[index];
			const entry = entries.get(row.prompt);
			if (entry) {
				entry.useCount++;
				continue;
			}
			const stored = this.#storedRow(row.prompt);
			entries.set(row.prompt, {
				id: stored?.id ?? this.#provisionalId(row.prompt),
				prompt: row.prompt,
				created_at: row.createdAt,
				cwd: row.cwd,
				sessionId: row.sessionId,
				useCount: (stored?.use_count ?? 0) + 1,
			});
		}
		return [...entries.values()];
	}

	/** Id and use count of the readable stored row for `prompt`, which the queued upsert will update in place. */
	#storedRow(prompt: string): { id: number; use_count: number } | null {
		try {
			return this.#db
				.query<{ id: number; use_count: number }, [string]>(
					"SELECT id, use_count FROM history WHERE prompt = ?1 AND typeof(use_count) = 'integer'",
				)
				.get(prompt);
		} catch (error) {
			logger.debug("HistoryStorage stored-row lookup failed", { error: String(error) });
			return null;
		}
	}

	#provisionalId(prompt: string): number {
		let id = this.#provisionalIds.get(prompt);
		if (id === undefined) {
			id = -(this.#provisionalIds.size + 1);
			this.#provisionalIds.set(prompt, id);
		}
		return id;
	}

	/**
	 * Stored `rows` (newest first) with the `queued` entries merged in as their
	 * write will leave them: a queued prompt replaces its stored row, which drops
	 * out even when the queued provenance no longer matches `scope`. Queued
	 * entries whose provenance places them outside `scope` stay hidden, using the
	 * JS form of {@link #scopeClause}; a queued prompt in a directory no stored
	 * row knows yet surfaces once the deferred write lands.
	 */
	#withQueued(
		queued: HistoryEntry[],
		rows: HistoryRow[],
		scope: HistoryScope | HistoryFilter | undefined,
		limit: number,
	): HistoryEntry[] {
		if (queued.length === 0) return rows.slice(0, limit).map(row => this.#toEntry(row));
		const queuedPrompts = new Set<string>();
		const entries: HistoryEntry[] = [];
		for (const entry of queued) {
			queuedPrompts.add(entry.prompt);
			if (this.#queuedInScope(entry, scope)) entries.push(entry);
		}
		for (const row of rows) {
			if (!queuedPrompts.has(row.prompt)) entries.push(this.#toEntry(row));
		}
		// Stable sort: within one second, queued submissions stay ahead of stored rows.
		return entries.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
	}

	/** Whether `entry`'s provenance matches `scope`: the in-memory twin of {@link #scopeClause}. */
	#queuedInScope(entry: HistoryEntry, scope: HistoryScope | HistoryFilter | undefined): boolean {
		if (!scope) return true;
		const selection: Partial<HistoryScope> & HistoryFilter = scope;
		const kind = selection.kind;
		if (kind === undefined) {
			// Legacy exact-metadata filter: an omitted field matches every prompt.
			return (
				(selection.cwd === undefined || entry.cwd === selection.cwd) &&
				(selection.sessionId === undefined || entry.sessionId === selection.sessionId)
			);
		}
		switch (kind) {
			case "global":
				return true;
			case "session":
				return entry.sessionId === (selection.value ?? "");
			case "cwd":
			case "repo": {
				// Queued provenance is compared by filesystem identity against the scope
				// target itself: stored-directory expansion cannot see a queued prompt
				// whose row has not landed yet. Empty spellings never match — the SQL
				// side excludes them too.
				if (entry.cwd === undefined || entry.cwd === "" || selection.value === undefined || selection.value === "")
					return false;
				const identity = pathIdentityKey(selection.value);
				if (kind === "cwd") return pathIdentityKey(entry.cwd) === identity;
				if (pathIdentityKey(primaryRootOrCwd(selection.value)) !== identity) return false;
				return pathIdentityKey(primaryRootOrCwd(entry.cwd)) === identity;
			}
			default:
				return false;
		}
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

	#historySchemaHasColumn(column: string): boolean {
		const columns = this.#db.query("PRAGMA table_info(history)").all() as Array<{ name: string }>;
		return columns.some(col => col.name === column);
	}

	/** Adds `column` to `history` when absent; `definition` must carry a default so existing rows stay valid. */
	#ensureColumn(column: string, definition: string): void {
		if (this.#historySchemaHasColumn(column)) return;
		this.#db.run(`ALTER TABLE history ADD COLUMN ${column} ${definition}`);
	}

	/**
	 * One-time dump-and-rebuild pass, gated by `PRAGMA user_version` (owned by
	 * this pass — nothing else versions history.db). Dumps every row, folds each
	 * prompt through {@link normalizePrompt} in JS, keeps the most recent
	 * submission per normalized prompt (the upsert's "latest wins" rule) with
	 * the use counts of every collapsed row summed, and recreates the table from
	 * {@link HISTORY_TABLE_DDL}. Subsumes every legacy shape at once — unixepoch
	 * defaults, missing session_id, non-unique prompt, per-line trailing
	 * padding — without per-shape SQL migrations. Returns whether it ran so the
	 * caller can rebuild the FTS index.
	 */
	#rebuildHistory(): boolean {
		const versionRow = this.#db.query("PRAGMA user_version").get() as { user_version: number };
		if (versionRow.user_version >= HISTORY_DATA_VERSION) return false;
		let rows: HistoryRow[];
		try {
			const sessionIdSelection = this.#historySchemaHasColumn("session_id") ? "session_id" : "NULL AS session_id";
			rows = this.#db
				.query(
					`SELECT id, prompt, created_at, cwd, ${sessionIdSelection}, use_count FROM history WHERE typeof(prompt) = 'text'`,
				)
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
			if (!incumbent) {
				winners.set(prompt, { ...row, prompt });
				continue;
			}
			// Most recent submission wins, matching the upsert's "latest provenance" rule;
			// every collapsed row still counts as a submission.
			const useCount = incumbent.use_count + row.use_count;
			const rowWins =
				row.created_at > incumbent.created_at || (row.created_at === incumbent.created_at && row.id > incumbent.id);
			winners.set(prompt, rowWins ? { ...row, prompt, use_count: useCount } : { ...incumbent, use_count: useCount });
		}
		this.#db.transaction(() => {
			this.#db.run("DROP INDEX IF EXISTS idx_history_created_at");
			this.#db.run("DROP TRIGGER IF EXISTS history_ai");
			this.#db.run("DROP TABLE IF EXISTS history_fts");
			this.#db.run("DROP TABLE history");
			this.#db.run(HISTORY_TABLE_DDL);
			const insert = this.#db.query(
				"INSERT INTO history (id, prompt, created_at, cwd, session_id, use_count) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const row of winners.values()) {
				insert.run(row.id, row.prompt, row.created_at, row.cwd, row.session_id, row.use_count);
			}
			this.#db.run(`PRAGMA user_version = ${HISTORY_DATA_VERSION}`);
		})();
		if (winners.size < rows.length) {
			logger.debug("HistoryStorage collapsed rows during rebuild", { before: rows.length, after: winners.size });
		}
		return true;
	}

	/**
	 * Recall reads the newest window first, so foreign rows there are what crash
	 * the editor. When the window holds any and `quick_check` confirms damage,
	 * failing with SQLITE_CORRUPT hands the store to quarantine and salvage.
	 * A clean check means only odd but intact values, which reads filter.
	 */
	#assertRecentWindowReadable(): void {
		const window = this.#db
			.query(
				`SELECT count(*) AS foreign_rows FROM (SELECT prompt, created_at, use_count FROM history ORDER BY created_at DESC, id DESC LIMIT ${RECENT_WINDOW}) WHERE NOT (${readableRowClause("")})`,
			)
			.get() as { foreign_rows: number };
		if (window.foreign_rows === 0) return;
		const check = this.#db.query("PRAGMA quick_check(1)").get() as { quick_check: string };
		if (check.quick_check === "ok") return;
		throw Object.assign(new Error(`database disk image is malformed (${check.quick_check})`), {
			code: "SQLITE_CORRUPT",
		});
	}

	/**
	 * Copies every prompt, session title, and recap the quarantined store at
	 * `backupPath` can still decode into this replacement. Runs once per
	 * quarantine; a peer that wrote to the replacement first keeps its rows, and
	 * a prompt both hold merges like a resubmission. Best-effort: the backup
	 * stays on disk whatever happens here.
	 */
	#salvage(backupPath: string): void {
		let source: Database | undefined;
		try {
			source = new Database(backupPath, { readonly: true });
			const prompts = readSalvageableRows<Record<keyof HistoryRow, unknown>>(
				source,
				"history",
				"id, prompt, created_at, cwd, session_id, use_count",
			).filter(
				row =>
					Number.isSafeInteger(row.id) &&
					typeof row.prompt === "string" &&
					row.prompt.trim() !== "" &&
					Number.isSafeInteger(row.created_at) &&
					Number.isSafeInteger(row.use_count),
			);
			let sequence: number | undefined;
			try {
				sequence = source
					.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'history'")
					.get()?.seq;
			} catch {}
			const target = this.#db;
			const counts = target.transaction(() => {
				using insert = target.prepare(`
INSERT INTO history (id, prompt, created_at, cwd, session_id, use_count)
VALUES (CASE WHEN EXISTS (SELECT 1 FROM history WHERE id = ?1) THEN NULL ELSE ?1 END, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT(prompt) DO UPDATE SET
	use_count = history.use_count + excluded.use_count,
	created_at = max(history.created_at, excluded.created_at),
	cwd = iif(excluded.created_at > history.created_at, excluded.cwd, history.cwd),
	session_id = iif(excluded.created_at > history.created_at, excluded.session_id, history.session_id)
				`);
				for (const row of prompts) {
					insert.run(
						row.id as number,
						row.prompt as string,
						row.created_at as number,
						typeof row.cwd === "string" ? row.cwd : null,
						typeof row.session_id === "string" ? row.session_id : null,
						row.use_count as number,
					);
				}
				// Keep ids above every id the damaged store handed out: the prediction
				// daemon's cursor reads `id > cursor` and would skip lower new ids.
				if (Number.isSafeInteger(sequence)) {
					target.run("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'history'", [sequence as number]);
				}
				return { prompts: prompts.length, ...salvageSessionIndex(source as Database, target) };
			})();
			logger.warn("Salvaged readable rows from a damaged history database", { backupPath, ...counts });
		} catch (error) {
			logger.error("HistoryStorage salvage failed; the damaged store is preserved", {
				backupPath,
				error: String(error),
			});
		} finally {
			source?.close();
		}
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		const clamped = Math.max(0, Math.floor(limit));
		return Math.min(clamped, 1000);
	}

	/**
	 * Whitespace-delimited query terms, lowercased for stable substring matching.
	 * A term without a letter or digit matches nothing and is dropped.
	 */
	#terms(query: string): string[] {
		return query
			.toLowerCase()
			.split(/\s+/u)
			.filter(term => /[\p{L}\p{N}]/u.test(term));
	}

	#searchSubstring(terms: string[], limit: number, clause: ScopeClause): HistoryRow[] {
		const whereClause = terms.map(() => "prompt LIKE ? ESCAPE '\\' COLLATE NOCASE").join(" AND ");
		// One LIKE term per token, so this text — and any cache key built from it — grows with the
		// query. Prepared per call and finalized right after: measured 8-34 us against the 1.5-29 ms
		// this scan already costs, so caching it bought nothing and retained a statement per token
		// count ever searched.
		const stmt = this.#db.prepare(
			`SELECT id, prompt, created_at, cwd, session_id, use_count FROM history WHERE ${readableRowClause("")} AND ${whereClause} ${clause.and} ORDER BY created_at DESC, id DESC LIMIT ?`,
		);
		try {
			const params: SQLQueryBindings[] = terms.map(term => `%${escapeLikePattern(term)}%`);
			params.push(...clause.params, limit);
			return stmt.all(...params) as HistoryRow[];
		} finally {
			stmt.finalize();
		}
	}

	/**
	 * SQL fragment (and its bound values) restricting a read to a scope or exact metadata filter.
	 * Omitted filters and `global` read the whole table; unknown scope kinds match nothing.
	 */
	#scopeClause(scope?: HistoryScope | HistoryFilter): ScopeClause {
		if (!scope) return EMPTY_SCOPE_CLAUSE;
		const selection: Partial<HistoryScope> & HistoryFilter = scope;
		const kind = selection.kind;
		if (kind === undefined) {
			const cwd = selection.cwd ?? null;
			const sessionId = selection.sessionId ?? null;
			if (cwd === null && sessionId === null) return EMPTY_SCOPE_CLAUSE;
			if (cwd === null) return { and: "AND session_id = ?", params: [sessionId] };
			if (sessionId === null) return { and: "AND cwd = ?", params: [cwd] };
			return { and: "AND cwd = ? AND session_id = ?", params: [cwd, sessionId] };
		}
		switch (kind) {
			case "global":
				return EMPTY_SCOPE_CLAUSE;
			case "session":
				return { and: "AND session_id = ?", params: [selection.value ?? ""] };
			case "cwd":
			case "repo":
				return {
					and: DIRS_AND,
					params: [JSON.stringify(this.#scopeDirs(kind, selection.value))],
				};
			default:
				return { and: "AND 1 = 0", params: [] };
		}
	}

	/**
	 * Stored directories a scope reads: the ones denoting `target` itself (`cwd`), or every
	 * one belonging to the repository rooted at `target` (`repo`).
	 *
	 * `cwd` holds the raw submission directory, so a plain equality is not enough: a subdirectory
	 * or a linked worktree shares only its primary root with the repository, and the same
	 * directory can be stored under two spellings (a symlinked checkout keeps its symlink
	 * spelling, since `setProjectDir` resolves lexically). Each read therefore filters the stored
	 * set, comparing filesystem identity on both sides.
	 *
	 * Raw directory rows are cached between database writes. Filtering re-resolves each
	 * distinct directory so nested repositories and symlink retargets stay visible.
	 */
	#scopeDirs(kind: "cwd" | "repo", target?: string): string[] {
		if (!target) return [];
		const identity = pathIdentityKey(target);
		const dirs = this.#storedDirs();
		if (kind === "cwd") return dirs.filter(dir => pathIdentityKey(dir) === identity);
		// Discovery needs an actual path, never a comparison key or a case-folded spelling.
		// A bare subdirectory or linked worktree is not itself the primary repository root.
		if (pathIdentityKey(primaryRootOrCwd(target)) !== identity) return [];
		return dirs.filter(dir => pathIdentityKey(primaryRootOrCwd(dir)) === identity);
	}

	#storedDirs(): string[] {
		try {
			// Own writes invalidate explicitly; data_version tracks other connections.
			const version = (this.#prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
			if (this.#storedDirsCache?.dataVersion === version) return this.#storedDirsCache.dirs;
			const rows = this.#prepare(
				`SELECT DISTINCT cwd FROM history WHERE ${readableRowClause("")} AND typeof(cwd) = 'text' AND cwd <> ''`,
			).all() as { cwd: string }[];
			const dirs = rows.map(row => row.cwd);
			// Stamp the version sampled before SELECT, never a later commit onto older rows.
			this.#storedDirsCache = { dataVersion: version, dirs };
			return dirs;
		} catch (error) {
			this.#storedDirsCache = undefined;
			throw error;
		}
	}

	#prepare(sql: string): Statement {
		let stmt = this.#stmts.get(sql);
		if (!stmt) {
			stmt = this.#db.prepare(sql);
			this.#stmts.set(sql, stmt);
		}
		return stmt;
	}

	#toEntry(row: HistoryRow): HistoryEntry {
		return {
			id: row.id,
			prompt: row.prompt,
			created_at: row.created_at,
			cwd: row.cwd ?? undefined,
			sessionId: row.session_id ?? undefined,
			useCount: row.use_count,
		};
	}
}
