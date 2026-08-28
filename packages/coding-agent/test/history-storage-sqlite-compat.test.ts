import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readTableSql } from "./helpers/sqlite-inspect";

const LEGACY_TIMESTAMP = 1_700_000_000;

let tempDir: TempDir | null = null;

beforeEach(() => {
	HistoryStorage.resetInstance();
});

afterEach(async () => {
	HistoryStorage.resetInstance();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

it("migrates legacy history schema away from unixepoch defaults", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-legacy-");
	const dbPath = tempDir.join("history.db");
	const legacyDb = new Database(dbPath);
	legacyDb.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			cwd TEXT
		);
	`);
	legacyDb
		.prepare("INSERT INTO history (prompt, created_at, cwd) VALUES (?, ?, ?)")
		.run("legacy prompt", LEGACY_TIMESTAMP, "/tmp/legacy");
	legacyDb.close();

	const storage = HistoryStorage.open(dbPath);
	await storage.add("new prompt", "/tmp/new");

	const db = new Database(dbPath, { readonly: true });
	try {
		const prompts = db.prepare("SELECT prompt FROM history ORDER BY id ASC").all() as Array<{ prompt: string }>;
		expect(prompts).toEqual([{ prompt: "legacy prompt" }, { prompt: "new prompt" }]);
		expect(readTableSql(dbPath, "history")).not.toContain("unixepoch(");
		expect(readTableSql(dbPath, "history")).toContain("strftime('%s','now')");
		const indexRow = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_history_created_at'")
			.get() as { present?: number } | undefined;
		expect(indexRow?.present).toBe(1);
		const ftsRow = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'history_fts'")
			.get() as { present?: number } | undefined;
		expect(ftsRow?.present).toBe(1);
	} finally {
		db.close();
	}
});
it("collapses duplicate prompts and keeps the latest project metadata", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-deduplicate-");
	const dbPath = tempDir.join("history.db");
	const legacyDb = new Database(dbPath);
	legacyDb.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
			cwd TEXT,
			session_id TEXT
		);
	`);
	const insert = legacyDb.prepare("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?)");
	insert.run("shared prompt", 1, "/projects/first", "first-session");
	insert.run("shared prompt", 2, "/projects/second", "second-session");
	legacyDb.close();

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10)).toEqual([
		{
			id: 2,
			prompt: "shared prompt",
			created_at: 2,
			cwd: "/projects/second",
			sessionId: "second-session",
		},
	]);

	await storage.add("shared prompt", "/projects/latest", "latest-session");

	const [latest] = storage.getRecent(10);
	expect(storage.getRecent(10)).toHaveLength(1);
	expect(latest?.cwd).toBe("/projects/latest");
	expect(latest?.sessionId).toBe("latest-session");
	expect(latest?.created_at).toBeGreaterThan(2);
	expect(storage.search("shared", 10).map(entry => entry.sessionId)).toEqual(["latest-session"]);

	const verify = new Database(dbPath);
	try {
		expect(() => verify.prepare("INSERT INTO history (prompt) VALUES (?)").run("shared prompt")).toThrow();
	} finally {
		verify.close();
	}
});
it("normalizes per-line trailing whitespace so padded resubmissions upsert instead of duplicating", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-normalize-");
	const storage = HistoryStorage.open(tempDir.join("history.db"));

	await storage.add("line one   \t\r\nline two  ", "/projects/first", "first-session");
	await storage.add("line one\nline two", "/projects/second", "second-session");

	const entries = storage.getRecent(10);
	expect(entries).toHaveLength(1);
	expect(entries[0]?.prompt).toBe("line one\nline two");
	expect(entries[0]?.sessionId).toBe("second-session");
});

it("collapses preexisting whitespace-padded duplicates on open, keeping the latest provenance", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-padded-");
	const dbPath = tempDir.join("history.db");
	HistoryStorage.open(dbPath);
	HistoryStorage.resetInstance();

	const raw = new Database(dbPath);
	const insert = raw.prepare("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?)");
	insert.run("keep me tidy\nplease", 1, "/projects/old", "old-session");
	insert.run("keep me tidy   \nplease", 2, "/projects/new", "new-session");
	raw.run("PRAGMA user_version = 0");
	raw.close();

	const storage = HistoryStorage.open(dbPath);
	const entries = storage.getRecent(10);
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		prompt: "keep me tidy\nplease",
		created_at: 2,
		cwd: "/projects/new",
		sessionId: "new-session",
	});
	// FTS was rebuilt after the delete+update, so no stale index rows remain.
	expect(storage.search("tidy", 10).map(entry => entry.sessionId)).toEqual(["new-session"]);
});
