/**
 * Dispose's seal-then-close sequence must preserve the final message and exit
 * record while an Indexed backend still owns an unconfirmed cold rewrite.
 * The immediately following flushSync must defer, not self-conflict against
 * that provisional index. Shutdown still drains the confirmed body and lands
 * the complete journal after sealing. Real backend failures remain visible,
 * and a lost acknowledgement counts as success only after exact readback.
 */

import { describe, expect, it } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

/** Exercise the real Indexed queue and CAS without artificial timer delays. */
class FakeIndexedBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly mtimes = new Map<string, number>();
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

/**
 * `MemorySessionStorage` with `defersSyncPublish` flipped on and no other
 * change: `close()`'s terminal-rewrite retry only runs for a deferred-publish
 * backend (the self-race this PR fixes), and `MemorySessionStorage.writeTextAtomic`
 * has no readback of its own -- unlike `IndexedSessionStorage`'s, which would
 * mask the gap under test -- so the tolerance exercised below is entirely
 * `SessionManager`'s own.
 */
class DeferredPublishMemoryStorage extends MemorySessionStorage {
	readonly defersSyncPublish = true;
}

describe("SessionManager seal()+close() around deferred rewrites", () => {
	it("dispose's seal-then-close still lands the final message and the exit record", async () => {
		const backend = new FakeIndexedBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const observed: Error[] = [];
		manager.onPersistenceError(error => observed.push(error));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		// The final turn's own message-persist (`appendMessage` ->
		// `#appendToCurrentSessionFile` -> `#rewriteSynchronously`) materializes
		// the file through the cold rewrite path and queues its publish.
		manager.appendMessage(assistantMessage("FINAL MESSAGE"));

		// Exactly `AgentSession#recordSessionExit`'s shape: append the exit
		// entry, then `flushSync()`, both inside one try/catch, immediately
		// after -- no await, no third append.
		let exitRecordError: unknown;
		try {
			manager.appendCustomEntry("session_exit", { reason: "dispose" });
			manager.flushSync();
		} catch (err) {
			exitRecordError = err;
		}
		// The provisional-write guard now prevents the old local self-conflict.
		expect(exitRecordError).toBeUndefined();

		// Exactly `AgentSession#doDispose`'s own shutdown sequence: seal (which
		// disables the ordinary mid-life repair path) then close(). No third
		// append follows -- there is none at dispose.
		manager.seal();
		await manager.close();

		const body = backend.files.get(sessionFile) ?? "";
		expect(body).toContain("FINAL MESSAGE");
		expect(body).toContain("session_exit");
		expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(body, "utf8"));
		expect(observed).toEqual([]);
	});

	it("still throws when the retried rewrite itself cannot reach the backend", async () => {
		const backend = new FakeIndexedBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);

		manager.appendMessage(assistantMessage("first"));
		manager.appendCustomEntry("session_exit", { reason: "dispose" });
		manager.flushSync();

		// The backend is genuinely gone (every retried write fails too), not
		// merely a stale precondition: close() must still surface a real
		// failure rather than silently reporting success.
		backend.writeFull = (): Promise<void> => {
			throw new Error("connection reset");
		};

		manager.seal();
		await expect(manager.close()).rejects.toThrow();
	});

	it("close()'s terminal rewrite tolerates an ack-lost write that landed durably anyway", async () => {
		const storage = new DeferredPublishMemoryStorage();
		const manager = SessionManager.create("/cwd", "/sessions/proj", storage);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a session file");

		manager.appendMessage(assistantMessage("FINAL MESSAGE"));
		manager.appendCustomEntry("session_exit", { reason: "dispose" });

		// Latch a disk failure via a transient, fully-unresolvable backend
		// outage (the write fails and the readback returns stale content), so
		// close() below finds `#diskFailure` already set, the same way a real
		// conflict or outage would leave it before dispose.
		const originalReadText = storage.readText.bind(storage);
		storage.writeTextAtomic = async (): Promise<void> => {
			throw new Error("transient backend outage");
		};
		storage.readText = async (): Promise<string> => "stale content that does not match";
		await manager.recoverPersistenceFromCurrentState().catch(() => undefined);
		storage.readText = originalReadText;

		// The retried terminal write close() issues now DOES land -- the
		// backend accepts the content -- but its own acknowledgment is lost
		// once, exactly the class of failure the ordinary mid-life repair
		// path (`#authoritativelyRewriteCurrentStateLocked`) already
		// tolerates via a readback; close()'s terminal rewrite must tolerate
		// it the same way now that both share `#publishAuthoritativeBody`.
		let ackLost = true;
		storage.writeTextAtomic = async (path: string, content: string): Promise<void> => {
			storage.writeTextSync(path, content);
			if (ackLost) {
				ackLost = false;
				throw new Error("connection reset after commit");
			}
		};

		manager.seal();
		await manager.close();

		const body = await storage.readText(sessionFile);
		expect(body).toContain("FINAL MESSAGE");
		expect(body).toContain("session_exit");
	});
});
