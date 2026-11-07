/**
 * Recall keeps decoded embeddings per connection. These pin the ways a cached vector could go stale (a vector
 * written later by this connection or by another connection, a write path that drops a vector, a rolled-back
 * transaction), that the cache survives commits that leave vectors alone, and that cache history never
 * changes what recall returns.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import "./setup";
import { BeamMemory, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { cachedEmbeddings, MAX_CACHED_VECTORS } from "@oh-my-pi/pi-mnemopi/core/beam/embedding-cache";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";

// "zorblat" and "quexim" share an axis, so a query and a memory can match by meaning without sharing a word.
const axis = (text: string) => (/zorblat|quexim/i.test(text) ? [1, 0] : [0, 1]);
const provider = async function* (texts: readonly string[]) {
	yield texts.map(axis);
};

/** Counts the `memory_embeddings` reads (one per fetched chunk) made through `db` until restored. */
function countVectorReads(db: Database): { reads(): number; mockRestore(): void } {
	const spy = spyOn(db, "query");
	return {
		reads: () => spy.mock.calls.filter(([sql]) => sql.includes("FROM memory_embeddings WHERE memory_id IN")).length,
		mockRestore: () => spy.mockRestore(),
	};
}

async function recallIds(memory: Mnemopi): Promise<string[]> {
	return (await memory.recall("zorblat plan", 5)).map(result => result.id);
}

/**
 * Recalls through one connection, lets a second connection on the same bank rewrite stored vectors with `edit`,
 * and returns the top id of the next recall. `target` matches the query until `edit` runs; a later memory keeps
 * the newest embedding row so the rewrite never touches it.
 */
async function topAfterPeerEdit(edit: (peer: Database, target: string, other: string) => void) {
	const dir = await TempDir.create("@mnemopi-embedding-cache-");
	const dbPath = dir.join("bank.db");
	const memory = new Mnemopi({ dbPath, embeddings: { provider } });
	try {
		const target = memory.remember("quexim checklist agreed for friday", { source: "test" });
		const other = memory.remember("gardening note about soil", { source: "test" });
		await memory.flushExtractions();
		memory.remember("weather report for the weekend", { source: "test" });
		await memory.flushExtractions();
		expect((await recallIds(memory))[0]).toBe(target);

		const peer = new Database(dbPath);
		try {
			const newest = peer.query<{ memory_id: string }, []>(
				"SELECT memory_id FROM memory_embeddings ORDER BY rowid DESC LIMIT 1",
			);
			const newestBefore = newest.get()?.memory_id;
			expect([target, other]).not.toContain(newestBefore);
			edit(peer, target, other);
			expect(newest.get()?.memory_id).toBe(newestBefore);
		} finally {
			peer.close();
		}
		return { top: (await recallIds(memory))[0], other };
	} finally {
		memory.close();
		await dir.remove();
	}
}

describe("embedding cache", () => {
	it("uses a vector stored after an earlier recall cached its absence", async () => {
		const gate = Promise.withResolvers<void>();
		let held = false;
		const heldProvider = async function* (texts: readonly string[]) {
			// Hold only the target's document embedding, so the first recall sees it without a vector.
			if (!held && texts.some(text => text.startsWith("quexim checklist"))) {
				held = true;
				await gate.promise;
			}
			yield texts.map(axis);
		};
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider: heldProvider } });
		try {
			memory.remember("gardening note about soil", { source: "test" });
			await memory.flushExtractions();
			const target = memory.remember("quexim checklist agreed for friday", { source: "test" });

			const before = await memory.recall("zorblat plan", 5);
			expect(before.some(result => result.id === target)).toBe(false);

			gate.resolve();
			await memory.flushExtractions();
			const after = await memory.recall("zorblat plan", 5);
			expect(after[0]?.id).toBe(target);
		} finally {
			memory.close();
		}
	});

	it("sees embeddings another connection rewrote", async () => {
		const dir = await TempDir.create("@mnemopi-embedding-cache-");
		const dbPath = dir.join("bank.db");
		const memory = new Mnemopi({ dbPath, embeddings: { provider } });
		try {
			const target = memory.remember("quexim checklist agreed for friday", { source: "test" });
			const other = memory.remember("gardening note about soil", { source: "test" });
			await memory.flushExtractions();
			expect((await memory.recall("zorblat plan", 5))[0]?.id).toBe(target);

			const peer = new Database(dbPath);
			try {
				// Rewrite the way the embedding writer does: INSERT OR REPLACE, keeping the stored model.
				const rewrite = peer.prepare(
					"INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model) SELECT memory_id, ?, model FROM memory_embeddings WHERE memory_id = ?",
				);
				rewrite.run("[0,1]", target);
				rewrite.run("[1,0]", other);
			} finally {
				peer.close();
			}

			expect((await memory.recall("zorblat plan", 5))[0]?.id).toBe(other);
		} finally {
			memory.close();
			await dir.remove();
		}
	});

	it("sees embeddings another connection updated in place behind a newer row", async () => {
		const { top, other } = await topAfterPeerEdit((peer, target, other) => {
			const update = peer.prepare("UPDATE memory_embeddings SET embedding_json = ? WHERE memory_id = ?");
			update.run("[0,1]", target);
			update.run("[1,0]", other);
		});
		expect(top).toBe(other);
	});

	it("sees embeddings another connection wiped and rebuilt with the same row count and newest row", async () => {
		const { top, other } = await topAfterPeerEdit((peer, target, other) => {
			peer.transaction(() => {
				const rows = peer
					.query<{ memory_id: string; embedding_json: string; model: string | null }, []>(
						"SELECT memory_id, embedding_json, model FROM memory_embeddings ORDER BY rowid",
					)
					.all();
				peer.run("DELETE FROM memory_embeddings");
				const insert = peer.prepare(
					"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)",
				);
				for (const row of rows) {
					const json = row.memory_id === target ? "[0,1]" : row.memory_id === other ? "[1,0]" : row.embedding_json;
					insert.run(row.memory_id, json, row.model);
				}
			})();
		});
		expect(top).toBe(other);
	});

	it("keeps decoded vectors when another connection commits a write that leaves embeddings alone", async () => {
		const dir = await TempDir.create("@mnemopi-embedding-cache-");
		const dbPath = dir.join("bank.db");
		const memory = new Mnemopi({ dbPath, embeddings: { provider } });
		try {
			const target = memory.remember("quexim checklist agreed for friday", { source: "test" });
			memory.remember("gardening note about soil", { source: "test" });
			await memory.flushExtractions();
			expect((await recallIds(memory))[0]).toBe(target);

			const peer = new Database(dbPath);
			try {
				// What another session's recall commits: recall counts, no vectors.
				peer.run("UPDATE working_memory SET recall_count = COALESCE(recall_count, 0) + 1");
			} finally {
				peer.close();
			}

			const counter = countVectorReads(memory.conn);
			try {
				expect((await recallIds(memory))[0]).toBe(target);
				expect(counter.reads()).toBe(0);
			} finally {
				counter.mockRestore();
			}
		} finally {
			memory.close();
			await dir.remove();
		}
	});

	it("serves the committed vector again after a transaction that changed it rolls back", async () => {
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider } });
		try {
			const target = memory.remember("quexim checklist agreed for friday", { source: "test" });
			memory.remember("gardening note about soil", { source: "test" });
			await memory.flushExtractions();
			expect((await recallIds(memory))[0]).toBe(target);

			memory.conn.run("BEGIN");
			memory.update(target, "gardening rota for the allotment");
			await memory.flushExtractions();
			expect(await recallIds(memory)).not.toContain(target);
			memory.conn.run("ROLLBACK");

			expect((await recallIds(memory))[0]).toBe(target);
		} finally {
			memory.close();
		}
	});

	it("stops using the vector of an episodic memory that degradation re-encoded", async () => {
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider } });
		try {
			const id = memory.beam.consolidateToEpisodic(
				"ORIGINAL_DETAILED_CONTEXT ".repeat(40).trim(),
				["wm-1"],
				"test",
				0.7,
			);
			const created = new Date(Date.now() - 181 * 24 * 60 * 60 * 1000).toISOString();
			memory.conn.run("UPDATE episodic_memory SET tier = 2, created_at = ? WHERE id = ?", [created, id]);
			// Seeded before the first recall, so no cached copy can predate it.
			memory.conn.run(
				"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0]', 'test')",
				[id],
			);
			expect(await recallIds(memory)).toContain(id);

			expect(memory.beam.degradeEpisodic(false).tier2_to_tier3).toBe(1);

			expect(await recallIds(memory)).not.toContain(id);
		} finally {
			memory.close();
		}
	});

	it("stops using the vector of a working memory that a forced import replaced", async () => {
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider } });
		try {
			const id = memory.remember("quexim checklist agreed for friday", { source: "test" });
			await memory.flushExtractions();
			expect(await recallIds(memory)).toContain(id);

			// A forced import overwrites the row and drops its vector; the import carries none for working rows.
			expect(memory.beam.importFromDict(memory.beam.exportToDict(), true).working_memory.overwritten).toBe(1);

			expect(await recallIds(memory)).not.toContain(id);
		} finally {
			memory.close();
		}
	});

	it("prunes a similarity tie the way the pre-cache query did, whatever an earlier recall cached", async () => {
		// 60 rows share one vector, so recall keeps the first 50 of the tie (`max(topK * 3, 50)`). The ten oldest
		// carry the highest importance. The pre-cache query listed the tie in id order, so they survived the cut;
		// listing it newest first (recall's id order) would drop them, whatever the cache held.
		const topRanked = async (warmFirst: boolean): Promise<string | undefined> => {
			const beam = new BeamMemory({ sessionId: "tie", dbPath: ":memory:" });
			try {
				const options = {
					queryEmbedding: [1, 0],
					queryTime: "2026-05-30T12:00:00.000Z",
					updateRecallCounts: false,
				};
				const add = (index: number) => {
					const id = `wm-${String(index).padStart(2, "0")}`;
					beam.db.run(
						"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', ?, ?, ?, 'global', 'unknown', 'general')",
						[
							id,
							`entry ${index}`,
							new Date(Date.UTC(2026, 4, 30, 11, 0, index)).toISOString(),
							"tie",
							index < 10 ? 0.9 : 0.1,
						],
					);
					beam.db.run(
						"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0]', 'test')",
						[id],
					);
				};
				for (let index = 0; index < 10; index += 1) add(index);
				if (warmFirst) await beam.recall("zorblat plan", 1, options);
				for (let index = 10; index < 60; index += 1) add(index);
				return (await beam.recall("zorblat plan", 1, options))[0]?.id;
			} finally {
				beam.close();
			}
		};
		const cold = await topRanked(false);
		expect(cold).toMatch(/^wm-0\d$/);
		expect(await topRanked(true)).toBe(cold);
	});

	it("returns vectors in the order the pre-cache chunked query returned them, cold or warm", () => {
		const db = new Database(":memory:");
		try {
			initBeam(db);
			// Insert order, id order and argument order all differ, and the ids span three 500-id chunks.
			const ids = Array.from({ length: 1300 }, (_, index) => `m${(index * 7919) % 1300}`);
			const insert = db.prepare(
				"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0]', 't')",
			);
			for (const id of ids) insert.run(id);
			const memoryIds = [...Array.from({ length: 1300 }, (_, index) => `m${(index * 104_729) % 1300}`), "missing"];
			const preCache: string[] = [];
			for (let offset = 0; offset < memoryIds.length; offset += 500) {
				const chunk = memoryIds.slice(offset, offset + 500);
				const rows = db
					.query<{ memory_id: string }, string[]>(
						`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${chunk.map(() => "?").join(",")})`,
					)
					.all(...chunk);
				for (const row of rows) preCache.push(row.memory_id);
			}

			cachedEmbeddings(db, memoryIds.slice(300, 900));
			expect([...cachedEmbeddings(db, memoryIds).keys()]).toEqual(preCache);
			expect([...cachedEmbeddings(db, memoryIds).keys()]).toEqual(preCache);
		} finally {
			db.close();
		}
	});

	it("keeps two alternating windows decoded after one of them slides past the bound", () => {
		const db = new Database(":memory:");
		try {
			initBeam(db);
			const shift = 100;
			const ids = Array.from({ length: MAX_CACHED_VECTORS + shift }, (_, index) => `m${index}`);
			const insert = db.prepare(
				"INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, '[1,0]', 't')",
			);
			db.transaction(() => {
				for (const id of ids) insert.run(id);
			})();
			const half = MAX_CACHED_VECTORS / 2;
			const second = ids.slice(half, MAX_CACHED_VECTORS);
			// The first window slides: its oldest rows drop out and rows past the bound come in.
			const slid = [...ids.slice(shift, half), ...ids.slice(MAX_CACHED_VECTORS)];
			cachedEmbeddings(db, ids.slice(0, half));
			cachedEmbeddings(db, second);
			cachedEmbeddings(db, slid);

			const counter = countVectorReads(db);
			try {
				cachedEmbeddings(db, second);
				cachedEmbeddings(db, slid);
				expect(counter.reads()).toBe(0);
			} finally {
				counter.mockRestore();
			}
		} finally {
			db.close();
		}
	});

	it("recalls past a stored empty embedding instead of failing", async () => {
		const memory = new Mnemopi({ db: new Database(":memory:"), embeddings: { provider } });
		try {
			const target = memory.remember("quexim plan for friday", { source: "test" });
			const empty = memory.remember("zorblat plan with an empty vector", { source: "test" });
			await memory.flushExtractions();
			memory.conn.run("UPDATE memory_embeddings SET embedding_json = '[]' WHERE memory_id = ?", [empty]);

			const ids = await recallIds(memory);
			expect(ids).toContain(target);
			expect(ids).toContain(empty);
		} finally {
			memory.close();
		}
	});
});
