/**
 * Functional tests for {@link SqlSessionStorage}. Driven by a real
 * `Bun.SQL` SQLite instance (in-memory) so the storage exercises actual
 * SQL execution, not a hand-rolled mock. PostgreSQL/MySQL behaviour is
 * covered by the dialect-specific query suite below, which inspects the
 * statements built at construction.
 */

import { describe, expect, it } from "bun:test";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

async function createSqlite(): Promise<{ client: InstanceType<typeof SQL>; storage: SqlSessionStorage }> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	return { client, storage };
}

describe("SqlSessionStorage (SQLite backend)", () => {
	it("indexes writeText metadata and reads content asynchronously", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/a.jsonl",
		])) as Array<{ path: string; content: string }>;
		expect(rows).toEqual([{ path: "/sessions/p/a.jsonl", content: "line1\nline2\n" }]);

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
		await client.end();
	});

	it("create() warms the metadata index without selecting full content", async () => {
		const client = new SQL("sqlite::memory:");
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT)`,
		);
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			"/sessions/p/huge.jsonl",
			"0123456789",
			Date.now(),
		]);

		const queries: string[] = [];
		const wrapped: SqlSessionStorageClient = {
			options: { adapter: "sqlite" },
			unsafe(query, values) {
				queries.push(query);
				return client.unsafe(query, values);
			},
		};

		const storage = await SqlSessionStorage.create({ client: wrapped, createTable: false });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);

		const warmup = queries.find(query => query.startsWith("SELECT path"));
		expect(warmup).toContain("length(cast(content AS blob))");
		expect(warmup).not.toMatch(/SELECT\s+path,\s*content\b/i);
		expect(queries.some(query => /SELECT\s+content\s+AS\s+content/i.test(query))).toBe(false);
		await client.end();
	});

	it("listFilesSync returns only direct children matching the glob", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		expect(storage.listFilesSync("/dir", "*.jsonl").sort()).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);
		expect(storage.listFilesSync("/dir", "*.bak")).toEqual(["/dir/note.bak"]);
		await client.end();
	});

	it("writer.append appends to SQL after drain", async () => {
		const { client, storage } = await createSqlite();
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from SQL.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		await storage.drain();
		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/session.jsonl",
		])) as Array<{ content: string }>;
		expect(rows[0].content).toBe('{"type":"session"}\n{"type":"message"}\n');

		await writer.close();
		await client.end();
	});

	it("flags='w' truncates both mirror and SQL row", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/keep.jsonl",
		])) as Array<{ content: string }>;
		expect(rows[0].content).toBe("fresh\n");
		await client.end();
	});

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");
		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
		await client.end();
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");

		// Force a SQL error: drop the table so the next append throws.
		await client.unsafe("DROP TABLE omp_session_files");
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow();
		expect(writer.getError()).toBeDefined();
		await client.end();
	});

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files ORDER BY path`)) as Array<{
			path: string;
		}>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/other.jsonl"]);
		await client.end();
	});

	it("rename moves content and mtime atomically inside the mirror and the DB", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);

		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/renamed.jsonl", content: "payload\n" }]);
		await client.end();
	});

	it("rename overwrites an existing destination (parity with fs.rename)", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "from-a\n");
		await storage.writeText("/sessions/p/b.jsonl", "from-b\n");

		await storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");
		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/b.jsonl")).toBe("from-a\n");
		await client.end();
	});

	it("refresh() reloads the mirror from SQL after out-of-band writes", async () => {
		const { client, storage } = await createSqlite();
		// Simulate a peer process inserting directly.
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			"/peer/x.jsonl",
			"from peer\n",
			Date.now() + 5_000,
		]);
		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);

		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
		await client.end();
	});

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		await client.end();
	});

	it("persists title updates as indexed fields across storage reloads", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await SqlSessionStorage.create({ client });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		await client.end();
	});

	it("readTextSlices uses bounded SQL byte substrings instead of a full content select", async () => {
		const client = new SQL("sqlite::memory:");
		const queries: string[] = [];
		const wrapped: SqlSessionStorageClient = {
			options: { adapter: "sqlite" },
			unsafe(query, values) {
				queries.push(query);
				return client.unsafe(query, values);
			},
		};
		const storage = await SqlSessionStorage.create({ client: wrapped });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		queries.length = 0;
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("substr(cast(content AS blob)");
		expect(queries[0]).not.toMatch(/SELECT\s+content\s+AS\s+content/i);
		await client.end();
	});

	it("custom table name is honored", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		await storage.writeText("/sessions/p/x.jsonl", "hello\n");
		const rows = (await client.unsafe(`SELECT path, content FROM agent_sessions`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/x.jsonl", content: "hello\n" }]);
		await client.end();
	});

	it("rejects table names that aren't safe identifiers", async () => {
		const client = new SQL("sqlite::memory:");
		await expect(SqlSessionStorage.create({ client, table: "drop table users; --" })).rejects.toThrow(
			/table name must match/,
		);
		await client.end();
	});

	it("LIKE special chars in artifact paths don't blow up the prefix sweep", async () => {
		const { client, storage } = await createSqlite();
		// Path containing `%`, `_`, and the escape char `#`.
		await storage.writeText("/sessions/p/odd%_#name.jsonl", "session\n");
		await storage.writeText("/sessions/p/odd%_#name/draft.txt", "sidecar");
		await storage.writeText("/sessions/p/sibling.jsonl", "untouched");

		await storage.deleteSessionWithArtifacts("/sessions/p/odd%_#name.jsonl");
		expect(storage.existsSync("/sessions/p/odd%_#name.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/odd%_#name/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/sibling.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files`)) as Array<{ path: string }>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/sibling.jsonl"]);
		await client.end();
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const { client, storage } = await createSqlite();
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("createTable: false skips the DDL (consumer manages migrations)", async () => {
		const client = new SQL("sqlite::memory:");
		// Pre-create the table with the expected schema.
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT)`,
		);
		const storage = await SqlSessionStorage.create({ client, createTable: false });
		await storage.writeText("/s/x.jsonl", "ok");
		expect(await storage.readText("/s/x.jsonl")).toBe("ok");
		await client.end();
	});
});

// ---------------------------------------------------------------------------
// Dialect-specific statement coverage. We can't run a real Postgres/MySQL
// instance from the test process, so we instantiate a `Bun.SQL` client (which
// parses the URL but doesn't connect until the first query) and stub
// `client.unsafe` to capture the rendered SQL. This catches dialect-specific
// regressions in the query builder.
// ---------------------------------------------------------------------------

interface CapturedQuery {
	sql: string;
	values: unknown[] | undefined;
}

function capturingClient(adapter: "postgres" | "mysql"): {
	client: SqlSessionStorageClient;
	queries: CapturedQuery[];
} {
	const queries: CapturedQuery[] = [];
	const client: SqlSessionStorageClient = {
		options: { adapter },
		async unsafe(sql, values) {
			queries.push({ sql, values });
			return [];
		},
	};
	return { client, queries };
}

describe("SqlSessionStorage (dialect-specific SQL)", () => {
	it("PostgreSQL uses numbered placeholders and `||` concat", async () => {
		const { client, queries } = capturingClient("postgres");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/s/p.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const ddl = queries.find(q => q.sql.startsWith("CREATE TABLE"));
		expect(ddl?.sql).toContain("path TEXT PRIMARY KEY");
		expect(ddl?.sql).toContain("mtime_ms BIGINT");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("octet_length(content)");
		expect(loadIndex?.sql).not.toMatch(/SELECT\s+path,\s*content\b/i);

		const append = queries.find(q => q.sql.includes("ON CONFLICT") && q.sql.includes("||"));
		expect(append?.sql).toContain("$1");
		expect(append?.sql).toContain("$2");
		expect(append?.sql).toContain("$3");
		expect(append?.sql).toMatch(/content = \w+\.content \|\| excluded\.content/);

		expect(storage.adapter).toBe("postgres");
	});

	it("MySQL uses `?` placeholders, `ON DUPLICATE KEY UPDATE`, and `CONCAT()`", async () => {
		const { client, queries } = capturingClient("mysql");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/s/m.jsonl");
		await writer.append("chunk\n");
		await writer.close();

		const ddl = queries.find(q => q.sql.startsWith("CREATE TABLE"));
		expect(ddl?.sql).toContain("VARCHAR(512)");
		expect(ddl?.sql).toContain("LONGTEXT");
		expect(ddl?.sql).toContain("ENGINE=InnoDB");
		expect(ddl?.sql).toContain("utf8mb4");

		const loadIndex = queries.find(q => q.sql.startsWith("SELECT path"));
		expect(loadIndex?.sql).toContain("length(content)");
		expect(loadIndex?.sql).not.toMatch(/SELECT\s+path,\s*content\b/i);

		const append = queries.find(q => q.sql.includes("ON DUPLICATE KEY UPDATE"));
		expect(append?.sql).toContain("CONCAT(content, VALUES(content))");
		expect(append?.sql).not.toContain("$1");

		expect(storage.adapter).toBe("mysql");
	});

	it("rejects clients reporting an unknown adapter without an override", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "weirdb" },
			async unsafe() {
				return [];
			},
		};
		await expect(SqlSessionStorage.create({ client })).rejects.toThrow(/unable to infer adapter/);
	});

	it("explicit `adapter` option overrides the reported adapter", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "" }, // empty / missing
			async unsafe() {
				return [];
			},
		};
		const storage = await SqlSessionStorage.create({ client, adapter: "postgres" });
		expect(storage.adapter).toBe("postgres");
	});
});
