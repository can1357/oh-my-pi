import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

// Schema migration regression: `initBeam` used to backfill every
// pre-existing `working_memory` row with a fresh `consolidated_at` timestamp
// the moment that column was ALTER-added to an older bank. Under D7's fixed
// trim predicate (trimWorkingMemory now reclaims rows where
// `consolidated_at IS NOT NULL`, treating NULL as "never promoted, don't
// delete") that backfill is exactly backwards: it stamps every legacy row as
// already-consolidated, making it immediately trim-eligible once past TTL
// even though it was never promoted to episodic memory — silently
// destroying an upgraded bank's whole working memory on the next
// remember(). A newly-added `consolidated_at` column must stay NULL.

const opened: Database[] = [];

afterEach(() => {
	while (opened.length > 0) {
		const db = opened.pop();
		if (db !== undefined) closeQuietly(db);
	}
});

function beamAround(db: Database, sessionId: string): BeamMemoryState {
	return {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-1",
		authorType: "user",
		channelId: sessionId,
		useCloud: false,
		eventEmitter: undefined,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
}

type WorkingRow = { id: string; consolidated_at: string | null };

describe("initBeam legacy consolidated_at migration (D7 backfill fix)", () => {
	it("leaves consolidated_at NULL for pre-existing rows on an upgraded bank, and trim never reclaims them", () => {
		// Build a genuinely legacy `working_memory` table BEFORE calling
		// initBeam, with a minimal column set that omits `consolidated_at`
		// entirely (and everything else initBeam adds via
		// addColumnIfMissing). initBeam's `CREATE TABLE IF NOT EXISTS` then
		// no-ops (the table already exists) and every ALTER fires for real —
		// exactly mirroring an on-disk bank upgraded from an older schema.
		const db = openDatabase(":memory:", { create: true, readwrite: true });
		opened.push(db);
		db.run(`
			CREATE TABLE working_memory (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				source TEXT,
				timestamp TEXT,
				session_id TEXT DEFAULT 'default',
				importance REAL DEFAULT 0.5,
				metadata_json TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// 30h old, ISO-8601 with a `T` separator and `Z` suffix (never
		// SQLite's space-separated `datetime('now')` form, which sorts before
		// every ISO string on the same calendar date): past the 24h
		// workingMemoryTtlHours default used below.
		const staleTimestamp = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
		db.run(
			`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, created_at)
			 VALUES (?, ?, 'conversation', ?, ?, 0.5, ?)`,
			[
				"wm-legacy-1",
				"Legacy row from before consolidated_at existed",
				staleTimestamp,
				"legacy-session",
				staleTimestamp,
			],
		);
		db.run(
			`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, created_at)
			 VALUES (?, ?, 'conversation', ?, ?, 0.5, ?)`,
			["wm-legacy-2", "Another legacy row, also stale", staleTimestamp, "legacy-session", staleTimestamp],
		);

		// Run the real schema migration.
		initBeam(db);

		const migrated = db
			.query<WorkingRow, []>(
				"SELECT id, consolidated_at FROM working_memory WHERE id IN ('wm-legacy-1', 'wm-legacy-2') ORDER BY id",
			)
			.all();
		expect(migrated).toHaveLength(2);
		for (const row of migrated) {
			expect(row.consolidated_at).toBeNull();
		}

		// A subsequent remember()-triggered trim must NOT delete them: they
		// are past TTL but never consolidated, which is the protected state.
		const beam = beamAround(db, "legacy-session");
		remember(beam, "a fresh conversational note", { source: "conversation" });

		const survivors = db
			.query<{ c: number }, []>(
				"SELECT COUNT(*) AS c FROM working_memory WHERE id IN ('wm-legacy-1', 'wm-legacy-2')",
			)
			.get();
		expect(survivors?.c).toBe(2);
	});
});
