import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";

// Real embeddings (fastembed + onnxruntime-node, ~270MB) install on demand via
// `bun install` on first use. These tests never exercise embeddings — the
// consolidation dry-run touches no vectors — so disable them; otherwise the
// on-demand install hangs each test past the 5s timeout (and starves siblings
// under parallel CI).
beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

afterEach(() => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
});

type TempDb = { dir: string; path: string };
const tempDbs: TempDb[] = [];

function tempDb(name = "mnemopi.db"): TempDb {
	const dir = mkdtempSync(join(tmpdir(), "mnemopi-beam-e3-e4-e6-"));
	const db = { dir, path: join(dir, name) };
	tempDbs.push(db);
	return db;
}

function oldTimestamp(): string {
	return new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
}

function seedOldWorking(beam: BeamMemory, ids: readonly string[], sessionId = "s1"): void {
	using insert = beam.db.prepare(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	for (const [index, id] of ids.entries()) {
		insert.run(id, `sleep marker ${id} token${index}`, "conversation", oldTimestamp(), sessionId, 0.5, "stated");
	}
}

function annotationCount(dbPath: string): number {
	const db = new Database(dbPath, { create: false, readwrite: true, strict: true });
	try {
		const row = db.query("SELECT COUNT(*) AS count FROM annotations").get() as {
			count: number;
		} | null;
		return row?.count ?? 0;
	} catch {
		return 0;
	} finally {
		db.close();
	}
}

function seedLegacyTriples(dbPath: string): void {
	const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
	try {
		db.run(`
			CREATE TABLE triples (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				subject TEXT NOT NULL,
				predicate TEXT NOT NULL,
				object TEXT NOT NULL,
				valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				valid_until TEXT,
				source TEXT,
				confidence REAL DEFAULT 1.0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		db.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-1", "mentions", "Alice", "2026-05-30", "extraction", 0.9],
		);
		db.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-1", "mentions", "Bob", "2026-05-30", "extraction", 0.9],
		);
		db.run(
			"INSERT INTO triples (subject, predicate, object, valid_from, source, confidence) VALUES (?, ?, ?, ?, ?, ?)",
			["mem-2", "fact", "Some fact about mem-2", "2026-05-30", "test", 0.7],
		);
	} finally {
		db.close();
	}
}

afterEach(() => {
	delete process.env.MNEMOPI_AUTO_MIGRATE;
	while (tempDbs.length > 0) {
		const db = tempDbs.pop();
		if (db) rmSync(db.dir, { recursive: true, force: true });
	}
});

describe("Beam E3/E4/E6 parity integration", () => {
	it("sleep is additive, marks consolidated_at, preserves recallability, and is idempotent", async () => {
		const db = tempDb();
		const beam = new BeamMemory({ sessionId: "s1", dbPath: db.path });
		try {
			seedOldWorking(beam, ["wm-old-1", "wm-old-2", "wm-old-3"]);
			const result = beam.sleep(false);
			expect(result.status).toBe("consolidated");
			expect(result.items_consolidated).toBe(3);
			expect(beam.db.query("SELECT COUNT(*) AS count FROM working_memory").get()).toEqual({
				count: 3,
			});
			const marked = beam.db.query("SELECT id, consolidated_at FROM working_memory ORDER BY id").all() as {
				id: string;
				consolidated_at: string | null;
			}[];
			expect(marked.every(row => row.consolidated_at !== null)).toBe(true);
			for (const row of marked) expect(() => new Date(row.consolidated_at ?? "bad").toISOString()).not.toThrow();
			expect((await beam.recall("token1", 10)).some(row => row.id === "wm-old-2" && row.tier === "working")).toBe(
				true,
			);
			expect(beam.sleep(false).status).toBe("no_op");
			expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
				count: 1,
			});
		} finally {
			beam.close();
		}
	});

	it("dry-run sleep leaves working, episodic, and consolidation-log state unchanged", () => {
		const db = tempDb();
		const beam = new BeamMemory({ sessionId: "s1", dbPath: db.path });
		try {
			seedOldWorking(beam, ["dry-1", "dry-2"]);
			const result = beam.sleep(true);
			expect(result.status).toBe("dry_run");
			expect(
				beam.db.query("SELECT COUNT(*) AS count FROM working_memory WHERE consolidated_at IS NOT NULL").get(),
			).toEqual({ count: 0 });
			expect(beam.db.query("SELECT COUNT(*) AS count FROM episodic_memory").get()).toEqual({
				count: 0,
			});
			expect(beam.db.query("SELECT COUNT(*) AS count FROM consolidation_log").get()).toEqual({
				count: 0,
			});
		} finally {
			beam.close();
		}
	});

	it("auto-migrates legacy annotation triples once and writes a backup", () => {
		const db = tempDb();
		seedLegacyTriples(db.path);
		expect(annotationCount(db.path)).toBe(0);
		const beam1 = new BeamMemory({ sessionId: "s1", dbPath: db.path });
		try {
			expect(annotationCount(db.path)).toBe(3);
			const values = beam1.db
				.query("SELECT value FROM annotations WHERE memory_id = 'mem-1' AND kind = 'mentions' ORDER BY value")
				.all() as { value: string }[];
			expect(values.map(row => row.value)).toEqual(["Alice", "Bob"]);
			expect(existsSync(`${db.path}.pre_e6_backup`)).toBe(true);
			const beam2 = new BeamMemory({ sessionId: "s1", dbPath: db.path });
			try {
				expect(annotationCount(db.path)).toBe(3);
			} finally {
				beam2.close();
			}
		} finally {
			beam1.close();
		}
	});

	it("cross-tier recall deduplicates summary/source pairs before recall_count attribution", async () => {
		const db = tempDb();
		const beam = new BeamMemory({ sessionId: "s1", dbPath: db.path });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[
					"wm-1",
					"deployment script for prod release",
					"conversation",
					new Date().toISOString(),
					"s1",
					0.5,
					"stated",
				],
			);
			beam.db.run(
				"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, importance, summary_of, veracity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					"ep-1",
					"Summary: deployment script for prod release",
					"consolidation",
					new Date().toISOString(),
					"s1",
					0.5,
					"wm-1",
					"stated",
				],
			);
			beam.db.run(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, veracity) VALUES (?, ?, ?, ?, ?, ?, ?)",
				["wm-2", "deployment notes for staging", "conversation", new Date().toISOString(), "s1", 0.5, "stated"],
			);
			const results = await beam.recall("deployment", 2);
			const ids = results.map(row => row.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids.includes("wm-1") && ids.includes("ep-1")).toBe(false);
			const wmCount =
				(
					beam.db.query("SELECT recall_count FROM working_memory WHERE id = 'wm-1'").get() as {
						recall_count: number;
					}
				).recall_count ?? 0;
			const epCount =
				(
					beam.db.query("SELECT recall_count FROM episodic_memory WHERE id = 'ep-1'").get() as {
						recall_count: number;
					}
				).recall_count ?? 0;
			expect(wmCount + epCount).toBe(1);
		} finally {
			beam.close();
		}
	});
});
