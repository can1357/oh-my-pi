import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { createMCPActionRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-action-runtime";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { MCPServerActions } from "@oh-my-pi/pi-coding-agent/mcp/server-actions";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createMcpManagerStub } from "./helpers/interactive-mode-context";

const CONFIG = { type: "http" as const, url: "https://mcp.example.com/mcp" };
const AUTH_STORAGE = { credentials: { get: () => undefined } } as unknown as AuthStorage;

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
		expect(reconnectServer).toHaveBeenCalledWith("github", {
			manual: true,
			signal: expect.any(AbortSignal),
		});
		expect(refreshTools).toHaveBeenCalledTimes(1);
	});

	test("test action probes a connected server instead of trusting cached tools", async () => {
		const request = vi.fn(async (_method: string) => ({}));
		const connection = {
			name: "github",
			config: CONFIG,
			transport: { connected: true, request, notify: vi.fn(), close: vi.fn() },
			serverInfo: { name: "github", version: "1.0" },
			capabilities: { tools: {} },
			tools: [{ name: "search", inputSchema: { type: "object" as const } }],
		} as unknown as MCPServerConnection;
		const manager = createMcpManagerStub({
			getConnectionStatus: vi.fn(() => "connected" as const),
			getConnection: vi.fn(() => connection),
		});
		const actions = new MCPServerActions({
			cwd: projectDir,
			manager,
			authStorage: AUTH_STORAGE,
			refreshMCPTools: async () => {},
		});
		const target = { name: "github", config: CONFIG };

		await expect(actions.test(target)).resolves.toMatchObject({ message: "Connected. 1 tool(s) available." });
		expect(request).toHaveBeenCalledWith("ping", {}, { signal: expect.any(AbortSignal) });

		request.mockRejectedValueOnce(new Error("MCP error -32601: Method not found"));
		await expect(actions.test(target)).resolves.toMatchObject({ action: "test" });

		request.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
		await expect(actions.test(target)).rejects.toThrow("ECONNREFUSED");
	});

	test("completes enable and disable persistence without a runtime manager", async () => {
		const actions = new MCPServerActions({ cwd: projectDir, refreshMCPTools: async () => {} });
		const source = { provider: "omp", providerName: "OMP", path: configPath, level: "project" as const };

		await expect(actions.setEnabled({ name: "github", source }, false)).resolves.toMatchObject({ action: "disable" });
		let saved = JSON.parse(await Bun.file(configPath).text());
		expect(saved.mcpServers.github.enabled).toBe(false);

		await expect(actions.setEnabled({ name: "github", source }, true)).resolves.toMatchObject({ action: "enable" });
		saved = JSON.parse(await Bun.file(configPath).text());
		expect(saved.mcpServers.github.enabled).toBe(true);
	});

	test("completes clear authentication without a runtime manager", async () => {
		const credentialId = mcpOAuthCredentialId(CONFIG.url);
		let credential: { type: "oauth" } | undefined = { type: "oauth" };
		const authStorage = {
			credentials: {
				get: (id: string) => (id === credentialId ? credential : undefined),
				remove: vi.fn(async (id: string) => {
					if (id === credentialId) credential = undefined;
				}),
			},
		} as unknown as AuthStorage;
		const config = {
			...CONFIG,
			auth: { type: "oauth" as const, credentialId, tokenUrl: "https://auth.example.com/token" },
		};
		await Bun.write(configPath, `${JSON.stringify({ mcpServers: { github: config } }, null, 2)}\n`);
		const actions = new MCPServerActions({
			cwd: projectDir,
			authStorage,
			refreshMCPTools: async () => {},
		});

		await expect(
			actions.clearAuthentication({
				name: "github",
				config,
				source: { provider: "omp", providerName: "OMP", path: configPath, level: "project" },
			}),
		).resolves.toMatchObject({ action: "clear-authentication" });
		expect(credential).toBeUndefined();
		const saved = JSON.parse(await Bun.file(configPath).text());
		expect(saved.mcpServers.github.auth).toBeUndefined();
	});

	test("refuses to connect project servers when project MCP config is disabled", async () => {
		const actions = new MCPServerActions({
			cwd: projectDir,
			authStorage: AUTH_STORAGE,
			enableProjectConfig: false,
			refreshMCPTools: async () => {},
		});
		// If the gate were bypassed, the probe would try to spawn this command and
		// fail with a spawn error instead of the policy message.
		const target = {
			name: "repo-tool",
			config: { type: "stdio" as const, command: path.join(projectDir, "must-not-run") },
			source: { provider: "omp", providerName: "OMP", path: configPath, level: "project" as const },
		};
		await expect(actions.test(target)).rejects.toThrow("mcp.enableProjectConfig");

		await Bun.write(configPath, `${JSON.stringify({ mcpServers: { github: CONFIG } }, null, 2)}\n`);
		cfgMcpEnableProjectConfig.set(settings, false);
		const runtime = createMCPActionRuntime({ cwd: projectDir, settings, authStorage: AUTH_STORAGE });
		const extension = (await loadAllExtensions(projectDir, [])).find(item => item.id === "mcp:github");
		const state = await runtime.loadState(extension!);
		for (const id of ["test", "reauthenticate"] as const) {
			expect(state.actions.find(item => item.id === id)).toMatchObject({
				enabled: false,
				disabledReason: expect.stringContaining("mcp.enableProjectConfig"),
			});
		}
	});

	test("clearing authentication from the dashboard keeps env placeholders in the config file", async () => {
		const credentialId = mcpOAuthCredentialId(CONFIG.url);
		let credential: { type: "oauth" } | undefined = { type: "oauth" };
		const authStorage = {
			credentials: {
				get: (id: string) => (id === credentialId ? credential : undefined),
				remove: vi.fn(async (id: string) => {
					if (id === credentialId) credential = undefined;
				}),
			},
		} as unknown as AuthStorage;
		const previousKey = Bun.env.DASHBOARD_TEST_API_KEY;
		Bun.env.DASHBOARD_TEST_API_KEY = "resolved-secret";
		try {
			await Bun.write(
				configPath,
				`${JSON.stringify(
					{
						mcpServers: {
							github: {
								...CONFIG,
								headers: { "X-Api-Key": "${DASHBOARD_TEST_API_KEY}" },
								auth: { type: "oauth", credentialId, tokenUrl: "https://auth.example.com/token" },
							},
						},
					},
					null,
					2,
				)}\n`,
			);
			const runtime = createMCPActionRuntime({ cwd: projectDir, settings, authStorage });
			const extension = (await loadAllExtensions(projectDir, [])).find(item => item.id === "mcp:github");
			await runtime.loadState(extension!);

			await expect(
				runtime.runAction(extension!, "clear-authentication", {
					signal: new AbortController().signal,
					onProgress: () => {},
					onAuthorization: () => {},
					requestManualInput: async () => "",
				}),
			).resolves.toBe("Stored authentication cleared.");
			const saved = JSON.parse(await Bun.file(configPath).text());
			expect(saved.mcpServers.github.auth).toBeUndefined();
			expect(saved.mcpServers.github.headers["X-Api-Key"]).toBe("${DASHBOARD_TEST_API_KEY}");
		} finally {
			if (previousKey === undefined) delete Bun.env.DASHBOARD_TEST_API_KEY;
			else Bun.env.DASHBOARD_TEST_API_KEY = previousKey;
		}
	});
});
