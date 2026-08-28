/**
 * Superseded rows must not occupy FTS candidate slots. The FTS mirrors keep a row's text
 * after `superseded_by` is set (content is unchanged, so no sync trigger fires) — correct
 * mirroring — but the query sites previously returned those ids/rowids inside `LIMIT k`;
 * downstream visibility filtering then dropped them, so a dead row silently STOLE a pool
 * slot from a live one. Contract: with k=1 and a better-matching superseded row present,
 * the live row must still be returned; superseded rows never appear at any k.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam";
import { ftsSearch, ftsSearchWorking } from "@oh-my-pi/pi-mnemopi/core/beam/helpers";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";

function makeBeam(db: Database): BeamMemoryState {
	return {
		db,
		sessionId: "bank-a",
		authorId: null,
		authorType: null,
		channelId: "bank-a",
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

function seedWorking(db: Database, id: string, content: string): void {
	db.run(
		`INSERT INTO working_memory
			(id, content, embed_text, source, timestamp, session_id, importance, metadata_json, scope,
			 veracity, memory_type, consolidated_at, author_id, author_type, channel_id, trust_tier, created_at)
		 VALUES (?, ?, ?, 'test', '2026-08-25T00:00:00.000Z', 'bank-a', 0.5, '{}', 'bank',
			 'unknown', 'episode', NULL, 'tester', 'agent', 'bank-a', 'private', '2026-08-25T00:00:00.000Z')`,
		[id, content, content],
	);
}

function seedEpisodic(db: Database, id: string, content: string): void {
	db.run(
		`INSERT INTO episodic_memory
			(id, content, source, timestamp, session_id, importance, metadata_json, veracity, tier,
			 memory_type, scope, author_id, author_type, channel_id, trust_tier, created_at)
		 VALUES (?, ?, 'test', '2026-08-25T00:00:00.000Z', 'bank-a', 0.5, '{}', 'unknown', 'recent',
			 'episode', 'bank', 'tester', 'agent', 'bank-a', 'private', '2026-08-25T00:00:00.000Z')`,
		[id, content],
	);
}

describe("fts candidate slots exclude superseded rows", () => {
	test("working: live row returned at k=1 even when a superseded row matches better", () => {
		const db = new Database(":memory:");
		initBeam(db);
		seedWorking(db, "live0000000000aa", "vindral deployment runbook lives here");
		// Repeats the terms, so raw FTS ranks the dead row first.
		seedWorking(db, "dead0000000000bb", "vindral vindral vindral deployment deployment runbook runbook details");
		db.run("UPDATE working_memory SET superseded_by = 'live0000000000aa' WHERE id = 'dead0000000000bb'");

		expect(ftsSearchWorking(db, "vindral deployment runbook", 1).map(hit => hit.id)).toEqual(["live0000000000aa"]);
		db.close();
	});

	test("working: superseded rows never appear at any k", () => {
		const db = new Database(":memory:");
		initBeam(db);
		seedWorking(db, "live0000000000aa", "kitty graphics protocol notes");
		seedWorking(db, "dead0000000000bb", "kitty graphics protocol older superseded copy");
		db.run("UPDATE working_memory SET superseded_by = 'live0000000000aa' WHERE id = 'dead0000000000bb'");

		expect(ftsSearchWorking(db, "kitty graphics protocol", 20).map(hit => hit.id)).toEqual(["live0000000000aa"]);
		db.close();
	});

	test("episodic: live row returned at k=1 even when a superseded row matches better", () => {
		const db = new Database(":memory:");
		initBeam(db);
		seedEpisodic(db, "epi0000000000aaa", "starship prompt theme configuration");
		seedEpisodic(db, "epi0000000000bbb", "starship starship prompt prompt theme theme configuration older");
		db.run("UPDATE episodic_memory SET superseded_by = 'epi0000000000aaa' WHERE id = 'epi0000000000bbb'");
		const liveRowid = (
			db.query("SELECT rowid FROM episodic_memory WHERE id='epi0000000000aaa'").get() as { rowid: number }
		).rowid;

		expect(ftsSearch(db, "starship prompt theme configuration", 1).map(hit => hit.rowid)).toEqual([liveRowid]);
		db.close();
	});
});

describe("recall FTS path excludes superseded rows from candidate slots", () => {
	test("linear recall returns the live row even when superseded rows flood the inner FTS pool", async () => {
		const db = new Database(":memory:");
		initBeam(db);
		const beam = makeBeam(db);
		seedWorking(db, "live0000000000aa", "vindral deployment runbook lives here");
		// The inner FTS fetch is max(topK*3, 50); 55 better-matching superseded rows would fill
		// every unfiltered slot and evict the live row entirely.
		for (let index = 0; index < 55; index++) {
			const id = `dead${String(index).padStart(12, "0")}`;
			seedWorking(db, id, "vindral vindral vindral deployment deployment runbook runbook details");
			db.run("UPDATE working_memory SET superseded_by = 'live0000000000aa' WHERE id = ?", [id]);
		}

		const results = await recall(beam, "vindral deployment runbook", 1, {});
		expect(results.map(row => row.id)).toEqual(["live0000000000aa"]);
		db.close();
	});
});

describe("cjk fallback excludes superseded rows", () => {
	test("k=1 returns the live row when a superseded row matches more query characters", () => {
		const db = new Database(":memory:");
		initBeam(db);
		// Live row matches 2 of 3 query chars; the superseded row matches all 3 and would win.
		seedWorking(db, "live0000000000aa", "部署 手册");
		seedWorking(db, "dead0000000000bb", "部署 手册 说明");
		db.run("UPDATE working_memory SET superseded_by = 'live0000000000aa' WHERE id = 'dead0000000000bb'");

		expect(ftsSearchWorking(db, "部署手册说明", 1).map(hit => hit.id)).toEqual(["live0000000000aa"]);
		db.close();
	});
});

/**
 * The visibility predicate must not cost a scan of the backing table on every lexical recall.
 *
 * `id IN (SELECT id FROM working_memory WHERE superseded_by IS NULL)` reads naturally but makes
 * SQLite build a LIST SUBQUERY over every live row BEFORE the small candidate LIMIT applies, so a
 * highly selective query pays for the whole table. Measured on a 40k-row bank with a query matching
 * 12 rows: 9.19ms for the IN form versus 0.042ms both without any filter and with a correlated
 * EXISTS. The plan is asserted rather than the timing, because timing is machine-dependent while the
 * plan shape is the actual contract.
 */
describe("FTS visibility predicate stays index-driven", () => {
	function plan(db: Database, sql: string): string {
		return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("marker", 8) as { detail: string }[])
			.map(row => row.detail)
			.join(" | ");
	}

	test("neither FTS candidate query materializes the live-row set", () => {
		const db = new Database(":memory:");
		initBeam(db);

		const workingPlan = plan(
			db,
			`SELECT f.id, f.rank FROM fts_working f
			 WHERE f.fts_working MATCH ?
			   AND EXISTS (SELECT 1 FROM working_memory w WHERE w.id = f.id AND w.superseded_by IS NULL)
			 ORDER BY f.rank, f.id LIMIT ?`,
		);
		expect(workingPlan).not.toContain("LIST SUBQUERY");
		expect(workingPlan).not.toContain("SCAN working_memory");
		expect(workingPlan).toContain("CORRELATED SCALAR SUBQUERY");
		expect(workingPlan).toContain("SEARCH w");

		const episodicPlan = plan(
			db,
			`SELECT f.rowid, f.rank FROM fts_episodes f
			 WHERE f.fts_episodes MATCH ?
			   AND EXISTS (SELECT 1 FROM episodic_memory e WHERE e.rowid = f.rowid AND e.superseded_by IS NULL)
			 ORDER BY f.rank, f.rowid LIMIT ?`,
		);
		expect(episodicPlan).not.toContain("LIST SUBQUERY");
		expect(episodicPlan).not.toContain("SCAN episodic_memory");
		expect(episodicPlan).toContain("CORRELATED SCALAR SUBQUERY");

		// Control: the rejected IN form really does produce what we are guarding against, so this
		// test cannot pass vacuously if EXPLAIN output ever changes shape.
		const rejected = plan(
			db,
			`SELECT id, rank FROM fts_working
			 WHERE fts_working MATCH ?
			   AND id IN (SELECT id FROM working_memory WHERE superseded_by IS NULL)
			 ORDER BY rank, id LIMIT ?`,
		);
		expect(rejected).toContain("LIST SUBQUERY");
		expect(rejected).toContain("SCAN working_memory");

		db.close();
	});
});
