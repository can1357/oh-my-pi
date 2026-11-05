/**
 * Moving a session under `session.storage: sql` never replaces a session
 * another client of the same database wrote at the destination: not one it
 * committed before the move started (this client's view is stale), and not
 * one it commits while the move runs (after the move's checks). The move is
 * refused, and the source and the destination keep exactly what they held.
 * Runs against SQLite always, and against PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a throwaway
 * database. Every test uses its own table and drops it when done.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { SessionManager, SessionMoveRefusedError } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { readStoredSession } from "../helpers/sql-session-storage";

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let tableSeq = 0;
const clients: SQL[] = [];
const cleanups: Array<() => Promise<void>> = [];
let tempDir: TempDir | undefined;
let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const client of clients.splice(0)) await client.end();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

function transcript(id: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" })}\n`;
}

async function seed(adapter: SqlSessionStorageAdapter, url: string) {
	tempDir = TempDir.createSync("@omp-sql-move-no-replace-");
	setAgentDir(tempDir.join("agent"));
	const table = `omp_mvnr_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	const databaseUrl = adapter === "sqlite" ? `sqlite:${tempDir.join("sessions.db")}` : url;
	/**
	 * A client of the shared database, as each omp process holds its own;
	 * `wrap` puts a test hook between the store and the driver.
	 */
	const connect = async (
		wrap?: (client: SQL) => SqlSessionStorageClient,
	): Promise<{ client: SQL; storage: SqlSessionStorage }> => {
		const client = new SQL(databaseUrl);
		clients.push(client);
		return {
			client,
			storage: await SqlSessionStorage.create({ client: wrap ? wrap(client) : client, table, adapter }),
		};
	};
	const { client, storage } = await connect();
	cleanups.push(async () => {
		await client.unsafe(`DROP TABLE IF EXISTS ${table}_parts`);
		await client.unsafe(`DROP TABLE IF EXISTS ${table}`);
	});
	const cwd = tempDir.join("from");
	const sessionDir = path.join(getSessionsDir(), "--from--");
	const to = tempDir.join("to");

	// The key moveTo computes for this session under `to`, read from what a
	// move of another session from the same directory produced.
	const probe = SessionManager.create(cwd, sessionDir, storage);
	await probe.moveTo(to);
	const destinationDir = path.dirname(probe.getSessionFile()!);
	await probe.close();

	const manager = SessionManager.create(cwd, sessionDir, storage);
	manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.flush();
	const source = manager.getSessionFile()!;
	const artifactsDir = source.slice(0, -".jsonl".length);
	await storage.writeText(path.join(artifactsDir, "A.jsonl"), transcript("a"));
	await storage.drain();
	const destination = path.join(destinationDir, path.basename(source));
	console.log(`[sql-move-no-replace] ${adapter}: moveTo(${to}) computes destination ${destination}`);
	/** What the database itself holds at `key`, read with plain SQL. */
	const stored = (key: string): Promise<string | null> => readStoredSession(client, table, key, adapter);
	return { storage, manager, source, artifactsDir, destination, to, connect, stored };
}

/**
 * Make `other` commit a session at `key` when `storage` is about to rename
 * `from`: after the move's checks (its refresh and header reads), before the
 * rename. Spies on whichever rename the move uses; the refusing one does not
 * exist before the fix.
 */
function commitBeforeRename(
	storage: SqlSessionStorage,
	from: string,
	other: SqlSessionStorage,
	key: string,
): { wrote: boolean } {
	const commit = { wrote: false };
	for (const method of ["rename", "renameNoReplace"] as const) {
		if (typeof storage[method] !== "function") continue;
		const original = storage[method].bind(storage);
		vi.spyOn(storage, method).mockImplementation(async (src: string, dst: string) => {
			if (!commit.wrote && src === from) {
				commit.wrote = true;
				await other.writeText(key, transcript("theirs"));
				await other.drain();
			}
			return original(src, dst);
		});
	}
	return commit;
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`moving a ${adapter}-stored session onto another client's session`, () => {
		test("refuses a destination another client committed before the move", async () => {
			const { manager, source, destination, to, connect, stored } = await seed(adapter, url!);
			const sourceBefore = await stored(source);
			expect(sourceBefore).toContain("question");
			const other = await connect();
			await other.storage.writeText(destination, transcript("theirs"));
			await other.storage.drain();

			const error = await manager.moveTo(to).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(error).toBeInstanceOf(SessionMoveRefusedError);
			expect((error as Error).message).toContain(destination);
			expect(manager.getSessionFile()).toBe(source);
			expect(await stored(source)).toBe(sourceBefore);
			expect(await stored(destination)).toBe(transcript("theirs"));
			await manager.close();
		});

		test("refuses a copy of this session at the destination, which another client may be writing", async () => {
			const { manager, source, destination, to, connect, stored } = await seed(adapter, url!);
			const sourceBefore = await stored(source);
			const other = await connect();
			// A copy of this session's journal: another process may have it open.
			const copy = `${sourceBefore!}${transcript("appended-by-the-other-client")}`;
			await other.storage.writeText(destination, copy);
			await other.storage.drain();

			const error = await manager.moveTo(to).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(error).toBeInstanceOf(SessionMoveRefusedError);
			expect((error as Error).message).toContain("copy of this session");
			expect(manager.getSessionFile()).toBe(source);
			expect(await stored(source)).toBe(sourceBefore);
			expect(await stored(destination)).toBe(copy);
			await manager.close();
		});

		test("refuses a subagent transcript key that was taken before the move", async () => {
			const { manager, source, artifactsDir, destination, to, connect, stored } = await seed(adapter, url!);
			const sourceBefore = await stored(source);
			const child = path.join(artifactsDir, "A.jsonl");
			const childDestination = path.join(destination.slice(0, -".jsonl".length), "A.jsonl");
			const other = await connect();
			await other.storage.writeText(childDestination, transcript("theirs"));
			await other.storage.drain();

			const error = await manager.moveTo(to).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(error).toBeInstanceOf(SessionMoveRefusedError);
			expect((error as Error).message).toContain(childDestination);
			expect(manager.getSessionFile()).toBe(source);
			expect(await stored(source)).toBe(sourceBefore);
			expect(await stored(child)).toBe(transcript("a"));
			expect(await stored(childDestination)).toBe(transcript("theirs"));
			expect(await stored(destination)).toBeNull();
			await manager.close();
		});

		test("deleting the session removes a child another client commits after the refresh", async () => {
			const { storage, manager, source, artifactsDir, connect, stored } = await seed(adapter, url!);
			await manager.close();
			const late = path.join(artifactsDir, "Late_%.jsonl");
			const other = await connect();
			// A sibling directory whose name only starts like the artifacts directory keeps its rows.
			const sibling = `${artifactsDir}-sibling.jsonl`;
			await other.storage.writeText(sibling, transcript("sibling"));
			await other.storage.drain();
			const refresh = storage.refresh.bind(storage);
			vi.spyOn(storage, "refresh").mockImplementation(async () => {
				await refresh();
				await other.storage.writeText(late, transcript("late"));
				await other.storage.drain();
			});

			await storage.deleteSessionWithArtifacts(source);
			await storage.drain();

			expect(await stored(source)).toBeNull();
			expect(await stored(path.join(artifactsDir, "A.jsonl"))).toBeNull();
			expect(await stored(late)).toBeNull();
			expect(await stored(sibling)).toBe(transcript("sibling"));
		});

		test("refuses a destination another client commits during the move", async () => {
			const { storage, manager, source, destination, to, connect, stored } = await seed(adapter, url!);
			const sourceBefore = await stored(source);
			const other = await connect();
			const commit = commitBeforeRename(storage, source, other.storage, destination);

			const error = await manager.moveTo(to).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(commit.wrote).toBe(true);
			expect(error).toBeInstanceOf(SessionMoveRefusedError);
			expect((error as Error).message).toContain(destination);
			expect(manager.getSessionFile()).toBe(source);
			expect(await stored(source)).toBe(sourceBefore);
			expect(await stored(destination)).toBe(transcript("theirs"));
			await manager.close();
		});

		test("refuses a subagent transcript key another client commits during the move", async () => {
			const { storage, manager, source, artifactsDir, destination, to, connect, stored } = await seed(adapter, url!);
			const sourceBefore = await stored(source);
			const child = path.join(artifactsDir, "A.jsonl");
			const childDestination = path.join(destination.slice(0, -".jsonl".length), "A.jsonl");
			const other = await connect();
			const commit = commitBeforeRename(storage, child, other.storage, childDestination);

			const error = await manager.moveTo(to).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect(commit.wrote).toBe(true);
			expect(error).toBeInstanceOf(SessionMoveRefusedError);
			expect((error as Error).message).toContain(childDestination);
			expect(manager.getSessionFile()).toBe(source);
			expect(await stored(source)).toBe(sourceBefore);
			expect(await stored(child)).toBe(transcript("a"));
			expect(await stored(childDestination)).toBe(transcript("theirs"));
			expect(await stored(destination)).toBeNull();
			await manager.close();
		});

		test("a failed move's rollback keeps a key another client wrote at the old path", async () => {
			const { storage, manager, source, artifactsDir, destination, to, connect, stored } = await seed(adapter, url!);
			const childA = path.join(artifactsDir, "A.jsonl");
			const childB = path.join(artifactsDir, "B.jsonl");
			const movedA = path.join(destination.slice(0, -".jsonl".length), "A.jsonl");
			await storage.writeText(childB, transcript("b"));
			await storage.drain();
			const other = await connect();
			// A moves; then another client writes A's old key, and B's move fails,
			// so the rollback would move A back over that key.
			const renameNoReplace = storage.renameNoReplace.bind(storage);
			vi.spyOn(storage, "renameNoReplace").mockImplementation(async (from: string, dest: string) => {
				if (from === childB) {
					await other.storage.writeText(childA, transcript("theirs"));
					await other.storage.drain();
					throw new Error("database rejected child B");
				}
				return renameNoReplace(from, dest);
			});

			const error = await manager.moveTo(to).then(
				() => undefined,
				(err: unknown) => err,
			);

			expect((error as Error).message).toContain("rollback");
			expect((error as Error).message).toContain(childA);
			expect(await stored(childA)).toBe(transcript("theirs"));
			expect(await stored(movedA)).toBe(transcript("a"));
			expect(await stored(childB)).toBe(transcript("b"));
			expect(await stored(source)).toContain("question");
			await manager.close();
		});
	});
}

// PostgreSQL runs each statement on its own READ COMMITTED snapshot, and a new
// row's key takes no lock the delete holds, so another client can commit a
// child between two statements of the delete. (MySQL's gap locks and SQLite's
// write lock make such a client wait for the delete instead.)
describe.skipIf(!process.env.OMP_TEST_SQL_POSTGRES_URL)("deleting a postgres-stored session", () => {
	test("never keeps a child's row while deleting its parts", async () => {
		const { manager, source, artifactsDir, connect, stored } = await seed(
			"postgres",
			process.env.OMP_TEST_SQL_POSTGRES_URL!,
		);
		await manager.close();
		const fresh = path.join(artifactsDir, "Fresh.jsonl");
		const creator = await connect();
		let created = false;
		// After each statement of the delete that matches the artifacts prefix,
		// another client creates and commits a child there once.
		const afterPrefixStatement = async (query: string): Promise<void> => {
			if (created || !query.includes("substr(path, 1,")) return;
			created = true;
			await creator.storage.writeText(fresh, transcript("fresh"));
			await creator.storage.drain();
		};
		const hooked = (transaction: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
			async unsafe(query, values) {
				const result = await transaction.unsafe(query, values);
				await afterPrefixStatement(query);
				return result;
			},
		});
		const deleter = await connect(client => ({
			options: client.options,
			unsafe: (query, values) => client.unsafe(query, values),
			transaction: work => client.transaction(transaction => work(hooked(transaction))),
		}));

		await deleter.storage.deleteSessionWithArtifacts(source);
		await deleter.storage.drain();

		expect(created).toBe(true);
		expect(await stored(source)).toBeNull();
		// Committed after the delete's statement, the child is whole; it is never a row with no bytes.
		expect(await stored(fresh)).toBe(transcript("fresh"));
	});
});
