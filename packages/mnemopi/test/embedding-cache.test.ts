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
import {
	cachedEmbeddings,
	forgetCachedEmbeddings,
	MAX_CACHED_VECTORS,
} from "@oh-my-pi/pi-mnemopi/core/beam/embedding-cache";
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

const QUERY_TIME = "2026-05-30T12:00:00.000Z";
const DENSE = { queryEmbedding: [1, 0], queryTime: QUERY_TIME, updateRecallCounts: false };

interface SeedRow {
	id: string;
	table?: "working_memory" | "episodic_memory";
	second?: number;
	session?: string;
	scope?: string;
	channel?: string;
	validUntil?: string;
	supersededBy?: string;
	vector?: string;
}

/** Inserts a row plus its stored embedding through raw SQL, so no provider runs. */
function seedRow(db: Database, row: SeedRow): void {
	db.run(
		`INSERT INTO ${row.table ?? "working_memory"} (id, content, source, timestamp, session_id, importance, scope, channel_id, valid_until, superseded_by, veracity, memory_type, recall_count) VALUES (?, ?, 'test', ?, ?, 0.5, ?, ?, ?, ?, 'unknown', 'general', 3)`,
		[
			row.id,
			`entry ${row.id}`,
			new Date(Date.UTC(2026, 4, 30, 11, 0, row.second ?? 0)).toISOString(),
			row.session ?? "warm",
			row.scope ?? "session",
			row.channel ?? null,
			row.validUntil ?? null,
			row.supersededBy ?? null,
		],
	);
	db.run("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, 'test')", [
		row.id,
		row.vector ?? "[1,0]",
	]);
}

/** A bank of `count` visible working rows, newest last (`wm-000` oldest), all stored as `[1,0]`. */
function bulkBeam(count: number, dbPath = ":memory:"): BeamMemory {
	const beam = new BeamMemory({ sessionId: "warm", dbPath });
	beam.db.transaction(() => {
		for (let index = 0; index < count; index += 1) {
			seedRow(beam.db, { id: `wm-${String(index).padStart(3, "0")}`, second: index });
		}
	})();
	return beam;
}

/** Visible and hidden rows in both tiers for channel `chan`; returns the ids recall may return. */
function seedMixedBank(beam: BeamMemory): string[] {
	const em = "episodic_memory" as const;
	const past = "2000-01-01T00:00:00.000Z";
	seedRow(beam.db, { id: "wm-own", second: 1 });
	seedRow(beam.db, { id: "wm-global", second: 2, session: "other", scope: "global" });
	seedRow(beam.db, { id: "wm-channel", second: 3, session: "other", channel: "chan" });
	seedRow(beam.db, { id: "em-own", table: em, second: 4 });
	seedRow(beam.db, { id: "em-global", table: em, second: 5, session: "other", scope: "global" });
	seedRow(beam.db, { id: "wm-foreign", second: 6, session: "other", channel: "elsewhere" });
	seedRow(beam.db, { id: "wm-expired", second: 7, validUntil: past });
	seedRow(beam.db, { id: "wm-superseded", second: 8, supersededBy: "wm-own" });
	seedRow(beam.db, { id: "em-foreign", table: em, second: 9, session: "other", channel: "elsewhere" });
	seedRow(beam.db, { id: "em-expired", table: em, second: 10, validUntil: past });
	return ["wm-own", "wm-global", "wm-channel", "em-own", "em-global"];
}

function recallCounts(db: Database): unknown[] {
	return db
		.query(
			"SELECT id, recall_count, last_recalled FROM working_memory UNION ALL SELECT id, recall_count, last_recalled FROM episodic_memory ORDER BY id",
		)
		.all();
}

/** One event-loop turn. Warmup yields with `Bun.sleep(0)`; this interleaves with it without timing anything. */
const yieldTurn = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
};

/** Runs event-loop turns until `counter` has seen `reads` chunk reads; bounded so a missing warmup fails, not hangs. */
async function untilReads(counter: { reads(): number }, reads: number): Promise<void> {
	for (let turn = 0; counter.reads() < reads; turn += 1) {
		if (turn > 1000) throw new Error(`warmup never reached ${reads} chunk read(s)`);
		await yieldTurn();
	}
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) await yieldTurn();
}

describe("recall cache warmup", () => {
	it("decodes exactly what recall reads, leaving counters alone, so the next recall reads no stored vector", async () => {
		const beam = new BeamMemory({ sessionId: "warm", dbPath: ":memory:" });
		try {
			const visible = seedMixedBank(beam);
			const before = recallCounts(beam.db);

			await beam.warmRecallCache({ channelId: "chan" });

			expect(recallCounts(beam.db)).toEqual(before);
			const counter = countVectorReads(beam.db);
			try {
				const results = await beam.recall("zorblat plan", 20, { ...DENSE, channelId: "chan" });
				expect(counter.reads()).toBe(0);
				expect(results.map(result => result.id).sort()).toEqual([...visible].sort());
			} finally {
				counter.mockRestore();
			}
		} finally {
			beam.close();
		}
	});

	it("skips the working tier when includeWorking is false", async () => {
		const beam = new BeamMemory({ sessionId: "warm", dbPath: ":memory:" });
		try {
			seedMixedBank(beam);
			await beam.warmRecallCache({ channelId: "chan", includeWorking: false });

			const counter = countVectorReads(beam.db);
			try {
				await beam.recall("zorblat plan", 20, { ...DENSE, channelId: "chan", includeWorking: false });
				expect(counter.reads()).toBe(0);
				await beam.recall("zorblat plan", 20, { ...DENSE, channelId: "chan" });
				expect(counter.reads()).toBeGreaterThan(0);
			} finally {
				counter.mockRestore();
			}
		} finally {
			beam.close();
		}
	});

	it("reads nothing before its first yield, then decodes in several chunks the event loop can interleave with", async () => {
		const beam = bulkBeam(450);
		const counter = countVectorReads(beam.db);
		try {
			const warm = beam.warmRecallCache();
			expect(counter.reads()).toBe(0);

			let settled = false;
			void warm.then(() => {
				settled = true;
			});
			const seen = new Set<number>();
			while (!settled) {
				seen.add(counter.reads());
				await yieldTurn();
			}
			const total = counter.reads();
			// 450 ids fit one 500-id read; chunking shows as several reads and states observed in between.
			expect(total).toBeGreaterThan(1);
			expect([...seen].some(reads => reads > 0 && reads < total)).toBe(true);
		} finally {
			counter.mockRestore();
			beam.close();
		}
	});

	it("stops reading when its signal aborts, leaving the rest to demand loading", async () => {
		const beam = bulkBeam(450);
		const counter = countVectorReads(beam.db);
		try {
			const controller = new AbortController();
			const warm = beam.warmRecallCache({}, controller.signal);
			await untilReads(counter, 1);
			controller.abort();
			await expect(warm).resolves.toBeUndefined();
			const stopped = counter.reads();
			await settle();
			expect(counter.reads()).toBe(stopped);

			await beam.recall("zorblat plan", 5, DENSE);
			expect(counter.reads()).toBeGreaterThan(stopped);
		} finally {
			counter.mockRestore();
			beam.close();
		}
	});

	it("makes no database call when its signal is already aborted", async () => {
		const beam = bulkBeam(3);
		const spy = spyOn(beam.db, "query");
		try {
			await expect(beam.warmRecallCache({}, AbortSignal.abort())).resolves.toBeUndefined();
			expect(spy.mock.calls).toHaveLength(0);
		} finally {
			spy.mockRestore();
			beam.close();
		}
	});

	it("stops without rejecting when the beam closes mid-warmup, and stays inert afterwards", async () => {
		const beam = bulkBeam(450);
		const spy = spyOn(beam.db, "query");
		const vectorReads = () => spy.mock.calls.filter(([sql]) => sql.includes("FROM memory_embeddings")).length;
		try {
			const warm = beam.warmRecallCache();
			await untilReads({ reads: vectorReads }, 1);
			beam.close();
			const callsAtClose = spy.mock.calls.length;
			await expect(warm).resolves.toBeUndefined();
			await settle();
			expect(spy.mock.calls).toHaveLength(callsAtClose);

			await expect(beam.warmRecallCache()).resolves.toBeUndefined();
			expect(spy.mock.calls).toHaveLength(callsAtClose);
		} finally {
			spy.mockRestore();
			beam.close();
		}
	});

	const topIdsAfterEditBetweenChunks = async (edit: (beam: BeamMemory, dbPath: string, target: string) => void) => {
		const dir = await TempDir.create("@mnemopi-warmup-");
		const dbPath = dir.join("bank.db");
		const beam = bulkBeam(450, dbPath);
		const counter = countVectorReads(beam.db);
		try {
			// The newest row is decoded in the first chunk (windows list newest first); the query is `[1,0]`.
			const target = "wm-449";
			const warm = beam.warmRecallCache();
			await untilReads(counter, 1);
			edit(beam, dbPath, target);
			await warm;
			const ids = (await beam.recall("zorblat plan", 5, DENSE)).map(result => result.id);
			return { ids, target };
		} finally {
			counter.mockRestore();
			beam.close();
			await dir.remove();
		}
	};

	it("does not serve a vector another connection rewrote after its chunk was warmed", async () => {
		const { ids, target } = await topIdsAfterEditBetweenChunks((_beam, dbPath, id) => {
			const peer = new Database(dbPath);
			try {
				peer.run("UPDATE memory_embeddings SET embedding_json = '[0,1]' WHERE memory_id = ?", [id]);
			} finally {
				peer.close();
			}
		});
		// Rewritten to `[0,1]`, the newest row no longer matches the `[1,0]` query; a stale `[1,0]` would put it on top.
		expect(ids).not.toContain(target);
	});

	it("does not serve a vector this connection rewrote after its chunk was warmed", async () => {
		const { ids, target } = await topIdsAfterEditBetweenChunks((beam, _dbPath, id) => {
			beam.db.run("UPDATE memory_embeddings SET embedding_json = '[0,1]' WHERE memory_id = ?", [id]);
			forgetCachedEmbeddings(beam.db, [id]);
		});
		expect(ids).not.toContain(target);
	});

	it("neither reads nor caches inside a transaction, so a rolled-back vector is never served", async () => {
		const beam = bulkBeam(3);
		try {
			beam.db.run("UPDATE memory_embeddings SET embedding_json = '[0,1]'");
			beam.db.run("UPDATE memory_embeddings SET embedding_json = '[1,0]' WHERE memory_id = 'wm-001'");
			const counter = countVectorReads(beam.db);
			try {
				beam.db.run("BEGIN");
				beam.db.run("UPDATE memory_embeddings SET embedding_json = '[0,1]' WHERE memory_id = 'wm-001'");
				await beam.warmRecallCache();
				expect(counter.reads()).toBe(0);
				beam.db.run("ROLLBACK");

				expect((await beam.recall("zorblat plan", 1, DENSE))[0]?.id).toBe("wm-001");
			} finally {
				counter.mockRestore();
			}
		} finally {
			beam.close();
		}
	});

	it("stops when a transaction opens between chunks", async () => {
		const beam = bulkBeam(450);
		const counter = countVectorReads(beam.db);
		try {
			const warm = beam.warmRecallCache();
			await untilReads(counter, 1);
			beam.db.run("BEGIN");
			await expect(warm).resolves.toBeUndefined();
			const stopped = counter.reads();
			await settle();
			expect(counter.reads()).toBe(stopped);
			beam.db.run("ROLLBACK");
		} finally {
			counter.mockRestore();
			beam.close();
		}
	});
});
