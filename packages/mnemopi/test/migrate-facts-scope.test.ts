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

function tempDb(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-facts-e7-"));
	roots.push(root);
	return join(root, "bank.db");
}

beforeEach(() => {
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

afterEach(() => {
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
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
		expect(hasPendingMigration(openDatabase(dbPath))).toBe(false);
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
});

describe("E7 facts scope recall, end to end", () => {
	it("recalls a fact extracted in session A from session B", () => {
		const dbPath = tempDb();
		const beamA = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			const cols = beamA.db.query("PRAGMA table_info(facts)").all() as { name: string }[];
			expect(cols.some(row => row.name === "scope")).toBe(true);
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

	it("storeExtractedFactCategories honors the inherited scope", () => {
		const dbPath = tempDb();
		const beam = new BeamMemory({ sessionId: "session-a", dbPath });
		try {
			storeExtractedFactCategories(
				beam,
				{ facts: ["Quorum relay requires tokens"], instructions: [], preferences: [], timelines: [], kg: [] },
				0,
				"wm-1",
				0.7,
				"session",
			);
			const rows = beam.db
				.query("SELECT scope FROM facts WHERE source_msg_id = 'wm-1'")
				.all() as { scope: string }[];
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(row.scope).toBe("session");
		} finally {
			beam.close();
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
