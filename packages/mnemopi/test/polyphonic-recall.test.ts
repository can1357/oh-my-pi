import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { PolyphonicRecallEngine, polyphonicRecall } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";
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
function setVeracity(beam: BeamMemoryState, id: string, veracity: string): void {
	beam.db.run("UPDATE working_memory SET veracity = ? WHERE id = ?", [veracity, id]);
}
function insertEpisodic(beam: BeamMemoryState, id: string, content: string, tier: number): void {
	beam.db.run(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, veracity, tier) VALUES (?, ?, 'test', ?, ?, 0.5, 'stated', ?)",
		[id, content, new Date().toISOString(), beam.sessionId, tier],
	);
}
function embed(beam: BeamMemoryState, id: string, vector: readonly number[]): void {
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		id,
		JSON.stringify(vector),
	]);
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
	// The temporal voice only re-ranks memories another voice surfaced, so m3 needs a (weak) vector hit.
	beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		"m3",
		JSON.stringify([0.7, 0.71]),
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

const ORIGINAL_TRUST_ENV = {
	MNEMOPI_TOOL_WEIGHT: process.env.MNEMOPI_TOOL_WEIGHT,
	MNEMOPI_TIER3_WEIGHT: process.env.MNEMOPI_TIER3_WEIGHT,
};

afterEach(() => {
	delete process.env.MNEMOPI_VOICE_VECTOR;
	delete process.env.MNEMOPI_VOICE_GRAPH;
	delete process.env.MNEMOPI_VOICE_FACT;
	delete process.env.MNEMOPI_VOICE_TEMPORAL;
	for (const key in ORIGINAL_TRUST_ENV) {
		const value = ORIGINAL_TRUST_ENV[key as keyof typeof ORIGINAL_TRUST_ENV];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
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
			expect(results[2]?.voice_scores).toEqual({ vector: 1 / 63, temporal: 1 / 61 });
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

			delete process.env.MNEMOPI_VOICE_TEMPORAL;
			const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId });
			const temporalResults = engine.temporalVoice("recent vector marker", new Set(["wm-private-b", "wm-global-b"]));

			expect(temporalResults.map(result => result.memoryId)).toEqual(["wm-global-b"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("treats only whole time words as a temporal query", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId });
			insertWorking(beam, "m-fresh", "Fresh note about the deploy");
			const surfaced = new Set(["m-fresh"]);

			for (const query of ["fix the blast radius", "the Chicago office"]) {
				expect(engine.temporalVoice(query, surfaced)).toEqual([]);
			}
			expect(engine.temporalVoice("what changed last week", surfaced).map(result => result.memoryId)).toEqual([
				"m-fresh",
			]);
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

	it("omits a false-veracity memory however it was reached, with or without a linear baseline", async () => {
		// m1 arrives via vector+fact, m2 via vector+graph, m3 via vector+temporal: each voice route is covered.
		for (const target of ["m1", "m2", "m3"]) {
			const beam = makeBeam();
			try {
				const engine = seedPolyphonicFixture(beam);
				const linear = await recall(beam, "Alice recent", 10, { queryEmbedding: null });
				expect(linear.map(row => row.id)).toContain(target);
				expect(
					engine
						.recall("Alice recent", [1, 0], 10)
						.map(result => result.id)
						.toSorted(),
				).toEqual(["m1", "m2", "m3"]);

				setVeracity(beam, target, "false");
				// A baseline ranked before the row was relabelled still carries the row, now stored as false.
				const staleBaseline = linear.map(row => (row.id === target ? { ...row, veracity: "stated" } : row));
				const eligible = ["m1", "m2", "m3"].filter(id => id !== target);
				for (const options of [{}, { baseline: staleBaseline }]) {
					const ids = engine.recall("Alice recent", [1, 0], 10, 4000, options).map(result => result.id);
					expect(ids).not.toContain(target);
					expect(ids.toSorted()).toEqual(eligible);
				}
			} finally {
				closeQuietly(beam.db);
			}
		}
	});

	it("omits zero-weight facts supplied in a caller's hybrid baseline", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId });
			const results = engine.recall("opaque fact lookup", null, 5, 4000, {
				includeFacts: true,
				baseline: [
					{ id: "bad-fact", content: "untrusted claim", score: 1, tier_label: "fact", veracity: "false" },
					{ id: "good-fact", content: "eligible claim", score: 0.5, tier_label: "fact", veracity: "stated" },
				],
			});
			expect(results.map(result => result.id)).toEqual(["good-fact"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("omits a memory whose veracity weight override is 0 without reweighting nonzero fusion", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			setVeracity(beam, "m1", "tool");
			// Default tool weight is nonzero: the row stays and fusion order is the unweighted RRF order.
			expect(engine.recall("Alice recent", [1, 0], 10).map(result => result.id)).toEqual(["m2", "m1", "m3"]);

			process.env.MNEMOPI_TOOL_WEIGHT = "0";
			expect(engine.recall("Alice recent", [1, 0], 10).map(result => result.id)).toEqual(["m2", "m3"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("omits an episodic memory whose degradation tier weight is 0", () => {
		const beam = makeBeam();
		try {
			insertEpisodic(beam, "ep-t1", "harbor crane manifest alpha", 1);
			insertEpisodic(beam, "ep-t3", "harbor crane manifest bravo", 3);
			embed(beam, "ep-t1", [1, 0]);
			embed(beam, "ep-t3", [1, 0]);
			const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId });
			expect(engine.recall("harbor crane", [1, 0], 10).map(result => result.id)).toEqual(["ep-t1", "ep-t3"]);

			process.env.MNEMOPI_TIER3_WEIGHT = "0";
			expect(engine.recall("harbor crane", [1, 0], 10).map(result => result.id)).toEqual(["ep-t1"]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("keeps distinct memories whose content differs by one hostname or is identical", () => {
		const beam = makeBeam();
		try {
			const hostPair = (host: string): string =>
				`Rotate the production database credentials on host ${host}.example.com before the quarterly audit window closes, then alert owners and confirm the rollback checklist with security review`;
			const candidate = (letter: string): string =>
				`Release candidate ${letter} passes the full regression suite on staging with zero flaky failures across every shard today`;
			const same = "Identical preview content shared by two distinct memories that must both stay recallable";
			const rows: [string, string][] = [
				["host-1", hostPair("db1")],
				["host-2", hostPair("db2")],
				["cand-a", candidate("A")],
				["cand-b", candidate("B")],
				["same-1", same],
				["same-2", same],
			];
			for (const [id, content] of rows) {
				insertWorking(beam, id, content);
				embed(beam, id, [1, 0]);
			}
			process.env.MNEMOPI_VOICE_GRAPH = "0";
			process.env.MNEMOPI_VOICE_FACT = "0";
			process.env.MNEMOPI_VOICE_TEMPORAL = "0";

			const results = polyphonicRecall(beam, "database credentials", 10, { queryEmbedding: [1, 0] });

			expect(results.map(result => result.id).toSorted()).toEqual(rows.map(([id]) => id).toSorted());
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("returns one result for a memory repeated across voices and baseline entries", async () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			const linear = await recall(beam, "Alice recent", 10, { queryEmbedding: null });
			const baseline = [...linear, ...linear];

			const ids = engine.recall("Alice recent", [1, 0], 10, 4000, { baseline }).map(result => result.id);

			expect(ids.toSorted()).toEqual(["m1", "m2", "m3"]);
		} finally {
			closeQuietly(beam.db);
		}
	});
});
