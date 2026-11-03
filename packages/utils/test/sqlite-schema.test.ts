import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { initializeSqliteSchema, openSqliteDatabase, openSqliteDatabaseSync } from "../src/sqlite";
import { TempDir } from "../src/temp";

const SCHEMA = "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value TEXT)";

function createStore(dbPath: string): void {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode=WAL");
	db.run(SCHEMA);
	db.close();
}

/** A second connection that holds the write lock, as another omp process mid-transaction does. */
function holdWriteLock(dbPath: string): Database {
	const holder = new Database(dbPath);
	holder.run("BEGIN IMMEDIATE");
	return holder;
}

/** Another process that holds the write lock for `ms`, then commits. Resolves once it holds it. */
async function holdWriteLockInChild(dbPath: string, ms: number): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
	const script = `
		const { Database } = require("bun:sqlite");
		const db = new Database(${JSON.stringify(dbPath)});
		db.run("BEGIN IMMEDIATE");
		db.run("INSERT INTO entries (value) VALUES ('peer')");
		console.log("held");
		setTimeout(() => { db.run("COMMIT"); db.close(); }, ${ms});
	`;
	const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
	const { value } = await child.stdout.getReader().read();
	expect(new TextDecoder().decode(value)).toContain("held");
	return child;
}

describe("initializeSqliteSchema", () => {
	test("a current schema initializes while another connection holds the write lock", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-current-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const holder = holdWriteLock(dbPath);
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA busy_timeout = 0");
			let runs = 0;
			initializeSqliteSchema(db, () => {
				runs++;
				db.run(SCHEMA);
			});
			expect(runs).toBe(1);
			// The connection is writable again once the peer commits.
			holder.run("COMMIT");
			db.run("INSERT INTO entries (value) VALUES ('after')");
		} finally {
			db.close();
			holder.close();
		}
	});

	test("a schema that needs a write waits for the write lock, then applies it in one transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-migrate-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const apply = (db: Database) => () => {
			db.run(SCHEMA);
			db.run("CREATE TABLE IF NOT EXISTS added (id INTEGER PRIMARY KEY)");
			if (db.query("SELECT 1 FROM added WHERE id = 1").get() === null) db.run("INSERT INTO added (id) VALUES (1)");
		};
		const holder = holdWriteLock(dbPath);
		const db = new Database(dbPath);
		try {
			db.run("PRAGMA busy_timeout = 0");
			expect(() => initializeSqliteSchema(db, apply(db))).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
			expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'added'").get()).toBeNull();
			holder.run("COMMIT");
			initializeSqliteSchema(db, apply(db));
			expect(db.query("SELECT id FROM added").all()).toEqual([{ id: 1 }]);
			// Now current: initializes again under a held write lock.
			holder.run("BEGIN IMMEDIATE");
			initializeSqliteSchema(db, apply(db));
			holder.run("COMMIT");
		} finally {
			db.close();
			holder.close();
		}
	});

	test("other errors propagate and leave the connection writable", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-error-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const db = new Database(dbPath);
		try {
			expect(() =>
				initializeSqliteSchema(db, () => {
					throw new Error("broken initializer");
				}),
			).toThrow("broken initializer");
			expect(db.inTransaction).toBe(false);
			db.run("INSERT INTO entries (value) VALUES ('writable')");
		} finally {
			db.close();
		}
	});

	test("inside a caller's transaction, the schema is applied in that transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-schema-nested-");
		const dbPath = dir.join("store.db");
		const db = new Database(dbPath);
		try {
			db.run("BEGIN IMMEDIATE");
			initializeSqliteSchema(db, () => db.run(SCHEMA));
			expect(db.inTransaction).toBe(true);
			db.run("ROLLBACK");
			expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'entries'").get()).toBeNull();
		} finally {
			db.close();
		}
	});
});

describe("open BUSY budget", () => {
	// A peer that holds the write lock for 6 s outlasts the former budget of four attempts
	// (1 s busy handler each plus 100/200/400 ms sleeps, ~4.7 s) that failed headless starts.
	// Real time on purpose: SQLite's busy handler and the peer's lock are wall-clock, in another process.
	const HOLD_MS = 6_000;

	test("openSqliteDatabase waits out a peer's long write transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-busy-async-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const peer = await holdWriteLockInChild(dbPath, HOLD_MS);
		const rows = await openSqliteDatabase(dbPath, db => {
			try {
				db.run("INSERT INTO entries (value) VALUES ('mine')");
				return db.query<{ value: string }, []>("SELECT value FROM entries ORDER BY id").all();
			} finally {
				db.close();
			}
		});
		expect(rows).toEqual([{ value: "peer" }, { value: "mine" }]);
		await peer.exited;
	}, 30_000);

	test("openSqliteDatabaseSync waits out a peer's long write transaction", async () => {
		await using dir = await TempDir.create("@omp-sqlite-busy-sync-");
		const dbPath = dir.join("store.db");
		createStore(dbPath);
		const peer = await holdWriteLockInChild(dbPath, HOLD_MS);
		const rows = openSqliteDatabaseSync(dbPath, db => {
			try {
				db.run("INSERT INTO entries (value) VALUES ('mine')");
				return db.query<{ value: string }, []>("SELECT value FROM entries ORDER BY id").all();
			} finally {
				db.close();
			}
		});
		expect(rows).toEqual([{ value: "peer" }, { value: "mine" }]);
		await peer.exited;
	}, 30_000);
});
