/**
 * Regressions for `/reload-plugins` runtime surfaces that must update without a
 * process restart: MCP reconnect/rebinding (#7189) and task-agent descriptions
 * published to existing tools (#7940).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const TEST_EXTENSION_ROOTS: EffectiveExtensionRoots = {
	explicit: [],
	mode: "merge",
	configured: [],
	configuredLevel: "user",
};

function agentDefinition(description: string): string {
	return `---\nname: reload-agent\ndescription: ${description}\n---\nReload agent.\n`;
}

function createTaskSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		effectiveExtensionRoots: () => TEST_EXTENSION_ROOTS,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function createFakeCtx(cwd: string, settingsValues: Record<string, unknown> = {}) {
	const mcpTools = [{ name: "mcp__srv_do" }];
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({ errors: new Map<string, string>() })),
		getTools: vi.fn(() => mcpTools),
	};
	const session = {
		effectiveExtensionRoots: TEST_EXTENSION_ROOTS,
		getEvalPreludes: () => [],
		refreshMCPTools: vi.fn(async (_tools: unknown) => {}),
		setMCPPromptCommands: vi.fn((_commands: unknown) => {}),
	};
	const ctx = {
		mcpManager,
		session,
		sessionManager: { getCwd: () => cwd },
		settings: { get: (key: string): unknown => settingsValues[key] },
		refreshSkillState: vi.fn(async () => {}),
		refreshSlashCommandState: vi.fn(async () => {}),
		showStatus: vi.fn(() => {}),
		editor: { setText: vi.fn(() => {}) },
	} as never as InteractiveModeContext;
	return { ctx, mcpManager, session, mcpTools };
}

describe("/reload-plugins runtime refresh", () => {
	let projectDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reload-plugins-mcp-"));
		setProjectDir(projectDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		await removeWithRetries(projectDir);
	});

	test("reconnects MCP servers, rebinds tools, and clears stale prompt commands", async () => {
		const { ctx, mcpManager, session, mcpTools } = createFakeCtx(projectDir);
		const runtime: TuiSlashCommandRuntime = { ctx };

		const result = await executeBuiltinSlashCommand("/reload-plugins", runtime);
		expect(result).toBe(true);
		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledWith(mcpTools);
		expect(session.setMCPPromptCommands).toHaveBeenCalledTimes(1);
		expect(session.setMCPPromptCommands).toHaveBeenCalledWith([]);
	});

	test("honors mcp.enableProjectConfig=false so opted-out project servers are not started on reload", async () => {
		const { ctx, mcpManager } = createFakeCtx(projectDir, { "mcp.enableProjectConfig": false });
		const runtime: TuiSlashCommandRuntime = { ctx };

		await executeBuiltinSlashCommand("/reload-plugins", runtime);

		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledWith(
			expect.objectContaining({ enableProjectConfig: false }),
		);
	});

	test("republishes edited agents to an existing task tool", async () => {
		const agentDir = path.join(projectDir, ".omp", "agents");
		const agentFile = path.join(agentDir, "reload-agent.md");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(agentFile, agentDefinition("VERSION_ONE"));
		const taskTool = await TaskTool.create(createTaskSession(projectDir));
		expect(taskTool.description).toContain("VERSION_ONE");

		await Bun.write(agentFile, agentDefinition("VERSION_TWO"));
		const { ctx } = createFakeCtx(projectDir);
		const runtime: TuiSlashCommandRuntime = { ctx };
		await executeBuiltinSlashCommand("/reload-plugins", runtime);

		expect(taskTool.description).toContain("VERSION_TWO");
		expect(taskTool.description).not.toContain("VERSION_ONE");
	});
});
