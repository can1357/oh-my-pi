import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { stripOuterDoubleQuotes } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

// -- helpers ----------------------------------------------------------------

import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader => typeof e === "object" && e !== null && "type" in e && (e as any).type === "session",
	) as SessionHeader | undefined;
}

function hasAssistantEntry(entries: unknown[]): boolean {
	return entries.some(
		e =>
			typeof e === "object" &&
			e !== null &&
			"type" in e &&
			(e as any).type === "message" &&
			"message" in e &&
			(e as any).message?.role === "assistant",
	);
}

// -- stripOuterDoubleQuotes tests -------------------------------------------

describe("stripOuterDoubleQuotes", () => {
	it("strips matching double quotes", () => {
		expect(stripOuterDoubleQuotes('"C:\\Users\\test"')).toBe("C:\\Users\\test");
	});
	it("strips matching double quotes from POSIX paths", () => {
		expect(stripOuterDoubleQuotes('"/home/user/test"')).toBe("/home/user/test");
	});
	it("passes through unquoted paths", () => {
		expect(stripOuterDoubleQuotes("C:\\Users\\test")).toBe("C:\\Users\\test");
	});
	it("does not strip mismatched quotes", () => {
		expect(stripOuterDoubleQuotes('"mismatched')).toBe('"mismatched');
	});
	it("does not strip single quotes", () => {
		expect(stripOuterDoubleQuotes("'foo'")).toBe("'foo'");
	});
	it("does not strip a lone double quote", () => {
		expect(stripOuterDoubleQuotes('"')).toBe('"');
	});
	it("strips empty quoted string to empty", () => {
		expect(stripOuterDoubleQuotes('""')).toBe("");
	});
});

// -- moveTo() tests ---------------------------------------------------------

describe("SessionManager.moveTo", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-move-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
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

	it("moves session file and updates header cwd (baseline)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(oldFile)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Reload and verify content
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(header?.previousSessionFiles).toEqual([path.resolve(oldFile)]);
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("persists the captured header and workspace roots after a rollback relocation", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.addWorkspaceDirectory(cwdB);
		await session.flush();
		const originalFile = session.getSessionFile()!;
		const snapshot = session.captureState();

		// Move to a target that is also an additional workspace root: moveTo
		// filters it from #additionalDirectories in the rewritten header.
		await session.moveTo(cwdB);
		await session.rollbackMove(snapshot);

		// Reopen the restored source file: disk must carry the captured header,
		// including the workspace root the forward move filtered out.
		const entries = await loadEntriesFromFile(originalFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdA));
		expect(header?.additionalDirectories ?? []).toContain(path.resolve(cwdB));
		expect(session.getCwd()).toBe(path.resolve(cwdA));
	});
	it("relocates a fallback session whose bucket matches the runtime cwd", async () => {
		const deniedDir = path.join(testAgentDir, "denied-project");
		const deniedFile = path.join(deniedDir, "session.jsonl");
		await fsp.mkdir(deniedDir);
		await Bun.write(
			deniedFile,
			`${JSON.stringify({
				type: "session",
				id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
				cwd: deniedDir,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		const realAccess = fs.promises.access.bind(fs.promises);
		const access = spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
			if (path.resolve(String(target)) === path.resolve(deniedDir)) {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realAccess(target, mode);
		});
		try {
			const session = await SessionManager.open(deniedFile, undefined, undefined, { initialCwd: cwdA });
			try {
				const snapshot = session.captureState();
				await session.moveTo(cwdA);
				const movedFile = session.getSessionFile()!;
				expect(movedFile).not.toBe(deniedFile);

				await session.rollbackMove(snapshot);

				expect(fs.existsSync(deniedFile)).toBe(true);
				expect(fs.existsSync(movedFile)).toBe(false);
				expect(session.getSessionFile()).toBe(deniedFile);
			} finally {
				await session.close();
			}
		} finally {
			access.mockRestore();
		}
	});

	it("succeeds on fresh session without ENOENT, then deferred persistence works", async () => {
		const session = SessionManager.create(cwdA);
		// No messages — file never written to disk
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		// Lazy-persist preserved: no header-only .jsonl created
		expect(fs.existsSync(newFile)).toBe(false);

		// Verify deferred persistence at the new path
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		expect(fs.existsSync(newFile)).toBe(true);
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(header?.previousSessionFiles).toBeUndefined();
	});

	it("recreates file from memory when old file is deleted (assistant exists)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.close();

		const oldFile = session.getSessionFile()!;
		// Delete the file to simulate unexpected removal
		await fsp.unlink(oldFile);
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Verify content recreated from memory
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("moves header-only session and rewrites cwd", async () => {
		// Create a header-only session via open() with a non-existent explicit path
		const explicitPath = path.join(cwdA, "explicit-session.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves header-only session with pending user message (#flushed regression)", async () => {
		// Create a header-only session
		const explicitPath = path.join(cwdA, "explicit-session-2.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		// Add a user message only — _persist() sets #flushed=false (line 1827)
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Rewrite must have run (hadSessionFile=true) even though #flushed was reset
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves artifact dir independently when session file does not exist", async () => {
		const session = SessionManager.create(cwdA);
		// Allocate an artifact — creates dir via ArtifactManager
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected artifact path");

		const oldArtifactDir = path.dirname(artifactPath);
		expect(fs.existsSync(oldArtifactDir)).toBe(true);

		// No messages — session file doesn't exist
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		// Old artifact dir moved
		expect(fs.existsSync(oldArtifactDir)).toBe(false);
		// New artifact dir exists
		const newFile = session.getSessionFile()!;
		const newArtifactDir = newFile.slice(0, -6); // strip .jsonl
		expect(fs.existsSync(newArtifactDir)).toBe(true);
	});
	it("does not orphan appends that race the session file rename", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");

		const renameFinished = Promise.withResolvers<void>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldFile)) return;
			renameFinished.resolve();
			await allowMoveToResume.promise;
		});

		try {
			const move = session.moveTo(cwdB);
			await renameFinished.promise;
			session.appendMessage({ role: "user", content: "during move", timestamp: 2 });
			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(
			entries.some(
				entry =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "during move",
			),
		).toBe(true);
	});

	it("does not orphan a flushSync that races the session file rename", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");

		const renameFinished = Promise.withResolvers<void>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldFile)) return;
			renameFinished.resolve();
			await allowMoveToResume.promise;
		});

		try {
			const move = session.moveTo(cwdB);
			await renameFinished.promise;
			// A fenced append followed by a Ctrl+C flushSync in the post-rename,
			// pre-repoint window must not recreate the old JSONL path.
			session.appendMessage({ role: "user", content: "during move", timestamp: 2 });
			session.flushSync();
			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(
			entries.some(
				entry =>
					entry.type === "message" && entry.message.role === "user" && entry.message.content === "during move",
			),
		).toBe(true);
	});

	it("does not orphan title changes that race the session file rename", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");

		const renameFinished = Promise.withResolvers<void>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldFile)) return;
			renameFinished.resolve();
			await allowMoveToResume.promise;
		});

		try {
			const move = session.moveTo(cwdB);
			await renameFinished.promise;
			await session.setSessionName("during move", "user");
			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(entries.some(entry => entry.type === "title_change" && entry.title === "during move")).toBe(true);
	});

	it("materializes an ensureOnDisk session when moveTo races the queued rewrite", async () => {
		// A header-only session (ACP session/new, drafts) forces creation via
		// ensureOnDisk(), which schedules its materializing rewrite on the disk
		// chain. Starting moveTo() before that task runs must not cancel it, or
		// the explicitly materialized session is lost and never discoverable.
		const session = SessionManager.create(cwdA);
		const ensure = session.ensureOnDisk();
		await session.moveTo(cwdB);
		await ensure;
		await session.flush();

		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		expect(fs.existsSync(movedFile)).toBe(true);

		const targetSessions = await SessionManager.list(cwdB);
		expect(targetSessions.some(item => item.path === movedFile)).toBe(true);
	});

	it("keeps post-rename fenced appends durable before trailing rewrite", async () => {
		// Crash window: session file has been renamed to dest, `#sessionFile` is
		// still the source path, and the trailing atomic rewrite has not run.
		// Completed entries appended in this window must land on dest (not recreate
		// source) and survive a crash-equivalent snapshot + reopen.
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "before move", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile();
		if (!oldFile) throw new Error("Expected session file");

		const renameFinished = Promise.withResolvers<{ dest: string }>();
		const allowMoveToResume = Promise.withResolvers<void>();
		const rename = fs.promises.rename.bind(fs.promises);
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			await rename(source, target);
			if (path.resolve(source.toString()) !== path.resolve(oldFile)) return;
			renameFinished.resolve({ dest: path.resolve(target.toString()) });
			await allowMoveToResume.promise;
		});

		let dest = "";
		try {
			const move = session.moveTo(cwdB);
			({ dest } = await renameFinished.promise);

			session.appendMessage({ role: "user", content: "during move crash window", timestamp: 2 });
			session.appendCustomEntry("tool_execution_start", {
				toolCallId: "move-call",
				toolName: "bash",
			});
			session.appendMessage({
				role: "toolResult",
				toolCallId: "move-call",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			});

			// Crash-equivalent: only dest bytes exist; source must stay absent.
			expect(fs.existsSync(oldFile)).toBe(false);
			expect(fs.existsSync(dest)).toBe(true);
			const crashBytes = fs.readFileSync(dest, "utf8");
			expect(crashBytes).toContain("during move crash window");
			expect(crashBytes).toContain('"customType":"tool_execution_start"');
			expect(crashBytes).toContain("move-call");

			const crashPath = path.join(testAgentDir, "crashed-move.jsonl");
			fs.writeFileSync(crashPath, crashBytes);
			const reopened = await SessionManager.open(crashPath);
			const reopenedEntries = reopened.getEntries();
			expect(
				reopenedEntries.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "during move crash window",
				),
			).toBe(true);
			expect(
				reopenedEntries.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolCallId === "move-call",
				),
			).toBe(true);
			expect(
				reopenedEntries.some(entry => entry.type === "custom" && entry.customType === "tool_execution_start"),
			).toBe(true);

			allowMoveToResume.resolve();
			await move;
			await session.flush();
		} finally {
			allowMoveToResume.resolve();
			renameSpy.mockRestore();
		}

		expect(fs.existsSync(oldFile)).toBe(false);
		const movedFile = session.getSessionFile();
		if (!movedFile) throw new Error("Expected moved session file");
		const entries = await loadEntriesFromFile(movedFile);
		expect(
			entries.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "during move crash window",
			),
		).toBe(true);
	});

	it("keeps the manager pointed at the moved file when the inverse relocation fails", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const snapshot = session.captureState();
		await session.moveTo(cwdB);
		const movedFile = session.getSessionFile()!;

		// Make the inverse rename fail on the rollback call.
		const moveTo = spyOn(session, "moveTo").mockRejectedValueOnce(new Error("rename denied"));
		try {
			await expect(session.rollbackMove(snapshot)).rejects.toThrow("the session file remains at");
		} finally {
			moveTo.mockRestore();
		}

		// The manager must keep pointing at the actual on-disk file so later
		// appends continue there instead of splitting the transcript.
		expect(session.getSessionFile()).toBe(movedFile);
	});
});
