import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { getConsolidationLog, sleep } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

// D7 regression: trimWorkingMemory used to delete `consolidated_at IS NULL`
// rows, which is exactly the un-promoted data `sleep()` still needed. A row
// aged past the TTL but never consolidated must survive the trim triggered by
// an unrelated `remember()`, and must still be reachable for real promotion
// afterward. Only rows that ARE already consolidated may be reclaimed.

function state(sessionId = "d7"): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
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

const opened: Database[] = [];

function trackedState(sessionId = "d7"): BeamMemoryState {
	const beam = state(sessionId);
	opened.push(beam.db);
	return beam;
}

afterEach(() => {
	while (opened.length > 0) {
		const db = opened.pop();
		if (db !== undefined) closeQuietly(db);
	}
});

type WorkingRow = { content: string; consolidated_at: string | null };

describe("trimWorkingMemory promote-or-skip (D7)", () => {
	it("leaves an un-consolidated row past the TTL untouched by trim, then lets sleep() promote it", () => {
		const beam = trackedState("d7-promote");
		const staleId = "wm-stale-unconsolidated";
		// 30h old, ISO-8601 with a `T` separator and `Z` suffix (never SQLite's
		// space-separated `datetime('now')` form, which sorts before every ISO
		// string on the same calendar date): past the 24h workingMemoryTtlHours
		// AND past sleep's 12h (half-TTL) eligibility cutoff, but never
		// consolidated.
		beam.db
			.prepare(
				`INSERT INTO working_memory
					(id, content, source, timestamp, session_id, importance, veracity, scope, trust_tier, consolidated_at, created_at)
				 VALUES (?, ?, 'conversation', ?, ?, 0.5, 'stated', 'session', 'STATED', NULL, ?)`,
			)
			.run(
				staleId,
				"Stale but never promoted note",
				new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
				"d7-promote",
				new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
			);

		// A normal write triggers the automatic TTL/overflow trim.
		remember(beam, "a fresh conversational note", { source: "conversation" });

		// The un-consolidated row must survive: trim only reclaims rows that
		// ARE consolidated.
		const survived = beam.db
			.query<WorkingRow, [string]>("SELECT content, consolidated_at FROM working_memory WHERE id = ?")
			.get(staleId);
		expect(survived).not.toBeNull();
		expect(survived?.content).toBe("Stale but never promoted note");
		expect(survived?.consolidated_at).toBeNull();

		// sleep() now promotes it: it is old enough (past half the TTL) and
		// still eligible because it was never trimmed away.
		const result = sleep(beam, false);
		expect(result.status).toBe("consolidated");
		expect(result.items_consolidated).toBeGreaterThanOrEqual(1);
		expect(result.consolidated_ids).toContain(staleId);

		expect(beam.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
			count: 1,
		});
		expect(getConsolidationLog(beam, 1)).toHaveLength(1);

		const promoted = beam.db
			.query<WorkingRow, [string]>("SELECT content, consolidated_at FROM working_memory WHERE id = ?")
			.get(staleId);
		expect(promoted?.consolidated_at).not.toBeNull();
	});

	it("still reclaims a row that IS consolidated and past the TTL", () => {
		const beam = trackedState("d7-reclaim");
		const consolidatedId = "wm-already-consolidated";
		const oldTimestamp = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
		beam.db
			.prepare(
				`INSERT INTO working_memory
					(id, content, source, timestamp, session_id, importance, veracity, scope, trust_tier, consolidated_at, created_at)
				 VALUES (?, ?, 'conversation', ?, ?, 0.5, 'stated', 'session', 'STATED', ?, ?)`,
			)
			.run(consolidatedId, "Already promoted note", oldTimestamp, "d7-reclaim", oldTimestamp, oldTimestamp);

		remember(beam, "a fresh conversational note", { source: "conversation" });

		const remaining = beam.db
			.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM working_memory WHERE id = ?")
			.get(consolidatedId);
		expect(remaining?.count).toBe(0);
	});
});
