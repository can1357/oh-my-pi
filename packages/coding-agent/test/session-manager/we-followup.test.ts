import { describe, expect, it } from "bun:test";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type { SessionStorageBackend } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Fails the first session-file lock acquisition, then lets the rest through. */
class FailOnceLockStorage extends FileSessionStorage {
	lockAttempts = 0;
	lockedWrites = 0;
	#failNext = true;

	override withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		this.lockAttempts++;
		if (this.#failNext) {
			this.#failNext = false;
			throw new Error("session-file lock unavailable");
		}
		this.lockedWrites++;
		return super.withSessionFileLockSync(sessionPath, operation);
	}
}

/** Minimal in-memory SessionStorageBackend for the indexed-storage tests. */
class MapBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly removed: string[][] = [];

	init(): Promise<void> {
		return Promise.resolve();
	}

	loadIndex(): Promise<Iterable<{ path: string; size: number; mtimeMs: number }>> {
		return Promise.resolve([]);
	}

	readFull(path: string): Promise<string | null> {
		return Promise.resolve(this.files.get(path) ?? null);
	}

	readSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const content = this.files.get(path) ?? "";
		const suffix = suffixBytes > 0 ? content.slice(-suffixBytes) : "";
		return Promise.resolve([content.slice(0, prefixBytes), suffix]);
	}

	writeFull(path: string, content: string): Promise<void> {
		this.files.set(path, content);
		return Promise.resolve();
	}

	append(path: string, line: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + line);
		return Promise.resolve();
	}

	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}

	truncate(path: string): Promise<void> {
		this.files.set(path, "");
		return Promise.resolve();
	}

	remove(paths: string[]): Promise<void> {
		this.removed.push(paths);
		for (const path of paths) this.files.delete(path);
		return Promise.resolve();
	}

	move(src: string, dst: string): Promise<void> {
		const content = this.files.get(src);
		if (content !== undefined) {
			this.files.delete(src);
			this.files.set(dst, content);
		}
		return Promise.resolve();
	}
}

describe("PRDeep.Own11574 WE follow-ups (review threads WE-e + WE-j)", () => {
	// WE-e: a first durable append whose lock acquisition fails stays in
	// #entries, so the entries-derived predicate can never route the retry to
	// the lock. The next append must still serialize on the session-file lock
	// instead of falling into an unlocked full rewrite.
	it("retries the session-file lock for the next durable append after a failed first append", async () => {
		using tempDir = TempDir.createSync("@pi-session-first-durable-lock-retry-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		const storage = new FailOnceLockStorage();
		const termC = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termC.setSessionFile(sessionFile);
		expect(await termC.consumeDraft()).toBeNull();

		termC.appendMessage({ role: "user", content: "first durable entry in C", timestamp: 1 });
		termC.appendMessage({ role: "user", content: "second durable entry in C", timestamp: 2 });
		await termC.flush();

		// The failed first append must not downgrade the retry to an unlocked
		// rewrite: the second append takes the lock again and publishes there.
		expect(storage.lockAttempts).toBe(2);
		expect(storage.lockedWrites).toBe(1);

		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("first durable entry in C");
		expect(content).toContain("second durable entry in C");
		await termB.close();
		await termA.close();
	});

	// WE-j: IndexedSessionStorage (Redis/SQL parent) never implemented the
	// optional conditional delete, so #dropIfEmptyAndNoDraft silently skipped
	// GC for every indexed backend. The capability must exist and be atomic
	// with respect to the backend's own per-path serialization.
	it("conditionally deletes metadata-only sessions on indexed backends", async () => {
		const backend = new MapBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		const conditionalDelete = storage.deleteSessionWithArtifactsIf;
		expect(typeof conditionalDelete).toBe("function");

		const metaPath = "/sessions/meta-only.jsonl";
		const durablePath = "/sessions/durable.jsonl";
		storage.writeTextSync(metaPath, "header\n");
		storage.writeTextSync(durablePath, "header\n");
		await storage.drain();

		expect(await conditionalDelete!.call(storage, metaPath, () => true)).toBe(true);
		expect(backend.files.has(metaPath)).toBe(false);

		expect(await conditionalDelete!.call(storage, durablePath, () => false)).toBe(false);
		expect(backend.files.has(durablePath)).toBe(true);

		expect(await conditionalDelete!.call(storage, "/sessions/missing.jsonl", () => true)).toBe(false);
	});

	// WE-j end to end: a draft-only session on an indexed backend is dropped
	// at close once its draft is consumed, instead of leaking the record and
	// its marker forever.
	it("drops a consumed draft-only session on indexed backends at close", async () => {
		const backend = new MapBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		const manager = SessionManager.create("/cwd", "/sessions", storage);
		manager.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await manager.saveDraft("indexed draft");

		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		expect(backend.files.has(sessionFile)).toBe(true);
		expect(await manager.consumeDraft()).toBe("indexed draft");

		await manager.close();

		expect(backend.files.has(sessionFile)).toBe(false);
		for (const path of backend.files.keys()) {
			expect(path.endsWith(".draft-only-session")).toBe(false);
		}
	});
});
