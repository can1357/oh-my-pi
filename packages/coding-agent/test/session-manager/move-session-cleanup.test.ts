import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupEmptyMoveSession, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

describe("move-session cleanup tracking", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-cleanup-"));
		setAgentDir(testAgentDir);
		cwd = path.join(testAgentDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
	});
	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("does not delete an empty session file without the owning move marker", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);

		await cleanupEmptyMoveSession(manager, undefined);

		expect(fs.existsSync(file)).toBe(true);
		await manager.dropSession(file);
	});

	it("createEmptySessionFile + cleanupEmptyMoveSession deletes an empty move session file", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);
		expect(fs.existsSync(file)).toBe(true);

		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);

		// The session has no real messages — just the header.
		const entries = manager.getEntries();
		const hasRealMessages = entries.some(
			e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
		expect(hasRealMessages).toBe(false);

		await cleanupEmptyMoveSession(manager, file);
		expect(fs.existsSync(file)).toBe(false);
	});

	it("a move session that received real messages is NOT deleted", async () => {
		const file = SessionManager.createEmptySessionFile(cwd);

		const manager = SessionManager.create(cwd);
		await manager.setSessionFile(file);
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();

		// The session now has real messages — it should survive.
		const entries = manager.getEntries();
		const hasRealMessages = entries.some(
			e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
		);
		expect(hasRealMessages).toBe(true);

		await cleanupEmptyMoveSession(manager, file);
		expect(fs.existsSync(file)).toBe(true);
		await manager.dropSession(file);
	});
});
