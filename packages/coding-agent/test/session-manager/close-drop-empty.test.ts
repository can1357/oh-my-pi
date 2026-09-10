import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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

class SignalingDeleteStorage extends FileSessionStorage {
	#attemptPath: string;

	constructor(attemptPath: string) {
		super();
		this.#attemptPath = attemptPath;
	}

	override deleteSessionWithArtifactsIf(
		sessionPath: string,
		shouldDelete: (content: string) => boolean,
	): Promise<boolean> {
		fs.writeFileSync(this.#attemptPath, "");
		return super.deleteSessionWithArtifactsIf(sessionPath, shouldDelete);
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

	// Issue #11497: terminal A materializes a draft-only file and arms the GC,
	// terminal B resumes it, consumes the draft (removing the sidecar the GC
	// keys off of), and persists a real conversation. Terminal A then closes
	// with a stale draft-only in-memory view. The close-time GC must re-read the
	// file it is about to delete and keep B's transcript intact.
	it("keeps the session file when another process consumed the draft and appended real messages", async () => {
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
	});

	it("serializes a concurrent append before the close-time draft GC decision", async () => {
		using tempDir = TempDir.createSync("@pi-session-close-lock-cross-writer-");
		const deleteAttemptPath = path.join(tempDir.path(), "delete-attempted");
		const termAStorage = new SignalingDeleteStorage(deleteAttemptPath);
		const termA = SessionManager.create(tempDir.path(), tempDir.path(), termAStorage);
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
			const readiness = appender.stdout.getReader();
			const ready = await readiness.read();
			readiness.releaseLock();
			expect(new TextDecoder().decode(ready.value)).toContain("ready");

			// The child owns the session lock until A reaches the competing
			// inspect-and-delete operation, then appends before handing it over.
			await termA.close();
			expect(await appender.exited).toBe(0);
			expect(await fileExists(sessionFile)).toBe(true);
			expect(await Bun.file(sessionFile).text()).toContain("real question from terminal B");
			await termB.close();
		} finally {
			if (appender.exitCode === null) {
				appender.kill();
				await appender.exited;
			}
		}
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
});
