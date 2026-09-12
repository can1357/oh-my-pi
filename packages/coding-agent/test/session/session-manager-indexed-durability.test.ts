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

import { describe, expect, it } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

class FakeBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly mtimes = new Map<string, number>();
	/** Reject the next N append calls with a transient failure. */
	failAppends = 0;
	/** Reject the next N whole-file publishes with a transient failure. */
	failWrites = 0;
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
		if (this.failAppends > 0) {
			this.failAppends -= 1;
			throw new Error("transient backend append failure");
		}
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
		if (this.failWrites > 0) {
			this.failWrites -= 1;
			throw new Error("transient backend write failure");
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

	it("recovers a transient indexed append failure instead of stranding entries in memory", async () => {
		const { backend, storage, manager } = await makeManager();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");
		const before = manager.captureState().expectedDiskSize;

		backend.failAppends = 1;
		manager.appendMessage({ role: "user", content: "lost turn", timestamp: Date.now() });
		// Let the queued publish fail and the writer latch it.
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		// A failed append must not be counted as durable.
		expect(manager.captureState().expectedDiskSize).toBe(before);

		// The next entry retries the whole in-memory transcript.
		manager.appendMessage({ role: "user", content: "recovered turn", timestamp: Date.now() });
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("lost turn");
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
		// assistant message) is rejected by the backend.
		backend.failWrites = 1;
		manager.appendMessage(assistantMessage("first turn"));
		await manager.flush().catch(() => {});
		await storage.drain().catch(() => {});

		// The next append retries the whole in-memory transcript.
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
});
