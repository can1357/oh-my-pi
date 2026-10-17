import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { lookupSessionTitle, resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import * as utils from "@oh-my-pi/pi-utils";
import { readLines, TempDir } from "@oh-my-pi/pi-utils";
import { readTableSql } from "./helpers/sqlite-inspect";

const LEGACY_TIMESTAMP = 1_700_000_000;

let tempDir: TempDir | null = null;

beforeEach(() => {
	HistoryStorage.close();
});

afterEach(async () => {
	vi.restoreAllMocks();
	HistoryStorage.close();
	resetSessionIndexForTests();
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
			useCount: 2,
		},
	]);

	await storage.add("shared prompt", "/projects/latest", "latest-session");

	const [latest] = storage.getRecent(10);
	expect(storage.getRecent(10)).toHaveLength(1);
	expect(latest?.cwd).toBe("/projects/latest");
	expect(latest?.sessionId).toBe("latest-session");
	expect(latest?.created_at).toBeGreaterThan(2);
	expect(latest?.useCount).toBe(3);
	expect(storage.search("shared", 10).map(entry => entry.sessionId)).toEqual(["latest-session"]);

	const verify = new Database(dbPath);
	try {
		expect(() => verify.prepare("INSERT INTO history (prompt) VALUES (?)").run("shared prompt")).toThrow();
	} finally {
		verify.close();
	}
});
it("adds use_count to a rebuilt store in place, without another rebuild", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-use-count-");
	const dbPath = tempDir.join("history.db");
	const v1Db = new Database(dbPath);
	v1Db.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
			cwd TEXT,
			session_id TEXT
		);
		PRAGMA user_version = 2;
	`);
	v1Db
		.prepare("INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?, ?)")
		.run(7, "counted prompt", LEGACY_TIMESTAMP, "/tmp/v1", "v1-session");
	v1Db.close();

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10)).toEqual([
		{
			id: 7,
			prompt: "counted prompt",
			created_at: LEGACY_TIMESTAMP,
			cwd: "/tmp/v1",
			sessionId: "v1-session",
			useCount: 1,
		},
	]);
	await storage.add("counted prompt", "/tmp/again", "again-session");
	expect(storage.getRecent(10).map(entry => [entry.id, entry.useCount])).toEqual([[7, 2]]);
	HistoryStorage.close();

	const verify = new Database(dbPath);
	try {
		expect(verify.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
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
	HistoryStorage.close();

	const raw = new Database(dbPath);
	const insert = raw.prepare(
		"INSERT INTO history (prompt, created_at, cwd, session_id, use_count) VALUES (?, ?, ?, ?, ?)",
	);
	insert.run("keep me tidy\nplease", 1, "/projects/old", "old-session", 4);
	insert.run("keep me tidy   \nplease", 2, "/projects/new", "new-session", 1);
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
		useCount: 5,
	});
	// FTS was rebuilt after the delete+update, so no stale index rows remain.
	expect(storage.search("tidy", 10).map(entry => entry.sessionId)).toEqual(["new-session"]);
});

// #13926: report failed persistence once per outage without changing the log-only promise contract.
it("reports failed writes once per outage and permits persistence after recovery", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-write-failure-");
	const dbPath = tempDir.join("history.db");
	const storage = HistoryStorage.open(dbPath);
	const peer = new Database(dbPath);
	const reportFailure = vi.fn();
	const reportSuccess = vi.fn();
	storage.setErrorListener(reportFailure);
	storage.setAddListener(reportSuccess);
	try {
		peer.run(
			"CREATE TRIGGER reject_prompt BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'write rejected'); END",
		);
		await storage.add("lost while locked", "/project", "session");
		await storage.add("lost again while locked", "/project", "session");
		expect(reportFailure).toHaveBeenCalledTimes(1);
		expect(reportFailure).toHaveBeenCalledWith(expect.any(Error));
		expect(reportSuccess).not.toHaveBeenCalled();
		peer.run("DROP TRIGGER reject_prompt");
		expect(storage.getRecent(10)).toEqual([]);

		await storage.add("lost while locked", "/project", "session");
		expect(reportSuccess).toHaveBeenCalledTimes(1);
		peer.run("CREATE TRIGGER reject_again BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'write rejected'); END");
		await storage.add("lost after recovery", "/project", "session");
		expect(reportFailure).toHaveBeenCalledTimes(2);
		expect(reportSuccess).toHaveBeenCalledTimes(1);
		peer.run("DROP TRIGGER reject_again");
		HistoryStorage.close();
		const reopened = HistoryStorage.open(dbPath);
		expect(reopened.search("locked", 10)).toMatchObject([
			{ prompt: "lost while locked", cwd: "/project", sessionId: "session", useCount: 1 },
		]);
	} finally {
		if (peer.inTransaction) peer.run("ROLLBACK");
		peer.close();
	}
});

// A damaged b-tree can decode another table's BLOB as `prompt`; recalling it in
// the editor threw "text.replace is not a function" on Up-arrow.
it.each([
	{ store: "a current store", userVersion: 2 },
	{ store: "a store awaiting the rebuild pass", userVersion: 1 },
])("never returns a non-text prompt from $store", async ({ userVersion }) => {
	tempDir = TempDir.createSync("@omp-history-storage-blob-prompt-");
	const dbPath = tempDir.join("history.db");
	await HistoryStorage.open(dbPath).add("readable prompt", "/project", "session");
	HistoryStorage.close();
	const raw = new Database(dbPath);
	raw.prepare("INSERT INTO history (prompt, created_at) VALUES (?, ?)").run(
		new Uint8Array([0x30, 0x15]),
		4_000_000_000,
	);
	raw.run(`PRAGMA user_version = ${userVersion}`);
	raw.close();

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10).map(entry => entry.prompt)).toEqual(["readable prompt"]);
	expect(storage.search("readable", 10).map(entry => entry.prompt)).toEqual(["readable prompt"]);
});

/**
 * Seeds two prompts (ids 1, 2), a title, and a recap (id 1), then scribbles
 * over the created_at index page only: quick_check fails, table pages stay
 * readable.
 */
async function seedDamagedStore(dbPath: string, userVersion: number): Promise<void> {
	const storage = HistoryStorage.open(dbPath);
	await storage.add("first prompt", "/project", "session-a");
	await storage.add("second prompt", "/project", "session-b");
	HistoryStorage.close();

	const raw = new Database(dbPath);
	raw.exec(`
		CREATE TABLE session_titles (
			session_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
		INSERT INTO session_titles (session_id, title, updated_at) VALUES ('session-a', 'kept title', 5);
		CREATE TABLE session_recaps (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			recap TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES ('session-a', '/project', 'kept recap', 5);
		PRAGMA user_version = ${userVersion};
		PRAGMA journal_mode = DELETE;
	`);
	const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const indexRoot = raw
		.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name = 'idx_history_created_at'")
		.get()!.rootpage;
	raw.close();
	const fd = fs.openSync(dbPath, "r+");
	fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (indexRoot - 1) * pageSize);
	fs.closeSync(fd);
}

it("quarantines a damaged store on the rebuild pass and salvages its prompts and recaps", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-damaged-");
	const dbPath = tempDir.join("history.db");
	await seedDamagedStore(dbPath, 1);

	const repaired = HistoryStorage.open(dbPath);
	expect(repaired.getRecent(10).map(entry => entry.prompt)).toEqual(["second prompt", "first prompt"]);
	await repaired.add("after repair", "/project", "session-c");
	expect(repaired.search("repair", 10).map(entry => entry.prompt)).toEqual(["after repair"]);
	HistoryStorage.close();

	expect(fs.readdirSync(tempDir.path()).some(name => name.startsWith("history.db.corrupt-"))).toBe(true);
	const verify = new Database(dbPath, { readonly: true });
	try {
		expect(verify.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all()).toEqual([
			{ integrity_check: "ok" },
		]);
		expect(verify.query("SELECT session_id, recap FROM session_recaps").all()).toEqual([
			{ session_id: "session-a", recap: "kept recap" },
		]);
	} finally {
		verify.close();
	}
});

it("quarantines and salvages a current store damaged after the v2 rebuild", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-runtime-damage-");
	const dbPath = tempDir.join("history.db");
	await seedDamagedStore(dbPath, 2);

	// The open-time integrity check is no longer gated on the data version, so a
	// store damaged after reaching v2 is quarantined and salvaged on the next
	// open instead of surfacing failed reads forever.
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(entry => entry.prompt),
	).toEqual(["second prompt", "first prompt"]);
	HistoryStorage.close();
	expect(fs.readdirSync(tempDir.path()).some(name => name.startsWith("history.db.corrupt-"))).toBe(true);

	const verify = new Database(dbPath, { readonly: true });
	try {
		expect(verify.query("SELECT session_id, title FROM session_titles").all()).toEqual([
			{ session_id: "session-a", title: "kept title" },
		]);
		expect(verify.query("SELECT session_id, recap FROM session_recaps").all()).toEqual([
			{ session_id: "session-a", recap: "kept recap" },
		]);
	} finally {
		verify.close();
	}
});

it("keeps a peer's rows and every salvaged row when the peer writes to the replacement first", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-salvage-race-");
	const dbPath = tempDir.join("history.db");
	await seedDamagedStore(dbPath, 1);
	const readDamaged = utils.readDamagedSqliteRows;
	let peerWrote = false;
	vi.spyOn(utils, "readDamagedSqliteRows").mockImplementation((db, table, columns, predicate) => {
		if (!peerWrote) {
			peerWrote = true;
			const peer = new Database(dbPath);
			peer.exec(`
				INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (1, 'peer prompt', 9000000000, '/peer', 'peer-session');
				INSERT INTO history (id, prompt, created_at, cwd, session_id) VALUES (2, 'second prompt', 9000000001, '/peer', 'peer-session');
				CREATE TABLE IF NOT EXISTS session_recaps (
					id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
					recap TEXT NOT NULL, created_at INTEGER NOT NULL
				);
				INSERT INTO session_recaps (id, session_id, cwd, recap, created_at) VALUES (1, 'peer-session', '/peer', 'peer recap', 9);
			`);
			peer.close();
		}
		return readDamaged(db, table, columns, predicate);
	});

	const storage = HistoryStorage.open(dbPath);
	expect(
		storage.getRecent(10).map(entry => ({ prompt: entry.prompt, cwd: entry.cwd, useCount: entry.useCount })),
	).toEqual([
		{ prompt: "second prompt", cwd: "/peer", useCount: 2 },
		{ prompt: "peer prompt", cwd: "/peer", useCount: 1 },
		{ prompt: "first prompt", cwd: "/project", useCount: 1 },
	]);
	HistoryStorage.close();
	const verify = new Database(dbPath, { readonly: true });
	try {
		expect(verify.query("SELECT recap FROM session_recaps ORDER BY recap").all()).toEqual([
			{ recap: "kept recap" },
			{ recap: "peer recap" },
		]);
	} finally {
		verify.close();
	}
});

/** Seeds a readable backup store holding one prompt that quarantine would have preserved. */
function seedSalvageBackup(backupPath: string): void {
	const backup = new Database(backupPath);
	backup.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			cwd TEXT,
			session_id TEXT,
			use_count INTEGER NOT NULL DEFAULT 1
		);
	`);
	backup
		.query("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?)")
		.run("stranded prompt", 1_700_000_000, "/project", "session-a");
	backup.close();
}

function queueBackup(dbPath: string, backupPath: string): void {
	fs.writeFileSync(`${dbPath}.pending-salvage`, JSON.stringify([{ backupName: path.basename(backupPath) }]));
}

it("salvages a recorded backup whose earlier pass was deferred", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-pending-salvage-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	// A prior open crashed or lost the write-lock race mid-salvage: only the
	// backup and its marker remain.
	seedSalvageBackup(backupPath);
	queueBackup(dbPath, backupPath);

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10).map(entry => entry.prompt)).toEqual(["stranded prompt"]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("finishes salvage despite malformed counters and does not replay recovered rows", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-bad-counter-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	const backup = new Database(backupPath);
	backup.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER,
			cwd TEXT, session_id TEXT, use_count INTEGER
		);
		INSERT INTO history VALUES
			(1, 'kept prompt', 1, NULL, NULL, 3),
			(2, 'null count', 2, NULL, NULL, NULL),
			(3, 'text count', 3, NULL, NULL, 'invalid'),
			(4, 'blob count', 4, NULL, NULL, X'0102');
	`);
	backup.close();
	queueBackup(dbPath, backupPath);

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10)).toMatchObject([{ prompt: "kept prompt", useCount: 3 }]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
	await storage.add("after salvage");
	HistoryStorage.close();
	const reopened = HistoryStorage.open(dbPath);
	expect(reopened.search("kept", 10)).toMatchObject([{ prompt: "kept prompt", useCount: 3 }]);
	expect(reopened.search("after", 10).map(entry => entry.prompt)).toEqual(["after salvage"]);
});

it("salvages legacy backups without a counter using the submission default", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-legacy-backup-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	const backup = new Database(backupPath);
	backup.exec(`
		CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER, cwd TEXT);
		INSERT INTO history VALUES (1, 'legacy recovered prompt', 1, '/legacy');
	`);
	backup.close();
	queueBackup(dbPath, backupPath);

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10)).toMatchObject([{ prompt: "legacy recovered prompt", cwd: "/legacy", useCount: 1 }]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("defers a salvage whose insert loses the write lock to a peer, then retries it", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-busy-salvage-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	seedSalvageBackup(backupPath);
	queueBackup(dbPath, backupPath);

	// A peer takes the replacement's write lock right before the salvage insert
	// and holds it past the busy timeout — the same race gc-cli's long
	// transaction creates.
	const readDamaged = utils.readDamagedSqliteRows;
	let peer: Database | undefined;
	vi.spyOn(utils, "readDamagedSqliteRows").mockImplementation(
		<T>(db: Database, table: string, columns: string, predicate?: string) => {
			const result = readDamaged<T>(db, table, columns, predicate);
			if (table === "history" && !peer) {
				peer = new Database(dbPath);
				peer.run("BEGIN IMMEDIATE");
			}
			return result;
		},
	);

	try {
		const locked = HistoryStorage.open(dbPath);
		expect(locked.getRecent(10)).toEqual([]);
		expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(true);
	} finally {
		try {
			peer?.run("ROLLBACK");
		} finally {
			peer?.close();
		}
	}
	HistoryStorage.close();

	const reopened = HistoryStorage.open(dbPath);
	expect(reopened.getRecent(10).map(entry => entry.prompt)).toEqual(["stranded prompt"]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("clears a failed index-open latch when the store is quarantined and replaced", async () => {
	tempDir = TempDir.createSync("@omp-history-index-failed-latch-");
	const dbPath = tempDir.join("history.db");
	vi.spyOn(utils, "getHistoryDbPath").mockReturnValue(dbPath);
	const warnSpy = vi.spyOn(utils.logger, "warn");

	// A failed open latches failedPath; repeated lookups must not reopen or re-warn.
	fs.mkdirSync(dbPath, { recursive: true });
	expect(lookupSessionTitle("session-a")).toBeUndefined();
	for (let i = 0; i < 5; i++) lookupSessionTitle("does-not-matter");
	fs.rmSync(dbPath, { recursive: true });

	// Quarantining a damaged store replaces it; the latch clears so the salvaged titles reopen.
	await seedDamagedStore(dbPath, 1);
	HistoryStorage.open(dbPath);
	HistoryStorage.close();

	expect(lookupSessionTitle("session-a")).toBe("kept title");

	const failures = warnSpy.mock.calls.filter(c => String(c[0] || "").includes("Session index unavailable"));
	expect(failures.length).toBe(1);
});

it("records recovery before the first backup scan and retains it when scanning fails", async () => {
	tempDir = TempDir.createSync("@omp-history-salvage-scan-interruption-");
	const dbPath = tempDir.join("history.db");
	await seedDamagedStore(dbPath, 2);
	let recordedBackup: string | undefined;
	const scan = vi.spyOn(utils, "readDamagedSqliteRows").mockImplementation(() => {
		recordedBackup = fs.readFileSync(`${dbPath}.pending-salvage`, "utf8").trim();
		throw new Error("interrupted backup scan");
	});
	HistoryStorage.open(dbPath);
	if (recordedBackup === undefined) throw new Error("Backup scan did not run");
	expect(fs.readFileSync(`${dbPath}.pending-salvage`, "utf8").trim()).toBe(recordedBackup);
	scan.mockRestore();
	HistoryStorage.close();
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(entry => entry.prompt),
	).toEqual(["second prompt", "first prompt"]);
});

it("does not count prompts or copy recaps twice when a committed backup is replayed", async () => {
	tempDir = TempDir.createSync("@omp-history-salvage-committed-replay-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	await seedDamagedStore(backupPath, 2);
	queueBackup(dbPath, backupPath);
	const first = HistoryStorage.open(dbPath);
	expect(first.getRecent(10).map(entry => entry.useCount)).toEqual([1, 1]);
	await first.add("second prompt", "/new", "new-session");
	HistoryStorage.close();
	// A crash after COMMIT or a failed unlink leaves exactly this journal state.
	queueBackup(dbPath, backupPath);
	const replayed = HistoryStorage.open(dbPath);
	expect(replayed.getRecent(10).map(entry => ({ prompt: entry.prompt, count: entry.useCount }))).toEqual([
		{ prompt: "second prompt", count: 2 },
		{ prompt: "first prompt", count: 1 },
	]);
	HistoryStorage.close();
	const verify = new Database(dbPath, { readonly: true });
	try {
		expect(verify.query("SELECT recap FROM session_recaps").all()).toEqual([{ recap: "kept recap" }]);
	} finally {
		verify.close();
	}
});

it("rolls back prompt salvage and retries all tables when session-index recovery fails", async () => {
	tempDir = TempDir.createSync("@omp-history-salvage-index-interruption-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	await seedDamagedStore(backupPath, 2);
	queueBackup(dbPath, backupPath);
	const readDamaged = utils.readDamagedSqliteRows;
	const scan = vi.spyOn(utils, "readDamagedSqliteRows").mockImplementation((db, table, columns, predicate) => {
		if (table === "session_recaps") throw new Error("interrupted index scan");
		return readDamaged(db, table, columns, predicate);
	});
	expect(HistoryStorage.open(dbPath).getRecent(10)).toEqual([]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(true);
	scan.mockRestore();
	HistoryStorage.close();
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(entry => entry.useCount),
	).toEqual([1, 1]);
	HistoryStorage.close();
	const verify = new Database(dbPath, { readonly: true });
	try {
		expect(verify.query("SELECT title FROM session_titles").all()).toEqual([{ title: "kept title" }]);
		expect(verify.query("SELECT recap FROM session_recaps").all()).toEqual([{ recap: "kept recap" }]);
	} finally {
		verify.close();
	}
});

it("leaves the original store in place when recovery intent cannot be persisted", async () => {
	tempDir = TempDir.createSync("@omp-history-salvage-journal-write-failure-");
	const dbPath = tempDir.join("history.db");
	await seedDamagedStore(dbPath, 2);
	const original = fs.statSync(dbPath, { bigint: true });
	const rename = fs.renameSync;
	const fail = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
		if (String(destination) === `${dbPath}.pending-salvage`) throw new Error("journal publication failed");
		return rename(source, destination);
	});
	expect(() => HistoryStorage.open(dbPath)).toThrow("journal publication failed");
	expect(fs.statSync(dbPath, { bigint: true }).ino).toBe(original.ino);
	fail.mockRestore();
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(entry => entry.prompt),
	).toEqual(["second prompt", "first prompt"]);
});

it("an already-open process writes to the replacement after another process recovers the store", async () => {
	tempDir = TempDir.createSync("@omp-history-live-peer-");
	const dbPath = tempDir.join("history.db");
	await HistoryStorage.open(dbPath).add("before replacement");
	HistoryStorage.close();
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
import { HistoryStorage } from ${JSON.stringify(import.meta.resolve("../src/session/history-storage.ts"))};
import { readLines } from ${JSON.stringify(import.meta.resolve("../../utils/src/stream.ts"))};
const storage = HistoryStorage.open(process.argv[1]);
process.stdout.write("ready\\n");
for await (const _ of readLines(Bun.stdin.stream())) {
	await storage.add("peer after replacement");
	process.stdout.write(JSON.stringify(storage.getRecent(10).map(row => row.prompt)) + "\\n");
	break;
}
HistoryStorage.close();
`,
			dbPath,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const output = readLines(child.stdout);
	const decode = new TextDecoder();
	try {
		expect(decode.decode((await output.next()).value)).toBe("ready");
		await seedDamagedStore(dbPath, 2);
		const replacement = HistoryStorage.open(dbPath);
		expect(replacement.search("first", 10).map(row => row.prompt)).toEqual(["first prompt"]);
		child.stdin.write("continue\n");
		child.stdin.end();
		const observed: unknown = JSON.parse(decode.decode((await output.next()).value));
		expect(observed).toContain("peer after replacement");
		expect(observed).toContain("first prompt");
		expect(await child.exited).toBe(0);
		expect(replacement.search("peer after", 10).map(row => row.prompt)).toEqual(["peer after replacement"]);
	} finally {
		child.kill();
		await child.exited;
		await output.return(undefined);
	}
}, 15_000);

it.each([
	{ mode: "rebuild", empty: false },
	{ mode: "rebuild", empty: true },
	{ mode: "recovery", empty: false },
	{ mode: "recovery", empty: true },
])("preserves prediction cursors across $mode with empty=$empty", async ({ mode, empty }) => {
	tempDir = TempDir.createSync("@omp-history-sequence-cursor-");
	const dbPath = tempDir.join("history.db");
	await HistoryStorage.open(dbPath).add("survivor");
	HistoryStorage.close();
	const raw = new Database(dbPath);
	raw.run("INSERT INTO history (id, prompt) VALUES (1000, 'removed newest')");
	raw.run(empty ? "DELETE FROM history" : "DELETE FROM history WHERE id = 1000");
	raw.run(`PRAGMA user_version = ${mode === "rebuild" ? 1 : 2}`);
	raw.run("PRAGMA journal_mode=DELETE");
	const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const indexRoot = raw
		.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='idx_history_created_at'")
		.get()!.rootpage;
	raw.close();
	if (mode === "recovery") {
		const fd = fs.openSync(dbPath, "r+");
		try {
			fs.writeSync(fd, Buffer.alloc(pageSize, 255), 0, pageSize, (indexRoot - 1) * pageSize);
		} finally {
			fs.closeSync(fd);
		}
	}
	const storage = HistoryStorage.open(dbPath);
	await storage.add("new unlearned prompt");
	const consumer = new Database(dbPath, { readonly: true });
	try {
		// The predictor has persisted cursor=1000 even though GC deleted that row.
		expect(consumer.query("SELECT prompt FROM history WHERE id > ? ORDER BY id").all(1000)).toEqual([
			{ prompt: "new unlearned prompt" },
		]);
	} finally {
		consumer.close();
	}
});

it("checks integrity once per store generation while keeping indexed history operations scan-free", async () => {
	tempDir = TempDir.createSync("@omp-history-integrity-generation-");
	const dbPath = tempDir.join("history.db");
	const check = vi.spyOn(utils, "assertSqliteQuickCheck");
	const storage = HistoryStorage.open(dbPath);
	await storage.add("kept prompt");
	for (let i = 0; i < 3; i++) {
		expect(storage.getRecent(1).map(row => row.prompt)).toEqual(["kept prompt"]);
		expect(storage.search("kept", 1).map(row => row.prompt)).toEqual(["kept prompt"]);
	}
	expect(check.mock.calls.length).toBe(1);
	// The facade remains open while another process replaces the file.
	const replacementPath = tempDir.join("replacement.db");
	fs.copyFileSync(dbPath, replacementPath);
	fs.renameSync(replacementPath, dbPath);
	expect(storage.search("kept", 1).map(row => row.prompt)).toEqual(["kept prompt"]);
	expect(check.mock.calls.length).toBe(2);
});

it("recovers operation-level corruption without rescanning a healthy generation on each lookup", async () => {
	tempDir = TempDir.createSync("@omp-history-operation-corruption-");
	const dbPath = tempDir.join("history.db");
	const storage = HistoryStorage.open(dbPath);
	await storage.add("still readable");
	const raw = new Database(dbPath);
	raw.run("PRAGMA journal_mode=DELETE");
	const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const root = raw
		.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='idx_history_created_at'")
		.get()!.rootpage;
	raw.close();
	const fd = fs.openSync(dbPath, "r+");
	try {
		fs.writeSync(fd, Buffer.alloc(pageSize, 255), 0, pageSize, (root - 1) * pageSize);
	} finally {
		fs.closeSync(fd);
	}
	expect(storage.getRecent(10).map(row => row.prompt)).toEqual(["still readable"]);
	expect(fs.readdirSync(tempDir.path()).some(name => name.startsWith("history.db.corrupt-"))).toBe(true);
});

it.each(["fts", "substring"])("repairs %s corruption found by search after the generation was checked", async kind => {
	tempDir = TempDir.createSync("@omp-history-search-corruption-");
	const dbPath = tempDir.join("history.db");
	const storage = HistoryStorage.open(dbPath);
	await storage.add("searchable prompt");
	const raw = new Database(dbPath);
	if (kind === "fts") {
		raw.run("PRAGMA journal_mode=DELETE");
		const block = raw
			.query<{ block: Uint8Array }, []>("SELECT block FROM history_fts_data WHERE id > 10 LIMIT 1")
			.get()!.block;
		raw.close();
		const bytes = fs.readFileSync(dbPath);
		const offset = bytes.indexOf(block);
		expect(offset).toBeGreaterThan(0);
		const fd = fs.openSync(dbPath, "r+");
		try {
			fs.writeSync(fd, new Uint8Array(block.length).fill(255), 0, block.length, offset);
		} finally {
			fs.closeSync(fd);
		}
	} else {
		raw.run("PRAGMA journal_mode=DELETE");
		const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
		const root = raw
			.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='idx_history_created_at'")
			.get()!.rootpage;
		raw.close();
		const fd = fs.openSync(dbPath, "r+");
		try {
			fs.writeSync(fd, Buffer.alloc(pageSize, 255), 0, pageSize, (root - 1) * pageSize);
		} finally {
			fs.closeSync(fd);
		}
	}
	expect(storage.search("searchable", 10).map(row => row.prompt)).toEqual(["searchable prompt"]);
	expect(fs.readdirSync(tempDir.path()).some(name => name.startsWith("history.db.corrupt-"))).toBe(true);
	await storage.add("new searchable prompt");
	expect(storage.search("new searchable", 10).map(row => row.prompt)).toEqual(["new searchable prompt"]);
});

it("retires an unreadable source without deleting evidence or blocking recovery of a later generation", async () => {
	tempDir = TempDir.createSync("@omp-history-terminal-source-");
	const dbPath = tempDir.join("history.db");
	const damaged = new Uint8Array(4096).fill(255);
	await Bun.write(dbPath, damaged);
	const storage = HistoryStorage.open(dbPath);
	await storage.add("replacement prompt");
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
	const backups = fs.readdirSync(tempDir.path()).filter(name => /^history\.db\.corrupt-.*[^-]$/.test(name));
	expect(backups.length).toBe(1);
	expect(await Bun.file(tempDir.join(backups[0])).bytes()).toEqual(damaged);
	HistoryStorage.close();
	const raw = new Database(dbPath);
	raw.run("PRAGMA journal_mode=DELETE");
	const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const root = raw
		.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='idx_history_created_at'")
		.get()!.rootpage;
	raw.close();
	const fd = fs.openSync(dbPath, "r+");
	try {
		fs.writeSync(fd, Buffer.alloc(pageSize, 255), 0, pageSize, (root - 1) * pageSize);
	} finally {
		fs.closeSync(fd);
	}
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(row => row.prompt),
	).toEqual(["replacement prompt"]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("keeps commits made after a failed quarantine unlink when that same source is retried", async () => {
	tempDir = TempDir.createSync("@omp-history-quarantine-retry-");
	const dbPath = tempDir.join("history.db");
	await seedDamagedStore(dbPath, 2);
	const unlink = fs.unlinkSync;
	const fail = vi.spyOn(fs, "unlinkSync").mockImplementation(target => {
		if (String(target) === dbPath) throw new Error("unlink blocked");
		unlink(target);
	});
	expect(() => HistoryStorage.open(dbPath)).toThrow("unlink blocked");
	fail.mockRestore();
	const peer = new Database(dbPath);
	peer
		.query("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?, ?, ?, ?)")
		.run("new-session", "/project", "committed between attempts", 10);
	peer.close();
	HistoryStorage.open(dbPath);
	const recovered = new Database(dbPath, { readonly: true });
	try {
		expect(recovered.query("SELECT recap FROM session_recaps WHERE session_id='new-session'").all()).toEqual([
			{ recap: "committed between attempts" },
		]);
	} finally {
		recovered.close();
	}
});

it.each(["missing", "schema"])("retires a %s-damaged backup and keeps any readable index rows", async kind => {
	tempDir = TempDir.createSync("@omp-history-terminal-backup-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-terminal");
	if (kind === "schema") {
		const source = new Database(backupPath);
		source.run("CREATE TABLE session_titles (session_id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER)");
		source.run("INSERT INTO session_titles VALUES ('session-a', 'readable title', 1)");
		source.close();
	}
	queueBackup(dbPath, backupPath);
	const storage = HistoryStorage.open(dbPath);
	await storage.add("new prompt");
	expect(storage.getRecent(10).map(row => row.prompt)).toEqual(["new prompt"]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
	if (kind === "schema") {
		const check = new Database(dbPath, { readonly: true });
		try {
			expect(check.query("SELECT title FROM session_titles").all()).toEqual([{ title: "readable title" }]);
		} finally {
			check.close();
		}
	}
});

it("preserves a sequence above the JavaScript safe integer range without rounding it during rebuild", async () => {
	tempDir = TempDir.createSync("@omp-history-wide-sequence-");
	const dbPath = tempDir.join("history.db");
	await HistoryStorage.open(dbPath).add("survivor");
	HistoryStorage.close();
	const raw = new Database(dbPath);
	raw.run("UPDATE sqlite_sequence SET seq=9007199254740993 WHERE name='history'");
	raw.run("PRAGMA user_version=1");
	raw.close();
	await HistoryStorage.open(dbPath).add("new prompt");
	const check = new Database(dbPath, { readonly: true });
	try {
		expect(check.query("SELECT CAST(id AS TEXT) AS id FROM history WHERE prompt='new prompt'").get()).toEqual({
			id: "9007199254740994",
		});
	} finally {
		check.close();
	}
});

it("salvages high-id rows losslessly and preserves allocation order after recovery", async () => {
	tempDir = TempDir.createSync("@omp-history-wide-salvage-");
	const dbPath = tempDir.join("history.db");
	const backup = new Database(dbPath);
	backup.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			cwd TEXT,
			session_id TEXT,
			use_count INTEGER NOT NULL DEFAULT 1
		);
		INSERT INTO history (id, prompt, created_at, use_count) VALUES
			(9007199254740993, 'first wide prompt', 1, 1),
			(9007199254740995, 'second wide prompt', 2, 1);
		UPDATE sqlite_sequence SET seq=9007199254740995 WHERE name='history';
		PRAGMA user_version = 2;
	`);
	backup.close();
	fs.copyFileSync(dbPath, tempDir.join("history.db.corrupt-wide"));
	fs.writeFileSync(`${dbPath}.pending-salvage`, JSON.stringify([{ backupName: "history.db.corrupt-wide" }]));
	// A different generation can write while the high-id source waits.
	await HistoryStorage.open(dbPath).add("live prompt");
	HistoryStorage.close();
	fs.copyFileSync(tempDir.join("history.db.corrupt-wide"), tempDir.join("history.db.corrupt-deferred"));
	fs.writeFileSync(`${dbPath}.pending-salvage`, JSON.stringify([{ backupName: "history.db.corrupt-deferred" }]));
	const storage = HistoryStorage.open(dbPath);
	await storage.add("next prompt");
	const check = new Database(dbPath, { readonly: true });
	try {
		expect(
			check
				.query<{ id: string; prompt: string }, []>("SELECT CAST(id AS TEXT) AS id, prompt FROM history ORDER BY id")
				.all(),
		).toEqual([
			{ id: "9007199254740993", prompt: "first wide prompt" },
			{ id: "9007199254740995", prompt: "second wide prompt" },
			{ id: "9007199254740996", prompt: "live prompt" },
			{ id: "9007199254740997", prompt: "next prompt" },
		]);
	} finally {
		check.close();
	}
});
it("remaps a salvaged id colliding at the AUTOINCREMENT ceiling instead of failing open", async () => {
	tempDir = TempDir.createSync("@omp-history-maxid-salvage-");
	const dbPath = tempDir.join("history.db");
	await HistoryStorage.open(dbPath).add("live prompt");
	HistoryStorage.close();

	// A peer claim at the last rowid: the live row keeps INT64_MAX, and the
	// backup carries a different prompt with the same id plus a maxed sequence.
	const raw = new Database(dbPath);
	raw.run("UPDATE history SET id = 9223372036854775807 WHERE prompt = 'live prompt'");
	raw.close();
	const backupPath = tempDir.join("history.db.corrupt-maxid");
	const backup = new Database(backupPath);
	backup.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			cwd TEXT,
			session_id TEXT,
			use_count INTEGER NOT NULL DEFAULT 1
		);
		INSERT INTO history (id, prompt, created_at, use_count) VALUES
			(9223372036854775807, 'stranded at the top', 1, 1);
		UPDATE sqlite_sequence SET seq = 9223372036854775807 WHERE name = 'history';
	`);
	backup.close();
	fs.writeFileSync(`${dbPath}.pending-salvage`, JSON.stringify([{ backupName: path.basename(backupPath) }]));

	const storage = HistoryStorage.open(dbPath);
	// Recency order: the live row's epoch timestamp outranks the salvaged row's fixture value.
	expect(storage.getRecent(10).map(entry => entry.prompt)).toEqual(["live prompt", "stranded at the top"]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
	HistoryStorage.close();

	const check = new Database(dbPath, { readonly: true });
	try {
		const rows = check
			.query<{ id: string; prompt: string }, []>(
				"SELECT CAST(id AS TEXT) AS id, prompt FROM history ORDER BY prompt",
			)
			.all();
		expect(rows).toEqual([
			{ id: "9223372036854775807", prompt: "live prompt" },
			{ id: "1", prompt: "stranded at the top" },
		]);
	} finally {
		check.close();
	}
});

it("preserves a deferred older source while recovering a newly damaged replacement", async () => {
	tempDir = TempDir.createSync("@omp-history-multiple-generations-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-older");
	seedSalvageBackup(backupPath);
	queueBackup(dbPath, backupPath);
	const scan = utils.readDamagedSqliteRows;
	const blocked = vi.spyOn(utils, "readDamagedSqliteRows").mockImplementation((db, table, columns, predicate) => {
		if (db.filename === backupPath) throw new Error("temporary source interruption");
		return scan(db, table, columns, predicate);
	});
	await HistoryStorage.open(dbPath).add("newer-generation prompt");
	HistoryStorage.close();
	const raw = new Database(dbPath);
	raw.run("PRAGMA journal_mode=DELETE");
	const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const root = raw
		.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='idx_history_created_at'")
		.get()!.rootpage;
	raw.close();
	const fd = fs.openSync(dbPath, "r+");
	try {
		fs.writeSync(fd, Buffer.alloc(pageSize, 255), 0, pageSize, (root - 1) * pageSize);
	} finally {
		fs.closeSync(fd);
	}
	expect(
		HistoryStorage.open(dbPath)
			.search("newer-generation", 10)
			.map(row => row.prompt),
	).toEqual(["newer-generation prompt"]);
	blocked.mockRestore();
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(row => row.prompt),
	).toContain("stranded prompt");
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("carries committed backup identities through a later recovery instead of counting the old source twice", async () => {
	tempDir = TempDir.createSync("@omp-history-carried-ledger-");
	const dbPath = tempDir.join("history.db");
	const older = tempDir.join("history.db.corrupt-older");
	seedSalvageBackup(older);
	queueBackup(dbPath, older);
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(row => row.useCount),
	).toEqual([1]);
	HistoryStorage.close();
	queueBackup(dbPath, older);
	const raw = new Database(dbPath);
	raw.run("PRAGMA journal_mode=DELETE");
	const pageSize = raw.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
	const root = raw
		.query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='idx_history_created_at'")
		.get()!.rootpage;
	raw.close();
	const fd = fs.openSync(dbPath, "r+");
	try {
		fs.writeSync(fd, Buffer.alloc(pageSize, 255), 0, pageSize, (root - 1) * pageSize);
	} finally {
		fs.closeSync(fd);
	}
	expect(
		HistoryStorage.open(dbPath)
			.getRecent(10)
			.map(row => row.useCount),
	).toEqual([1]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("does not replay a queued snapshot into the original generation that is still live", async () => {
	tempDir = TempDir.createSync("@omp-history-live-source-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-before-unlink");
	const storage = HistoryStorage.open(dbPath);
	await storage.add("original prompt");
	const sourceIdentity = utils.sqliteFileIdentity(dbPath);
	fs.copyFileSync(dbPath, backupPath);
	fs.writeFileSync(
		`${dbPath}.pending-salvage`,
		JSON.stringify([
			{
				backupName: path.basename(backupPath),
				sourceIdentity,
			},
		]),
	);
	await storage.add("committed after failed unlink");
	expect(storage.getRecent(10).map(row => ({ prompt: row.prompt, useCount: row.useCount }))).toEqual([
		{ prompt: "committed after failed unlink", useCount: 1 },
		{ prompt: "original prompt", useCount: 1 },
	]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("returns distinct search hits when adjacent rowids round to the same JavaScript number", async () => {
	tempDir = TempDir.createSync("@omp-history-wide-search-");
	const dbPath = tempDir.join("history.db");
	await HistoryStorage.open(dbPath).add("seed");
	HistoryStorage.close();
	const raw = new Database(dbPath);
	raw.run("UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='history'");
	raw.close();
	// Rows 9007199254740992 and ...993 are distinct rowids that coerce to the
	// same IEEE-754 double; a numeric key would collapse one of them.
	const storage = HistoryStorage.open(dbPath);
	await storage.add("wide alpha");
	await storage.add("wide beta");
	expect(
		storage
			.search("wide", 10)
			.map(entry => entry.prompt)
			.sort(),
	).toEqual(["wide alpha", "wide beta"]);
});

it("reads damaged rows above the safe integer range without collapsing their ids", async () => {
	tempDir = TempDir.createSync("@omp-history-wide-dedup-");
	const dbPath = tempDir.join("history.db");
	const raw = new Database(dbPath);
	raw.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER,
			cwd TEXT, session_id TEXT, use_count INTEGER
		);
		INSERT INTO history VALUES
			(9007199254740992, 'wide alpha', 1, NULL, NULL, 1),
			(9007199254740993, 'wide beta', 2, NULL, NULL, 1);
		PRAGMA user_version = 1;
	`);
	raw.close();
	// Rebuild folds through text rowids; both prompts must survive intact.
	const storage = HistoryStorage.open(dbPath);
	expect(
		storage
			.getRecent(10)
			.map(entry => entry.prompt)
			.sort(),
	).toEqual(["wide alpha", "wide beta"]);
	expect(
		storage
			.search("wide", 10)
			.map(entry => entry.prompt)
			.sort(),
	).toEqual(["wide alpha", "wide beta"]);
});

it("drops non-text provenance from a damaged backup while keeping the prompt", async () => {
	tempDir = TempDir.createSync("@omp-history-salvage-provenance-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	const backup = new Database(backupPath);
	backup.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY, prompt TEXT, created_at INTEGER,
			cwd TEXT, session_id TEXT, use_count INTEGER
		);
		INSERT INTO history VALUES (1, 'recovered prompt', 1, X'0102', X'0304', 1);
	`);
	backup.close();
	queueBackup(dbPath, backupPath);

	const storage = HistoryStorage.open(dbPath);
	const [entry] = storage.getRecent(10);
	expect(entry?.prompt).toBe("recovered prompt");
	expect(entry?.cwd).toBeUndefined();
	expect(entry?.sessionId).toBeUndefined();
	const [found] = storage.search("recovered", 10);
	expect(found?.cwd).toBeUndefined();
	expect(found?.sessionId).toBeUndefined();
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("does not hold the recovery lease while scanning a queued backup", async () => {
	tempDir = TempDir.createSync("@omp-history-salvage-lease-");
	const dbPath = tempDir.join("history.db");
	const backupPath = tempDir.join("history.db.corrupt-backup");
	seedSalvageBackup(backupPath);
	queueBackup(dbPath, backupPath);

	const realScan = utils.readDamagedSqliteRows;
	let leaseHeldDuringScan: boolean | undefined;
	vi.spyOn(utils, "readDamagedSqliteRows").mockImplementation(((db: Database, table: string, columns: string) => {
		if (table === "history") {
			const lease = utils.tryAcquireFileLock(
				`${utils.normalizePathForComparison(dbPath, { allowMissing: true })}.recovery`,
			);
			leaseHeldDuringScan = lease === null;
			lease?.release();
		}
		return realScan(db, table, columns);
	}) as typeof utils.readDamagedSqliteRows);

	HistoryStorage.open(dbPath);
	expect(leaseHeldDuringScan).toBe(false);
});

/**
 * Seeds a backup whose carried applied-ledger holds one malformed (blob) row.
 * The scan cannot prove which older backups committed into this snapshot, so
 * the drain must defer older journal records to a merge replay.
 */
function seedBackupWithDamagedLedger(
	backupPath: string,
	rows: Array<[id: number, prompt: string, useCount: number]>,
): void {
	const backup = new Database(backupPath);
	backup.exec(`
		CREATE TABLE history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			prompt TEXT NOT NULL UNIQUE,
			created_at INTEGER NOT NULL,
			cwd TEXT,
			session_id TEXT,
			use_count INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE session_titles (
			session_id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE session_recaps (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			cwd TEXT NOT NULL,
			recap TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX idx_session_recaps_session ON session_recaps(session_id, created_at);
		CREATE TABLE history_salvage_applied (backup_path TEXT PRIMARY KEY);
	`);
	for (const [id, prompt, useCount] of rows) {
		backup
			.query(
				"INSERT INTO history (id, prompt, created_at, cwd, session_id, use_count) VALUES (?, ?, ?, '/project', 'session-a', ?)",
			)
			.run(id, prompt, LEGACY_TIMESTAMP, useCount);
	}
	if (rows.length) {
		backup
			.query(
				"INSERT INTO session_recaps (id, session_id, cwd, recap, created_at) VALUES (5, 'session-a', '/project', 'recap one', ?)",
			)
			.run(LEGACY_TIMESTAMP);
	}
	// A damaged ledger row: a blob where only backup basenames are valid.
	backup.query("INSERT INTO history_salvage_applied (backup_path) VALUES (?)").run(new Uint8Array([1, 2]) as never);
	backup.close();
}

function queueBackups(dbPath: string, ...backupPaths: string[]): void {
	fs.writeFileSync(
		`${dbPath}.pending-salvage`,
		JSON.stringify(backupPaths.map(backupPath => ({ backupName: path.basename(backupPath) }))),
	);
}

it("replays an older backup without double counting when a newer snapshot's carried ledger is unreadable", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-carried-ledger-");
	const dbPath = tempDir.join("history.db");
	// The older backup committed into the newer snapshot, but crashed before its
	// journal entry was cleared. The newer snapshot's ledger page is damaged, so
	// the drain cannot prove the commit — replaying additively would count its
	// prompts twice.
	const olderPath = tempDir.join("history.db.corrupt-older");
	const newerPath = tempDir.join("history.db.corrupt-newer");
	seedBackupWithDamagedLedger(olderPath, [[1, "stranded prompt", 3]]);
	// The newer snapshot carries the older backup's merged rows, but its ledger
	// lost the readable mark: replaying the older record additively would count
	// its prompt a second time.
	fs.copyFileSync(olderPath, newerPath);
	queueBackups(dbPath, olderPath, newerPath);

	const storage = HistoryStorage.open(dbPath);
	expect(storage.getRecent(10)).toMatchObject([{ prompt: "stranded prompt", useCount: 3 }]);
	const verify = new Database(dbPath, { readonly: true });
	try {
		expect(verify.query("SELECT COUNT(*) AS n FROM session_recaps WHERE recap = 'recap one'").get()).toEqual({
			n: 1,
		});
	} finally {
		verify.close();
	}
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});

it("still restores an older backup that never committed past an unreadable carried ledger", async () => {
	tempDir = TempDir.createSync("@omp-history-storage-carried-rollback-");
	const dbPath = tempDir.join("history.db");
	const olderPath = tempDir.join("history.db.corrupt-older");
	const newerPath = tempDir.join("history.db.corrupt-newer");
	seedBackupWithDamagedLedger(olderPath, [[1, "stranded prompt", 3]]);
	// The older backup's apply rolled back, so the newer snapshot lacks its rows.
	seedBackupWithDamagedLedger(newerPath, [[7, "newer prompt", 1]]);
	queueBackups(dbPath, olderPath, newerPath);

	const storage = HistoryStorage.open(dbPath);
	expect(
		storage
			.getRecent(10)
			.map(entry => entry.prompt)
			.sort(),
	).toEqual(["newer prompt", "stranded prompt"]);
	expect(storage.search("stranded", 10)).toMatchObject([{ prompt: "stranded prompt", useCount: 3 }]);
	expect(fs.existsSync(`${dbPath}.pending-salvage`)).toBe(false);
});
