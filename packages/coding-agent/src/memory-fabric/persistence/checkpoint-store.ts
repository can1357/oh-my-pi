/**
 * Checkpoint store — immutable snapshots the session can return to.
 *
 * A checkpoint is a copy of a {@link WorkingState} taken at a moment worth
 * remembering: a compaction, a session stop, an explicit request. Checkpoints
 * are never mutated after creation; restoring one copies its state back into
 * the live store rather than pointing the live store at the checkpoint row —
 * a restore that made subsequent edits mutate the checkpoint would quietly
 * destroy the thing it restored from.
 *
 * ## Durability
 *
 * WAL journal mode with `synchronous = FULL`: the store exists precisely for
 * the process that dies mid-turn, so trading fsyncs for speed here would be
 * optimising away the reason to have the file.
 *
 * ## The JSONL mirror
 *
 * Every checkpoint is also appended, one JSON object per line, to a plain
 * `checkpoints.jsonl` beside the database. The mirror is portable (readable
 * without SQLite) and doubles as a cross-check: each line carries the same
 * `contentHash` as its row. It is written with a plain append — an earlier
 * design that staged lines in a temp file and `rename`d it over the mirror
 * replaced the whole history with the newest line on every write.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckpointSnapshot, PersistenceScope, WorkingState } from "./types";
import { asString, hashContent, newPersistenceId } from "./types";

export interface CheckpointStoreOptions {
	/** Directory that receives the SQLite database and the JSONL mirror. */
	directory: string;
	scope: PersistenceScope;
	/** Checkpoints kept per project when {@link CheckpointStore.prune} runs. */
	keepLatest?: number;
}

const DEFAULT_KEEP_LATEST = 20;

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS checkpoints (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		label TEXT NOT NULL,
		state_json TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id, created_at);
	CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
`;

export class CheckpointStore {
	readonly #db: Database;
	readonly #scope: PersistenceScope;
	readonly #mirrorPath: string;
	readonly #keepLatest: number;

	constructor(options: CheckpointStoreOptions) {
		this.#scope = options.scope;
		this.#keepLatest = options.keepLatest ?? DEFAULT_KEEP_LATEST;
		fs.mkdirSync(options.directory, { recursive: true });
		this.#mirrorPath = path.join(options.directory, `${options.scope.projectId}_checkpoints.jsonl`);
		this.#db = new Database(path.join(options.directory, `${options.scope.projectId}_checkpoints.sqlite`), {
			create: true,
		});
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec("PRAGMA synchronous = FULL;");
		this.#db.exec("PRAGMA busy_timeout = 5000;");
		this.#db.exec(SCHEMA);
	}

	/** Snapshot `state` under `label` and return the immutable record. */
	create(state: WorkingState, sessionId: string, label: string): CheckpointSnapshot {
		const snapshot: CheckpointSnapshot = {
			checkpointId: newPersistenceId("cp"),
			sessionId,
			label,
			state: cloneState(state),
			contentHash: hashContent(state),
			createdAt: new Date().toISOString(),
		};

		this.#db
			.query(`
			INSERT INTO checkpoints (id, project_id, session_id, label, state_json, content_hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`)
			.run(
				snapshot.checkpointId,
				this.#scope.projectId,
				snapshot.sessionId,
				snapshot.label,
				JSON.stringify(snapshot.state),
				snapshot.contentHash,
				snapshot.createdAt,
			);

		// Plain append: the mirror is a log, and a log is only useful if
		// writing entry N does not erase entries 1..N-1.
		fs.appendFileSync(this.#mirrorPath, `${JSON.stringify(snapshot)}\n`, "utf8");

		return snapshot;
	}

	/** Load one checkpoint by id, or `null` when it does not exist. */
	load(checkpointId: string): CheckpointSnapshot | null {
		const row = this.#db
			.query("SELECT * FROM checkpoints WHERE id = ? AND project_id = ?")
			.get(checkpointId, this.#scope.projectId) as Record<string, unknown> | null;
		return row ? rowToSnapshot(row) : null;
	}

	/**
	 * The most recent checkpoint for a session, or `null` when it has none.
	 *
	 * Ties on `created_at` (millisecond ISO strings collide under fast
	 * successive writes) break on `rowid` — insertion order — because the
	 * random-suffix ids sort in an order unrelated to creation time.
	 */
	latestForSession(sessionId: string): CheckpointSnapshot | null {
		const row = this.#db
			.query(`
			SELECT * FROM checkpoints
			WHERE project_id = ? AND session_id = ?
			ORDER BY created_at DESC, rowid DESC LIMIT 1
		`)
			.get(this.#scope.projectId, sessionId) as Record<string, unknown> | null;
		return row ? rowToSnapshot(row) : null;
	}

	/** Recent checkpoints for this project, newest first. */
	list(limit = 10): CheckpointSnapshot[] {
		const rows = this.#db
			.query(`
			SELECT * FROM checkpoints
			WHERE project_id = ?
			ORDER BY created_at DESC, rowid DESC LIMIT ?
		`)
			.all(this.#scope.projectId, limit) as Array<Record<string, unknown>>;
		return rows.map(rowToSnapshot);
	}

	/**
	 * Drop everything but the newest `keepLatest` checkpoints for this project.
	 *
	 * Only the SQLite rows are pruned; the JSONL mirror keeps its full history,
	 * which is the mirror's job.
	 *
	 * @returns how many checkpoints were removed
	 */
	prune(keepLatest = this.#keepLatest): number {
		const result = this.#db
			.query(`
			DELETE FROM checkpoints
			WHERE project_id = ? AND id NOT IN (
				SELECT id FROM checkpoints
				WHERE project_id = ?
				ORDER BY created_at DESC, rowid DESC LIMIT ?
			)
		`)
			.run(this.#scope.projectId, this.#scope.projectId, keepLatest);
		return result.changes;
	}

	close(): void {
		this.#db.close();
	}
}

/** Deep-copy a working state so the snapshot cannot alias the caller's arrays. */
function cloneState(state: WorkingState): WorkingState {
	return {
		...state,
		constraints: [...state.constraints],
		filesTouched: [...state.filesTouched],
		pendingOperations: [...state.pendingOperations],
		unresolvedErrors: [...state.unresolvedErrors],
	};
}

function rowToSnapshot(row: Record<string, unknown>): CheckpointSnapshot {
	return {
		checkpointId: asString(row.id),
		sessionId: asString(row.session_id),
		label: asString(row.label),
		state: parseState(row.state_json),
		contentHash: asString(row.content_hash),
		createdAt: asString(row.created_at),
	};
}

/** Rehydrate a persisted state defensively: a rotten column must not throw. */
function parseState(value: unknown): WorkingState {
	let parsed: Record<string, unknown> = {};
	if (typeof value === "string") {
		try {
			const candidate: unknown = JSON.parse(value);
			if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
				parsed = candidate as Record<string, unknown>;
			}
		} catch {
			// Fall through to the empty object: every field below has a default.
		}
	}
	return {
		objective: asString(parsed.objective),
		constraints: toStringArray(parsed.constraints),
		activePlan: asString(parsed.activePlan),
		currentStep: asString(parsed.currentStep),
		filesTouched: toStringArray(parsed.filesTouched),
		pendingOperations: toStringArray(parsed.pendingOperations),
		unresolvedErrors: toStringArray(parsed.unresolvedErrors),
		lastVerifiedTestState: asString(parsed.lastVerifiedTestState),
		updatedAt: asString(parsed.updatedAt),
	};
}

/** Narrow an already-parsed value to an array of strings. */
function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}
