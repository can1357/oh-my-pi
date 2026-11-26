/**
 * Integration: `SessionManager` driven by `SqlSessionStorage` (SQLite
 * backend) instead of the file-backed store. Verifies the SQL substrate is
 * genuinely pluggable — append → flush → reload via `open()` works against
 * a real `Bun.SQL` connection, and `SessionManager.list()` enumerates rows
 * out of the table.
 *
 * The second block holds the session's own full rewrite at the store while an
 * entry is recorded, on SQLite always and on PostgreSQL when
 * `OMP_TEST_SQL_POSTGRES_URL` names a database.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type SqlSessionStorageAdapter,
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SQL } from "bun";

// Storage keys are platform paths; `/sessions/...` is only drive-relative on Windows,
// so a resolved `open()` would address a different key than `create()` wrote.
const virtualDir = (dir: string): string => path.resolve(dir);

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

class HeldSqlClient implements SqlSessionStorageClient {
	readonly options: SqlSessionStorageClient["options"];
	holdNextReplace = false;
	holdQueryPrefix = "UPDATE omp_session_files SET content";
	/** Every statement sent, those of transactions included, in order. */
	readonly statements: string[] = [];
	readonly replaceStarted = Promise.withResolvers<void>();
	readonly allowReplace = Promise.withResolvers<void>();
	readonly #client: InstanceType<typeof SQL>;

	constructor(client: InstanceType<typeof SQL>) {
		this.#client = client;
		this.options = client.options;
	}

	unsafe(query: string, values?: unknown[]) {
		return this.#run(this.#client, query, values);
	}

	transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> {
		return this.#client.transaction(transaction =>
			callback({ unsafe: (query, values) => this.#run(transaction, query, values) }),
		);
	}

	#run(executor: SqlSessionStorageTransaction, query: string, values?: unknown[]) {
		this.statements.push(query);
		if (this.holdNextReplace && query.startsWith(this.holdQueryPrefix)) {
			this.holdNextReplace = false;
			this.replaceStarted.resolve();
			return this.allowReplace.promise.then(() => executor.unsafe(query, values));
		}
		return executor.unsafe(query, values);
	}
}

describe("SessionManager + SqlSessionStorage (SQLite)", () => {
	it("persists appended assistant messages into SQL and reloads via open()", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/proj");

		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "hi" }],
			usage: fakeUsage(10, 5),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const sessionFilePath = sessionFile as string;
		expect(sessionFilePath.startsWith(sessionDir)).toBe(true);

		// `appendMessage` queues the cold-path rewrite onto SessionManager's
		// internal persist chain via a fire-and-forget call. `flush()` awaits
		// that chain; `drain()` mops up the storage-level pending tail.
		await manager.flush();
		await storage.drain();
		await manager.close();

		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			sessionFilePath,
		])) as Array<{ content: string }>;
		expect(rows).toHaveLength(1);
		const lines = rows[0].content.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// The fixed-width title slot is always the first physical line; the session header follows.
		const slot = JSON.parse(lines[0]);
		expect(slot.type).toBe("title");
		const header = JSON.parse(lines[1]);
		expect(header.type).toBe("session");
		const msg = JSON.parse(lines[lines.length - 1]);
		expect(msg.type).toBe("message");
		expect(msg.message.role).toBe("assistant");
		expect(msg.message.content[0].text).toBe("hi");

		const reopened = await SessionManager.open(sessionFilePath, sessionDir, storage);
		const leaf = reopened.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf?.type).toBe("message");
		await reopened.close();
		await client.end();
	});

	it("SessionManager.list returns SQL-backed sessions for the cwd", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/list-proj");

		const a = SessionManager.create("/cwd", sessionDir, storage);
		a.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "alpha" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await a.flush();
		await storage.drain();
		await a.close();

		const b = SessionManager.create("/cwd", sessionDir, storage);
		b.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "beta" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await b.flush();
		await storage.drain();
		await b.close();

		const aFile = a.getSessionFile();
		const bFile = b.getSessionFile();
		expect(aFile).toBeDefined();
		expect(bFile).toBeDefined();

		const sessions = await SessionManager.list("/cwd", sessionDir, storage);
		const sessionFiles = sessions.map(s => s.path).sort();
		expect(sessionFiles).toContain(aFile as string);
		expect(sessionFiles).toContain(bFile as string);
		await client.end();
	});

	it("rejects a stale rewrite after another SQL storage appends", async () => {
		const client = new SQL("sqlite::memory:");
		const firstStorage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/shared");
		const first = SessionManager.create("/cwd", sessionDir, firstStorage);
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await SqlSessionStorage.create({ client });
		const second = await SessionManager.open(sessionFile, sessionDir, secondStorage);
		second.appendMessage({ role: "user", content: "durable SQL peer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await secondStorage.readText(sessionFile)).toContain("durable SQL peer turn");
		await client.end();
	});

	it("counts a new session as resumable only once SQL confirms its first write", async () => {
		// The index entry appears before the backend acknowledges the write; an exit-time
		// resume hint read in that window would advertise a session the exit then loses.
		const client = new SQL("sqlite::memory:");
		const heldClient = new HeldSqlClient(client);
		const storage = await SqlSessionStorage.create({ client: heldClient });
		const manager = SessionManager.create("/cwd", virtualDir("/sessions/unconfirmed"), storage);
		heldClient.holdQueryPrefix = "INSERT INTO omp_session_files";
		heldClient.holdNextReplace = true;

		const firstWrite = manager.ensureOnDisk();
		await heldClient.replaceStarted.promise;
		expect(manager.isSessionOnDisk()).toBe(true);
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);

		heldClient.allowReplace.resolve();
		await firstWrite;
		expect(manager.isSessionConfirmedOnDisk()).toBe(true);
		await manager.close();
		await client.end();
	});

	it("does not confirm a new file whose atomic write a synchronous rewrite superseded", async () => {
		// SessionManager's synchronous rewrite fails the pending atomic write's commit guard
		// and queues its own publish; until that publish lands the store holds nothing.
		const client = new SQL("sqlite::memory:");
		const heldClient = new HeldSqlClient(client);
		const storage = await SqlSessionStorage.create({ client: heldClient });
		const sessionFile = path.join(virtualDir("/sessions/superseded"), "s.jsonl");
		let atomicStillCurrent = true;

		const atomic = storage.writeTextAtomic(sessionFile, "atomic\n", { commitGuard: () => atomicStillCurrent });
		await Promise.resolve();
		// The atomic write's optimistic index entry is in place, its publish not yet started.
		expect(storage.existsSync(sessionFile)).toBe(true);
		atomicStillCurrent = false;
		heldClient.holdQueryPrefix = "INSERT INTO omp_session_files";
		heldClient.holdNextReplace = true;
		storage.writeTextSync(sessionFile, "sync\n");
		await atomic;
		await heldClient.replaceStarted.promise;
		expect(storage.existsConfirmedSync(sessionFile)).toBe(false);

		heldClient.allowReplace.resolve();
		await storage.drain();
		expect(storage.existsConfirmedSync(sessionFile)).toBe(true);
		expect(await storage.readText(sessionFile)).toBe("sync\n");
		await client.end();
	});
});

/** SQLite always; PostgreSQL when `OMP_TEST_SQL_POSTGRES_URL` names a database. Each case uses a table of its own. */
const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL || undefined },
];

const WAITING_ENTRY = "entry recorded during the rewrite";

interface HeldSession extends AsyncDisposable {
	readonly client: HeldSqlClient;
	readonly storage: SqlSessionStorage;
	readonly manager: SessionManager;
	readonly sessionFile: string;
	/** What `onPersistenceError` reported, in order. */
	readonly failures: string[];
	/** A full write of the table's rows, stated against a size or not; an append never runs it. */
	readonly fullWrite: RegExp;
	/** An append to a row. */
	readonly append: RegExp;
	/**
	 * Edit an entry in place and start `rewriteEntries()`, as closing a retried model call does when it records the
	 * outcome on the refused attempt (`#markPendingRetryErrors` in turn-recovery.ts). Its full write waits at the store,
	 * after the storage index already holds its size, until `client.allowReplace` resolves.
	 */
	startHeldRewrite(): Promise<void>;
	/** The session's row as the table holds it, read past the storage index. */
	stored(): Promise<string>;
}

/** A session of two stored turns whose SQL statements go through a {@link HeldSqlClient}. */
async function openHeldSession(adapter: SqlSessionStorageAdapter, url: string): Promise<HeldSession> {
	const raw = new SQL(url);
	const table = `omp_rewrite_${Bun.randomUUIDv7().replaceAll("-", "").slice(-12)}`;
	const client = new HeldSqlClient(raw);
	client.holdQueryPrefix = `UPDATE ${table} SET content`;
	const close = async (): Promise<void> => {
		client.allowReplace.resolve();
		if (adapter !== "sqlite") await raw.unsafe(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
		await raw.end();
	};
	try {
		const storage = await SqlSessionStorage.create({ client, adapter, table });
		const manager = SessionManager.create("/cwd", virtualDir(`/sessions/${table}`), storage);
		const failures: string[] = [];
		manager.onPersistenceError(error => failures.push(error.message));
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "seed reply" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await manager.flush();
		await storage.drain();
		const placeholder = adapter === "postgres" ? "$1" : "?";
		return {
			client,
			storage,
			manager,
			sessionFile,
			failures,
			fullWrite: new RegExp(`^(UPDATE ${table} SET content|INSERT INTO ${table} \\(path, content, mtime_ms, title)`),
			append: new RegExp(`^INSERT INTO ${table} \\(path, content, mtime_ms\\) VALUES`),
			startHeldRewrite() {
				const turn = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
				if (turn?.type !== "message" || turn.message.role !== "user") throw new Error("Expected user turn");
				turn.message.content = "annotated before rewrite";
				client.holdNextReplace = true;
				return manager.rewriteEntries();
			},
			async stored() {
				const rows = (await raw.unsafe(`SELECT content FROM ${table} WHERE path = ${placeholder}`, [
					sessionFile,
				])) as Array<{ content: string }>;
				return rows[0]?.content ?? "";
			},
			async [Symbol.asyncDispose]() {
				client.allowReplace.resolve();
				await manager.close().catch(() => undefined);
				await close();
			},
		};
	} catch (err) {
		await close();
		throw err;
	}
}

function copies(content: string, text: string): number {
	return content.split(text).length - 1;
}

/** Whether `content` holds exactly the journal's entries, in its order: every line but the title slot and header. */
function holdsTheJournal(content: string, manager: SessionManager): boolean {
	const ids = content
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as { type?: unknown; id?: unknown })
		.filter(record => record.type !== "title" && record.type !== "session")
		.map(record => record.id);
	return JSON.stringify(ids) === JSON.stringify(manager.getEntries().map(entry => entry.id));
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(
		`SessionManager + SqlSessionStorage: an entry recorded during its own rewrite (${adapter})`,
		() => {
			// Before the fix each case reported "Session file changed before rewrite": the entry replaced the held rewrite
			// with a synchronous full write stated against the size before it, which the storage index, already holding the
			// rewrite's size, refused.
			it("stores the entry with no conflict, and the entries after it", async () => {
				await using s = await openHeldSession(adapter, url ?? "");
				const rewrite = s.startHeldRewrite();
				await s.client.replaceStarted.promise;
				s.manager.appendMessage({ role: "user", content: WAITING_ENTRY, timestamp: Date.now() });
				s.client.allowReplace.resolve();
				await rewrite.catch(() => undefined);
				s.manager.appendMessage({ role: "user", content: "later turn", timestamp: Date.now() });
				await s.manager.flush().catch(() => undefined);

				const body = await s.stored();
				expect({
					failures: s.failures,
					copies: [WAITING_ENTRY, "later turn"].map(text => copies(body, text)),
					holdsTheJournal: holdsTheJournal(body, s.manager),
					expectsWhatIsStored: s.manager.captureState().expectedDiskSize === Buffer.byteLength(body, "utf8"),
				}).toEqual({ failures: [], copies: [1, 1], holdsTheJournal: true, expectsWhatIsStored: true });
			}, 120_000);

			it("appends the entry once after the landed rewrite, with no second full write", async () => {
				await using s = await openHeldSession(adapter, url ?? "");
				const rewrite = s.startHeldRewrite();
				await s.client.replaceStarted.promise;
				s.manager.appendMessage({ role: "user", content: WAITING_ENTRY, timestamp: Date.now() });
				const landedAt = s.client.statements.length;
				s.client.allowReplace.resolve();
				await rewrite.catch(() => undefined);
				await s.manager.flush().catch(() => undefined);

				const afterLanding = s.client.statements.slice(landedAt);
				const body = await s.stored();
				expect({
					failures: s.failures,
					copies: copies(body, WAITING_ENTRY),
					holdsTheJournal: holdsTheJournal(body, s.manager),
					fullWritesAfterLanding: afterLanding.filter(query => s.fullWrite.test(query)).length,
					appendsAfterLanding: afterLanding.filter(query => s.append.test(query)).length,
				}).toEqual({
					failures: [],
					copies: 1,
					holdsTheJournal: true,
					fullWritesAfterLanding: 0,
					appendsAfterLanding: 1,
				});
			}, 120_000);

			// Before the fix the entry also moved the disk epoch, so the landed rewrite was recorded only once a read of the
			// whole transcript matched it. That read can fail on a transcript of a few hundred megabytes; the session then
			// kept the size from before the rewrite, and every later full write stated it and was refused. Now the epoch does
			// not move and nothing reads the transcript back: a change that reads it again meets the failure injected here.
			it("records the landed rewrite without reading the transcript back, so a failing read cannot keep the old size", async () => {
				await using s = await openHeldSession(adapter, url ?? "");
				let landed = false;
				let readsAfterLanding = 0;
				const readText = s.storage.readText.bind(s.storage);
				s.storage.readText = async requested => {
					if (landed && requested === s.sessionFile) {
						readsAfterLanding++;
						throw new Error("canceling statement due to statement timeout");
					}
					return readText(requested);
				};
				const rewrite = s.startHeldRewrite();
				await s.client.replaceStarted.promise;
				s.manager.appendMessage({ role: "user", content: WAITING_ENTRY, timestamp: Date.now() });
				landed = true;
				s.client.allowReplace.resolve();
				await rewrite.catch(() => undefined);
				s.manager.appendMessage({ role: "user", content: "later turn", timestamp: Date.now() });
				await s.manager.rewriteEntries().catch(() => undefined);
				await s.manager.flush().catch(() => undefined);

				const body = await s.stored();
				expect({
					failures: s.failures,
					readsAfterLanding,
					copies: [WAITING_ENTRY, "later turn"].map(text => copies(body, text)),
					expectsWhatIsStored: s.manager.captureState().expectedDiskSize === Buffer.byteLength(body, "utf8"),
				}).toEqual({ failures: [], readsAfterLanding: 0, copies: [1, 1], expectsWhatIsStored: true });
			}, 120_000);

			// A process that exits while its rewrite publishes seals the session and closes it: the entry that waited on the
			// rewrite the seal superseded goes out with close()'s write of the whole transcript.
			it("stores the entry when the session is sealed and closed during the rewrite", async () => {
				await using s = await openHeldSession(adapter, url ?? "");
				const rewrite = s.startHeldRewrite();
				await s.client.replaceStarted.promise;
				s.manager.appendMessage({ role: "user", content: WAITING_ENTRY, timestamp: Date.now() });
				s.manager.seal();
				s.client.allowReplace.resolve();
				await rewrite.catch(() => undefined);
				const closed = await s.manager.close().then(
					() => "closed",
					(err: unknown) => String(err),
				);

				const body = await s.stored();
				expect({
					closed,
					failures: s.failures,
					copies: copies(body, WAITING_ENTRY),
					holdsTheJournal: holdsTheJournal(body, s.manager),
				}).toEqual({ closed: "closed", failures: [], copies: 1, holdsTheJournal: true });
			}, 120_000);

			// The append that carries the waiting entries can fail before it reaches the store, as preparing an entry does
			// for a blob it cannot write. The failure is reported, and the rewrite publishes the whole transcript again
			// instead of leaving the entries out of a file it marks current.
			it("saves the entry with the rewrite's next full write when its append fails", async () => {
				await using s = await openHeldSession(adapter, url ?? "");
				const failure = "the append of the waiting entries failed";
				let failNextAppend = false;
				const openWriter = s.storage.openWriter.bind(s.storage);
				s.storage.openWriter = (writerPath, options) => {
					const writer = openWriter(writerPath, options);
					const appendSync = writer.appendSync?.bind(writer);
					if (appendSync) {
						writer.appendSync = line => {
							if (!failNextAppend) return appendSync(line);
							failNextAppend = false;
							throw new Error(failure);
						};
					}
					return writer;
				};
				const rewrite = s.startHeldRewrite();
				await s.client.replaceStarted.promise;
				s.manager.appendMessage({ role: "user", content: WAITING_ENTRY, timestamp: Date.now() });
				failNextAppend = true;
				s.client.allowReplace.resolve();
				await rewrite.catch(() => undefined);

				const body = await s.stored();
				expect({
					failures: s.failures,
					copies: copies(body, WAITING_ENTRY),
					holdsTheJournal: holdsTheJournal(body, s.manager),
				}).toEqual({ failures: [failure], copies: 1, holdsTheJournal: true });
			}, 120_000);
		},
	);
}
