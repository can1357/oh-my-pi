import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, getTerminalSessionsDir, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader =>
			typeof e === "object" && e !== null && "type" in e && (e as { type: unknown }).type === "session",
	);
}

function writeBreadcrumb(cwd: string, sessionFile: string): string {
	const terminalId = getTerminalId();
	if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
	const dir = getTerminalSessionsDir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, terminalId);
	fs.writeFileSync(file, `${cwd}\n${sessionFile}\n`);
	return file;
}

function stripHeaderCwd(file: string): void {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const rewritten = lines.map(line => {
		if (!line.trim()) return line;
		const obj = JSON.parse(line) as { type?: string; cwd?: unknown };
		if (obj.type === "session") delete obj.cwd;
		return JSON.stringify(obj);
	});
	fs.writeFileSync(file, rewritten.join("\n"));
}

describe("SessionManager.continueRecent relocation", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		// Force a deterministic, non-TTY terminal id so breadcrumb read/write is stable.
		process.env.TMUX_PANE = "%relocation-test";
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-reloc-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "worktree-old");
		cwdB = path.join(testAgentDir, "worktree-new");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("re-roots the terminal's session when its directory was moved/renamed", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		// Breadcrumb points at the old session, recorded under the old cwd.
		writeBreadcrumb(cwdA, oldFile);
		// Simulate `git worktree move`: the old directory no longer exists.
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			// The relocated session is adopted, not discarded for a fresh one.
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			const newFile = resumed.getSessionFile();
			if (!newFile) throw new Error("Expected re-rooted session file");
			expect(newFile).not.toBe(oldFile);
			expect(fs.existsSync(oldFile)).toBe(false);

			const entries = await loadEntriesFromFile(newFile);
			expect(getHeader(entries)?.cwd).toBe(path.resolve(cwdB));
			const userMessages = entries.filter(e => e.type === "message" && e.message.role === "user");
			expect(userMessages).toHaveLength(1);
		} finally {
			await resumed.close();
		}
	});

	it("does not hijack the session when the recorded directory still exists (plain cd)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "other project", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		// Breadcrumb from a still-existing different project; user just cd'd elsewhere.
		writeBreadcrumb(cwdA, oldFile);

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			// Old project's session is left untouched; a fresh session starts in cwdB.
			expect(fs.existsSync(oldFile)).toBe(true);
			expect(resumed.getSessionFile()).not.toBe(oldFile);
			expect(resumed.getEntries()).toHaveLength(0);
		} finally {
			await resumed.close();
		}
	});

	it("does not re-root when the new directory already has its own sessions", async () => {
		const moved = SessionManager.create(cwdA);
		moved.appendMessage({ role: "user", content: "moved", timestamp: 1 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted session file");
		await moved.close();

		// cwdB already owns a local session.
		const local = SessionManager.create(cwdB);
		local.appendMessage({ role: "user", content: "local", timestamp: 2 });
		local.appendMessage(makeAssistantMessage());
		await local.flush();
		const localFile = local.getSessionFile();
		if (!localFile) throw new Error("Expected persisted local session file");
		await local.close();

		writeBreadcrumb(cwdA, movedFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB);
		try {
			// Prefer cwdB's own recent session over re-rooting the moved one.
			expect(resumed.getSessionFile()).toBe(localFile);
			expect(fs.existsSync(movedFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("moves a relocated breadcrumb session into an explicit sessionDir", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "explicit dir", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		await session.close();

		const explicitSessionDir = path.join(testAgentDir, "custom-sessions");
		writeBreadcrumb(cwdA, oldFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			const newFile = resumed.getSessionFile();
			if (!newFile) throw new Error("Expected re-rooted session file");
			expect(path.dirname(newFile)).toBe(path.resolve(explicitSessionDir));
			expect(fs.existsSync(oldFile)).toBe(false);
			expect(getHeader(await loadEntriesFromFile(newFile))?.cwd).toBe(path.resolve(cwdB));
		} finally {
			await resumed.close();
		}
	});

	it("re-roots when the stale breadcrumb file is already in the explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "shared-custom-sessions");
		const session = SessionManager.create(cwdA, explicitSessionDir);
		session.appendMessage({ role: "user", content: "same explicit dir", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		expect(path.dirname(oldFile)).toBe(path.resolve(explicitSessionDir));
		await session.close();

		writeBreadcrumb(cwdA, oldFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			const newFile = resumed.getSessionFile();
			if (!newFile) throw new Error("Expected re-rooted session file");
			expect(newFile).toBe(oldFile);
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			expect(getHeader(await loadEntriesFromFile(newFile))?.cwd).toBe(path.resolve(cwdB));
		} finally {
			await resumed.close();
		}
	});

	it("prefers an existing current-cwd session in a shared explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "shared-current-sessions");
		const local = SessionManager.create(cwdB, explicitSessionDir);
		local.appendMessage({ role: "user", content: "local current cwd", timestamp: 1 });
		local.appendMessage(makeAssistantMessage());
		await local.flush();
		const localFile = local.getSessionFile();
		if (!localFile) throw new Error("Expected persisted local session file");
		await local.close();

		// Ensure the stale moved session is newer than the local current-cwd session.
		await new Promise(resolve => setTimeout(resolve, 20));
		const moved = SessionManager.create(cwdA, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "newer stale moved cwd", timestamp: 2 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted moved session file");
		await moved.close();

		writeBreadcrumb(cwdA, movedFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			expect(resumed.getSessionFile()).toBe(localFile);
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			expect(fs.existsSync(movedFile)).toBe(true);
		} finally {
			await resumed.close();
		}
	});

	it("re-roots past a cwd-less legacy session in a shared explicit sessionDir", async () => {
		const explicitSessionDir = path.join(testAgentDir, "shared-legacy-sessions");
		const legacy = SessionManager.create(cwdB, explicitSessionDir);
		legacy.appendMessage({ role: "user", content: "legacy without cwd", timestamp: 1 });
		legacy.appendMessage(makeAssistantMessage());
		await legacy.flush();
		const legacyFile = legacy.getSessionFile();
		if (!legacyFile) throw new Error("Expected persisted legacy session file");
		await legacy.close();
		stripHeaderCwd(legacyFile);

		// Ensure the stale moved session is newer than the cwd-less legacy session.
		await new Promise(resolve => setTimeout(resolve, 20));
		const moved = SessionManager.create(cwdA, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "newer stale moved cwd", timestamp: 2 });
		moved.appendMessage(makeAssistantMessage());
		await moved.flush();
		const movedFile = moved.getSessionFile();
		if (!movedFile) throw new Error("Expected persisted moved session file");
		await moved.close();

		writeBreadcrumb(cwdA, movedFile);
		await fsp.rm(cwdA, { recursive: true, force: true });

		const resumed = await SessionManager.continueRecent(cwdB, explicitSessionDir);
		try {
			// The moved session is re-rooted; the cwd-less legacy session is not hijacked.
			expect(resumed.getSessionFile()).toBe(movedFile);
			expect(resumed.getCwd()).toBe(path.resolve(cwdB));
			expect(fs.existsSync(legacyFile)).toBe(true);
			expect(getHeader(await loadEntriesFromFile(movedFile))?.cwd).toBe(path.resolve(cwdB));
		} finally {
			await resumed.close();
		}
	});
});
