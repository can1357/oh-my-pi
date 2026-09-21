import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { createMCPActionRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-action-runtime";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createMcpManagerStub } from "./helpers/interactive-mode-context";

const CONFIG = { type: "http" as const, url: "https://mcp.example.com/mcp" };
const AUTH_STORAGE = { get: () => undefined } as unknown as AuthStorage;

describe("extensions dashboard MCP actions", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	let settings: Settings;

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dashboard-actions-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dashboard-actions-user-"));
		setAgentDir(agentDir);
		configPath = path.join(projectDir, ".omp", "mcp.json");
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await Bun.write(configPath, `${JSON.stringify({ mcpServers: { github: CONFIG } }, null, 2)}\n`);
		await Bun.write(path.join(agentDir, "mcp.json"), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
		settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("shows live status and reconnects through the active MCP manager", async () => {
		const tools = [{ name: "search", inputSchema: { type: "object" as const } }];
		const connection = {
			name: "github",
			config: CONFIG,
			transport: { connected: true, request: vi.fn(), notify: vi.fn(), close: vi.fn() },
			serverInfo: { name: "github", version: "1.0" },
			capabilities: { tools: {} },
			tools,
		} as unknown as MCPServerConnection;
		let retainedConfig = true;
		const disconnectServer = vi.fn(async () => {
			retainedConfig = false;
		});
		const reconnectServer = vi.fn(async () => (retainedConfig ? connection : null));
		const refreshTools = vi.fn(async () => {});
		const manager = createMcpManagerStub({
			getConnectionStatus: vi.fn(() => "connected" as const),
			getConnection: vi.fn(() => connection),
			getSource: vi.fn(() => ({
				provider: "native",
				providerName: "Native",
				level: "project" as const,
				path: configPath,
			})),
			getServerConfig: vi.fn(() => CONFIG),
			getServerResources: vi.fn(() => ({ resources: [{ uri: "resource://one", name: "one" }], templates: [] })),
			getServerPrompts: vi.fn(() => [{ name: "prompt" }]),
			getLastConnectionError: vi.fn(() => undefined),
			disconnectServer,
			reconnectServer,
			getTools: vi.fn(() => []),
		});
		const runtime = createMCPActionRuntime({
			cwd: projectDir,
			settings,
			mcpManager: manager,
			authStorage: AUTH_STORAGE,
			onMcpToolsChanged: refreshTools,
		});
		const extension = (await loadAllExtensions(projectDir, [])).find(item => item.id === "mcp:github");
		expect(extension).toBeDefined();

		const state = await runtime.loadState(extension!);
		expect(state.connectionStatus).toBe("connected");
		expect(state.tools).toBe(1);
		expect(state.prompts).toBe(1);
		expect(state.resources).toBe(1);
		expect(state.actions.find(action => action.id === "reconnect")?.enabled).toBe(true);

		const progress: string[] = [];
		const message = await runtime.runAction(extension!, "reconnect", {
			signal: new AbortController().signal,
			onProgress: value => progress.push(value),
			onAuthorization: () => {},
			requestManualInput: async () => "",
		});
		expect(message).toBe("Reconnected. 1 tool(s) available.");
		expect(progress).toEqual(["Reconnecting github..."]);
		expect(reconnectServer).toHaveBeenCalledWith("github", { manual: true });
		expect(refreshTools).toHaveBeenCalledTimes(1);
	});
});
