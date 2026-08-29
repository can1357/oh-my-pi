import { Database, type SQLQueryBindings } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getAutoresearchDbPath, getAutoresearchProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { ASIData, ExperimentStatus, MetricDirection, NumericMetricMap } from "./types";

/**
 * Encode an absolute project path into a single filesystem-safe segment.
 *
 * Used to key per-project autoresearch state under `~/.omp/autoresearch/`.
 * The `--…--` wrapper is historical — existing on-disk state depends on it,
 * so changing the format here would orphan every prior autoresearch DB.
 * Not collision-free for pathological inputs (`/a/b` vs `/a-b`) but matches
 * the rest of the codebase and stays human-readable for `ls`.
 */
function encodeProjectKey(repoRoot: string): string {
	return `--${repoRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface SessionRow {
	id: number;
	name: string;
	goal: string | null;
	primaryMetric: string;
	metricUnit: string;
	direction: MetricDirection;
	preferredCommand: string | null;
	branch: string | null;
	baselineCommit: string | null;
	currentSegment: number;
	maxIterations: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	secondaryMetrics: string[];
	notes: string;
	createdAt: number;
	closedAt: number | null;
}

export interface RunRow {
	id: number;
	sessionId: number;
	segment: number;
	command: string;
	startedAt: number;
	completedAt: number | null;
	durationMs: number | null;
	exitCode: number | null;
	timedOut: boolean;
	parsedPrimary: number | null;
	parsedMetrics: NumericMetricMap | null;
	parsedAsi: ASIData | null;
	preRunDirtyPaths: string[];
	logPath: string;
	status: ExperimentStatus | null;
	description: string | null;
	metric: number | null;
	metrics: NumericMetricMap | null;
	asi: ASIData | null;
	commitHash: string | null;
	confidence: number | null;
	modifiedPaths: string[] | null;
	scopeDeviations: string[] | null;
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
	loggedAt: number | null;
	abandonedAt: number | null;
}

export interface OpenSessionParams {
	name: string;
	goal: string | null;
	primaryMetric: string;
	metricUnit: string;
	direction: MetricDirection;
	preferredCommand: string | null;
	branch: string | null;
	baselineCommit: string | null;
	maxIterations: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	secondaryMetrics: string[];
}

export interface UpdateSessionParams {
	goal?: string | null;
	preferredCommand?: string | null;
	maxIterations?: number | null;
	scopePaths?: string[];
	offLimits?: string[];
	constraints?: string[];
	secondaryMetrics?: string[];
	primaryMetric?: string;
	metricUnit?: string;
	direction?: MetricDirection;
	branch?: string | null;
	baselineCommit?: string | null;
	notes?: string;
}

export interface InsertRunParams {
	sessionId: number;
	segment: number;
	command: string;
	logPath: string;
	preRunDirtyPaths: string[];
	startedAt: number;
}

export interface MarkRunCompletedParams {
	runId: number;
	completedAt: number;
	durationMs: number;
	exitCode: number | null;
	timedOut: boolean;
	parsedPrimary: number | null;
	parsedMetrics: NumericMetricMap | null;
	parsedAsi: ASIData | null;
}

export interface MarkRunLoggedParams {
	runId: number;
	status: ExperimentStatus;
	description: string;
	metric: number;
	metrics: NumericMetricMap;
	asi: ASIData | null;
	commitHash: string | null;
	confidence: number | null;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	loggedAt: number;
}

type SessionDbRow = {
	id: number;
	name: string;
	goal: string | null;
	primary_metric: string;
	metric_unit: string;
	direction: string;
	preferred_command: string | null;
	branch: string | null;
	baseline_commit: string | null;
	current_segment: number;
	max_iterations: number | null;
	scope_paths_json: string;
	off_limits_json: string;
	constraints_json: string;
	secondary_metrics_json: string;
	notes: string;
	created_at: number;
	closed_at: number | null;
};

type RunDbRow = {
	id: number;
	session_id: number;
	segment: number;
	command: string;
	started_at: number;
	completed_at: number | null;
	duration_ms: number | null;
	exit_code: number | null;
	timed_out: number;
	parsed_primary: number | null;
	parsed_metrics_json: string | null;
	parsed_asi_json: string | null;
	pre_run_dirty_paths_json: string;
	log_path: string;
	status: string | null;
	description: string | null;
	metric: number | null;
	metrics_json: string | null;
	asi_json: string | null;
	commit_hash: string | null;
	confidence: number | null;
	modified_paths_json: string | null;
	scope_deviations_json: string | null;
	justification: string | null;
	flagged: number;
	flagged_reason: string | null;
	logged_at: number | null;
	abandoned_at: number | null;
};

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	goal TEXT,
	primary_metric TEXT NOT NULL,
	metric_unit TEXT NOT NULL DEFAULT '',
	direction TEXT NOT NULL DEFAULT 'lower',
	preferred_command TEXT,
	branch TEXT,
	baseline_commit TEXT,
	current_segment INTEGER NOT NULL DEFAULT 0,
	max_iterations INTEGER,
	scope_paths_json TEXT NOT NULL DEFAULT '[]',
	off_limits_json TEXT NOT NULL DEFAULT '[]',
	constraints_json TEXT NOT NULL DEFAULT '[]',
	secondary_metrics_json TEXT NOT NULL DEFAULT '[]',
	notes TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY,
	session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	segment INTEGER NOT NULL,
	command TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	completed_at INTEGER,
	duration_ms INTEGER,
	exit_code INTEGER,
	timed_out INTEGER NOT NULL DEFAULT 0,
	parsed_primary REAL,
	parsed_metrics_json TEXT,
	parsed_asi_json TEXT,
	pre_run_dirty_paths_json TEXT NOT NULL DEFAULT '[]',
	log_path TEXT NOT NULL,
	status TEXT,
	description TEXT,
	metric REAL,
	metrics_json TEXT,
	asi_json TEXT,
	commit_hash TEXT,
	confidence REAL,
	modified_paths_json TEXT,
	scope_deviations_json TEXT,
	justification TEXT,
	flagged INTEGER NOT NULL DEFAULT 0,
	flagged_reason TEXT,
	logged_at INTEGER,
	abandoned_at INTEGER
);

CREATE INDEX IF NOT EXISTS runs_session_segment_idx ON runs(session_id, segment);
CREATE INDEX IF NOT EXISTS runs_pending_idx ON runs(session_id, status, abandoned_at);
`;

export class AutoresearchStorage {
	#db: Database;
	#projectDir: string;
	#dbPath: string;

	constructor(dbPath: string, projectDir: string) {
		this.#dbPath = dbPath;
		this.#projectDir = projectDir;
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run(SCHEMA_SQL);
		const versionRow = this.#db.query("PRAGMA user_version").get() as { user_version: number } | null;
		const currentVersion = versionRow?.user_version ?? 0;
		if (currentVersion < SCHEMA_VERSION) {
			this.#db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		}
	}

	get dbPath(): string {
		return this.#dbPath;
	}

	get projectDir(): string {
		return this.#projectDir;
	}

	close(): void {
		this.#db.close();
	}

	getActiveSession(): SessionRow | null {
		const stmt = this.#db.prepare<SessionDbRow, []>(
			"SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1",
		);
		const row = stmt.get();
		return row ? rowToSession(row) : null;
	}

	getActiveSessionForBranch(branch: string | null): SessionRow | null {
		// Most-recent active session whose recorded branch matches the caller's branch.
		// `branch === null` means "no git repo / no branch info" — treat null on both
		// sides as a match.
		if (branch === null) {
			const stmt = this.#db.prepare<SessionDbRow, []>(
				"SELECT * FROM sessions WHERE closed_at IS NULL AND branch IS NULL ORDER BY id DESC LIMIT 1",
			);
			const row = stmt.get();
			return row ? rowToSession(row) : null;
		}
		const stmt = this.#db.prepare<SessionDbRow, [string]>(
			"SELECT * FROM sessions WHERE closed_at IS NULL AND branch = ? ORDER BY id DESC LIMIT 1",
		);
		const row = stmt.get(branch);
		return row ? rowToSession(row) : null;
	}

	getSessionById(sessionId: number): SessionRow | null {
		const stmt = this.#db.prepare<SessionDbRow, [number]>("SELECT * FROM sessions WHERE id = ?");
		const row = stmt.get(sessionId);
		return row ? rowToSession(row) : null;
	}

	openSession(params: OpenSessionParams): SessionRow {
		const stmt = this.#db.prepare<{ id: number }, SQLQueryBindings[]>(
			`INSERT INTO sessions (
				name, goal, primary_metric, metric_unit, direction,
				preferred_command, branch, baseline_commit, max_iterations,
				scope_paths_json, off_limits_json, constraints_json, secondary_metrics_json,
				created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		);
		const row = stmt.get(
			params.name,
			params.goal,
			params.primaryMetric,
			params.metricUnit,
			params.direction,
			params.preferredCommand,
			params.branch,
			params.baselineCommit,
			params.maxIterations,
			JSON.stringify(params.scopePaths),
			JSON.stringify(params.offLimits),
			JSON.stringify(params.constraints),
			JSON.stringify(params.secondaryMetrics),
			Date.now(),
		);
		if (!row) throw new Error("Failed to insert autoresearch session");
		const session = this.getSessionById(row.id);
		if (!session) throw new Error(`Failed to read inserted autoresearch session ${row.id}`);
		return session;
	}

	updateSession(sessionId: number, updates: UpdateSessionParams): SessionRow {
		const setClauses: string[] = [];
		const values: SQLQueryBindings[] = [];
		if (updates.goal !== undefined) {
			setClauses.push("goal = ?");
			values.push(updates.goal);
		}
		if (updates.preferredCommand !== undefined) {
			setClauses.push("preferred_command = ?");
			values.push(updates.preferredCommand);
		}
		if (updates.maxIterations !== undefined) {
			setClauses.push("max_iterations = ?");
			values.push(updates.maxIterations);
		}
		if (updates.scopePaths !== undefined) {
			setClauses.push("scope_paths_json = ?");
			values.push(JSON.stringify(updates.scopePaths));
		}
		if (updates.offLimits !== undefined) {
			setClauses.push("off_limits_json = ?");
			values.push(JSON.stringify(updates.offLimits));
		}
		if (updates.constraints !== undefined) {
			setClauses.push("constraints_json = ?");
			values.push(JSON.stringify(updates.constraints));
		}
		if (updates.secondaryMetrics !== undefined) {
			setClauses.push("secondary_metrics_json = ?");
			values.push(JSON.stringify(updates.secondaryMetrics));
		}
		if (updates.primaryMetric !== undefined) {
			setClauses.push("primary_metric = ?");
			values.push(updates.primaryMetric);
		}
		if (updates.metricUnit !== undefined) {
			setClauses.push("metric_unit = ?");
			values.push(updates.metricUnit);
		}
		if (updates.direction !== undefined) {
			setClauses.push("direction = ?");
			values.push(updates.direction);
		}
		if (updates.branch !== undefined) {
			setClauses.push("branch = ?");
			values.push(updates.branch);
		}
		if (updates.baselineCommit !== undefined) {
			setClauses.push("baseline_commit = ?");
			values.push(updates.baselineCommit);
		}
		if (updates.notes !== undefined) {
			setClauses.push("notes = ?");
			values.push(updates.notes);
		}
		if (setClauses.length > 0) {
			values.push(sessionId);
			this.#db.prepare(`UPDATE sessions SET ${setClauses.join(", ")} WHERE id = ?`).run(...(values as never[]));
		}
		const session = this.getSessionById(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found after update`);
		return session;
	}

	bumpSegment(sessionId: number): SessionRow {
		this.#db.prepare("UPDATE sessions SET current_segment = current_segment + 1 WHERE id = ?").run(sessionId);
		const session = this.getSessionById(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found after bumping segment`);
		return session;
	}

	closeSession(sessionId: number): void {
		this.#db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ?").run(Date.now(), sessionId);
	}

	insertRun(params: InsertRunParams): RunRow {
		const stmt = this.#db.prepare<{ id: number }, SQLQueryBindings[]>(
			`INSERT INTO runs (
				session_id, segment, command, started_at, log_path, pre_run_dirty_paths_json
			) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
		);
		const row = stmt.get(
			params.sessionId,
			params.segment,
			params.command,
			params.startedAt,
			params.logPath,
			JSON.stringify(params.preRunDirtyPaths),
		);
		if (!row) throw new Error("Failed to insert run");
		return this.getRunByIdRequired(row.id);
	}

	updateRunLogPath(runId: number, logPath: string): RunRow {
		this.#db.prepare("UPDATE runs SET log_path = ? WHERE id = ?").run(logPath, runId);
		return this.getRunByIdRequired(runId);
	}

	updateRunConfidence(runId: number, confidence: number | null): RunRow {
		this.#db.prepare("UPDATE runs SET confidence = ? WHERE id = ?").run(confidence, runId);
		return this.getRunByIdRequired(runId);
	}

	markRunCompleted(params: MarkRunCompletedParams): RunRow {
		this.#db
			.prepare(
				`UPDATE runs SET
					completed_at = ?, duration_ms = ?, exit_code = ?, timed_out = ?,
					parsed_primary = ?, parsed_metrics_json = ?, parsed_asi_json = ?
				WHERE id = ?`,
			)
			.run(
				params.completedAt,
				params.durationMs,
				params.exitCode,
				params.timedOut ? 1 : 0,
				params.parsedPrimary,
				params.parsedMetrics ? JSON.stringify(params.parsedMetrics) : null,
				params.parsedAsi ? JSON.stringify(params.parsedAsi) : null,
				params.runId,
			);
		return this.getRunByIdRequired(params.runId);
	}

	markRunLogged(params: MarkRunLoggedParams): RunRow {
		this.#db
			.prepare(
				`UPDATE runs SET
					status = ?, description = ?, metric = ?, metrics_json = ?, asi_json = ?,
					commit_hash = ?, confidence = ?, modified_paths_json = ?, scope_deviations_json = ?,
					justification = ?, logged_at = ?
				WHERE id = ?`,
			)
			.run(
				params.status,
				params.description,
				params.metric,
				JSON.stringify(params.metrics),
				params.asi ? JSON.stringify(params.asi) : null,
				params.commitHash,
				params.confidence,
				JSON.stringify(params.modifiedPaths),
				JSON.stringify(params.scopeDeviations),
				params.justification,
				params.loggedAt,
				params.runId,
			);
		return this.getRunByIdRequired(params.runId);
	}

	flagRun(runId: number, reason: string): RunRow {
		this.#db.prepare("UPDATE runs SET flagged = 1, flagged_reason = ? WHERE id = ?").run(reason, runId);
		return this.getRunByIdRequired(runId);
	}

	abandonPendingRuns(sessionId: number): number {
		const beforeRow = this.#db
			.prepare<{ n: number }, [number]>(
				"SELECT COUNT(*) AS n FROM runs WHERE session_id = ? AND status IS NULL AND abandoned_at IS NULL",
			)
			.get(sessionId);
		const before = beforeRow?.n ?? 0;
		if (before === 0) return 0;
		this.#db
			.prepare("UPDATE runs SET abandoned_at = ? WHERE session_id = ? AND status IS NULL AND abandoned_at IS NULL")
			.run(Date.now(), sessionId);
		return before;
	}

	getPendingRun(sessionId: number): RunRow | null {
		const stmt = this.#db.prepare<RunDbRow, [number]>(
			"SELECT * FROM runs WHERE session_id = ? AND status IS NULL AND abandoned_at IS NULL ORDER BY id DESC LIMIT 1",
		);
		const row = stmt.get(sessionId);
		return row ? rowToRun(row) : null;
	}

	getRunById(runId: number): RunRow | null {
		const stmt = this.#db.prepare<RunDbRow, [number]>("SELECT * FROM runs WHERE id = ?");
		const row = stmt.get(runId);
		return row ? rowToRun(row) : null;
	}

	getRunByIdRequired(runId: number): RunRow {
		const run = this.getRunById(runId);
		if (!run) throw new Error(`Run ${runId} not found`);
		return run;
	}

	listRuns(sessionId: number): RunRow[] {
		const stmt = this.#db.prepare<RunDbRow, [number]>("SELECT * FROM runs WHERE session_id = ? ORDER BY id ASC");
		return stmt.all(sessionId).map(rowToRun);
	}

	listLoggedRuns(sessionId: number): RunRow[] {
		const stmt = this.#db.prepare<RunDbRow, [number]>(
			"SELECT * FROM runs WHERE session_id = ? AND status IS NOT NULL ORDER BY id ASC",
		);
		return stmt.all(sessionId).map(rowToRun);
	}
}

const storageCache = new Map<string, AutoresearchStorage>();

export async function openAutoresearchStorage(cwd: string): Promise<AutoresearchStorage> {
	const { dbPath, projectDir } = await resolveAutoresearchPaths(cwd);
	const cached = storageCache.get(dbPath);
	if (cached) return cached;
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const storage = new AutoresearchStorage(dbPath, projectDir);
	storageCache.set(dbPath, storage);
	return storage;
}

export async function openAutoresearchStorageIfExists(cwd: string): Promise<AutoresearchStorage | null> {
	const { dbPath, projectDir } = await resolveAutoresearchPaths(cwd);
	const cached = storageCache.get(dbPath);
	if (cached) return cached;
	if (!fs.existsSync(dbPath)) return null;
	const storage = new AutoresearchStorage(dbPath, projectDir);
	storageCache.set(dbPath, storage);
	return storage;
}

async function resolveAutoresearchPaths(cwd: string): Promise<{ dbPath: string; projectDir: string }> {
	const override = process.env.OMP_AUTORESEARCH_DB_DIR;
	const repoRoot = vcs.repo(cwd)?.root() ?? cwd;
	const encoded = encodeProjectKey(repoRoot);
	if (override) {
		return {
			dbPath: path.join(override, `${encoded}.db`),
			projectDir: path.join(override, encoded),
		};
	}
	return {
		dbPath: getAutoresearchDbPath(encoded),
		projectDir: getAutoresearchProjectDir(encoded),
	};
}

export function closeAllAutoresearchStorages(): void {
	for (const storage of storageCache.values()) {
		try {
			storage.close();
		} catch (err) {
			logger.warn("Failed to close autoresearch storage", {
				error: err instanceof Error ? err.message : String(err),
				path: storage.dbPath,
			});
		}
	}
	storageCache.clear();
}

function rowToSession(row: SessionDbRow): SessionRow {
	return {
		id: row.id,
		name: row.name,
		goal: row.goal,
		primaryMetric: row.primary_metric,
		metricUnit: row.metric_unit,
		direction: row.direction === "higher" ? "higher" : "lower",
		preferredCommand: row.preferred_command,
		branch: row.branch,
		baselineCommit: row.baseline_commit,
		currentSegment: row.current_segment,
		maxIterations: row.max_iterations,
		scopePaths: parseStringArray(row.scope_paths_json),
		offLimits: parseStringArray(row.off_limits_json),
		constraints: parseStringArray(row.constraints_json),
		secondaryMetrics: parseStringArray(row.secondary_metrics_json),
		notes: row.notes,
		createdAt: row.created_at,
		closedAt: row.closed_at,
	};
}

function rowToRun(row: RunDbRow): RunRow {
	return {
		id: row.id,
		sessionId: row.session_id,
		segment: row.segment,
		command: row.command,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		durationMs: row.duration_ms,
		exitCode: row.exit_code,
		timedOut: row.timed_out !== 0,
		parsedPrimary: row.parsed_primary,
		parsedMetrics: parseNumericMetricMap(row.parsed_metrics_json),
		parsedAsi: parseAsiData(row.parsed_asi_json),
		preRunDirtyPaths: parseStringArray(row.pre_run_dirty_paths_json),
		logPath: row.log_path,
		status: parseStatus(row.status),
		description: row.description,
		metric: row.metric,
		metrics: parseNumericMetricMap(row.metrics_json),
		asi: parseAsiData(row.asi_json),
		commitHash: row.commit_hash,
		confidence: row.confidence,
		modifiedPaths: row.modified_paths_json !== null ? parseStringArray(row.modified_paths_json) : null,
		scopeDeviations: row.scope_deviations_json !== null ? parseStringArray(row.scope_deviations_json) : null,
		justification: row.justification,
		flagged: row.flagged !== 0,
		flaggedReason: row.flagged_reason,
		loggedAt: row.logged_at,
		abandonedAt: row.abandoned_at,
	};
}

function parseStatus(value: string | null): ExperimentStatus | null {
	if (value === "keep" || value === "discard" || value === "crash" || value === "checks_failed") return value;
	return null;
}

function parseStringArray(json: string): string[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}

function parseNumericMetricMap(json: string | null): NumericMetricMap | null {
	if (json === null) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const out: NumericMetricMap = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
		}
		return out;
	} catch {
		return null;
	}
}

function parseAsiData(json: string | null): ASIData | null {
	if (json === null) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as ASIData;
	} catch {
		return null;
	}
}
