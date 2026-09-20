import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { computeDefaultSessionDir } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { loadPinnedSessionIds } from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";

let tempDir: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const storage = new FileSessionStorage();

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pin-command-"));
	setAgentDir(path.join(tempDir, "agent"));
});

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
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

function createRuntime(activeSessionId?: string, cwd = tempDir, sessionDir = tempDir) {
	const showStatus = vi.fn();
	const setText = vi.fn();
	return {
		showStatus,
		setText,
		ctx: {
			showStatus,
			editor: {
				setText,
			},
			sessionManager: {
				getCwd: () => cwd,
				getSessionDir: () => sessionDir,
				getSessionId: () => activeSessionId ?? "",
			},
		} as unknown as InteractiveModeContext,
	};
}

describe("/pin slash command", () => {
	it("toggles pin for the active session when invoked without arguments", async () => {
		const activeId = "active-session-123";
		const runtime = createRuntime(activeId);

		// First invocation pins the session
		const handled1 = await executeBuiltinSlashCommand("/pin", runtime);
		expect(handled1).toBe(true);
		expect(runtime.showStatus).toHaveBeenCalledWith("Session pinned to the top of the resume list.");

		let pins = await loadPinnedSessionIds(path.join(tempDir, "agent"));
		expect(pins.has(activeId)).toBe(true);

		// Second invocation unpins the session
		const handled2 = await executeBuiltinSlashCommand("/pin", runtime);
		expect(handled2).toBe(true);
		expect(runtime.showStatus).toHaveBeenCalledWith("Session unpinned.");

		pins = await loadPinnedSessionIds(path.join(tempDir, "agent"));
		expect(pins.has(activeId)).toBe(false);
	});

	it("shows usage error when invoked without active session and no args", async () => {
		const runtime = createRuntime("");
		const handled = await executeBuiltinSlashCommand("/pin", runtime);
		expect(handled).toBe(true);
		expect(runtime.showStatus).toHaveBeenCalledWith("No active session to pin.");
	});

	it("pins a specific session by id or prefix", async () => {
		const targetId = "target-session-456";
		const sessionDir = computeDefaultSessionDir(tempDir, storage);
		await writeSession(targetId, tempDir, sessionDir);

		const runtime = createRuntime("active-session-123", tempDir, sessionDir);
		const handled = await executeBuiltinSlashCommand(`/pin ${targetId.slice(0, 10)}`, runtime);
		expect(handled).toBe(true);
		expect(runtime.showStatus).toHaveBeenCalledWith("Session pinned to the top of the resume list.");

		const pins = await loadPinnedSessionIds(path.join(tempDir, "agent"));
		expect(pins.has(targetId)).toBe(true);
	});

	it("shows error for unknown session argument", async () => {
		const runtime = createRuntime("active-session-123");
		const handled = await executeBuiltinSlashCommand("/pin nonexistent-session-xyz", runtime);
		expect(handled).toBe(true);
		expect(runtime.showStatus).toHaveBeenCalledWith('Session "nonexistent-session-xyz" not found.');
	});
});
