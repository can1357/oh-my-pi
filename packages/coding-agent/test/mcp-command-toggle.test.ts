import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPDroppedServer } from "@oh-my-pi/pi-coding-agent/mcp/transforms";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";
import { initTheme } from "../src/ui/theme/service";

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

function createController(builtinDrops = new Map<string, MCPDroppedServer>()) {
	const refreshMCPTools = vi.fn(async () => {});
	const connectServers = vi.fn(
		async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		}),
	);
	const mcpManager = createMcpManagerStub({ connectServers, getBuiltinDrops: () => builtinDrops });
	const ctx = createInteractiveModeContext({
		session: { refreshMCPTools },
		mcpManager,
	});
	const controller = new MCPCommandController(ctx);

	return { controller, mcpManager, refreshMCPTools, connectServers };
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

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, connectServers } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});

	test("enabling a server a built-in transform dropped records the enable and connects it", async () => {
		// Codex's config is another tool's file: the enable can only live in the
		// user allowlist, and that entry is what keeps the next discovery from
		// dropping the server again.
		const codexConfig = path.join(projectDir, ".codex", "config.toml");
		await Bun.write(codexConfig, '[mcp_servers.codex_js]\ncommand = "/opt/codex/cua_node/bin/node_repl"\n');
		const source: SourceMeta = {
			provider: "codex",
			providerName: "OpenAI Codex",
			path: codexConfig,
			level: "project",
		};
		const { controller, connectServers } = createController(
			new Map([["codex_js", { reason: "eval already runs JavaScript", source }]]),
		);

		await controller.handle("/mcp enable codex_js");

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.enabledServers).toEqual(["codex_js"]);
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(configs.codex_js).toMatchObject({ type: "stdio", command: "/opt/codex/cua_node/bin/node_repl" });
	});
});
