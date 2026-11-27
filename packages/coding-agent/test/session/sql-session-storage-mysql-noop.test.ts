/**
 * MySQL no-op-update repro: a size-checked replace with a byte-identical body
 * matches the session row but may change nothing, and MySQL reports
 * `affectedRows: 0` for such a row. That must not surface as a
 * `SessionWriteConflictError`; only a real size divergence may.
 *
 * The fake below drives the REAL `mysql` adapter branch of
 * `SqlSessionStorageBackend` on every run, with documented MySQL
 * `affectedRows` semantics: 0 when a matched row is unchanged, 1 when a row
 * is inserted, 2 when an upsert changes one. sql-session-storage-dialects.test.ts
 * covers the same replace against a live MySQL when `OMP_TEST_SQL_MYSQL_URL`
 * is set.
 */

import { describe, expect, it } from "bun:test";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";

interface FakeRow {
	byteLen: number;
	mtimeMs: number;
	title: unknown[];
}

function mysqlResult(affectedRows: number, rows: unknown[] = []): SqlSessionStorageResult {
	return Object.assign(rows, { affectedRows });
}

/** In-memory session rows and parts speaking just enough MySQL wire behavior for the test. */
function mysqlFake(): { client: SqlSessionStorageClient; stored(path: string): string | undefined } {
	const rows = new Map<string, FakeRow>();
	const parts = new Map<string, Map<number, string>>();
	const partsOf = (path: string): Map<number, string> => {
		let byOffset = parts.get(path);
		if (!byOffset) {
			byOffset = new Map();
			parts.set(path, byOffset);
		}
		return byOffset;
	};
	const orderedParts = (path: string): Array<[number, string]> =>
		[...(parts.get(path) ?? new Map<number, string>())].sort(([a], [b]) => a - b);

	const client: SqlSessionStorageClient = {
		options: { adapter: "mysql" },
		async unsafe(sql: string, values: unknown[] = []): Promise<SqlSessionStorageResult> {
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return mysqlResult(0);
			// A fresh table: the column probe finds nothing, so the store adds every column.
			if (sql.startsWith("SELECT column_name")) return mysqlResult(0);
			// Every fake row already carries its byte_len, so nothing needs a backfill.
			if (sql.startsWith("SELECT 1 AS unmeasured")) return mysqlResult(0);
			if (sql.startsWith("SELECT 1 AS found FROM omp_session_files_parts")) {
				return mysqlResult(0, orderedParts(values[0] as string).length > 0 ? [{ found: 1 }] : []);
			}
			if (sql.startsWith("SELECT path")) {
				return mysqlResult(
					0,
					[...rows].map(([path, row]) => ({
						path,
						mtime_ms: row.mtimeMs,
						byte_len: row.byteLen,
						title: null,
						title_source: null,
						title_updated_at: null,
					})),
				);
			}
			if (sql.startsWith("SELECT 0 AS kind")) {
				const path = values[0] as string;
				if (!rows.has(path)) return mysqlResult(0);
				return mysqlResult(0, [
					{ kind: 0, start_offset: 0, content: "" },
					...orderedParts(path).map(([offset, content]) => ({ kind: 1, start_offset: offset, content })),
				]);
			}
			if (sql.startsWith("SELECT byte_len")) {
				const row = rows.get(values[0] as string);
				return mysqlResult(0, row ? [{ byte_len: row.byteLen }] : []);
			}
			if (sql.startsWith("INSERT IGNORE INTO omp_session_files ")) {
				const [path, mtimeMs, title, source, updatedAt, byteLen] = values as [string, number, ...unknown[]];
				if (rows.has(path)) return mysqlResult(0);
				rows.set(path, { byteLen: byteLen as number, mtimeMs, title: [title, source, updatedAt] });
				return mysqlResult(1);
			}
			if (sql.startsWith("INSERT INTO omp_session_files_parts")) {
				if (sql.includes(" SELECT ")) {
					const [byteLen, content, path] = values as [number, string, string];
					const row = rows.get(path);
					if (row && byteLen > 0) partsOf(path).set(row.byteLen - byteLen, content);
					return mysqlResult(row && byteLen > 0 ? 1 : 0);
				}
				const [path, offset, content] = values as [string, number, string];
				partsOf(path).set(offset, content);
				return mysqlResult(1);
			}
			if (sql.startsWith("INSERT INTO omp_session_files ")) {
				const path = values[0] as string;
				const existing = rows.get(path);
				if (sql.includes("byte_len = byte_len + ?")) {
					const [, mtimeMs, byteLen] = values as [string, number, number];
					rows.set(
						path,
						existing
							? { ...existing, byteLen: existing.byteLen + byteLen, mtimeMs }
							: { byteLen, mtimeMs, title: [null, null, null] },
					);
					return mysqlResult(existing ? 2 : 1);
				}
				const [, mtimeMs, title, source, updatedAt, byteLen] = values as [string, number, ...unknown[]];
				const next: FakeRow = { byteLen: byteLen as number, mtimeMs, title: [title, source, updatedAt] };
				rows.set(path, next);
				if (!existing) return mysqlResult(1);
				// Matched but unchanged: a real MySQL upsert reports affectedRows 0 here.
				const unchanged = JSON.stringify(existing) === JSON.stringify(next);
				return mysqlResult(unchanged ? 0 : 2);
			}
			if (sql.startsWith("DELETE FROM omp_session_files_parts")) {
				parts.delete(values[0] as string);
				return mysqlResult(1);
			}
			if (sql.startsWith("DELETE FROM omp_session_files ")) {
				return mysqlResult(rows.delete(values[0] as string) ? 1 : 0);
			}
			throw new Error(`mysqlFake: unhandled statement: ${sql.slice(0, 60)}`);
		},
		async transaction(callback) {
			return callback(client);
		},
	};
	return {
		client,
		stored: path =>
			rows.has(path)
				? orderedParts(path)
						.map(([, content]) => content)
						.join("")
				: undefined,
	};
}

const BODY = "title-slot-line\nheader-line\nentry-one\n";

describe("SqlSessionStorage (MySQL no-op replace)", () => {
	it("does not latch a false conflict when affectedRows is 0 for a byte-identical body", async () => {
		// The sync publish path (`writeTextSync`, used by manager rewrites) has
		// no content readback: a backend `SessionWriteConflictError` lands in
		// the drain error latch. Identical bodies must not produce one.
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		expect(storage.adapter).toBe("mysql");

		await storage.writeText("/s/n.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		storage.writeTextSync("/s/n.jsonl", BODY, { expectedSize: size });
		await storage.drain();
		expect(stored("/s/n.jsonl")).toBe(BODY);
	});

	it("commits a byte-identical writeTextAtomic at the current size", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/a.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		await storage.writeTextAtomic("/s/a.jsonl", BODY, { expectedSize: size });
		expect(stored("/s/a.jsonl")).toBe(BODY);
	});

	it("still throws a genuine conflict when another writer changed the body", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const peer = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/c.jsonl", BODY);
		const staleSize = Buffer.byteLength(BODY, "utf8");
		await peer.refresh();
		await peer.writeText("/s/c.jsonl", `${BODY}peer-line\n`);

		await expect(storage.writeTextAtomic("/s/c.jsonl", BODY, { expectedSize: staleSize })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		expect(stored("/s/c.jsonl")).toBe(`${BODY}peer-line\n`);
	});

	it("still throws when another writer removed the row", async () => {
		const { client, stored } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const peer = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/gone.jsonl", BODY);
		await peer.refresh();
		await peer.unlink("/s/gone.jsonl");

		await expect(
			storage.writeTextAtomic("/s/gone.jsonl", BODY, { expectedSize: Buffer.byteLength(BODY, "utf8") }),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(stored("/s/gone.jsonl")).toBeUndefined();
	});
});
