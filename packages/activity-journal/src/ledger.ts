import { Database } from "bun:sqlite";
import type { ActivityEvidence, RawClipReference } from "./types";

export interface ActivityLedger {
	record(evidence: ActivityEvidence): boolean;
	list(): readonly ActivityEvidence[];
	listExpiredRawClips(now: string): readonly ActivityEvidence[];
	markRawClipDeleted(evidenceId: string, deletedAt: string): boolean;
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
