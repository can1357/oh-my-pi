import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { listAllSessions, resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getConfigRootDir, refreshDirsFromEnv, setAgentDir } from "@oh-my-pi/pi-utils";

let tempDir: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const storage = new FileSessionStorage();

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-resume-command-"));
	setAgentDir(path.join(tempDir, "agent"));
});

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeSession(
	id: string,
	cwd = tempDir,
	sessionDir = computeDefaultSessionDir(cwd, storage),
): Promise<string> {
	const sessionPath = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	await Bun.write(
		sessionPath,
		`${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
	);
	return sessionPath;
}

function createRuntime(cwd = tempDir, sessionDir = tempDir) {
	const showSessionSelector = vi.fn();
	const handleResumeSession = vi.fn(async () => {});
	const showError = vi.fn();
	const setText = vi.fn();
	return {
		showSessionSelector,
		handleResumeSession,
		showError,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showSessionSelector,
				handleResumeSession,
				showError,
				sessionManager: {
					getCwd: () => cwd,
					getSessionDir: () => sessionDir,
				},
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/resume slash command", () => {
	it("opens the session selector without an argument", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/resume", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showSessionSelector).toHaveBeenCalled();
		expect(harness.handleResumeSession).not.toHaveBeenCalled();
	});

	it("opens foreign session selectors for @claude and @codex", async () => {
		const sources: Array<{ argument: string; source: "claude" | "codex" }> = [
			{ argument: "@claude", source: "claude" },
			{ argument: "@codex", source: "codex" },
		];
		for (const { argument, source } of sources) {
			const harness = createRuntime();

			const handled = await executeBuiltinSlashCommand(`/resume ${argument}`, harness.runtime);

			expect(handled).toBe(true);
			expect(harness.showSessionSelector).toHaveBeenCalledWith(source);
			expect(harness.handleResumeSession).not.toHaveBeenCalled();
			expect(harness.showError).not.toHaveBeenCalled();
		}
	});

	it("resumes a matching session id prefix", async () => {
		const sessionPath = await writeSession("019ed676-02fb-7000-8dac-396e2f84d484");
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/resume 019ed676", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showSessionSelector).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.handleResumeSession).toHaveBeenCalledWith(sessionPath);
	});

	it("checks the active session directory before global cwd buckets", async () => {
		const currentCwd = path.join(tempDir, "current");
		const customSessionDir = path.join(tempDir, "custom-sessions");
		await fs.mkdir(currentCwd, { recursive: true });
		const sessionPath = await writeSession("019ed699-02fb-7000-8dac-396e2f84d484", currentCwd, customSessionDir);
		const harness = createRuntime(currentCwd, customSessionDir);

		const handled = await executeBuiltinSlashCommand("/resume 019ed699", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.handleResumeSession).toHaveBeenCalledWith(sessionPath);
	});

	it("resumes a matching session id prefix from another cwd", async () => {
		const currentCwd = path.join(tempDir, "current");
		const otherCwd = path.join(tempDir, "other");
		await fs.mkdir(currentCwd, { recursive: true });
		await fs.mkdir(otherCwd, { recursive: true });
		const currentSessionDir = computeDefaultSessionDir(currentCwd, storage);
		const otherSessionDir = computeDefaultSessionDir(otherCwd, storage);
		const sessionPath = await writeSession("019ed777-02fb-7000-8dac-396e2f84d484", otherCwd, otherSessionDir);
		const harness = createRuntime(currentCwd, currentSessionDir);

		const handled = await executeBuiltinSlashCommand("/resume 019ed777", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.handleResumeSession).toHaveBeenCalledWith(sessionPath);
	});

	it("keeps explicit session directories scoped unless global fallback is enabled", async () => {
		const currentCwd = path.join(tempDir, "current");
		const otherCwd = path.join(tempDir, "other");
		const customSessionDir = path.join(tempDir, "custom-sessions");
		await fs.mkdir(currentCwd, { recursive: true });
		await fs.mkdir(otherCwd, { recursive: true });
		const otherSessionDir = computeDefaultSessionDir(otherCwd, storage);
		const sessionPath = await writeSession("019ed888-02fb-7000-8dac-396e2f84d484", otherCwd, otherSessionDir);

		const scoped = await resolveResumableSession("019ed888", currentCwd, customSessionDir);
		const fallback = await resolveResumableSession("019ed888", currentCwd, customSessionDir, {
			allowGlobalFallback: true,
		});

		expect(scoped).toBeUndefined();
		expect(fallback?.scope).toBe("global");
		expect(fallback?.session.path).toBe(sessionPath);
	});

	it("shows an error when no session id matches", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/resume missing-session", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showError).toHaveBeenCalledWith('Session "missing-session" not found');
		expect(harness.handleResumeSession).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("lists and resumes sessions stored in XDG_DATA_HOME", async () => {
		const xdgDataDir = path.join(tempDir, "xdg-data");
		const xdgOmpDir = path.join(xdgDataDir, "omp");
		await fs.mkdir(xdgOmpDir, { recursive: true });

		const originalXdgData = process.env.XDG_DATA_HOME;
		const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		process.env.XDG_DATA_HOME = xdgDataDir;
		refreshDirsFromEnv();

		try {
			const projA = path.join(tempDir, "projA");
			const projB = path.join(tempDir, "projB");
			await fs.mkdir(projA, { recursive: true });
			await fs.mkdir(projB, { recursive: true });

			const sessionDirA = computeDefaultSessionDir(projA, storage);
			const sessionPathA = await writeSession("019ed999-02fb-7000-8dac-396e2f84d484", projA, sessionDirA);

			expect(sessionPathA.startsWith(xdgOmpDir)).toBe(true);

			const allSessions = await listAllSessions(storage);
			expect(allSessions.some(s => s.id === "019ed999-02fb-7000-8dac-396e2f84d484")).toBe(true);

			const harness = createRuntime(projB);
			const handled = await executeBuiltinSlashCommand("/resume 019ed999", harness.runtime);
			expect(handled).toBe(true);
			expect(harness.showError).not.toHaveBeenCalled();
			expect(harness.handleResumeSession).toHaveBeenCalledWith(sessionPathA);
		} finally {
			if (originalXdgData !== undefined) process.env.XDG_DATA_HOME = originalXdgData;
			else delete process.env.XDG_DATA_HOME;
			if (originalPiCodingAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
			refreshDirsFromEnv();
		}
	});
});
