import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

function createController() {
	const refreshMCPTools = vi.fn(async () => {});
	const connectServers = vi.fn(
		async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		}),
	);
	const mcpManager = createMcpManagerStub({ connectServers });
	const ctx = createInteractiveModeContext({
		session: { refreshMCPTools },
		mcpManager,
	});
	const controller = new MCPCommandController(ctx);

	return { controller, ctx, mcpManager, refreshMCPTools, connectServers };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("disabling a configured server uses the shared reload lifecycle", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		const config = JSON.parse(await Bun.file(getMCPConfigPath("project", projectDir)).text());
		expect(config.mcpServers.mcp1.enabled).toBe(false);
	});

	test("enabling a configured server reports success only after the shared reload", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		const config = JSON.parse(await Bun.file(getMCPConfigPath("project", projectDir)).text());
		expect(config.mcpServers.mcp1.enabled).toBe(true);
	});

	test("does not report enable success when the shared reload fails", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
		});
		const { controller, ctx, mcpManager } = createController();
		vi.spyOn(mcpManager, "discoverAndConnect").mockRejectedValueOnce(new Error("reload failed"));

		await controller.handle("/mcp enable mcp1");

		expect(ctx.showError).toHaveBeenCalledWith("Failed to enable server: reload failed");
		const output = ctx.chatContainer.render(120).join("\n");
		expect(output).not.toContain("mcp1 enabled.");
	});
	test("reconciles profile lists when a disabled foreign server is absent from manager state", async () => {
		await writeProjectConfig(projectDir, {});
		await Bun.write(
			getMCPConfigPath("user", projectDir),
			`${JSON.stringify({ mcpServers: {}, disabledServers: ["foreign"] }, null, 2)}\n`,
		);
		const mcpManager = createMcpManagerStub({
			getSource: vi.fn(() => undefined),
			getServerConfig: vi.fn(() => undefined),
		});
		const ctx = createInteractiveModeContext({ mcpManager, session: { refreshMCPTools: vi.fn(async () => {}) } });
		const controller = new MCPCommandController(ctx);

		await controller.handle("/mcp enable foreign");
		let userConfig = JSON.parse(await Bun.file(getMCPConfigPath("user", projectDir)).text());
		expect(userConfig.disabledServers).toBeUndefined();
		expect(userConfig.enabledServers).toEqual(["foreign"]);

		await controller.handle("/mcp disable foreign");
		userConfig = JSON.parse(await Bun.file(getMCPConfigPath("user", projectDir)).text());
		expect(userConfig.enabledServers).toBeUndefined();
		expect(userConfig.disabledServers).toEqual(["foreign"]);
	});
});
