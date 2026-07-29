import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	type AppendEventInput,
	type CreateEpisodeInput,
	type CreateJobInput,
	type CreateNotificationInput,
	DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
	type DurableJob,
	type EpisodeRecord,
	type EpisodeSearchOptions,
	type EventListFilter,
	JOB_STATUSES,
	type JobCheckpoint,
	type JobListFilter,
	type JobStatus,
	type JobTransitionInput,
	type JsonObject,
	type JsonValue,
	type MaterializeDueScheduleInput,
	type NotificationRecord,
	type RecurringSchedule,
	type ScopedStateEntry,
	type StateScope,
	TRAJECTORY_EVENT_KINDS,
	type TrajectoryEvent,
	type TrajectoryEventKind,
	type UpsertScheduleInput,
} from "./types";

const SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 60_000;
/**
 * Episode search prefers FTS5 (`episodes_fts`) when available.
 * If FTS5 cannot be created, search falls back to indexed LIKE over
 * `search_text` (title + summary + tags), which remains useful across sessions.
 */

const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
	queued: ["running", "paused", "cancelled"],
	running: ["paused", "completed", "failed", "cancelled", "queued"],
	paused: ["running", "cancelled", "queued"],
	completed: [],
	failed: ["queued"],
	cancelled: [],
};

type ScopeKind = "user" | "project";

type StateRow = {
	scope_kind: ScopeKind;
	project_path: string;
	key: string;
	value_json: string;
	updated_at: number;
};

type EpisodeRow = {
	id: string;
	session_id: string;
	title: string;
	summary: string;
	tags_json: string;
	metadata_json: string;
	search_text: string;
	created_at: number;
	updated_at: number;
};

type JobRow = {
	id: string;
	type: string;
	status: string;
	payload_json: string;
	result_json: string | null;
	error: string | null;
	lease_owner: string | null;
	lease_expires_at: number | null;
	checkpoint_json: string | null;
	schedule_id: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	completed_at: number | null;
};

type ScheduleRow = {
	id: string;
	name: string;
	cron: string;
	next_run_at: number | null;
	enabled: number;
	payload_json: string;
	created_at: number;
	updated_at: number;
};

type NotificationRow = {
	id: string;
	kind: string;
	title: string;
	body: string;
	read: number;
	metadata_json: string;
	created_at: number;
};

type EventRow = {
	id: string;
	kind: string;
	job_id: string | null;
	session_id: string | null;
	payload_json: string;
	created_at: number;
};

export interface OperationalStoreOptions {
	/** Explicit SQLite path. Defaults to `~/.ompk/agent/operational.db`. */
	readonly dbPath?: string;
	/** Injected clock (epoch ms) for deterministic tests. */
	readonly now?: () => number;
	/** Injected id factory for deterministic tests. */
	readonly createId?: () => string;
	/** Max UTF-8 bytes for serialized trajectory event payloads. */
	readonly maxEventPayloadBytes?: number;
	/** SQLite synchronous mode. Production defaults to `full`; tests may opt into `normal`. */
	readonly durability?: "full" | "normal";
}

function defaultDbPath(): string {
	return path.join(getAgentDir(), "operational.db");
}

function defaultCreateId(): string {
	return Bun.randomUUIDv7();
}

function isJobStatus(value: string): value is JobStatus {
	return (JOB_STATUSES as readonly string[]).includes(value);
}

function isEventKind(value: string): value is TrajectoryEventKind {
	return (TRAJECTORY_EVENT_KINDS as readonly string[]).includes(value);
}

function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, "\\$&");
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/i)
		.map(token => token.trim())
		.filter(token => token.length > 0);
}

/**
 * Safe JSON serialization for operational payloads.
 * Drops `undefined`, converts `bigint` to string, and replaces cycles / non-JSON
 * values with `null` rather than throwing.
 */
export function serializeJsonValue(value: unknown): string {
	const seen = new WeakSet<object>();
	return (
		JSON.stringify(value, (_key, current: unknown) => {
			if (current === undefined) return undefined;
			if (typeof current === "bigint") return current.toString();
			if (typeof current === "function" || typeof current === "symbol") return null;
			if (current !== null && typeof current === "object") {
				if (seen.has(current)) return null;
				seen.add(current);
			}
			return current;
		}) ?? "null"
	);
}

export function parseJsonValue(raw: string | null | undefined): JsonValue {
	if (raw === null || raw === undefined || raw === "") return null;
	try {
		return JSON.parse(raw) as JsonValue;
	} catch {
		return null;
	}
}

export function capJsonPayload(value: JsonValue, maxBytes: number): JsonValue {
	const serialized = serializeJsonValue(value);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes <= maxBytes) return value;

	const previewBudget = Math.max(64, Math.min(maxBytes - 128, 2048));
	let preview = serialized;
	while (Buffer.byteLength(preview, "utf8") > previewBudget && preview.length > 0) {
		preview = preview.slice(0, Math.floor(preview.length * 0.85));
	}

	const capped: JsonObject = {
		truncated: true,
		originalBytes: bytes,
		maxBytes,
		preview,
	};
	return capped;
}

function normalizeScope(scope: StateScope): { scopeKind: ScopeKind; projectPath: string } {
	if (scope.kind === "user") {
		return { scopeKind: "user", projectPath: "" };
	}
	const projectPath = scope.projectPath.trim();
	if (!projectPath) {
		throw new Error("project scope requires a non-empty projectPath");
	}
	return { scopeKind: "project", projectPath };
}

function scopeFromRow(row: Pick<StateRow, "scope_kind" | "project_path">): StateScope {
	if (row.scope_kind === "project") {
		return { kind: "project", projectPath: row.project_path };
	}
	return { kind: "user" };
}

function episodeSearchText(title: string, summary: string, tags: readonly string[]): string {
	return `${title}\n${summary}\n${tags.join(" ")}`.trim();
}

export class OperationalStore {
	readonly #db: Database;
	readonly #dbPath: string;
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #maxEventPayloadBytes: number;
	readonly #ftsEnabled: boolean;
	#closed = false;

	readonly #setStateStmt: Statement;
	readonly #getStateStmt: Statement;
	readonly #deleteStateStmt: Statement;
	readonly #listStateStmt: Statement;
	readonly #listStatePrefixStmt: Statement;

	readonly #insertEpisodeStmt: Statement;
	readonly #getEpisodeStmt: Statement;
	readonly #listEpisodesStmt: Statement;
	readonly #searchEpisodesLikeStmt: Statement;
	#searchEpisodesFtsStmt: Statement | null = null;
	#insertEpisodeFtsStmt: Statement | null = null;

	readonly #insertJobStmt: Statement;
	readonly #getJobStmt: Statement;
	readonly #updateJobStmt: Statement;
	readonly #selectClaimCandidateStmt: Statement;
	readonly #selectExpiredRunningStmt: Statement;

	readonly #upsertScheduleStmt: Statement;
	readonly #getScheduleStmt: Statement;
	readonly #listSchedulesStmt: Statement;
	readonly #listDueSchedulesStmt: Statement;
	readonly #casScheduleNextRunStmt: Statement;

	readonly #insertNotificationStmt: Statement;
	readonly #listNotificationsStmt: Statement;
	readonly #markNotificationReadStmt: Statement;

	readonly #insertEventStmt: Statement;
	readonly #listEventsStmt: Statement;

	constructor(options: OperationalStoreOptions = {}) {
		this.#dbPath = options.dbPath ?? defaultDbPath();
		this.#now = options.now ?? (() => Date.now());
		this.#createId = options.createId ?? defaultCreateId;
		this.#maxEventPayloadBytes = options.maxEventPayloadBytes ?? DEFAULT_MAX_EVENT_PAYLOAD_BYTES;

		fs.mkdirSync(path.dirname(this.#dbPath), { recursive: true });
		this.#db = new Database(this.#dbPath);
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run(`PRAGMA synchronous = ${options.durability === "normal" ? "NORMAL" : "FULL"}`);
		this.#db.run("PRAGMA foreign_keys = ON");
		this.#initializeSchema();
		this.#ftsEnabled = this.#ensureEpisodeFts();

		this.#setStateStmt = this.#db.prepare(
			`INSERT INTO scoped_state (scope_kind, project_path, key, value_json, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(scope_kind, project_path, key) DO UPDATE SET
			   value_json = excluded.value_json,
			   updated_at = excluded.updated_at`,
		);
		this.#getStateStmt = this.#db.prepare(
			"SELECT scope_kind, project_path, key, value_json, updated_at FROM scoped_state WHERE scope_kind = ? AND project_path = ? AND key = ?",
		);
		this.#deleteStateStmt = this.#db.prepare(
			"DELETE FROM scoped_state WHERE scope_kind = ? AND project_path = ? AND key = ?",
		);
		this.#listStateStmt = this.#db.prepare(
			"SELECT scope_kind, project_path, key, value_json, updated_at FROM scoped_state WHERE scope_kind = ? AND project_path = ? ORDER BY key ASC",
		);
		this.#listStatePrefixStmt = this.#db.prepare(
			`SELECT scope_kind, project_path, key, value_json, updated_at FROM scoped_state
			 WHERE scope_kind = ? AND project_path = ? AND key LIKE ? ESCAPE '\\'
			 ORDER BY key ASC`,
		);

		this.#insertEpisodeStmt = this.#db.prepare(
			`INSERT INTO episodes (id, session_id, title, summary, tags_json, metadata_json, search_text, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		this.#getEpisodeStmt = this.#db.prepare("SELECT * FROM episodes WHERE id = ?");
		this.#listEpisodesStmt = this.#db.prepare("SELECT * FROM episodes ORDER BY created_at DESC, id DESC LIMIT ?");
		this.#searchEpisodesLikeStmt = this.#db.prepare(
			`SELECT * FROM episodes
			 WHERE search_text LIKE ? ESCAPE '\\'
			   AND (? IS NULL OR session_id = ?)
			 ORDER BY created_at DESC, id DESC
			 LIMIT ?`,
		);
		if (this.#ftsEnabled) {
			this.#searchEpisodesFtsStmt = this.#db.prepare(
				`SELECT e.* FROM episodes_fts f
				 JOIN episodes e ON e.id = f.episode_id
				 WHERE episodes_fts MATCH ?
				   AND (? IS NULL OR e.session_id = ?)
				 ORDER BY e.created_at DESC, e.id DESC
				 LIMIT ?`,
			);
			this.#insertEpisodeFtsStmt = this.#db.prepare(
				"INSERT INTO episodes_fts(episode_id, title, summary, tags, search_text) VALUES (?, ?, ?, ?, ?)",
			);
		}

		this.#insertJobStmt = this.#db.prepare(
			`INSERT INTO jobs (
				id, type, status, payload_json, result_json, error, lease_owner, lease_expires_at,
				checkpoint_json, schedule_id, created_at, updated_at, started_at, completed_at
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
		);
		this.#getJobStmt = this.#db.prepare("SELECT * FROM jobs WHERE id = ?");
		this.#updateJobStmt = this.#db.prepare(
			`UPDATE jobs SET
				status = ?, result_json = ?, error = ?, lease_owner = ?, lease_expires_at = ?,
				checkpoint_json = ?, updated_at = ?, started_at = ?, completed_at = ?
			 WHERE id = ?`,
		);
		this.#selectClaimCandidateStmt = this.#db.prepare(
			`SELECT * FROM jobs WHERE status = 'queued' AND (? IS NULL OR type = ?)
			 ORDER BY created_at ASC, id ASC LIMIT 1`,
		);
		this.#selectExpiredRunningStmt = this.#db.prepare(
			`SELECT * FROM jobs
			 WHERE status = 'running'
			   AND lease_expires_at IS NOT NULL
			   AND lease_expires_at < ?
			 ORDER BY lease_expires_at ASC, id ASC`,
		);

		this.#upsertScheduleStmt = this.#db.prepare(
			`INSERT INTO schedules (id, name, cron, next_run_at, enabled, payload_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   cron = excluded.cron,
			   next_run_at = excluded.next_run_at,
			   enabled = excluded.enabled,
			   payload_json = excluded.payload_json,
			   updated_at = excluded.updated_at`,
		);
		this.#getScheduleStmt = this.#db.prepare("SELECT * FROM schedules WHERE id = ?");
		this.#listSchedulesStmt = this.#db.prepare("SELECT * FROM schedules ORDER BY name ASC, id ASC");
		this.#listDueSchedulesStmt = this.#db.prepare(
			`SELECT * FROM schedules
			 WHERE enabled = 1
			   AND next_run_at IS NOT NULL
			   AND next_run_at <= ?
			 ORDER BY next_run_at ASC, id ASC`,
		);
		this.#casScheduleNextRunStmt = this.#db.prepare(
			`UPDATE schedules
			 SET next_run_at = ?, updated_at = ?
			 WHERE id = ?
			   AND enabled = 1
			   AND next_run_at = ?`,
		);

		this.#insertNotificationStmt = this.#db.prepare(
			`INSERT INTO notifications (id, kind, title, body, read, metadata_json, created_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		);
		this.#listNotificationsStmt = this.#db.prepare(
			"SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT ?",
		);
		this.#markNotificationReadStmt = this.#db.prepare("UPDATE notifications SET read = 1 WHERE id = ?");

		this.#insertEventStmt = this.#db.prepare(
			`INSERT INTO trajectory_events (id, kind, job_id, session_id, payload_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		this.#listEventsStmt = this.#db.prepare(
			`SELECT * FROM trajectory_events
			 WHERE (? IS NULL OR kind = ?)
			   AND (? IS NULL OR job_id = ?)
			   AND (? IS NULL OR session_id = ?)
			   AND (? IS NULL OR created_at > ?)
			 ORDER BY created_at ASC, id ASC
			 LIMIT ?`,
		);
	}

	/** Open (or create) the operational SQLite database. */
	static open(options: OperationalStoreOptions = {}): OperationalStore {
		return new OperationalStore(options);
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	get ftsEnabled(): boolean {
		return this.#ftsEnabled;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#setStateStmt.finalize();
		this.#getStateStmt.finalize();
		this.#deleteStateStmt.finalize();
		this.#listStateStmt.finalize();
		this.#listStatePrefixStmt.finalize();
		this.#insertEpisodeStmt.finalize();
		this.#getEpisodeStmt.finalize();
		this.#listEpisodesStmt.finalize();
		this.#searchEpisodesLikeStmt.finalize();
		this.#searchEpisodesFtsStmt?.finalize();
		this.#insertEpisodeFtsStmt?.finalize();
		this.#insertJobStmt.finalize();
		this.#getJobStmt.finalize();
		this.#updateJobStmt.finalize();
		this.#selectClaimCandidateStmt.finalize();
		this.#selectExpiredRunningStmt.finalize();
		this.#upsertScheduleStmt.finalize();
		this.#getScheduleStmt.finalize();
		this.#listSchedulesStmt.finalize();
		this.#listDueSchedulesStmt.finalize();
		this.#casScheduleNextRunStmt.finalize();
		this.#insertNotificationStmt.finalize();
		this.#listNotificationsStmt.finalize();
		this.#markNotificationReadStmt.finalize();
		this.#insertEventStmt.finalize();
		this.#listEventsStmt.finalize();
		this.#db.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("OperationalStore is closed");
	}

	#initializeSchema(): void {
		this.#db.run(`
CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS scoped_state (
	scope_kind TEXT NOT NULL CHECK(scope_kind IN ('user', 'project')),
	project_path TEXT NOT NULL DEFAULT '',
	key TEXT NOT NULL,
	value_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (scope_kind, project_path, key)
);
CREATE INDEX IF NOT EXISTS idx_scoped_state_scope ON scoped_state(scope_kind, project_path);

CREATE TABLE IF NOT EXISTS episodes (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT NOT NULL,
	tags_json TEXT NOT NULL,
	metadata_json TEXT NOT NULL,
	search_text TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_session_created ON episodes(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_search_text ON episodes(search_text);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('queued','running','paused','completed','failed','cancelled')),
	payload_json TEXT NOT NULL,
	result_json TEXT,
	error TEXT,
	lease_owner TEXT,
	lease_expires_at INTEGER,
	checkpoint_json TEXT,
	schedule_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	started_at INTEGER,
	completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires ON jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS schedules (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	cron TEXT NOT NULL,
	next_run_at INTEGER,
	enabled INTEGER NOT NULL DEFAULT 1,
	payload_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS notifications (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	read INTEGER NOT NULL DEFAULT 0,
	metadata_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

CREATE TABLE IF NOT EXISTS trajectory_events (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	job_id TEXT,
	session_id TEXT,
	payload_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON trajectory_events(created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_events_kind_created ON trajectory_events(kind, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_events_job ON trajectory_events(job_id, created_at ASC);
`);

		const versionRow = this.#db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
			| { version?: number }
			| undefined;
		const current = typeof versionRow?.version === "number" ? versionRow.version : 0;
		if (current > SCHEMA_VERSION) {
			throw new Error(`Operational database schema ${current} is newer than supported version ${SCHEMA_VERSION}`);
		}
		if (current < SCHEMA_VERSION) {
			this.#migrateSchema(current);
			this.#db.prepare("INSERT OR REPLACE INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
		}
	}

	#migrateSchema(_fromVersion: number): void {
		// v1 is the initial schema created by CREATE TABLE IF NOT EXISTS above.
	}

	#ensureEpisodeFts(): boolean {
		try {
			this.#db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
	episode_id UNINDEXED,
	title,
	summary,
	tags,
	search_text
)`);
			return true;
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------------------------
	// Scoped state
	// ---------------------------------------------------------------------------

	setState(scope: StateScope, key: string, value: JsonValue): ScopedStateEntry {
		this.#assertOpen();
		const trimmed = key.trim();
		if (!trimmed) throw new Error("state key must be non-empty");
		const { scopeKind, projectPath } = normalizeScope(scope);
		const updatedAt = this.#now();
		const valueJson = serializeJsonValue(value);
		this.#setStateStmt.run(scopeKind, projectPath, trimmed, valueJson, updatedAt);
		return {
			scope: scopeFromRow({ scope_kind: scopeKind, project_path: projectPath }),
			key: trimmed,
			value: parseJsonValue(valueJson),
			updatedAt,
		};
	}

	getState(scope: StateScope, key: string): JsonValue | null {
		this.#assertOpen();
		const { scopeKind, projectPath } = normalizeScope(scope);
		const row = this.#getStateStmt.get(scopeKind, projectPath, key.trim()) as StateRow | null;
		if (!row) return null;
		return parseJsonValue(row.value_json);
	}

	deleteState(scope: StateScope, key: string): boolean {
		this.#assertOpen();
		const { scopeKind, projectPath } = normalizeScope(scope);
		const result = this.#deleteStateStmt.run(scopeKind, projectPath, key.trim());
		return result.changes > 0;
	}

	listState(scope: StateScope, prefix?: string): ScopedStateEntry[] {
		this.#assertOpen();
		const { scopeKind, projectPath } = normalizeScope(scope);
		const rows =
			prefix && prefix.length > 0
				? (this.#listStatePrefixStmt.all(scopeKind, projectPath, `${escapeLikePattern(prefix)}%`) as StateRow[])
				: (this.#listStateStmt.all(scopeKind, projectPath) as StateRow[]);
		return rows.map(row => ({
			scope: scopeFromRow(row),
			key: row.key,
			value: parseJsonValue(row.value_json),
			updatedAt: row.updated_at,
		}));
	}

	// ---------------------------------------------------------------------------
	// Episodes
	// ---------------------------------------------------------------------------

	createEpisode(input: CreateEpisodeInput): EpisodeRecord {
		this.#assertOpen();
		const now = this.#now();
		const id = input.id ?? this.#createId();
		const tags = input.tags ? [...input.tags] : [];
		const metadata = input.metadata ?? null;
		const searchText = episodeSearchText(input.title, input.summary, tags);
		this.#insertEpisodeStmt.run(
			id,
			input.sessionId ?? "",
			input.title,
			input.summary,
			serializeJsonValue(tags),
			serializeJsonValue(metadata),
			searchText,
			now,
			now,
		);
		this.#insertEpisodeFtsStmt?.run(id, input.title, input.summary, serializeJsonValue(tags), searchText);
		const created = this.getEpisode(id);
		if (!created) throw new Error(`failed to read episode ${id}`);
		return created;
	}

	getEpisode(id: string): EpisodeRecord | null {
		this.#assertOpen();
		const row = this.#getEpisodeStmt.get(id) as EpisodeRow | null;
		return row ? this.#toEpisode(row) : null;
	}

	listEpisodes(limit = 100): EpisodeRecord[] {
		this.#assertOpen();
		const rows = this.#listEpisodesStmt.all(this.#normalizeLimit(limit)) as EpisodeRow[];
		return rows.map(row => this.#toEpisode(row));
	}

	/**
	 * Cross-session episode search.
	 * Uses FTS5 when available; otherwise indexed LIKE over `search_text`.
	 */
	searchEpisodes(query: string, options: EpisodeSearchOptions = {}): EpisodeRecord[] {
		this.#assertOpen();
		const limit = this.#normalizeLimit(options.limit ?? 50);
		if (limit === 0) return [];
		const tokens = tokenize(query);
		if (tokens.length === 0) return [];
		const sessionId = options.sessionId ?? null;

		if (this.#ftsEnabled && this.#searchEpisodesFtsStmt) {
			const ftsQuery = tokens.map(token => `"${token.replace(/"/g, '""')}"*`).join(" ");
			try {
				const rows = this.#searchEpisodesFtsStmt.all(ftsQuery, sessionId, sessionId, limit) as EpisodeRow[];
				if (rows.length > 0) return rows.map(row => this.#toEpisode(row));
			} catch {
				// Fall through to LIKE fallback.
			}
		}

		// Indexed fallback: AND tokens via successive filters in JS over a LIKE seed.
		const seed = `%${escapeLikePattern(tokens[0]!)}%`;
		const seedRows = this.#searchEpisodesLikeStmt.all(
			seed,
			sessionId,
			sessionId,
			Math.max(limit * 4, 50),
		) as EpisodeRow[];
		return seedRows
			.filter(row => {
				const hay = row.search_text.toLowerCase();
				return tokens.every(token => hay.includes(token));
			})
			.slice(0, limit)
			.map(row => this.#toEpisode(row));
	}

	#toEpisode(row: EpisodeRow): EpisodeRecord {
		const tagsRaw = parseJsonValue(row.tags_json);
		const tags = Array.isArray(tagsRaw) ? tagsRaw.map(tag => String(tag)) : [];
		return {
			id: row.id,
			sessionId: row.session_id || null,
			title: row.title,
			summary: row.summary,
			tags,
			metadata: parseJsonValue(row.metadata_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	// ---------------------------------------------------------------------------
	// Durable jobs
	// ---------------------------------------------------------------------------

	createJob(input: CreateJobInput): DurableJob {
		this.#assertOpen();
		const now = this.#now();
		const id = input.id ?? this.#createId();
		const status = input.status ?? "queued";
		this.#insertJobStmt.run(
			id,
			input.type,
			status,
			serializeJsonValue(input.payload ?? null),
			input.scheduleId ?? null,
			now,
			now,
		);
		const job = this.getJob(id);
		if (!job) throw new Error(`failed to read job ${id}`);
		return job;
	}

	getJob(id: string): DurableJob | null {
		this.#assertOpen();
		const row = this.#getJobStmt.get(id) as JobRow | null;
		return row ? this.#toJob(row) : null;
	}

	listJobs(filter: JobListFilter = {}): DurableJob[] {
		this.#assertOpen();
		const limit = this.#normalizeLimit(filter.limit ?? 100);
		const statuses =
			filter.status === undefined ? null : Array.isArray(filter.status) ? [...filter.status] : [filter.status];
		const type = filter.type ?? null;

		let sql = "SELECT * FROM jobs WHERE 1=1";
		const params: SQLQueryBindings[] = [];
		if (statuses && statuses.length > 0) {
			sql += ` AND status IN (${statuses.map(() => "?").join(", ")})`;
			params.push(...statuses);
		}
		if (type !== null) {
			sql += " AND type = ?";
			params.push(type);
		}
		sql += " ORDER BY created_at ASC, id ASC LIMIT ?";
		params.push(limit);
		const rows = this.#db.prepare(sql).all(...params) as JobRow[];
		return rows.map(row => this.#toJob(row));
	}

	/**
	 * Atomically claim the oldest queued job (optionally filtered by type).
	 * Sets status=running and assigns lease ownership/expiry.
	 */
	claimJob(leaseOwner: string, leaseMs = DEFAULT_LEASE_MS, type?: string): DurableJob | null {
		this.#assertOpen();
		if (!leaseOwner.trim()) throw new Error("leaseOwner is required");
		const owner = leaseOwner.trim();
		const leaseDuration = Math.max(1, leaseMs);

		const claim = this.#db.transaction(() => {
			const candidate = this.#selectClaimCandidateStmt.get(type ?? null, type ?? null) as JobRow | null;
			if (!candidate) return null;
			const now = this.#now();
			const updated: JobRow = {
				...candidate,
				status: "running",
				lease_owner: owner,
				lease_expires_at: now + leaseDuration,
				updated_at: now,
				started_at: candidate.started_at ?? now,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});

		return claim();
	}

	transitionJob(id: string, input: JobTransitionInput): DurableJob {
		this.#assertOpen();
		const transition = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(id) as JobRow | null;
			if (!row) throw new Error(`job not found: ${id}`);
			if (!isJobStatus(row.status)) throw new Error(`corrupt job status: ${row.status}`);

			const from = row.status;
			const to = input.to;
			if (!ALLOWED_TRANSITIONS[from].includes(to)) {
				throw new Error(`invalid job transition ${from} -> ${to}`);
			}

			if (from === "running" || from === "paused") {
				if (row.lease_owner !== null) {
					if (
						input.leaseOwner === undefined ||
						input.leaseOwner === null ||
						input.leaseOwner !== row.lease_owner
					) {
						throw new Error(`stale lease owner for job ${id}`);
					}
				}
			}

			const now = this.#now();
			let leaseOwner = row.lease_owner;
			let leaseExpiresAt = row.lease_expires_at;
			let startedAt = row.started_at;
			let completedAt = row.completed_at;
			let resultJson = row.result_json;
			let error = row.error;

			if (to === "running") {
				const owner = (input.leaseOwner ?? row.lease_owner ?? "").trim();
				if (!owner) throw new Error("leaseOwner is required when transitioning to running");
				leaseOwner = owner;
				leaseExpiresAt = now + Math.max(1, input.leaseMs ?? DEFAULT_LEASE_MS);
				startedAt = startedAt ?? now;
				completedAt = null;
			} else if (to === "queued") {
				leaseOwner = null;
				leaseExpiresAt = null;
				completedAt = null;
				error = null;
			} else if (to === "paused") {
				leaseOwner = input.leaseOwner ?? row.lease_owner;
			} else if (to === "completed" || to === "failed" || to === "cancelled") {
				leaseOwner = null;
				leaseExpiresAt = null;
				completedAt = now;
			}

			if (input.result !== undefined) {
				resultJson = serializeJsonValue(input.result);
			}
			if (input.error !== undefined) {
				error = input.error;
			}

			const updated: JobRow = {
				...row,
				status: to,
				result_json: resultJson,
				error,
				lease_owner: leaseOwner,
				lease_expires_at: leaseExpiresAt,
				updated_at: now,
				started_at: startedAt,
				completed_at: completedAt,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});

		return transition();
	}

	setCheckpoint(jobId: string, data: JsonValue): JobCheckpoint {
		this.#assertOpen();
		const set = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			const now = this.#now();
			const updated: JobRow = {
				...row,
				checkpoint_json: serializeJsonValue(data),
				updated_at: now,
			};
			this.#writeJobRow(updated);
			return { jobId, data: parseJsonValue(updated.checkpoint_json), updatedAt: now };
		});
		return set();
	}

	setCheckpointForLease(jobId: string, leaseOwner: string, data: JsonValue): JobCheckpoint {
		this.#assertOpen();
		const owner = leaseOwner.trim();
		if (!owner) throw new Error("leaseOwner is required");
		const set = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			if (row.status !== "running" || row.lease_owner !== owner) {
				throw new Error(`stale lease owner for job ${jobId}`);
			}
			const now = this.#now();
			const updated: JobRow = {
				...row,
				checkpoint_json: serializeJsonValue(data),
				updated_at: now,
			};
			this.#writeJobRow(updated);
			return { jobId, data: parseJsonValue(updated.checkpoint_json), updatedAt: now };
		});
		return set();
	}

	releasePausedLease(jobId: string, leaseOwner: string): DurableJob {
		this.#assertOpen();
		const release = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			if (row.status !== "paused" || row.lease_owner !== leaseOwner) {
				throw new Error(`stale paused lease owner for job ${jobId}`);
			}
			const updated: JobRow = {
				...row,
				lease_owner: null,
				lease_expires_at: null,
				updated_at: this.#now(),
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});
		return release();
	}

	getCheckpoint(jobId: string): JobCheckpoint | null {
		this.#assertOpen();
		const row = this.#getJobStmt.get(jobId) as JobRow | null;
		if (!row || row.checkpoint_json === null) return null;
		return {
			jobId,
			data: parseJsonValue(row.checkpoint_json),
			updatedAt: row.updated_at,
		};
	}

	/**
	 * Extend the lease on a running job. Requires the current lease owner.
	 */
	renewLease(jobId: string, leaseOwner: string, leaseMs = DEFAULT_LEASE_MS): DurableJob {
		this.#assertOpen();
		const owner = leaseOwner.trim();
		if (!owner) throw new Error("leaseOwner is required");
		const renew = this.#db.transaction(() => {
			const row = this.#getJobStmt.get(jobId) as JobRow | null;
			if (!row) throw new Error(`job not found: ${jobId}`);
			if (row.status !== "running") {
				throw new Error(`cannot renew lease for job ${jobId} in status ${row.status}`);
			}
			if (row.lease_owner !== owner) {
				throw new Error(`stale lease owner for job ${jobId}`);
			}
			const now = this.#now();
			const updated: JobRow = {
				...row,
				lease_expires_at: now + Math.max(1, leaseMs),
				updated_at: now,
			};
			this.#writeJobRow(updated);
			return this.#toJob(updated);
		});
		return renew();
	}

	/** Re-queue running jobs whose leases have expired. */
	recoverExpiredLeases(): DurableJob[] {
		this.#assertOpen();
		const recover = this.#db.transaction(() => {
			const now = this.#now();
			const expired = this.#selectExpiredRunningStmt.all(now) as JobRow[];
			const recovered: DurableJob[] = [];
			for (const row of expired) {
				const updated: JobRow = {
					...row,
					status: "queued",
					lease_owner: null,
					lease_expires_at: null,
					updated_at: now,
				};
				this.#writeJobRow(updated);
				recovered.push(this.#toJob(updated));
			}
			return recovered;
		});
		return recover();
	}

	#writeJobRow(row: JobRow): void {
		this.#updateJobStmt.run(
			row.status,
			row.result_json,
			row.error,
			row.lease_owner,
			row.lease_expires_at,
			row.checkpoint_json,
			row.updated_at,
			row.started_at,
			row.completed_at,
			row.id,
		);
	}

	#toJob(row: JobRow): DurableJob {
		if (!isJobStatus(row.status)) {
			throw new Error(`corrupt job status: ${row.status}`);
		}
		return {
			id: row.id,
			type: row.type,
			status: row.status,
			payload: parseJsonValue(row.payload_json),
			result: row.result_json === null ? null : parseJsonValue(row.result_json),
			error: row.error,
			leaseOwner: row.lease_owner,
			leaseExpiresAt: row.lease_expires_at,
			checkpoint: row.checkpoint_json === null ? null : parseJsonValue(row.checkpoint_json),
			scheduleId: row.schedule_id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			startedAt: row.started_at,
			completedAt: row.completed_at,
		};
	}

	// ---------------------------------------------------------------------------
	// Schedules
	// ---------------------------------------------------------------------------

	upsertSchedule(input: UpsertScheduleInput): RecurringSchedule {
		this.#assertOpen();
		const now = this.#now();
		const id = input.id ?? this.#createId();
		const existing = this.#getScheduleStmt.get(id) as ScheduleRow | null;
		const createdAt = existing?.created_at ?? now;
		this.#upsertScheduleStmt.run(
			id,
			input.name,
			input.cron,
			input.nextRunAt ?? null,
			input.enabled === false ? 0 : 1,
			serializeJsonValue(input.payload ?? null),
			createdAt,
			now,
		);
		const schedule = this.getSchedule(id);
		if (!schedule) throw new Error(`failed to read schedule ${id}`);
		return schedule;
	}

	getSchedule(id: string): RecurringSchedule | null {
		this.#assertOpen();
		const row = this.#getScheduleStmt.get(id) as ScheduleRow | null;
		return row ? this.#toSchedule(row) : null;
	}

	listSchedules(): RecurringSchedule[] {
		this.#assertOpen();
		const rows = this.#listSchedulesStmt.all() as ScheduleRow[];
		return rows.map(row => this.#toSchedule(row));
	}

	/** Enabled schedules whose nextRunAt is due at or before `now`. */
	listDueSchedules(now = this.#now()): RecurringSchedule[] {
		this.#assertOpen();
		const rows = this.#listDueSchedulesStmt.all(now) as ScheduleRow[];
		return rows.map(row => this.#toSchedule(row));
	}

	/**
	 * Atomically CAS `next_run_at` and create exactly one queued job for the
	 * claimed occurrence. Returns null when another runner already won the CAS.
	 */
	materializeDueSchedule(input: MaterializeDueScheduleInput): DurableJob | null {
		this.#assertOpen();
		const materialize = this.#db.transaction(() => {
			const scheduleRow = this.#getScheduleStmt.get(input.scheduleId) as ScheduleRow | null;
			if (!scheduleRow) throw new Error(`schedule not found: ${input.scheduleId}`);
			if (scheduleRow.enabled !== 1) return null;
			if (scheduleRow.next_run_at !== input.expectedNextRunAt) return null;

			const now = this.#now();
			const cas = this.#casScheduleNextRunStmt.run(input.nextRunAt, now, input.scheduleId, input.expectedNextRunAt);
			if (cas.changes !== 1) return null;

			const jobId = input.jobId ?? this.#createId();
			this.#insertJobStmt.run(
				jobId,
				input.jobType,
				"queued",
				serializeJsonValue(input.jobPayload ?? null),
				input.scheduleId,
				now,
				now,
			);
			const job = this.getJob(jobId);
			if (!job) throw new Error(`failed to read job ${jobId}`);
			return job;
		});
		return materialize();
	}

	#toSchedule(row: ScheduleRow): RecurringSchedule {
		return {
			id: row.id,
			name: row.name,
			cron: row.cron,
			nextRunAt: row.next_run_at,
			enabled: row.enabled === 1,
			payload: parseJsonValue(row.payload_json),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	// ---------------------------------------------------------------------------
	// Notifications
	// ---------------------------------------------------------------------------

	createNotification(input: CreateNotificationInput): NotificationRecord {
		this.#assertOpen();
		const id = input.id ?? this.#createId();
		const createdAt = this.#now();
		this.#insertNotificationStmt.run(
			id,
			input.kind,
			input.title,
			input.body,
			serializeJsonValue(input.metadata ?? null),
			createdAt,
		);
		return {
			id,
			kind: input.kind,
			title: input.title,
			body: input.body,
			read: false,
			metadata: input.metadata ?? null,
			createdAt,
		};
	}

	listNotifications(limit = 100): NotificationRecord[] {
		this.#assertOpen();
		const rows = this.#listNotificationsStmt.all(this.#normalizeLimit(limit)) as NotificationRow[];
		return rows.map(row => ({
			id: row.id,
			kind: row.kind,
			title: row.title,
			body: row.body,
			read: row.read === 1,
			metadata: parseJsonValue(row.metadata_json),
			createdAt: row.created_at,
		}));
	}

	markNotificationRead(id: string): boolean {
		this.#assertOpen();
		const result = this.#markNotificationReadStmt.run(id);
		return result.changes > 0;
	}

	// ---------------------------------------------------------------------------
	// Trajectory events
	// ---------------------------------------------------------------------------

	appendEvent(input: AppendEventInput): TrajectoryEvent {
		this.#assertOpen();
		if (!isEventKind(input.kind)) {
			throw new Error(`invalid trajectory event kind: ${String(input.kind)}`);
		}
		const id = input.id ?? this.#createId();
		const createdAt = this.#now();
		const capped = capJsonPayload(input.payload ?? null, this.#maxEventPayloadBytes);
		const payloadJson = serializeJsonValue(capped);
		this.#insertEventStmt.run(id, input.kind, input.jobId ?? null, input.sessionId ?? null, payloadJson, createdAt);
		return {
			id,
			kind: input.kind,
			jobId: input.jobId ?? null,
			sessionId: input.sessionId ?? null,
			payload: capped,
			createdAt,
		};
	}

	listEvents(filter: EventListFilter = {}): TrajectoryEvent[] {
		this.#assertOpen();
		const limit = this.#normalizeLimit(filter.limit ?? 1000);
		if (filter.kind !== undefined && Array.isArray(filter.kind)) {
			const kinds = filter.kind;
			if (kinds.length === 0) return [];
			const sql = `SELECT * FROM trajectory_events
				WHERE kind IN (${kinds.map(() => "?").join(", ")})
				  AND (? IS NULL OR job_id = ?)
				  AND (? IS NULL OR session_id = ?)
				  AND (? IS NULL OR created_at > ?)
				ORDER BY created_at ASC, id ASC
				LIMIT ?`;
			const params: SQLQueryBindings[] = [
				...kinds,
				filter.jobId ?? null,
				filter.jobId ?? null,
				filter.sessionId ?? null,
				filter.sessionId ?? null,
				filter.afterCreatedAt ?? null,
				filter.afterCreatedAt ?? null,
				limit,
			];
			const rows = this.#db.prepare(sql).all(...params) as EventRow[];
			return rows.map(row => this.#toEvent(row));
		}

		const kind = typeof filter.kind === "string" ? filter.kind : null;
		const rows = this.#listEventsStmt.all(
			kind,
			kind,
			filter.jobId ?? null,
			filter.jobId ?? null,
			filter.sessionId ?? null,
			filter.sessionId ?? null,
			filter.afterCreatedAt ?? null,
			filter.afterCreatedAt ?? null,
			limit,
		) as EventRow[];
		return rows.map(row => this.#toEvent(row));
	}

	/** Chronological JSONL export of trajectory events. */
	exportEventsJsonl(filter: EventListFilter = {}): string {
		const events = this.listEvents(filter);
		if (events.length === 0) return "";
		return `${events.map(event => serializeJsonValue(event)).join("\n")}\n`;
	}

	#toEvent(row: EventRow): TrajectoryEvent {
		if (!isEventKind(row.kind)) {
			throw new Error(`corrupt trajectory event kind: ${row.kind}`);
		}
		return {
			id: row.id,
			kind: row.kind,
			jobId: row.job_id,
			sessionId: row.session_id,
			payload: parseJsonValue(row.payload_json),
			createdAt: row.created_at,
		};
	}

	#normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit) || limit <= 0) return 0;
		return Math.min(Math.floor(limit), 10_000);
	}
}
