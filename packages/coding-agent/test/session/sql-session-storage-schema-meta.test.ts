/**
 * `SqlSessionStorage` records each completed schema check in `<table>_meta`,
 * so a start against a checked table reads no row of the session table; with
 * `createTable: false` it still refuses a row that breaks a check, through an
 * indexed probe. These run against SQLite always, and against PostgreSQL and
 * MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * throwaway database; every test makes its own tables and drops them.
 */
import { describe, expect, it } from "bun:test";
import {
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	SqlSessionStorage,
	sessionRowKey,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SQL } from "bun";
import { sessionSqlTestClient } from "../helpers/session-sql-client";

type SqlClient = InstanceType<typeof SQL>;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

const ROOT = "/home/meta/.omp/agent/sessions";

let tableSeq = 0;

class Db implements AsyncDisposable {
	readonly table = `omp_meta_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		this.client = sessionSqlTestClient(url);
	}

	open(options: { createTable?: boolean; client?: SqlSessionStorageClient } = {}): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({
			client: options.client ?? this.client,
			table: this.table,
			sessionsRoot: ROOT,
			adapter: this.adapter,
			createTable: options.createTable,
		});
	}

	/** A client over this database that records every statement it runs. */
	recording(statements: string[]): SqlSessionStorageClient {
		return {
			options: this.client.options,
			unsafe: (sql, values) => {
				statements.push(sql);
				return this.client.unsafe(sql, values);
			},
			transaction: work =>
				this.client.transaction(transaction =>
					work({
						unsafe: (sql, values) => {
							statements.push(sql);
							return transaction.unsafe(sql, values);
						},
					}),
				),
		};
	}

	async sql(query: string, values: unknown[] = []): Promise<void> {
		let n = 0;
		await this.client.unsafe(this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query, values);
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_meta`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage schema checks (${adapter})`, () => {
		it("a start against a table whose checks are recorded reads only the two indexed probes of the session table", async () => {
			await using db = new Db(adapter, url ?? "");
			const first = await db.open();
			await first.writeText(`${ROOT}/-p/s.jsonl`, "body\n");
			await first.drain();

			const statements: string[] = [];
			await db.open({ client: db.recording(statements) });

			// `<table>_meta` and `<table>_parts` are other tables: the name ends at a word boundary here.
			const readsSessionTable = new RegExp(`\\b(?:FROM|UPDATE|INTO|JOIN)\\s+${db.table}\\b`, "i");
			const reads = statements.filter(sql => readsSessionTable.test(sql));
			// One probe for a row with no byte_len, one for a legacy key; each stops at the first row.
			expect(
				reads.map(sql => [sql.startsWith(`SELECT path FROM ${db.table} WHERE `), sql.endsWith(" LIMIT 1")]),
			).toEqual([
				[true, true],
				[true, true],
			]);
			expect(reads.some(sql => sql.includes("byte_len IS NULL"))).toBe(true);
			expect(statements.some(sql => sql.includes(`${db.table}_meta`))).toBe(true);
		});

		for (const createTable of [true, false]) {
			it(`createTable: ${createTable} refuses a row an older omp wrote with no byte_len after the check was recorded`, async () => {
				await using db = new Db(adapter, url ?? "");
				await (await db.open()).drain();
				const key = sessionRowKey(`${ROOT}/-p/unmeasured.jsonl`, ROOT);
				await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) VALUES (?, ?, 1, NULL)`, [
					key,
					"older omp\n",
				]);

				await expect(db.open({ createTable })).rejects.toThrow(`row ${JSON.stringify(key)} has no byte_len`);
			});

			it(`createTable: ${createTable} refuses a legacy key an older omp wrote after the check was recorded`, async () => {
				await using db = new Db(adapter, url ?? "");
				await (await db.open()).drain();
				await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) VALUES (?, '', 1, 0)`, [
					"/home/old/.omp/agent/sessions/-p/legacy.jsonl",
				]);

				await expect(db.open({ createTable })).rejects.toThrow(
					'holds the row key "/home/old/.omp/agent/sessions/-p/legacy.jsonl"',
				);
			});
		}

		it("createTable: false starts on a checked table with both checks recorded", async () => {
			await using db = new Db(adapter, url ?? "");
			const first = await db.open();
			await first.writeText(`${ROOT}/-p/s.jsonl`, "body\n");
			await first.drain();

			const storage = await db.open({ createTable: false });
			expect(await storage.readText(`${ROOT}/-p/s.jsonl`)).toBe("body\n");
		});
	});
}
