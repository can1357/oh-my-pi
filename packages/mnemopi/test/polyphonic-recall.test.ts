import { afterEach, describe, expect, it } from "bun:test";
import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import {
	PolyphonicRecallEngine,
	polyphonicRecall,
	polyphonicRecallIsEnabled,
} from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

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

const previousPolyphonic = process.env.MNEMOPI_POLYPHONIC_RECALL;

afterEach(() => {
	if (previousPolyphonic === undefined) delete process.env.MNEMOPI_POLYPHONIC_RECALL;
	else process.env.MNEMOPI_POLYPHONIC_RECALL = previousPolyphonic;
	delete process.env.MNEMOPI_VOICE_VECTOR;
	delete process.env.MNEMOPI_VOICE_GRAPH;
	delete process.env.MNEMOPI_VOICE_FACT;
	delete process.env.MNEMOPI_VOICE_TEMPORAL;
});

describe("PolyphonicRecallEngine", () => {
	it("reads the polyphonic recall gate per call", () => {
		delete process.env.MNEMOPI_POLYPHONIC_RECALL;
		expect(polyphonicRecallIsEnabled()).toBe(false);
		process.env.MNEMOPI_POLYPHONIC_RECALL = "0";
		expect(polyphonicRecallIsEnabled()).toBe(false);
		process.env.MNEMOPI_POLYPHONIC_RECALL = "1";
		expect(polyphonicRecallIsEnabled()).toBe(true);
	});

	it("fuses the four voices with RRF and attributes voice scores per memory", () => {
		const beam = makeBeam();
		try {
			const engine = seedPolyphonicFixture(beam);
			const results = engine.recall("Alice recent", [1, 0], 10);
			// Final ordering is diversity-aware (MMR over content), so the contract is the
			// selected SET plus per-memory voice attribution, not a pure score ordering.
			expect(results.map(result => result.id).sort()).toEqual(["m1", "m2", "m3"]);
			const byId = new Map(results.map(result => [result.id, result]));
			// Weighted RRF: contribution is voiceWeights[voice] / (RRF_K + rank).
			expect(byId.get("m2")?.voice_scores).toEqual({ vector: 0.2 / 61, graph: 0.4 / 61 });
			expect(byId.get("m1")?.voice_scores).toEqual({ vector: 0.2 / 62, fact: 0.4 / 61 });
			expect(byId.get("m3")?.voice_scores).toEqual({ temporal: 0 / 61 });
			// MMR seeds from the highest-RRF candidate, so the top-scored memory still leads.
			expect(results[0]?.id).toBe("m2");
			expect(byId.get("m2")?.score).toBeGreaterThan(byId.get("m1")?.score ?? 0);
			expect(byId.get("m2")?.content).toContain("graph traversal");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("applies length normalization to the raw polyphonic pool before final diversity", () => {
		const beam = makeBeam();
		try {
			insertWorking(beam, "a-long", `quokka protocol ${"background ".repeat(500)}`);
			insertWorking(beam, "z-short", "quokka protocol concise answer");
			for (const id of ["a-long", "z-short"]) {
				beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
					id,
					JSON.stringify([1, 0]),
				]);
			}
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const recallWithMode = engine.recall.bind(engine) as unknown as (
				query: string,
				embedding: readonly number[],
				topK: number,
				options: { lengthNormalization: "none" | "log" | "bm25" },
			) => ReturnType<PolyphonicRecallEngine["recall"]>;

			const none = recallWithMode("quokka protocol", [1, 0], 2, { lengthNormalization: "none" });
			const log = recallWithMode("quokka protocol", [1, 0], 2, { lengthNormalization: "log" });
			const bm25 = recallWithMode("quokka protocol", [1, 0], 2, { lengthNormalization: "bm25" });

			expect(none[0]?.id).toBe("a-long");
			expect(log[0]?.id).toBe("z-short");
			expect(bm25[0]?.id).toBe("z-short");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("can abstain before diversity when every fused score is below the floor", () => {
		const beam = makeBeam();
		try {
			insertWorking(beam, "weak", "quokka protocol incidental note");
			beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES ('weak','[1,0]','test')");
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const recallWithFloor = engine.recall.bind(engine) as unknown as (
				query: string,
				embedding: readonly number[],
				topK: number,
				options: { scoreFloor: number },
			) => ReturnType<PolyphonicRecallEngine["recall"]>;

			expect(recallWithFloor("quokka protocol", [1, 0], 8, { scoreFloor: 1 })).toEqual([]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("pool floor cleans the MMR pool without changing the returned count", () => {
		const beam = makeBeam();
		try {
			// Three vector-only candidates at deterministic cosine ranks 1..3. Weighted RRF
			// fused scores: .2/61 = .0032787, .2/62 = .0032258, .2/63 = .0031746.
			// rank2 is a near-duplicate of rank1 (high content Jaccard); rank3 is lexically
			// disjoint, so at topK=2 MMR prefers rank3's diversity over rank2's relevance —
			// which is exactly the "weak row crowds selection" effect the knob removes.
			insertWorking(beam, "rank1", "quokka protocol primary answer alpha beta gamma");
			insertWorking(beam, "rank2", "quokka protocol primary answer alpha beta delta");
			insertWorking(beam, "rank3", "quokka zulu yankee xray whiskey victor uniform");
			const embeddings: Record<string, readonly number[]> = {
				rank1: [1, 0],
				rank2: [0.98, 0.19899748],
				rank3: [0.9, 0.43588989],
			};
			for (const [id, embedding] of Object.entries(embeddings)) {
				beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
					id,
					JSON.stringify(embedding),
				]);
			}
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const recall = engine.recall.bind(engine) as unknown as (
				query: string,
				embedding: readonly number[],
				topK: number,
				options: { poolFloor?: number; scoreFloor?: number },
			) => ReturnType<PolyphonicRecallEngine["recall"]>;
			const ids = (rows: ReturnType<PolyphonicRecallEngine["recall"]>) => rows.map(row => row.id);
			// A floor between rank2 (.0032258) and rank3 (.0031746).
			const FLOOR = 0.0032;

			// Inert by default: absent and 0 are byte-identical to each other.
			const bare = recall("quokka protocol", [1, 0], 8, {});
			expect(ids(recall("quokka protocol", [1, 0], 8, { poolFloor: 0 }))).toEqual(ids(bare));
			expect(bare.length).toBe(3);

			// COUNT INVARIANCE with partial survivors: only rank1+rank2 clear the floor, but the
			// baseline returns 3, so the cleaned result must also return 3 — the below-floor row
			// comes back as FILLER, appended after selection, never ahead of a kept row.
			const partial = recall("quokka protocol", [1, 0], 8, { poolFloor: FLOOR });
			expect(partial.length).toBe(bare.length);
			expect(ids(partial).slice(0, 2).sort()).toEqual(["rank1", "rank2"]);
			expect(ids(partial)[2]).toBe("rank3");

			// CLEANING CHANGES SELECTION, NOT COUNT: at topK=2 the baseline trades rank2's
			// relevance for rank3's diversity; cleaning keeps rank3 out of the MMR pool entirely,
			// so the same number of rows comes back with a different second slot.
			const baselineTop2 = recall("quokka protocol", [1, 0], 2, {});
			const cleanedTop2 = recall("quokka protocol", [1, 0], 2, { poolFloor: FLOOR });
			expect(cleanedTop2.length).toBe(baselineTop2.length);
			expect(ids(baselineTop2)).toEqual(["rank1", "rank3"]);
			expect(ids(cleanedTop2)).toEqual(["rank1", "rank2"]);

			// ALL BELOW FLOOR: falls back to the baseline result byte-identically (contrast
			// scoreFloor, which abstains and returns nothing).
			expect(ids(recall("quokka protocol", [1, 0], 8, { poolFloor: 1 }))).toEqual(ids(bare));
			expect(recall("quokka protocol", [1, 0], 8, { scoreFloor: 1 })).toEqual([]);

			// poolFloor never rescues rows scoreFloor excluded: abstention still governs count.
			expect(recall("quokka protocol", [1, 0], 8, { scoreFloor: 1, poolFloor: FLOOR })).toEqual([]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("returns a full topK when a single voice nominates every candidate", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			// Twelve distinct memories reachable only through the vector voice. Diversity is
			// judged on content, so these must not be treated as duplicates of one another.
			// The previous rule compared voice-MEMBERSHIP sets, giving every pair a Jaccard of
			// 1.0 and collapsing the whole result set to a single row.
			for (let index = 0; index < 12; index++) {
				const id = `v${index}`;
				insertWorking(beam, id, `Distinct subject ${index} with its own unrelated wording ${index}`);
				beam.db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
					id,
					JSON.stringify([1, index / 100]),
				]);
			}
			const results = engine.recall("unrelated wording", [1, 0], 8);
			expect(results).toHaveLength(8);
			expect(new Set(results.map(result => result.id)).size).toBe(8);
			for (const result of results) {
				expect(result.voice_scores).toHaveProperty("vector");
			}
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("builds a subject dictionary that excludes writer placeholders", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			const now = new Date().toISOString();
			insertWorking(beam, "dm1", "Bash tool notes");
			for (const [factId, subject, object] of [
				["f_placeholder", "fact", "a flat statement stored with a placeholder subject"],
				["f_version", "version", "1.2.3"],
				["f_real", "Bash tool", "only affects that subprocess"],
				["f_caps", "CLI", "manages banks"],
			]) {
				beam.db.run(
					`INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence)
						VALUES (?, ?, ?, 'is', ?, ?, 'dm1', 0.8)`,
					[factId ?? "", beam.sessionId, subject ?? "", object ?? "", now],
				);
			}
			const dictionary = engine.subjectDictionary().map(entry => entry.toLowerCase());
			// `fact`/`version` are field labels from the writer, not entities. Admitting `fact`
			// would let any query containing that common word seed every flat row.
			expect(dictionary).not.toContain("fact");
			expect(dictionary).not.toContain("version");
			expect(dictionary).toContain("bash tool");
			expect(dictionary).toContain("cli");
			// Both of these are unreachable for a proper-case-run regex: `Bash tool` has a
			// lowercase second word and `CLI` has no lowercase letters at all.
			expect(engine.matchStoredSubjects("what does the Bash tool do in the CLI?").sort()).toEqual([
				"Bash tool",
				"CLI",
			]);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("recalls flat placeholder facts through object text", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(beam, "om1", "Full-page screenshots are required for visual QA");
			beam.db.run(
				`INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence)
					VALUES ('f_flat', ?, 'fact', 'entity', 'capture a full-page screenshot rather than a fixed viewport', ?, 'om1', 0.7)`,
				[beam.sessionId, new Date().toISOString()],
			);
			const results = engine.factVoice("which screenshot should I capture?");
			expect(results.map(result => result.memoryId)).toContain("om1");
			expect(results.every(result => result.voice === "fact")).toBe(true);
			// A silent SQL failure here would be indistinguishable from "no matches".
			expect(engine.getStats().fact_object_error).toBeNull();
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("seeds the graph voice from a fact's source memory, not its fact id", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(beam, "fm1", "Alice maintains the release runbook");
			// Real stored fact ids look like `fact_<memoryId>_<index>`; the memory id lives in
			// `source_msg_id`. Taking the last underscore segment yields the index ("0").
			beam.db.run(
				`INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence)
					VALUES ('fact_fm1_0', ?, 'Alice', 'maintains', 'release runbook', ?, 'fm1', 0.9)`,
				[beam.sessionId, new Date().toISOString()],
			);
			const candidates = engine.graphVoice("Alice");
			expect(candidates.map(candidate => candidate.memoryId)).toContain("fm1");
			expect(candidates.map(candidate => candidate.memoryId)).not.toContain("0");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("normalizes gist nodes reached by ctx traversal to their memory id", () => {
		const beam = makeBeam();
		try {
			const engine = new PolyphonicRecallEngine({
				db: beam.db,
				sessionId: beam.sessionId,
				channelId: beam.channelId,
			});
			insertWorking(beam, "gm1", "Alice opened the incident review");
			insertWorking(beam, "gm2", "Follow-up actions from the incident review");
			const timestamp = new Date().toISOString();
			beam.db.run(
				`INSERT INTO gists (id, text, timestamp, participants_json, memory_id)
					VALUES ('gist_gm1', 'Alice incident gist', ?, ?, 'gm1')`,
				[timestamp, JSON.stringify(["Alice"])],
			);
			// `ctx` edges hop through the gist node, so a depth-2 walk surfaces `gist_gm1`.
			for (const [source, target] of [
				["gm1", "gist_gm1"],
				["gist_gm1", "gm2"],
			]) {
				beam.db.run(
					"INSERT INTO graph_edges (source, target, edge_type, weight, timestamp) VALUES (?, ?, 'ctx', 1.0, ?)",
					[source ?? "", target ?? "", timestamp],
				);
			}
			const ids = engine.graphVoice("Alice").map(candidate => candidate.memoryId);
			expect(ids).toContain("gm2");
			expect(ids.some(id => id.startsWith("gist_"))).toBe(false);
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
			expect(results[0]?.voice_scores).toEqual({ fact: 0.4 / 61 });
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

	it("caches an engine on Beam state and hydrates result content", () => {
		const beam = makeBeam();
		try {
			seedPolyphonicFixture(beam).close();
			const first = polyphonicRecall(beam, "Alice", 5, { queryEmbedding: [1, 0] });
			const cached = beam.caches.polyphonicEngine;
			const second = polyphonicRecall(beam, "Alice", 5, { queryEmbedding: [1, 0] });
			expect(cached).toBeInstanceOf(PolyphonicRecallEngine);
			expect(beam.caches.polyphonicEngine).toBe(cached);
			expect(first[0]?.content).toBe(second[0]?.content);
			expect(first[0]?.voice_scores).toEqual(second[0]?.voice_scores);
		} finally {
			closeQuietly(beam.db);
		}
	});
});
