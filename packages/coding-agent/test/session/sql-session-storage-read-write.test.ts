/**
 * {@link SqlSessionStorage} writes to PostgreSQL over a connection whose
 * session default is `default_transaction_read_only = on`, as a pooled
 * connection can carry from another client's session-level `SET`. PostgreSQL
 * refuses a plain write there (SQLSTATE 25006, "cannot execute INSERT in a
 * read-only transaction"); each test shows that refusal on the store's own
 * connection, makes one kind of store write on it, reads the write back
 * through the store and through a second client, and checks the connection's
 * default is still read-only. A read-only default the connection's start
 * parameters set, as a database or role default would, is honoured instead:
 * the store refuses every write there and writes nothing. A session that turns
 * that default off again writes there, as older releases did. A last test
 * starts several stores at once on new tables, with the server's default left
 * as it is. Runs only when `OMP_TEST_SQL_POSTGRES_URL` names a throwaway database.
 * That URL must be a direct connection, not one through a transaction-mode
 * pooler, because the read-only tests set that default at session level.
 * Every test uses its own tables and drops them when done.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readStoredParts, readStoredSession } from "../helpers/sql-session-storage";

const url = process.env.OMP_TEST_SQL_POSTGRES_URL;

/** The session table's columns, by name, as `create()` leaves them. */
const SESSION_COLUMNS = ["byte_len", "content", "mtime_ms", "path", "title", "title_source", "title_updated_at"];

let tableSeq = 0;

/** One test's database: its table names and its two clients. */
interface Db {
	/**
	 * The store's client: one connection, kept open, so a session-level `SET`
	 * on it governs every statement the store runs.
	 */
	client: SQL;
	/** A second client, on sessions that keep the server's default; it makes, reads and drops the tables. */
	other: SQL;
	table: string;
	/** A one-column table the store never touches, for the plain `INSERT` PostgreSQL refuses. */
	scratch: string;
}

let current: Db | undefined;

afterEach(async () => {
	const db = current;
	current = undefined;
	if (!db) return;
	try {
		for (const name of [`${db.table}_parts`, db.table, db.scratch]) {
			await db.other.unsafe(`DROP TABLE IF EXISTS ${name}`);
		}
	} finally {
		// Undo the test's session-level SET. Best effort: a RESET that fails on a
		// broken connection must not hide the error that broke it.
		await db.client.unsafe("RESET default_transaction_read_only").catch(() => {});
		await db.client.end();
		await db.other.end();
	}
});

/** One test's database; `connection` sets start parameters on the store's connection. */
async function connect(connection?: Record<string, string>): Promise<Db> {
	const table = `omp_rw_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	const db: Db = {
		client: new SQL(url!, { max: 1, idleTimeout: 0, connection }),
		other: new SQL(url!),
		table,
		scratch: `${table}_scratch`,
	};
	current = db;
	await db.other.unsafe(`CREATE TABLE ${db.scratch} (n integer)`);
	return db;
}

function open(db: Db): Promise<SqlSessionStorage> {
	return SqlSessionStorage.create({ client: db.client, table: db.table });
}

/**
 * `default_transaction_read_only` on the store's connection: `setting` is the
 * default new transactions start from, `reset_val` the one the session began
 * with (from the database, role, server or connection start), which a session
 * `SET` leaves alone.
 */
async function readOnlyDefault(db: Db): Promise<{ setting: string; reset_val: string } | undefined> {
	const rows = (await db.client.unsafe(
		"SELECT setting, reset_val FROM pg_settings WHERE name = 'default_transaction_read_only'",
	)) as Array<{ setting: string; reset_val: string }>;
	return rows[0];
}

/** A read-only default this session set; the store overrides it. */
const SESSION_READ_ONLY = { setting: "on", reset_val: "off" };

/**
 * Make every transaction on the store's connection start read-only, for that
 * session alone, and show PostgreSQL now refuses a plain write there.
 */
async function setReadOnly(db: Db, statement = "SET default_transaction_read_only = on"): Promise<void> {
	await db.client.unsafe(statement);
	expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	await expect(db.client.unsafe(`INSERT INTO ${db.scratch} (n) VALUES (1)`)).rejects.toMatchObject({
		errno: "25006",
	});
}

/** A store made while the default is still read-write, holding `sessions`; then the default turns read-only. */
async function readOnlyStore(sessions: Record<string, string> = {}): Promise<{ db: Db; storage: SqlSessionStorage }> {
	const db = await connect();
	const storage = await open(db);
	for (const [path, content] of Object.entries(sessions)) await storage.writeText(path, content);
	await setReadOnly(db);
	return { db, storage };
}

/** A session's content as the second client reads it; `null` when no row exists. */
function stored(db: Db, path: string): Promise<string | null> {
	return readStoredSession(db.other, db.table, path, "postgres");
}

/** The parts the second client finds for `path`. */
function storedParts(db: Db, path: string): Promise<string[]> {
	return readStoredParts(db.other, db.table, path, "postgres");
}

/** `table`'s column names, sorted, as the second client sees them; none when it does not exist. */
async function columns(db: Pick<Db, "other">, table: string): Promise<string[]> {
	const rows = (await db.other.unsafe(
		"SELECT column_name FROM information_schema.columns " +
			"WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name",
		[table],
	)) as Array<{ column_name: string }>;
	return rows.map(row => row.column_name);
}

describe.skipIf(!url)("SqlSessionStorage on a PostgreSQL connection whose transactions default to read-only", () => {
	it("starts again on tables that exist", async () => {
		const path = "/sessions/p/kept.jsonl";
		const { db } = await readOnlyStore({ [path]: "kept\n" });

		const storage = await open(db);

		expect(await storage.readText(path)).toBe("kept\n");
		expect(await stored(db, path)).toBe("kept\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("creates its tables", async () => {
		const db = await connect();
		await setReadOnly(db);

		const storage = await open(db);

		expect(await columns(db, db.table)).toEqual(SESSION_COLUMNS);
		expect(await columns(db, `${db.table}_parts`)).toEqual(["content", "path", "start_offset"]);
		const path = "/sessions/p/new.jsonl";
		await storage.writeText(path, "new\n");
		expect(await storage.readText(path)).toBe("new\n");
		expect(await stored(db, path)).toBe("new\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("migrates a session table from before titles and parts", async () => {
		const db = await connect();
		const path = "/sessions/p/old.jsonl";
		const content = "old ✓\n";
		await db.other.unsafe(
			`CREATE TABLE ${db.table} (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms BIGINT NOT NULL)`,
		);
		await db.other.unsafe(`INSERT INTO ${db.table} (path, content, mtime_ms) VALUES ($1, $2, 1)`, [path, content]);
		await setReadOnly(db);

		const storage = await open(db);

		expect(await storage.readText(path)).toBe(content);
		expect(storage.statSync(path).size).toBe(Buffer.byteLength(content));
		expect(await columns(db, db.table)).toEqual(SESSION_COLUMNS);
		const rows = (await db.other.unsafe(`SELECT byte_len FROM ${db.table} WHERE path = $1`, [path])) as Array<{
			byte_len: number | bigint | string;
		}>;
		expect(Number(rows[0]?.byte_len)).toBe(Buffer.byteLength(content));
		expect(await stored(db, path)).toBe(content);
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("appends through a writer", async () => {
		const { db, storage } = await readOnlyStore();
		const path = "/sessions/p/appended.jsonl";

		const writer = storage.openWriter(path);
		await writer.append("one\n");
		await writer.append("two ✓\n");
		await writer.close();

		expect(await storage.readText(path)).toBe("one\ntwo ✓\n");
		expect(await stored(db, path)).toBe("one\ntwo ✓\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("appends through a writer when SET SESSION CHARACTERISTICS made the session read-only", async () => {
		const db = await connect();
		const storage = await open(db);
		await setReadOnly(db, "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
		const path = "/sessions/p/characteristics.jsonl";

		const writer = storage.openWriter(path);
		await writer.append("one\n");
		await writer.append("two ✓\n");
		await writer.close();

		expect(await storage.readText(path)).toBe("one\ntwo ✓\n");
		expect(await stored(db, path)).toBe("one\ntwo ✓\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("writes a session whole", async () => {
		const { db, storage } = await readOnlyStore();
		const path = "/sessions/p/written.jsonl";

		await storage.writeText(path, "whole ✓\n");

		expect(await storage.readText(path)).toBe("whole ✓\n");
		expect(await stored(db, path)).toBe("whole ✓\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("creates a session and replaces it at its size", async () => {
		const { db, storage } = await readOnlyStore();
		const path = "/sessions/p/atomic.jsonl";

		await storage.writeTextAtomic(path, "first\n", { expectedSize: null });
		expect(await stored(db, path)).toBe("first\n");
		await storage.writeTextAtomic(path, "second ✓\n", { expectedSize: storage.statSync(path).size });

		expect(await storage.readText(path)).toBe("second ✓\n");
		expect(await stored(db, path)).toBe("second ✓\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("truncates a session through a writer opened with flags w", async () => {
		const path = "/sessions/p/truncated.jsonl";
		const { db, storage } = await readOnlyStore({ [path]: "old\nlines\n" });

		const writer = storage.openWriter(path, { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText(path)).toBe("fresh\n");
		expect(await stored(db, path)).toBe("fresh\n");
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("updates a session's title", async () => {
		const path = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		const { db, storage } = await readOnlyStore({
			[path]: `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		});

		await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

		await storage.refresh();
		expect(JSON.parse((await storage.readText(path)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		const rows = (await db.other.unsafe(
			`SELECT title, title_source, title_updated_at FROM ${db.table} WHERE path = $1`,
			[path],
		)) as Array<{ title: string; title_source: string; title_updated_at: string }>;
		expect(rows[0]).toEqual({ title: "New", title_source: "user", title_updated_at: "t2" });
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	// Two kinds of write: `rename` first deletes any row at `to`, `renameNoReplace` never does.
	for (const method of ["rename", "renameNoReplace"] as const) {
		it(`moves a session through ${method}`, async () => {
			const from = "/sessions/p/from.jsonl";
			const to = "/sessions/q/to.jsonl";
			const { db, storage } = await readOnlyStore({ [from]: "moved\n" });

			await storage[method](from, to);

			await storage.refresh();
			expect(storage.existsSync(from)).toBe(false);
			expect(await storage.readText(to)).toBe("moved\n");
			expect(await stored(db, from)).toBeNull();
			expect(await storedParts(db, from)).toEqual([]);
			expect(await stored(db, to)).toBe("moved\n");
			expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
		});
	}

	it("unlinks a session", async () => {
		const path = "/sessions/p/unlinked.jsonl";
		const { db, storage } = await readOnlyStore({ [path]: "gone\n" });

		await storage.unlink(path);

		await storage.refresh();
		expect(storage.existsSync(path)).toBe(false);
		expect(await stored(db, path)).toBeNull();
		expect(await storedParts(db, path)).toEqual([]);
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});

	it("deletes a session with its artifacts", async () => {
		// The delete also removes the artifacts directory from local disk.
		using dir = TempDir.createSync("@omp-sql-read-write-");
		const session = dir.join("s.jsonl");
		const artifact = dir.join("s", "x.jsonl");
		const { db, storage } = await readOnlyStore({ [session]: "session\n", [artifact]: "artifact\n" });

		await storage.deleteSessionWithArtifacts(session);

		await storage.refresh();
		for (const path of [session, artifact]) {
			expect(storage.existsSync(path)).toBe(false);
			expect(await stored(db, path)).toBeNull();
			expect(await storedParts(db, path)).toEqual([]);
		}
		expect(await readOnlyDefault(db)).toEqual(SESSION_READ_ONLY);
	});
});

/**
 * A store's connection whose transactions default to read-only from its start
 * parameters, which PostgreSQL reports as it would a database or role default
 * (the test alters no database or role), and PostgreSQL's refusal of a plain
 * write there.
 */
async function connectReadOnlyAtStart(): Promise<Db> {
	const db = await connect({ default_transaction_read_only: "on" });
	expect(await readOnlyDefault(db)).toEqual({ setting: "on", reset_val: "on" });
	await expect(db.client.unsafe(`INSERT INTO ${db.scratch} (n) VALUES (1)`)).rejects.toMatchObject({
		errno: "25006",
	});
	return db;
}

/** How many session rows and parts the second client finds in the test's tables. */
async function storedCounts(db: Db): Promise<{ sessions: number; parts: number } | undefined> {
	const rows = (await db.other.unsafe(
		`SELECT (SELECT count(*)::int FROM ${db.table}) AS sessions, ` +
			`(SELECT count(*)::int FROM ${db.table}_parts) AS parts`,
	)) as Array<{ sessions: number; parts: number }>;
	return rows[0];
}

/**
 * A read-only default that the database, the role, the server or the
 * connection's start parameters set is an operator's or a provider's
 * decision, so the store honours it: it refuses to start or write, and
 * nothing reaches the database.
 */
describe.skipIf(!url)("a read-only default the connection's start sets is honoured", () => {
	it("refuses to create its tables", async () => {
		const db = await connectReadOnlyAtStart();

		await expect(open(db)).rejects.toThrow("default_transaction_read_only");

		expect(await columns(db, db.table)).toEqual([]);
		expect(await columns(db, `${db.table}_parts`)).toEqual([]);
	});

	it("refuses to start on tables another client made", async () => {
		const db = await connectReadOnlyAtStart();
		await SqlSessionStorage.create({ client: db.other, table: db.table });

		await expect(open(db)).rejects.toThrow("default_transaction_read_only");

		expect(await storedCounts(db)).toEqual({ sessions: 0, parts: 0 });
	});

	it("refuses an append through a writer on tables it does not create", async () => {
		const db = await connectReadOnlyAtStart();
		await SqlSessionStorage.create({ client: db.other, table: db.table });
		const storage = await SqlSessionStorage.create({ client: db.client, table: db.table, createTable: false });

		const writer = storage.openWriter("/sessions/p/appended.jsonl");
		await expect(writer.append("refused\n")).rejects.toThrow("default_transaction_read_only");
		await expect(writer.close()).rejects.toThrow("default_transaction_read_only");

		expect(await storedCounts(db)).toEqual({ sessions: 0, parts: 0 });
	});

	it("refuses to write a session whole on tables it does not create", async () => {
		const db = await connectReadOnlyAtStart();
		await SqlSessionStorage.create({ client: db.other, table: db.table });
		const storage = await SqlSessionStorage.create({ client: db.client, table: db.table, createTable: false });

		await expect(storage.writeText("/sessions/p/written.jsonl", "refused\n")).rejects.toThrow(
			"default_transaction_read_only",
		);

		expect(await storedCounts(db)).toEqual({ sessions: 0, parts: 0 });
	});
});

/** What a session that turned off a read-only default it started with reads. */
const TURNED_OFF = { setting: "off", reset_val: "on" };

/**
 * A store's connection whose transactions default to read-only from its start
 * parameters (see {@link connectReadOnlyAtStart}), and whose session then
 * turns that default off.
 */
async function connectTurnedOff(): Promise<Db> {
	const db = await connectReadOnlyAtStart();
	await db.client.unsafe("SET default_transaction_read_only = off");
	expect(await readOnlyDefault(db)).toEqual(TURNED_OFF);
	return db;
}

/**
 * A session that turns such a default off keeps `reset_val` on, but its own
 * `setting` is off. That session made the decision, and older releases wrote
 * there, so the store writes.
 */
describe.skipIf(!url)("a session that turns such a default off writes", () => {
	it("creates its tables", async () => {
		const db = await connectTurnedOff();

		await open(db);

		expect(await columns(db, db.table)).toEqual(SESSION_COLUMNS);
		expect(await columns(db, `${db.table}_parts`)).toEqual(["content", "path", "start_offset"]);
		expect(await readOnlyDefault(db)).toEqual(TURNED_OFF);
	});

	it("appends through a writer", async () => {
		const db = await connectTurnedOff();
		const storage = await open(db);
		const path = "/sessions/p/appended.jsonl";

		const writer = storage.openWriter(path);
		await writer.append("one\n");
		await writer.append("two ✓\n");
		await writer.close();

		expect(await storage.readText(path)).toBe("one\ntwo ✓\n");
		expect(await stored(db, path)).toBe("one\ntwo ✓\n");
		expect(await storedParts(db, path)).toEqual(["one\n", "two ✓\n"]);
		expect(await readOnlyDefault(db)).toEqual(TURNED_OFF);
	});

	it("writes a session whole", async () => {
		const db = await connectTurnedOff();
		const storage = await open(db);
		const path = "/sessions/p/written.jsonl";

		await storage.writeText(path, "whole ✓\n");

		expect(await storage.readText(path)).toBe("whole ✓\n");
		expect(await stored(db, path)).toBe("whole ✓\n");
		expect(await storedParts(db, path)).toEqual(["whole ✓\n"]);
		expect(await readOnlyDefault(db)).toEqual(TURNED_OFF);
	});
});

/** What a failed start shows: PostgreSQL's SQLSTATE, when it sent one, and the message. */
function failure(reason: unknown): { errno: string | undefined; message: string } {
	return {
		errno: reason instanceof SQL.PostgresError ? reason.errno : undefined,
		message: reason instanceof Error ? reason.message : String(reason),
	};
}

/**
 * Stores that start at the same moment on a database without their tables.
 * Each start makes the tables with `CREATE TABLE IF NOT EXISTS`; without a
 * lock around start-up, two of one name both found no table and one start
 * failed (SQLSTATE 23505, 42P07 or 42710), 83 of 120 starts when measured.
 * Every start must succeed.
 */
describe.skipIf(!url)("SqlSessionStorage starting beside other stores on PostgreSQL", () => {
	it("starts six stores at once on tables that do not exist yet", async () => {
		for (let round = 0; round < 5; round++) {
			const table = `omp_rw_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
			const other = new SQL(url!);
			const clients = Array.from({ length: 6 }, () => new SQL(url!, { max: 1, idleTimeout: 0 }));
			try {
				// Connect first, so the starts reach the server together.
				await Promise.all(clients.map(client => client.connect()));

				const starts = await Promise.allSettled(clients.map(client => SqlSessionStorage.create({ client, table })));

				expect(starts.flatMap(start => (start.status === "rejected" ? [failure(start.reason)] : []))).toEqual([]);
				expect(await columns({ other }, table)).toEqual(SESSION_COLUMNS);
				expect(await columns({ other }, `${table}_parts`)).toEqual(["content", "path", "start_offset"]);
			} finally {
				try {
					for (const name of [`${table}_parts`, table]) await other.unsafe(`DROP TABLE IF EXISTS ${name}`);
				} finally {
					await Promise.all([...clients, other].map(client => client.end()));
				}
			}
		}
	});
});
