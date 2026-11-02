/**
 * MySQL no-op-update repro: `replaceIfSize` with a byte-identical body matches
 * the row but changes nothing, so MySQL reports `affectedRows: 0`. That must
 * not surface as a `SessionWriteConflictError`.
 *
 * There is no live MySQL in this environment (and none in CI), so the fake
 * below drives the REAL `mysql` adapter branch of `SqlSessionStorageBackend`
 * with documented MySQL `affectedRows` semantics: 0 when a matched row is
 * unchanged, 1 when it changes, 0 when nothing matches. Repo convention for
 * dialect coverage without a server: see sql-session-storage.test.ts ("We
 * can't run a real Postgres/MySQL instance from the test process").
 *
 * Boundary: actual MySQL driver/flag behavior (e.g. CLIENT_FOUND_ROWS) is
 * unverified here; the guard under test is dialect-neutral (a size match
 * means no size-precondition conflict by definition) and mirrors the
 * verify-on-failure pattern in IndexedSessionStorage.writeTextAtomic.
 */

import { describe, expect, it } from "bun:test";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { readLatestSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-loader";

interface FakeRow {
	content: string;
	mtimeMs: number;
	title?: string | null;
	source?: string | null;
	updatedAt?: string | null;
	titleIndexedSize?: number | null;
}

function mysqlResult(affectedRows: number, rows: unknown[] = []): SqlSessionStorageResult {
	return Object.assign(rows, { affectedRows });
}

/** In-memory row store speaking just enough MySQL wire behavior for the test. */
function mysqlFake(): { client: SqlSessionStorageClient; rows: Map<string, FakeRow>; queries: string[] } {
	const rows = new Map<string, FakeRow>();
	const queries: string[] = [];
	const client: SqlSessionStorageClient = {
		options: { adapter: "mysql" },
		async unsafe(sql: string, values: unknown[] = []): Promise<SqlSessionStorageResult> {
			queries.push(sql);
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return mysqlResult(0);
			if (sql.startsWith("SELECT path")) {
				return mysqlResult(
					0,
					[...rows].map(([path, row]) => ({
						path,
						mtime_ms: row.mtimeMs,
						byte_len: Buffer.byteLength(row.content, "utf8"),
						title: row.title ?? null,
						title_source: row.source ?? null,
						title_updated_at: row.updatedAt ?? null,
						title_indexed_size: row.titleIndexedSize ?? null,
					})),
				);
			}
			if (sql.startsWith("SELECT content")) {
				const row = rows.get(values[0] as string);
				return mysqlResult(0, row ? [{ content: row.content }] : []);
			}
			if (sql.startsWith("INSERT INTO")) {
				const [path, content, mtimeMs] = values as [string, string, number];
				if (sql.includes("DO NOTHING")) {
					if (rows.has(path)) return mysqlResult(0);
					rows.set(path, { content, mtimeMs });
					return mysqlResult(1, [{ path }]);
				}
				if (sql.includes("CONCAT(content, ?)")) {
					const existing = rows.get(path);
					rows.set(path, {
						...existing,
						content: (existing?.content ?? "") + content,
						mtimeMs,
						...(values.length > 5
							? {
									title: values[3] as string | null,
									source: values[4] as string | null,
									updatedAt: values[5] as string | null,
									titleIndexedSize: values[6] as number,
								}
							: {}),
					});
					return mysqlResult(existing ? 2 : 1);
				}
				rows.set(path, {
					content,
					mtimeMs,
					title: values[3] as string | null,
					source: values[4] as string | null,
					updatedAt: values[5] as string | null,
					titleIndexedSize: values[6] as number,
				});
				return mysqlResult(1);
			}
			if (sql.startsWith("UPDATE") && sql.includes("SET title =")) {
				const path = values.at(-1) as string;
				const row = rows.get(path);
				if (!row) return mysqlResult(0);
				rows.set(path, {
					...row,
					title: values[0] as string | null,
					source: values[1] as string | null,
					updatedAt: values[2] as string | null,
					mtimeMs: values[3] as number,
					titleIndexedSize: values.length === 6 ? (values[4] as number) : null,
				});
				return mysqlResult(1);
			}
			if (sql.startsWith("UPDATE")) {
				const [content, mtimeMs, title, source, updatedAt, titleIndexedSize, path, expectedSize] = values as [
					string,
					number,
					string | null,
					string | null,
					string | null,
					number,
					string,
					number,
				];
				const row = rows.get(path);
				if (!row || Buffer.byteLength(row.content, "utf8") !== expectedSize) {
					return mysqlResult(0);
				}
				if (row.content === content) {
					// Matched but unchanged: a real MySQL UPDATE reports
					// affectedRows 0 here (unless CLIENT_FOUND_ROWS is set).
					return mysqlResult(0);
				}
				rows.set(path, { content, mtimeMs, title, source, updatedAt, titleIndexedSize });
				return mysqlResult(1);
			}
			throw new Error(`mysqlFake: unhandled statement: ${sql.slice(0, 60)}`);
		},
		async transaction(callback) {
			return callback(client);
		},
	};
	return { client, rows, queries };
}

const BODY = "title-slot-line\nheader-line\nentry-one\n";

describe("SqlSessionStorage (MySQL no-op replace)", () => {
	it("does not latch a false conflict when affectedRows is 0 for a byte-identical body", async () => {
		// The sync publish path (`writeTextSync`, used by manager rewrites) has
		// no content readback: a backend `SessionWriteConflictError` lands in
		// the drain error latch. Identical bodies must not produce one.
		const { client, rows } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		expect(storage.adapter).toBe("mysql");

		await storage.writeText("/s/n.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		storage.writeTextSync("/s/n.jsonl", BODY, { expectedSize: size });
		await storage.drain();
		expect(rows.get("/s/n.jsonl")?.content).toBe(BODY);
	});

	it("writeTextAtomic already absorbs the identical-body case via readback", async () => {
		// Characterization: IndexedSessionStorage.writeTextAtomic re-reads on
		// backend failure and accepts content equality, so the async path never
		// surfaced the false positive. This pins that behavior.
		const { client, rows } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/a.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		await storage.writeTextAtomic("/s/a.jsonl", BODY, { expectedSize: size });
		expect(rows.get("/s/a.jsonl")?.content).toBe(BODY);
	});

	it("still throws a genuine conflict when another writer changed the body", async () => {
		const { client } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/c.jsonl", BODY);
		const staleSize = Buffer.byteLength(BODY, "utf8");
		await storage.writeText("/s/c.jsonl", `${BODY}peer-line\n`);

		await expect(storage.writeTextAtomic("/s/c.jsonl", BODY, { expectedSize: staleSize })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
	});

	it("still throws when the row is missing", async () => {
		const { client } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });

		await expect(storage.writeTextAtomic("/s/gone.jsonl", BODY, { expectedSize: 42 })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
	});

	it("persists title append metadata through the real MySQL adapter branch across reopen", async () => {
		const { client, rows } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const file = "/s/title.jsonl";
		const body = '{"type":"session","id":"mysql-title"}\n';
		await storage.writeText(file, body);
		const writer = storage.openWriter(file);
		const line = '{"type":"title_change","title":"MySQL journal","source":"user","timestamp":"t2"}\n';
		await writer.append(line);
		await writer.close();
		expect(rows.get(file)).toMatchObject({
			content: body + line,
			title: "MySQL journal",
			source: "user",
			updatedAt: "t2",
			titleIndexedSize: Buffer.byteLength(body + line),
		});
		const reopened = await SqlSessionStorage.create({ client });
		expect(await readLatestSessionTitle(file, reopened)).toEqual({
			title: "MySQL journal",
			source: "user",
			updatedAt: "t2",
		});
	});
	it("persists direct metadata title authority through the MySQL adapter without reading an older journal", async () => {
		const { client, rows, queries } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const file = "/s/direct-title.jsonl";
		const body =
			'{"type":"session","id":"direct"}\n' +
			'{"type":"title_change","title":"Older journal","source":"auto","timestamp":"2099"}\n';
		await storage.writeText(file, body);
		const title = { title: "New metadata", source: "user" as const, updatedAt: "1900" };
		queries.length = 0;
		await storage.updateSessionTitle(file, title);
		expect(rows.get(file)).toMatchObject({
			content: body,
			title: title.title,
			source: title.source,
			updatedAt: title.updatedAt,
			titleIndexedSize: Buffer.byteLength(body),
		});
		expect(await storage.readLatestTitle(file)).toEqual(title);
		const reopened = await SqlSessionStorage.create({ client });
		expect(await reopened.readLatestTitle(file)).toEqual(title);
		expect(queries.some(query => query.startsWith("SELECT content"))).toBe(false);
	});
});
