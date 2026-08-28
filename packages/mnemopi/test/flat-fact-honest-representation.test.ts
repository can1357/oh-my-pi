import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { extractAndStoreFacts, storeFactStrings } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import { factRecall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";

// D2 regression: `storeFactStrings`'s flat-statement call site used to
// fabricate `facts.subject = 'fact'` / `facts.predicate = 'entity'` for
// every extracted statement — those are storage LABELS
// (`memoria_facts.key`/`fact_type`), not a real subject/predicate, and
// projecting them into `facts` lied about the statement's shape. Flat
// statements now live only in `memoria_facts`, indexed by the new
// `fts_memoria_facts` FTS5 table, and stay reachable through `factRecall`.
// Callers that DO have a real key (metric/date/version extraction in
// `extractAndStoreFacts`) must keep projecting into `facts` unchanged.

function makeBeam(sessionId = "d2"): BeamMemoryState {
	const db = new Database(":memory:");
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

function trackedBeam(sessionId = "d2"): BeamMemoryState {
	const beam = makeBeam(sessionId);
	opened.push(beam.db);
	return beam;
}

afterEach(() => {
	while (opened.length > 0) {
		opened.pop()?.close();
	}
});

describe("flat extracted facts get an honest representation (D2)", () => {
	it("storeFactStrings writes only memoria_facts, never a fabricated facts row", () => {
		const beam = trackedBeam();
		storeFactStrings(beam, ["capture a full-page screenshot rather than a fixed viewport"], 0, "src-mem-1", 0.7);

		const factsCount = beam.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM facts").get();
		expect(factsCount?.c).toBe(0);

		const fabricatedSubject = beam.db
			.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM facts WHERE subject = 'fact'")
			.get();
		expect(fabricatedSubject?.c).toBe(0);

		const mf = beam.db
			.query<{ fact_type: string; key: string; value: string; source_memory_id: string | null }, []>(
				"SELECT fact_type, key, value, source_memory_id FROM memoria_facts",
			)
			.get();
		expect(mf?.fact_type).toBe("entity");
		expect(mf?.key).toBe("fact");
		expect(mf?.value).toBe("capture a full-page screenshot rather than a fixed viewport");
		expect(mf?.source_memory_id).toBe("src-mem-1");
	});

	it("the flat statement is findable by a text word through the new memoria FTS index and through factRecall", () => {
		const beam = trackedBeam();
		storeFactStrings(beam, ["capture a full-page screenshot rather than a fixed viewport"], 0, "src-mem-2", 0.7);

		const direct = beam.db
			.query<{ value: string }, [string]>(
				`SELECT memoria_facts.value AS value
				 FROM fts_memoria_facts
				 JOIN memoria_facts ON memoria_facts.id = fts_memoria_facts.rowid
				 WHERE fts_memoria_facts MATCH ?`,
			)
			.all("screenshot");
		expect(direct).toHaveLength(1);
		expect(direct[0]?.value).toContain("screenshot");

		const results = factRecall(beam, "screenshot", 5);
		expect(results).toHaveLength(1);
		expect(results[0]?.content).toBe("capture a full-page screenshot rather than a fixed viewport");
		expect(results[0]?.source_memory_id).toBe("src-mem-2");
	});

	it("a heuristic extraction path with a real key still projects into facts unchanged (date extraction)", () => {
		// NOTE: `storeFactStrings`'s own regex-routed preference/instruction
		// paths (`The user prefers X`, `Instruction: X`) never touched `facts`
		// at all — they write `memoria_preferences`/`memoria_instructions` via
		// `insertPreference`/`insertInstruction`, which never called
		// `insertFactRows`. The only heuristic paths that DO project into
		// `facts` with a real key are the metric/date/version extractors in
		// `extractAndStoreFacts`, which call `insertFactRows` directly. Date
		// extraction is used here since its key ("iso_date") is fixed and
		// deterministic.
		const beam = trackedBeam();
		const counts = extractAndStoreFacts(beam, "The launch date is 2026-06-01.", 0, "src-mem-3");
		expect(counts.date).toBeGreaterThanOrEqual(1);

		const factRow = beam.db
			.query<{ subject: string; predicate: string; object: string }, []>(
				"SELECT subject, predicate, object FROM facts WHERE predicate = 'date'",
			)
			.get();
		expect(factRow?.subject).toBe("iso_date");
		expect(factRow?.predicate).toBe("date");
		expect(factRow?.object).toBe("2026-06-01");

		const mfRow = beam.db
			.query<{ fact_type: string; key: string; value: string }, []>(
				"SELECT fact_type, key, value FROM memoria_facts WHERE fact_type = 'date'",
			)
			.get();
		expect(mfRow?.key).toBe("iso_date");
		expect(mfRow?.value).toBe("2026-06-01");
	});

	it("an existing legacy row manually inserted with the fabricated subject='fact' is still found by factRecall", () => {
		const beam = trackedBeam();
		beam.db.run(
			`INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, confidence)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				"legacy-fact-1",
				beam.sessionId,
				"fact",
				"entity",
				"legacy flat statement about widgets",
				"2026-01-01T00:00:00.000Z",
				0.8,
			],
		);

		const results = factRecall(beam, "widgets", 5);
		expect(results).toHaveLength(1);
		expect(results[0]?.fact_id).toBe("legacy-fact-1");
		expect(results[0]?.content).toBe("legacy flat statement about widgets");
	});

	it("distinct flat facts sharing one source memory id stay independently recallable, not collapsed", () => {
		const beam = trackedBeam();
		const facts = [
			"redis cluster runs on port 6379",
			"api-server depends on redis for session storage",
			"redis eviction policy is allkeys-lru",
			"redis maxmemory is set to 4gb",
			"redis persistence uses append-only file",
			"worker queues are backed by redis streams",
			"redis sentinel handles failover",
			"cache invalidation publishes to redis pubsub",
		];
		storeFactStrings(beam, facts, 0, "repro-source");

		const results = factRecall(beam, "redis", 20);
		expect(results.map(result => result.content).toSorted()).toEqual(facts.toSorted());
		expect(new Set(results.map(result => result.id)).size).toBe(8);
	});

	it("scores flat facts by BM25 relevance, not a constant importance", () => {
		const beam = trackedBeam();
		// All stored with the SAME importance, so any score variation must come from relevance.
		storeFactStrings(
			beam,
			[
				"redis redis redis cluster cache eviction policy tuning",
				"redis cluster runs on port 6379",
				"the deployment runbook mentions redis once",
				"an unrelated note about postgres vacuum settings",
			],
			0,
			"score-source",
			0.7,
		);

		const results = factRecall(beam, "redis cluster cache", 20);
		const memoria = results.filter(result => result.source === "memoria_facts");
		expect(memoria.length).toBeGreaterThan(1);

		// Previously every flat fact scored exactly `importance` (0.7), discarding the BM25
		// rank the query already computes — a perfect match ranked identically to a weak one.
		const scores = memoria.map(result => result.score ?? 0);
		expect(new Set(scores.map(score => score.toFixed(4))).size).toBeGreaterThan(1);
		// Best hit keeps the full importance-derived score, so nothing regresses at the top.
		expect(Math.max(...scores)).toBeCloseTo(0.7, 5);
		// Importance floors the score, so the weakest hit is never filtered out by `score > 0`.
		expect(Math.min(...scores)).toBeGreaterThan(0.7 * 0.8 - 1e-9);
		// The strongest lexical match must outrank the incidental one-mention row.
		const best = memoria.reduce((a, b) => ((a.score ?? 0) >= (b.score ?? 0) ? a : b));
		expect(best.content).toContain("eviction policy tuning");
		// Relevance is exposed for debugging, not silently dropped.
		expect(best.voice_scores?.keyword).toBeGreaterThan(0);
	});
});
