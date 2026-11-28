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
import { describe, expect, it, spyOn } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { logger } from "@oh-my-pi/pi-utils";

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

// A working_memory row as SQLite's `.recover` rebuilt one from a damaged file: a page of an
// fts5 index's data table read back as a working_memory record. It keeps that page's rowid
// ((10 << 37) + 1, segment 10 page 1), its NULL `id` (the data table's INTEGER PRIMARY KEY is
// stored as NULL) and the page itself as BLOB `content`; every other column is at its default.
const UNREADABLE_ROWID = 10 * 2 ** 37 + 1;
const UNREADABLE_PAGE = new Uint8Array([0x00, 0x00, 0x03, 0x51, 0x02, 0x30, 0x31, 0x06, 0x02, 0x42]);

function insertUnreadableRow(db: Database): void {
	db.prepare("INSERT INTO working_memory (rowid, content) VALUES (?, ?)").run(UNREADABLE_ROWID, UNREADABLE_PAGE);
}

/** Inserts a working_memory row with a text id and the page as BLOB content, and returns its rowid as decimal text. */
function insertBlobContentRow(db: Database, id: string): string {
	const insert = db.prepare("INSERT INTO working_memory (id, content) VALUES (?, ?)");
	return String(insert.run(id, UNREADABLE_PAGE).lastInsertRowid);
}

// A skipped-row warning names the row by its rowid as decimal text: a rowid is a signed 64-bit
// integer, and a JS number rounds one past 2^53.
const SKIPPED_ROW_FIELDS = {
	table: "working_memory",
	rowid: String(UNREADABLE_ROWID),
	id: null,
	idType: "null",
	contentType: "blob",
};
const REBUILT = [
	{ memory_id: "ep-1", model: NEW_MODEL },
	{ memory_id: "wm-1", model: NEW_MODEL },
];

/** Two live memories with no embedding at all, as an interrupted rebuild leaves them. */
function seedUnembeddedDb(): Database {
	const db = new Database(":memory:");
	initBeam(db);
	const ts = new Date().toISOString();
	db.prepare(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
	).run("wm-1", "alpha working memory", ts);
	db.prepare(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
	).run("ep-1", "beta episodic memory", ts);
	return db;
}

/**
 * Opens a store on `db` with the new model and waits for its rebuild. Returns the fields of each
 * warning that names a skipped row (it has a `rowid`) and of each warning that counts them (it has
 * `skipped`), matched by those fields rather than the wording; a throw from `new Mnemopi()`
 * propagates.
 */
async function openAndRebuild(db: Database): Promise<{ rows: unknown[]; summaries: unknown[] }> {
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	let memory: Mnemopi | undefined;
	try {
		memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		await memory.flushExtractions();
		const warned = warn.mock.calls.map(([, fields]) => fields ?? {});
		return {
			rows: warned.filter(fields => Object.hasOwn(fields, "rowid")),
			summaries: warned.filter(fields => Object.hasOwn(fields, "skipped")),
		};
	} finally {
		warn.mockRestore();
		memory?.close();
	}
}

function storedEmbeddings(db: Database): unknown[] {
	return db.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all();
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

	it("opens the store and resumes the rebuild past a row with no text id or no text", async () => {
		// The interrupted-rebuild branch runs inside the constructor. A BLOB row there used to
		// throw out of `new Mnemopi()`, so the coding agent left the memory backend off.
		const db = seedUnembeddedDb();
		try {
			insertUnreadableRow(db);
			const logged = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(logged.rows).toEqual([SKIPPED_ROW_FIELDS]);
			expect(logged.summaries).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("finishes a model-change rebuild past a row with no text id or no text", async () => {
		// The model-change branch rebuilds in the background. A BLOB row there aborted the whole
		// rebuild, so every open kept the stale vectors and tried again.
		const { db } = seedDb(OLD_MODEL);
		try {
			insertUnreadableRow(db);
			const logged = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(logged.rows).toEqual([SKIPPED_ROW_FIELDS]);
			expect(logged.summaries).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("resumes past a row with a NULL id after other memories have active-model vectors", async () => {
		// `NULL NOT IN (subquery)` is NULL, not true, once the subquery returns a row: a NOT IN
		// anti-join dropped the NULL-id row unreported as soon as any memory had an active-model vector.
		const db = seedUnembeddedDb();
		try {
			db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
				"wm-1",
				JSON.stringify([1, 0, 0, 0]),
				NEW_MODEL,
			);
			insertUnreadableRow(db);
			const logged = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(logged.rows).toEqual([SKIPPED_ROW_FIELDS]);
		} finally {
			db.close();
		}
	});

	it("resumes every memory missing a vector when an active-model vector has a NULL memory_id", async () => {
		// `memory_embeddings.memory_id` admits NULL too, and `x NOT IN (..., NULL)` is never true:
		// one such vector made a NOT IN anti-join resume no memory at all.
		const db = seedUnembeddedDb();
		try {
			db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (NULL, ?, ?)").run(
				JSON.stringify([1, 0, 0, 0]),
				NEW_MODEL,
			);
			await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual([{ memory_id: null, model: NEW_MODEL }, ...REBUILT]);
		} finally {
			db.close();
		}
	});

	it("names a skipped row by its exact rowid past 2^53, in both rebuild branches", async () => {
		// For a row with a NULL id the rowid is the only locator, and a JS number reads 2^53 + 1 as 2^53.
		const rowid = "9007199254740993";
		for (const seed of [seedUnembeddedDb, () => seedDb(OLD_MODEL).db]) {
			const db = seed();
			try {
				db.run(`INSERT INTO working_memory (rowid, content) VALUES (${rowid}, ?)`, [UNREADABLE_PAGE]);
				const logged = await openAndRebuild(db);
				expect(storedEmbeddings(db)).toEqual(REBUILT);
				expect(logged.rows).toEqual([{ ...SKIPPED_ROW_FIELDS, rowid }]);
			} finally {
				db.close();
			}
		}
	});

	it("skips a row with a text id and BLOB content: a text id alone does not make a row embeddable", async () => {
		// The content half of the guard stops the crash: BLOB content reached `item.content.trim()`
		// and threw out of `new Mnemopi()`, whatever the row's id.
		const db = seedUnembeddedDb();
		try {
			const rowid = insertBlobContentRow(db, "wm-blob");
			const logged = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(logged.rows).toEqual([
				{ table: "working_memory", rowid, id: "wm-blob", idType: "text", contentType: "blob" },
			]);
			expect(logged.summaries).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("skips a row with a NULL id and text content: text alone does not make a row embeddable", async () => {
		// No string id can address this row, so the rebuild does not embed it either.
		const db = seedUnembeddedDb();
		try {
			db.prepare("INSERT INTO working_memory (rowid, content) VALUES (?, ?)").run(
				UNREADABLE_ROWID,
				"gamma working memory",
			);
			const logged = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(logged.rows).toEqual([
				{ table: "working_memory", rowid: String(UNREADABLE_ROWID), id: null, idType: "null", contentType: "text" },
			]);
			expect(logged.summaries).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("names at most 10 skipped rows at each open and counts the rest in one line", async () => {
		// A skipped row gets no vector, so each open skips it again. A badly damaged file must not
		// write one warning per row at every open.
		const db = seedUnembeddedDb();
		try {
			for (let i = 0; i < 10; i += 1) insertBlobContentRow(db, `wm-blob-${i}`);
			const atCap = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(atCap.rows).toHaveLength(10);
			expect(atCap.summaries).toEqual([]);

			insertBlobContentRow(db, "wm-blob-10");
			const oneOver = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(oneOver.rows).toHaveLength(10);
			expect(oneOver.summaries).toEqual([{ skipped: 11, logged: 10 }]);

			for (let i = 11; i < 25; i += 1) insertBlobContentRow(db, `wm-blob-${i}`);
			const pastCap = await openAndRebuild(db);
			expect(storedEmbeddings(db)).toEqual(REBUILT);
			expect(pastCap.rows).toHaveLength(10);
			for (const fields of pastCap.rows) {
				expect(fields).toMatchObject({ table: "working_memory", idType: "text", contentType: "blob" });
			}
			expect(pastCap.summaries).toEqual([{ skipped: 25, logged: 10 }]);
		} finally {
			db.close();
		}
	});
});
