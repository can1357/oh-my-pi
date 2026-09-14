import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type { SessionStorageBackend } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
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

/**
 * Replays the rBN-/:2109 race inside one close: the first session-file lock
 * acquisition runs a rival closer that removes the session and its artifacts,
 * and the verdict hook re-materializes the session with a fresh marker and
 * draft after the verdict's lock released — the window where the loser's
 * post-lock marker clear used to delete the new owner's marker.
 */
class MissingVerdictStorage extends FileSessionStorage {
	onFirstLock: (() => void) | null = null;
	onAfterVerdict: (() => void) | null = null;

	override withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		const hook = this.onFirstLock;
		this.onFirstLock = null;
		if (hook) hook();
		return super.withSessionFileLockSync(sessionPath, operation);
	}

	override async deleteSessionWithArtifactsIf(
		sessionPath: string,
		shouldDelete: (content: string, complete: boolean) => boolean,
	): Promise<boolean> {
		const deleted = await super.deleteSessionWithArtifactsIf(sessionPath, shouldDelete);
		const hook = this.onAfterVerdict;
		this.onAfterVerdict = null;
		if (hook) hook();
		return deleted;
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

	// rBN-/:2109 — two stale closers race and the loser observes a missing
	// file. The missing verdict never ran the predicate, so it must not clear
	// a marker re-materialized after the lock released; otherwise the next
	// consumer cannot re-arm cleanup and the metadata-only session leaks.
	it("preserves a marker recreated after a missing-file delete verdict", async () => {
		using tempDir = TempDir.createSync("@pi-session-missing-verdict-marker-");
		const storage = new MissingVerdictStorage();
		const termA = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const artifactsDir = sessionFile.slice(0, -6);
		const markerPath = path.join(artifactsDir, ".draft-only-session");
		const draftPath = path.join(artifactsDir, "draft.txt");
		expect(fs.existsSync(markerPath)).toBe(true);

		const termB = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		// Terminal A is stale and still armed for draft-only GC. Its close
		// loses the race: a rival closer removes the session and its artifacts
		// inside the verdict lock, then a third terminal re-materializes the
		// session with a fresh marker and draft after the lock released.
		const sessionBytes = fs.readFileSync(sessionFile);
		storage.onFirstLock = () => {
			fs.rmSync(sessionFile, { force: true });
			fs.rmSync(artifactsDir, { recursive: true, force: true });
		};
		storage.onAfterVerdict = () => {
			fs.writeFileSync(sessionFile, sessionBytes);
			fs.mkdirSync(artifactsDir, { recursive: true });
			fs.writeFileSync(markerPath, "");
			fs.writeFileSync(draftPath, "fresh draft from terminal C");
		};

		await termA.close();

		expect(fs.existsSync(sessionFile)).toBe(true);
		expect(fs.existsSync(markerPath)).toBe(true);
		expect(fs.existsSync(draftPath)).toBe(true);
		await termB.close();
	});
});

/** Unlinks and byte-identically recreates the session file on lock entry: the
 *  GC unlink plus another manager's re-materialization replacing the inode. A
 *  writer opened before entry still points at the old inode. */
class UnlinkRecreateOnLockStorage extends FileSessionStorage {
	#sessionFile: string | null = null;

	armReplace(sessionFile: string): void {
		this.#sessionFile = sessionFile;
	}

	override withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		if (sessionPath === this.#sessionFile) {
			this.#sessionFile = null;
			const prior = fs.readFileSync(sessionPath, "utf-8");
			fs.rmSync(sessionPath, { force: true });
			fs.writeFileSync(sessionPath, prior);
		}
		return super.withSessionFileLockSync(sessionPath, operation);
	}
}

/** Strips both synchronous publish primitives so the locked title path must
 *  use its async fallbacks, and gates the async publishes on a test latch. */
class GatedAsyncTitleStorage extends FileSessionStorage {
	closeCalled = false;
	#gate: Promise<void>;
	#releaseGate: () => void;

	constructor() {
		super();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#gate = promise;
		this.#releaseGate = resolve;
		// The locked title path probes these as optional capability flags:
		// absent means "custom backend without sync publication".
		(this as unknown as Record<string, unknown>).updateSessionTitleSync = undefined;
	}

	release(): void {
		this.#releaseGate?.();
	}

	override async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		await this.#gate;
		// Call the prototype's sync slot rewrite directly: this instance's own
		// updateSessionTitleSync is stripped (that is the point of the double),
		// and the async wrapper would dispatch back to the stripped slot.
		return FileSessionStorage.prototype.updateSessionTitleSync!.call(this, path, update);
	}

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const inner = super.openWriter(path, options);
		const storage = this;
		const gate = this.#gate;
		return {
			async append(line: string): Promise<void> {
				await gate;
				return inner.append(line);
			},
			async flush(): Promise<void> {
				return inner.flush();
			},
			isOpen(): boolean {
				return inner.isOpen();
			},
			async close(): Promise<void> {
				storage.closeCalled = true;
				return inner.close();
			},
			getError(): Error | undefined {
				return inner.getError();
			},
		};
	}
}

/** Publishes a rival draft through the same indexed instance from inside the
 *  verdict's backend read, the way a same-instance same-process write lands
 *  during the awaited readFull. */
class RivalPublishBackend extends MapBackend {
	storage: IndexedSessionStorage | null = null;
	#armed = false;
	#rivalFired = false;

	armRival(storage: IndexedSessionStorage): void {
		this.storage = storage;
		this.#armed = true;
	}

	override async readFull(path: string): Promise<string | null> {
		const storage = this.storage;
		if (this.#armed && !this.#rivalFired && storage && path.endsWith("/draft.txt")) {
			this.#rivalFired = true;
			this.files.set(path, "rival draft via shared storage");
			storage.writeTextSync(path, "rival draft via shared storage");
		}
		return super.readFull(path);
	}
}
describe("PRDeep.Repair11574b retained review findings (rBN6 + rKBt + rKBz + rBOB)", () => {
	// rBN6: the indexed conditional delete must see a draft sidecar another
	// instance published straight to the backend. The verdict predicate only
	// reads this instance's index, so without the backend-fresh re-check the
	// delete below orphans the other instance's draft.
	it("vetoes the indexed conditional delete when another instance's draft reached the backend", async () => {
		const backend = new MapBackend();
		const storageA = new IndexedSessionStorage(backend);
		await storageA.initialize();

		const managerA = SessionManager.create("/cwd", "/sessions", storageA);
		managerA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await managerA.saveDraft("draft in terminal A");

		const sessionFile = managerA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const draftPath = path.join(managerA.getArtifactsDir()!, "draft.txt");
		const markerPath = path.join(managerA.getArtifactsDir()!, ".draft-only-session");
		expect(await managerA.consumeDraft()).toBe("draft in terminal A");

		// A second instance's late draft save lands straight in the backend,
		// invisible to A's index -- the cross-instance write the predicate's
		// existsSync cannot see.
		backend.files.set(draftPath, "late draft from terminal B");

		await managerA.close();

		expect(backend.files.has(sessionFile)).toBe(true);
		expect(backend.files.has(markerPath)).toBe(true);
		expect(backend.files.get(draftPath)).toBe("late draft from terminal B");
	});

	// rKBt: the cached writer may reference an inode the GC unlinked and
	// recreated after the writer opened. The locked title path must reopen
	// under the lock instead of appending into the unlinked file.
	it("appends the title entry to the current file when the session was replaced after the writer opened", async () => {
		using tempDir = TempDir.createSync("@pi-session-stale-writer-title-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const storage = new UnlinkRecreateOnLockStorage();
		const termB = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");
		// Open termB's writer against the current inode before the rival
		// replace, so the locked title path below reuses a stale handle
		// without the fix.
		termB.appendModelChange("litellm/anthropic--claude-4.7-opus", "default");
		await termB.flush();
		storage.armReplace(sessionFile);

		await termB.setSessionName("renamed before the first message", "user");
		await termB.close();

		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("renamed before the first message");
		expect(content.includes('"title_change"')).toBe(true);
		await termA.close();
	});

	// rKBz: GC during the ensureOnDisk await removes the file and its marker.
	// The save must still take the locked path on its pre-await marker
	// eligibility and re-materialize the session instead of orphaning the
	// sidecar with an unlocked write.
	it("re-materializes the session when GC removes it during the saveDraft await", async () => {
		using tempDir = TempDir.createSync("@pi-session-save-during-gc-");
		const first = SessionManager.create(tempDir.path(), tempDir.path());
		first.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await first.saveDraft("original draft");
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await first.close();

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		const artifactsDir = resumed.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected artifacts dir");

		// A rival close-time GC lands exactly in the ensureOnDisk await window:
		// microtask FIFO runs it after saveDraft yields and before it resumes.
		queueMicrotask(() => {
			fs.rmSync(sessionFile, { force: true });
			fs.rmSync(artifactsDir, { recursive: true, force: true });
		});
		await resumed.saveDraft("draft typed after resume");

		expect(await Bun.file(sessionFile).exists()).toBe(true);
		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(await Bun.file(path.join(artifactsDir, ".draft-only-session")).exists()).toBe(true);
		expect(await resumed.consumeDraft()).toBe("draft typed after resume");
		await resumed.close();
	});

	// rBOB: an async-only writer cannot publish before the synchronous lock
	// callback returns. The locked title path must hold the publish on the
	// disk tail so close() awaits it instead of deciding GC on a file that
	// does not carry the entry yet.
	it("holds close() until a deferred async title publish lands", async () => {
		using tempDir = TempDir.createSync("@pi-session-deferred-title-publish-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const storage = new GatedAsyncTitleStorage();
		const termB = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		await termB.setSessionName("renamed before the first message", "user");

		// Both publishes are still gated: close() must park on the disk tail.
		// The bounded poll only distinguishes "sailed past" (no fix) from
		// "parked on the gate" (fix); the gate release below is what unblocks.
		const closed = termB.close();
		// Real-timer exception: close() performs genuine filesystem I/O (writer
		// close, marker unlink), so fake timers cannot advance it, and the poll
		// observes whether close parked on the gated tail or sailed past -- a
		// condition no exposed promise names. Bounded (200 turns); the gate
		// release below is what unblocks either way.
		for (let i = 0; i < 200 && !storage.closeCalled; i++) await new Promise(resolve => setTimeout(resolve, 0));
		storage.release();
		await closed;

		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("renamed before the first message");
		expect(content.includes('"title_change"')).toBe(true);
		await termA.close();
	});
});

describe("PRDeep.Repair11574b round 2 (loan revalidation + debt clearing + rival close)", () => {
	// Loan revalidation: a same-instance draft publish landing during the
	// verdict's backend read populates a real index entry. The lend must not
	// overwrite it with the placeholder, and the finally must not delete it.
	it("keeps a same-instance draft index entry published during the verdict read", async () => {
		const backend = new RivalPublishBackend();
		const storageA = new IndexedSessionStorage(backend);
		await storageA.initialize();

		const managerA = SessionManager.create("/cwd", "/sessions", storageA);
		managerA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await managerA.saveDraft("draft in terminal A");

		const sessionFile = managerA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const draftPath = path.join(managerA.getArtifactsDir()!, "draft.txt");
		expect(await managerA.consumeDraft()).toBe("draft in terminal A");

		backend.armRival(storageA);
		await managerA.close();

		// The verdict vetoed on the rival draft, so the session survives; the
		// rival's real index entry must survive too, not just the backend key.
		expect(backend.files.has(sessionFile)).toBe(true);
		expect(storageA.existsSync(draftPath)).toBe(true);
		expect(backend.files.get(draftPath)).toBe("rival draft via shared storage");
	});

	// Debt clearing: once the queued async title publish succeeds, the
	// retained rewrite debt must clear. Otherwise the next append takes the
	// full-body rewrite path from a journal that never saw another manager's
	// durable append and drops it.
	it("does not drop another manager's durable append when the queued title publish succeeds", async () => {
		using tempDir = TempDir.createSync("@pi-session-title-debt-cleared-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const storage = new GatedAsyncTitleStorage();
		storage.release();
		const termB = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		await termB.setSessionName("renamed before the first message", "user");
		await termB.flush();

		termA.appendMessage({ role: "user", content: "durable from terminal A", timestamp: 3 });
		await termA.flush();

		termB.appendMessage({ role: "user", content: "second durable in B", timestamp: 4 });
		await termB.flush();

		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("durable from terminal A");
		expect(content).toContain("second durable in B");
		await termB.close();
		await termA.close();
	});

	// Rival close: a competing close deciding on the file while B's publish
	// is still gated wins lawfully (no title entry on disk yet). B's late
	// append lands in the unlinked inode (invisible); its title update fails
	// on the missing path and latches a persistence failure instead of
	// silently dropping the entry or resurrecting a headerless file.
	it("fails closed when a rival close wins before a deferred title publish lands", async () => {
		using tempDir = TempDir.createSync("@pi-session-rival-close-wins-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const storage = new GatedAsyncTitleStorage();
		const termB = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		await termB.setSessionName("renamed before the first message", "user");

		await termA.close();
		storage.release();

		await expect(termB.flush()).rejects.toThrow();
		expect(await Bun.file(sessionFile).exists()).toBe(false);
		await termB.close().catch(() => undefined);
	});
});
