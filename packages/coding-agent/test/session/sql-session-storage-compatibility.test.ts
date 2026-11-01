import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

interface CapturedQuery {
	sql: string;
	values: unknown[];
}

const SIX_COLUMNS =
	"path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT";
const OLD_BODY =
	serializeTitleSlot({ title: "Slot", updatedAt: "slot" }) +
	'{"type":"session","id":"compat","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/repo"}\n' +
	'{"type":"title_change","title":"Older journal","source":"auto","timestamp":"2099-01-01"}\n';
const DIRECT_TITLE = { title: "Direct metadata", source: "user" as const, updatedAt: "1900-01-01" };

function wrapSqlite(client: InstanceType<typeof SQL>, queries: CapturedQuery[]): SqlSessionStorageClient {
	return {
		options: { adapter: "sqlite" },
		unsafe(sql, values = []) {
			queries.push({ sql, values });
			return client.unsafe(sql, values);
		},
		transaction(callback) {
			return client.transaction(async transaction => callback(transaction));
		},
	};
}

function fullReads(queries: CapturedQuery[]): CapturedQuery[] {
	return queries.filter(query => /SELECT\s+content\s+AS\s+content/i.test(query.sql));
}

function authorityProbes(queries: CapturedQuery[]): CapturedQuery[] {
	return queries.filter(query => query.sql.startsWith("SELECT path") && query.sql.includes("title_indexed_size"));
}

describe("SqlSessionStorage optional title authority compatibility", () => {
	for (const columns of [6, 7] as const) {
		it(`supports external ${columns}-column schemas without DDL through writes, journal append, refresh and reopen`, async () => {
			const client = new SQL("sqlite::memory:");
			try {
				await client.unsafe(
					`CREATE TABLE omp_session_files (${SIX_COLUMNS}${columns === 7 ? ", title_indexed_size INTEGER" : ""})`,
				);
				const queries: CapturedQuery[] = [];
				const wrapped = wrapSqlite(client, queries);
				const storage = await SqlSessionStorage.create({ client: wrapped, createTable: false });
				const file = "/sessions/p/external.jsonl";
				await storage.writeText(file, OLD_BODY);
				const writer = storage.openWriter(file);
				await writer.append(
					'{"type":"title_change","title":"Appended journal","source":"user","timestamp":"t2"}\n',
				);
				await writer.close();
				expect((await storage.readLatestTitle(file))?.title).toBe("Appended journal");
				await storage.refresh();
				expect((await storage.readLatestTitle(file))?.title).toBe("Appended journal");
				const reopened = await SqlSessionStorage.create({ client: wrapped, createTable: false });
				expect((await reopened.readLatestTitle(file))?.title).toBe("Appended journal");
				expect(queries.some(query => /^(CREATE|ALTER)\s/i.test(query.sql))).toBe(false);
				expect(fullReads(queries)).toHaveLength(0);
				expect(authorityProbes(queries)).toHaveLength(columns === 6 ? 2 : 3);
				if (columns === 6) {
					expect(
						queries
							.filter(query => !query.sql.startsWith("SELECT path"))
							.every(query => !query.sql.includes("title_indexed_size")),
					).toBe(true);
				}
			} finally {
				await client.end();
			}
		});

		it(`preserves newer metadata-only titles over older journal titles in external ${columns}-column schemas`, async () => {
			const client = new SQL("sqlite::memory:");
			try {
				await client.unsafe(
					`CREATE TABLE omp_session_files (${SIX_COLUMNS}${columns === 7 ? ", title_indexed_size INTEGER" : ""})`,
				);
				const queries: CapturedQuery[] = [];
				const wrapped = wrapSqlite(client, queries);
				const storage = await SqlSessionStorage.create({ client: wrapped, createTable: false });
				const file = "/sessions/p/direct.jsonl";
				await storage.writeText(file, OLD_BODY);
				const writer = storage.openWriter(file);
				const appended = '{"type":"custom","data":"queued before metadata"}\n';
				const pending = writer.append(appended);
				queries.length = 0;
				await storage.updateSessionTitle(file, DIRECT_TITLE);
				await pending;
				await writer.close();
				expect(await storage.readLatestTitle(file)).toEqual(DIRECT_TITLE);
				if (columns === 7) {
					const rows = await client.unsafe("SELECT title_indexed_size FROM omp_session_files WHERE path = ?", [
						file,
					]);
					expect(rows[0]?.title_indexed_size).toBe(Buffer.byteLength(OLD_BODY + appended));
				}
				await storage.refresh();
				const reopened = await SqlSessionStorage.create({ client: wrapped, createTable: false });
				expect(await storage.readLatestTitle(file)).toEqual(DIRECT_TITLE);
				expect(await reopened.readLatestTitle(file)).toEqual(DIRECT_TITLE);
				expect((await listSessions("/sessions/p", reopened)).find(session => session.path === file)?.title).toBe(
					DIRECT_TITLE.title,
				);
				expect(fullReads(queries)).toHaveLength(0);
				const cleared = { title: undefined, source: "user" as const, updatedAt: "clear" };
				await reopened.updateSessionTitle(file, cleared);
				const clearedReopen = await SqlSessionStorage.create({ client: wrapped, createTable: false });
				expect(await clearedReopen.readLatestTitle(file)).toEqual(cleared);
				expect(fullReads(queries)).toHaveLength(0);
				const rows = await client.unsafe("SELECT content FROM omp_session_files WHERE path = ?", [file]);
				expect(rows[0]?.content).toBe(OLD_BODY + appended);
			} finally {
				await client.end();
			}
		});
	}

	it("persists drained direct title authority on the default SQLite schema without body reads", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			const queries: CapturedQuery[] = [];
			const wrapped = wrapSqlite(client, queries);
			const storage = await SqlSessionStorage.create({ client: wrapped });
			const file = "/sessions/p/default-direct.jsonl";
			await storage.writeText(file, OLD_BODY);
			queries.length = 0;
			await storage.updateSessionTitle(file, DIRECT_TITLE);
			expect(await storage.readLatestTitle(file)).toEqual(DIRECT_TITLE);
			const reopened = await SqlSessionStorage.create({ client: wrapped });
			expect(await reopened.readLatestTitle(file)).toEqual(DIRECT_TITLE);
			expect(fullReads(queries)).toHaveLength(0);
			const rows = await client.unsafe("SELECT content, title_indexed_size FROM omp_session_files WHERE path = ?", [
				file,
			]);
			expect(rows[0]).toMatchObject({ content: OLD_BODY, title_indexed_size: Buffer.byteLength(OLD_BODY) });
		} finally {
			await client.end();
		}
	});

	it("bootstraps the authority column on an existing six-column schema when DDL is enabled", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			await client.unsafe(`CREATE TABLE omp_session_files (${SIX_COLUMNS})`);
			const storage = await SqlSessionStorage.create({ client });
			await storage.writeText("/s/bootstrap.jsonl", OLD_BODY);
			const rows = await client.unsafe("SELECT title_indexed_size FROM omp_session_files");
			expect(rows[0]?.title_indexed_size).toBe(Buffer.byteLength(OLD_BODY));
		} finally {
			await client.end();
		}
	});

	it("lazily reconciles unindexed six-column rows with bounded slices and caches the result", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			await client.unsafe(`CREATE TABLE omp_session_files (${SIX_COLUMNS})`);
			await client.unsafe("INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)", [
				"/s/legacy.jsonl",
				OLD_BODY,
				1,
			]);
			const queries: CapturedQuery[] = [];
			const storage = await SqlSessionStorage.create({ client: wrapSqlite(client, queries), createTable: false });
			expect(queries.some(query => /AS head/.test(query.sql))).toBe(false);
			expect(fullReads(queries)).toHaveLength(0);
			expect((await storage.readLatestTitle("/s/legacy.jsonl"))?.title).toBe("Older journal");
			expect(queries.filter(query => /AS head/.test(query.sql))).toHaveLength(1);
			expect(fullReads(queries)).toHaveLength(0);
			const count = queries.length;
			expect((await storage.readLatestTitle("/s/legacy.jsonl"))?.title).toBe("Older journal");
			expect(queries).toHaveLength(count);
			await storage.refresh();
			expect((await storage.readLatestTitle("/s/legacy.jsonl"))?.title).toBe("Older journal");
			expect(authorityProbes(queries)).toHaveLength(1);
		} finally {
			await client.end();
		}
	});

	it("keeps six-column insert-if-missing and size-CAS writes atomic against peer changes", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			await client.unsafe(`CREATE TABLE omp_session_files (${SIX_COLUMNS})`);
			const storage = await SqlSessionStorage.create({ client, createTable: false });
			const file = "/s/cas.jsonl";
			storage.writeTextSync(file, "first", { expectedSize: null });
			await storage.drain();
			storage.writeTextSync(file, "replacement", { expectedSize: 5 });
			await storage.drain();
			await client.unsafe("UPDATE omp_session_files SET content = ? WHERE path = ?", [
				"peer body longer than replacement",
				file,
			]);
			storage.writeTextSync(file, "must not land", { expectedSize: 11 });
			await expect(storage.drain()).rejects.toBeInstanceOf(SessionWriteConflictError);
			await client.unsafe("INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)", [
				"/s/peer.jsonl",
				"peer",
				1,
			]);
			storage.writeTextSync("/s/peer.jsonl", "must not insert", { expectedSize: null });
			await expect(storage.drain()).rejects.toBeInstanceOf(SessionWriteConflictError);
			const rows = await client.unsafe("SELECT content FROM omp_session_files ORDER BY path");
			expect(rows.map((row: { content: string }) => row.content)).toEqual([
				"peer body longer than replacement",
				"peer",
			]);
		} finally {
			await client.end();
		}
	});
	it("preserves authoritative six-column title/source fields when the update timestamp is unknown", async () => {
		const client = new SQL("sqlite::memory:"),
			queries: CapturedQuery[] = [];
		try {
			await client.unsafe(`CREATE TABLE omp_session_files (${SIX_COLUMNS})`);
			for (const [file, title, source] of [
				["/s/title-only", "Known title", null],
				["/s/source-only", null, "user"],
			]) {
				await client.unsafe("INSERT INTO omp_session_files VALUES (?, ?, ?, ?, ?, ?)", [
					file,
					OLD_BODY,
					1,
					title,
					source,
					null,
				]);
			}
			const storage = await SqlSessionStorage.create({ client: wrapSqlite(client, queries), createTable: false });
			queries.length = 0;
			expect(await storage.readLatestTitle("/s/title-only")).toEqual({
				title: "Known title",
				source: undefined,
				updatedAt: "",
			});
			expect(await storage.readLatestTitle("/s/source-only")).toEqual({
				title: undefined,
				source: "user",
				updatedAt: "",
			});
			expect(queries).toEqual([]);
			const timestamps = await client.unsafe("SELECT title_updated_at FROM omp_session_files");
			expect(timestamps.map((row: { title_updated_at: string | null }) => row.title_updated_at)).toEqual([
				null,
				null,
			]);
		} finally {
			await client.end();
		}
	});
});

function missingColumn(adapter: SqlSessionStorageAdapter): Error {
	if (adapter === "postgres")
		return Object.assign(new Error('column "title_indexed_size" does not exist'), { code: "42703" });
	if (adapter === "mysql")
		return Object.assign(new Error("Unknown column 'title_indexed_size' in 'field list'"), {
			code: "ER_BAD_FIELD_ERROR",
			errno: 1054,
		});
	return new Error("no such column: title_indexed_size");
}

describe("SqlSessionStorage optional authority dialect contracts", () => {
	for (const adapter of ["postgres", "mysql", "sqlite"] as const) {
		it(`${adapter} latches genuine missing-column fallback with correctly bound six-column mutations`, async () => {
			const queries: CapturedQuery[] = [];
			const legacyBody = '{"type":"session","id":"legacy"}\n';
			const client: SqlSessionStorageClient = {
				options: { adapter },
				async unsafe(sql, values = []) {
					queries.push({ sql, values });
					if (sql.includes("title_indexed_size")) throw missingColumn(adapter);
					if (sql.startsWith("SELECT path"))
						return [
							{
								path: "/s/legacy.jsonl",
								mtime_ms: 1,
								byte_len: Buffer.byteLength(legacyBody),
								title: null,
								title_source: null,
								title_updated_at: null,
							},
						];
					if (sql.includes("AS head")) return [{ head: legacyBody, tail: legacyBody }];
					return Object.assign(sql.includes("RETURNING") ? [{ path: values.at(-1) }] : [], {
						affectedRows: 1,
					}) as SqlSessionStorageResult;
				},
				async transaction(callback) {
					return callback(client);
				},
			};
			const storage = await SqlSessionStorage.create({ client, createTable: false });
			await storage.writeText("/s/upsert.jsonl", OLD_BODY);
			storage.writeTextSync("/s/insert.jsonl", OLD_BODY, { expectedSize: null });
			await storage.drain();
			storage.writeTextSync("/s/insert.jsonl", OLD_BODY + "\n", { expectedSize: Buffer.byteLength(OLD_BODY) });
			await storage.drain();
			const writer = storage.openWriter("/s/upsert.jsonl");
			await writer.append('{"type":"title_change","title":"Journal","timestamp":"t2"}\n');
			await writer.close();
			await storage.updateSessionTitle("/s/upsert.jsonl", DIRECT_TITLE);
			expect(await storage.readLatestTitle("/s/legacy.jsonl")).toBeUndefined();
			await storage.refresh();
			expect(authorityProbes(queries)).toHaveLength(1);
			expect(queries.some(query => /^(CREATE|ALTER)\s/i.test(query.sql))).toBe(false);
			const mutations = queries.filter(query => /^(INSERT|UPDATE)\s/.test(query.sql));
			expect(mutations).toHaveLength(6);
			for (const query of mutations) {
				expect(query.sql).not.toContain("title_indexed_size");
				const placeholders =
					adapter === "postgres"
						? [...query.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
						: [...query.sql.matchAll(/\?/g)].map((_, index) => index + 1);
				expect(Math.max(...placeholders)).toBe(query.values.length);
			}
			const upsert = mutations[0];
			expect(upsert.values.slice(3, 6)).toEqual(["Older journal", "auto", "2099-01-01"]);
			if (adapter === "mysql") {
				expect(upsert.values).toHaveLength(11);
				expect(upsert.values.slice(6)).toEqual([
					OLD_BODY,
					expect.any(Number),
					"Older journal",
					"auto",
					"2099-01-01",
				]);
				expect(mutations[3].values).toHaveLength(11);
				expect(mutations[3].sql).toContain("CONCAT(content, ?)");
			} else {
				expect(upsert.values).toHaveLength(6);
			}
			expect(mutations[4].values).toEqual([
				DIRECT_TITLE.title,
				DIRECT_TITLE.source,
				DIRECT_TITLE.updatedAt,
				expect.any(Number),
				"/s/upsert.jsonl",
			]);
			expect(mutations[5].values).toEqual([null, null, null, "/s/legacy.jsonl", Buffer.byteLength(legacyBody)]);
		});

		for (const error of [
			new Error("permission denied for title_indexed_size"),
			new Error("no such table: omp_session_files"),
			new Error("no such column: another_column"),
			new Error("connection lost while selecting title_indexed_size"),
		]) {
			it(`${adapter} propagates ${error.message} without fallback`, async () => {
				const queries: string[] = [];
				const client: SqlSessionStorageClient = {
					options: { adapter },
					async unsafe(sql) {
						queries.push(sql);
						throw error;
					},
					async transaction(callback) {
						return callback(client);
					},
				};
				await expect(SqlSessionStorage.create({ client, createTable: false })).rejects.toBe(error);
				expect(queries).toHaveLength(1);
			});
		}
	}
});
