/**
 * Turns keep reaching the journal while full rewrites fail (a full disk or a
 * read-only directory where O_APPEND still works), and an entry that missed
 * the journal is restored by appending it before its successors, never by a
 * republish that cannot succeed. Every test reopens the session, because a
 * restart sees only what the journal holds.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SESSION_TAIL_APPEND_CHUNK_BYTES, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	SESSION_HEADER_PREFIX_BYTES,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Fails full-journal publishes on demand, can park the next atomic one, the
 * next drain, or the next session-file unlink once it took effect, and can
 * park the next session delete and then fail it; appends are untouched.
 */
class ControlledRewriteStorage extends FileSessionStorage {
	/** Every full rewrite fails while set. */
	failRewrites = false;
	/** The next full rewrite fails. */
	failNextRewrite = false;
	/** Every in-place title-slot write fails while set. */
	failTitleSlots = false;
	/** The next `statSync` throws EACCES. */
	failNextStat = false;
	/** Full-journal publishes that reached storage, failed ones included. */
	fullRewrites = 0;
	#parked:
		| { started: PromiseWithResolvers<WriteTextAtomicOptions | undefined>; release: PromiseWithResolvers<void> }
		| undefined;
	#parkedDelete:
		| { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void>; fail: boolean }
		| undefined;
	#parkedUnlink: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
	#parkedDrain: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;

	/** Park the next session-file unlink once it has taken effect, until `release()`; `started` resolves then. */
	parkAfterNextUnlink(): { started: Promise<void>; release: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		this.#parkedUnlink = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	override async unlink(fpath: string): Promise<void> {
		await super.unlink(fpath);
		const parked = this.#parkedUnlink;
		if (!parked || !fpath.endsWith(".jsonl")) return;
		this.#parkedUnlink = undefined;
		parked.started.resolve();
		await parked.release.promise;
	}

	/** Park the next drain until `release()`; `started` resolves once it waits. */
	parkNextDrain(): { started: Promise<void>; release: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		this.#parkedDrain = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	override async drain(): Promise<void> {
		const parked = this.#parkedDrain;
		if (parked) {
			this.#parkedDrain = undefined;
			parked.started.resolve();
			await parked.release.promise;
		}
		await super.drain();
	}

	override statSync(fpath: string) {
		if (this.failNextStat) {
			this.failNextStat = false;
			throw Object.assign(new Error("EACCES: synthetic stat failure"), { code: "EACCES" });
		}
		return super.statSync(fpath);
	}

	override async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		if (this.failTitleSlots)
			throw Object.assign(new Error("EACCES: synthetic title slot failure"), { code: "EACCES" });
		await super.updateSessionTitle(fpath, update);
	}

	/**
	 * Park the next atomic publish, before it stages its body, until `release()`;
	 * `started` resolves with the publish's options once it waits.
	 */
	parkNextAtomicRewrite(): { started: Promise<WriteTextAtomicOptions | undefined>; release: () => void } {
		const parked = {
			started: Promise.withResolvers<WriteTextAtomicOptions | undefined>(),
			release: Promise.withResolvers<void>(),
		};
		this.#parked = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	/** Park the next session delete until `fail()`, which makes it throw EACCES; `started` resolves once it waits. */
	parkNextDeleteToFail(): { started: Promise<void>; fail: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), fail: true };
		this.#parkedDelete = parked;
		return { started: parked.started.promise, fail: () => parked.release.resolve() };
	}

	/** Park the next session delete until `release()`, which runs the real delete; `started` resolves once it waits. */
	parkNextDelete(): { started: Promise<void>; release: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), fail: false };
		this.#parkedDelete = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	override async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		const parked = this.#parkedDelete;
		if (!parked) return super.deleteSessionWithArtifacts(sessionPath);
		this.#parkedDelete = undefined;
		parked.started.resolve();
		await parked.release.promise;
		if (!parked.fail) return super.deleteSessionWithArtifacts(sessionPath);
		throw Object.assign(new Error("EACCES: synthetic unlink failure"), { code: "EACCES" });
	}

	#rewriteFailure(): Error | undefined {
		if (this.failNextRewrite) {
			this.failNextRewrite = false;
			return new Error("EROFS: synthetic full rewrite failure");
		}
		return this.failRewrites ? new Error("EROFS: synthetic full rewrite failure") : undefined;
	}

	override writeLinesSync(fpath: string, lines: Iterable<string>, options?: SessionStorageWriteOptions): void {
		this.fullRewrites++;
		const failure = this.#rewriteFailure();
		if (failure) throw failure;
		super.writeLinesSync(fpath, lines, options);
	}

	override async writeLinesAtomic(
		fpath: string,
		lines: Iterable<string>,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		const parked = this.#parked;
		if (parked) {
			this.#parked = undefined;
			parked.started.resolve(options);
			await parked.release.promise;
		}
		this.fullRewrites++;
		const failure = this.#rewriteFailure();
		if (failure) throw failure;
		await super.writeLinesAtomic(fpath, lines, options);
	}
}

/**
 * Records the bytes of every append. While `failOpens` is set no writer opens;
 * while `failAppends` is set every append throws; the `failAppendAt.count`-th
 * append from now throws `failAppendAt.error`.
 */
class AppendRecordingStorage extends ControlledRewriteStorage {
	readonly appendBytes: number[] = [];
	failOpens = false;
	failAppends = false;
	failAppendAt: { count: number; error: Error } | undefined;

	override openWriter(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		if (this.failOpens) throw Object.assign(new Error("EMFILE: synthetic open failure"), { code: "EMFILE" });
		const writer = super.openWriter(fpath, options);
		const appendSync = (line: string): void => {
			if (this.failAppends) throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
			const injected = this.failAppendAt;
			if (injected && --injected.count === 0) {
				this.failAppendAt = undefined;
				throw injected.error;
			}
			this.appendBytes.push(Buffer.byteLength(line, "utf8"));
			writer.appendSync?.(line);
		};
		const wrapped: SessionStorageWriter = {
			append: async line => appendSync(line),
			appendSync,
			flush: () => writer.flush(),
			flushSync: () => writer.flushSync?.(),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
		return wrapped;
	}
}

/** Counts the bytes every synchronous read-back returns. */
class ReadCountingStorage extends ControlledRewriteStorage {
	bytesRead = 0;
	readonly rangeReadBytes: number[] = [];

	override readTextSync(fpath: string): string {
		const text = super.readTextSync(fpath);
		this.bytesRead += Buffer.byteLength(text, "utf8");
		return text;
	}

	override readTextRangeSync(fpath: string, start: number, end: number): string {
		const text = super.readTextRangeSync(fpath, start, end);
		const bytes = Buffer.byteLength(text, "utf8");
		this.bytesRead += bytes;
		this.rangeReadBytes.push(bytes);
		return text;
	}
}

/** Forces conflict recovery to inspect the complete journal and fail its first retry. */
class FullConflictStorage extends ControlledRewriteStorage {
	#writeAttempts = 0;

	override readTextRangeSync(_fpath: string, _start: number, _end: number): string {
		throw new Error("Synthetic tail read failure");
	}

	override writeLinesSync(fpath: string, lines: Iterable<string>, options?: SessionStorageWriteOptions): void {
		if (++this.#writeAttempts === 2) throw new Error("EROFS: synthetic recovery rewrite failure");
		super.writeLinesSync(fpath, lines, options);
	}
}

/**
 * An in-memory backend for {@link IndexedSessionStorage} that counts every
 * write to a path and can hold the next `remove()` until released, then
 * remove the paths, fail, or remove only the first path and then fail. The
 * next `readFull()` can fail, as a connection that failed the remove can
 * still be failing for the readback after it, and the next `append()` can
 * fail, as a backend that rejects one turn and then recovers.
 */
class HeldRemoveBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly writes = new Map<string, number>();
	#heldRemove:
		| {
				started: PromiseWithResolvers<void>;
				release: PromiseWithResolvers<void>;
				fail: "none" | "before-remove" | "after-first-path";
		  }
		| undefined;

	/**
	 * Hold the next remove until `release()`; `started` resolves once it waits. `fail` picks the outcome:
	 * `"none"` removes every path, `"before-remove"` throws EIO with every path intact, and
	 * `"after-first-path"` removes the session row and then throws EIO, as Redis's DEL-then-HDEL or SQL's
	 * per-path DELETE loop can fail partway.
	 */
	holdNextRemove(fail: "none" | "before-remove" | "after-first-path" = "none"): {
		started: Promise<void>;
		release: () => void;
	} {
		const held = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), fail };
		this.#heldRemove = held;
		return { started: held.started.promise, release: () => held.release.resolve() };
	}

	#wrote(path: string): void {
		this.writes.set(path, (this.writes.get(path) ?? 0) + 1);
	}

	/** The next `readFull()` throws ECONNRESET. */
	failNextRead = false;

	/** The next `append()` throws ECONNRESET without storing the line. */
	failNextAppend = false;

	async init(): Promise<void> {}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return [...this.files].map(([path, content]) => ({ path, size: Buffer.byteLength(content, "utf8"), mtimeMs: 0 }));
	}

	async readFull(path: string): Promise<string | null> {
		if (this.failNextRead) {
			this.failNextRead = false;
			throw Object.assign(new Error("ECONNRESET: synthetic read failure"), { code: "ECONNRESET" });
		}
		return this.files.get(path) ?? null;
	}

	async readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const bytes = Buffer.from(this.files.get(path) ?? "", "utf8");
		const suffix = suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8") : "";
		return [bytes.subarray(0, prefixBytes).toString("utf8"), suffix];
	}

	async append(path: string, line: string): Promise<void> {
		if (this.failNextAppend) {
			this.failNextAppend = false;
			throw Object.assign(new Error("ECONNRESET: synthetic append failure"), { code: "ECONNRESET" });
		}
		this.#wrote(path);
		this.files.set(path, (this.files.get(path) ?? "") + line);
	}

	async writeFull(
		path: string,
		content: string,
		_mtimeMs: number,
		_title?: unknown,
		expectedSize?: number | null,
	): Promise<void> {
		this.#wrote(path);
		const current = this.files.get(path);
		const actualSize = current === undefined ? null : Buffer.byteLength(current, "utf8");
		if (expectedSize !== undefined && actualSize !== expectedSize) {
			throw new SessionWriteConflictError(path, expectedSize, actualSize);
		}
		this.files.set(path, content);
		this.fullWrites++;
	}

	/** Full-content publishes that landed. */
	fullWrites = 0;

	async updateSessionTitle(path: string): Promise<void> {
		this.#wrote(path);
	}

	async truncate(path: string): Promise<void> {
		this.#wrote(path);
		this.files.set(path, "");
	}

	async remove(paths: string[]): Promise<void> {
		const held = this.#heldRemove;
		if (held) {
			this.#heldRemove = undefined;
			held.started.resolve();
			await held.release.promise;
			if (held.fail === "after-first-path") this.files.delete(paths[0]);
			if (held.fail !== "none") throw Object.assign(new Error("EIO: synthetic remove failure"), { code: "EIO" });
		}
		for (const path of paths) this.files.delete(path);
	}

	async move(src: string, dst: string): Promise<void> {
		const content = this.files.get(src);
		if (content === undefined) throw Object.assign(new Error(`ENOENT: ${src}`), { code: "ENOENT" });
		this.files.delete(src);
		this.files.set(dst, content);
	}
}

/** Indexed storage whose next drain can park until `release()`. */
class ParkingIndexedStorage extends IndexedSessionStorage {
	#parkedDrain: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;

	/** Park the next drain until `release()`; `started` resolves once it waits. */
	parkNextDrain(): { started: Promise<void>; release: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		this.#parkedDrain = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	override async drain(): Promise<void> {
		const parked = this.#parkedDrain;
		if (parked) {
			this.#parkedDrain = undefined;
			parked.started.resolve();
			await parked.release.promise;
		}
		await super.drain();
	}
}

/**
 * Memory storage whose session delete unlinks the journal; the next delete
 * can park until `release()`, after the unlink, or before it when it then
 * fails with the journal intact. Counts synchronous full writes.
 */
class ParkingMemoryStorage extends MemorySessionStorage {
	fullWrites = 0;
	#parked:
		| {
				started: PromiseWithResolvers<void>;
				release: PromiseWithResolvers<void>;
				fail: "none" | "before-unlink" | "after-unlink";
		  }
		| undefined;

	/**
	 * Park the next session delete until `release()`; `started` resolves once it waits. `fail` picks the
	 * outcome: `"none"` unlinks and succeeds, `"after-unlink"` unlinks and then fails its cleanup, and
	 * `"before-unlink"` fails with the journal intact.
	 */
	parkNextDelete(fail: "none" | "before-unlink" | "after-unlink"): { started: Promise<void>; release: () => void } {
		const parked = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), fail };
		this.#parked = parked;
		return { started: parked.started.promise, release: () => parked.release.resolve() };
	}

	override writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.fullWrites++;
		super.writeTextSync(path, content, options);
	}

	override async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		const parked = this.#parked;
		this.#parked = undefined;
		if (parked?.fail === "before-unlink") {
			parked.started.resolve();
			await parked.release.promise;
			throw Object.assign(new Error("EACCES: synthetic unlink failure"), { code: "EACCES" });
		}
		await this.unlink(sessionPath);
		if (!parked) return;
		parked.started.resolve();
		await parked.release.promise;
		if (parked.fail === "after-unlink") {
			throw new Error("Session file deleted but failed to remove artifacts directory: synthetic failure");
		}
	}
}

const tempDirs: TempDir[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

const userTurn = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const userTurnsOf = (entries: readonly SessionEntry[]) =>
	entries.flatMap(entry => (entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []));

/** A file-backed session whose journal holds an assistant turn and the user turn "before". */
async function fileSession(): Promise<{
	storage: ControlledRewriteStorage;
	manager: SessionManager;
	sessionDir: string;
	sessionFile: string;
}> {
	const root = TempDir.createSync("@pi-durable-frontier-");
	tempDirs.push(root);
	const sessionDir = path.join(root.path(), "sessions");
	const storage = new ControlledRewriteStorage();
	const manager = SessionManager.create(root.path(), sessionDir, storage);
	managers.push(manager);
	manager.appendMessage(assistantMessage("seed"));
	manager.appendMessage(userTurn("before"));
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	return { storage, manager, sessionDir, sessionFile };
}

async function reopen(sessionFile: string, sessionDir: string): Promise<SessionManager> {
	const reopened = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
	managers.push(reopened);
	return reopened;
}

/** An indexed session whose backend row holds an assistant turn and the user turn "before". */
async function indexedSession(): Promise<{
	backend: HeldRemoveBackend;
	storage: ParkingIndexedStorage;
	manager: SessionManager;
	sessionFile: string;
}> {
	const backend = new HeldRemoveBackend();
	const storage = new ParkingIndexedStorage(backend);
	await storage.initialize();
	const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
	managers.push(manager);
	manager.appendMessage(assistantMessage("seed"));
	manager.appendMessage(userTurn("before"));
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	expect(backend.files.has(sessionFile)).toBe(true);
	return { backend, storage, manager, sessionFile };
}

/** Reopen `sessionFile` through a fresh index over `backend`, so it reads only what the backend holds. */
async function reopenFromBackend(backend: HeldRemoveBackend, sessionFile: string): Promise<SessionManager> {
	const fresh = new IndexedSessionStorage(backend);
	await fresh.initialize();
	const reopened = await SessionManager.open(sessionFile, "/sessions/proj", fresh, { suppressBreadcrumb: true });
	managers.push(reopened);
	return reopened;
}

/** Make the next raw file write fail, as a full disk fails an append. */
function failNextFileWrite(): void {
	spyOn(fs, "writeSync").mockImplementationOnce(() => {
		throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
	});
}

function firstUserEntry(manager: SessionManager): SessionEntry & { type: "message" } {
	const entry = manager
		.getEntries()
		.find(candidate => candidate.type === "message" && candidate.message.role === "user");
	if (!entry || entry.type !== "message") throw new Error("Expected a user entry");
	return entry;
}

describe("session turns while every full rewrite fails", () => {
	it.each([
		{
			change: "an in-place entry edit followed by rewriteEntries()",
			apply: async (manager: SessionManager) => {
				const entry = firstUserEntry(manager);
				if (entry.message.role !== "user") throw new Error("Expected a user message");
				entry.message.content = "edited in place";
				await manager.rewriteEntries().catch(() => undefined);
			},
		},
		{
			change: "a header change",
			apply: async (manager: SessionManager) => {
				await manager.addWorkspaceDirectory("/extra-workspace-root").catch(() => undefined);
			},
		},
	])("saves the next turns after $change, reports the failure, and lets flush() resolve", async ({ apply }) => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		await apply(manager);

		for (const turn of ["t1", "t2", "t3"]) manager.appendMessage(userTurn(turn));

		// Every turn reached the journal, so nothing waits on the failed rewrite.
		await expect(manager.flush()).resolves.toBeUndefined();
		expect(manager.getPersistenceFailure()).toBeDefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch()).slice(-3)).toEqual(["t1", "t2", "t3"]);
	});
});

describe("session turns after an authoritative repair failed while every full rewrite fails", () => {
	it.each([
		{
			repair: "recoverPersistenceFromCurrentState()",
			run: (manager: SessionManager) => manager.recoverPersistenceFromCurrentState(),
		},
		{
			repair: "a failed appendEntriesAtomically() batch",
			run: (manager: SessionManager) =>
				manager.appendEntriesAtomically(() => manager.appendCustomEntry("vibe-lifecycle")),
		},
	])("are saved after $repair over an unpublished in-place edit", async ({ run }) => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "pruned in place";
		await manager.rewriteEntries().catch(() => undefined);
		await expect(run(manager)).rejects.toThrow("indeterminate");

		for (const turn of ["t1", "t2", "t3"]) manager.appendMessage(userTurn(turn));

		await expect(manager.flush()).resolves.toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "t1", "t2", "t3"]);
	});
});

describe("an entry that missed the journal after an authoritative repair failed, once appends work again", () => {
	it.each([
		{ step: "flush()", run: (manager: SessionManager) => manager.flush() },
		{ step: "close()", run: (manager: SessionManager) => manager.close() },
	])("is appended by $step", async ({ run }) => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "pruned in place";
		await manager.rewriteEntries().catch(() => undefined);
		await expect(manager.recoverPersistenceFromCurrentState()).rejects.toThrow("indeterminate");
		manager.appendMessage(userTurn("t1"));
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));

		await run(manager).catch(() => undefined);
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "t1", "missing"]);
	});
});

describe("an entry that missed the journal while full rewrites fail", () => {
	it("is appended before the next turn after a hot append failed once", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		manager.appendMessage(userTurn("after"));

		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "missing", "after"]);
	});

	it("is appended before the next turn after a fenced append's synchronous rewrite failed", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextAtomicRewrite();
		const rewrite = manager.rewriteEntries();
		await parked.started;
		storage.failRewrites = true;
		// The parked maintenance rewrite holds the fence, so this append is
		// persisted only by a synchronous full rewrite, which fails.
		manager.appendMessage(userTurn("fenced"));
		parked.release();
		await rewrite.catch(() => undefined);
		manager.appendMessage(userTurn("after"));

		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "fenced", "after"]);
	});

	it("keeps a title change on the branch after its append and fallback rewrite both failed", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		failNextFileWrite();
		await manager.setSessionName("new title", "user").catch(() => false);
		manager.appendMessage(userTurn("after"));

		const reopened = await reopen(sessionFile, sessionDir);
		const branch = reopened.getBranch();
		expect(userTurnsOf(branch)).toEqual(["before", "after"]);
		const after = branch.findIndex(
			entry => entry.type === "message" && entry.message.role === "user" && entry.message.content === "after",
		);
		expect(branch[after - 1]).toMatchObject({ type: "title_change", title: "new title" });
	});
});

describe("an entry that missed the journal once storage recovers", () => {
	it("is appended by flush(), which then resolves", async () => {
		const { manager, sessionDir, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "missing"]);
	});

	it("is appended by close(), which then resolves", async () => {
		const { manager, sessionDir, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));

		await expect(manager.close()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "missing"]);
	});

	it("is appended by newSession() before it switches", async () => {
		const { manager, sessionDir, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));

		const next = await manager.newSession();
		expect(next).not.toBe(sessionFile);
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "missing"]);
	});

	it("blocks newSession() once while storage still refuses it, and a retry switches", async () => {
		const { manager, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
		});
		try {
			await expect(manager.newSession()).rejects.toThrow("ENOSPC");
			expect(manager.getSessionFile()).toBe(sessionFile);
		} finally {
			mock.restore();
		}
		expect(await manager.newSession()).not.toBe(sessionFile);
	});
});

describe("a session file the heal cannot account for", () => {
	it("is not recreated by flush() after it vanished; the next turn republishes the whole transcript", async () => {
		const { manager, sessionDir, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		fs.rmSync(sessionFile);

		await expect(manager.flush()).rejects.toThrow("ENOSPC");
		expect(fs.existsSync(sessionFile)).toBe(false);

		manager.appendMessage(userTurn("after"));
		await manager.flush();
		const current = manager.getSessionFile();
		if (!current) throw new Error("Expected a session file");
		expect(userTurnsOf((await reopen(current, sessionDir)).getBranch())).toEqual(["before", "missing", "after"]);
	});
});

describe("a dropped session file", () => {
	it("stays deleted when newSession() follows dropSession() after a turn missed the journal (/delete)", async () => {
		const { manager, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));

		await manager.dropSession(sessionFile);
		const next = await manager.newSession();

		expect(next).not.toBe(sessionFile);
		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	it("is never written again by later turns, flushSync() or close()", async () => {
		const { manager, sessionFile } = await fileSession();

		await manager.dropSession(sessionFile);
		manager.appendMessage(assistantMessage("after the drop"));
		manager.flushSync();
		await manager.close();

		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	it.each([
		{
			write: "a turn",
			run: async (manager: SessionManager) => {
				manager.appendMessage(userTurn("in the window"));
			},
		},
		{
			write: "an auto title",
			run: async (manager: SessionManager) => {
				await manager.setSessionName("auto title", "auto");
			},
		},
		{
			write: "an in-place edit and rewriteEntries()",
			run: async (manager: SessionManager) => {
				const entry = firstUserEntry(manager);
				if (entry.message.role !== "user") throw new Error("Expected a user message");
				entry.message.content = "edited in the window";
				await manager.rewriteEntries();
			},
		},
		{
			write: "flushSync()",
			run: async (manager: SessionManager) => {
				manager.appendMessage(userTurn("in the window"));
				manager.flushSync();
			},
		},
	])(
		"stays deleted and unlisted when $write lands after the unlink, before dropSession() resolves (C2)",
		async ({ run }) => {
			const { storage, manager, sessionDir, sessionFile } = await fileSession();
			const parked = storage.parkAfterNextUnlink();
			const drop = manager.dropSession(sessionFile);
			await parked.started;

			await run(manager);
			parked.release();
			await drop;
			await manager.close();

			expect(fs.existsSync(sessionFile)).toBe(false);
			const listed = await SessionManager.list(path.dirname(sessionDir), sessionDir);
			expect(listed.map(session => session.path)).not.toContain(sessionFile);
		},
	);

	it("stays deleted when an authoritative repair already in flight would publish after the unlink (C2)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const drain = storage.parkNextDrain();
		const recovery = manager.recoverPersistenceFromCurrentState().catch(() => undefined);
		await drain.started;
		const unlinked = storage.parkAfterNextUnlink();
		const drop = manager.dropSession(sessionFile);
		drain.release();
		await recovery;
		unlinked.release();
		await expect(drop).resolves.toBeUndefined();
		await manager.close().catch(() => undefined);

		expect(fs.existsSync(sessionFile)).toBe(false);
		const listed = await SessionManager.list(path.dirname(sessionDir), sessionDir);
		expect(listed.map(session => session.path)).not.toContain(sessionFile);
	});

	it("does not let an authoritative repair already in flight publish an edit before the delete (C2)", async () => {
		const { storage, manager, sessionFile } = await fileSession();
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited before the repair";
		const drain = storage.parkNextDrain();
		const recovery = manager.recoverPersistenceFromCurrentState().catch(() => undefined);
		await drain.started;
		const bytesAtDrop = fs.readFileSync(sessionFile);
		const deleting = storage.parkNextDelete();
		const drop = manager.dropSession(sessionFile);
		// dropSession() waits for the repair before it deletes, so the repair runs on only once the drop has started.
		drain.release();
		await recovery;
		await deleting.started;
		const bytesAtDelete = fs.readFileSync(sessionFile);
		deleting.release();
		await expect(drop).resolves.toBeUndefined();
		await manager.close().catch(() => undefined);

		expect(bytesAtDelete.equals(bytesAtDrop)).toBe(true);
		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	it.each([
		{ outcome: "succeeds", failDelete: false },
		{ outcome: "fails with the journal intact", failDelete: true },
	])(
		"lets an authoritative repair it fenced off resolve without a persistence error when the delete $outcome (C2)",
		async ({ failDelete }) => {
			const { storage, manager, sessionFile } = await fileSession();
			const errors: Error[] = [];
			manager.onPersistenceError(error => errors.push(error));
			const drain = storage.parkNextDrain();
			const recovery = manager.recoverPersistenceFromCurrentState();
			await drain.started;
			if (failDelete) storage.parkNextDeleteToFail().fail();
			const drop = manager.dropSession(sessionFile).then(
				() => "resolved",
				(error: Error) => error.message,
			);
			drain.release();
			await expect(recovery).resolves.toBeUndefined();
			expect(await drop).toBe(failDelete ? "EACCES: synthetic unlink failure" : "resolved");

			expect(errors).toEqual([]);
			expect(manager.getPersistenceFailure()).toBeUndefined();
		},
	);

	it("saves a later turn and the edit on indexed storage after it fenced off an authoritative repair carrying that edit and the remove failed with the row intact (C1, C8)", async () => {
		const { backend, storage, manager, sessionFile } = await indexedSession();
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited before the repair";
		const drain = storage.parkNextDrain();
		const recovery = manager.recoverPersistenceFromCurrentState();
		await drain.started;
		const held = backend.holdNextRemove("before-remove");
		const drop = manager.dropSession(sessionFile);
		drain.release();
		await held.started;
		held.release();
		await expect(recovery).resolves.toBeUndefined();
		await expect(drop).rejects.toThrow("EIO");

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		await storage.drain();
		const fresh = new IndexedSessionStorage(backend);
		await fresh.initialize();
		const reopened = await SessionManager.open(sessionFile, "/sessions/proj", fresh, { suppressBreadcrumb: true });
		managers.push(reopened);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["edited before the repair", "after the failed delete"]);
	});

	it("saves a later turn by append after it fenced off an authoritative repair carrying an edit and the delete failed with the journal intact, while every full rewrite fails (C1, C5)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited before the repair";
		const drain = storage.parkNextDrain();
		const recovery = manager.recoverPersistenceFromCurrentState();
		await drain.started;
		const deleting = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		drain.release();
		await deleting.started;
		storage.failRewrites = true;
		deleting.fail();
		await expect(recovery).resolves.toBeUndefined();
		await expect(drop).rejects.toThrow("EACCES");

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		// The edit needs the full rewrite that cannot land; the turn is appended after the journal's own bytes.
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "after the failed delete"]);
	});

	it("lets an appendEntriesAtomically() batch already publishing commit when the delete then fails with the journal intact (C1)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const atomic = storage.parkNextAtomicRewrite();
		const batch = manager.appendEntriesAtomically(() => manager.appendCustomEntry("batched", { n: 1 }));
		await atomic.started;
		storage.parkNextDeleteToFail().fail();
		const drop = manager.dropSession(sessionFile);
		atomic.release();
		const batchId = await batch;
		await expect(drop).rejects.toThrow("EACCES");

		expect(manager.getEntries().map(entry => entry.id)).toContain(batchId);
		const reopened = await reopen(sessionFile, sessionDir);
		expect(reopened.getEntries().map(entry => entry.id)).toContain(batchId);
	});

	it("stays deleted when an atomic rewrite already in flight would publish after the unlink (C2)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const atomic = storage.parkNextAtomicRewrite();
		const rewrite = manager.rewriteEntries().catch(() => undefined);
		await atomic.started;
		const unlinked = storage.parkAfterNextUnlink();
		const drop = manager.dropSession(sessionFile);
		atomic.release();
		await rewrite;
		unlinked.release();
		await expect(drop).resolves.toBeUndefined();
		await manager.close().catch(() => undefined);

		expect(fs.existsSync(sessionFile)).toBe(false);
		const listed = await SessionManager.list(path.dirname(sessionDir), sessionDir);
		expect(listed.map(session => session.path)).not.toContain(sessionFile);
	});

	/** Journal unlinked, artifact cleanup failed, `run` in the window, then /delete's newSession(). */
	async function dropWithFailedArtifactCleanup(run: (manager: SessionManager) => Promise<void>): Promise<void> {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		await manager.saveArtifact("payload", "bash");
		const parked = storage.parkAfterNextUnlink();
		const rm = spyOn(fsp, "rm").mockRejectedValueOnce(new Error("EBUSY: synthetic rm failure"));
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		await run(manager);
		parked.release();
		try {
			await expect(drop).rejects.toThrow("failed to remove artifacts directory");
		} finally {
			rm.mockRestore();
		}
		// /delete switches next: the deleted file gets nothing.
		const next = await manager.newSession();
		manager.appendMessage(assistantMessage("in the new session"));
		await manager.flush();

		expect(next).not.toBe(sessionFile);
		expect(manager.getSessionFile()).not.toBe(sessionFile);
		expect(fs.existsSync(sessionFile)).toBe(false);
		const listed = await SessionManager.list(path.dirname(sessionDir), sessionDir);
		expect(listed.map(session => session.path)).not.toContain(sessionFile);
	}

	it.each([
		{ write: "nothing", run: async (_manager: SessionManager) => {} },
		{
			write: "a turn",
			run: async (manager: SessionManager) => {
				manager.appendMessage(userTurn("in the window"));
			},
		},
		{
			write: "an auto title",
			run: async (manager: SessionManager) => {
				await manager.setSessionName("auto title", "auto");
			},
		},
		{
			write: "an in-place edit and rewriteEntries()",
			run: async (manager: SessionManager) => {
				const entry = firstUserEntry(manager);
				if (entry.message.role !== "user") throw new Error("Expected a user message");
				entry.message.content = "edited in the window";
				await manager.rewriteEntries();
			},
		},
	])(
		"counts as gone when the journal unlink succeeded but the artifact cleanup failed, with $write in the window (C4)",
		async ({ run }) => dropWithFailedArtifactCleanup(run),
	);

	it("ends persistence after an artifact cleanup failure: later turns, flushSync() and close() write nothing (C4)", async () => {
		const { storage, manager, sessionFile } = await fileSession();
		await manager.saveArtifact("payload", "bash");
		const rewritesBefore = storage.fullRewrites;
		const rm = spyOn(fsp, "rm").mockRejectedValueOnce(new Error("EBUSY: synthetic rm failure"));
		try {
			await expect(manager.dropSession(sessionFile)).rejects.toThrow("failed to remove artifacts directory");
		} finally {
			rm.mockRestore();
		}
		manager.appendMessage(userTurn("after the drop"));
		await manager.setSessionName("after the drop", "auto");
		manager.flushSync();
		await manager.close();

		expect(manager.getSessionFile()).toBeUndefined();
		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(storage.fullRewrites).toBe(rewritesBefore);
	});

	it("counts as present when the gone check's stat fails with an error other than ENOENT (C4)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		storage.failNextStat = true;
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");
		storage.failNextStat = false;

		expect(manager.getSessionFile()).toBe(sessionFile);
		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual([
			"before",
			"after the failed delete",
		]);
	});

	it("keeps saving turns, titles and edits after a delete that failed with the journal intact (C1)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.parkNextDeleteToFail().fail();
		await expect(manager.dropSession(sessionFile)).rejects.toThrow("EACCES");

		manager.appendMessage(userTurn("after the failed delete"));
		await manager.setSessionName("named after the failed delete", "user");
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited after the failed delete";
		await manager.rewriteEntries();
		await expect(manager.flush()).resolves.toBeUndefined();

		expect(manager.getPersistenceFailure()).toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(reopened.getSessionName()).toBe("named after the failed delete");
		expect(userTurnsOf(reopened.getBranch())).toEqual(["edited after the failed delete", "after the failed delete"]);
	});

	it("republishes an edit whose rewrite the drop fenced off once the delete fails with the journal intact (C2)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const drain = storage.parkNextDrain();
		const recovery = manager.recoverPersistenceFromCurrentState().catch(() => undefined);
		await drain.started;
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited before the delete";
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		drain.release();
		await recovery;
		await parked.started;
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["edited before the delete"]);
	});

	it.each([
		{
			write: "a turn",
			run: async (manager: SessionManager) => {
				manager.appendMessage(userTurn("in the window"));
			},
		},
		{
			write: "a title",
			run: async (manager: SessionManager) => {
				await manager.setSessionName("named in the window", "auto");
			},
		},
	])(
		"gets nothing from /delete's newSession() after a delete that failed with $write in the window (C3)",
		async ({ run }) => {
			const { storage, manager, sessionFile } = await fileSession();
			const parked = storage.parkNextDeleteToFail();
			const drop = manager.dropSession(sessionFile);
			await parked.started;
			await run(manager);
			parked.fail();
			await expect(drop).rejects.toThrow("EACCES");
			const bytesAfterDrop = fs.readFileSync(sessionFile);

			const next = await manager.newSession();
			manager.appendMessage(assistantMessage("in the new session"));
			await manager.flush();

			expect(next).not.toBe(sessionFile);
			expect(fs.readFileSync(sessionFile).equals(bytesAfterDrop)).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps a title set while a delete ran that a read-only directory refused, without a full rewrite (C5, C6)",
		async () => {
			const { storage, manager, sessionDir, sessionFile } = await fileSession();
			const errors: Error[] = [];
			manager.onPersistenceError(error => errors.push(error));
			fs.chmodSync(sessionDir, 0o555);
			try {
				const parked = storage.parkNextDelete();
				const drop = manager.dropSession(sessionFile);
				await parked.started;
				await manager.setSessionName("named in the window", "auto");
				parked.release();
				await expect(drop).rejects.toThrow("EACCES");
				expect(manager.getPersistenceFailure()).toBeUndefined();
				manager.appendMessage(userTurn("after the failed delete"));
				await expect(manager.flush()).resolves.toBeUndefined();
			} finally {
				fs.chmodSync(sessionDir, 0o755);
			}

			expect(errors).toEqual([]);
			expect(manager.getPersistenceFailure()).toBeUndefined();
			const reopened = await reopen(sessionFile, sessionDir);
			expect(reopened.getSessionName()).toBe("named in the window");
			expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "after the failed delete"]);
		},
	);

	it("publishes a title held by a delete that then failed through the title slot, not a full rewrite (C6)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		await manager.setSessionName("named in the window", "auto");
		const rewritesBefore = storage.fullRewrites;
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");

		expect(storage.fullRewrites).toBe(rewritesBefore);
		expect((await reopen(sessionFile, sessionDir)).getSessionName()).toBe("named in the window");
	});

	it("publishes a held title with a full rewrite when the title slot write fails (C6)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		await manager.setSessionName("named in the window", "auto");
		storage.failTitleSlots = true;
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");
		storage.failTitleSlots = false;

		expect((await reopen(sessionFile, sessionDir)).getSessionName()).toBe("named in the window");
	});

	it("has flush() append a turn that missed the journal before a delete that failed with the journal intact (C7)", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		storage.parkNextDeleteToFail().fail();
		await expect(manager.dropSession(sessionFile)).rejects.toThrow("EACCES");

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "missing"]);
	});

	it("has flush() report a turn that missed the journal when a failed delete is followed by failing appends (C7)", async () => {
		const { storage, manager, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		storage.parkNextDeleteToFail().fail();
		await expect(manager.dropSession(sessionFile)).rejects.toThrow("EACCES");
		spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
		});
		try {
			await expect(manager.flush()).rejects.toThrow("ENOSPC");
		} finally {
			mock.restore();
		}
	});

	it("stays deleted on an indexed backend when a turn is appended while its remove is held", async () => {
		const backend = new HeldRemoveBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		managers.push(manager);
		manager.appendMessage(assistantMessage("seed"));
		manager.appendMessage(userTurn("before"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		expect(backend.files.has(sessionFile)).toBe(true);
		const held = backend.holdNextRemove();
		const drop = manager.dropSession(sessionFile);
		await held.started;
		const writesBefore = backend.writes.get(sessionFile) ?? 0;

		manager.appendMessage(userTurn("in the window"));
		held.release();
		await drop;
		await manager.flush();
		await storage.drain();

		expect(backend.writes.get(sessionFile) ?? 0).toBe(writesBefore);
		expect(backend.files.has(sessionFile)).toBe(false);
		expect(storage.existsSync(sessionFile)).toBe(false);
	});

	// Root ignores directory modes and Windows has none, so the unlink could not fail there.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps saving later turns while the directory still refuses the delete (ACP /session delete)",
		async () => {
			const { manager, sessionDir, sessionFile } = await fileSession();
			// A read-only directory refuses the unlink (EACCES) and a full rewrite's
			// temp file; appends to the existing file still work.
			fs.chmodSync(sessionDir, 0o555);
			try {
				await expect(manager.dropSession(sessionFile)).rejects.toThrow();
				manager.appendMessage(userTurn("after the failed delete"));
				await expect(manager.flush()).resolves.toBeUndefined();
			} finally {
				fs.chmodSync(sessionDir, 0o755);
			}
			expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual([
				"before",
				"after the failed delete",
			]);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"has flush() append a turn that missed the journal before the delete failed",
		async () => {
			const { manager, sessionDir, sessionFile } = await fileSession();
			failNextFileWrite();
			manager.appendMessage(userTurn("missing"));
			fs.chmodSync(sessionDir, 0o555);
			try {
				await expect(manager.dropSession(sessionFile)).rejects.toThrow();
				await expect(manager.flush()).resolves.toBeUndefined();
			} finally {
				fs.chmodSync(sessionDir, 0o755);
			}
			expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "missing"]);
		},
	);

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"is left as it was when newSession() follows a failed delete after a turn missed the journal (/delete)",
		async () => {
			const { manager, sessionDir, sessionFile } = await fileSession();
			failNextFileWrite();
			manager.appendMessage(userTurn("missing"));
			const bytesBefore = fs.readFileSync(sessionFile);
			fs.chmodSync(sessionDir, 0o555);
			try {
				await expect(manager.dropSession(sessionFile)).rejects.toThrow();
			} finally {
				fs.chmodSync(sessionDir, 0o755);
			}

			const next = await manager.newSession();

			expect(next).not.toBe(sessionFile);
			expect(fs.readFileSync(sessionFile).equals(bytesBefore)).toBe(true);
		},
	);

	// Without search permission the unlink and any stat of the file both fail with EACCES.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"keeps saving later turns after a directory without search permission refused the delete",
		async () => {
			const { manager, sessionDir, sessionFile } = await fileSession();
			fs.chmodSync(sessionDir, 0o444);
			try {
				await expect(manager.dropSession(sessionFile)).rejects.toThrow("EACCES");
			} finally {
				fs.chmodSync(sessionDir, 0o755);
			}

			manager.appendMessage(userTurn("after the failed delete"));
			await expect(manager.flush()).resolves.toBeUndefined();
			expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual([
				"before",
				"after the failed delete",
			]);
		},
	);

	it("keeps a title set while a delete that then failed was running", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		await manager.setSessionName("named during the delete", "user");
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(reopened.getSessionName()).toBe("named during the delete");
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "after the failed delete"]);
	});

	it("publishes an in-place edit rewritten while a delete that then failed was running", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited during the delete";
		await manager.rewriteEntries();
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");

		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["edited during the delete"]);
	});

	it("keeps a turn, a title and an in-place edit made while a delete that then failed was running", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		const parked = storage.parkNextDeleteToFail();
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		manager.appendMessage(userTurn("during the delete"));
		await manager.setSessionName("named during the delete", "auto");
		const entry = firstUserEntry(manager);
		if (entry.message.role !== "user") throw new Error("Expected a user message");
		entry.message.content = "edited during the delete";
		await manager.rewriteEntries();
		parked.fail();
		await expect(drop).rejects.toThrow("EACCES");

		await expect(manager.flush()).resolves.toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(reopened.getSessionName()).toBe("named during the delete");
		expect(userTurnsOf(reopened.getBranch())).toEqual(["edited during the delete", "during the delete"]);
	});
});

describe("a dropped session file on memory and indexed storage (C8)", () => {
	async function memorySession() {
		const storage = new ParkingMemoryStorage();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		managers.push(manager);
		manager.appendMessage(assistantMessage("seed"));
		manager.appendMessage(userTurn("before"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return { storage, manager, sessionFile };
	}

	const windowWrites = [
		{
			write: "a turn",
			run: async (manager: SessionManager) => {
				manager.appendMessage(userTurn("in the window"));
			},
		},
		{
			write: "an auto title",
			run: async (manager: SessionManager) => {
				await manager.setSessionName("auto title", "auto");
			},
		},
		{
			write: "an in-place edit and rewriteEntries()",
			run: async (manager: SessionManager) => {
				const entry = firstUserEntry(manager);
				if (entry.message.role !== "user") throw new Error("Expected a user message");
				entry.message.content = "edited in the window";
				await manager.rewriteEntries();
			},
		},
	];

	it.each(windowWrites)("stays deleted on memory storage when $write lands after the unlink (C2)", async ({ run }) => {
		const { storage, manager, sessionFile } = await memorySession();
		const parked = storage.parkNextDelete("none");
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		await run(manager);
		parked.release();
		await drop;
		manager.flushSync();
		await manager.close();

		expect(storage.existsSync(sessionFile)).toBe(false);
	});

	it.each(windowWrites)(
		"counts as gone on memory storage when its cleanup failed after the unlink, with $write in the window (C4)",
		async ({ run }) => {
			const { storage, manager, sessionFile } = await memorySession();
			const parked = storage.parkNextDelete("after-unlink");
			const drop = manager.dropSession(sessionFile);
			await parked.started;
			await run(manager);
			parked.release();
			await expect(drop).rejects.toThrow("failed to remove artifacts directory");
			const next = await manager.newSession();
			manager.appendMessage(assistantMessage("in the new session"));
			await manager.flush();

			expect(next).not.toBe(sessionFile);
			expect(storage.existsSync(sessionFile)).toBe(false);
		},
	);

	it("keeps saving on memory storage after a delete failed with the journal intact, publishing a held title through the slot (C1, C6, C7)", async () => {
		const { storage, manager, sessionFile } = await memorySession();
		const parked = storage.parkNextDelete("before-unlink");
		const drop = manager.dropSession(sessionFile);
		await parked.started;
		manager.appendMessage(userTurn("in the window"));
		await manager.setSessionName("named in the window", "auto");
		const fullWritesBefore = storage.fullWrites;
		parked.release();
		await expect(drop).rejects.toThrow("EACCES");
		expect(storage.fullWrites).toBe(fullWritesBefore);

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		const reopened = await SessionManager.open(sessionFile, "/sessions/proj", storage, { suppressBreadcrumb: true });
		managers.push(reopened);
		expect(reopened.getSessionName()).toBe("named in the window");
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "in the window", "after the failed delete"]);
	});

	it.each(windowWrites)(
		"stays deleted on indexed storage when $write lands while its remove is held (C2)",
		async ({ run }) => {
			const { backend, storage, manager, sessionFile } = await indexedSession();
			const held = backend.holdNextRemove();
			const drop = manager.dropSession(sessionFile);
			await held.started;
			const writesBefore = backend.writes.get(sessionFile) ?? 0;
			await run(manager);
			held.release();
			await drop;
			await manager.flush();
			await manager.close();
			await storage.drain();

			expect(backend.writes.get(sessionFile) ?? 0).toBe(writesBefore);
			expect(backend.files.has(sessionFile)).toBe(false);
			expect(storage.existsSync(sessionFile)).toBe(false);
		},
	);

	it.each(windowWrites)(
		"keeps the session on indexed storage, unconfirmed, and reports the next write as a conflict instead of recreating it, when its remove deleted the session row and then failed with $write in the window (C4)",
		async ({ run }) => {
			const { backend, storage, manager, sessionFile } = await indexedSession();
			const errors: Error[] = [];
			manager.onPersistenceError(error => errors.push(error));
			const held = backend.holdNextRemove("after-first-path");
			const drop = manager.dropSession(sessionFile);
			await held.started;
			await run(manager);
			held.release();
			await expect(drop).rejects.toThrow("EIO");
			// The failed remove restores the index entry, marked unconfirmed: the session
			// survives the failure instead of reading as deleted.
			expect(manager.getSessionFile()).toBe(sessionFile);
			expect(storage.existsSync(sessionFile)).toBe(true);
			expect(manager.isSessionConfirmedOnDisk()).toBe(false);

			// The next write is a size-checked full publish. The row it would replace is
			// gone, so it reports the conflict instead of recreating the file over an
			// unknown state.
			manager.appendMessage(userTurn("after the failed delete"));
			await expect(manager.flush()).rejects.toBeInstanceOf(SessionWriteConflictError);
			await storage.drain().catch(() => undefined);

			expect(errors.map(error => error.constructor)).toContain(SessionWriteConflictError);
			expect(manager.isSessionConfirmedOnDisk()).toBe(false);
			expect(backend.files.has(sessionFile)).toBe(false);
		},
	);

	it("keeps saving on indexed storage after its remove failed, publishing the turn and title held meanwhile in one full publish (C1, C4, C6)", async () => {
		const { backend, storage, manager, sessionFile } = await indexedSession();
		const held = backend.holdNextRemove("before-remove");
		const drop = manager.dropSession(sessionFile);
		await held.started;
		manager.appendMessage(userTurn("in the window"));
		await manager.setSessionName("named in the window", "auto");
		const fullWritesBefore = backend.fullWrites;
		held.release();
		await expect(drop).rejects.toThrow("EIO");
		await storage.drain();
		expect(backend.fullWrites).toBe(fullWritesBefore + 1);
		expect(manager.getSessionFile()).toBe(sessionFile);

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		await storage.drain();
		const reopened = await SessionManager.open(sessionFile, "/sessions/proj", storage, { suppressBreadcrumb: true });
		managers.push(reopened);
		expect(reopened.getSessionName()).toBe("named in the window");
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "in the window", "after the failed delete"]);
	});

	it.each([
		{ step: "flush()", run: (manager: SessionManager) => manager.flush() },
		{ step: "close()", run: (manager: SessionManager) => manager.close() },
		{
			step: "a switch to another session (flush(), then setSessionFile())",
			run: async (manager: SessionManager, storage: IndexedSessionStorage) => {
				const other = SessionManager.create("/cwd", "/sessions/proj", storage);
				managers.push(other);
				other.appendMessage(assistantMessage("other seed"));
				await other.flush();
				const otherFile = other.getSessionFile();
				if (!otherFile) throw new Error("Expected a persisted session file");
				await other.close();
				await manager.flush();
				await manager.setSessionFile(otherFile);
				expect(manager.getSessionFile()).toBe(otherFile);
			},
		},
	])(
		"has $step alone save a turn recorded while its indexed remove was held, after the remove failed with the row intact (C1, C8)",
		async ({ run }) => {
			const { backend, storage, manager, sessionFile } = await indexedSession();
			const held = backend.holdNextRemove("before-remove");
			const drop = manager.dropSession(sessionFile);
			await held.started;
			manager.appendMessage(userTurn("in the window"));
			held.release();
			await expect(drop).rejects.toThrow("EIO");

			await expect(run(manager, storage)).resolves.toBeUndefined();
			await storage.drain();
			const reopened = await reopenFromBackend(backend, sessionFile);
			expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "in the window"]);
		},
	);

	it("has close() alone save a title set while its indexed remove was held, after the remove failed with the row intact (C6, C8)", async () => {
		const { backend, storage, manager, sessionFile } = await indexedSession();
		const held = backend.holdNextRemove("before-remove");
		const drop = manager.dropSession(sessionFile);
		await held.started;
		await manager.setSessionName("named in the window", "auto");
		held.release();
		await expect(drop).rejects.toThrow("EIO");

		await expect(manager.close()).resolves.toBeUndefined();
		await storage.drain();
		const reopened = await reopenFromBackend(backend, sessionFile);
		expect(reopened.getSessionName()).toBe("named in the window");
	});

	it("has flush() save a turn the indexed backend rejected before the drop, once the backend recovers and the remove failed with the row intact (C7, C8)", async () => {
		const { backend, storage, manager, sessionFile } = await indexedSession();
		backend.failNextAppend = true;
		manager.appendMessage(userTurn("missed"));
		await storage.drain().catch(() => undefined);
		expect(manager.getPersistenceFailure()?.message).toContain("ECONNRESET");
		const held = backend.holdNextRemove("before-remove");
		const drop = manager.dropSession(sessionFile);
		await held.started;
		held.release();
		await expect(drop).rejects.toThrow("EIO");

		await expect(manager.flush()).resolves.toBeUndefined();
		await storage.drain();
		const reopened = await reopenFromBackend(backend, sessionFile);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "missed"]);
	});

	it("keeps saving on indexed storage after its remove failed with the session row intact and nothing written meanwhile (C1, C4)", async () => {
		const { backend, storage, manager, sessionFile } = await indexedSession();
		const held = backend.holdNextRemove("before-remove");
		const drop = manager.dropSession(sessionFile);
		await held.started;
		held.release();
		await expect(drop).rejects.toThrow("EIO");
		expect(manager.getSessionFile()).toBe(sessionFile);

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).resolves.toBeUndefined();
		await storage.drain();
		const reopened = await SessionManager.open(sessionFile, "/sessions/proj", storage, { suppressBreadcrumb: true });
		managers.push(reopened);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "after the failed delete"]);
	});

	it("keeps the session unconfirmed and reports the next turn as a conflict instead of writing a headerless row, when its remove deleted the session row and failed with nothing written meanwhile (C2)", async () => {
		const { backend, storage, manager, sessionFile } = await indexedSession();
		const errors: Error[] = [];
		manager.onPersistenceError(error => errors.push(error));
		const held = backend.holdNextRemove("after-first-path");
		const drop = manager.dropSession(sessionFile);
		await held.started;
		held.release();
		await expect(drop).rejects.toThrow("EIO");
		// The failed remove restores the entry marked unconfirmed: still listed, not reported as stored.
		expect(manager.getSessionFile()).toBe(sessionFile);
		expect(storage.existsSync(sessionFile)).toBe(true);
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);

		manager.appendMessage(userTurn("after the failed delete"));
		await expect(manager.flush()).rejects.toBeInstanceOf(SessionWriteConflictError);
		await storage.drain().catch(() => undefined);

		expect(errors.map(error => error.constructor)).toContain(SessionWriteConflictError);
		expect(manager.isSessionConfirmedOnDisk()).toBe(false);
		expect(backend.files.has(sessionFile)).toBe(false);
	});
});

describe("a restored snapshot taken while an entry missed the journal", () => {
	it("has flush() append the entry", async () => {
		const { manager, sessionDir, sessionFile } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		manager.restoreState(manager.captureState());

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual(["before", "missing"]);
	});

	it("has flush() reject while storage still refuses the entry", async () => {
		const { manager } = await fileSession();
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		manager.restoreState(manager.captureState());
		spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" });
		});

		try {
			await expect(manager.flush()).rejects.toThrow("ENOSPC");
		} finally {
			mock.restore();
		}
	});
});

describe("a clone taken before its original heals an entry that missed the journal", () => {
	it("saves the clone's next turn after the heal while every full rewrite fails", async () => {
		const { storage, manager, sessionDir, sessionFile } = await fileSession();
		storage.failRewrites = true;
		failNextFileWrite();
		manager.appendMessage(userTurn("missing"));
		// AgentSession.newSession detaches the running bash command onto a clone, then flushes, which heals.
		const clone = manager.cloneCurrentSession();
		managers.push(clone);
		await manager.flush();

		clone.appendMessage(userTurn("bash result"));
		await expect(clone.close()).resolves.toBeUndefined();
		expect(userTurnsOf((await reopen(sessionFile, sessionDir)).getBranch())).toEqual([
			"before",
			"missing",
			"bash result",
		]);
	});
});

it("republishes the original graph when a shared entry's parent changed before a foreign append", async () => {
	const first = await fileSession();
	const resumed = await SessionManager.open(first.sessionFile, first.sessionDir, new FullConflictStorage(), {
		suppressBreadcrumb: true,
	});
	managers.push(resumed);
	const shared = first.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
	if (shared?.type !== "message" || shared.message.role !== "user") throw new Error("Expected the shared user turn");
	shared.parentId = shared.id;
	await first.manager.rewriteEntries();
	first.manager.appendCustomEntry("previous-writer-tail", { n: 1 });
	await first.manager.close();

	resumed.appendMessage(userTurn("recovery write fails"));
	resumed.appendMessage(userTurn("latest turn"));
	await resumed.flush();

	const reopened = await reopen(first.sessionFile, first.sessionDir);
	expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "recovery write fails", "latest turn"]);
	expect(reopened.getBranch()).toContainEqual(
		expect.objectContaining({
			type: "message",
			message: expect.objectContaining({ content: [expect.objectContaining({ text: "seed" })] }),
		}),
	);
});

describe("a turn appended after another writer's entries", () => {
	/**
	 * A second manager resumes the journal while the first is still live; the
	 * first then appends its tail (a root entry with `asRoot`) and closes.
	 */
	async function resumedBehindAnotherWriter(storage = new ControlledRewriteStorage(), { asRoot = false } = {}) {
		const first = await fileSession();
		const resumed = await SessionManager.open(first.sessionFile, first.sessionDir, storage, {
			suppressBreadcrumb: true,
		});
		managers.push(resumed);
		if (asRoot) first.manager.resetLeaf();
		first.manager.appendCustomEntry("previous-writer-tail", { n: 1 });
		await first.manager.flush();
		await first.manager.close();
		return { ...first, storage, resumed };
	}

	it("is the leaf a resume restores, and the other writer's entry is kept", async () => {
		const { resumed, sessionDir, sessionFile } = await resumedBehindAnotherWriter();
		resumed.appendMessage(userTurn("latest turn"));
		await resumed.flush();

		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "latest turn"]);
		expect(reopened.getBranch().at(-1)).toMatchObject({ type: "message", message: { content: "latest turn" } });
		expect(reopened.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "previous-writer-tail" }),
		);
	});

	it("reaches the journal while every full rewrite fails", async () => {
		const storage = new ControlledRewriteStorage();
		storage.failRewrites = true;
		const { resumed, sessionDir, sessionFile } = await resumedBehindAnotherWriter(storage);
		resumed.appendMessage(userTurn("latest turn"));

		await expect(resumed.flush()).resolves.toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "latest turn"]);
	});

	it("reaches the journal while every full rewrite fails when the other writer's entry is a root", async () => {
		const storage = new ControlledRewriteStorage();
		storage.failRewrites = true;
		const { resumed, sessionDir, sessionFile } = await resumedBehindAnotherWriter(storage, { asRoot: true });
		resumed.appendMessage(userTurn("latest turn"));

		await expect(resumed.flush()).resolves.toBeUndefined();
		const reopened = await reopen(sessionFile, sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "latest turn"]);
		expect(reopened.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "previous-writer-tail", parentId: null }),
		);
	});

	it.each([
		{ replace: "copied over", put: (from: string, to: string) => fs.copyFileSync(from, to) },
		{
			replace: "renamed over",
			put: (from: string, to: string) => {
				fs.copyFileSync(from, `${to}.replacement`);
				fs.renameSync(`${to}.replacement`, to);
			},
		},
	])("moves to a sibling when another session's journal was $replace a header-only session file", async ({ put }) => {
		const root = TempDir.createSync("@pi-durable-frontier-");
		tempDirs.push(root);
		const sessionDir = path.join(root.path(), "sessions");
		const manager = SessionManager.create(root.path(), sessionDir, new FileSessionStorage());
		managers.push(manager);
		const sessionFile = await manager.newSession();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const other = SessionManager.create(root.path(), sessionDir, new FileSessionStorage());
		managers.push(other);
		other.appendMessage(userTurn("other session's turn"));
		other.appendMessage(assistantMessage("other session's reply"));
		await other.flush();
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("Expected a persisted session file");
		const otherId = other.getSessionId();
		await other.close();
		// Two fresh headers in one cwd measure the same, so the bytes past this
		// session's frontier are exactly the other session's entries, a root first.
		const otherLines = fs.readFileSync(otherFile, "utf8").split("\n");
		expect(Buffer.byteLength(`${otherLines[0]}\n${otherLines[1]}\n`)).toBe(fs.statSync(sessionFile).size);
		put(otherFile, sessionFile);

		manager.appendMessage(userTurn("own turn"));
		manager.appendMessage(assistantMessage("own reply"));
		await expect(manager.flush()).resolves.toBeUndefined();
		// A full rewrite after the flush must not put this session's id on that journal.
		await manager.rewriteEntries();
		await manager.close();

		const movedTo = manager.getSessionFile();
		expect(movedTo).not.toBe(sessionFile);
		const replaced = await reopen(sessionFile, sessionDir);
		expect(replaced.getSessionId()).toBe(otherId);
		expect(userTurnsOf(replaced.getEntries())).toEqual(["other session's turn"]);
		if (!movedTo) throw new Error("Expected the session to keep a file");
		expect(userTurnsOf((await reopen(movedTo, sessionDir)).getBranch())).toEqual(["own turn"]);
	});

	it("moves to a sibling when a persistCopy journal replaces this session with a non-root tail", async () => {
		const root = TempDir.createSync("@pi-durable-frontier-");
		tempDirs.push(root);
		const sessionDir = path.join(root.path(), "sessions");
		const manager = SessionManager.create(root.path(), sessionDir, new FileSessionStorage());
		managers.push(manager);
		manager.appendMessage(assistantMessage("shared seed"));
		await manager.flush();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const issuedSize = fs.statSync(sessionFile).size;

		const other = await manager.persistCopy({ sessionDir, suppressBreadcrumb: true }, new FileSessionStorage());
		managers.push(other);
		other.appendMessage(userTurn("other session's non-root tail"));
		await other.flush();
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("Expected a copied session file");
		const otherId = other.getSessionId();
		expect(Buffer.byteLength(fs.readFileSync(otherFile, "utf8"))).toBeGreaterThan(issuedSize);
		fs.copyFileSync(otherFile, sessionFile);

		manager.appendMessage(userTurn("own turn"));
		manager.appendMessage(assistantMessage("own reply"));
		await expect(manager.flush()).resolves.toBeUndefined();
		await manager.rewriteEntries();
		await manager.close();

		const movedTo = manager.getSessionFile();
		expect(movedTo).not.toBe(sessionFile);
		expect((await reopen(sessionFile, sessionDir)).getSessionId()).toBe(otherId);
		if (!movedTo) throw new Error("Expected the session to keep a file");
		expect(userTurnsOf((await reopen(movedTo, sessionDir)).getBranch())).toEqual(["own turn"]);
	});

	it("reads the bounded header plus only the bytes the other writer appended", async () => {
		const storage = new ReadCountingStorage();
		const first = await fileSession();
		// History the read-back must not touch.
		for (let i = 0; i < 20; i++) first.manager.appendCustomEntry("history", { i, payload: "x".repeat(10_000) });
		await first.manager.flush();
		const resumed = await SessionManager.open(first.sessionFile, first.sessionDir, storage, {
			suppressBreadcrumb: true,
		});
		managers.push(resumed);
		const sizeAtResume = fs.statSync(first.sessionFile).size;
		first.manager.appendCustomEntry("previous-writer-tail", { n: 1 });
		await first.manager.close();
		const appendedBytes = fs.statSync(first.sessionFile).size - sizeAtResume;
		storage.bytesRead = 0;

		resumed.appendMessage(userTurn("latest turn"));
		await expect(resumed.flush()).resolves.toBeUndefined();
		expect(storage.bytesRead).toBeGreaterThan(0);
		expect(storage.bytesRead).toBeLessThanOrEqual(SESSION_HEADER_PREFIX_BYTES + appendedBytes);
		const reopened = await reopen(first.sessionFile, first.sessionDir);
		expect(userTurnsOf(reopened.getBranch())).toEqual(["before", "latest turn"]);
		expect(reopened.getEntries()).toContainEqual(
			expect.objectContaining({ type: "custom", customType: "previous-writer-tail" }),
		);
	});

	it("adopts a foreign tail larger than three chunks without a transcript-sized range read", async () => {
		const storage = new ReadCountingStorage();
		const first = await fileSession();
		const resumed = await SessionManager.open(first.sessionFile, first.sessionDir, storage, {
			suppressBreadcrumb: true,
		});
		managers.push(resumed);
		const payload = "x".repeat(1_000_000);
		const backlog = Math.ceil((3 * SESSION_TAIL_APPEND_CHUNK_BYTES) / Buffer.byteLength(payload, "utf8"));
		for (let i = 0; i < backlog; i++) first.manager.appendCustomEntry("foreign-backlog", { i, payload });
		await first.manager.close();
		storage.rangeReadBytes.length = 0;

		resumed.appendMessage(userTurn("latest turn"));
		await expect(resumed.flush()).resolves.toBeUndefined();

		expect(Math.max(...storage.rangeReadBytes)).toBeLessThanOrEqual(SESSION_TAIL_APPEND_CHUNK_BYTES);
		expect(
			(await reopen(first.sessionFile, first.sessionDir))
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "foreign-backlog"),
		).toHaveLength(backlog);
	});
});

describe("a durably discarded entry", () => {
	/** A session whose branch ends in an assistant turn to discard and its service-tier child. */
	async function sessionWithDiscardableTurn() {
		const session = await fileSession();
		const discardedId = session.manager.appendMessage(assistantMessage("discarded turn"));
		session.manager.appendServiceTierChange({ openai: "priority" });
		return { ...session, discardedId };
	}

	function expectDiscardSurvivesRestart(branch: readonly SessionEntry[], discardedId: string): void {
		expect(branch.some(entry => entry.id === discardedId)).toBe(false);
		expect(branch.flatMap(entry => (entry.type === "service_tier_change" ? [entry.serviceTier] : []))).toContainEqual(
			{
				openai: "priority",
			},
		);
		expect(userTurnsOf(branch)).toEqual(["before", "after", "after2"]);
	}

	it("stays discarded after its rewrite failed once and storage healed", async () => {
		const { storage, manager, sessionDir, sessionFile, discardedId } = await sessionWithDiscardableTurn();
		storage.failNextRewrite = true;
		await manager.discardEntryDurably(discardedId).catch(() => undefined);
		manager.appendMessage(userTurn("after"));
		manager.appendMessage(userTurn("after2"));

		expectDiscardSurvivesRestart((await reopen(sessionFile, sessionDir)).getBranch(), discardedId);
	});

	it("stays discarded when it was queued behind a parked rewrite and its own publish failed", async () => {
		const { storage, manager, sessionDir, sessionFile, discardedId } = await sessionWithDiscardableTurn();
		const parked = storage.parkNextAtomicRewrite();
		const unrelated = manager.rewriteEntries();
		await parked.started;
		storage.failRewrites = true;
		const discard = manager.discardEntryDurably(discardedId);
		parked.release();
		await unrelated.catch(() => undefined);
		await discard.catch(() => undefined);
		storage.failRewrites = false;
		manager.appendMessage(userTurn("after"));
		manager.appendMessage(userTurn("after2"));

		expectDiscardSurvivesRestart((await reopen(sessionFile, sessionDir)).getBranch(), discardedId);
	});
});

describe("a backlog of entries that missed the journal", () => {
	/** About half a MiB serialized: whole entries, several to a chunk. */
	const payload = "x".repeat(499_000);
	/** Enough entries for about three chunks. */
	const backlog = Math.ceil((3 * SESSION_TAIL_APPEND_CHUNK_BYTES) / payload.length);

	/** A file-backed session on disk with no writer open yet. */
	async function recordingSession() {
		const root = TempDir.createSync("@pi-durable-frontier-");
		tempDirs.push(root);
		const sessionDir = path.join(root.path(), "sessions");
		const storage = new AppendRecordingStorage();
		const manager = SessionManager.create(root.path(), sessionDir, storage);
		managers.push(manager);
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return { storage, manager, sessionDir, sessionFile };
	}

	async function sessionWithBacklog() {
		const { storage, manager, sessionDir, sessionFile } = await recordingSession();
		manager.appendMessage(assistantMessage("seed"));
		storage.failAppends = true;
		for (let i = 0; i < backlog; i++) manager.appendCustomEntry("backlog", { i, payload });
		storage.failAppends = false;
		storage.appendBytes.length = 0;
		return { storage, manager, sessionDir, sessionFile };
	}

	/** The backlog indexes the journal holds, in file order, duplicates included. */
	function backlogOnDisk(sessionFile: string): number[] {
		return parseSessionContent(fs.readFileSync(sessionFile, "utf8")).entries.flatMap(entry => {
			if (entry.type !== "custom" || entry.customType !== "backlog") return [];
			const data = entry.data;
			return data && typeof data === "object" && "i" in data && typeof data.i === "number" ? [data.i] : [];
		});
	}
	const wholeBacklog = Array.from({ length: backlog }, (_, i) => i);

	it("is written by flush() in appends no larger than the chunk budget plus one entry, in order", async () => {
		const { storage, manager, sessionDir, sessionFile } = await sessionWithBacklog();

		await expect(manager.flush()).resolves.toBeUndefined();

		expect(storage.appendBytes.length).toBeGreaterThan(1);
		expect(Math.max(...storage.appendBytes)).toBeLessThanOrEqual(
			SESSION_TAIL_APPEND_CHUNK_BYTES + payload.length + 1024,
		);
		expect(backlogOnDisk(sessionFile)).toEqual(wholeBacklog);
		expect((await reopen(sessionFile, sessionDir)).getBranch().at(-1)).toMatchObject({ data: { i: backlog - 1 } });
	});

	it("keeps the chunks that landed before a failed one, and the next flush appends the rest once", async () => {
		const { storage, manager, sessionFile } = await sessionWithBacklog();
		storage.failAppendAt = {
			count: 2,
			error: Object.assign(new Error("ENOSPC: synthetic append failure"), { code: "ENOSPC" }),
		};

		await expect(manager.flush()).rejects.toThrow("ENOSPC");
		const kept = backlogOnDisk(sessionFile);
		expect(kept.length).toBeGreaterThan(0);
		expect(kept).toEqual(wholeBacklog.slice(0, kept.length));

		await expect(manager.flush()).resolves.toBeUndefined();
		expect(backlogOnDisk(sessionFile)).toEqual(wholeBacklog);
	});

	it("has flush() and close() reject with the failure storage gives now, not one that has since cleared", async () => {
		const { storage, manager } = await recordingSession();
		storage.failOpens = true;
		manager.appendMessage(assistantMessage("missing"));
		storage.failOpens = false;
		storage.failAppends = true;

		await expect(manager.flush()).rejects.toThrow("ENOSPC");
		await expect(manager.close()).rejects.toThrow("ENOSPC");
	});
});
