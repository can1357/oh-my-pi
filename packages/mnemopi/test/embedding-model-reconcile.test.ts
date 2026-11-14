/**
 * Wipe-and-rebuild reconcile: each `memory_embeddings` row is stamped with the
 * model that produced it. When the configured embedding model changes the vector
 * dimension changes too, so on store open `reconcileEmbeddingModel` (wired into
 * the `Mnemopi` constructor) probes the new model, then embeds the whole corpus with it.
 * Only when every batch returns does it swap the stale vectors for the new ones in one
 * transaction. A provider that fails any request leaves the stale vectors in place.
 * A matching model is a no-op.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

const OLD_MODEL = "BAAI/bge-small-en-v1.5";
const NEW_MODEL = "intfloat/multilingual-e5-large";

// Deterministic fastembed-shaped provider so the background rebuild actually
// writes rows (and stamps them with the active model) under the test runtime.
function fakeEmbed() {
	return async function* embed(texts: readonly string[]) {
		yield texts.map(() => [0.1, 0.2, 0.3, 0.4]);
	};
}

function seedDb(model: string): { db: Database; ids: string[] } {
	const db = new Database(":memory:");
	initBeam(db);
	const ts = new Date().toISOString();
	db.prepare(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
	).run("wm-1", "alpha working memory", ts);
	db.prepare(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, binary_vector) VALUES (?, ?, 'test', ?, 'default', ?)",
	).run("ep-1", "beta episodic memory", ts, new Uint8Array([1, 2, 3, 4]));
	for (const id of ["wm-1", "ep-1"]) {
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			id,
			JSON.stringify([1, 0, 0, 0]),
			model,
		);
	}
	return { db, ids: ["wm-1", "ep-1"] };
}

function countEmbeddings(memory: Mnemopi): number {
	return (memory.conn.query("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number }).n;
}

describe("reconcileEmbeddingModel on store open", () => {
	it("wipes stale embeddings + binary vectors and re-embeds when the model changed", async () => {
		const { db, ids } = seedDb(OLD_MODEL);
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		try {
			// The constructor enqueues the migration: it probes the new provider, embeds the corpus,
			// then swaps the stale vectors and clears the episodic binary vector.
			expect(memory.beam.pendingExtractions.size).toBeGreaterThanOrEqual(1);
			await memory.flushExtractions();
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).toBeNull();

			// Every live memory is re-stamped with the new model.
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all() as {
				memory_id: string;
				model: string;
			}[];
			expect(rows.map(row => row.memory_id).sort()).toEqual([...ids].sort());
			expect(rows.every(row => row.model === NEW_MODEL)).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});

	it("preserves updated embeddings and skips deleted memories when a rebuild commits", async () => {
		const { db } = seedDb(OLD_MODEL);
		const ts = new Date().toISOString();
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("wm-deleted", "delete during rebuild", ts);
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			"wm-deleted",
			JSON.stringify([1, 0, 0, 0]),
			OLD_MODEL,
		);

		const oldContent = "alpha working memory";
		const updatedContent = "updated working memory";
		const updatedVector = [0, 1, 0, 0];
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		const provider = async function* (texts: readonly string[]) {
			if (texts.includes(oldContent)) {
				rebuildStarted.resolve();
				await releaseRebuild.promise;
			}
			yield texts.map(text => {
				if (text === oldContent) return [1, 0, 0, 0];
				if (text === updatedContent) return updatedVector;
				return [0, 0, 1, 0];
			});
		};
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider } });
		try {
			await rebuildStarted.promise;
			const pendingBeforeUpdate = new Set(memory.beam.pendingExtractions);
			expect(memory.update("wm-1", updatedContent)).toBe(true);
			expect(memory.forget("wm-deleted")).toBe(true);
			const updateEmbedding = [...memory.beam.pendingExtractions].find(task => !pendingBeforeUpdate.has(task));
			expect(updateEmbedding).toBeDefined();
			await updateEmbedding;

			releaseRebuild.resolve();
			await memory.flushExtractions();

			const results = await memory.recall("unrelated lexical query", 5, {
				queryEmbedding: updatedVector,
				vecWeight: 1,
				ftsWeight: 0,
				importanceWeight: 0,
			});
			const updated = results.find(result => result.id === "wm-1");
			expect(updated?.content).toBe(updatedContent);
			expect(updated?.dense_score).toBe(1);
			expect(memory.conn.query("SELECT 1 FROM memory_embeddings WHERE memory_id = 'wm-deleted'").get()).toBeNull();
		} finally {
			releaseRebuild.resolve();
			await memory.flushExtractions();
			memory.close();
			db.close();
		}
	});

	it("keeps stale embeddings when the new provider does not answer", async () => {
		const { db } = seedDb(OLD_MODEL);
		const down = async function* (_texts: readonly string[]): AsyncGenerator<number[][]> {
			yield* [];
			throw new Error("provider down");
		};
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: down } });
		try {
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT model FROM memory_embeddings").all() as { model: string }[];
			expect(rows).toHaveLength(2);
			expect(rows.every(row => row.model === OLD_MODEL)).toBe(true);
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
		} finally {
			memory.close();
			db.close();
		}
	});

	it("leaves embeddings untouched when the stored model already matches", () => {
		const { db } = seedDb(NEW_MODEL);
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		try {
			// No mismatch -> no wipe, no rebuild enqueued.
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
			// The no-op path must preserve the episodic binary vector too (regression
			// guard against an unconditional clear that would silently drop vectors).
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
			expect(Array.from(ep.v as Uint8Array)).toEqual([1, 2, 3, 4]);
		} finally {
			memory.close();
			db.close();
		}
	});

	it("does not wipe when embeddings are disabled via the MNEMOPI_NO_EMBEDDINGS env", () => {
		const { db } = seedDb(OLD_MODEL);
		const previous = process.env.MNEMOPI_NO_EMBEDDINGS;
		process.env.MNEMOPI_NO_EMBEDDINGS = "1";
		let memory: Mnemopi | undefined;
		try {
			// The model differs, but with embeddings disabled the rebuild would
			// produce nothing — so the stale-but-present vectors must survive.
			memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
		} finally {
			if (previous === undefined) {
				delete process.env.MNEMOPI_NO_EMBEDDINGS;
			} else {
				process.env.MNEMOPI_NO_EMBEDDINGS = previous;
			}
			memory?.close();
			db.close();
		}
	});

	it("does not wipe when the active embedding model is empty", () => {
		const { db } = seedDb(OLD_MODEL);
		let memory: Mnemopi | undefined;
		try {
			// An explicit empty model resolves to no embedder; wiping would be
			// unrecoverable, so the reconcile must skip.
			memory = new Mnemopi({ db, embeddings: { model: "", provider: fakeEmbed() } });
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
		} finally {
			memory?.close();
			db.close();
		}
	});

	it("does not reconcile a read-only open (reconcile: false), even on a model change", () => {
		const { db } = seedDb(OLD_MODEL);
		let memory: Mnemopi | undefined;
		try {
			// A stats/read-only open is short-lived and would exit before its async
			// rebuild completed, so it must not perform the destructive wipe.
			memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() }, reconcile: false });
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
		} finally {
			memory?.close();
			db.close();
		}
	});

	it("recovers an interrupted rebuild: re-enqueues live memories missing an active-model embedding", async () => {
		// Simulate a wipe that completed but whose async rebuild never finished (a process exit
		// or transient embed failure): live memories remain but `memory_embeddings` is empty. A
		// prior bug treated the empty table as "reconciled" and stranded them FTS-only forever.
		const db = new Database(":memory:");
		initBeam(db);
		const ts = new Date().toISOString();
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("wm-1", "alpha working memory", ts);
		db.prepare(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("ep-1", "beta episodic memory", ts);

		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		try {
			// No stale rows to wipe, but the missing-embedding recovery enqueues the live rows.
			expect(countEmbeddings(memory)).toBe(0);
			expect(memory.beam.pendingExtractions.size).toBeGreaterThanOrEqual(1);

			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all() as {
				memory_id: string;
				model: string;
			}[];
			expect(rows.map(row => row.memory_id).sort()).toEqual(["ep-1", "wm-1"]);
			expect(rows.every(row => row.model === NEW_MODEL)).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});
});
