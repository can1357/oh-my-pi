/**
 * Durability boundary for indexed backends (`IndexedSessionStorage`), exercised
 * through `SessionManager`. These backends update a local index immediately and
 * queue the remote publish, so the manager's durable-size record must never
 * run ahead of what the backend has confirmed: an inflated record feeds the
 * next recovery rewrite an impossible `expectedSize` and the CAS rejects it,
 * losing the in-memory entries.
 *
 * The backend below drives the REAL `IndexedSessionStorage`/`SessionManager`
 * path; it is not a general-purpose mock.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SESSION_TAIL_APPEND_CHUNK_BYTES, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as piUtils from "@oh-my-pi/pi-utils";

class FakeBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly mtimes = new Map<string, number>();
	/** Number of append publishes the remote backend observed. */
	appendCalls = 0;
	/** Number of whole-journal publishes the remote backend observed. */
	fullWriteCalls = 0;
	/** Reject the next N append calls with a transient failure. */
	failAppends = 0;
	/** When set, let this many append calls land, then reject the next one. */
	rejectAppendAfter: number | undefined;
	/** UTF-8 bytes of every append publish that landed. */
	readonly appendBytes: number[] = [];
	/** Reject the next N whole-file publishes with a transient failure. */
	failWrites = 0;
	/** When set, the next whole-journal publish waits for it before landing; `writeHeld` resolves once one waits. */
	holdNextWrite: PromiseWithResolvers<void> | undefined;
	readonly writeHeld = Promise.withResolvers<void>();
	#mtime = 1;

	async init(): Promise<void> {}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return [...this.files].map(([path, content]) => ({
			path,
			size: Buffer.byteLength(content, "utf8"),
			mtimeMs: this.mtimes.get(path) ?? 0,
		}));
	}

	async readFull(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const bytes = Buffer.from(this.files.get(path) ?? "", "utf8");
		const prefix = bytes.subarray(0, prefixBytes).toString("utf8");
		const suffix = suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8") : "";
		return [prefix, suffix];
	}

	async append(path: string, line: string): Promise<void> {
		this.appendCalls += 1;
		if (this.failAppends > 0) {
			this.failAppends -= 1;
			throw new Error("transient backend append failure");
		}
		if (this.rejectAppendAfter !== undefined && this.rejectAppendAfter-- === 0) {
			this.rejectAppendAfter = undefined;
			throw new Error("transient backend append failure");
		}
		this.appendBytes.push(Buffer.byteLength(line, "utf8"));
		this.files.set(path, (this.files.get(path) ?? "") + line);
		this.mtimes.set(path, this.#mtime++);
	}

	async writeFull(
		path: string,
		content: string,
		mtimeMs: number,
		_title?: unknown,
		expectedSize?: number | null,
	): Promise<void> {
		this.fullWriteCalls += 1;
		if (this.failWrites > 0) {
			this.failWrites -= 1;
			throw new Error("transient backend write failure");
		}
		const hold = this.holdNextWrite;
		if (hold) {
			this.holdNextWrite = undefined;
			this.writeHeld.resolve();
			await hold.promise;
		}
		const current = this.files.get(path) ?? null;
		const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
		if (expectedSize !== undefined && actualSize !== expectedSize) {
			throw new SessionWriteConflictError(path, expectedSize, actualSize);
		}
		this.files.set(path, content);
		this.mtimes.set(path, mtimeMs);
	}

	async updateSessionTitle(path: string, _title: unknown, mtimeMs: number): Promise<void> {
		this.mtimes.set(path, mtimeMs);
	}

	async truncate(path: string, mtimeMs: number): Promise<void> {
		this.files.set(path, "");
		this.mtimes.set(path, mtimeMs);
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) {
			this.files.delete(path);
			this.mtimes.delete(path);
		}
	}

	async move(src: string, dst: string, mtimeMs: number): Promise<void> {
		const content = this.files.get(src);
		if (content === undefined) throw new Error(`ENOENT: ${src}`);
		this.files.delete(src);
		this.files.set(dst, content);
		this.mtimes.set(dst, mtimeMs);
	}
}

/** An indexed writer whose accepted append rejects only when a switch drains and closes it. */
class DrainRejectingIndexedStorage extends IndexedSessionStorage {
	#publication = Promise.withResolvers<void>();
	#failure = new Error("transient backend append failure");

	override openWriter(_path: string, _options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		let open = true;
		return {
			append: async (_line: string) => await this.#publication.promise,
			appendSync: (_line: string) => {},
			flush: () => this.#publication.promise,
			isOpen: () => open,
			close: async () => {
				open = false;
				this.#publication.reject(this.#failure);
				await this.#publication.promise;
			},
			getError: () => undefined,
		};
	}
}

/** A well-formed assistant message: the lazy gate materializes the file for it. */
function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		api: "anthropic-messages" as const,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

async function makeManager(): Promise<{
	backend: FakeBackend;
	storage: IndexedSessionStorage;
	manager: SessionManager;
}> {
	const backend = new FakeBackend();
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
	await manager.ensureOnDisk();
	await storage.drain();
	return { backend, storage, manager };
}

/** Ids of records in `content` whose `parentId` names a record the journal does not hold. */
function orphanedRecords(content: string): string[] {
	const records = parseSessionContent(content).entries.slice(1) as SessionEntry[];
	const ids = new Set(records.map(record => record.id));
	return records.filter(record => record.parentId !== null && !ids.has(record.parentId)).map(record => record.id);
}

describe("SessionManager + indexed backend durability", () => {
	it("does not advance the durable size before the backend confirms the append", async () => {
		const { backend, storage, manager } = await makeManager();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");
		const before = manager.captureState().expectedDiskSize;

		manager.appendMessage({ role: "user", content: "queued turn", timestamp: Date.now() });
		// The publish is still on the wire: the durable record must not lead it.
		expect(manager.captureState().expectedDiskSize).toBe(before);

		await manager.flush();
		await storage.drain();
		expect(manager.captureState().expectedDiskSize).toBe(
			Buffer.byteLength(backend.files.get(sessionFile) ?? "", "utf8"),
		);
		await manager.close();
	});

	it("refuses one switch when an indexed append rejects during its writer drain", async () => {
		const backend = new FakeBackend();
		const storage = new DrainRejectingIndexedStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		await manager.ensureOnDisk();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");
		manager.appendMessage({ role: "user", content: "pending turn", timestamp: Date.now() });

		await expect(manager.newSession()).rejects.toThrow("transient backend append failure");

		const nextSessionFile = await manager.newSession();
		expect(nextSessionFile).not.toBe(sessionFile);
	});

	it("continues appending after a rejected maintenance rewrite when earlier turns are durable", async () => {
		const { backend, storage, manager } = await makeManager();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		manager.appendMessage({ role: "user", content: "durable turn", timestamp: Date.now() });
		await manager.flush();
		await storage.drain();
		const durableEntry = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!durableEntry || durableEntry.type !== "message" || durableEntry.message.role !== "user") {
			throw new Error("expected durable user entry");
		}
		// Maintenance mutates a turn in place before it requests a full rewrite.
		durableEntry.message.content = "rewritten durable turn";

		backend.failWrites = 1;
		await expect(manager.rewriteEntries()).rejects.toThrow("transient backend write failure");
		await storage.drain().catch(() => {});
		const fullWritesBeforeRecovery = backend.fullWriteCalls;
		const appendsBeforeRecovery = backend.appendCalls;

		// Every append-only entry predates the failed rewrite. The next turn must
		// reach the backend as an append, rather than republishing the journal.
		manager.appendMessage({ role: "user", content: "recovered turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		expect(backend.fullWriteCalls).toBe(fullWritesBeforeRecovery);
		expect(backend.appendCalls).toBe(appendsBeforeRecovery + 1);
		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("durable turn");
		expect(body).toContain("recovered turn");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
	});

	it("keeps a hot append durable through a following atomic batch", async () => {
		const { backend, storage, manager } = await makeManager();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		manager.appendMessage({ role: "user", content: "hot turn", timestamp: Date.now() });
		await manager.appendEntriesAtomically(() => manager.appendCustomEntry("probe", { ok: true }));
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("hot turn");
		expect(body).toContain("probe");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
	});

	it("recovers a rejected indexed full rewrite instead of staying on an unpublished size", async () => {
		const backend = new FakeBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		// The first cold rewrite (a fresh manager materializes on the first
		// assistant message) is rejected by the backend, so its first turn has
		// not reached durable storage.
		backend.failWrites = 1;
		manager.appendMessage(assistantMessage("first turn"));
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		// The next entry must publish the whole in-memory journal because the
		// first turn never landed.
		manager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("first turn");
		expect(body).toContain("second turn");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
	});

	it("keeps a rewrite racing an unconfirmed publish on the confirmed size", async () => {
		const backend = new FakeBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		// The first cold rewrite is rejected by the backend while a second turn
		// races it synchronously (hV-oB): the queued publish is only a promise,
		// so the manager must record nothing and expose nothing as current
		// until the backend confirms.
		backend.failWrites = 1;
		manager.appendMessage(assistantMessage("first turn"));
		expect(manager.captureState().expectedDiskSize).toBeNull();
		expect(manager.captureState().onDisk).toBe(false);

		// The racing turn must not land as a bare append on the unconfirmed
		// body: its cold-path rewrite still carries the last confirmed token,
		// which the store's queue-time size check fail-fasts before a second
		// provisional publish can queue behind the unconfirmed one.
		manager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		// The rejected publish realigns to confirmed state, and the backend
		// holds no bare append from the race.
		expect(manager.captureState().expectedDiskSize).toBeNull();
		expect(backend.files.get(sessionFile)).toBeUndefined();

		// Recovery converges: the full transcript publishes once the backend
		// accepts, with the durable record describing exactly those bytes.
		manager.appendMessage({ role: "user", content: "third turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("first turn");
		expect(body).toContain("second turn");
		expect(body).toContain("third turn");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
	});
	it("rolls back a chained indexed append failure instead of stranding later rewrites", async () => {
		const backend = new FakeBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		manager.appendMessage(assistantMessage("base turn"));
		await manager.flush();
		await storage.drain();

		// Two hot appends queue before the first backend publish fails: the
		// second must not land on the backend without the first, and the
		// optimistic index must fall back to the last durable entry so the
		// next recovery rewrite carries a reachable CAS token (rJDg).
		backend.failAppends = 1;
		manager.appendMessage({ role: "user", content: "first queued turn", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "second queued turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		manager.appendMessage({ role: "user", content: "healer turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("base turn");
		expect(body).toContain("first queued turn");
		expect(body).toContain("second queued turn");
		expect(body).toContain("healer turn");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
	});

	it("does not mark a superseded deferred rewrite current on confirm", async () => {
		const backend = new FakeBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		// The first cold rewrite queues its publish; a second turn races it
		// synchronously and fail-fasts against the unconfirmed optimistic
		// index. When the first publish confirms, the manager must not
		// declare current a body that predates the racing turn: close must
		// still persist the whole transcript (rvEW).
		manager.appendMessage(assistantMessage("first turn"));
		manager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});
		await manager.close();

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("first turn");
		expect(body).toContain("second turn");
	});

	// The size-check conflict after pruning is covered against the real backend in
	// sql-session-storage-manager.test.ts.
	it("recovers IndexedSessionStorage after a rejected deferred publish", async () => {
		const { backend, storage, manager } = await makeManager();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		manager.appendMessage(assistantMessage("seed reply"));
		manager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
		await manager.flush();
		await storage.drain();

		const hold = Promise.withResolvers<void>();
		backend.holdNextWrite = hold;
		const rewritePublished = manager.rewriteEntries();
		await backend.writeHeld.promise;
		backend.failWrites = 1;
		manager.appendMessage({ role: "user", content: "fenced append", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "after fenced append", timestamp: Date.now() });
		hold.resolve();
		await rewritePublished.catch(() => {});
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		manager.appendMessage({ role: "user", content: "later turn 1", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "later turn 2", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = backend.files.get(sessionFile) ?? "";
		for (const turn of ["fenced append", "after fenced append", "later turn 1", "later turn 2"]) {
			expect(body).toContain(turn);
		}
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		await manager.close();
	});

	// A maintenance rewrite holds the fence while its publish is on the wire, so
	// an append made then is persisted only by a synchronous full rewrite. When
	// that rewrite fails, its successor (parented to it) must not reach the
	// backend as a bare append: a reload would find a record whose parent is gone.
	it.each([
		{ failure: "the backend rejects its deferred publish", rewritesContent: false, failWrites: 1 },
		{
			// Tool-output pruning changes a durable turn's length in place, so the held
			// publish moves the optimistic index past the last confirmed size.
			failure: "its size check meets the held rewrite's optimistic index",
			rewritesContent: true,
			failWrites: 0,
		},
	])(
		"never lands a successor of a fenced append whose rewrite failed when $failure",
		async ({ rewritesContent, failWrites }) => {
			const { backend, storage, manager } = await makeManager();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected a session file");
			const errors: Error[] = [];
			manager.onPersistenceError(error => errors.push(error));
			manager.appendMessage(assistantMessage("seed turn"));
			manager.appendMessage({ role: "user", content: "before rewrite", timestamp: Date.now() });
			await manager.flush();
			await storage.drain();
			if (rewritesContent) {
				const durable = manager
					.getEntries()
					.find(entry => entry.type === "message" && entry.message.role === "user");
				if (!durable || durable.type !== "message" || durable.message.role !== "user") {
					throw new Error("expected durable user entry");
				}
				durable.message.content = "pruned before rewrite";
			}

			const hold = Promise.withResolvers<void>();
			backend.holdNextWrite = hold;
			const rewritePublished = manager.rewriteEntries();
			await backend.writeHeld.promise;
			backend.failWrites = failWrites;
			manager.appendMessage({ role: "user", content: "fenced append", timestamp: Date.now() });
			manager.appendMessage({ role: "user", content: "after fenced append", timestamp: Date.now() });
			hold.resolve();
			await rewritePublished.catch(() => {});
			await manager.flush().catch(() => {});
			await storage.drain().catch(() => {});
			manager.appendMessage({ role: "user", content: "next turn", timestamp: Date.now() });
			await manager.flush().catch(() => {});
			await storage.drain().catch(() => {});
			await manager.close().catch(() => {});

			expect(orphanedRecords(backend.files.get(sessionFile) ?? "")).toEqual([]);
			expect(errors.length).toBeGreaterThan(0);
		},
	);

	it("refuses a fail-closed open whose row another process deleted during the cwd probe", async () => {
		const { backend, storage, manager } = await makeManager();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");
		manager.appendMessage(assistantMessage("parked turn"));
		await manager.flush();
		await storage.drain();
		await manager.close();

		// A reviver in another process loads its index while the row still exists.
		const reviverStorage = new IndexedSessionStorage(backend);
		await reviverStorage.initialize();
		// The row is deleted while open() awaits the recorded-cwd probe.
		const probe = spyOn(piUtils, "directoryIsEnterable").mockImplementationOnce(async () => {
			backend.files.delete(sessionFile);
			return true;
		});
		let failure: unknown;
		let probes = 0;
		try {
			await SessionManager.open(sessionFile, "/sessions/proj", reviverStorage, {
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
		} catch (error) {
			failure = error;
		} finally {
			probes = probe.mock.calls.length;
			probe.mockRestore();
		}
		expect(probes).toBe(1);
		expect(piUtils.isEnoent(failure), String(failure)).toBe(true);
		// Failing closed mints nothing at the deleted path.
		await reviverStorage.drain();
		expect(backend.files.has(sessionFile)).toBe(false);
	});
});

/** What a restart of `sessionFile` reads from `backend`, through a fresh index. */
async function reopenIndexed(backend: FakeBackend, sessionFile: string): Promise<SessionManager> {
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	return SessionManager.open(sessionFile, "/sessions/proj", storage, { suppressBreadcrumb: true });
}

const userTurnsOf = (entries: readonly SessionEntry[]) =>
	entries.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));

/** An indexed session whose backend holds an assistant turn and the user turn "before". */
async function seededIndexedSession() {
	const made = await makeManager();
	made.manager.appendMessage(assistantMessage("seed"));
	made.manager.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
	await made.manager.flush();
	await made.storage.drain();
	const sessionFile = made.manager.getSessionFile();
	if (!sessionFile) throw new Error("expected a session file");
	return { ...made, sessionFile };
}

async function settle(manager: SessionManager, storage: IndexedSessionStorage): Promise<void> {
	await manager.flush().catch(() => {});
	await storage.drain().catch(() => {});
}

describe("indexed session turns while every whole-journal publish fails", () => {
	it.each([
		{
			change: "an in-place entry edit followed by rewriteEntries()",
			apply: async (manager: SessionManager) => {
				const entry = manager.getEntries().find(e => e.type === "message" && e.message.role === "user");
				if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("expected a user entry");
				entry.message.content = "edited in place";
				await manager.rewriteEntries().catch(() => {});
			},
		},
		{
			change: "a header change",
			apply: async (manager: SessionManager) => {
				await manager.addWorkspaceDirectory("/extra-workspace-root").catch(() => {});
			},
		},
	])("saves the next turns after $change", async ({ apply }) => {
		const { backend, storage, manager, sessionFile } = await seededIndexedSession();
		backend.failWrites = Number.POSITIVE_INFINITY;
		await apply(manager);
		await storage.drain().catch(() => {});

		for (const turn of ["t1", "t2", "t3"])
			manager.appendMessage({ role: "user", content: turn, timestamp: Date.now() });
		await settle(manager, storage);

		const reopened = await reopenIndexed(backend, sessionFile);
		expect(userTurnsOf(reopened.getBranch()).slice(-3)).toEqual(["t1", "t2", "t3"]);
	});
});

describe("indexed entries that missed the backend while whole-journal publishes fail", () => {
	it("appends a turn whose append the backend rejected before the next turn", async () => {
		const { backend, storage, manager, sessionFile } = await seededIndexedSession();
		backend.failWrites = Number.POSITIVE_INFINITY;
		backend.failAppends = 1;
		manager.appendMessage({ role: "user", content: "missing", timestamp: Date.now() });
		await settle(manager, storage);
		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await settle(manager, storage);

		const reopened = await reopenIndexed(backend, sessionFile);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "missing", "after"]);
		expect(orphanedRecords(backend.files.get(sessionFile) ?? "")).toEqual([]);
	});

	it("records two turns appended before the first confirms exactly once each", async () => {
		const { backend, storage, manager, sessionFile } = await seededIndexedSession();
		manager.appendMessage({ role: "user", content: "t1", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "t2", timestamp: Date.now() });
		await settle(manager, storage);
		manager.appendMessage({ role: "user", content: "t3", timestamp: Date.now() });
		await settle(manager, storage);

		const reopened = await reopenIndexed(backend, sessionFile);
		expect(userTurnsOf(reopened.getEntries())).toEqual(["before", "t1", "t2", "t3"]);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "t1", "t2", "t3"]);
	});

	it("re-appends both of two unconfirmed turns once the first one's append is rejected", async () => {
		const { backend, storage, manager, sessionFile } = await seededIndexedSession();
		backend.failWrites = Number.POSITIVE_INFINITY;
		backend.failAppends = 1;
		manager.appendMessage({ role: "user", content: "t1", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "t2", timestamp: Date.now() });
		await settle(manager, storage);
		manager.appendMessage({ role: "user", content: "t3", timestamp: Date.now() });
		await settle(manager, storage);

		const reopened = await reopenIndexed(backend, sessionFile);
		expect(userTurnsOf(reopened.getEntries())).toEqual(["before", "t1", "t2", "t3"]);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "t1", "t2", "t3"]);
	});

	it("lets close() append a turn whose append the backend rejected, while whole-journal publishes fail", async () => {
		const { backend, manager, sessionFile } = await seededIndexedSession();
		backend.failWrites = Number.POSITIVE_INFINITY;
		backend.failAppends = 1;
		manager.appendMessage({ role: "user", content: "missing", timestamp: Date.now() });

		await expect(manager.close()).resolves.toBeUndefined();
		const reopened = await reopenIndexed(backend, sessionFile);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "missing"]);
	});

	it("keeps a title change on the branch after its append and fallback publish both failed", async () => {
		const { backend, storage, manager, sessionFile } = await seededIndexedSession();
		backend.failWrites = Number.POSITIVE_INFINITY;
		backend.failAppends = 1;
		await manager.setSessionName("new title", "user").catch(() => false);
		await settle(manager, storage);
		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await settle(manager, storage);

		const branch = (await reopenIndexed(backend, sessionFile)).getBranch();
		expect(userTurnsOf(branch)).toEqual(["before", "after"]);
		expect(branch.at(-2)).toMatchObject({ type: "title_change", title: "new title" });
	});
});

describe("an indexed session started while the previous session's publish is still on the wire", () => {
	it("keeps saving its turns after the previous session's publish confirms, while whole-journal publishes fail", async () => {
		const backend = new FakeBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const hold = Promise.withResolvers<void>();
		backend.holdNextWrite = hold;
		manager.appendMessage(assistantMessage("previous session"));
		await backend.writeHeld.promise;

		const next = await manager.newSession();
		if (!next) throw new Error("expected a new session file");
		manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		await storage.confirmWrites(next);
		// The previous session's publish confirms only now, after the new
		// session has its own durable frontier.
		hold.resolve();
		await storage.drain().catch(() => {});

		backend.failWrites = Number.POSITIVE_INFINITY;
		manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopenIndexed(backend, next)).getBranch())).toEqual(["first", "second"]);
	});
});

/**
 * Holds the next writer flush's confirmation until released, after the append
 * itself landed; `undelayedConfirmed` resolves once a flush confirms while
 * that one is held. `confirmations` holds every flush the manager awaited.
 */
class DelayedConfirmationStorage extends IndexedSessionStorage {
	delayNextConfirmation = false;
	readonly confirmationHeld = Promise.withResolvers<void>();
	readonly releaseConfirmation = Promise.withResolvers<void>();
	readonly undelayedConfirmed = Promise.withResolvers<void>();
	readonly confirmations: Promise<void>[] = [];
	#holding = false;

	override openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		const writer = super.openWriter(path, options);
		const flush = writer.flush.bind(writer);
		writer.flush = () => {
			const delayed = this.delayNextConfirmation;
			this.delayNextConfirmation = false;
			const confirmation = (async () => {
				await flush();
				if (!delayed) {
					if (this.#holding) queueMicrotask(() => this.undelayedConfirmed.resolve());
					return;
				}
				this.#holding = true;
				this.confirmationHeld.resolve();
				await this.releaseConfirmation.promise;
				this.#holding = false;
			})();
			this.confirmations.push(confirmation);
			return confirmation;
		};
		return writer;
	}
}

describe("indexed append confirmations that arrive out of order", () => {
	it("keep both confirmed turns when a later append fails and whole-journal publishes fail", async () => {
		const backend = new FakeBackend();
		const storage = new DelayedConfirmationStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		await manager.ensureOnDisk();
		manager.appendMessage(assistantMessage("seed"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		storage.delayNextConfirmation = true;
		manager.appendMessage({ role: "user", content: "confirmed late", timestamp: Date.now() });
		await storage.confirmationHeld.promise;
		manager.appendMessage({ role: "user", content: "confirmed early", timestamp: Date.now() });
		// The second append's confirmation settles before the first one's.
		await storage.undelayedConfirmed.promise;
		storage.releaseConfirmation.resolve();
		await manager.flush();

		backend.failWrites = Number.POSITIVE_INFINITY;
		backend.failAppends = 1;
		manager.appendMessage({ role: "user", content: "rejected", timestamp: Date.now() });
		await storage.drain().catch(() => {});
		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopenIndexed(backend, sessionFile)).getBranch())).toEqual([
			"confirmed late",
			"confirmed early",
			"rejected",
			"after",
		]);
	});

	it.each(["working", "failing"] as const)(
		"keep a turn that confirmed ahead of a held one when a later append is rejected (whole-journal publishes %s)",
		async rewrites => {
			const backend = new FakeBackend();
			const storage = new DelayedConfirmationStorage(backend);
			await storage.initialize();
			const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
			await manager.ensureOnDisk();
			manager.appendMessage(assistantMessage("seed"));
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("expected a session file");
			if (rewrites === "failing") backend.failWrites = Number.POSITIVE_INFINITY;

			storage.delayNextConfirmation = true;
			manager.appendMessage({ role: "user", content: "confirmed late", timestamp: Date.now() });
			await storage.confirmationHeld.promise;
			manager.appendMessage({ role: "user", content: "confirmed early", timestamp: Date.now() });
			await storage.undelayedConfirmed.promise;
			// The backend rejects the next append while the first confirmation is still held.
			const held = storage.confirmations.length - 2;
			backend.failAppends = 1;
			manager.appendMessage({ role: "user", content: "rejected", timestamp: Date.now() });
			await Promise.allSettled(storage.confirmations.slice(held + 1));
			storage.releaseConfirmation.resolve();
			await Promise.allSettled(storage.confirmations);

			manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
			await settle(manager, storage);
			manager.appendMessage({ role: "user", content: "after2", timestamp: Date.now() });
			await expect(manager.flush()).resolves.toBeUndefined();
			expect(userTurnsOf((await reopenIndexed(backend, sessionFile)).getBranch())).toEqual([
				"confirmed late",
				"confirmed early",
				"rejected",
				"after",
				"after2",
			]);
		},
	);
});

describe("an indexed durably discarded entry", () => {
	async function sessionWithDiscardableTurn() {
		const session = await seededIndexedSession();
		const discardedId = session.manager.appendMessage(assistantMessage("discarded turn"));
		session.manager.appendServiceTierChange({ openai: "priority" });
		await settle(session.manager, session.storage);
		return { ...session, discardedId };
	}

	async function expectDiscardSurvivesRestart(backend: FakeBackend, sessionFile: string, discardedId: string) {
		const branch = (await reopenIndexed(backend, sessionFile)).getBranch();
		expect(branch.some(entry => entry.id === discardedId)).toBe(false);
		expect(branch.flatMap(entry => (entry.type === "service_tier_change" ? [entry.serviceTier] : []))).toContainEqual(
			{
				openai: "priority",
			},
		);
		expect(userTurnsOf(branch)).toEqual(["before", "after", "after2"]);
	}

	it("stays discarded after its publish failed once and the backend healed", async () => {
		const { backend, storage, manager, sessionFile, discardedId } = await sessionWithDiscardableTurn();
		backend.failWrites = 1;
		await manager.discardEntryDurably(discardedId).catch(() => {});
		await settle(manager, storage);
		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "after2", timestamp: Date.now() });
		await settle(manager, storage);

		await expectDiscardSurvivesRestart(backend, sessionFile, discardedId);
	});

	it("stays discarded when queued behind a held publish and its own publish failed", async () => {
		const { backend, storage, manager, sessionFile, discardedId } = await sessionWithDiscardableTurn();
		const hold = Promise.withResolvers<void>();
		backend.holdNextWrite = hold;
		const unrelated = manager.rewriteEntries();
		await backend.writeHeld.promise;
		const discard = manager.discardEntryDurably(discardedId);
		backend.failWrites = 1;
		hold.resolve();
		await unrelated.catch(() => {});
		await discard.catch(() => {});
		await settle(manager, storage);
		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		manager.appendMessage({ role: "user", content: "after2", timestamp: Date.now() });
		await settle(manager, storage);

		await expectDiscardSurvivesRestart(backend, sessionFile, discardedId);
	});
});

describe("an indexed backlog of entries the backend rejected", () => {
	/** About half a MiB serialized: whole entries, several to a chunk. */
	const payload = "x".repeat(499_000);
	/** Enough entries for about three chunks. */
	const backlog = Math.ceil((3 * SESSION_TAIL_APPEND_CHUNK_BYTES) / payload.length);
	const wholeBacklog = Array.from({ length: backlog }, (_, i) => i);

	/** The backlog indexes the backend holds, in file order, duplicates included. */
	function backlogOnBackend(backend: FakeBackend, sessionFile: string): number[] {
		return parseSessionContent(backend.files.get(sessionFile) ?? "").entries.flatMap(entry => {
			if (entry.type !== "custom" || entry.customType !== "backlog") return [];
			const data = entry.data;
			return data && typeof data === "object" && "i" in data && typeof data.i === "number" ? [data.i] : [];
		});
	}

	it("is appended in confirmed chunks, and a rejected middle chunk is re-sent from the last confirmed one", async () => {
		const { backend, storage, manager, sessionFile } = await seededIndexedSession();
		backend.failWrites = Number.POSITIVE_INFINITY;
		backend.failAppends = 1;
		for (let i = 0; i < backlog; i++) manager.appendCustomEntry("backlog", { i, payload });
		backend.appendBytes.length = 0;
		// The heal's first chunk lands and its second is rejected.
		backend.rejectAppendAfter = 1;

		await expect(manager.flush()).rejects.toThrow("transient backend append failure");
		const kept = backlogOnBackend(backend, sessionFile);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept.length).toBeLessThan(backlog);
		expect(kept).toEqual(wholeBacklog.slice(0, kept.length));

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(backlogOnBackend(backend, sessionFile)).toEqual(wholeBacklog);
		expect(Math.max(...backend.appendBytes)).toBeLessThanOrEqual(
			SESSION_TAIL_APPEND_CHUNK_BYTES + payload.length + 1024,
		);

		// The frontier covers the whole journal, so the next turn is a plain
		// append although every whole-journal publish still fails.
		manager.appendMessage({ role: "user", content: "after", timestamp: Date.now() });
		await expect(manager.flush()).resolves.toBeUndefined();
		await storage.drain();
		const branch = (await reopenIndexed(backend, sessionFile)).getBranch();
		expect(userTurnsOf(branch)).toEqual(["before", "after"]);
		expect(branch.at(-2)).toMatchObject({ type: "custom", data: { i: backlog - 1 } });
	});
});
