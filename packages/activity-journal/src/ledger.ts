import { Database } from "bun:sqlite";
import type { ActivityEvidence, RawClipReference } from "./types";

export interface ActivityLedger {
	record(evidence: ActivityEvidence): boolean;
	list(): readonly ActivityEvidence[];
	listExpiredRawClips(now: string): readonly ActivityEvidence[];
	markRawClipDeleted(evidenceId: string, deletedAt: string): boolean;
	close(): void;
}

/**
 * The query-only half of {@link ActivityLedger}. Consumers that only read —
 * recall, reporting, in-session activity lookup — should depend on this and
 * open via {@link SqliteActivityLedgerReader}, never on the read-write class.
 */
export interface ActivityLedgerReader {
	list(): readonly ActivityEvidence[];
	/** Evidence whose window overlaps `[startedAt, endedAt)`; both ISO-8601. */
	listOverlapping(startedAt: string, endedAt: string): readonly ActivityEvidence[];
	close(): void;
}

interface LedgerRow {
	readonly id: string;
	readonly payload: string;
}

/**
 * Local-only source of truth for redacted activity evidence. Raw clip bytes are
 * never written to this database; a short-lived local pointer may be retained
 * solely so the configured lifecycle can delete the source file.
 */
export class SqliteActivityLedger implements ActivityLedger {
	#db: Database;

	constructor(path: string) {
		this.#db = new Database(path, { create: true, strict: true });
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS activity_evidence (
				id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT NOT NULL,
				payload TEXT NOT NULL,
				raw_clip_pointer TEXT,
				raw_clip_expires_at TEXT,
				raw_clip_deleted_at TEXT
			);
			CREATE INDEX IF NOT EXISTS activity_evidence_window_idx
				ON activity_evidence (started_at, ended_at);
			CREATE INDEX IF NOT EXISTS activity_evidence_raw_expiry_idx
				ON activity_evidence (raw_clip_expires_at)
				WHERE raw_clip_deleted_at IS NULL;
		`);
	}

	record(evidence: ActivityEvidence): boolean {
		const result = this.#db.run(
			`INSERT OR IGNORE INTO activity_evidence (
				id, source, started_at, ended_at, payload, raw_clip_pointer, raw_clip_expires_at, raw_clip_deleted_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				evidence.id,
				evidence.source,
				evidence.window.startedAt,
				evidence.window.endedAt,
				JSON.stringify(evidence),
				evidence.rawClip?.localPointer ?? null,
				evidence.rawClip?.expiresAt ?? null,
				evidence.rawClip?.deletedAt ?? null,
			],
		);
		return result.changes === 1;
	}

	list(): readonly ActivityEvidence[] {
		return this.#db
			.query<LedgerRow, []>("SELECT id, payload FROM activity_evidence ORDER BY started_at, id")
			.all()
			.map(row => parseEvidence(row));
	}

	listExpiredRawClips(now: string): readonly ActivityEvidence[] {
		return this.#db
			.query<LedgerRow, [string]>(
				`SELECT id, payload FROM activity_evidence
				 WHERE raw_clip_pointer IS NOT NULL
				   AND raw_clip_expires_at <= ?
				   AND raw_clip_deleted_at IS NULL
				 ORDER BY raw_clip_expires_at, id`,
			)
			.all(now)
			.map(row => parseEvidence(row));
	}

	markRawClipDeleted(evidenceId: string, deletedAt: string): boolean {
		const row = this.#db
			.query<LedgerRow, [string]>("SELECT id, payload FROM activity_evidence WHERE id = ?")
			.get(evidenceId);
		if (!row) return false;

		const evidence = parseEvidence(row);
		if (!evidence.rawClip || evidence.rawClip.deletedAt) return false;
		const rawClip: RawClipReference = { ...evidence.rawClip, deletedAt };
		const updated: ActivityEvidence = { ...evidence, rawClip };
		const result = this.#db.run(
			`UPDATE activity_evidence
			 SET payload = ?, raw_clip_deleted_at = ?
			 WHERE id = ? AND raw_clip_deleted_at IS NULL`,
			[JSON.stringify(updated), deletedAt, evidenceId],
		);
		return result.changes === 1;
	}

	close(): void {
		this.#db.close();
	}
}

/**
 * Read-only view of a ledger someone else owns.
 *
 * Deliberately does NOT run the `CREATE TABLE IF NOT EXISTS` bootstrap that
 * {@link SqliteActivityLedger} does: DDL takes a write lock, so a reader that
 * bootstraps would contend with the live writer on every open. The sqlite
 * handle itself is opened read-only, which makes that a structural guarantee
 * rather than a convention — any stray write throws instead of racing.
 *
 * Requires the database to already exist; opening a missing file throws, since
 * "the ledger has not been created yet" is a caller-visible state, not
 * something a reader should paper over by creating an empty database.
 */
export class SqliteActivityLedgerReader implements ActivityLedgerReader {
	#db: Database;

	constructor(path: string) {
		this.#db = new Database(path, { readonly: true, strict: true });
	}

	list(): readonly ActivityEvidence[] {
		return this.#db
			.query<LedgerRow, []>("SELECT id, payload FROM activity_evidence ORDER BY started_at, id")
			.all()
			.map(row => parseEvidence(row));
	}

	listOverlapping(startedAt: string, endedAt: string): readonly ActivityEvidence[] {
		// Half-open overlap: the row starts before the window ends and ends
		// after it begins. Both columns hold `Date#toISOString()` output, whose
		// fixed-width UTC form sorts lexicographically in chronological order,
		// so string comparison is a correct range test here.
		return this.#db
			.query<LedgerRow, [string, string]>(
				`SELECT id, payload FROM activity_evidence
				 WHERE started_at < ? AND ended_at > ?
				 ORDER BY started_at, id`,
			)
			.all(endedAt, startedAt)
			.map(row => parseEvidence(row));
	}

	close(): void {
		this.#db.close();
	}
}

function parseEvidence(row: LedgerRow): ActivityEvidence {
	const value: unknown = JSON.parse(row.payload);
	if (!isActivityEvidence(value)) throw new Error(`activity ledger record ${row.id} is malformed`);
	return value;
}

function isActivityEvidence(value: unknown): value is ActivityEvidence {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.source === "string" &&
		typeof record.sourceEventId === "string" &&
		typeof record.recordedAt === "string" &&
		Array.isArray(record.evidenceRefs)
	);
}
