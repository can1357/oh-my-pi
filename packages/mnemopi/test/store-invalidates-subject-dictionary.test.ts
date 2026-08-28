import { afterEach, describe, expect, it } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { forgetWorking, remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { EpisodicGraph } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const states: BeamMemoryState[] = [];

/** Call counters fed by the duck-typed spies installed on `beam.caches`. */
interface CacheSpyCounts {
	queryCache: number;
	dictionary: number;
}

/**
 * Builds a beam state wired with minimal duck-typed spies on `queryCache` and
 * `polyphonicEngine` — the exact shapes `invalidateCaches` in `beam/store.ts`
 * probes for (`{ invalidate?: () => void }` / `{ invalidateDictionary?: () => void }`).
 * Neither `QueryCache` nor `PolyphonicRecallEngine` is imported: this proves the
 * hook fires against the duck-typed contract alone, the same way production code
 * plugs a real engine instance into `beam.caches.polyphonicEngine`.
 */
function makeState(sessionId: string, counts: CacheSpyCounts): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: () => {},
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: {
			timestampParse: new Map(),
			extractionBuffer: [],
			queryCache: {
				invalidate: () => {
					counts.queryCache++;
				},
			},
			polyphonicEngine: {
				invalidateDictionary: () => {
					counts.dictionary++;
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
	};
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

describe("beam/store.ts invalidates the polyphonic subject dictionary", () => {
	it("fires both the query-cache and subject-dictionary hooks on remember()", () => {
		const counts: CacheSpyCounts = { queryCache: 0, dictionary: 0 };
		const beam = makeState("session-dict-a", counts);

		remember(beam, "User prefers dark mode", { source: "conversation" });

		expect(counts.queryCache).toBeGreaterThan(0);
		expect(counts.dictionary).toBeGreaterThan(0);
	});

	it("fires both hooks when forgetWorking deletes the facts/gists rows the dictionary is built from", () => {
		const counts: CacheSpyCounts = { queryCache: 0, dictionary: 0 };
		const beam = makeState("session-dict-b", counts);
		// EpisodicGraph owns the `gists` schema; init it on the shared connection
		// so the facts/gists rows the subject dictionary reads from actually exist.
		new EpisodicGraph({ db: beam.db, dbPath: ":memory:" });

		const memoryId = remember(beam, "Bob works at Acme", { source: "conversation" });
		beam.db
			.prepare(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id) VALUES (?, ?, 'Bob', 'works_at', 'Acme', ?)",
			)
			.run(`fact-${memoryId}`, beam.sessionId, memoryId);
		beam.db.prepare("INSERT INTO gists (id, text, memory_id) VALUES (?, 'g', ?)").run(`gist-${memoryId}`, memoryId);

		const beforeQueryCache = counts.queryCache;
		const beforeDictionary = counts.dictionary;

		expect(forgetWorking(beam, memoryId)).toBe(true);

		// The delete actually reached facts/gists — this is the mutation the
		// engine's own `MAX(rowid)` staleness check can miss (deleting the max
		// row, then a later insert reusing that rowid, never re-triggers it).
		expect(beam.db.prepare("SELECT COUNT(*) AS count FROM facts WHERE source_msg_id = ?").get(memoryId)).toEqual({
			count: 0,
		});
		expect(beam.db.prepare("SELECT COUNT(*) AS count FROM gists WHERE memory_id = ?").get(memoryId)).toEqual({
			count: 0,
		});

		expect(counts.queryCache).toBeGreaterThan(beforeQueryCache);
		expect(counts.dictionary).toBeGreaterThan(beforeDictionary);
	});
});
