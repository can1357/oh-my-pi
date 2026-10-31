import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { consolidateToEpisodic, extractAndStoreFacts, storeExtractedFactCategories, storeFactStrings } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import { factRecall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { sourceMemoryScope } from "@oh-my-pi/pi-mnemopi/core/beam/fact-scope";
import { get, importFromDict, updateWorking } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import { ensureFactsFtsUpdateTrigger } from "@oh-my-pi/pi-mnemopi/core/facts-fts";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { EpisodicGraph } from "@oh-my-pi/pi-mnemopi/core/episodic-graph";
import {
	hasPendingFactsScopeMigration as hasPendingMigration,
	migrateFactsScope as migrate,
} from "@oh-my-pi/pi-mnemopi/core/migrations/e7-facts-scope";
// The exports map exposes the barrel file via its explicit path ("./*" -> "./src/*.ts");
// the directory shorthand is not a valid subpath, so import the index file directly.
import * as migrationsBarrel from "@oh-my-pi/pi-mnemopi/core/migrations/index";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const roots: string[] = [];
let prevNoEmbeddings: string | undefined;

function tempDb(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-facts-e7-"));
	roots.push(root);
	return join(root, "bank.db");
}

beforeEach(() => {
	// Capture the caller's environment and restore it afterwards: deleting the
	// variable outright would let later test files in the same Bun worker
	// initialize native embeddings mid-suite.
	prevNoEmbeddings = process.env.MNEMOPI_NO_EMBEDDINGS;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

afterEach(() => {
	if (prevNoEmbeddings === undefined) delete process.env.MNEMOPI_NO_EMBEDDINGS;
	else process.env.MNEMOPI_NO_EMBEDDINGS = prevNoEmbeddings;
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** The facts table exactly as pre-e7 banks created it (no `scope` column),
 * including the FTS5 external-content table and its triggers. */
function seedOldShapeFacts(dbPath: string, rows: readonly (readonly [string, string, string, string, string])[]): void {
	const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
	try {
		db.run(`
			CREATE TABLE facts (
				fact_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				subject TEXT NOT NULL,
				predicate TEXT NOT NULL,
				object TEXT NOT NULL,
				timestamp TEXT,
				source_msg_id TEXT,
				confidence REAL DEFAULT 1.0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);
		db.run(
			`CREATE VIRTUAL TABLE fts_facts USING fts5(
				subject, predicate, object, content='facts'
			)`,
		);
		db.run(
			`CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
				INSERT INTO fts_facts(rowid, subject, predicate, object)
				VALUES (new.rowid, new.subject, new.predicate, new.object);
			END`,
		);
		db.run(
			`CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
				INSERT INTO fts_facts(fts_facts, rowid, subject, predicate, object)
				VALUES ('delete', old.rowid, old.subject, old.predicate, old.object);
			END`,
		);
		for (const [factId, sessionId, subject, predicate, object] of rows) {
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object) VALUES (?, ?, ?, ?, ?)",
				[factId, sessionId, subject, predicate, object],
			);
		}
	} finally {
		db.close();
	}
}

function factColumns(dbPath: string): string[] {
	const db = openDatabase(dbPath);
	try {
		const rows = db.query("PRAGMA table_info(facts)").all() as { name: string }[];
		return rows.map(row => row.name);
	} finally {
		closeQuietly(db);
	}
}

function journalMode(dbPath: string): string {
	const db = openDatabase(dbPath, { create: false, readwrite: false, pragmas: false });
	try {
		return (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
	} finally {
		closeQuietly(db);
	}
}

function factScopes(dbPath: string): Record<string, string | null> {
	const db = openDatabase(dbPath);
	try {
		const rows = db.query("SELECT fact_id, scope FROM facts ORDER BY fact_id").all() as {
			fact_id: string;
			scope: string | null;
		}[];
		const out: Record<string, string | null> = {};
		for (const row of rows) out[row.fact_id] = row.scope;
		return out;
	} finally {
		closeQuietly(db);
	}
}

describe("E7 facts scope migration", () => {
	it("adds the scope column to an old-shape bank and preserves pre-existing rows", () => {
		const dbPath = tempDb();
		seedOldShapeFacts(dbPath, [
			["fact-1", "session-a", "relay", "requires", "quorum tokens"],
			["fact-2", "session-b", "vault", "stores", "sealed keys"],
		]);

		const probe = openDatabase(dbPath);
		try {
			expect(hasPendingMigration(probe)).toBe(true);
		} finally {
			closeQuietly(probe);
		}
		expect(migrate({ dbPath, backup: false, logFn: () => undefined })).toBe(1);

		expect(factColumns(dbPath)).toContain("scope");
		// Pre-existing rows keep the default — no retroactive widening to 'global'.
		expect(factScopes(dbPath)).toEqual({ "fact-1": "session", "fact-2": "session" });

		// The FTS5 external-content table needs no side action for a non-indexed
		// column add; the index must still pass its integrity check.
		const db = openDatabase(dbPath);
		try {
			db.run(`INSERT INTO fts_facts(fts_facts, rank) VALUES ('integrity-check', 1)`);
			expect(db.query("SELECT COUNT(*) AS count FROM fts_facts WHERE fts_facts MATCH 'quorum'").get()).toEqual({
				count: 1,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("is idempotent: re-running is a no-op", () => {
		const dbPath = tempDb();
		seedOldShapeFacts(dbPath, [["fact-1", "session-a", "relay", "requires", "quorum tokens"]]);

		expect(migrate(dbPath, false, false, () => undefined)).toBe(1);
		expect(migrate(dbPath, false, false, () => undefined)).toBe(0);
		expect(factScopes(dbPath)).toEqual({ "fact-1": "session" });
		const probe = openDatabase(dbPath);
		try {
			expect(hasPendingMigration(probe)).toBe(false);
		} finally {
			closeQuietly(probe);
		}
	});

	it("reports dry-run without writes and writes backup only when requested", () => {
		const dbPath = tempDb();
		seedOldShapeFacts(dbPath, [["fact-1", "session-a", "relay", "requires", "quorum tokens"]]);

		expect(migrate({ dbPath, dryRun: true, backup: false, logFn: () => undefined })).toBe(1);
		expect(factColumns(dbPath)).not.toContain("scope");
		expect(existsSync(`${dbPath}.pre_e7_backup`)).toBe(false);

		expect(migrate({ dbPath, backup: true, logFn: () => undefined })).toBe(1);
		expect(existsSync(`${dbPath}.pre_e7_backup`)).toBe(true);
		writeFileSync(`${dbPath}.pre_e7_backup`, "sentinel");
		expect(migrate({ dbPath, backup: true, logFn: () => undefined })).toBe(0);
		expect(readFileSync(`${dbPath}.pre_e7_backup`, "utf8")).toBe("sentinel");
	});

	it("is a no-op for databases without a facts table", () => {
		const dbPath = tempDb();
		closeQuietly(new Database(dbPath, { create: true }));
		expect(migrate(dbPath, false, false, () => undefined)).toBe(0);
		expect(existsSync(`${dbPath}.pre_e7_backup`)).toBe(false);
	});

	it("detects pending migration cheaply and new banks never report it", () => {
		const dbPath = tempDb();
		const fresh = openDatabase(dbPath);
		try {
			initBeam(fresh);
			expect(hasPendingMigration(fresh)).toBe(false);
		} finally {
			closeQuietly(fresh);
		}

		const oldPath = tempDb();
		seedOldShapeFacts(oldPath, [["fact-1", "session-a", "relay", "requires", "quorum tokens"]]);
		let old = openDatabase(oldPath);
		try {
			expect(hasPendingMigration(old)).toBe(true);
		} finally {
			closeQuietly(old);
		}

		expect(migrate(oldPath, false, false, () => undefined)).toBe(1);
		old = openDatabase(oldPath);
		try {
			expect(hasPendingMigration(old)).toBe(false);
		} finally {
			closeQuietly(old);
		}
	});

	it("dry run leaves the bank file untouched (no journal-mode change, no column)", () => {
		const dbPath = tempDb();
		seedOldShapeFacts(dbPath, [["fact-1", "session-a", "relay", "requires", "quorum tokens"]]);
		const before = journalMode(dbPath);
		expect(migrate({ dbPath, dryRun: true, backup: false, logFn: () => undefined })).toBe(1);
		expect(journalMode(dbPath)).toBe(before);
		expect(factColumns(dbPath)).not.toContain("scope");
	});

	it("throws for a missing database and for :memory:", () => {
		expect(() => migrate("/nonexistent/mnemopi-e7-missing.db", false, false, () => undefined)).toThrow(
			/database not found/,
		);
		expect(() => migrate(":memory:", false, false, () => undefined)).toThrow(/database not found/);
	});

	it("keeps e6's migrate and hasPendingMigration importable from the migrations barrel", () => {
		const core = migrationsBarrel as Record<string, unknown>;
		expect(typeof core.migrate).toBe("function");
		expect(typeof core.hasPendingMigration).toBe("function");
		expect(typeof core.migrateFactsScope).toBe("function");
		expect(typeof core.hasPendingFactsScopeMigration).toBe("function");
	});

	it("consolidated episodes scope their extracted facts like the episode", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const memoryId = consolidateToEpisodic(
				beamA,
				"Upgraded the relay to v3.2.1 and the cron to 2026-01-05",
				["wm-1"],
				"test",
				0.6,
				{ scope: "session" },
			);
			const rows = beamA.db
				.query("SELECT scope FROM facts WHERE source_msg_id = ?")
				.all(memoryId) as { scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.scope).toBe("session");
		}
		finally {
			beamA.close();
		}
	});

	it("get-by-id honors source narrowing and retirement like recall", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-gid', 'g content', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-gid");
			const factId = (beamA.db
				.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-gid'")
				.get() as { fact_id: string }).fact_id;
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamB, factId)).not.toBeNull();
			} finally {
				beamB.close();
			}

			beamA.db.run("UPDATE working_memory SET scope = 'session' WHERE id = 'wm-gid'");
			const beamC = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamC, factId)).toBeNull();
			} finally {
				beamC.close();
			}
			expect(get(beamA, factId)).not.toBeNull();

			beamA.db.run("UPDATE working_memory SET superseded_by = 'x' WHERE id = 'wm-gid'");
			expect(get(beamA, factId)).toBeNull();
		} finally {
			beamA.close();
		}
	});

	it("get-by-id resolves episodic-sourced facts and honors their source rules", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('ep-gid', 'e content', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ep-gid");
			const factId = (beamA.db
				.query("SELECT fact_id FROM facts WHERE source_msg_id = 'ep-gid'")
				.get() as { fact_id: string }).fact_id;
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamB, factId)).not.toBeNull();
			} finally {
				beamB.close();
			}

			beamA.db.run("UPDATE episodic_memory SET scope = 'session' WHERE id = 'ep-gid'");
			const beamC = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamC, factId)).toBeNull();
			} finally {
				beamC.close();
			}
			expect(get(beamA, factId)).not.toBeNull();
		} finally {
			beamA.close();
		}
	});

	it("updateWorking retires the edited source's extracted facts", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-edit', 'old text', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-edit");
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const before = factRecall(beamB, "quorum", 10);
				expect(before.some(result => result.content.includes("quorum"))).toBe(true);
			} finally {
				beamB.close();
			}

			const updated = updateWorking(beamA, "wm-edit", "completely different text");
			expect(updated).toBe(true);

			const beamC = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const after = factRecall(beamC, "quorum", 10);
				expect(after.some(result => result.content.includes("quorum"))).toBe(false);
			} finally {
				beamC.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("discards extraction when the source is trimmed before the task snapshots it", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			// An ancient timestamp is TTL-trimmed inside this remember(), before
			// the extraction task captures its source snapshot.
			const id = memory.remember("original text", {
				source: "test",
				extract: true,
				timestamp: "2000-01-01T00:00:00.000Z",
			});
			expect(id).toBeTruthy();
			// Reuse the id with different content under the same scope while the
			// extraction is still in flight (this insert only succeeds because
			// the trim already removed the original row).
			memory.beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES (?, 'replacement text', 'session-a', 'session')",
				[id],
			);
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as { fact_id: string }[];
			expect(rows.length).toBe(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("force import overwriting an episode purges the old episode's facts", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('ep-repl', 'old episode text', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ep-repl");
			const before = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'ep-repl'").all() as unknown[];
			expect(before.length).toBeGreaterThan(0);

			const stats = importFromDict(
				beamA,
				{
					episodic_memory: [{ id: "ep-repl", content: "replacement episode text", session_id: "session-a", scope: "global" }],
				},
				true,
			);
			expect(stats.episodic_memory.overwritten).toBe(1);

			const after = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'ep-repl'").all() as unknown[];
			expect(after.length).toBe(0);
			const content = beamA.db.query("SELECT content FROM episodic_memory WHERE id = 'ep-repl'").get() as { content: string };
			expect(content.content).toBe("replacement episode text");
		} finally {
			beamA.close();
		}
	});

	it("content edits preserve the source's annotations", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-ann', 'old text', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO annotations (memory_id, kind, value, source) VALUES ('wm-ann', 'occurred_on', '2026-01-02T00:00:00.000Z', 'test')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-ann");

			expect(updateWorking(beamA, "wm-ann", "completely different text")).toBe(true);

			const facts = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-ann'").all() as unknown[];
			expect(facts.length).toBe(0);
			const annotation = beamA.db
				.query("SELECT value FROM annotations WHERE memory_id = 'wm-ann' AND kind = 'occurred_on'")
				.get() as { value: string } | null;
			expect(annotation != null && annotation.value === "2026-01-02T00:00:00.000Z").toBe(true);
		} finally {
			beamA.close();
		}
	});

	it("keeps pending extraction when a duplicate remember refreshes the timestamp", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			const id = memory.remember("I use the quorum relay for tokens", { source: "test", extract: true });
			expect(id).toBeTruthy();
			// A duplicate remember of identical content hits the refresh path,
			// which updates the mutable event timestamp in place without
			// recreating the row: the pending extraction must survive it.
			const dup = memory.remember("I use the quorum relay for tokens", { source: "test", extract: true });
			expect(dup).toBe(id);
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as { fact_id: string }[];
			expect(rows.length).toBeGreaterThan(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("keeps NULL-owned source rows private to empty session ids", () => {
		const beam = new BeamMemory({ sessionId: "", dbPath: tempDb() });
		try {
			// A restored row can retain a NULL owner; a caller built with an
			// explicit empty session id must not be equated with the missing one.
			beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-null-owner', 'src content', NULL, 'session')",
			);
			storeFactStrings(beam, ["Quorum relay needs a safeword passphrase"], 0, "wm-null-owner");
			const results = factRecall(beam, "quorum relay safeword passphrase", 10);
			expect(results.some(result => result.content.includes("safeword"))).toBe(false);
		} finally {
			beam.close();
		}
	});

	it("re-scoped duplicate remember schedules a replacement extraction", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			const id = memory.remember("I use the quorum relay for tokens", { source: "test", scope: "global", extract: true });
			expect(id).toBeTruthy();
			// The duplicate write narrows the scope: the first pending task
			// becomes stale, and the duplicate path must schedule the
			// replacement under the updated scope so the memory does not end
			// up with no facts.
			const dup = memory.remember("I use the quorum relay for tokens", { source: "test", scope: "session", extract: true });
			expect(dup).toBe(id);
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id, scope FROM facts WHERE source_msg_id = ?").all(id) as { fact_id: string; scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every(row => row.scope === "session")).toBe(true);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("discards extraction when a force import recreates the row preserving timestamps", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			const id = memory.remember("same text both times", { source: "test", extract: true });
			expect(id).toBeTruthy();
			const orig = memory.beam.db
				.prepare("SELECT created_at FROM working_memory WHERE id = ?")
				.get(id) as { created_at: string };
			memory.beam.db.run("DELETE FROM working_memory WHERE id = ?", [id]);
			// Re-import the same row with the exported creation timestamp
			// preserved: created_at (and even the rowid) can match the old
			// incarnation, but the import must receive a fresh generation token.
			importFromDict(
				memory.beam,
				{ working_memory: [{ id, content: "same text both times", session_id: "session-a", scope: "session", created_at: orig.created_at }] },
				true,
			);
			const gen = memory.beam.db
				.prepare("SELECT generation FROM working_memory WHERE id = ?")
				.get(id) as { generation: string | null };
			expect(gen.generation).not.toBeNull();
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as { fact_id: string }[];
			expect(rows.length).toBe(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("discards extraction when the source row is forgotten and recreated identically", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			const id = memory.remember("same text both times", { source: "test", extract: true });
			expect(id).toBeTruthy();
			// Forget the row while extraction is in flight and re-create it
			// within the same second: the rowid is reused, created_at has
			// one-second precision, and the raw insert omits the generation
			// column — only the per-insert generation token (NULL on the
			// replacement vs a fresh value on the original) can distinguish the
			// incarnations.
			memory.beam.db.run("DELETE FROM working_memory WHERE id = ?", [id]);
			memory.beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES (?, 'same text both times', 'session-a', 'session')",
				[id],
			);
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as { fact_id: string }[];
			expect(rows.length).toBe(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("episode force-import skips the purge when a working row collides on the id", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-c2', 'working text', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('wm-c2', 'episode text', 'session-b', 'session')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-c2");
			const before = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-c2'").all() as unknown[];
			expect(before.length).toBeGreaterThan(0);

			const stats = importFromDict(
				beamA,
				{
					episodic_memory: [{ id: "wm-c2", content: "replacement episode text", session_id: "session-b", scope: "session" }],
				},
				true,
			);
			expect(stats.episodic_memory.overwritten).toBe(1);

			// Collision: the untyped-id purge is skipped, so the working row's
			// derivatives survive the episode overwrite.
			const after = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-c2'").all() as unknown[];
			expect(after.length).toBe(before.length);
		} finally {
			beamA.close();
		}
	});

	it("backfills fts_facts when the index adopts a pre-existing facts table", () => {
		const db = openDatabase(":memory:");
		try {
			db.run(
				"CREATE TABLE facts (fact_id TEXT PRIMARY KEY, session_id TEXT, subject TEXT, predicate TEXT, object TEXT, timestamp TEXT, source_msg_id TEXT, confidence REAL, scope TEXT DEFAULT 'session')",
			);
			db.run(
				"INSERT INTO facts (fact_id, subject, predicate, object, timestamp, scope) VALUES ('f_old', 'Ada', 'works at', 'Example Corp', '2026-01-01T00:00:00.000Z', 'global')",
			);
			db.run("CREATE VIRTUAL TABLE fts_facts USING fts5(subject, predicate, object, content='facts')");
			ensureFactsFtsUpdateTrigger(db);
			const found = db.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'Example'").get() as { n: number };
			expect(found.n).toBe(1);
			db.run("UPDATE facts SET object = 'Other Corp' WHERE fact_id = 'f_old'");
			const stale = db.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'Example'").get() as { n: number };
			const fresh = db.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'Other'").get() as { n: number };
			expect(stale.n).toBe(0);
			expect(fresh.n).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("discards extraction results when the source is edited while in flight", async () => {
		const idRef: { id: string } = { id: "" };
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: {
				enabled: true,
				complete: async prompt => {
					// Edit the source after remember() has returned (and the task
					// captured the scheduled version) but before extraction settles.
					await Bun.sleep(0);
					updateWorking(memory.beam, idRef.id, "completely different text");
					return "The user uses the quorum relay for tokens";
				},
			},
		});
		try {
			idRef.id = memory.remember("I use the quorum relay for tokens", { source: "test", extract: true });
			expect(idRef.id).toBeTruthy();
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(idRef.id) as { fact_id: string }[];
			expect(rows.length).toBe(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("content edits skip the artifact purge when the other tier collides on the id", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-col', 'old text', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('wm-col', 'episode text', 'session-b', 'session')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-col");
			const before = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-col'").all() as { fact_id: string }[];
			expect(before.length).toBeGreaterThan(0);

			expect(updateWorking(beamA, "wm-col", "completely different text")).toBe(true);

			// The purge must not have run: the collision makes the untyped source
			// id ambiguous, so the (possibly episode-derived) rows stay.
			const after = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-col'").all() as { fact_id: string }[];
			expect(after.length).toBe(before.length);
		} finally {
			beamA.close();
		}
	});

	it("get-by-id hides a fact when the same id exists privately in the other tier", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-dual', 'g', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('wm-dual', 'e', 'session-b', 'session')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-dual");
			const factId = (beamA.db
				.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-dual'")
				.get() as { fact_id: string }).fact_id;
			// The same conservative rule applies in factRecall, so no session that
			// cannot see the private episode row resolves the fact — including
			// session-a, which only owns the global working row.
			const beamC = new BeamMemory({ sessionId: "session-c", dbPath });
			try {
				expect(get(beamC, factId)).toBeNull();
			} finally {
				beamC.close();
			}
			const beamD = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamD, factId)).not.toBeNull();
			} finally {
				beamD.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("get-by-id tolerates facts whose source row no longer exists", () => {
		const dbPath = tempDb();
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			storeFactStrings(beam, ["I use the quorum relay for tokens"], 0, "wm-gone");
			const factId = (beam.db
				.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-gone'")
				.get() as { fact_id: string }).fact_id;
			expect(get(beam, factId)).not.toBeNull();
		} finally {
			beam.close();
		}
	});
});

describe("E7 facts scope recall, end to end", () => {
	it("recalls a fact extracted in session A from session B", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const cols = beamA.db.query("PRAGMA table_info(facts)").all() as { name: string }[];
			expect(cols.some(row => row.name === "scope")).toBe(true);
			// The source memory is stored global, so its extracted facts inherit
			// 'global' and stay recallable cross-session (the durable-tier case).
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-src-1', 'src content', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["Zorblax relay requires quorum tokens"], 0, "wm-src-1");
			const stored = beamA.db
				.query("SELECT scope FROM facts WHERE source_msg_id = 'wm-src-1'")
				.get() as { scope: string };
			expect(stored.scope).toBe("global");
		} finally {
			beamA.close();
		}

		const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
		try {
			const results = factRecall(beamB, "Zorblax relay quorum tokens", 10);
			expect(results.some(result => result.content.includes("Zorblax"))).toBe(true);
		} finally {
			beamB.close();
		}
	});

	it("keeps a manually session-scoped fact invisible cross-session but visible in its own session", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, scope) VALUES (?, ?, ?, ?, ?, ?)",
				["fact-local", "session-a", "console", "prefers", "silent mode", "session"],
			);
		} finally {
			beamA.close();
		}

		const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
		try {
			const cross = factRecall(beamB, "silent mode console", 10);
			expect(cross.some(result => result.id === "fact-local")).toBe(false);
		} finally {
			beamB.close();
		}

		const beamA2 = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const own = factRecall(beamA2, "silent mode console", 10);
			expect(own.some(result => result.id === "fact-local")).toBe(true);
		} finally {
			beamA2.close();
		}
	});

	it("keeps pre-migration fact rows invisible cross-session after the column is added", () => {
		const dbPath = tempDb();
		seedOldShapeFacts(dbPath, [["fact-old", "session-a", "ledger", "balances", "midnight cron"]]);
		expect(migrate(dbPath, false, false, () => undefined)).toBe(1);

		const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
		try {
			const cross = factRecall(beamB, "midnight cron ledger", 10);
			expect(cross.some(result => result.id === "fact-old")).toBe(false);
		} finally {
			beamB.close();
		}

		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const own = factRecall(beamA, "midnight cron ledger", 10);
			expect(own.some(result => result.id === "fact-old")).toBe(true);
		} finally {
			beamA.close();
		}
	});
});
describe("E7 facts scope, writer paths", () => {
	it("sourceMemoryScope inherits the stored memory's scope", () => {
		const dbPath = tempDb();
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-s', 's content', 'session-a', 'session')",
			);
			beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-g', 'g content', 'session-a', 'global')",
			);
			beam.db.run("INSERT INTO episodic_memory (id, content, scope) VALUES ('ep-s', 'episode content', 'session')");
			expect(sourceMemoryScope(beam, "wm-s")).toBe("session");
			expect(sourceMemoryScope(beam, "wm-g")).toBe("global");
			expect(sourceMemoryScope(beam, "ep-s")).toBe("session");
			expect(sourceMemoryScope(beam, "wm-missing")).toBe("session");
		} finally {
			beam.close();
		}
	});

	it("storeExtractedFactCategories inherits scope from a global source when omitted", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-1', 'src content', 'session-a', 'global')",
			);
			storeExtractedFactCategories(
				beamA,
				{ facts: ["I use the quorum relay for tokens"], instructions: [], preferences: [], timelines: [], kg: [] },
				0,
				"wm-1",
			);
			const rows = beamA.db
				.query("SELECT scope FROM facts WHERE source_msg_id = 'wm-1'")
				.all() as { scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.scope).toBe("global");
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const results = factRecall(beamB, "quorum", 10);
				expect(results.some(result => result.content.includes("quorum"))).toBe(true);
			} finally {
				beamB.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("keeps graph-ingested facts from a session consolidation session-scoped", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			consolidateToEpisodic(beamA, "Alice uses secret vault", ["wm-9"], "test", 0.6, {
				scope: "session",
			});
			const rows = beamA.db.query("SELECT scope FROM facts").all() as { scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.scope).toBe("session");
		} finally {
			beamA.close();
		}

		const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
		try {
			const cross = factRecall(beamB, "secret vault Alice", 10);
			expect(cross.some(result => result.content.includes("secret vault"))).toBe(false);
		} finally {
			beamB.close();
		}
	});

	it("keeps fts_facts fresh when a fact is re-stored with new content", () => {
		const dbPath = tempDb();
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const graph = new EpisodicGraph({ db: beam.db, dbPath });
			const fact = {
				id: "fact-fts-1",
				subject: "relay",
				predicate: "uses",
				object: "vaultword",
				timestamp: "2026-01-01T00:00:00.000Z",
				confidence: 0.7,
			};
			graph.storeFact(fact, "m-fts", "session-a");
			graph.storeFact({ ...fact, object: "safeword" }, "m-fts", "session-a");
			const stale = beam.db
				.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'vaultword'")
				.get() as { n: number };
			const fresh = beam.db
				.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'safeword'")
				.get() as { n: number };
			expect(stale.n).toBe(0);
			expect(fresh.n).toBe(1);
		} finally {
			beam.close();
		}
	});
});
describe("E7 facts scope, review round 2", () => {
	it("public extractAndStoreFacts inherits the source memory's scope", () => {
		const dbPath = tempDb();
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-pub', 'c', 'session-a', 'session')",
			);
			extractAndStoreFacts(beam, "I use the quorum relay for tokens", 0, "wm-pub");
			const rows = beam.db
				.query("SELECT scope FROM facts WHERE source_msg_id = 'wm-pub'")
				.all() as { scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.scope).toBe("session");
		} finally {
			beam.close();
		}
	});

	it("global facts hide cross-session when the source scope becomes NULL", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-null', 'n content', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-null");
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const before = factRecall(beamB, "quorum", 10);
				expect(before.some(result => result.content.includes("quorum"))).toBe(true);
			} finally {
				beamB.close();
			}

			beamA.db.run("UPDATE working_memory SET scope = NULL WHERE id = 'wm-null'");
			const beamC = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const after = factRecall(beamC, "quorum", 10);
				expect(after.some(result => result.content.includes("quorum"))).toBe(false);
			} finally {
				beamC.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("facts retire when their episodic source is invalidated", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const episodeId = consolidateToEpisodic(
				beamA,
				"Relay upgrade shipped on 2026-03-14",
				["wm-1"],
				"test",
				0.6,
				{ scope: "global" },
			);
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const before = factRecall(beamB, "iso_date", 10);
				expect(before.some(result => result.content.includes("2026-03-14"))).toBe(true);
			} finally {
				beamB.close();
			}

			beamA.db.run("UPDATE episodic_memory SET superseded_by = 'ep-x' WHERE id = ?", [episodeId]);
			const beamC = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const after = factRecall(beamC, "iso_date", 10);
				expect(after.some(result => result.content.includes("2026-03-14"))).toBe(false);
			} finally {
				beamC.close();
			}
		} finally {
			beamA.close();
		}
	});
});
describe("E7 facts scope, review round 3", () => {
	it("direct storeFactStrings inherits the source memory's scope", () => {
		const dbPath = tempDb();
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beam.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-d', 'd content', 'session-a', 'session')",
			);
			storeFactStrings(beam, ["I use the quorum relay for tokens"], 0, "wm-d");
			const rows = beam.db
				.query("SELECT scope FROM facts WHERE source_msg_id = 'wm-d'")
				.all() as { scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.scope).toBe("session");
		} finally {
			beam.close();
		}
	});

	it("global facts hide cross-session when the source is narrowed to session", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-n', 'n content', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-n");
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const before = factRecall(beamB, "quorum", 10);
				expect(before.some(result => result.content.includes("quorum"))).toBe(true);
			} finally {
				beamB.close();
			}

			beamA.db.run("UPDATE working_memory SET scope = 'session' WHERE id = 'wm-n'");
			const beamC = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const after = factRecall(beamC, "quorum", 10);
				expect(after.some(result => result.content.includes("quorum"))).toBe(false);
			} finally {
				beamC.close();
			}
			const own = factRecall(beamA, "quorum", 10);
			expect(own.some(result => result.content.includes("quorum"))).toBe(true);
		} finally {
			beamA.close();
		}
	});
});
