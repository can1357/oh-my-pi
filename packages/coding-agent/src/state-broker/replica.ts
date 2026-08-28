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
	 * watermark to the last entry's `rev`, so an out-of-order page would skip
	 * rows permanently.
	 *
	 * A filtered domain (project scoping, size caps) MUST apply its filter
	 * DURING the scan rather than to an already-limited page. The watermark
	 * follows the last row returned, so a page whose rows were all dropped after
	 * the fact stalls the cursor while eligible rows sit just beyond it, and the
	 * same window is rescanned forever.
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
	/**
	 * Highest local entry `rev` already scanned for pushing.
	 *
	 * Only ever moved by the push path, and never past the local clock. Merging
	 * a remote row deliberately leaves this alone: remote revs come from another
	 * machine's clock, and letting one drag this forward would mute every local
	 * write below it. See `StateSyncEngine`'s watermark ceiling.
	 */
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
 * Small key/value side table for facts about the BROKER rather than about
 * local state.
 *
 * Currently the broker epoch each domain's inbound cursor was issued by, under
 * `broker_epoch:<domain>`. An inbound cursor is only meaningful relative to the
 * database that issued it, so the epoch has to be remembered next to the
 * cursors it qualifies — and per domain, because the cursors are per domain.
 */
const META_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS sync_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

/**
 * Keys a domain has already published, so a LOCAL DELETION is detectable.
 *
 * A domain that enumerates live state (files on disk, rows in a table) can only
 * ever report what still exists, so on its own it can never emit the tombstone
 * that tells peers something was removed. Remembering what was published turns
 * "absent from this scan" into a deletion event.
 *
 * `deleted` latches the tombstone: it stays set, and the row stays, until the
 * outbound watermark passes `rev`, which only happens once a push carrying the
 * tombstone has actually succeeded. A failed push therefore retries instead of
 * losing the deletion.
 */
const PUBLISHED_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS published_key (
	domain TEXT NOT NULL,
	key TEXT NOT NULL,
	rev INTEGER NOT NULL,
	deleted INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (domain, key)
);
`;

/** One remembered publication; `deleted` marks a pending tombstone. */
export interface PublishedKey {
	key: string;
	rev: number;
	deleted: boolean;
}

/**
 * The exact local snapshot each object-store upload reflects.
 *
 * Without this, "is the archived body current?" can only be asked of the
 * object's own upload timestamp, which is assigned AFTER the bytes were read.
 * A session that appends between the read and the completed `put` therefore
 * produces an object that is missing that record yet looks strictly newer than
 * the local file forever, so every later reconcile skips it and peers resume a
 * truncated conversation.
 *
 * Remembering the `(mtime, size)` the uploaded bytes came from turns the
 * question into an exact-identity comparison against the local file, which no
 * remote clock can confuse. It deliberately does NOT compare local and remote
 * sizes: `ensureLocal` rewrites the header `cwd`, so the same logical content
 * legitimately occupies different byte counts on machines whose project paths
 * differ in length.
 */
const UPLOADED_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS uploaded_object (
	key TEXT PRIMARY KEY,
	mtime INTEGER NOT NULL,
	size INTEGER NOT NULL
);
`;

/** The local `(mtime, size)` a completed upload was taken from. */
export interface UploadedSnapshot {
	mtime: number;
	size: number;
}

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
	#readPublished: Statement;
	#writePublished: Statement;
	#markDeleted: Statement;
	#forgetPublished: Statement;
	#readUploaded: Statement;
	#writeUploaded: Statement;
	#readMeta: Statement;
	#writeMeta: Statement;

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
${PUBLISHED_TABLE_DDL}
${UPLOADED_TABLE_DDL}
${META_TABLE_DDL}
		`);
		this.#read = this.#db.prepare("SELECT inbound_seq, outbound_rev FROM sync_cursor WHERE domain = ?");
		this.#write = this.#db.prepare(`
INSERT INTO sync_cursor (domain, inbound_seq, outbound_rev) VALUES (?, ?, ?)
ON CONFLICT(domain) DO UPDATE SET inbound_seq = excluded.inbound_seq, outbound_rev = excluded.outbound_rev
		`);
		this.#readPublished = this.#db.prepare("SELECT key, rev, deleted FROM published_key WHERE domain = ?");
		this.#writePublished = this.#db.prepare(`
INSERT INTO published_key (domain, key, rev, deleted) VALUES (?, ?, ?, 0)
ON CONFLICT(domain, key) DO UPDATE SET rev = excluded.rev, deleted = 0
		`);
		this.#markDeleted = this.#db.prepare(`
UPDATE published_key SET rev = ?, deleted = 1 WHERE domain = ? AND key = ?
		`);
		this.#forgetPublished = this.#db.prepare("DELETE FROM published_key WHERE domain = ? AND key = ?");
		this.#readUploaded = this.#db.prepare("SELECT mtime, size FROM uploaded_object WHERE key = ?");
		this.#writeUploaded = this.#db.prepare(`
INSERT INTO uploaded_object (key, mtime, size) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET mtime = excluded.mtime, size = excluded.size
		`);
		this.#readMeta = this.#db.prepare("SELECT value FROM sync_meta WHERE key = ?");
		this.#writeMeta = this.#db.prepare(`
INSERT INTO sync_meta (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`);
	}

	/**
	 * Broker epoch `domain`'s inbound cursor was last valid against.
	 *
	 * Scoped per domain because the cursor it qualifies is: domains sync
	 * CONCURRENTLY, so one shared row cannot work. The first domain to see a new
	 * epoch would record it for everyone, and every other domain would then find
	 * its own recorded epoch already equal to the broker's and keep replaying a
	 * cursor the new database never issued.
	 */
	brokerEpoch(domain: StateDomainId): string | undefined {
		try {
			const row = this.#readMeta.get(`broker_epoch:${domain}`) as { value: string } | null;
			return row?.value ?? undefined;
		} catch (error) {
			logger.warn("state sync broker epoch read failed", { domain, error: String(error) });
			return undefined;
		}
	}

	/**
	 * Record the broker identity `domain`'s cursor is now valid against.
	 *
	 * Deliberately does not touch the cursor. The caller resets its own cursor
	 * FIRST and records the epoch after, so a crash in between leaves a
	 * replayable cursor with the old epoch — which is detected and reset again,
	 * idempotently — rather than a stale cursor blessed by the new epoch.
	 */
	rememberBrokerEpoch(domain: StateDomainId, epoch: string): void {
		try {
			this.#writeMeta.run(`broker_epoch:${domain}`, epoch);
		} catch (error) {
			logger.warn("state sync broker epoch write failed", { domain, epoch, error: String(error) });
		}
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

	/**
	 * Everything this domain has published, live rows and pending tombstones
	 * alike. Returns `[]` on a read failure: the caller then sees no prior
	 * publications and simply re-publishes what exists, which LWW absorbs.
	 */
	published(domain: StateDomainId): PublishedKey[] {
		try {
			const rows = this.#readPublished.all(domain) as Array<{ key: string; rev: number; deleted: number }>;
			return rows.map(row => ({ key: row.key, rev: row.rev, deleted: row.deleted !== 0 }));
		} catch (error) {
			logger.warn("state sync published read failed", { domain, error: String(error) });
			return [];
		}
	}

	/** Record that `key` was published at `rev`, clearing any pending tombstone. */
	recordPublished(domain: StateDomainId, key: string, rev: number): void {
		try {
			this.#writePublished.run(domain, key, rev);
		} catch (error) {
			logger.warn("state sync published write failed", { domain, key, error: String(error) });
		}
	}

	/** Latch a pending tombstone for `key` at `rev`. */
	recordDeleted(domain: StateDomainId, key: string, rev: number): void {
		try {
			this.#markDeleted.run(rev, domain, key);
		} catch (error) {
			logger.warn("state sync tombstone latch failed", { domain, key, error: String(error) });
		}
	}

	/** Drop a remembered publication, once its tombstone is known delivered. */
	forgetPublished(domain: StateDomainId, key: string): void {
		try {
			this.#forgetPublished.run(domain, key);
		} catch (error) {
			logger.warn("state sync published delete failed", { domain, key, error: String(error) });
		}
	}

	/** The local snapshot our last completed upload of `key` was taken from. */
	uploadedSnapshot(key: string): UploadedSnapshot | undefined {
		try {
			const row = this.#readUploaded.get(key) as { mtime: number; size: number } | null;
			return row ? { mtime: row.mtime, size: row.size } : undefined;
		} catch (error) {
			// Unknown is the safe answer: the caller re-uploads rather than
			// assuming the archive is current.
			logger.warn("state sync uploaded read failed", { key, error: String(error) });
			return undefined;
		}
	}

	/**
	 * Record that `key` now holds exactly the bytes at local `(mtime, size)`.
	 * Only ever called for a snapshot proven unchanged across the transfer.
	 */
	recordUploaded(key: string, snapshot: UploadedSnapshot): void {
		try {
			this.#writeUploaded.run(key, snapshot.mtime, snapshot.size);
		} catch (error) {
			logger.warn("state sync uploaded write failed", { key, error: String(error) });
		}
	}

	close(): void {
		this.#read.finalize();
		this.#write.finalize();
		this.#readPublished.finalize();
		this.#writePublished.finalize();
		this.#markDeleted.finalize();
		this.#forgetPublished.finalize();
		this.#readUploaded.finalize();
		this.#writeUploaded.finalize();
		this.#readMeta.finalize();
		this.#writeMeta.finalize();
		this.#db.close();
	}
}
