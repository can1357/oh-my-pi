/**
 * `invalidate()` retires a memory by setting `valid_until`/`superseded_by`. Recall filters both in
 * SQL, but a host that installs a query cache consults it BEFORE reaching SQL, so the retired row
 * keeps being served to an identical query until the cache expires.
 *
 * Every other mutator in `store.ts` calls `invalidateCaches()` after changing what recall would
 * return; `invalidate()` did not. These tests pin the contract at the seam `invalidateCaches()`
 * itself uses — the `invalidate()` hook on `beam.caches.queryCache` — so they hold regardless of
 * which cache implementation a host wires in.
 */
import { describe, expect, test } from "bun:test";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { invalidate, remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

/** A beam whose query cache counts how often it is invalidated. */
function makeBeam(): { beam: BeamMemoryState; cleared: () => number } {
	const db = openDatabase(":memory:");
	initBeam(db);
	let cleared = 0;
	const beam = {
		db,
		dbPath: ":memory:",
		sessionId: "session-a",
		authorId: null,
		authorType: null,
		channelId: "session-a",
		useCloud: false,
		eventEmitter: () => {},
		pluginManager: { emit: () => {} },
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: {
			timestampParse: new Map(),
			extractionBuffer: [],
			queryCache: {
				invalidate: () => {
					cleared += 1;
				},
			},
		},
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
	} as unknown as BeamMemoryState;
	return { beam, cleared: () => cleared };
}

describe("invalidate() clears the recall caches", () => {
	test("retiring a working-memory row invalidates the query cache", () => {
		const { beam, cleared } = makeBeam();
		const id = remember(beam, "the quarterly corridor forecast was withdrawn", { source: "conversation" });
		const before = cleared();

		expect(invalidate(beam, id)).toBe(true);
		expect(cleared()).toBe(before + 1);

		beam.db.close();
	});

	test("retiring an episodic row invalidates the query cache", () => {
		const { beam, cleared } = makeBeam();
		beam.db.run(
			`INSERT INTO episodic_memory (id, content, source, timestamp, importance, scope, session_id)
			 VALUES (?, ?, 'conversation', ?, 0.5, 'session', ?)`,
			["ep-1", "an episodic summary that is no longer true", new Date().toISOString(), "session-a"],
		);
		const before = cleared();

		// Falls through the working-memory UPDATE, which matches nothing, into the episodic one.
		expect(invalidate(beam, "ep-1")).toBe(true);
		expect(cleared()).toBe(before + 1);

		beam.db.close();
	});

	test("an invalidation that matches no row leaves the cache alone", () => {
		const { beam, cleared } = makeBeam();
		remember(beam, "a memory that is not the target", { source: "conversation" });
		const before = cleared();

		expect(invalidate(beam, "no-such-memory-id")).toBe(false);
		expect(cleared()).toBe(before);

		beam.db.close();
	});
});
