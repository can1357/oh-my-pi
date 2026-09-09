import { describe, expect, it } from "bun:test";
import * as path from "node:path";
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
});
