/**
 * `SqlSessionStorage` keys a session row by the file's path relative to the
 * sessions root (`sessions/…`), or by `abs:` and the absolute path for a file
 * outside it, so a session written from one home directory resolves from
 * another. These run against SQLite always, and against PostgreSQL and MySQL
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

	/** Fixture SQL written with `?` placeholders, on any dialect. */
	async sql(
		query: string,
		values: unknown[] = [],
		client: SqlClient = this.client,
	): Promise<Record<string, unknown>[]> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		return (await client.unsafe(text, values)) as Record<string, unknown>[];
	}

	async insertRow(key: string, content: string): Promise<void> {
		await this.sql(`INSERT INTO ${this.table} (path, content, mtime_ms, byte_len) VALUES (?, ?, ?, ?)`, [
			key,
			content,
			1,
			Buffer.byteLength(content),
		]);
	}

	async keys(table = this.table): Promise<string[]> {
		return (await this.sql(`SELECT path FROM ${table} ORDER BY path`)).map(row => String(row.path));
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

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

		it("reads every session byte for byte after the documented key migration", async () => {
			await using db = connect();
			await (await db.open(ROOT_B)).drain();
			const name = "2026-01-01T00-00-00-000Z_01a00000-0000-7000-8000-000000000001";
			const main = `${DOCUMENTED_OLD_ROOT}/-src-proj/${name}.jsonl`;
			const child = `${DOCUMENTED_OLD_ROOT}/-src-proj/${name}/Worker.jsonl`;
			const outside = "/srv/legion/.omp/agent/sessions/-x/other.jsonl";
			// A session written in parts, one whose bytes still sit in `content`, and one under another root.
			await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) VALUES (?, '', 1, 13)`, [main]);
			await db.sql(`INSERT INTO ${db.table}_parts (path, start_offset, content) VALUES (?, 0, ?), (?, 8, ?)`, [
				main,
				"head✓\n",
				main,
				"tail\n",
			]);
			await db.insertRow(child, "child content\n");
			await db.insertRow(outside, "elsewhere\n");

			const migration = await documentedStatements(
				adapter === "mysql" ? "-- MySQL / MariaDB" : "-- PostgreSQL and SQLite",
			);
			// BEGIN … COMMIT as written, on one connection.
			const session = adapter === "sqlite" ? db.client : new SQL(url ?? "", { max: 1 });
			try {
				for (const statement of migration) {
					await db.sql(statement.replaceAll("omp_session_files", db.table), [], session);
				}
			} finally {
				if (session !== db.client) await session.end();
			}
			for (const check of await documentedStatements(
				"SELECT count(*) FROM omp_session_files WHERE substr(path, 1, 9) <> 'sessions/' AND substr(path, 1, 4) <> 'abs:';",
			)) {
				const [row] = await db.sql(check.replaceAll("omp_session_files", db.table));
				expect(Number(Object.values(row ?? {})[0])).toBe(0);
			}

			const storage = await db.open(ROOT_B);
			expect(await storage.readText(path.join(ROOT_B, "-src-proj", `${name}.jsonl`))).toBe("head✓\ntail\n");
			expect(await storage.readText(path.join(ROOT_B, "-src-proj", name, "Worker.jsonl"))).toBe("child content\n");
			expect(await storage.readText(outside)).toBe("elsewhere\n");
			expect(await db.keys(`${db.table}_parts`)).toEqual([
				`sessions/-src-proj/${name}.jsonl`,
				`sessions/-src-proj/${name}.jsonl`,
			]);
		});
	});
}
