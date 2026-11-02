/**
 * `SqlSessionStorage` keys a session row by the file's path relative to the
 * sessions root (`sessions/…`), or by `abs:` and the absolute path for a file
 * outside it, so a session written from one home directory resolves from
 * another, and every spelling of a path names one session. The key migration
 * in docs/session.md moves every key of both tables, and changes neither when
 * two keys would become one or a statement before the parts move fails.
 * These run against SQLite always, and against PostgreSQL and MySQL
 * when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database; every test makes its own tables and drops them.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

type SqlClient = InstanceType<typeof SQL>;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

const ROOT_A = "/home/alice/.omp/agent/sessions";
const ROOT_B = "/home/bob/.omp/agent/sessions";
/** The sessions root docs/session.md's key migration names, as an older omp under `/home/me` wrote it. */
const DOCUMENTED_OLD_ROOT = "/home/me/.omp/agent/sessions";
const SESSION_DOCS = path.resolve(import.meta.dir, "../../../../docs/session.md");

/** A current-version transcript: header, one user turn, one assistant reply. */
function transcript(id: string, cwd: string, text: string): string {
	const timestamp = "2026-11-02T00:00:00.000Z";
	return `${[
		{ type: "session", version: 3, id, timestamp, cwd },
		{ type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: text, timestamp: 1 } },
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${text} reply` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test-model",
				usage: {},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	]
		.map(entry => JSON.stringify(entry))
		.join("\n")}\n`;
}

/** The SQL statements of the fenced block in docs/session.md whose first line is `firstLine`. */
async function documentedStatements(firstLine: string): Promise<string[]> {
	const docs = await Bun.file(SESSION_DOCS).text();
	const start = docs.indexOf(`\`\`\`sql\n${firstLine}\n`);
	if (start < 0) throw new Error(`docs/session.md has no SQL block starting ${JSON.stringify(firstLine)}`);
	const body = docs.slice(start + "```sql\n".length, docs.indexOf("\n```", start + 1));
	return body
		.split("\n")
		.filter(line => !line.startsWith("--"))
		.join("\n")
		.split(/;\s*(?:\n|$)/)
		.map(statement => statement.trim())
		.filter(statement => statement.length > 0);
}

/** The sessions root the documented key migration names in its roots list. */
const MIGRATION_ROOT = `${DOCUMENTED_OLD_ROOT}/`;

/** First line of each dialect's key migration block in docs/session.md. */
const KEY_MIGRATION_BLOCK: Record<SqlSessionStorageAdapter, string> = {
	postgres: "-- Key migration: PostgreSQL",
	sqlite: "-- Key migration: SQLite",
	mysql: "-- Key migration: MySQL / MariaDB",
};

/** Both tables, every column, in a fixed order. */
async function snapshot(db: Db): Promise<{ files: Record<string, unknown>[]; parts: Record<string, unknown>[] }> {
	return {
		files: await db.sql(
			`SELECT path, content, mtime_ms, byte_len, title, title_source, title_updated_at FROM ${db.table} ORDER BY path`,
		),
		parts: await db.sql(`SELECT path, start_offset, content FROM ${db.table}_parts ORDER BY path, start_offset`),
	};
}

/**
 * Run the documented key migration for `roots`, every statement in order on
 * one connection, carrying on past a failed statement the way the `sqlite3`
 * and `psql` clients do by default. Returns the errors of the statements that
 * failed.
 */
async function runKeyMigration(db: Db, roots: readonly string[] = [MIGRATION_ROOT]): Promise<string[]> {
	const listed = roots.map(root => `('${root}')`).join(", ");
	const statements = (await documentedStatements(KEY_MIGRATION_BLOCK[db.adapter])).map(statement =>
		statement.replaceAll("omp_session_files", db.table).replace(`('${MIGRATION_ROOT}')`, listed),
	);
	const session = db.adapter === "sqlite" ? db.client : new SQL(db.url, { max: 1 });
	const errors: string[] = [];
	try {
		for (const statement of statements) {
			try {
				await db.sql(statement, [], session);
			} catch (error) {
				errors.push(String(error));
			}
		}
	} finally {
		if (session !== db.client) await session.end();
	}
	return errors;
}

const KEY_ROLLBACK_BLOCK: Record<SqlSessionStorageAdapter, string> = {
	postgres: "-- Key rollback: PostgreSQL",
	sqlite: "-- Key rollback: SQLite",
	mysql: "-- Key rollback: MySQL / MariaDB",
};

async function documentedPartsRollbackStatements(adapter: SqlSessionStorageAdapter): Promise<string[]> {
	const docs = await Bun.file(SESSION_DOCS).text();
	const blockStart = docs.indexOf("```sql\n-- PostgreSQL\n");
	if (blockStart < 0) throw new Error("docs/session.md has no parts rollback SQL block");
	const block = docs.slice(blockStart + "```sql\n".length, docs.indexOf("\n```", blockStart + 1));
	const headings: Record<SqlSessionStorageAdapter, readonly [string, string | undefined]> = {
		postgres: ["-- PostgreSQL\n", "-- MySQL / MariaDB"],
		mysql: [
			"-- MySQL / MariaDB (GROUP_CONCAT truncates at group_concat_max_len, 1024 bytes by default)\n",
			"-- SQLite 3.44 or later",
		],
		sqlite: ["-- SQLite 3.44 or later\n", undefined],
	};
	const [heading, nextHeading] = headings[adapter];
	const start = block.indexOf(heading);
	if (start < 0) throw new Error(`docs/session.md has no ${adapter} parts rollback`);
	const section = block.slice(start + heading.length, nextHeading ? block.indexOf(nextHeading, start) : undefined);
	return section
		.split("\n")
		.filter(line => !line.startsWith("--"))
		.join("\n")
		.split(/;\s*(?:\n|$)/)
		.map(statement => statement.trim())
		.filter(statement => statement.length > 0);
}

async function runStatements(db: Db, statements: readonly string[]): Promise<string[]> {
	const client = db.adapter === "sqlite" ? db.client : new SQL(db.url, { max: 1 });
	const errors: string[] = [];
	try {
		for (const statement of statements) {
			try {
				await db.sql(statement.replaceAll("omp_session_files", db.table), [], client);
			} catch (error) {
				errors.push(String(error));
			}
		}
	} finally {
		if (client !== db.client) await client.end();
	}
	return errors;
}

async function runKeyRollback(db: Db, restoreRoot: string): Promise<string[]> {
	const statements = await documentedStatements(KEY_ROLLBACK_BLOCK[db.adapter]);
	return runStatements(
		db,
		statements.map(statement =>
			statement
				.replace(`('/home/me/.omp/agent/sessions/')`, `('${restoreRoot}')`)
				.replaceAll("omp_session_files", db.table),
		),
	);
}

/** Read a row the way the pre-row-key SQL storage did: the local path was its table key. */
async function readOldPathKey(db: Db, file: string): Promise<string | null> {
	const [row] = await db.sql(`SELECT content FROM ${db.table} WHERE path = ?`, [file]);
	return typeof row?.content === "string" ? row.content : null;
}

let tableSeq = 0;

/** One test's tables on one database, dropped when done. */
class Db implements AsyncDisposable {
	readonly table = `omp_rowkey_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		this.client = new SQL(url);
	}

	open(sessionsRoot: string, options: { createTable?: boolean } = {}): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client: this.client, table: this.table, sessionsRoot, ...options });
	}

	/** Fixture SQL written with `?` placeholders, on any dialect; the rows as plain objects. */
	async sql(
		query: string,
		values: unknown[] = [],
		client: SqlClient = this.client,
	): Promise<Record<string, unknown>[]> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		const rows = (await client.unsafe(text, values)) as Record<string, unknown>[];
		return rows.map(row => ({ ...row }));
	}

	async insertRow(key: string, content: string): Promise<void> {
		await this.sql(`INSERT INTO ${this.table} (path, content, mtime_ms, byte_len) VALUES (?, ?, ?, ?)`, [
			key,
			content,
			1,
			Buffer.byteLength(content),
		]);
	}

	/** A session row whose bytes are `parts`, stored as parts the way this version writes them. */
	async insertSession(key: string, parts: readonly string[]): Promise<void> {
		const size = parts.reduce((total, part) => total + Buffer.byteLength(part), 0);
		await this.sql(`INSERT INTO ${this.table} (path, content, mtime_ms, byte_len) VALUES (?, '', 1, ?)`, [key, size]);
		await this.insertParts(key, parts);
	}

	/** Parts of `key` at consecutive offsets, with no session row added. */
	async insertParts(key: string, parts: readonly string[]): Promise<void> {
		let offset = 0;
		for (const part of parts) {
			await this.sql(`INSERT INTO ${this.table}_parts (path, start_offset, content) VALUES (?, ?, ?)`, [
				key,
				offset,
				part,
			]);
			offset += Buffer.byteLength(part);
		}
	}

	/** The keys of `table`, in code-unit order whatever the database's collation. */
	async keys(table = this.table): Promise<string[]> {
		return (await this.sql(`SELECT path FROM ${table}`)).map(row => String(row.path)).sort();
	}

	/** Make every UPDATE of a session row fail, as a lock wait timeout or a full disk would. */
	async refuseSessionRowUpdates(): Promise<void> {
		const trigger = `${this.table}_refuse`;
		if (this.adapter === "sqlite") {
			await this.sql(
				`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${this.table} BEGIN SELECT RAISE(ABORT, 'refused'); END`,
			);
		} else if (this.adapter === "mysql") {
			await this.sql(
				`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${this.table} FOR EACH ROW ` +
					`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refused'`,
			);
		} else {
			await this.sql(
				`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`,
			);
			await this.sql(
				`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${this.table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
			);
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		if (this.adapter === "postgres") await this.client.unsafe(`DROP FUNCTION IF EXISTS ${this.table}_refuse()`);
		await this.client.end();
	}
}

/**
 * Tables the documented key migration must leave byte for byte as they are:
 * each case seeds a collision into the session rows, the parts, or both, or
 * makes a statement fail in a client that carries on past it.
 */
const REFUSED_MIGRATIONS: ReadonlyArray<{
	name: string;
	roots: readonly string[];
	/** The refusal shows as a failed statement; a client that carries on past it still changes nothing. */
	failsStatement?: true;
	seed(db: Db): Promise<void>;
}> = [
	{
		name: "a moved key would take the key of a row already migrated",
		roots: [MIGRATION_ROOT],
		async seed(db) {
			await db.insertSession(`${MIGRATION_ROOT}-p/a.jsonl`, ["old\n"]);
			await db.insertSession("sessions/-p/a.jsonl", ["new\n", "newer\n"]);
		},
	},
	{
		name: "canonicalized keys under two roots would take one key",
		roots: ["/home/a/.omp/agent/sessions/", "/home/b/.omp/agent/sessions/"],
		async seed(db) {
			await db.insertSession("/home/a/.omp/agent/sessions/-p/b.jsonl", ["from a\n"]);
			await db.insertSession("/home/b/.omp/agent/sessions/-p/x/../b.jsonl", ["from b\n"]);
		},
	},
	{
		name: "parts without a session row would join another session",
		roots: [MIGRATION_ROOT],
		async seed(db) {
			await db.insertParts(`${MIGRATION_ROOT}-p/c.jsonl`, ["orphan\n"]);
			await db.insertSession("sessions/-p/c.jsonl", ["new\n"]);
		},
	},
	{
		name: "a key lies under two of the listed roots",
		roots: [MIGRATION_ROOT, `${MIGRATION_ROOT}-p/`],
		async seed(db) {
			await db.insertSession(`${MIGRATION_ROOT}-p/d.jsonl`, ["nested\n"]);
		},
	},
	{
		name: "the roots list fails to insert",
		roots: [],
		failsStatement: true,
		async seed() {},
	},
	{
		name: "the session-row UPDATE fails and the client carries on",
		roots: [MIGRATION_ROOT],
		failsStatement: true,
		async seed(db) {
			await db.refuseSessionRowUpdates();
		},
	},
	{
		name: "a relative legacy key has no explicit base directory",
		roots: [MIGRATION_ROOT],
		async seed(db) {
			await db.insertSession("relative/c.jsonl", ["relative\n"]);
		},
	},
];

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage row keys (${adapter})`, () => {
		const connect = (): Db => new Db(adapter, url ?? "");

		it("resolves a session written under one home directory from a process with another", async () => {
			await using db = connect();
			const id = "01a1880d-aaaa-7000-9000-000000000001";
			const cwd = "/home/alice/src/proj";
			const name = `2026-11-02T00-00-00-000Z_${id}`;
			const writer = await db.open(ROOT_A);
			const main = transcript(id, cwd, "main turn");
			const child = transcript("child", cwd, "child turn");
			const outside = transcript("outside", cwd, "custom file");
			await writer.writeText(path.join(ROOT_A, "-src-proj", `${name}.jsonl`), main);
			await writer.writeText(path.join(ROOT_A, "-src-proj", name, "Worker.jsonl"), child);
			await writer.writeText("/srv/custom/session.jsonl", outside);
			await writer.drain();

			// The keys another box, the import tool and the key migration read.
			expect(await db.keys()).toEqual([
				"abs:/srv/custom/session.jsonl",
				`sessions/-src-proj/${name}.jsonl`,
				`sessions/-src-proj/${name}/Worker.jsonl`,
			]);

			const reader = await db.open(ROOT_B);
			const resolved = await resolveResumableSession(id.slice(0, 8), cwd, path.join(ROOT_B, "-src-proj"), reader);
			const readerFile = path.join(ROOT_B, "-src-proj", `${name}.jsonl`);
			expect(resolved?.session.path).toBe(readerFile);
			expect(await reader.readText(path.join(ROOT_B, "-src-proj", name, "Worker.jsonl"))).toBe(child);
			expect(await reader.readText("/srv/custom/session.jsonl")).toBe(outside);

			// Both processes write the one row.
			const line = `${JSON.stringify({ type: "custom", id: "c1", parentId: "m2", timestamp: "x" })}\n`;
			const appender = reader.openWriter(readerFile);
			await appender.append(line);
			await appender.close();
			await writer.refresh();
			expect(await writer.readText(path.join(ROOT_A, "-src-proj", `${name}.jsonl`))).toBe(main + line);
		});

		it("lists only rows whose key it would write back for the listed path", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			await db.insertRow("sessions/-p/kept.jsonl", "kept\n");
			// Each of these names a row that a write to the path it suggests would not reach.
			await db.insertRow("sessions/-p/../escaped.jsonl", "escaped\n");
			await db.insertRow("sessions/-p//empty-segment.jsonl", "empty\n");
			await db.insertRow(`abs:${ROOT_B}/-p/under-root.jsonl`, "under root\n");

			const storage = await db.open(ROOT_B);

			expect(storage.listFilesSync(path.join(ROOT_B, "-p"), "*.jsonl")).toEqual([
				path.join(ROOT_B, "-p", "kept.jsonl"),
			]);
			expect(storage.existsSync(path.join(ROOT_B, "escaped.jsonl"))).toBe(false);
			expect(storage.existsSync(path.join(ROOT_B, "-p", "under-root.jsonl"))).toBe(false);
		});

		it("refuses to start on rows keyed by absolute path until they are migrated", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			const legacy = `${DOCUMENTED_OLD_ROOT}/-p/2026-01-01T00-00-00-000Z_old.jsonl`;
			await db.insertRow(legacy, "old\n");

			for (const createTable of [true, false]) {
				await expect(db.open(ROOT_B, { createTable })).rejects.toThrow(
					`holds the row key ${JSON.stringify(legacy)}, which is neither "sessions/…" nor "abs:…"`,
				);
			}
		});

		it("names one session by every spelling of its path, through every entry point and across refresh", async () => {
			await using db = connect();
			const storage = await db.open(ROOT_B);
			const dir = path.join(ROOT_B, "-p");
			const file = path.join(dir, "s.jsonl");
			const [dotted, doubled, relative] = [
				`${ROOT_B}/-p/x/../s.jsonl`,
				`${ROOT_B}//-p//s.jsonl`,
				path.relative(process.cwd(), file),
			];

			storage.writeTextSync(dotted, "head\n");
			const writer = storage.openWriter(doubled);
			await writer.append("tail\n");
			await writer.close();
			await storage.drain();
			expect(storage.listFilesSync(`${ROOT_B}//-p/./`, "*.jsonl")).toEqual([file]);
			expect(storage.listAllSync()).toEqual([file]);
			expect(storage.statSync(relative).size).toBe(10);

			await storage.refresh();
			for (const spelling of [dotted, doubled, relative]) {
				expect({
					spelling,
					exists: storage.existsSync(spelling),
					text: await storage.readText(spelling),
					from: await storage.readTextFrom(spelling, 5),
				}).toEqual({
					spelling,
					exists: true,
					text: "head\ntail\n",
					from: { text: "tail\n", size: 10 },
				});
			}
			expect(await storage.readTextSlices(relative, 4, 5)).toEqual(["head", "tail\n"]);

			await storage.writeTextAtomic(doubled, "whole\n", { expectedSize: 10 });
			await storage.updateSessionTitle(dotted, {
				title: "Named",
				source: "user",
				updatedAt: "2026-11-02T00:00:00Z",
			});
			const [row] = await db.sql(`SELECT path, title, byte_len FROM ${db.table}`);
			expect({
				path: String(row?.path),
				title: row?.title,
				byte_len: Number(row?.byte_len),
			}).toEqual({
				path: "sessions/-p/s.jsonl",
				title: "Named",
				byte_len: Buffer.byteLength("whole\n"),
			});
			expect(await db.keys()).toEqual(["sessions/-p/s.jsonl"]);

			await storage.writeText(`${ROOT_B}/-p//s/Worker.jsonl`, "child\n");
			expect(storage.listDirsSync(`${ROOT_B}//-p/./`)).toEqual(["s"]);
			await storage.rename(relative, `${ROOT_B}/-q/../-p/moved.jsonl`);
			await storage.unlink(`${ROOT_B}/-p/./s/Worker.jsonl`);
			expect(await db.keys()).toEqual(["sessions/-p/moved.jsonl"]);
			await storage.writeText(`${ROOT_B}/-p/moved//Sub.jsonl`, "sub\n");
			await storage.deleteSessionWithArtifacts(`${ROOT_B}//-p/moved.jsonl`);
			expect(await db.keys()).toEqual([]);
			expect(storage.listFilesSync(dir, "*.jsonl")).toEqual([]);
			// The refusal names the path as the caller spelled it, not the resolved path or the row key.
			await expect(storage.readText(dotted)).rejects.toMatchObject({ code: "ENOENT", path: dotted });
		});

		it("moves every key of both tables with the documented key migration, several roots at once", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			// `_` and `%` are LIKE wildcards: the migration must compare the root literally.
			const otherRoot = "/home/a_%/.omp/agent/sessions/";
			const name = "2026-01-01T00-00-00-000Z_01a00000-0000-7000-8000-000000000001";
			const main = `${MIGRATION_ROOT}-src-proj/${name}.jsonl`;
			const child = `${MIGRATION_ROOT}-src-proj/${name}/Worker.jsonl`;
			const second = `${otherRoot}-q/second.jsonl`;
			const dotted = `${MIGRATION_ROOT}-alias/../dotted.jsonl`;
			const doubled = `${MIGRATION_ROOT}/doubled.jsonl`;
			const lookalike = "/home/aZZ/.omp/agent/sessions/-q/lookalike.jsonl";
			const sibling = `${DOCUMENTED_OLD_ROOT}-other/sibling.jsonl`;
			const outside = "/srv/legion/.omp/agent/sessions/-x/other.jsonl";
			// A session in parts, sessions whose bytes still sit in `content`, a
			// row already migrated, and parts whose session row is gone.
			await db.insertSession(main, ["head✓\n", "tail\n"]);
			const rows: Array<[string, string]> = [
				[child, "child content\n"],
				[second, "second root\n"],
				[dotted, "dotted alias\n"],
				[doubled, "doubled alias\n"],
				[lookalike, "lookalike\n"],
				[sibling, "sibling\n"],
				[outside, "elsewhere\n"],
				["sessions/-src-proj/current.jsonl", "current\n"],
			];
			for (const [key, content] of rows) await db.insertRow(key, content);
			await db.insertParts(`${MIGRATION_ROOT}-gone/orphan.jsonl`, ["orphan\n"]);

			expect(await runKeyMigration(db, [MIGRATION_ROOT, otherRoot])).toEqual([]);
			for (const check of await documentedStatements(
				"SELECT count(*) FROM omp_session_files WHERE substr(path, 1, 9) <> 'sessions/' AND substr(path, 1, 4) <> 'abs:';",
			)) {
				const [row] = await db.sql(check.replaceAll("omp_session_files", db.table));
				expect(Number(Object.values(row ?? {})[0])).toBe(0);
			}

			expect(await db.keys()).toEqual([
				`abs:${lookalike}`,
				`abs:${sibling}`,
				`abs:${outside}`,
				"sessions/-q/second.jsonl",
				`sessions/-src-proj/${name}.jsonl`,
				`sessions/-src-proj/${name}/Worker.jsonl`,
				"sessions/-src-proj/current.jsonl",
				"sessions/dotted.jsonl",
				"sessions/doubled.jsonl",
			]);
			expect(await db.keys(`${db.table}_parts`)).toEqual([
				"sessions/-gone/orphan.jsonl",
				`sessions/-src-proj/${name}.jsonl`,
				`sessions/-src-proj/${name}.jsonl`,
			]);
			const storage = await db.open(ROOT_B);
			expect(await storage.readText(path.join(ROOT_B, "-src-proj", `${name}.jsonl`))).toBe("head✓\ntail\n");
			expect(await storage.readText(path.join(ROOT_B, "-src-proj", name, "Worker.jsonl"))).toBe("child content\n");
			expect(await storage.readText(path.join(ROOT_B, "-q", "second.jsonl"))).toBe("second root\n");
			expect(await storage.readText(path.join(ROOT_B, "dotted.jsonl"))).toBe("dotted alias\n");
			expect(await storage.readText(path.join(ROOT_B, "doubled.jsonl"))).toBe("doubled alias\n");
			expect(await storage.readText(path.join(ROOT_B, "-src-proj", "current.jsonl"))).toBe("current\n");
			for (const [file, content] of rows.slice(4, 7)) expect(await storage.readText(file)).toBe(content);
		});

		for (const refused of REFUSED_MIGRATIONS) {
			it(`changes neither table when ${refused.name}`, async () => {
				await using db = connect();
				await (await db.open(ROOT_B)).drain();
				await refused.seed(db);
				// A row the migration would move were it not refused: no partial migration.
				await db.insertSession(`${MIGRATION_ROOT}-p/movable.jsonl`, ["movable\n"]);
				const before = await snapshot(db);

				const errors = await runKeyMigration(db, refused.roots);

				expect(await snapshot(db)).toEqual(before);
				if (refused.failsStatement) expect(errors.length).toBeGreaterThan(0);
				else expect(errors).toEqual([]);
				await expect(db.open(ROOT_B)).rejects.toThrow("holds the row key");
			});
		}

		it("restores root-relative and abs rows for an old path-key reader after the documented rollback", async () => {
			await using db = connect();
			const storage = await db.open(ROOT_B);
			const inside = path.join(ROOT_B, "-p", "rollback.jsonl");
			const outside = "/srv/rollback.jsonl";
			await storage.writeText(inside, "inside rollback\n");
			await storage.writeText(outside, "outside rollback\n");
			await storage.drain();

			expect(await runStatements(db, await documentedPartsRollbackStatements(adapter))).toEqual([]);
			expect(await runKeyRollback(db, `${ROOT_B}/`)).toEqual([]);

			expect(await db.keys()).toEqual([inside, outside].sort());
			expect(await db.keys(`${db.table}_parts`)).toEqual([]);
			expect(await readOldPathKey(db, inside)).toBe("inside rollback\n");
			expect(await readOldPathKey(db, outside)).toBe("outside rollback\n");
		});

		for (const rollback of [
			{
				name: "a restored root-relative key would collide with an abs key",
				seed: async (db: Db) => {
					await db.insertSession("sessions/-p/collision.jsonl", ["root\n"]);
					await db.insertSession(`abs:${ROOT_B}/-p/collision.jsonl`, ["abs\n"]);
				},
			},
			{
				name: "a root-relative key has a rejected segment",
				seed: async (db: Db) => {
					await db.insertSession("sessions/-p/../bad.jsonl", ["bad\n"]);
				},
			},
		]) {
			it(`leaves both tables unchanged when key rollback sees ${rollback.name}`, async () => {
				await using db = connect();
				await (await db.open(ROOT_B)).drain();
				await rollback.seed(db);
				const before = await snapshot(db);

				expect(await runKeyRollback(db, `${ROOT_B}/`)).toEqual([]);

				expect(await snapshot(db)).toEqual(before);
			});
		}
	});
}
