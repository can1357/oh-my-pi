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
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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

	test("refreshes custom-agent-dir watchdogs through interactive /reload-plugins", async () => {
		const agentDir = path.join(projectDir, "custom-agent");
		const agentFile = path.join(agentDir, "agents", "worker.md");
		await fs.mkdir(path.dirname(agentFile), { recursive: true });
		const definition = (name: string) =>
			`---\nname: sdk-watchdog-worker\ndescription: Custom directory worker\nwatchdogs:\n  - id: review\n    name: ${name}\n    instructions: Review the assigned work.\n---\nPerform the assigned work.\n`;
		await fs.writeFile(agentFile, definition("VERSION_ONE"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		const authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		let session: AgentSession | undefined;
		try {
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
			});
			settings.setModelRole("advisor", `${model.provider}/${model.id}`);
			const result = await createAgentSession({
				cwd: projectDir,
				agentDir,
				agentName: "sdk-watchdog-worker",
				sessionManager: SessionManager.inMemory(projectDir),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				workspaceTree: {
					rootPath: projectDir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			session = result.session;
			expect(session.getAdvisorStats().advisors.map(advisor => advisor.name)).toEqual(["VERSION_ONE"]);

			await fs.writeFile(agentFile, definition("VERSION_TWO"));
			const ctx = {
				mcpManager: undefined,
				session,
				sessionManager: session.sessionManager,
				settings,
				refreshSkillState: (refreshAgents?: boolean) => session!.refreshSkills(refreshAgents),
				refreshSlashCommandState: async () => {},
				showStatus: () => {},
				editor: { setText: () => {} },
			} as unknown as InteractiveModeContext;

			await executeBuiltinSlashCommand("/reload-plugins", { ctx });

			expect(session.getAdvisorStats().advisors.map(advisor => advisor.name)).toEqual(["VERSION_TWO"]);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});
});
