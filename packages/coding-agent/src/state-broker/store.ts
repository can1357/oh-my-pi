/**
 * Broker-side authoritative store for replicated state.
 *
 * This is the *server* half of the state broker: the single SQLite database
 * (`state.db`, created only when `omp auth-broker serve` runs) that fans deltas
 * out to every replica. It is deliberately dumb — it owns no domain semantics,
 * only the two counters the wire protocol is built on:
 *
 * - `rev` — the per-entry logical clock supplied by the client. Merge is strict
 *   last-writer-wins: an incoming entry is stored only when its `rev` is
 *   *strictly greater* than the row already held, so replays and clock ties are
 *   no-ops and never bump the sequence.
 * - `seq` — a per-domain monotonic broker sequence. Every accepted entry is
 *   stamped with the next `seq`, which is the cursor replicas page against.
 *   Keeping `seq` broker-assigned (rather than derived from `rev`) is what lets
 *   `delta()` return a totally-ordered, gap-free stream even when many peers
 *   push overlapping `rev` values.
 *
 * `value` is `JSON.stringify(entry.value)`. A tombstone (`entry.value === null`)
 * is stored as SQL `NULL`, which is why the column is nullable and read-back
 * treats SQL `NULL` and the JSON string `"null"` as distinct — only the former
 * is a tombstone.
 */

import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbBusyTimeoutMs, getStateDbPath } from "@oh-my-pi/pi-utils";
import {
	STATE_DOMAIN_IDS,
	STATE_PAGE_LIMIT,
	type StateDeltaResponse,
	type StateDomainId,
	type StateEntry,
	type StateSummaryResponse,
} from "./wire";

const STATE_DDL = `
CREATE TABLE IF NOT EXISTS state_entries (
	domain TEXT NOT NULL,
	key TEXT NOT NULL,
	rev INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	value TEXT,
	PRIMARY KEY (domain, key)
);
CREATE INDEX IF NOT EXISTS idx_state_entries_seq ON state_entries(domain, seq);
CREATE TABLE IF NOT EXISTS state_seq (
	domain TEXT PRIMARY KEY,
	seq INTEGER NOT NULL
);
`;

/** A row as stored on disk: `value` is a JSON string, or SQL `NULL` for a tombstone. */
interface StoredRow {
	key: string;
	rev: number;
	seq: number;
	value: string | null;
}

/**
 * The single SQLite-backed store behind the broker's `/v1/state` routes.
 *
 * Reads and writes are synchronous — the store is only ever driven from the
 * broker's request handlers, so there is no TUI render path to keep off the
 * SQLite thread. Long-poll wake-ups are delivered in-process via
 * {@link StateBrokerStore.subscribe} rather than by polling the database.
 */
export class StateBrokerStore {
	#db: Database;

	// Prepared statements — reused across every request for the process lifetime.
	#selectRevStmt: Statement;
	#upsertEntryStmt: Statement;
	#selectSeqStmt: Statement;
	#upsertSeqStmt: Statement;
	#deltaStmt: Statement;
	#countStmt: Statement;

	/**
	 * Long-poll notifiers keyed by domain. Fed by {@link push} after a commit
	 * that advanced the domain's `seq`, so `GET ?wait=` can return immediately
	 * instead of spinning on the database.
	 */
	#subscribers = new Map<StateDomainId, Set<() => void>>();

	private constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });

		this.#db = new Database(dbPath);

		// Install the busy handler BEFORE any lock-taking statement so a
		// concurrent writer can't wedge the broker for the full default timeout.
		this.#db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
${STATE_DDL}
		`);

		this.#selectRevStmt = this.#db.prepare("SELECT rev FROM state_entries WHERE domain = ? AND key = ?");
		this.#upsertEntryStmt = this.#db.prepare(`
INSERT INTO state_entries (domain, key, rev, seq, value) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(domain, key) DO UPDATE SET rev = excluded.rev, seq = excluded.seq, value = excluded.value
		`);
		this.#selectSeqStmt = this.#db.prepare("SELECT seq FROM state_seq WHERE domain = ?");
		this.#upsertSeqStmt = this.#db.prepare(`
INSERT INTO state_seq (domain, seq) VALUES (?, ?)
ON CONFLICT(domain) DO UPDATE SET seq = excluded.seq
		`);
		this.#deltaStmt = this.#db.prepare(
			"SELECT key, rev, seq, value FROM state_entries WHERE domain = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
		);
		this.#countStmt = this.#db.prepare("SELECT COUNT(*) AS n FROM state_entries WHERE domain = ?");
	}

	/** Open (creating on first use) the broker's shared-state database. */
	static open(dbPath: string = getStateDbPath()): StateBrokerStore {
		return new StateBrokerStore(dbPath);
	}

	/**
	 * Apply a client push under strict last-writer-wins and return the domain's
	 * resulting `seq` plus the number of entries that won their comparison.
	 *
	 * The whole batch runs in one transaction so the allocated sequence range is
	 * contiguous and the summary/delta a concurrent reader sees is never a
	 * half-applied push.
	 */
	push(domain: StateDomainId, entries: readonly StateEntry[]): { seq: number; accepted: number } {
		const apply = this.#db.transaction((rows: readonly StateEntry[]) => {
			let seq = this.#readSeq(domain);
			let accepted = 0;
			for (const entry of rows) {
				const existing = this.#selectRevStmt.get(domain, entry.key) as { rev: number } | null;
				// Strict `>`: equal revs (replays, clock ties) are dropped so seq
				// only ever advances for a genuinely newer write.
				if (existing != null && entry.rev <= existing.rev) continue;
				seq += 1;
				accepted += 1;
				this.#upsertEntryStmt.run(domain, entry.key, entry.rev, seq, this.#encodeValue(entry.value));
			}
			if (accepted > 0) this.#upsertSeqStmt.run(domain, seq);
			return { seq, accepted };
		});
		const result = apply(entries);
		if (result.accepted > 0) this.#notify(domain);
		return result;
	}

	/**
	 * Entries accepted after `sinceSeq`, ordered by ascending `seq`, capped at
	 * `limit` (clamped to {@link STATE_PAGE_LIMIT}). `seq` is the last returned
	 * entry's sequence (or `sinceSeq` when the page is empty); `more` is true
	 * when the page filled, signalling the caller to pull again immediately.
	 */
	delta(domain: StateDomainId, sinceSeq: number, limit: number): StateDeltaResponse {
		const capped = Math.max(1, Math.min(STATE_PAGE_LIMIT, Math.trunc(limit)));
		const rows = this.#deltaStmt.all(domain, sinceSeq, capped) as StoredRow[];
		const entries: StateEntry[] = rows.map(row => ({
			key: row.key,
			rev: row.rev,
			value: this.#decodeValue(row.value),
		}));
		const seq = rows.length > 0 ? rows[rows.length - 1]!.seq : sinceSeq;
		return { domain, seq, entries, more: rows.length === capped };
	}

	/** Per-domain current `seq` and stored row count, for the cheap change probe. */
	summary(): StateSummaryResponse["domains"] {
		return STATE_DOMAIN_IDS.map(domain => {
			const count = this.#countStmt.get(domain) as { n: number };
			return { domain, seq: this.#readSeq(domain), entries: count.n };
		});
	}

	/** Current broker sequence for a domain (0 when nothing has been pushed). */
	currentSeq(domain: StateDomainId): number {
		return this.#readSeq(domain);
	}

	/**
	 * Register a wake-up for `domain`, fired after any push that advances its
	 * `seq`. Returns an unsubscribe callback the long-poll handler must call on
	 * every exit path so the set never leaks resolvers.
	 */
	subscribe(domain: StateDomainId, cb: () => void): () => void {
		let set = this.#subscribers.get(domain);
		if (!set) {
			set = new Set();
			this.#subscribers.set(domain, set);
		}
		set.add(cb);
		return () => {
			const current = this.#subscribers.get(domain);
			if (!current) return;
			current.delete(cb);
			if (current.size === 0) this.#subscribers.delete(domain);
		};
	}

	close(): void {
		this.#selectRevStmt.finalize();
		this.#upsertEntryStmt.finalize();
		this.#selectSeqStmt.finalize();
		this.#upsertSeqStmt.finalize();
		this.#deltaStmt.finalize();
		this.#countStmt.finalize();
		this.#subscribers.clear();
		this.#db.close();
	}

	#readSeq(domain: StateDomainId): number {
		const row = this.#selectSeqStmt.get(domain) as { seq: number } | null;
		return row?.seq ?? 0;
	}

	#notify(domain: StateDomainId): void {
		const set = this.#subscribers.get(domain);
		if (!set) return;
		// Copy before firing: resolvers unsubscribe themselves during iteration.
		for (const cb of [...set]) cb();
	}

	/** `null` value → SQL NULL tombstone; anything else → its JSON encoding. */
	#encodeValue(value: unknown): string | null {
		if (value === null || value === undefined) return null;
		return JSON.stringify(value);
	}

	/** SQL NULL → tombstone (`null`); a JSON string → its decoded value. */
	#decodeValue(value: string | null): unknown {
		if (value === null) return null;
		return JSON.parse(value);
	}
}
