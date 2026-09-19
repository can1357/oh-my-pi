import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runConfigCommand } from "@oh-my-pi/pi-coding-agent/cli/config-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let testAgentDir: TempDir | undefined;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(() => {
	resetSettingsForTest();
	testAgentDir = TempDir.createSync("@omp-config-modelroles-");
	setAgentDir(testAgentDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	AgentStorage.resetInstance();
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		try {
			await testAgentDir.remove();
		} catch {}
		testAgentDir = undefined;
	}
});

async function readModelRoles(): Promise<Record<string, string>> {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await runConfigCommand({ action: "get", key: "modelRoles", flags: { json: true } });
		const payload = logSpy.mock.calls.at(-1)?.[0];
		const parsed = JSON.parse(String(payload)) as { value: Record<string, string> };
		return parsed.value;
	} finally {
		logSpy.mockRestore();
	}
}

describe("config set modelRoles safety", () => {
	it("patches named roles without deleting unrelated roles", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "modelRoles",
			value: '{"default":"anthropic/claude-opus-4-6","task":"meta/worker-old","smol":"openai/gpt-small"}',
			flags: { json: true },
		});
		vi.restoreAllMocks();

		vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "modelRoles",
			value: '{"task":"meta/worker-new"}',
			flags: { json: true },
		});
		vi.restoreAllMocks();

		const roles = await readModelRoles();
		expect(roles.default).toBe("anthropic/claude-opus-4-6");
		expect(roles.task).toBe("meta/worker-new");
		expect(roles.smol).toBe("openai/gpt-small");
	});

	it("validates the whole patch before mutating any role", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "modelRoles",
			value: '{"default":"anthropic/claude-opus-4-6","task":"meta/worker-old","smol":"openai/gpt-small"}',
			flags: { json: true },
		});
		vi.restoreAllMocks();
		const before = await readModelRoles();

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as typeof process.exit);

		await expect(
			runConfigCommand({
				action: "set",
				key: "modelRoles",
				value: '{"task":"meta/worker-new","smol":17}',
				flags: { json: true },
			}),
		).rejects.toThrow("process.exit");
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid model role value for smol"));
		vi.restoreAllMocks();

		const after = await readModelRoles();
		expect(after).toEqual(before);
	});

	it("normalizes valid role values before persisting", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		await runConfigCommand({
			action: "set",
			key: "modelRoles",
			value: '{"task":"  @slow  "}',
			flags: { json: true },
		});
		vi.restoreAllMocks();

		const roles = await readModelRoles();
		expect(roles.task).toBe("@slow");
	});
});
