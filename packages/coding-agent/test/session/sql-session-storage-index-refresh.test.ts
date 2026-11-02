/**
 * A `SqlSessionStorage` loads no rows at start and refreshes its index, one
 * scope at a time, at each listing, lookup and roster entry, so sessions other
 * processes create, retitle or delete show here without a restart. These run
 * against SQLite always, and against PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database (PostgreSQL directly or through a transaction-mode pooler); every
 * test makes its own tables and drops them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { SESSION_INDEX_REFRESH_COALESCE_MS } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	listAllSessions,
	listSessions,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { defaultSessionStorage, setDefaultSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
	SqlSessionStorage,
	sessionRowKey,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SQL } from "bun";
import { sessionSqlTestClient } from "../helpers/session-sql-client";

type SqlClient = InstanceType<typeof SQL>;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

/** Every index load `SqlSessionStorage` issues starts this way, at PR 1's head and after. */
const INDEX_READ = "SELECT path, mtime_ms";

/** A current-version transcript: title slot, header, one user turn, one assistant reply. */
function transcript(id: string, cwd: string, text: string): string {
	const timestamp = "2026-11-02T00:00:00.000Z";
	return `${serializeTitleSlot({ updatedAt: timestamp })}${[
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

/** The session file `<root>/<bucket>/<timestamp>_<id>.jsonl`, as `SessionManager` names one. */
function sessionFile(root: string, bucket: string, id: string): string {
	return path.join(root, bucket, `2026-11-02T00-00-00-000Z_${id}.jsonl`);
}

/** One index load a store issued: its statement and the row keys it returned. */
interface IndexRead {
	sql: string;
	keys: string[];
}

/** Parks index loads while `armed`, signalling `reached` once one is parked. */
interface IndexHold {
	armed: boolean;
	reached: () => void;
	release: Promise<void>;
}

/**
 * A client over `client` that records every index load and, while `hold` is
 * armed, parks each one after the database answered it and before the store
 * sees the rows: the snapshot is taken, the merge has not run.
 */
function recordingClient(client: SqlClient, reads: IndexRead[], hold?: IndexHold): SqlSessionStorageClient {
	const run = async (sql: string, values: unknown[] | undefined, executor: SqlSessionStorageTransaction) => {
		const result = await executor.unsafe(sql, values);
		if (sql.startsWith(INDEX_READ)) {
			const keys = [...result].map(row =>
				typeof row === "object" && row !== null && "path" in row ? String(row.path) : "",
			);
			reads.push({ sql, keys });
			if (hold?.armed) {
				hold.reached();
				await hold.release;
			}
		}
		return result;
	};
	return {
		options: client.options,
		unsafe: (sql, values) => run(sql, values, client),
		transaction: work =>
			client.transaction(transaction => work({ unsafe: (sql, values) => run(sql, values, transaction) })),
	};
}

let tableSeq = 0;

/** One test's tables on one database, dropped when done. */
class Db implements AsyncDisposable {
	readonly table = `omp_ir_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
		readonly root: string,
	) {
		this.client = sessionSqlTestClient(url);
	}

	open(client: SqlSessionStorageClient = this.client): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client, table: this.table, sessionsRoot: this.root, adapter: this.adapter });
	}

	/** Fixture SQL written with `?` placeholders, on any dialect. */
	async sql(query: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		return (await this.client.unsafe(text, values)) as Record<string, unknown>[];
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_parts`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}_meta`);
		await this.client.unsafe(`DROP TABLE IF EXISTS ${this.table}`);
		await this.client.end();
	}
}

/** Drive `performance.now()`, the refresh window's clock, by hand. */
function fakeClock(): { advance(ms: number): void } {
	let now = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => now);
	return {
		advance(ms: number) {
			now += ms;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage index refresh (${adapter})`, () => {
		it("issues no index read when it starts", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const writer = await db.open();
			await writer.writeText(sessionFile(db.root, "-proj", "01a00000-0000-7000-8000-00000000000a"), "x\n");
			await writer.drain();

			const reads: IndexRead[] = [];
			await db.open(recordingClient(db.client, reads));

			expect(reads).toEqual([]);
		});

		it("shows a session another store creates, retitles and deletes, without a restart", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const clock = fakeClock();
			const cwd = tempDir.join("proj");
			const dir = path.join(db.root, "-proj");
			const id = "01a00000-0000-7000-8000-000000000001";
			const file = sessionFile(db.root, "-proj", id);

			const reader = await db.open();
			expect(await listSessions(dir, reader)).toEqual([]);

			const writer = await db.open();
			await writer.writeText(file, transcript(id, cwd, "created elsewhere"));
			await writer.drain();
			clock.advance(SESSION_INDEX_REFRESH_COALESCE_MS + 1);

			expect((await listSessions(dir, reader)).map(session => session.path)).toEqual([file]);
			expect((await listAllSessions(reader, db.root)).map(session => session.path)).toEqual([file]);
			expect((await resolveResumableSession(id.slice(0, 8), cwd, dir, reader))?.session.path).toBe(file);

			await writer.updateSessionTitle(file, { title: "Retitled elsewhere", source: "user", updatedAt: "t1" });
			clock.advance(SESSION_INDEX_REFRESH_COALESCE_MS + 1);
			expect((await listSessions(dir, reader)).map(session => session.title)).toEqual(["Retitled elsewhere"]);

			await writer.deleteSessionWithArtifacts(file);
			clock.advance(SESSION_INDEX_REFRESH_COALESCE_MS + 1);
			expect(await listSessions(dir, reader)).toEqual([]);
			expect(await listAllSessions(reader, db.root)).toEqual([]);
			expect(await resolveResumableSession(id.slice(0, 8), cwd, dir, reader)).toBeUndefined();
		});

		it("keeps a local write and a local unlink made while a refresh reads the backend", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const dir = path.join(db.root, "-proj");
			const removed = path.join(dir, "removed.jsonl");
			const added = path.join(dir, "added.jsonl");
			const seed = await db.open();
			await seed.writeText(removed, "old\n");
			await seed.drain();

			const reached = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const hold: IndexHold = { armed: false, reached: reached.resolve, release: release.promise };
			const reads: IndexRead[] = [];
			const storage = await db.open(recordingClient(db.client, reads, hold));
			await storage.exists(removed);
			expect(storage.existsSync(removed)).toBe(true);

			hold.armed = true;
			const refreshing = storage.refresh({ kind: "dir", dir });
			// The snapshot holds `removed` and lacks `added`; both change locally before the merge.
			await reached.promise;
			expect(reads.at(-1)?.keys).toEqual([sessionRowKey(removed, db.root)]);
			storage.writeTextSync(added, "local\n");
			const unlinking = storage.unlink(removed);
			// The unlink drops its index entry once its (idle) path queue yields a microtask.
			for (let turn = 0; turn < 10 && storage.existsSync(removed); turn++) await Promise.resolve();
			expect(storage.existsSync(removed)).toBe(false);
			release.resolve();
			await refreshing;
			await unlinking;

			expect(storage.existsSync(added)).toBe(true);
			expect(storage.statSync(added).size).toBe(Buffer.byteLength("local\n"));
			expect(storage.existsSync(removed)).toBe(false);
			await storage.drain();
			expect(await storage.readText(added)).toBe("local\n");
		});

		it("reads the index once for listings within the refresh window and again after it", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const clock = fakeClock();
			const dir = path.join(db.root, "-proj");
			const reads: IndexRead[] = [];
			const storage = await db.open(recordingClient(db.client, reads));

			await listSessions(dir, storage);
			clock.advance(SESSION_INDEX_REFRESH_COALESCE_MS - 1);
			await listSessions(dir, storage);
			expect(reads).toHaveLength(1);

			clock.advance(2);
			await listSessions(dir, storage);
			expect(reads).toHaveLength(2);
		});

		it("never indexes a row of kind artifact", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const dir = path.join(db.root, "-proj");
			const artifact = path.join(dir, "2026-11-02T00-00-00-000Z_01a00000-0000-7000-8000-000000000002.jsonl");
			await (await db.open()).drain();
			await db.sql(
				`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len, kind) VALUES (?, '', 1, 0, 'artifact')`,
				[sessionRowKey(artifact, db.root)],
			);

			const storage = await db.open();
			await storage.refresh();

			expect(storage.existsSync(artifact)).toBe(false);
			expect(storage.listFilesSync(dir, "*.jsonl")).toEqual([]);
		});

		it("loads only the listed directory's rows for a directory listing", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const cwd = tempDir.join("proj");
			const listed = sessionFile(db.root, "-listed", "01a00000-0000-7000-8000-000000000003");
			const child = path.join(listed.slice(0, -".jsonl".length), "Worker.jsonl");
			const other = sessionFile(db.root, "-other", "01a00000-0000-7000-8000-000000000004");
			const writer = await db.open();
			await writer.writeText(listed, transcript("listed", cwd, "listed"));
			await writer.writeText(child, transcript("child", cwd, "child"));
			await writer.writeText(other, transcript("other", cwd, "other"));
			await writer.drain();

			const reads: IndexRead[] = [];
			const reader = await db.open(recordingClient(db.client, reads));
			const sessions = await listSessions(path.dirname(listed), reader);

			expect(sessions.map(session => session.path)).toEqual([listed]);
			expect(reads.flatMap(read => read.keys).sort()).toEqual(
				[sessionRowKey(listed, db.root), sessionRowKey(child, db.root)].sort(),
			);
			expect(reader.existsSync(other)).toBe(false);
		});

		it("lists in the history:// roster a subagent transcript another store wrote after this one started", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const cwd = tempDir.join("proj");
			const root = sessionFile(db.root, "-proj", "01a00000-0000-7000-8000-000000000005");
			const child = path.join(root.slice(0, -".jsonl".length), "Worker.jsonl");

			const reader = await db.open();
			const writer = await db.open();
			await writer.writeText(root, transcript("root", cwd, "root"));
			await writer.writeText(child, transcript("child", cwd, "child brief"));
			await writer.drain();

			const registry = new AgentRegistry();
			expect(await ensurePersistedRoster(registry, root, reader)).toBe(root);

			expect(registry.get("Worker")?.sessionFile).toBe(child);
			expect(registry.get("Worker")?.status).toBe("parked");
		});

		it("renames a session another store created after this one started", async () => {
			using tempDir = TempDir.createSync("@omp-index-refresh-");
			await using db = new Db(adapter, url ?? "", tempDir.join("sessions"));
			const cwd = tempDir.join("proj");
			const file = sessionFile(db.root, "-proj", "01a00000-0000-7000-8000-000000000006");
			const previous = defaultSessionStorage();
			const reader = await db.open();
			setDefaultSessionStorage(reader);
			try {
				const writer = await db.open();
				await writer.writeText(file, transcript("01a00000-0000-7000-8000-000000000006", cwd, "made elsewhere"));
				await writer.drain();

				const renamed = await SessionManager.renameSessionTitle(file, "Renamed here", { cwd });
				await reader.drain();
				const later = await db.open();
				const [listed] = await listSessions(path.dirname(file), later);

				expect([renamed, listed?.title]).toEqual(["Renamed here", "Renamed here"]);
			} finally {
				setDefaultSessionStorage(previous);
			}
		});
	});
}
