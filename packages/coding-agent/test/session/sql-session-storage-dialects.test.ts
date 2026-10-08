/**
 * Functional tests for {@link SqlSessionStorage}'s session-row-plus-parts
 * schema, driven through the store's public surface. They run against SQLite
 * always, and against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database (a MySQL 8 server that
 * requires RSA key retrieval needs `?ssl=require` on the URL). Every test
 * creates its own table and drops it when done, so runs do not collide.
 */

import { describe, expect, it } from "bun:test";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { readStoredParts, readStoredSession } from "../helpers/sql-session-storage";

type SqlClient = InstanceType<typeof SQL>;

const MiB = 1024 * 1024;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

/** The session table as Oh My Pi created it before parts existed: no `byte_len`, no `<table>_parts`. */
function oldSchema(adapter: SqlSessionStorageAdapter, table: string): string {
	if (adapter === "mysql") {
		return (
			`CREATE TABLE ${table} (path VARCHAR(512) NOT NULL PRIMARY KEY, content LONGTEXT NOT NULL, ` +
			`mtime_ms BIGINT NOT NULL, title TEXT NULL, title_source VARCHAR(16) NULL, title_updated_at VARCHAR(64) NULL` +
			`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
		);
	}
	const integer = adapter === "postgres" ? "BIGINT" : "INTEGER";
	return (
		`CREATE TABLE ${table} (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms ${integer} NOT NULL, ` +
		`title TEXT, title_source TEXT, title_updated_at TEXT)`
	);
}

/** The parts table DDL that docs/session.md gives `createTable: false` consumers. */
function partsSchema(adapter: SqlSessionStorageAdapter, table: string): string {
	if (adapter === "mysql") {
		return (
			`CREATE TABLE ${table}_parts (path VARCHAR(512) NOT NULL, start_offset BIGINT NOT NULL, ` +
			`content LONGTEXT NOT NULL, PRIMARY KEY (path, start_offset)` +
			`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
		);
	}
	const integer = adapter === "postgres" ? "BIGINT" : "INTEGER";
	return (
		`CREATE TABLE ${table}_parts (path TEXT NOT NULL, start_offset ${integer} NOT NULL, ` +
		`content TEXT NOT NULL, PRIMARY KEY (path, start_offset))`
	);
}

let tableSeq = 0;

/** One test's database: a fresh table name, its clients, and the cleanup that drops both tables. */
class Db implements AsyncDisposable {
	readonly table = `omp_test_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly #clients: SqlClient[] = [];

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		this.client = new SQL(url);
		this.#clients.push(this.client);
	}

	/** A second client of the same database; SQLite's in-memory database lives only on the first. */
	connect(options: { max?: number } = {}): SqlClient {
		if (this.adapter === "sqlite") return this.client;
		const client = new SQL(this.url, options);
		this.#clients.push(client);
		return client;
	}

	async open(options: { createTable?: boolean; client?: SqlClient } = {}): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({
			client: options.client ?? this.client,
			table: this.table,
			createTable: options.createTable,
		});
	}

	/** Run fixture SQL written with `?` placeholders on any dialect. */
	async sql(query: string, values: unknown[] = []): Promise<void> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		await this.client.unsafe(text, values);
	}

	stored(path: string): Promise<string | null> {
		return readStoredSession(this.client, this.table, path, this.adapter);
	}

	parts(path: string): Promise<string[]> {
		return readStoredParts(this.client, this.table, path, this.adapter);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		for (const client of this.#clients) await client.end();
	}
}

/** Every window's head and tail must equal what {@link FileSessionStorage} returns for the same bytes on disk. */
async function expectSlicesMatchFile(
	storage: SqlSessionStorage,
	path: string,
	content: string,
	windows: ReadonlyArray<readonly [number, number]>,
): Promise<void> {
	using dir = TempDir.createSync("@omp-sql-session-slices-");
	const file = dir.join("session.jsonl");
	await Bun.write(file, content);
	const reference = new FileSessionStorage();
	for (const [prefix, suffix] of windows) {
		expect({ prefix, suffix, slices: await storage.readTextSlices(path, prefix, suffix) }).toEqual({
			prefix,
			suffix,
			slices: await reference.readTextSlices(file, prefix, suffix),
		});
	}
}

/** Windows whose head ends, or whose tail starts, within two bytes either side of each boundary. */
function windowsAround(boundaries: readonly number[], size: number): Array<[number, number]> {
	const windows: Array<[number, number]> = [];
	for (const at of boundaries) {
		for (const delta of [-2, -1, 0, 1, 2]) windows.push([at + delta, 0], [0, size - at - delta]);
	}
	return windows;
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage session parts (${adapter})`, () => {
		const connect = (): Db => new Db(adapter, url ?? "");

		it("stores each append as its own part after the existing content", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/append.jsonl";
			await storage.writeText(path, "head ✓\n");
			const writer = storage.openWriter(path);
			await writer.append("€ one\n");
			await writer.append("😀 two\n");
			await writer.close();
			// An append to a path with no row creates the session.
			const fresh = "/sessions/p/fresh.jsonl";
			const freshWriter = storage.openWriter(fresh);
			await freshWriter.append("first\n");
			await freshWriter.close();

			const expected = "head ✓\n€ one\n😀 two\n";
			expect(await storage.readText(path)).toBe(expected);
			expect(await db.parts(path)).toEqual(["head ✓\n", "€ one\n", "😀 two\n"]);
			expect(await db.stored(path)).toBe(expected);

			const reloaded = await db.open();
			expect(reloaded.statSync(path).size).toBe(Buffer.byteLength(expected));
			expect(await reloaded.readText(path)).toBe(expected);
			expect(await reloaded.readText(fresh)).toBe("first\n");
		});

		it("replaces every part on a full write and empties the session on truncate", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/rewrite.jsonl";
			await storage.writeText(path, "old\n");
			const appender = storage.openWriter(path);
			await appender.append("old tail\n");
			await appender.close();

			await storage.writeText(path, "new\n");
			expect(await storage.readText(path)).toBe("new\n");
			expect(await db.parts(path)).toEqual(["new\n"]);

			const truncating = storage.openWriter(path, { flags: "w" });
			await truncating.append("fresh\n");
			await truncating.close();
			const reloaded = await db.open();
			expect(reloaded.statSync(path).size).toBe(6);
			expect(await reloaded.readText(path)).toBe("fresh\n");
			expect(await db.stored(path)).toBe("fresh\n");
		});

		it("commits a size-checked replace at the current size and conflicts at a stale one", async () => {
			await using db = connect();
			const storage = await db.open();
			const peer = await db.open({ client: db.connect() });
			const path = "/sessions/p/checked.jsonl";
			const body = "one\ntwo 😀\n";
			await storage.writeText(path, body);

			// A byte-identical replace at the current size is no conflict (MySQL reports it as 0 affected rows).
			storage.writeTextSync(path, body, { expectedSize: Buffer.byteLength(body) });
			await storage.drain();
			await storage.writeTextAtomic(path, "rewritten\n", { expectedSize: Buffer.byteLength(body) });
			expect(await storage.readText(path)).toBe("rewritten\n");

			await peer.refresh();
			const peerWriter = peer.openWriter(path);
			await peerWriter.append("peer\n");
			await peerWriter.close();

			await expect(storage.writeTextAtomic(path, "stale\n", { expectedSize: 10 })).rejects.toBeInstanceOf(
				SessionWriteConflictError,
			);
			expect(await (await db.open()).readText(path)).toBe("rewritten\npeer\n");
		});

		it("creates a missing session over orphan parts and refuses to create an existing one", async () => {
			await using db = connect();
			const late = await db.open();
			const storage = await db.open();
			const path = "/sessions/p/created.jsonl";
			await db.sql(`INSERT INTO ${db.table}_parts (path, start_offset, content) VALUES (?, ?, ?), (?, ?, ?)`, [
				path,
				0,
				"orphan-1\n",
				path,
				9,
				"orphan-2\n",
			]);

			storage.writeTextSync(path, "created\n", { expectedSize: null });
			await storage.drain();
			expect(await storage.readText(path)).toBe("created\n");
			expect(await db.parts(path)).toEqual(["created\n"]);

			await expect(late.writeTextAtomic(path, "late\n", { expectedSize: null })).rejects.toBeInstanceOf(
				SessionWriteConflictError,
			);
			expect(await (await db.open()).readText(path)).toBe("created\n");
		});

		it("renames a session with its parts over an existing destination", async () => {
			await using db = connect();
			const storage = await db.open();
			const source = "/sessions/p/source.jsonl";
			const destination = "/sessions/p/destination.jsonl";
			await storage.writeText(source, "source head\n");
			const sourceWriter = storage.openWriter(source);
			await sourceWriter.append("source tail 😀\n");
			await sourceWriter.close();
			await storage.writeText(destination, "destination head\n");
			const destinationWriter = storage.openWriter(destination);
			await destinationWriter.append("destination tail\n");
			await destinationWriter.close();

			await storage.rename(source, destination);
			const moved = "source head\nsource tail 😀\n";
			expect(storage.existsSync(source)).toBe(false);
			expect(await storage.readText(destination)).toBe(moved);
			const reloaded = await db.open();
			expect(reloaded.existsSync(source)).toBe(false);
			expect(await reloaded.readText(destination)).toBe(moved);
			expect(await db.parts(source)).toEqual([]);

			await storage.rename(destination, destination);
			expect(await storage.readText(destination)).toBe(moved);
			await db.sql(`DELETE FROM ${db.table} WHERE path = ?`, [destination]);
			await expect(storage.rename(destination, destination)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("deletes a session's row and parts together", async () => {
			await using db = connect();
			const storage = await db.open();
			const session = "/sessions/p/s1.jsonl";
			const sidecar = "/sessions/p/s1/draft.txt";
			const other = "/sessions/p/other.jsonl";
			await storage.writeText(session, "session\n");
			const writer = storage.openWriter(session);
			await writer.append("more\n");
			await writer.close();
			await storage.writeText(sidecar, "draft");
			await storage.writeText(other, "other\n");

			await storage.deleteSessionWithArtifacts(session);
			await storage.unlink(other);

			const reloaded = await db.open();
			for (const path of [session, sidecar, other]) {
				expect(reloaded.existsSync(path)).toBe(false);
				expect(await db.parts(path)).toEqual([]);
			}
		});

		it("keeps title updates across reloads of a session stored in parts", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/titled.jsonl";
			const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
			const entry = `${JSON.stringify({ type: "message", id: "m" })}\n`;
			await storage.writeText(
				path,
				`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
			);
			const writer = storage.openWriter(path);
			await writer.append(entry);
			await writer.close();

			await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

			const expectedTitle = { type: "title", title: "New", source: "user", updatedAt: "t2" };
			for (const view of [storage, await db.open()]) {
				const content = await view.readText(path);
				expect(JSON.parse(content.split("\n")[0])).toMatchObject(expectedTitle);
				expect(content.endsWith(`${header}${entry}`)).toBe(true);
				expect(JSON.parse((await view.readTextSlices(path, 256, 0))[0].split("\n")[0])).toMatchObject(
					expectedTitle,
				);
			}
		});

		it("serves head and tail slices byte-identical to a file across part edges", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/sliced.jsonl";
			// Three-byte characters put the 1 MiB split point mid-character, so
			// the full write's first part ends one byte early.
			const body = "€".repeat(400_000);
			const appends = ["😀a\n", "€b\n", "😀😀\n"];
			await storage.writeText(path, body);
			const writer = storage.openWriter(path);
			for (const line of appends) await writer.append(line);
			await writer.close();

			const content = body + appends.join("");
			const size = Buffer.byteLength(content);
			const partEdge = MiB - 1;
			expect((await db.parts(path)).map(part => Buffer.byteLength(part))).toEqual([
				partEdge,
				1_200_000 - partEdge,
				6,
				5,
				9,
			]);
			await expectSlicesMatchFile(storage, path, content, [
				[1, 0],
				[2, 0],
				[0, 1],
				[0, 3],
				[4, 3],
				[size + 7, 0],
				[0, size + 3],
				[size, size],
				...windowsAround([partEdge, 1_200_000, 1_200_006, 1_200_011], size),
			]);
		});

		it("reads back a full write larger than 1 MiB with no stored value over 1 MiB", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/large.jsonl";
			const content = `${"😀".repeat(300_000)}\n${"€".repeat(500_000)}x\n`;
			await storage.writeText(path, content);

			expect(await storage.readText(path)).toBe(content);
			const reloaded = await db.open();
			expect(reloaded.statSync(path).size).toBe(Buffer.byteLength(content));
			expect(await reloaded.readText(path)).toBe(content);
			const parts = await db.parts(path);
			expect(parts.length).toBeGreaterThan(2);
			expect(Math.max(...parts.map(part => Buffer.byteLength(part)))).toBeLessThanOrEqual(MiB);
		});

		it("migrates a table from before parts and keeps serving its sessions", async () => {
			await using db = connect();
			await db.sql(oldSchema(adapter, db.table));
			const replaced = "/sessions/p/replaced.jsonl";
			const grown = "/sessions/p/grown.jsonl";
			const replacedBody = '{"type":"session","id":"r"}\n';
			const grownBody = '{"type":"session","id":"g"}\n€€';
			await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms) VALUES (?, ?, ?), (?, ?, ?)`, [
				replaced,
				replacedBody,
				1,
				grown,
				grownBody,
				2,
			]);

			const storage = await db.open();
			expect(storage.statSync(grown).size).toBe(Buffer.byteLength(grownBody));
			expect(await storage.readText(replaced)).toBe(replacedBody);
			await storage.writeTextAtomic(replaced, "rewritten\n", { expectedSize: Buffer.byteLength(replacedBody) });
			expect(await storage.readText(replaced)).toBe("rewritten\n");

			const writer = storage.openWriter(grown);
			await writer.append("😀 one\n");
			await writer.append("€ two\n");
			await writer.close();
			const content = `${grownBody}😀 one\n€ two\n`;
			const size = Buffer.byteLength(content);
			expect(await storage.readText(grown)).toBe(content);
			await expectSlicesMatchFile(storage, grown, content, [
				[size, 0],
				[0, size],
				...windowsAround([Buffer.byteLength(grownBody), Buffer.byteLength(grownBody) + 3], size),
			]);

			const moved = "/sessions/p/moved.jsonl";
			await storage.rename(grown, moved);
			// Re-running the migration on an already migrated table is a no-op.
			const reloaded = await db.open();
			expect(reloaded.existsSync(grown)).toBe(false);
			expect(await reloaded.readText(moved)).toBe(content);
			expect(await reloaded.readText(replaced)).toBe("rewritten\n");
			await reloaded.writeTextAtomic(moved, "compacted\n", { expectedSize: size });
			expect(await (await db.open()).readText(moved)).toBe("compacted\n");
		});

		it("refuses to start under createTable: false until the documented schema is in place", async () => {
			await using db = connect();
			await db.sql(oldSchema(adapter, db.table));
			const legacy = "/sessions/p/legacy.jsonl";
			await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms) VALUES (?, ?, ?)`, [legacy, "legacy\n", 1]);

			const bothMissing = db.open({ createTable: false });
			await expect(bothMissing).rejects.toThrow(`column ${db.table}.byte_len`);
			await expect(bothMissing).rejects.toThrow(`table ${db.table}_parts`);

			await db.sql(`ALTER TABLE ${db.table} ADD COLUMN byte_len ${adapter === "sqlite" ? "INTEGER" : "BIGINT"}`);
			const partsMissing: unknown = await db.open({ createTable: false }).catch((error: unknown) => error);
			expect(partsMissing).toBeInstanceOf(Error);
			expect((partsMissing as Error).message).toContain(`table ${db.table}_parts`);
			expect((partsMissing as Error).message).not.toContain("byte_len");

			await db.sql(partsSchema(adapter, db.table));
			await expect(db.open({ createTable: false })).rejects.toThrow(legacy);

			const backfill = {
				sqlite: "length(cast(content AS blob))",
				postgres: "octet_length(content)",
				mysql: "length(content)",
			};
			await db.sql(`UPDATE ${db.table} SET byte_len = ${backfill[adapter]} WHERE byte_len IS NULL`);
			const storage = await db.open({ createTable: false });
			expect(await storage.readText(legacy)).toBe("legacy\n");
		});
	});
}

for (const { adapter, url } of BACKENDS) {
	if (adapter === "sqlite") continue;
	describe.skipIf(!url)(`SqlSessionStorage concurrent clients (${adapter})`, () => {
		it("serializes appends from one client against a size-checked replace from another", async () => {
			await using db = new Db(adapter, url ?? "");
			const appender = await db.open();
			const replacer = await db.open({ client: db.connect() });
			const initial = "initial\n";
			const replacement = "replacement\n";

			for (let trial = 0; trial < 20; trial++) {
				const path = `/race/${trial}.jsonl`;
				await appender.writeText(path, initial);
				await replacer.refresh();
				const lines = Array.from({ length: 4 }, (_, line) => `t${trial}-a${line} 😀\n`);
				const writer = appender.openWriter(path);
				const appends = Promise.all(lines.map(line => writer.append(line)));
				const replace = replacer
					.writeTextAtomic(path, replacement, { expectedSize: Buffer.byteLength(initial) })
					.then(
						() => null,
						(error: unknown) => error,
					);
				await appends;
				await writer.close();
				const failure = await replace;

				// The replace either ran before every append or lost to the first one.
				if (failure === null) {
					expect(await db.stored(path)).toBe(replacement + lines.join(""));
				} else {
					expect(failure).toBeInstanceOf(SessionWriteConflictError);
					expect(await db.stored(path)).toBe(initial + lines.join(""));
				}
			}
		});

		it("creates sessions on adjacent new paths from two clients at once", async () => {
			await using db = new Db(adapter, url ?? "");
			const first = await db.open();
			const second = await db.open({ client: db.connect() });
			// Two parts each, so every create inserts into the parts table more than once.
			const body = `${"x".repeat(1024 * 1024 + 512)}\n`;

			for (let trial = 0; trial < 20; trial++) {
				const paths = [`/adjacent/${trial}/a.jsonl`, `/adjacent/${trial}/b.jsonl`];
				await Promise.all([
					first.writeTextAtomic(paths[0], body, { expectedSize: null }),
					second.writeTextAtomic(paths[1], body, { expectedSize: null }),
				]);
				for (const path of paths) expect(await db.stored(path)).toBe(body);
			}
		}, 60_000);

		it("starts while another client holds a session row lock", async () => {
			await using db = new Db(adapter, url ?? "");
			const storage = await db.open();
			await storage.writeText("/locked.jsonl", "locked\n");
			const starter = db.connect({ max: 1 });
			await starter.unsafe(
				adapter === "postgres" ? "SET lock_timeout = '1s'" : "SET SESSION innodb_lock_wait_timeout = 1",
			);

			const release = Promise.withResolvers<void>();
			const locked = Promise.withResolvers<void>();
			const holder = db.client.transaction(async transaction => {
				await transaction.unsafe(
					`SELECT byte_len FROM ${db.table} WHERE path = ${adapter === "postgres" ? "$1" : "?"} FOR UPDATE`,
					["/locked.jsonl"],
				);
				locked.resolve();
				await release.promise;
			});
			await locked.promise;
			try {
				const started = await db.open({ client: starter });
				expect(started.statSync("/locked.jsonl").size).toBe(7);
			} finally {
				release.resolve();
				await holder;
			}
		});

		it("leaves no orphan part when a peer appends to an artifact while its session is deleted", async () => {
			await using db = new Db(adapter, url ?? "");
			const session = "/race/s1.jsonl";
			const artifact = "/race/s1/sub.jsonl";
			const seed = await db.open();
			await seed.writeText(session, "session head\n");
			await seed.writeText(artifact, "");
			// The peer gives up on a lock after 1 s, so a peer the delete blocks
			// fails on its own instead of waiting for a commit that waits on it.
			const peerClient = db.connect({ max: 1 });
			await peerClient.unsafe(
				adapter === "postgres" ? "SET lock_timeout = '1s'" : "SET SESSION innodb_lock_wait_timeout = 1",
			);
			const peer = await db.open({ client: peerClient });

			// Pause the delete right after its first statement on the session's
			// parts, and let the peer append to the artifact meanwhile: the peer
			// either commits or times out on a lock the delete holds.
			let peerOutcome: unknown;
			const run = async (sql: string, values: unknown[] | undefined, executor: SqlSessionStorageTransaction) => {
				const result = await executor.unsafe(sql, values);
				if (peerOutcome === undefined && sql.includes(`${db.table}_parts`) && values?.includes(session)) {
					const writer = peer.openWriter(artifact);
					peerOutcome = await writer.append("peer line\n").then(
						() => writer.close().then(() => "appended"),
						(error: unknown) => error,
					);
				}
				return result;
			};
			const pausing: SqlSessionStorageClient = {
				options: db.client.options,
				unsafe: (sql, values) => run(sql, values, db.client),
				transaction: work =>
					db.client.transaction(async transaction =>
						work({ unsafe: (sql, values) => run(sql, values, transaction) }),
					),
			};
			const deleter = await SqlSessionStorage.create({ client: pausing, table: db.table });
			await deleter.deleteSessionWithArtifacts(session);
			if (peerOutcome !== "appended") {
				expect(peerOutcome).toMatchObject({ errno: adapter === "postgres" ? "55P03" : 1205 });
			}

			const orphans = (await db.client.unsafe(
				`SELECT path, start_offset FROM ${db.table}_parts WHERE path NOT IN (SELECT path FROM ${db.table})`,
			)) as unknown[];
			expect([...orphans]).toEqual([]);
			const later = await db.open();
			const writer = later.openWriter(artifact);
			await writer.append("later line\n");
			await writer.close();
			const stored = await db.stored(artifact);
			expect(stored?.endsWith("later line\n")).toBe(true);
			expect((await db.open()).statSync(artifact).size).toBe(Buffer.byteLength(stored ?? ""));
			expect(await db.stored(session)).toBeNull();
		});
	});
}
