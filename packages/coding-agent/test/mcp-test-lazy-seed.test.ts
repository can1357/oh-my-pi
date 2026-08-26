/**
 * Bot review on PR #9793: `/mcp test <name>` on a *first-time lazy* server
 * used to report success while leaving the manager tool-less. The test's
 * temporary connection never writes the tool cache, and the follow-up
 * `#syncManagerConnection` → `connectServers` deliberately skips a lazy
 * server's connection — it can only restore a pre-existing cache, so with
 * none the just-fetched definitions were discarded and the server stayed
 * dormant until a manual `/mcp reconnect`. After a successful test the
 * controller now seeds first-time lazy servers through `reconnectServer`
 * (the documented seeding path, which registers live tools and writes the
 * cache).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

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

function createController(options: { toolsAfterReconnect?: boolean } = {}) {
	const refreshMCPTools = vi.fn(async () => {});
	let seeded = false;
	const serverTools = (name: string) => [{ name: "fixture_tool", mcpServerName: name }];
	let toolsFor: string | undefined;
	const mcpManager = {
		prepareConfig: vi.fn(async (config: MCPServerConfig) => config),
		connectServers: vi.fn(async () => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		})),
		getTools: vi.fn(() => (seeded && toolsFor ? serverTools(toolsFor) : [])),
		getConnectionStatus: vi.fn(() => "disconnected"),
		reconnectServer: vi.fn(async (name: string) => {
			if (options.toolsAfterReconnect !== false) {
				seeded = true;
				toolsFor = name;
			}
			return {};
		}),
		getSource: vi.fn(() => undefined),
	};
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		presentCommandOutput: vi.fn(),
		ui: { requestRender: vi.fn() },
		editor: {},
		showError: vi.fn(),
		showStatus: vi.fn(),
		mcpTestEscapeHandlers: new Set(),
		oauthManualInput: {
			hasPending: vi.fn(() => false),
			pendingProviderId: undefined,
			tryClaimInput: vi.fn(),
		},
		session: {
			refreshMCPTools,
			modelRegistry: { authStorage: undefined },
		},
		mcpManager,
	} as never);
	return { controller, mcpManager, refreshMCPTools };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(getMCPConfigPath("project", projectDir), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

describe("/mcp test seeds first-time lazy servers (PR #9793 review)", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-test-seed-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-test-seed-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({
			serverInfo: { name: "fixture", version: "1.0.0" },
		} as never);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([
			{ name: "fixture_tool", description: "d", inputSchema: { type: "object" } },
		] as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("a successful test on a cache-less lazy server forces one seeding connect", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp test lazysrv");

		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv");
		// The seeded tools reach the session even though the manager still
		// reports the lazy server itself as disconnected.
		expect(refreshMCPTools).toHaveBeenCalledWith([{ name: "fixture_tool", mcpServerName: "lazysrv" }]);
	});

	test("a successful test on an eager server does not force a reconnect", async () => {
		await writeProjectConfig(projectDir, {
			eagersrv: { type: "stdio", command: "eager-cmd" },
		});
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp test eagersrv");

		expect(mcpManager.reconnectServer).not.toHaveBeenCalled();
	});

	test("a cache-hit lazy server is re-seeded so the session gets the current catalog, not the stale cache", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();
		// connectServers restored the LAST connect's cached definitions as
		// deferred tools — but the test just fetched the server's current
		// catalog, which may differ (upgraded server, same identity). The
		// forced seeding reconnect must refresh the session with the live
		// catalog rather than trusting the stale cache (PR #9793 round-9).
		mcpManager.getTools.mockReturnValue([{ name: "stale_cached_tool", mcpServerName: "lazysrv" }]);
		mcpManager.reconnectServer.mockImplementation(async (name: string) => {
			mcpManager.getTools.mockReturnValue([{ name: "fresh_tool", mcpServerName: name }]);
			return {};
		});

		await controller.handle("/mcp test lazysrv");

		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv");
		expect(refreshMCPTools).toHaveBeenCalledWith([{ name: "fresh_tool", mcpServerName: "lazysrv" }]);
	});
});
