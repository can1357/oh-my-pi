/**
 * Regression: dense recall must only score vectors stamped with the active
 * embedding model. `reconcileEmbeddingModel` deliberately retains stale-model
 * vectors on disk while a rebuild runs (or after a failed batch), so recall —
 * both the linear `vectorSimilarities` path and the polyphonic vector voice —
 * has to exclude them itself. Otherwise a query embedded under the new model is
 * compared against vectors from a different model, producing meaningless
 * similarity scores (and, across a dimension change, zero-padded cosine).
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { currentEmbeddingModel } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { PolyphonicRecallEngine } from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const OLD_MODEL = "BAAI/bge-small-en-v1.5";
const NEW_MODEL = "intfloat/multilingual-e5-large";
const ACTIVE_MODEL = currentEmbeddingModel();

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

function insertWorking(beam: BeamMemoryState, id: string, content: string): void {
	const timestamp = new Date().toISOString();
	beam.db.run(
		`INSERT INTO working_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, memory_type, scope, created_at)
			VALUES (?, ?, 'test', ?, ?, 0.7, '{}', 'unknown', 'unknown', 'global', ?)`,
		[id, content, timestamp, beam.sessionId, timestamp],
	);
}

function seedEmbedding(db: Database, memoryId: string, model: string, vector: readonly number[]): void {
	db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)", [
		memoryId,
		JSON.stringify(vector),
		model,
	]);
}

describe("stale-model vectors are excluded from dense recall", () => {
	it("linear recall scores only embeddings stamped with the active model", async () => {
		const beam = makeBeam();
		try {
			insertWorking(beam, "fresh", "alpha checklist note");
			insertWorking(beam, "stale", "alpha checklist note from the old model");
			// Identical vectors: without the model filter both would score cosine 1.
			seedEmbedding(beam.db, "fresh", ACTIVE_MODEL, [1, 0]);
			seedEmbedding(beam.db, "stale", "some-other-model", [1, 0]);

			const results = await recall(beam, "alpha checklist", 5, {
				queryEmbedding: [1, 0],
				queryTime: new Date().toISOString(),
				updateRecallCounts: false,
			});

			const byId = new Map(results.map(result => [result.id, result]));
			expect(byId.get("fresh")?.dense_score ?? 0).toBeGreaterThan(0);
			// The stale-model row still surfaces through FTS but contributes no dense score.
			const stale = byId.get("stale");
			expect(stale).toBeDefined();
			expect(stale?.dense_score ?? 0).toBe(0);
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("polyphonic vector voice ignores embeddings stamped with a different model", () => {
		const beam = makeBeam();
		try {
			insertWorking(beam, "fresh", "alpha checklist note");
			insertWorking(beam, "stale", "alpha checklist note from the old model");
			seedEmbedding(beam.db, "fresh", ACTIVE_MODEL, [1, 0]);
			seedEmbedding(beam.db, "stale", "some-other-model", [1, 0]);
			const engine = new PolyphonicRecallEngine({ db: beam.db, sessionId: beam.sessionId });
			const results = engine.vectorVoice([1, 0]);
			const ids = results.map(result => result.memoryId);
			expect(ids).toContain("fresh");
			expect(ids).not.toContain("stale");
		} finally {
			closeQuietly(beam.db);
		}
	});

	it("recall during a failed model rebuild keeps stale vectors on disk but out of scoring", async () => {
		// Provider answers single-text embeds (query embedding succeeds) but fails
		// multi-text batches, so the corpus rebuild aborts and the old-model vectors
		// stay in memory_embeddings stamped OLD_MODEL.
		const batchFailing = async function* embed(texts: readonly string[]) {
			if (texts.length > 1) throw new Error("batch embed rejected");
			yield texts.map(() => [1, 0, 0, 0]);
		};
		const db = new Database(":memory:");
		initBeam(db);
		const ts = new Date().toISOString();
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("wm-1", "alpha launch checklist", ts);
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("wm-2", "beta migration notes", ts);
		seedEmbedding(db, "wm-1", OLD_MODEL, [1, 0, 0, 0]);
		seedEmbedding(db, "wm-2", OLD_MODEL, [0, 1, 0, 0]);

		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: batchFailing } });
		try {
			await memory.flushExtractions();
			// The failed rebuild must not have deleted the stale vector.
			const stored = memory.conn.query("SELECT model FROM memory_embeddings WHERE memory_id = 'wm-1'").get() as {
				model: string;
			};
			expect(stored.model).toBe(OLD_MODEL);

			const results = await memory.recall("alpha launch checklist", 5);
			const hit = results.find(result => result.id === "wm-1");
			expect(hit).toBeDefined();
			// The query vector ([1,0,0,0]) is identical to the stale stored vector, so
			// without the model filter this hit would score dense cosine 1. The dense
			// channel must stay closed while the rebuild is unfinished.
			expect(hit?.dense_score ?? 0).toBe(0);
		} finally {
			memory.close();
			db.close();
		}
	});
});
