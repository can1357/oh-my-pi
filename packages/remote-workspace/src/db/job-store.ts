/**
 * Durable SQLite job store.
 *
 * Each job is serialised as a single JSON blob — no column-per-field sprawl.
 * The schema is intentionally thin; query patterns are handled by loading and
 * filtering in-process. At Phase 1 we never have more than a few dozen jobs.
 *
 * Writes are synchronous bun:sqlite calls inside explicit transactions, which
 * gives atomicity without async complexity.
 */

import { Database } from "bun:sqlite";
import type { JobState, RemoteJobV1 } from "../job/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id        TEXT    PRIMARY KEY,
  state     TEXT    NOT NULL,
  blob      TEXT    NOT NULL,
  revision  INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL,
  updated   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated);
`;

interface StoredJobRow {
	readonly blob: string;
	readonly revision: number;
}

export interface JobStoreOptions {
	readonly path: string;
}

export class JobStore {
	readonly #db: Database;

	constructor(opts: JobStoreOptions) {
		this.#db = new Database(opts.path, { create: true });
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run("PRAGMA synchronous = NORMAL");
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.exec(SCHEMA);
		this.#addRevisionColumnIfNeeded();
	}

	/**
	 * Persists only if this record is current. Returns false when another process
	 * wrote a newer revision, so callers cannot overwrite cancellation or cleanup.
	 */
	upsert(job: RemoteJobV1): boolean {
		const revision = job.revision + 1;
		const blob = JSON.stringify({ ...job, revision });
		const now = Date.now();
		const result = this.#db.run(
			`INSERT INTO jobs (id, state, blob, revision, created, updated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state    = excluded.state,
         blob     = excluded.blob,
         revision = excluded.revision,
         updated  = excluded.updated
       WHERE jobs.revision = ?`,
			[job.id, job.state, blob, revision, now, now, job.revision],
		);
		if (result.changes === 0) return false;
		job.revision = revision;
		return true;
	}

	get(id: string): RemoteJobV1 | undefined {
		const row = this.#db.query<StoredJobRow, [string]>("SELECT blob, revision FROM jobs WHERE id = ?").get(id);
		return row ? { ...(JSON.parse(row.blob) as RemoteJobV1), revision: row.revision } : undefined;
	}

	byState(state: JobState): RemoteJobV1[] {
		const rows = this.#db
			.query<StoredJobRow, [string]>("SELECT blob, revision FROM jobs WHERE state = ? ORDER BY updated DESC")
			.all(state);
		return rows.map(row => ({ ...(JSON.parse(row.blob) as RemoteJobV1), revision: row.revision }));
	}

	all(): RemoteJobV1[] {
		const rows = this.#db.query<StoredJobRow, []>("SELECT blob, revision FROM jobs ORDER BY created DESC").all();
		return rows.map(row => ({ ...(JSON.parse(row.blob) as RemoteJobV1), revision: row.revision }));
	}

	/** Delete a job record by id. Returns true if a row was removed. */
	delete(id: string): boolean {
		const result = this.#db.run("DELETE FROM jobs WHERE id = ?", [id]);
		return result.changes > 0;
	}

	count(): number {
		const row = this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs").get();
		return row?.n ?? 0;
	}

	/** Atomically upsert and run a callback. Rolls back on throw. */
	transaction<T>(fn: (store: JobStore) => T): T {
		return this.#db.transaction(() => fn(this))() as T;
	}

	close(): void {
		this.#db.close();
	}

	#addRevisionColumnIfNeeded(): void {
		try {
			this.#db.run("ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("duplicate column name")) throw error;
		}
	}
}
