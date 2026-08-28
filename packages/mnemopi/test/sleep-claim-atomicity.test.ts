// Regression coverage for B2: `sleep()` must never leave a `working_memory` row
// stamped `consolidated_at` without a matching `episodic_memory` row (the "phantom
// consolidated" state that `trimWorkingMemory` — beam/store.ts, `consolidated_at IS NOT
// NULL` — would silently delete on the next `remember()`). See
// beam/consolidate.ts: `promoteChunk` claims and promotes each chunk inside a single
// `transaction()`, so a throw anywhere in the promote step rolls the claim back too.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { getConsolidationLog, sleep } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import * as extraction from "@oh-my-pi/pi-mnemopi/core/extraction";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

function state(sessionId = "s1"): BeamMemoryState {
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

// TTL-eligible rows must be older than half the (24h default) TTL. ISO-8601 throughout —
// `working_memory.timestamp` is compared as a string, and `datetime('now', ...)` sorts
// before the `T`-separated format `sleep()` writes, so it is never used here.
function oldIso(hoursAgo: number): string {
	return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

const opened: Database[] = [];

function trackedState(sessionId = "s1"): BeamMemoryState {
	const beam = state(sessionId);
	opened.push(beam.db);
	return beam;
}

function insertWorking(beam: BeamMemoryState, id: string, content: string, source: string, hoursAgo: number): void {
	beam.db.run(
		`INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity, scope, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[id, content, source, oldIso(hoursAgo), beam.sessionId, 0.7, "true", "session", oldIso(hoursAgo)],
	);
}

/** Rows stamped as consolidated with no promoted counterpart — the exact phantom state B2 produced. */
function orphanedConsolidatedRows(beam: BeamMemoryState): number {
	const row = beam.db
		.query(
			`SELECT COUNT(*) AS n FROM working_memory wm
			 WHERE wm.consolidated_at IS NOT NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM episodic_memory em
			     WHERE ',' || em.summary_of || ',' LIKE '%,' || wm.id || ',%'
			   )`,
		)
		.get() as { n: number };
	return row.n;
}

afterEach(() => {
	while (opened.length > 0) {
		const db = opened.pop();
		if (db !== undefined) closeQuietly(db);
	}
});

describe("sleep() claim-and-promote atomicity (B2)", () => {
	it("rolls a failing chunk's claim back instead of leaving a phantom consolidated row", () => {
		const beam = trackedState();
		// Distinct `source` values put "healthy" and "poison" rows in separate chunks
		// (sleep() groups by source before splitting), so only the poison chunk fails.
		insertWorking(beam, "wm-healthy", "a perfectly normal note", "sourceHealthy", 30);
		insertWorking(beam, "wm-poison", "a note that trips the injected failure", "sourcePoison", 29);

		// Least invasive failure seam: `heuristicExtractFacts` is called synchronously,
		// uncaught, from `extractAndStoreFacts` inside `consolidateToEpisodic` — the same
		// call `promoteChunk` wraps in its transaction — so throwing here reproduces a
		// real mid-promote failure without touching consolidate.ts's own internals.
		const real = extraction.heuristicExtractFacts;
		const spy = spyOn(extraction, "heuristicExtractFacts").mockImplementation((text: string) => {
			if (text.includes("sourcePoison")) throw new Error("injected promote failure");
			return real(text);
		});

		const result = sleep(beam, false);

		expect(orphanedConsolidatedRows(beam)).toBe(0);

		const healthy = beam.db.query("SELECT consolidated_at FROM working_memory WHERE id = 'wm-healthy'").get() as {
			consolidated_at: string | null;
		};
		const poison = beam.db.query("SELECT consolidated_at FROM working_memory WHERE id = 'wm-poison'").get() as {
			consolidated_at: string | null;
		};
		expect(healthy.consolidated_at).not.toBeNull();
		expect(poison.consolidated_at).toBeNull();
		expect(beam.db.query("SELECT COUNT(*) AS c FROM episodic_memory").get()).toEqual({ c: 1 });
		expect(result.status).toBe("consolidated");
		expect(result.items_consolidated).toBe(1);

		spy.mockRestore();
		// The poisoned row must stay eligible (not silently dropped forever) once the
		// failure clears, proving the skip-and-continue design does not lose data.
		const retry = sleep(beam, false);
		expect(retry.items_consolidated).toBe(1);
		expect(
			(
				beam.db.query("SELECT consolidated_at FROM working_memory WHERE id = 'wm-poison'").get() as {
					consolidated_at: string | null;
				}
			).consolidated_at,
		).not.toBeNull();
		expect(orphanedConsolidatedRows(beam)).toBe(0);
	});

	it("happy path promotes every row, writes exactly one consolidation_log row, and keeps the SleepResult shape", () => {
		const beam = trackedState();
		insertWorking(beam, "wm1", "task alpha", "conversation", 30);
		insertWorking(beam, "wm2", "task beta", "conversation", 29);

		const result = sleep(beam, false);

		expect(result.dry_run).toBe(false);
		expect(result.status).toBe("consolidated");
		expect(result.items_consolidated).toBe(2);
		expect(result.summaries_created).toBe(1);
		expect(result.conflicts_resolved).toBe(0);
		expect(result.llm_used).toBe(0);
		expect(result.method).toBe("aaak");
		expect(Array.isArray(result.consolidated_ids)).toBe(true);
		expect((result.consolidated_ids as string[]).sort()).toEqual(["wm1", "wm2"]);
		expect(result.degradation).toBeDefined();

		expect(beam.db.query("SELECT COUNT(*) AS c FROM consolidation_log").get()).toEqual({ c: 1 });
		expect(getConsolidationLog(beam, 1)[0]?.items_consolidated).toBe(2);
		expect(
			(
				beam.db.query("SELECT COUNT(*) AS c FROM working_memory WHERE consolidated_at IS NOT NULL").get() as {
					c: number;
				}
			).c,
		).toBe(2);
		expect(orphanedConsolidatedRows(beam)).toBe(0);
	});

	it("dryRun stays side-effect free: no claims, no episodic rows, no log entries", () => {
		const beam = trackedState();
		insertWorking(beam, "wm1", "task alpha", "conversation", 30);
		insertWorking(beam, "wm2", "task beta", "conversation", 29);

		const result = sleep(beam, true);

		expect(result.status).toBe("dry_run");
		expect(result.items_consolidated).toBe(2);
		expect(beam.db.query("SELECT COUNT(*) AS c FROM episodic_memory").get()).toEqual({ c: 0 });
		expect(beam.db.query("SELECT COUNT(*) AS c FROM consolidation_log").get()).toEqual({ c: 0 });
		expect(
			(
				beam.db.query("SELECT COUNT(*) AS c FROM working_memory WHERE consolidated_at IS NOT NULL").get() as {
					c: number;
				}
			).c,
		).toBe(0);
	});

	it("invalidates the query cache and polyphonic dictionary after a real consolidation", () => {
		const beam = trackedState();
		insertWorking(beam, "wm1", "task alpha", "conversation", 30);

		let queryCacheInvalidations = 0;
		let dictionaryInvalidations = 0;
		beam.caches.queryCache = { invalidate: () => queryCacheInvalidations++ };
		beam.caches.polyphonicEngine = { invalidateDictionary: () => dictionaryInvalidations++ };

		sleep(beam, true);
		expect(queryCacheInvalidations).toBe(0);
		expect(dictionaryInvalidations).toBe(0);

		sleep(beam, false);
		expect(queryCacheInvalidations).toBe(1);
		expect(dictionaryInvalidations).toBe(1);
	});
});
