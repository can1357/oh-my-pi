import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { resolveResumableSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-listing";
import { computeDefaultSessionDir } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-storage";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import { getConfigRootDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";

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
});
