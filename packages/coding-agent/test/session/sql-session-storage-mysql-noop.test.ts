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

interface FakeRow {
	content: string;
	mtimeMs: number;
}

function mysqlResult(affectedRows: number, rows: unknown[] = []): SqlSessionStorageResult {
	return Object.assign(rows, { affectedRows });
}

/** In-memory row store speaking just enough MySQL wire behavior for the test. */
function mysqlFake(): { client: SqlSessionStorageClient; rows: Map<string, FakeRow> } {
	const rows = new Map<string, FakeRow>();
	const client: SqlSessionStorageClient = {
		options: { adapter: "mysql" },
		async unsafe(sql: string, values: unknown[] = []): Promise<SqlSessionStorageResult> {
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return mysqlResult(0);
			if (sql.startsWith("SELECT path")) {
				return mysqlResult(
					0,
					[...rows].map(([path, row]) => ({
						path,
						mtime_ms: row.mtimeMs,
						byte_len: Buffer.byteLength(row.content, "utf8"),
						title: null,
						title_source: null,
						title_updated_at: null,
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
				if (values.length === 3) {
					const existing = rows.get(path);
					rows.set(path, { content: (existing?.content ?? "") + content, mtimeMs });
					return mysqlResult(existing ? 2 : 1);
				}
				rows.set(path, { content, mtimeMs });
				return mysqlResult(1);
			}
			if (sql.startsWith("UPDATE")) {
				const [content, mtimeMs, , , , path, expectedSize] = values as [
					string,
					number,
					unknown,
					unknown,
					unknown,
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
				rows.set(path, { content, mtimeMs });
				return mysqlResult(1);
			}
			throw new Error(`mysqlFake: unhandled statement: ${sql.slice(0, 60)}`);
		},
	};
	return { client, rows };
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
});
