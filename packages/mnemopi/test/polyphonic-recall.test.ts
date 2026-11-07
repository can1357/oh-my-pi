import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { PolyphonicRecallEngine, polyphonicRecall } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, onDatabaseClose, openDatabase } from "@oh-my-pi/pi-mnemopi/db";
import { currentLoopPhase } from "@oh-my-pi/pi-utils";

function makeBeam(): BeamMemoryState {
	const db = openDatabase(":memory:", { create: true, readwrite: true });
	initBeam(db);
	return {
		db,
		sessionId: "test-session",
		authorId: null,
		authorType: null,
		channelId: "test-session",
		useCloud: false,
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
function insertWorking(
	beam: BeamMemoryState,
	id: string,
	content: string,
	importance = 0.7,
	timestamp = new Date().toISOString(),
	sessionId = beam.sessionId,
	scope = "global",
): void {
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, created_at)
			VALUES (?, ?, 'test', ?, ?, ?, '{}', 'unknown', 'unknown', ?, ?)`,
		[id, content, timestamp, sessionId, importance, scope, timestamp],
	);
}
function seedPolyphonicFixture(beam: BeamMemoryState): PolyphonicRecallEngine {
	const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId, channelId: beam.channelId });
	const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
	insertWorking(beam, "m1", "Alice owns the durable launch checklist", 0.8, old);
	insertWorking(beam, "m2", "Alice linked the graph traversal plan", 0.7, old);
	insertWorking(beam, "m3", "Recent operational note for this week", 0.6);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m1",
		JSON.stringify([0.8, 0.2]),
	]);
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m2",
		JSON.stringify([1, 0]),
	]);
	beam.db.run(
		`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
			VALUES ('gist_m2', 'Alice graph gist', ?, ?, 'm2')`,
		[new Date().toISOString(), JSON.stringify(["Alice"])],
	);
	beam.db.run(
		`INSERT INTO consolidated_facts
			(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
			VALUES ('cf_alice_owns', 'Alice', 'owns', 'durable launch checklist', 0.9, 2, ?, ?, ?, 'likely_true')`,
		[new Date().toISOString(), new Date().toISOString(), JSON.stringify(["m1"])],
	);
	return engine;
}

afterEach(() => {
	delete process.env.MNEMOPI_VOICE_VECTOR;
	delete process.env.MNEMOPI_VOICE_GRAPH;
	delete process.env.MNEMOPI_VOICE_FACT;
	delete process.env.MNEMOPI_VOICE_TEMPORAL;
});

describe("PolyphonicRecallEngine", () => {
	it("fuses the four voices with RRF and preserves voice attribution order", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			const results = engine.recall("Alice recent", [1, 0], 10);
			expect(results.map(result => result.id)).toEqual(["m2", "m1", "m3"]);
			expect(results[0]?.voice_scores).toEqual({ vector: 1 / 61, graph: 1 / 61 });
			expect(results[1]?.voice_scores).toEqual({ vector: 1 / 62, fact: 1 / 61 });
			expect(results[2]?.voice_scores).toEqual({ temporal: 1 / 61 });
			expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
			expect(results[0]?.content).toContain("graph traversal");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("reports its synchronous fan-out and fusion to the loop watchdog as mnemopi.recall", () => {
		const beam = makeBeam();
		try {
			seedPolyphonicFixture(beam);
			const recall = PolyphonicRecallEngine.prototype.recall;
			const phases: (string | undefined)[] = [];
			const spy = spyOn(PolyphonicRecallEngine.prototype, "recall").mockImplementation(function (
				this: PolyphonicRecallEngine,
				...args
			) {
				phases.push(currentLoopPhase());
				return recall.apply(this, args);
			});
			try {
				polyphonicRecall(beam, "Alice recent", 10, { queryEmbedding: [1, 0] });

				expect(phases.length).toBeGreaterThan(0);
				expect(phases.every(phase => phase === "mnemopi.recall")).toBe(true);
				expect(currentLoopPhase()).toBeUndefined();
			} finally {
				spy.mockRestore();
			}
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("honors per-voice gates without producing fake-success results", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";
			const results = engine.recall("Alice recent", [1, 0], 10);
			expect(results.map(result => result.id)).toEqual(["m1"]);
			expect(results[0]?.voice_scores).toEqual({ fact: 1 / 61 });
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("does not let a query stopword match a stopword fact subject", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			insertWorking(beam, "m-junk", "That is approximately one CSS pixel at the default zoom level");
			const timestamp = new Date().toISOString();
			// Shape the regex extractor stores for "That is ..." sentences.
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf_that', 'That', 'related_to', 'approximately one CSS pixel', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["m-junk"])],
			);

			expect(engine.factVoice("the checklist that Alice owns").map(result => result.memoryId)).toEqual(["m1"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("filters vector and temporal voices to beam-session or global memories", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			insertWorking(
				beam,
				"wm-private-b",
				"Other session private vector marker",
				0.9,
				timestamp,
				"session-b",
				"session",
			);
			insertWorking(
				beam,
				"wm-global-b",
				"Other session global vector marker",
				0.8,
				timestamp,
				"session-b",
				"global",
			);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-private-b",
				JSON.stringify([1, 0]),
			]);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-global-b",
				JSON.stringify([1, 0]),
			]);
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_FACT = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const vectorResults = polyphonicRecall(beam, "vector marker", 5, { queryEmbedding: [1, 0] });

			expect(vectorResults.map(result => result.id)).toEqual(["wm-global-b"]);

			process.env.MNEMOPI_VOICE_VECTOR = "0";
			delete process.env.MNEMOPI_VOICE_TEMPORAL;

			const temporalResults = polyphonicRecall(beam, "recent vector marker", 5);

			expect(temporalResults.map(result => result.id)).toEqual(["wm-global-b"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("hydrates fact voice source memories through the session/global visibility filter", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(
				beam,
				"wm-private-fact",
				"Alice private source from another session",
				0.9,
				timestamp,
				"session-b",
				"session",
			);
			insertWorking(
				beam,
				"wm-global-fact",
				"Alice global source from another session",
				0.8,
				timestamp,
				"session-b",
				"global",
			);
			beam.db.run(
				`INSERT INTO consolidated_facts
					(id, subject, predicate, object, confidence, mention_count, first_seen, last_seen, sources_json, veracity)
					VALUES ('cf_alice_visibility', 'Alice', 'owns', 'visibility fixture', 0.9, 2, ?, ?, ?, 'likely_true')`,
				[timestamp, timestamp, JSON.stringify(["wm-private-fact", "wm-global-fact"])],
			);
			process.env.MNEMOPI_VOICE_VECTOR = "0";
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const results = engine.recall("Alice", null, 5);

			expect(results.map(result => result.id)).toEqual(["wm-global-fact"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("re-scores updated memory_embeddings rows when an embedding changes in place", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(beam, "wm-mutable", "Mutable vector memory", 0.9, timestamp, beam.sessionId, "session");
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-mutable",
				JSON.stringify([1, 0]),
			]);

			expect(engine.vectorVoice([1, 0]).map(hit => hit.memoryId)).toEqual(["wm-mutable"]);

			// Rewrite the stored embedding to an orthogonal vector; the stale cached entry must be replaced.
			beam.db.run("UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?", [
				JSON.stringify([0, 1]),
				"wm-mutable",
			]);
			expect(engine.vectorVoice([1, 0])).toEqual([]);
			expect(engine.vectorVoice([0, 1]).map(hit => hit.memoryId)).toEqual(["wm-mutable"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("isolates and recalls accurately across engines sharing a database with different sessionIds", () => {
		const beam = makeBeam();
		try {
			const timestamp = new Date().toISOString();
			const engineA = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: "session-a",
				channelId: beam.channelId,
			});
			const engineB = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: "session-b",
				channelId: beam.channelId,
			});

			// session-a private memory
			insertWorking(beam, "wm-session-a", "Session A memory", 0.9, timestamp, "session-a", "session");
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-session-a",
				JSON.stringify([1, 0]),
			]);

			// session-b private memory
			insertWorking(beam, "wm-session-b", "Session B memory", 0.9, timestamp, "session-b", "session");
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-session-b",
				JSON.stringify([0, 1]),
			]);

			// global shared memory
			insertWorking(beam, "wm-global-shared", "Global shared memory", 0.9, timestamp, "session-a", "global");
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-global-shared",
				JSON.stringify([0.7071, 0.7071]),
			]);

			// Cold then warm calls across both engines sharing the database and underlying cache
			for (let i = 0; i < 2; i++) {
				const aHits = engineA.vectorVoice([1, 0]).map(h => h.memoryId);
				expect(aHits).toContain("wm-session-a");
				expect(aHits).toContain("wm-global-shared");
				expect(aHits).not.toContain("wm-session-b");

				const bHits = engineB.vectorVoice([0, 1]).map(h => h.memoryId);
				expect(bHits).toContain("wm-session-b");
				expect(bHits).toContain("wm-global-shared");
				expect(bHits).not.toContain("wm-session-a");
			}
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("clears embedding cache when a caller-owned Database is closed directly via db.close()", () => {
		const beam = makeBeam();
		const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId, channelId: beam.channelId });
		insertWorking(beam, "wm-direct-close", "Direct close test memory", 0.9);
		const embeddingJson = JSON.stringify([1, 0]);
		beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
			"wm-direct-close",
			embeddingJson,
		]);

		let directCloseCount = 0;
		onDatabaseClose(beam.db, () => {
			directCloseCount += 1;
		});

		// Cold call parses JSON and warms the embedding cache for this db instance
		const parseSpy = spyOn(JSON, "parse");
		try {
			parseSpy.mockClear();
			const hits = engine.vectorVoice([1, 0]).map(h => h.memoryId);
			expect(hits).toContain("wm-direct-close");
			expect(parseSpy).toHaveBeenCalledTimes(1);

			// Warm call should hit cache without parsing JSON again
			parseSpy.mockClear();
			const warmHits = engine.vectorVoice([1, 0]).map(h => h.memoryId);
			expect(warmHits).toContain("wm-direct-close");
			expect(parseSpy).toHaveBeenCalledTimes(0);

			// Direct close without closeQuietly
			beam.db.close();
			expect(directCloseCount).toBe(1);

			// Calling close again or closeQuietly is safe and callbacks are already drained
			expect(() => closeQuietly(beam.db)).not.toThrow();
			expect(directCloseCount).toBe(1);

			// Stub db.query on the closed database object to return the same row
			beam.db.query = (() => ({
				all: () => [
					{
						memory_id: "wm-direct-close",
						embedding_json: embeddingJson,
						embedding_tier: "working",
					},
				],
			})) as unknown as typeof beam.db.query;

			// Because db.close() cleared the DB-scoped embedding cache, vectorVoice must parse JSON again
			parseSpy.mockClear();
			const postCloseHits = engine.vectorVoice([1, 0]).map(h => h.memoryId);
			expect(postCloseHits).toContain("wm-direct-close");
			expect(parseSpy).toHaveBeenCalledTimes(1);
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("discards all-zero and non-numeric embeddings without allocating or caching them", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(beam, "wm-zero", "Zero vector memory", 0.9);
			insertWorking(beam, "wm-nan", "Non-numeric vector memory", 0.9);
			insertWorking(beam, "wm-valid", "Valid vector memory", 0.9);

			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-zero",
				JSON.stringify([0, 0]),
			]);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-nan",
				JSON.stringify([1, "not-a-number"]),
			]);
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
				"wm-valid",
				JSON.stringify([1, 0]),
			]);

			const origFloat64Array = globalThis.Float64Array;
			let float64ArrayAllocations = 0;
			const float64Proxy = new Proxy(origFloat64Array, {
				construct(target, args, newTarget) {
					float64ArrayAllocations++;
					return Reflect.construct(target, args, newTarget);
				},
			});
			globalThis.Float64Array = float64Proxy;

			const parseSpy = spyOn(JSON, "parse");
			try {
				const hits = engine.vectorVoice([1, 0]);
				const hitIds = hits.map(h => h.memoryId);
				expect(hitIds).toEqual(["wm-valid"]);
				expect(hitIds).not.toContain("wm-zero");
				expect(hitIds).not.toContain("wm-nan");

				// Only wm-valid should have allocated a Float64Array for cache admission
				expect(float64ArrayAllocations).toBe(1);

				// Second call: wm-valid should hit the cache, while wm-zero and wm-nan are still parsed on scan
				// without allocating Float64Array
				parseSpy.mockClear();
				const warmHits = engine.vectorVoice([1, 0]);
				expect(warmHits.map(h => h.memoryId)).toEqual(["wm-valid"]);
				// wm-valid is cached so not parsed; wm-zero and wm-nan are parsed again because they were not admitted to cache
				expect(parseSpy).toHaveBeenCalledTimes(2);
				expect(float64ArrayAllocations).toBe(1);
			} finally {
				globalThis.Float64Array = origFloat64Array;
				parseSpy.mockRestore();
			}
		} finally {
			closeQuietly(beam.db);
		}
	});
});
