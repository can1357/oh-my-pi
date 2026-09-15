import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

function freshStorage(prefix = "omp-history-scope-"): { storage: HistoryStorage; dbPath: string } {
	tempDir = TempDir.createSync(`@${prefix}`);
	const dbPath = tempDir.join("history.db");
	HistoryStorage.close();
	return { storage: HistoryStorage.open(dbPath), dbPath };
}

beforeEach(() => {
	HistoryStorage.close();
});

afterEach(async () => {
	HistoryStorage.close();
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("HistoryStorage recall scopes", () => {
	it("keeps global recall unfiltered", async () => {
		const { storage } = freshStorage();
		await storage.add("alpha prompt", "/repo-a", "session-a");
		await storage.add("beta prompt", "/repo-b", "session-b");

		expect(storage.getRecent(10).map(entry => entry.prompt)).toEqual(["beta prompt", "alpha prompt"]);
		expect(storage.search("prompt", 10)).toHaveLength(2);
	});

	it("restricts recent and search to the requested project", async () => {
		const { storage } = freshStorage();
		await storage.add("alpha prompt", "/repo-a", "session-a");
		await storage.add("beta prompt", "/repo-b", "session-b");

		expect(storage.getRecent(10, { cwd: "/repo-a" }).map(entry => entry.prompt)).toEqual(["alpha prompt"]);
		expect(storage.search("prompt", 10, { cwd: "/repo-b" }).map(entry => entry.prompt)).toEqual(["beta prompt"]);
	});

	it("restricts recent and search to the requested session", async () => {
		const { storage } = freshStorage();
		await storage.add("first session prompt", "/repo", "session-a");
		await storage.add("second session prompt", "/repo", "session-b");

		expect(storage.getRecent(10, { sessionId: "session-a" }).map(entry => entry.prompt)).toEqual([
			"first session prompt",
		]);
		expect(storage.search("session", 10, { sessionId: "session-b" }).map(entry => entry.prompt)).toEqual([
			"second session prompt",
		]);
	});

	it("keeps a reused prompt visible in every scope it was submitted from", async () => {
		const { storage } = freshStorage();
		await storage.add("shared prompt", "/repo-a", "session-a");
		await storage.add("shared prompt", "/repo-b", "session-b");

		// The prompt row keeps only the latest provenance, so scoping on it alone
		// would drop the first project/session entirely.
		expect(storage.getRecent(10, { cwd: "/repo-a" }).map(entry => entry.prompt)).toEqual(["shared prompt"]);
		expect(storage.getRecent(10, { cwd: "/repo-b" }).map(entry => entry.prompt)).toEqual(["shared prompt"]);
		expect(storage.getRecent(10, { sessionId: "session-a" }).map(entry => entry.prompt)).toEqual(["shared prompt"]);
		expect(storage.search("shared", 10, { sessionId: "session-b" }).map(entry => entry.prompt)).toEqual([
			"shared prompt",
		]);
		// One row per prompt, not one per recorded submission.
		expect(storage.getRecent(10, { cwd: "/repo-a" })).toHaveLength(1);
	});

	it("matches both fields when a scope names a project and a session", async () => {
		const { storage } = freshStorage();
		await storage.add("scoped prompt", "/repo-a", "session-a");

		expect(storage.getRecent(10, { cwd: "/repo-a", sessionId: "session-a" })).toHaveLength(1);
		expect(storage.getRecent(10, { cwd: "/repo-a", sessionId: "session-b" })).toHaveLength(0);
		expect(storage.getRecent(10, { cwd: "/repo-b", sessionId: "session-a" })).toHaveLength(0);
	});

	it("ranks scoped recall by the submission made inside the scope", async () => {
		const { storage, dbPath } = freshStorage();
		await storage.add("older elsewhere", "/repo-a", "session-a");
		await storage.add("newer elsewhere", "/repo-b", "session-b");
		HistoryStorage.close();

		// Age the /repo-a submission of a prompt that was also used in /repo-b, so
		// global recency and /repo-a recency disagree.
		const db = new Database(dbPath);
		db.run("UPDATE history SET created_at = created_at + 100 WHERE prompt = 'newer elsewhere'");
		db.run("UPDATE history_usage SET used_at = used_at + 100 WHERE cwd = '/repo-b'");
		db.run(
			"INSERT INTO history_usage (prompt_id, cwd, session_id, used_at) SELECT id, '/repo-a', 'session-a', created_at + 200 FROM history WHERE prompt = 'newer elsewhere'",
		);
		db.close();

		const storage2 = HistoryStorage.open(dbPath);
		expect(storage2.getRecent(10, { cwd: "/repo-a" }).map(entry => entry.prompt)).toEqual([
			"newer elsewhere",
			"older elsewhere",
		]);
		const [newest] = storage2.getRecent(10, { cwd: "/repo-a" });
		const [globalNewest] = storage2.getRecent(10);
		// Scoped rows report the in-scope submission time, not the global one.
		expect(newest?.created_at).toBeGreaterThan(globalNewest?.created_at ?? 0);
	});

	it("backfills a pre-existing database from its stored provenance", async () => {
		tempDir = TempDir.createSync("@omp-history-scope-legacy-");
		const dbPath = tempDir.join("history.db");
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				prompt TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				cwd TEXT,
				session_id TEXT
			);
			INSERT INTO history (prompt, cwd, session_id) VALUES ('legacy prompt', '/legacy', 'legacy-session');
			INSERT INTO history (prompt, cwd, session_id) VALUES ('unstamped prompt', NULL, NULL);
			PRAGMA user_version = 1;
		`);
		legacyDb.close();

		HistoryStorage.close();
		const storage = HistoryStorage.open(dbPath);

		expect(storage.getRecent(10, { cwd: "/legacy" }).map(entry => entry.prompt)).toEqual(["legacy prompt"]);
		expect(storage.getRecent(10, { sessionId: "legacy-session" }).map(entry => entry.prompt)).toEqual([
			"legacy prompt",
		]);
		expect(storage.getRecent(10, { cwd: "/other" })).toHaveLength(0);
		// Rows stored without provenance stay out of every named scope but remain in global recall.
		expect(storage.getRecent(10).map(entry => entry.prompt)).toContain("unstamped prompt");
	});
});
