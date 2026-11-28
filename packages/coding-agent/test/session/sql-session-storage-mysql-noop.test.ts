/**
 * MySQL no-op-update repro: `replaceIfSize` with a byte-identical body matches
 * the row but changes nothing, so MySQL reports `affectedRows: 0`. That must
 * not surface as a `SessionWriteConflictError`. A title update that leaves its
 * row as it was gets the same count, and must not surface as `ENOENT`; one
 * that matches no row must, even when another process creates a row at the
 * path before the check that follows the update.
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

import { describe, expect, it, spyOn } from "bun:test";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

interface FakeRow {
	content: string;
	mtimeMs: number;
	/** The row's `title`, `title_source` and `title_updated_at` columns, NULL as null. */
	title: unknown;
	titleSource: unknown;
	titleUpdatedAt: unknown;
}

function mysqlResult(affectedRows: number, rows: unknown[] = []): SqlSessionStorageResult {
	return Object.assign(rows, { affectedRows });
}

/** The title columns of `row` as a read selects them. */
function titleColumns(row: FakeRow): Record<string, unknown> {
	return { title: row.title, title_source: row.titleSource, title_updated_at: row.titleUpdatedAt };
}

/** In-memory row store speaking just enough MySQL wire behavior for the test. */
function mysqlFake(): { client: SqlSessionStorageClient; rows: Map<string, FakeRow> } {
	const rows = new Map<string, FakeRow>();
	const client: SqlSessionStorageClient = {
		options: { adapter: "mysql" },
		async unsafe(sql: string, values: unknown[] = []): Promise<SqlSessionStorageResult> {
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return mysqlResult(0);
			// The index load: each row's path, time and size.
			if (sql.startsWith("SELECT path")) {
				return mysqlResult(
					0,
					[...rows].map(([path, row]) => ({
						path,
						mtime_ms: row.mtimeMs,
						byte_len: Buffer.byteLength(row.content, "utf8"),
					})),
				);
			}
			// A whole read: the content with the row's title columns.
			if (sql.startsWith("SELECT content")) {
				const row = rows.get(values[0] as string);
				return mysqlResult(0, row ? [{ content: row.content, ...titleColumns(row) }] : []);
			}
			// A slice read: the first and last bytes asked for, with the row's title columns.
			if (sql.startsWith("SELECT substring")) {
				const [prefixBytes, suffixBytes, , path] = values as [number, number, number, string];
				const row = rows.get(path);
				if (!row) return mysqlResult(0);
				const bytes = Buffer.from(row.content, "utf8");
				const head = bytes.subarray(0, Math.max(0, prefixBytes));
				const tail =
					suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)) : bytes.subarray(0, 0);
				return mysqlResult(0, [{ head, tail, ...titleColumns(row) }]);
			}
			// A title check: the row's title columns and its time.
			if (sql.startsWith("SELECT title")) {
				const row = rows.get(values[0] as string);
				return mysqlResult(0, row ? [{ ...titleColumns(row), mtime_ms: row.mtimeMs }] : []);
			}
			if (sql.startsWith("INSERT INTO")) {
				const [path, content, mtimeMs] = values as [string, string, number];
				if (sql.includes("DO NOTHING")) {
					if (rows.has(path)) return mysqlResult(0);
					rows.set(path, {
						content,
						mtimeMs,
						title: values[3],
						titleSource: values[4],
						titleUpdatedAt: values[5],
					});
					return mysqlResult(1, [{ path }]);
				}
				if (sql.includes("CONCAT(content, ?)")) {
					const existing = rows.get(path);
					rows.set(path, {
						content: (existing?.content ?? "") + (values[3] as string),
						mtimeMs: values[4] as number,
						title: existing?.title ?? null,
						titleSource: existing?.titleSource ?? null,
						titleUpdatedAt: existing?.titleUpdatedAt ?? null,
					});
					return mysqlResult(existing ? 2 : 1);
				}
				rows.set(path, {
					content: values[6] as string,
					mtimeMs: values[7] as number,
					title: values[8],
					titleSource: values[9],
					titleUpdatedAt: values[10],
				});
				return mysqlResult(1);
			}
			// A title update: a matched row it leaves as it was is not counted, as a real MySQL UPDATE reports it.
			if (/^UPDATE \w+ SET title = /.test(sql)) {
				const [title, titleSource, titleUpdatedAt, mtimeMs, path] = values as [
					unknown,
					unknown,
					unknown,
					number,
					string,
				];
				const row = rows.get(path);
				if (!row) return mysqlResult(0);
				const next = { ...row, title, titleSource, titleUpdatedAt, mtimeMs };
				if (Bun.deepEquals(next, row)) return mysqlResult(0);
				rows.set(path, next);
				return mysqlResult(1);
			}
			if (sql.startsWith("UPDATE")) {
				const [content, mtimeMs, title, titleSource, titleUpdatedAt, path, expectedSize] = values as [
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
				rows.set(path, { content, mtimeMs, title, titleSource, titleUpdatedAt });
				return mysqlResult(1);
			}
			throw new Error(`mysqlFake: unhandled statement: ${sql.slice(0, 60)}`);
		},
		async transaction(callback) {
			return callback(client);
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

describe("SqlSessionStorage (MySQL title update)", () => {
	// If this regresses, a title update whose row already holds that title at that time (another process stored the
	// same update in the same millisecond) rejects as missing: the session manager rewrites a session that is there.
	it("resolves a title update that leaves an existing row as it was", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, rows } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const path = "/s/same.jsonl";
		await storage.writeText(path, BODY);
		const update: SessionTitleUpdate = { title: "Same", source: "user", updatedAt: "t1" };
		// The time this store's next update takes, and the row as another process already left it at that time.
		const next = storage.statSync(path).mtimeMs + 1_000;
		const clock = spyOn(Date, "now").mockReturnValue(next);
		cleanup.defer(() => clock.mockRestore());
		const stored: FakeRow = {
			content: BODY,
			mtimeMs: next,
			title: "Same",
			titleSource: "user",
			titleUpdatedAt: "t1",
		};
		rows.set(path, { ...stored });

		const outcome = await storage.updateSessionTitle(path, update).then(
			() => "stored",
			(error: NodeJS.ErrnoException) => error.code,
		);
		expect({ outcome, row: rows.get(path) }).toEqual({ outcome: "stored", row: stored });
	}, 30_000);

	// If this regresses, a title update for a row another process deleted resolves as if stored: the session manager
	// marks the session current instead of rewriting it, so the session stays missing from the table.
	it("rejects a title update with ENOENT when another process deleted the session's row", async () => {
		const { client, rows } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const path = "/s/deleted.jsonl";
		await storage.writeText(path, BODY);
		rows.delete(path);

		await expect(
			storage.updateSessionTitle(path, { title: "Stale", source: "user", updatedAt: "t2" }),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(rows.has(path)).toBe(false);
	}, 30_000);

	// If this regresses, a title update that matched no row resolves when another process creates a row at the path
	// before the check after the update: the session manager marks the session current though its title was never
	// written, and the row keeps the other process's title metadata.
	it("rejects a title update with ENOENT, writing nothing, when a row another process creates after it holds other title metadata or time", async () => {
		const update: SessionTitleUpdate = { title: "Ours", source: "user", updatedAt: "t2" };
		// The row another process creates once the update has matched none: the update's values but one.
		const differing: Record<string, (row: FakeRow) => FakeRow> = {
			title: row => ({ ...row, title: "Theirs" }),
			source: row => ({ ...row, titleSource: "auto" }),
			time: row => ({ ...row, titleUpdatedAt: "t1" }),
			mtime: row => ({ ...row, mtimeMs: row.mtimeMs - 1 }),
		};
		const actual: Record<string, unknown> = {};
		const expected: Record<string, unknown> = {};
		for (const [field, differ] of Object.entries(differing)) {
			const { client, rows } = mysqlFake();
			const storage = await SqlSessionStorage.create({ client });
			const path = `/s/created-${field}.jsonl`;
			await storage.writeText(path, BODY);
			rows.delete(path);
			const unsafe = client.unsafe.bind(client);
			let created: FakeRow | undefined;
			client.unsafe = async (sql, values = []) => {
				const result = await unsafe(sql, values);
				if (/^UPDATE \w+ SET title = /.test(sql)) {
					const [title, titleSource, titleUpdatedAt, mtimeMs] = values;
					created = differ({ content: BODY, mtimeMs: mtimeMs as number, title, titleSource, titleUpdatedAt });
					rows.set(path, { ...created });
				}
				return result;
			};

			const outcome = await storage.updateSessionTitle(path, update).then(
				() => "stored",
				(error: NodeJS.ErrnoException) => error.code,
			);
			actual[field] = { outcome, row: rows.get(path) };
			expected[field] = { outcome: "ENOENT", row: created };
		}
		expect(actual).toEqual(expected);
	}, 30_000);
});
