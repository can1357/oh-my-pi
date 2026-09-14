import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage, type SessionStorageWriter } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";

async function fileExists(p: string): Promise<boolean> {
	try {
		await Bun.file(p).stat();
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** Announces the conditional delete so a spawned appender can take the lock. */
class SignalingDeleteStorage extends FileSessionStorage {
	readonly #attemptPath: string;

	constructor(attemptPath: string) {
		super();
		this.#attemptPath = attemptPath;
	}

	override deleteSessionWithArtifactsIf(
		sessionPath: string,
		shouldDelete: (content: string, complete: boolean) => boolean,
	): Promise<boolean> {
		fs.writeFileSync(this.#attemptPath, "");
		return super.deleteSessionWithArtifactsIf(sessionPath, shouldDelete);
	}
}

/** Saves a draft while another manager is inside its conditional delete. */
class LateDraftStorage extends FileSessionStorage {
	#draftPath: string | null = null;
	#draftText = "";

	armLateDraft(draftPath: string, draftText: string): void {
		this.#draftPath = draftPath;
		this.#draftText = draftText;
	}

	override deleteSessionWithArtifactsIf(
		sessionPath: string,
		shouldDelete: (content: string, complete: boolean) => boolean,
	): Promise<boolean> {
		if (this.#draftPath && this.#draftText.length > 0) fs.writeFileSync(this.#draftPath, this.#draftText);
		return super.deleteSessionWithArtifactsIf(sessionPath, shouldDelete);
	}
}

/** Removes the session file (and its artifacts) after the first materialize. */
class GcAfterMaterializeStorage extends FileSessionStorage {
	#sessionFile: string | null = null;

	armGc(sessionFile: string): void {
		this.#sessionFile = sessionFile;
	}

	override async writeTextAtomic(
		path: string,
		content: string,
		options?: { commitGuard?: () => boolean },
	): Promise<void> {
		await super.writeTextAtomic(path, content, options);
		if (path !== this.#sessionFile) return;
		this.#sessionFile = null;
		fs.rmSync(path, { force: true });
		fs.rmSync(path.slice(0, -6), { recursive: true, force: true });
	}
}

/** Deletes the session file the instant a writer opens it for appending. */
class GcBeforeAppendStorage extends FileSessionStorage {
	#sessionFile: string | null = null;

	armGc(sessionFile: string): void {
		this.#sessionFile = sessionFile;
	}

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		if (path === this.#sessionFile) {
			this.#sessionFile = null;
			fs.rmSync(path, { force: true });
		}
		return super.openWriter(path, options);
	}
}

/** Fails every session-file lock acquisition so a save must fail closed. */
class FailingLockStorage extends FileSessionStorage {
	override withSessionFileLockSync<T>(_sessionPath: string, _operation: () => T): T {
		throw new Error("session-file lock unavailable");
	}
}

/**
 * Stands in for a close-time GC another process already decided to run: once an
 * unlocked draft write lands it removes the session file and its artifacts. A
 * writer that took the session-file lock is left alone, because the GC's
 * predicate re-reads the sidecar under that same lock and keeps the session.
 */
class GcAfterUnlockedDraftWriteStorage extends FileSessionStorage {
	#sessionFile: string | null = null;
	#lockHeld = false;

	armGc(sessionFile: string): void {
		this.#sessionFile = sessionFile;
	}

	override withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		this.#lockHeld = true;
		try {
			return super.withSessionFileLockSync(sessionPath, operation);
		} finally {
			this.#lockHeld = false;
		}
	}

	override writeTextSync(path: string, content: string): void {
		super.writeTextSync(path, content);
		this.#gcAfterUnlockedDraftWrite(path);
	}

	override async writeText(path: string, content: string): Promise<void> {
		await super.writeText(path, content);
		this.#gcAfterUnlockedDraftWrite(path);
	}

	#gcAfterUnlockedDraftWrite(path: string): void {
		if (this.#lockHeld || !this.#sessionFile || !path.endsWith("draft.txt")) return;
		const sessionFile = this.#sessionFile;
		this.#sessionFile = null;
		fs.rmSync(sessionFile, { force: true });
		fs.rmSync(sessionFile.slice(0, -6), { recursive: true, force: true });
	}
}

/**
 * Same unlocked-publish GC stand-in as above, but keyed on the session file so
 * it fires for the full-body publish the atomic batch commit uses.
 */
class GcAfterUnlockedPublishStorage extends FileSessionStorage {
	#sessionFile: string | null = null;
	#lockHeld = false;

	armGc(sessionFile: string): void {
		this.#sessionFile = sessionFile;
	}

	override withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		this.#lockHeld = true;
		try {
			return super.withSessionFileLockSync(sessionPath, operation);
		} finally {
			this.#lockHeld = false;
		}
	}

	override writeTextSync(path: string, content: string): void {
		super.writeTextSync(path, content);
		this.#gcAfterUnlockedPublish(path);
	}

	override async writeTextAtomic(
		path: string,
		content: string,
		options?: { commitGuard?: () => boolean },
	): Promise<void> {
		await super.writeTextAtomic(path, content, options);
		this.#gcAfterUnlockedPublish(path);
	}

	#gcAfterUnlockedPublish(path: string): void {
		if (this.#lockHeld || !this.#sessionFile || path !== this.#sessionFile) return;
		const sessionFile = this.#sessionFile;
		this.#sessionFile = null;
		fs.rmSync(sessionFile, { force: true });
		fs.rmSync(sessionFile.slice(0, -6), { recursive: true, force: true });
	}
}

/**
 * Deletes the session file the instant a writer opens it for appending while
 * the session-file lock is not held, standing in for the close-time GC another
 * terminal still holds. A locked append is left alone.
 */
class GcOnUnlockedAppendStorage extends FileSessionStorage {
	#sessionFile: string | null = null;
	#lockHeld = false;

	armGc(sessionFile: string): void {
		this.#sessionFile = sessionFile;
	}

	override withSessionFileLockSync<T>(sessionPath: string, operation: () => T): T {
		this.#lockHeld = true;
		try {
			return super.withSessionFileLockSync(sessionPath, operation);
		} finally {
			this.#lockHeld = false;
		}
	}

	override openWriter(
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		if (!this.#lockHeld && this.#sessionFile !== null && path === this.#sessionFile) {
			const sessionFile = this.#sessionFile;
			this.#sessionFile = null;
			fs.rmSync(sessionFile, { force: true });
			fs.rmSync(sessionFile.slice(0, -6), { recursive: true, force: true });
		}
		return super.openWriter(path, options);
	}
}

/** Records what the close-time GC handed to the locked delete predicate. */
class RecordingDeleteStorage extends FileSessionStorage {
	readonly probes: Array<{ bytes: number; complete: boolean }> = [];

	override deleteSessionWithArtifactsIf(
		sessionPath: string,
		shouldDelete: (content: string, complete: boolean) => boolean,
	): Promise<boolean> {
		return super.deleteSessionWithArtifactsIf(sessionPath, (content, complete) => {
			this.probes.push({ bytes: Buffer.byteLength(content, "utf-8"), complete });
			return shouldDelete(content, complete);
		});
	}
}

describe("SessionManager close() drops empty metadata-only sessions", () => {
	// Repro of issue #4571: saveDraft(text) materializes the JSONL so the
	// draft sidecar has a parent. A subsequent saveDraft("") only unlinks
	// the sidecar — before the fix, close() left the metadata-only file
	// behind and every ctrl+D cycle leaked another 500–750B zombie.
	it("drops the session file when close() runs with no user/assistant messages and no draft", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-drop-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		session.appendModelChange("litellm/anthropic--claude-4.7-opus", "default");

		await session.saveDraft("some in-progress text"); // materializes JSONL
		await session.saveDraft(""); // sidecar unlinked; before fix, file survives

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		await session.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});

	// `plan.defaultOnStartup` records a `mode_change` before the composer
	// restores its draft. Clearing that draft and closing must still drop the
	// otherwise metadata-only file — mode changes are startup selector state,
	// not durable conversation.
	it("drops the session file when only mode/model changes precede a cleared draft", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-drop-plan-startup-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		session.appendModeChange("plan", { planFilePath: "local://PLAN.md" });

		await session.saveDraft("plan-mode draft");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		await session.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});

	it("drops a resumed draft-only session after consumeDraft removes the sidecar", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-drop-resumed-draft-");
		const firstRun = SessionManager.create(tempDir.path(), tempDir.path());
		firstRun.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await firstRun.saveDraft("resume me");

		const sessionFile = firstRun.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await firstRun.close();
		expect(await fileExists(sessionFile)).toBe(true);

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraft()).toBe("resume me");
		await resumed.saveDraft("");
		await resumed.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});

	// A draft still on disk at close time is the whole reason the session
	// file was materialized in the first place (`--resume` needs to find
	// this session's file to reattach the draft). Never drop it.
	it("keeps the session file when a draft sidecar is still present at close", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-keep-draft-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await session.saveDraft("queued for next time");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const draftPath = path.join(session.getArtifactsDir()!, "draft.txt");
		expect(await fileExists(draftPath)).toBe(true);

		await session.close();

		expect(await fileExists(sessionFile)).toBe(true);
		expect(await fileExists(draftPath)).toBe(true);
	});

	// Real conversations must survive close() unconditionally.
	it("keeps the session file when it contains a real user message", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-keep-user-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.saveDraft("draft that will be cleared");
		await session.saveDraft("");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		await session.close();

		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("keeps an explicitly ensured empty session discoverable after close", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-keep-explicit-empty-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		await session.ensureOnDisk();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		await session.close();

		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("keeps an explicitly ensured empty session after its draft is consumed on resume", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-keep-explicit-resumed-draft-");
		const firstRun = SessionManager.create(tempDir.path(), tempDir.path());
		await firstRun.ensureOnDisk();
		await firstRun.saveDraft("resume me");

		const sessionFile = firstRun.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await firstRun.close();
		expect(await fileExists(sessionFile)).toBe(true);

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraft()).toBe("resume me");
		await resumed.saveDraft("");
		await resumed.close();

		expect(await fileExists(sessionFile)).toBe(true);
	});

	it("keeps a handoff custom message even before the next user turn", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-keep-handoff-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendCustomMessageEntry("handoff", "handoff context", true, undefined, "agent");
		await session.ensureOnDisk();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		await session.close();

		expect(await fileExists(sessionFile)).toBe(true);
	});

	// Never-materialized sessions (no draft ever saved, no assistant reply)
	// must not be summoned into existence by close() itself.
	it("is a no-op when the session file was never materialized", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-never-materialized-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file path");
		expect(await fileExists(sessionFile)).toBe(false);

		await session.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});

	// Issue #11497: terminal A materializes a draft-only file and arms the GC;
	// terminal B resumes it, consumes the draft (removing the sidecar the GC
	// keys off) and persists a real conversation. Terminal A then closes with a
	// stale draft-only view, so its GC must re-read the file before deleting.
	it("keeps the file when another manager consumed the draft and appended real messages", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-keep-cross-writer-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");
		termB.appendMessage({ role: "user", content: "real question", timestamp: 1 });
		await termB.close();

		await termA.close();

		expect(await fileExists(sessionFile)).toBe(true);
		const loaded = parseSessionContent(await Bun.file(sessionFile).text());
		expect(loaded.invalidHeader).toBe(false);
		expect(JSON.stringify(loaded.entries)).toContain("real question");
	});

	// The GC's re-read and its unlink must be one locked step. A spawned appender
	// holds the session-file lock across the GC's delete attempt, so the append
	// lands inside the window an unlocked check/delete would have missed.
	it("serializes the close-time GC against a cross-process append", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-lock-cross-writer-");
		const deleteAttemptPath = path.join(tempDir.path(), "delete-attempted");
		const termA = SessionManager.create(
			tempDir.path(),
			tempDir.path(),
			new SignalingDeleteStorage(deleteAttemptPath),
		);
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		const appender = Bun.spawn(
			[
				process.execPath,
				path.join(import.meta.dir, "fixtures/draft-gc-lock-appender.ts"),
				sessionFile,
				deleteAttemptPath,
			],
			{
				cwd: path.resolve(import.meta.dir, "../../../.."),
				env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		try {
			const reader = appender.stdout.getReader();
			const ready = await reader.read();
			reader.releaseLock();
			expect(new TextDecoder().decode(ready.value)).toContain("ready");

			// The child owns the session lock until A reaches its competing
			// inspect-and-delete, then appends before releasing it.
			await termA.close();
			expect(await appender.exited).toBe(0);

			expect(await fileExists(sessionFile)).toBe(true);
			expect(await Bun.file(sessionFile).text()).toContain("real question from the other terminal");
			await termB.close();
		} finally {
			if (appender.exitCode === null) {
				appender.kill();
				await appender.exited;
			}
		}
	});

	// A draft saved after the GC read the directory must keep its parent
	// session: the sidecar check is part of the locked delete predicate.
	it("keeps the file when a draft is saved while the GC is deciding", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-late-draft-");
		const storage = new LateDraftStorage();
		const termA = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const draftPath = path.join(termA.getArtifactsDir()!, "draft.txt");
		await termA.saveDraft("");
		storage.armLateDraft(draftPath, "late draft");

		await termA.close();

		expect(await fileExists(sessionFile)).toBe(true);
		expect(await Bun.file(draftPath).text()).toBe("late draft");
	});

	// The GC can win the lock and delete the draft-only file while this manager
	// is still writing its draft, so the draft write must re-materialize the
	// parent session it attaches to.
	it("re-materializes the session when the GC drops it during the draft save", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-save-vs-gc-");
		const storage = new GcAfterMaterializeStorage();
		const session = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		storage.armGc(sessionFile);

		await session.saveDraft("typed while the other terminal closed");

		expect(await fileExists(sessionFile)).toBe(true);
		expect(parseSessionContent(await Bun.file(sessionFile).text()).invalidHeader).toBe(false);
		expect(await Bun.file(path.join(session.getArtifactsDir()!, "draft.txt")).text()).toBe(
			"typed while the other terminal closed",
		);
	});

	// A GC that removed the draft-only file before the first durable append must
	// not leave a headerless file carrying only that entry.
	it("rebuilds the session when the GC already removed the file before the first append", async () => {
		using tempDir = TempDir.createSync("@pi-session-append-after-gc-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");
		fs.rmSync(sessionFile);

		termB.appendMessage({ role: "user", content: "written after the GC", timestamp: 1 });
		await termB.close();

		expect(await fileExists(sessionFile)).toBe(true);
		const loaded = parseSessionContent(await Bun.file(sessionFile).text());
		expect(loaded.invalidHeader).toBe(false);
		expect(JSON.stringify(loaded.entries)).toContain("written after the GC");
	});

	// `/rename` straight after resuming a draft is the same transition through
	// the title path: the append plus title-slot rewrite would recreate a
	// headerless file and overwrite its first bytes if the GC won the race.
	it("rebuilds the session when the GC removes the file before a draft-only rename", async () => {
		using tempDir = TempDir.createSync("@pi-session-rename-after-gc-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const storage = new GcBeforeAppendStorage();
		storage.armGc(sessionFile);
		const termB = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		await termB.setSessionName("renamed before the first message", "user");
		await termA.close();

		expect(await fileExists(sessionFile)).toBe(true);
		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("renamed before the first message");
	});

	// A draft save whose session-file lock cannot be taken must fail instead of
	// writing the sidecar unlocked: a delayed close-time GC could still be
	// holding the lock it never observed and delete the sidecar after the save
	// reported success.
	it("fails the draft save when the session-file lock cannot be taken", async () => {
		using tempDir = TempDir.createSync("@pi-session-draft-lock-failure-");
		const session = SessionManager.create(tempDir.path(), tempDir.path(), new FailingLockStorage());
		session.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		const draftPath = path.join(session.getArtifactsDir()!, "draft.txt");

		await expect(session.saveDraft("must not land")).rejects.toThrow(/lock unavailable/);
		expect(await fileExists(draftPath)).toBe(false);
	});

	// A resumed draft-only session keeps `.draft-only-session` while its sidecar
	// still exists, so it stays a GC target even though `#setSessionFile` cleared
	// the in-memory arm flag. Saving a draft against it must take the same lock.
	it("takes the session-file lock when saving a draft onto a marker-backed resumed session", async () => {
		using tempDir = TempDir.createSync("@pi-session-resumed-draft-save-");
		const first = SessionManager.create(tempDir.path(), tempDir.path());
		first.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await first.saveDraft("original draft");
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await first.close();
		expect(await fileExists(sessionFile)).toBe(true);

		const storage = new GcAfterUnlockedDraftWriteStorage();
		storage.armGc(sessionFile);
		const resumed = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await resumed.setSessionFile(sessionFile);
		await resumed.saveDraft("draft typed after resume");

		expect(await fileExists(sessionFile)).toBe(true);
		expect(parseSessionContent(await Bun.file(sessionFile).text()).invalidHeader).toBe(false);
		expect(await Bun.file(path.join(resumed.getArtifactsDir()!, "draft.txt")).text()).toBe(
			"draft typed after resume",
		);
	});

	// The atomic batch commit publishes a full body through its own branch, so
	// the first durable entry it creates out of a resumed draft must be
	// serialized on the session-file lock like every other first durable write.
	it("takes the session-file lock for the first durable atomic batch after a resumed draft", async () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-batch-lock-");
		const first = SessionManager.create(tempDir.path(), tempDir.path());
		first.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await first.saveDraft("draft for the batch");
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		await first.close();

		const storage = new GcAfterUnlockedPublishStorage();
		const resumed = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraft()).toBe("draft for the batch");

		await resumed.appendEntriesAtomically(() => {
			storage.armGc(sessionFile);
			resumed.appendCustomEntry("batched durable entry");
		});

		expect(await fileExists(sessionFile)).toBe(true);
		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("batched durable entry");
		await resumed.close();
	});

	// A late draft vetoes the locked delete but leaves the session a draft-only
	// GC target. `consumeDraft` re-arms cleanup from the marker, so clearing it
	// on that veto disables the later GC and leaks the metadata-only file.
	it("keeps the draft-only marker when a late draft vetoes the GC", async () => {
		using tempDir = TempDir.createSync("@pi-session-late-draft-marker-");
		const storage = new LateDraftStorage();
		const termA = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");
		const draftPath = path.join(termA.getArtifactsDir()!, "draft.txt");
		await termA.saveDraft("");
		storage.armLateDraft(draftPath, "late draft");

		await termA.close();
		expect(await fileExists(sessionFile)).toBe(true);

		const resumed = SessionManager.create(tempDir.path(), tempDir.path());
		await resumed.setSessionFile(sessionFile);
		expect(await resumed.consumeDraft()).toBe("late draft");
		await resumed.saveDraft("");
		await resumed.close();

		expect(await fileExists(sessionFile)).toBe(false);
	});

	// Terminal B's draft-only rename must not republish B's stale entry list:
	// terminal A appended a real message after B read the file, and a full-body
	// rewrite from B's memory would delete it even though both writes serialize.
	it("preserves a concurrent append when a draft-only rename publishes under the lock", async () => {
		using tempDir = TempDir.createSync("@pi-session-rename-preserve-entries-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		termA.appendMessage({ role: "user", content: "real question from terminal A", timestamp: 1 });
		await termA.flush();

		await termB.setSessionName("renamed in terminal B", "user");

		const content = await Bun.file(sessionFile).text();
		expect(content).toContain("real question from terminal A");
		expect(content).toContain("renamed in terminal B");
		await termA.close();
	});

	// Terminal A materializes a draft-only session and arms its GC; terminal B
	// resumes it and consumes the sidecar, leaving `.draft-only-session` behind.
	// A third terminal C then resumes: consumeDraft finds no sidecar, so it
	// cannot re-arm cleanup, and only the marker can still hold C's first
	// durable append on the lock the stale GC terminal A takes.
	it("takes the session-file lock for the first durable append when only the marker survives", async () => {
		using tempDir = TempDir.createSync("@pi-session-marker-backed-first-append-");
		const termA = SessionManager.create(tempDir.path(), tempDir.path());
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");

		const storage = new GcOnUnlockedAppendStorage();
		storage.armGc(sessionFile);
		const termC = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		await termC.setSessionFile(sessionFile);
		expect(await termC.consumeDraft()).toBeNull();

		termC.appendMessage({ role: "user", content: "first durable entry in C", timestamp: 1 });
		await termC.flush();

		const content = await Bun.file(sessionFile).text();
		expect(parseSessionContent(content).invalidHeader).toBe(false);
		expect(content).toContain("first durable entry in C");
		await termB.close();
		await termA.close();
	});

	// A stale draft-only manager closing behind a long-running terminal must not
	// read that terminal's whole transcript to learn the conversation vetoes the
	// GC: the bounded prefix already carries the first durable entry.
	it("decides the close-time GC from a bounded prefix instead of the whole body", async () => {
		using tempDir = TempDir.createSync("@pi-session-gc-bounded-probe-");
		const storage = new RecordingDeleteStorage();
		const termA = SessionManager.create(tempDir.path(), tempDir.path(), storage);
		termA.appendModelChange("hai-proxy/anthropic--claude-4.6-opus");
		await termA.saveDraft("draft in terminal A");

		const sessionFile = termA.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file");

		const termB = SessionManager.create(tempDir.path(), tempDir.path());
		await termB.setSessionFile(sessionFile);
		expect(await termB.consumeDraft()).toBe("draft in terminal A");
		termB.appendMessage({ role: "user", content: "real question", timestamp: 1 });
		termB.appendCustomEntry("bulk", "x".repeat(2 * 1024 * 1024));
		await termB.flush();
		const fileBytes = (await Bun.file(sessionFile).stat()).size;
		expect(fileBytes).toBeGreaterThan(256 * 1024);
		await termB.close();

		await termA.close();

		expect(await fileExists(sessionFile)).toBe(true);
		expect(storage.probes.length).toBe(1);
		expect(storage.probes[0]?.complete).toBe(false);
		expect(storage.probes[0]?.bytes).toBeLessThan(fileBytes);
	});
});
