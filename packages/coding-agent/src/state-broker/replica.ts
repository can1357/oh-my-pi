/**
 * Replica-side contracts for shared-state replication.
 *
 * A {@link ReplicatedDomain} is a thin adapter over an existing local store
 * (history.db, agent.db, the config files). It answers two questions and
 * nothing else:
 *
 * 1. "which of my local rows changed after logical clock `afterRev`?"
 * 2. "merge these remote rows into me."
 *
 * Domains own **no** sync bookkeeping — cursors live in {@link StateSyncStore}
 * so replication never adds columns to, or bumps the schema version of, the
 * databases it replicates. That keeps every existing local read path (all of
 * which are synchronous and on TUI render paths) completely untouched: the
 * local database remains authoritative for reads, and the broker is a
 * replication hub rather than a remote read path.
 */

import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbBusyTimeoutMs, getStateSyncDbPath, logger } from "@oh-my-pi/pi-utils";
import type { StateDomainId, StateEntry } from "./wire";

/**
 * Adapter exposing one local store as a replicated domain.
 *
 * Implementations MUST be total and non-throwing on the merge path: a
 * malformed remote entry is dropped with a log line, never propagated as an
 * exception, because one bad row must not stall the whole sync loop.
 */
export interface ReplicatedDomain {
	readonly id: StateDomainId;

	/**
	 * Local entries whose logical clock is strictly greater than `afterRev`,
	 * ordered by ascending `rev`, capped at `limit`.
	 *
	 * Ascending order is load-bearing: the engine advances its outbound
	 * watermark to the last pushed entry's `rev`, so an out-of-order page would
	 * skip rows permanently.
	 */
	changedSince(afterRev: number, limit: number): StateEntry[];

	/** Merge remote entries under this domain's rule (LWW unless documented otherwise). */
	applyRemote(entries: readonly StateEntry[]): void;

	/**
	 * Flush any deferred local writes so a shutdown drain cannot lose rows that
	 * were merged but still sitting in a batch queue.
	 */
	drain?(): Promise<void>;
}

/** Per-domain replication cursors. */
export interface SyncCursor {
	/** Highest broker `seq` already pulled and applied. */
	inboundSeq: number;
	/** Highest local entry `rev` already pushed. */
	outboundRev: number;
}

const CURSOR_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS sync_cursor (
	domain TEXT PRIMARY KEY,
	inbound_seq INTEGER NOT NULL DEFAULT 0,
	outbound_rev INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Cursor persistence for the replica, in its own `state-sync.db`.
 *
 * Deliberately a separate file from every domain database: cursors are written
 * on every sync cycle, and colocating that write traffic with history.db would
 * put the FTS-indexed prompt table behind the sync loop's write lock.
 */
export class StateSyncStore {
	#db: Database;
	#read: Statement;
	#write: Statement;

	constructor(dbPath: string = getStateSyncDbPath()) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		// Busy handler before any lock-taking statement; see the same ordering
		// requirement in SqliteAuthCredentialStore.open().
		this.#db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
${CURSOR_TABLE_DDL}
		`);
		this.#read = this.#db.prepare("SELECT inbound_seq, outbound_rev FROM sync_cursor WHERE domain = ?");
		this.#write = this.#db.prepare(`
INSERT INTO sync_cursor (domain, inbound_seq, outbound_rev) VALUES (?, ?, ?)
ON CONFLICT(domain) DO UPDATE SET inbound_seq = excluded.inbound_seq, outbound_rev = excluded.outbound_rev
		`);
	}

	get(domain: StateDomainId): SyncCursor {
		try {
			const row = this.#read.get(domain) as { inbound_seq: number; outbound_rev: number } | null;
			if (!row) return { inboundSeq: 0, outboundRev: 0 };
			return { inboundSeq: row.inbound_seq, outboundRev: row.outbound_rev };
		} catch (error) {
			// A read failure must not wedge sync; restarting from 0 re-pulls the
			// full delta, which LWW makes idempotent.
			logger.warn("state sync cursor read failed", { domain, error: String(error) });
			return { inboundSeq: 0, outboundRev: 0 };
		}
	}

	set(domain: StateDomainId, cursor: SyncCursor): void {
		try {
			this.#write.run(domain, cursor.inboundSeq, cursor.outboundRev);
		} catch (error) {
			logger.warn("state sync cursor write failed", { domain, error: String(error) });
		}
	}

	close(): void {
		this.#read.finalize();
		this.#write.finalize();
		this.#db.close();
	}
}
