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

	it("beam init backfills fts_facts when adopting a pre-existing facts table", () => {
		const dbPath = tempDb();
		{
			const raw = openDatabase(dbPath);
			try {
				raw.run(
					"CREATE TABLE facts (fact_id TEXT PRIMARY KEY, session_id TEXT, subject TEXT, predicate TEXT, object TEXT, timestamp TEXT, source_msg_id TEXT, confidence REAL, scope TEXT DEFAULT 'session')",
				);
				raw.run(
					"INSERT INTO facts (fact_id, subject, predicate, object, timestamp, scope) VALUES ('f_old', 'Ada', 'works at', 'Example Corp', '2026-01-01T00:00:00.000Z', 'global')",
				);
			} finally {
				closeQuietly(raw);
			}
		}
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			// initBeam adopted the facts rows: the index must already be backfilled,
			// and the first update must refresh it without a missing-index delete.
			const found = beam.db.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'Example'").get() as { n: number };
			expect(found.n).toBe(1);
			beam.db.run("UPDATE facts SET object = 'Other Corp' WHERE fact_id = 'f_old'");
			const stale = beam.db.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'Example'").get() as { n: number };
			const fresh = beam.db.query("SELECT count(*) AS n FROM fts_facts WHERE fts_facts MATCH 'Other'").get() as { n: number };
			expect(stale.n).toBe(0);
			expect(fresh.n).toBe(1);
		} finally {
			beam.close();
		}
	});

	it("duplicate remember with the same explicit scope does not double-extract", async () => {
		let llmCalls = 0;
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => { llmCalls++; return "The user uses the quorum relay for tokens"; } },
		});
		try {
			const id = memory.remember("I use the quorum relay for tokens", { source: "test", scope: "session", extract: true });
			expect(id).toBeTruthy();
			// Callers that always pass the same explicit scope must not start a
			// second extraction: the stored scope is unchanged, so the pending
			// task is still valid and a duplicate pass would only re-write the
			// projection tables.
			const dup = memory.remember("I use the quorum relay for tokens", { source: "test", scope: "session", extract: true });
			expect(dup).toBe(id);
			await memory.flushExtractions();
			expect(llmCalls).toBe(1);
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
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-c2");
			// The colliding episode row appears AFTER the fact was written, so
			// the fact's provenance is unambiguously the working tier.
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('wm-c2', 'episode text', 'session-b', 'session')",
			);
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

	it("id collisions retire only the edited tier's own fact derivatives", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-col', 'old text', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-col");
			const tier = beamA.db.query("SELECT source_tier FROM facts WHERE source_msg_id = 'wm-col'").get() as { source_tier: string | null };
			expect(tier.source_tier).toBe("working");
			// The colliding episode row appears AFTER the fact was written (the
			// stamp reflects the source situation at write time)...
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('wm-col', 'episode text', 'session-b', 'session')",
			);
			const before = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-col'").all() as { fact_id: string }[];
			expect(before.length).toBeGreaterThan(0);

			expect(updateWorking(beamA, "wm-col", "completely different text")).toBe(true);

			// Provenance now resolves the ambiguous untyped id: the working
			// content change retires the working-derived facts even with the
			// episode row still colliding (they no longer support the new text).
			const after = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-col'").all() as { fact_id: string }[];
			expect(after.length).toBe(0);
		} finally {
			beamA.close();
		}
	});

	it("episode force-overwrite retires episode-derived facts across id collisions", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			// A global fact extracted from the episode before any working row
			// collides on the id.
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('ep-c3', 'episode statement', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ep-c3");
			const tier = beamA.db.query("SELECT source_tier FROM facts WHERE source_msg_id = 'ep-c3'").get() as { source_tier: string | null };
			expect(tier.source_tier).toBe("episodic");
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('ep-c3', 'working text', 'session-a', 'global')",
			);
			const stats = importFromDict(
				beamA,
				{ episodic_memory: [{ id: "ep-c3", content: "replacement episode text", session_id: "session-a", scope: "global" }] },
				true,
			);
			expect(stats.episodic_memory.overwritten).toBe(1);
			// The replaced episode's old statement no longer supports its
			// facts, so they must retire even though a working row collides on
			// the untyped id.
			const rows = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'ep-c3'").all() as { fact_id: string }[];
			expect(rows.length).toBe(0);
		} finally {
			beamA.close();
		}
	});

	it("edits that change and restore content invalidate the pending extraction", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			const id = memory.remember("I use the quorum relay for tokens", { source: "test", extract: true });
			expect(id).toBeTruthy();
			// Move the content away and back before the LLM finishes: the text
			// matches the snapshot again, but each real edit advanced the
			// generation token, so the pending result must be discarded.
			updateWorking(memory.beam, id, "entirely different text");
			updateWorking(memory.beam, id, "I use the quorum relay for tokens");
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as { fact_id: string }[];
			expect(rows.length).toBe(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("get-by-id follows the fact's recorded provenance tier", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('wm-dual', 'g', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "wm-dual");
			// The colliding episode row appears AFTER the fact was written, so
			// the provenance stamp is unambiguously the working tier.
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('wm-dual', 'e', 'session-b', 'session')",
			);
			const factId = (beamA.db
				.query("SELECT fact_id FROM facts WHERE source_msg_id = 'wm-dual'")
				.get() as { fact_id: string }).fact_id;
			// The fact is working-derived: the private episode row sharing the id
			// no longer masks it, so a session owning neither row still resolves
			// it through the global working source.
			const beamC = new BeamMemory({ sessionId: "session-c", dbPath });
			try {
				expect(get(beamC, factId)).not.toBeNull();
			} finally {
				beamC.close();
			}
			// Legacy rows without provenance keep the conservative both-tiers
			// rule: a private same-id row in either tier retires the fact for
			// sessions that cannot see it.
			beamA.db.run("UPDATE facts SET source_tier = NULL WHERE fact_id = ?", [factId]);
			const beamD = new BeamMemory({ sessionId: "session-c", dbPath });
			try {
				expect(get(beamD, factId)).toBeNull();
			} finally {
				beamD.close();
			}
			const beamE = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamE, factId)).not.toBeNull();
			} finally {
				beamE.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("fact recall follows the fact's recorded provenance tier", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('x9', 'episode text', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "x9");
			const tier = beamA.db.query("SELECT source_tier FROM facts WHERE source_msg_id = 'x9'").get() as { source_tier: string | null };
			expect(tier.source_tier).toBe("episodic");
			// A session-private working row sharing the id must not hide the
			// episode-derived global fact: the fact's source is the episode.
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('x9', 'working text', 'session-b', 'session')",
			);
			const hits = factRecall(beamA, "quorum relay") as { content: string }[];
			expect(hits.some(h => h.content.includes("quorum relay"))).toBe(true);
		} finally {
			beamA.close();
		}
	});

	it("tier-scoped collision purge preserves the other tier's graph edges", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('e4', 'working text', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('e4', 'episode text', 'session-b', 'session')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "e4");
			beamA.db.run(
				"INSERT INTO graph_edges (source, target, edge_type, weight, timestamp) VALUES ('e4', 'node-e4', 'ctx', 1, '2026-01-01T00:00:00.000Z')",
			);
			updateWorking(beamA, "e4", "reworded working text");
			// The working-derived fact retires with the content change...
			const facts = beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'e4'").all() as { fact_id: string }[];
			expect(facts.length).toBe(0);
			// ...but the graph edge touching the shared memory id (owned by the
			// untouched tier) survives.
			const edge = beamA.db.query("SELECT source FROM graph_edges WHERE source = 'e4' AND target = 'node-e4'").get() as { source: string } | null;
			expect(edge).not.toBeNull();
		} finally {
			beamA.close();
		}
	});

	it("ABA re-scope rotates the extraction generation", async () => {
		let calls = 0;
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: {
				enabled: true,
				complete: async () => {
					calls++;
					return calls === 1
						? "I use the quorum relay for tokens"
						: calls === 2
							? "I use the signal lamp for status"
							: "I use the backup vault for keys";
				},
			},
		});
		try {
			const text = "stored text";
			const id = memory.remember(text, { source: "test", scope: "global", extract: true, extractText: "T1" });
			// global -> session -> global while the first task awaits: the final
			// state matches the first snapshot again (same content, same scope),
			// so only the per-change generation can tell the incarnations apart.
			const second = memory.remember(text, { source: "test", scope: "session", extract: true, extractText: "T2" });
			const third = memory.remember(text, { source: "test", scope: "global", extract: true, extractText: "T3" });
			expect(second).toBe(id);
			expect(third).toBe(id);
			await memory.flushExtractions();
			expect(calls).toBe(3);
			const objs = (memory.conn.query("SELECT object FROM facts").all() as { object: string }[]).map(r => r.object);
			expect(objs.some(o => o.includes("backup vault"))).toBe(true);
			expect(objs.some(o => o.includes("quorum relay"))).toBe(false);
			expect(objs.some(o => o.includes("signal lamp"))).toBe(false);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("honors an explicit extraction request when nothing is pending", async () => {
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: { enabled: true, complete: async () => "The user uses the quorum relay for tokens" },
		});
		try {
			const text = "stored text";
			const id = memory.remember(text, { source: "test", extract: true });
			// Edit the content away and back: both changes rotate the generation
			// and the original task discards itself, leaving the row without facts.
			updateWorking(memory.beam, id, "other text");
			updateWorking(memory.beam, id, text);
			await memory.flushExtractions();
			expect((memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as unknown[]).length).toBe(0);
			// A later duplicate remember requesting extraction must still run:
			// no task is pending, so the request is not suppressed.
			const dup = memory.remember(text, { source: "test", extract: true });
			expect(dup).toBe(id);
			await memory.flushExtractions();
			expect((memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as unknown[]).length).toBeGreaterThan(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
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

	it("extracted facts carry their source channel for cross-session visibility", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope, channel_id) VALUES ('ch1', 'channel text', 'session-a', 'channel', 'chan-1')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ch1");
			const row = beamA.db.query("SELECT channel_id FROM facts WHERE source_msg_id = 'ch1'").get() as { channel_id: string | null };
			expect(row.channel_id).toBe("chan-1");
			// A different session in the same channel recalls the fact...
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const withChannel = factRecall(beamB, "quorum relay", 30, "chan-1") as { content: string }[];
				expect(withChannel.some(h => h.content.includes("quorum relay"))).toBe(true);
				const withoutChannel = factRecall(beamB, "quorum relay", 30) as { content: string }[];
				expect(withoutChannel.some(h => h.content.includes("quorum relay"))).toBe(false);
			} finally {
				beamB.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("suppresses duplicate extraction only while the current generation is pending", async () => {
		let calls = 0;
		const gate1 = Promise.withResolvers<void>();
		const gate2 = Promise.withResolvers<void>();
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: {
				enabled: true,
				complete: async () => {
					calls++;
					if (calls === 1) await gate1.promise;
					if (calls === 2) await gate2.promise;
					return "I use the quorum relay for tokens";
				},
			},
		});
		try {
			const storedText = "stored text";
			const id = memory.remember(storedText, { source: "test", scope: "global", extract: true });
			expect(id).toBeTruthy();
			// A re-scope rotates the generation and schedules a replacement while
			// the first task is still gated: two distinct (id, generation) tasks.
			memory.remember(storedText, { source: "test", scope: "session", extract: true });
			for (let i = 0; i < 10_000 && memory.beam.pendingExtractionIds.size !== 2; i++) {
				await Promise.resolve();
			}
			expect(memory.beam.pendingExtractionIds.size).toBe(2);
			// A duplicate request at the CURRENT generation is suppressed...
			const dup = memory.remember(storedText, { source: "test", extract: true });
			expect(dup).toBe(id);
			expect(calls).toBe(2);
			// ...while a stale-generation task does NOT block: let the current
			// task settle, then the obsolete one still counts nothing for the
			// current generation, so the next explicit request runs.
			gate2.resolve();
			gate1.resolve();
			await memory.flushExtractions();
			expect(calls).toBe(2);
			memory.remember(storedText, { source: "test", extract: true });
			await memory.flushExtractions();
			expect(calls).toBe(3);
			expect((memory.conn.query("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id) as unknown[]).length).toBeGreaterThan(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("channel visibility does not retroactively widen session-scoped facts", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope, channel_id) VALUES ('ch5', 't', 'session-a', 'session', 'chan-5')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ch5");
			const row = beamA.db.query("SELECT scope, channel_id FROM facts WHERE source_msg_id = 'ch5'").get() as { scope: string; channel_id: string | null };
			expect(row.scope).toBe("session");
			expect(row.channel_id).toBe("chan-5");
			// Widen the source later: the fact keeps its original scope and
			// must not become channel-visible retroactively.
			beamA.db.run("UPDATE working_memory SET scope = 'global' WHERE id = 'ch5'");
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const hits = factRecall(beamB, "quorum relay", 30, "chan-5") as { content: string }[];
				expect(hits.some(h => h.content.includes("quorum relay"))).toBe(false);
			} finally {
				beamB.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("graph-stored facts stamp the source channel", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const graph = new EpisodicGraph({ db: beamA.db, dbPath });
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope, channel_id) VALUES ('ch6', 't', 'session-a', 'channel', 'chan-6')",
			);
			graph.storeFact(
				{ id: "f-ch6", subject: "I", predicate: "use", object: "the quorum relay for tokens", timestamp: "2026-01-01T00:00:00.000Z", confidence: 0.7 },
				"ch6",
				"session-a",
				"channel",
			);
			const row = beamA.db.query("SELECT channel_id, source_tier FROM facts WHERE fact_id = 'f-ch6'").get() as { channel_id: string | null; source_tier: string | null };
			expect(row.channel_id).toBe("chan-6");
			expect(row.source_tier).toBe("working");
		} finally {
			beamA.close();
		}
	});

	it("get-by-id resolves a channel fact for a session in the channel", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope, channel_id) VALUES ('ch7', 't', 'session-a', 'channel', 'chan-7')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ch7");
			const factId = (beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'ch7'").get() as { fact_id: string }).fact_id;
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				expect(get(beamB, factId)).toBeNull();
				expect(get(beamB, factId, "chan-7")).not.toBeNull();
			} finally {
				beamB.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("legacy unprovenanced facts retire when the colliding episode is force-overwritten", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('leg7', 'working text', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('leg7', 'old episode', 'session-a', 'global')",
			);
			// A pre-provenance fact: no source_tier value (NULL), so its true
			// tier is unknown.
			beamA.db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, timestamp, source_msg_id, confidence, scope) VALUES ('leg7-f', 'session-a', 'I', 'use', 'the quorum relay for tokens', '2026-01-01T00:00:00.000Z', 'leg7', 0.7, 'global')",
			);
			const stats = importFromDict(
				beamA,
				{ episodic_memory: [{ id: "leg7", content: "replacement episode", session_id: "session-a", scope: "global" }] },
				true,
			);
			expect(stats.episodic_memory.overwritten).toBe(1);
			// The legacy NULL-tier fact is ambiguous, so the colliding episode
			// replacement retires it conservatively.
			expect((beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'leg7'").all() as unknown[]).length).toBe(0);
		} finally {
			beamA.close();
		}
	});

	it("legacy NULL-generation rows still suppress duplicate extraction", async () => {
		let calls = 0;
		const gate = Promise.withResolvers<void>();
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		// A pre-upgrade row: no generation token at all.
		beamA.db.run(
			"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('leg8', 'stored text', 'session-a', 'global')",
		);
		beamA.close();
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath,
			llm: {
				enabled: true,
				complete: async () => {
					calls++;
					if (calls === 1) await gate.promise;
					return "I use the quorum relay for tokens";
				},
			},
		});
		try {
			const id = memory.remember("stored text", { source: "test", extract: true });
			expect(id).toBe("leg8");
			for (let i = 0; i < 10_000 && memory.beam.pendingExtractionIds.size !== 1; i++) {
				await Promise.resolve();
			}
			expect(memory.beam.pendingExtractionIds.size).toBe(1);
			// A second identical request while the first is still in flight is
			// suppressed — including for NULL-generation legacy rows, where both
			// tasks would otherwise validate against the same NULL snapshot.
			const dup = memory.remember("stored text", { source: "test", extract: true });
			expect(dup).toBe("leg8");
			expect(calls).toBe(1);
			gate.resolve();
			await memory.flushExtractions();
			expect(calls).toBe(1);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("re-extraction refreshes a conflict fact's provenance without widening it", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope, channel_id) VALUES ('re1', 't', 'session-a', 'channel', 'chan-A')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "re1");
			const before = beamA.db.query("SELECT channel_id, scope FROM facts WHERE source_msg_id = 're1'").get() as { channel_id: string | null; scope: string };
			expect(before.channel_id).toBe("chan-A");
			// The source moves to another channel; re-extraction hits the same
			// stable fact id and must refresh the channel stamp...
			beamA.db.run("UPDATE working_memory SET channel_id = 'chan-B' WHERE id = 're1'");
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "re1");
			const after = beamA.db.query("SELECT channel_id, scope, session_id FROM facts WHERE source_msg_id = 're1'").get() as { channel_id: string | null; scope: string; session_id: string };
			expect(after.channel_id).toBe("chan-B");
			// ...while scope and owner stay untouched (no retroactive widening).
			expect(after.scope).toBe(before.scope);
			expect(after.session_id).toBe("session-a");
			// Recall now follows the source's current channel...
			const beamB = new BeamMemory({ sessionId: "session-b", dbPath });
			try {
				const inB = factRecall(beamB, "quorum relay", 30, "chan-B") as { content: string }[];
				expect(inB.some(h => h.content.includes("quorum relay"))).toBe(true);
				const inA = factRecall(beamB, "quorum relay", 30, "chan-A") as { content: string }[];
				expect(inA.some(h => h.content.includes("quorum relay"))).toBe(false);
			} finally {
				beamB.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("public extraction over a colliding id never outshines the narrower source", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('colx', 'w', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('colx', 'e', 'session-b', 'session')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "colx");
			const row = beamA.db.query("SELECT scope, source_tier, channel_id FROM facts WHERE source_msg_id = 'colx'").get() as { scope: string; source_tier: string | null; channel_id: string | null };
			// The untyped id is ambiguous: the fact takes the NARROWER of the
			// two sources' scopes and no tier/channel stamp, so recall keeps
			// the conservative both-tiers probe.
			expect(row.scope).toBe("session");
			expect(row.source_tier).toBeNull();
			expect(row.channel_id).toBeNull();
			// ...and the private episode's owner dominates: no other session
			// sees the fact — not even the owner of the global working row.
			const beamC = new BeamMemory({ sessionId: "session-c", dbPath });
			try {
				const hits = factRecall(beamC, "quorum relay", 30) as { content: string }[];
				expect(hits.some(h => h.content.includes("quorum relay"))).toBe(false);
			} finally {
				beamC.close();
			}
			const own = factRecall(beamA, "quorum relay", 30) as { content: string }[];
			expect(own.some(h => h.content.includes("quorum relay"))).toBe(false);
		} finally {
			beamA.close();
		}
	});

	it("a changed extractText replaces the pending extraction instead of coalescing", async () => {
		let calls = 0;
		const g1 = Promise.withResolvers<void>();
		const g2 = Promise.withResolvers<void>();
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: {
				enabled: true,
				complete: async () => {
					calls++;
					if (calls === 1) await g1.promise;
					if (calls === 2) await g2.promise;
					return calls === 1 ? "I use the quorum relay for tokens" : "I use the backup vault for keys";
				},
			},
		});
		try {
			const id = memory.remember("stored text", { source: "test", extract: true, extractText: "override A" });
			expect(id).toBeTruthy();
			// Same stored content and scope, a different extraction override
			// while the first task is in flight: a replacement, not a coalesce.
			const dup = memory.remember("stored text", { source: "test", extract: true, extractText: "override B" });
			expect(dup).toBe(id);
			for (let i = 0; i < 10_000 && memory.beam.pendingExtractionIds.size !== 2; i++) {
				await Promise.resolve();
			}
			expect(memory.beam.pendingExtractionIds.size).toBe(2);
			g1.resolve();
			g2.resolve();
			await memory.flushExtractions();
			expect(calls).toBe(2);
			// The superseded task's unique facts are discarded; the replacement
			// task's persist.
			const objs = (memory.conn.query("SELECT object FROM facts").all() as { object: string }[]).map(r => r.object);
			expect(objs.some(o => o.includes("backup vault"))).toBe(true);
			expect(objs.some(o => o.includes("quorum relay"))).toBe(false);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("direct extraction from a vanished source stays private", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			// The source row is gone (forgotten between the caller's snapshot
			// and the write): the inherited-scope fallback must be the
			// conservative 'session', never 'global'.
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "ghost-id");
			const row = beamA.db.query("SELECT scope FROM facts WHERE source_msg_id = 'ghost-id'").get() as { scope: string } | null;
			expect(row).not.toBeNull();
			expect(row!.scope).toBe("session");
			const beamC = new BeamMemory({ sessionId: "session-c", dbPath });
			try {
				const hits = factRecall(beamC, "quorum relay", 30) as { content: string }[];
				expect(hits.some(h => h.content.includes("quorum relay"))).toBe(false);
			} finally {
				beamC.close();
			}
		} finally {
			beamA.close();
		}
	});

	it("background extraction completes for a conservatively-scoped colliding id", async () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		beamA.db.run("INSERT INTO working_memory (id, content, session_id, scope) VALUES ('cfx', 'stored text', 'session-a', 'global')");
		beamA.db.run("INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('cfx', 'e', 'session-b', 'session')");
		beamA.close();
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath,
			llm: {
				enabled: true,
				complete: async () => "I use the quorum relay for tokens",
			},
		});
		try {
			const id = memory.remember("stored text", { source: "test", extract: true });
			expect(id).toBe("cfx");
			await memory.flushExtractions();
			// The conservative inherited scope ('session', narrower of the
			// colliding pair) must be accepted by the async guard instead of
			// being rejected against the raw working row's 'global'.
			const row = memory.conn.query("SELECT scope FROM facts WHERE source_msg_id = 'cfx'").get() as { scope: string } | null;
			expect(row).not.toBeNull();
			expect(row!.scope).toBe("session");
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("an A to B to A extractText sequence honors the latest request", async () => {
		let calls = 0;
		const gates: { promise: Promise<void>; resolve: () => void }[] = [];
		for (let i = 0; i < 3; i++) gates.push(Promise.withResolvers<void>());
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: {
				enabled: true,
				complete: async () => {
					calls++;
					await gates[calls - 1]?.promise;
					return calls === 2 ? "I use the signal lamp for alerts" : "I use the quorum relay for tokens";
				},
			},
		});
		try {
			const id = memory.remember("stored text", { source: "test", extract: true, extractText: "A" });
			expect(id).toBeTruthy();
			memory.remember("stored text", { source: "test", extract: true, extractText: "B" });
			// Back to the original override: the first task was superseded by
			// B, so it must not suppress this request — a new task takes over.
			memory.remember("stored text", { source: "test", extract: true, extractText: "A" });
			for (let i = 0; i < 10_000 && calls !== 3; i++) {
				await Promise.resolve();
			}
			expect(calls).toBe(3);
			for (const g of gates) g.resolve();
			await memory.flushExtractions();
			const objs = (memory.conn.query("SELECT object FROM facts").all() as { object: string }[]).map(r => r.object);
			// The latest request (A) persists; B was superseded.
			expect(objs.some(o => o.includes("quorum relay"))).toBe(true);
			expect(objs.some(o => o.includes("signal lamp"))).toBe(false);
			// After every task settles, the generation's cancel entry is
			// retired — the bookkeeping maps do not grow per extraction.
			for (let i = 0; i < 10_000 && memory.beam.extractionCancelSeq.size !== 0; i++) {
				await Promise.resolve();
			}
			expect(memory.beam.extractionCancelSeq.size).toBe(0);
			expect(memory.beam.pendingExtractionIds.size).toBe(0);
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});
	it("a mid-flight collision re-scope replaces the pending extraction", async () => {
		let calls = 0;
		const g1 = Promise.withResolvers<void>();
		const g2 = Promise.withResolvers<void>();
		const memory = new Mnemopi({
			sessionId: "session-a",
			dbPath: tempDb(),
			llm: {
				enabled: true,
				complete: async () => {
					calls++;
					if (calls === 1) await g1.promise;
					if (calls === 2) await g2.promise;
					return "I use the quorum relay for tokens";
				},
			},
		});
		try {
			const id = memory.remember("stored text", { source: "test", scope: "global", extract: true });
			expect(id).toBeTruthy();
			for (let i = 0; i < 10_000 && memory.beam.pendingExtractionIds.size !== 1; i++) {
				await Promise.resolve();
			}
			// While the first task waits on the LLM, a same-id episode appears
			// with a narrower scope: the inherited scope of the working source
			// changes, so the pending task will discard itself on validation.
			memory.beam.db.run("INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('" + id + "', 'e', 'session-b', 'session')");
			// The next identical request must NOT be suppressed — it schedules a
			// replacement bound to the new (narrower) inherited scope. (Explicit
			// 'global' scope so the facade default does not re-scope the row.)
			const dup = memory.remember("stored text", { source: "test", scope: "global", extract: true });
			expect(dup).toBe(id);
			for (let i = 0; i < 10_000 && calls !== 2; i++) {
				await Promise.resolve();
			}
			g1.resolve();
			g2.resolve();
			await memory.flushExtractions();
			expect(calls).toBe(2);
			const row = memory.conn.query("SELECT scope FROM facts WHERE source_msg_id = ?").get(id) as { scope: string } | null;
			expect(row).not.toBeNull();
			expect(row!.scope).toBe("session");
		} finally {
			await memory.flushExtractions();
			memory.close();
		}
	});

	it("force-import replacing both tiers of a shared id purges the full artifact set", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			beamA.db.run(
				"INSERT INTO working_memory (id, content, session_id, scope) VALUES ('b9', 'old working', 'session-a', 'global')",
			);
			beamA.db.run(
				"INSERT INTO episodic_memory (id, content, session_id, scope) VALUES ('b9', 'old episode', 'session-a', 'global')",
			);
			storeFactStrings(beamA, ["I use the quorum relay for tokens"], 0, "b9");
			beamA.db.run("INSERT INTO gists (id, text, memory_id) VALUES ('gist_b9', 'old gist', 'b9')");
			beamA.db.run(
				"INSERT INTO graph_edges (source, target, edge_type, weight, timestamp) VALUES ('b9', 'node-b9', 'ctx', 1, '2026-01-01T00:00:00.000Z')",
			);
			const stats = importFromDict(
				beamA,
				{
					working_memory: [{ id: "b9", content: "new working", session_id: "session-a", scope: "global" }],
					episodic_memory: [{ id: "b9", content: "new episode", session_id: "session-a", scope: "global" }],
				},
				true,
			);
			expect(stats.working_memory.overwritten).toBe(1);
			expect(stats.episodic_memory.overwritten).toBe(1);
			// Neither old source survives: the shared untyped artifacts (facts,
			// gists, raw-memory edges) die with them in one full purge.
			expect((beamA.db.query("SELECT fact_id FROM facts WHERE source_msg_id = 'b9'").all() as unknown[]).length).toBe(0);
			expect((beamA.db.query("SELECT id FROM gists WHERE memory_id = 'b9'").all() as unknown[]).length).toBe(0);
			expect((beamA.db.query("SELECT source FROM graph_edges WHERE source = 'b9' OR target = 'node-b9'").all() as unknown[]).length).toBe(0);
			// ...while the replacement rows are live.
			expect((beamA.db.query("SELECT content FROM working_memory WHERE id = 'b9'").get() as { content: string }).content).toBe("new working");
			expect((beamA.db.query("SELECT content FROM episodic_memory WHERE id = 'b9'").get() as { content: string }).content).toBe("new episode");
		} finally {
			beamA.close();
		}
	});
});
