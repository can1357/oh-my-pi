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
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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
		reconnectServer: vi.fn(
			async (name: string, _options?: { manual?: boolean }): Promise<Record<string, never> | null> => {
				if (options.toolsAfterReconnect !== false) {
					seeded = true;
					toolsFor = name;
				}
				return {};
			},
		),
		getSource: vi.fn(() => undefined),
		getAllServerNames: vi.fn((): string[] => []),
	};
	const showCommandReport = vi.fn();
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		presentCommandOutput: vi.fn(),
		showCommandReport,
		ui: { requestRender: vi.fn() },
		editor: {},
		showError: vi.fn(),
		showStatus: vi.fn(),
		keybindings: KeybindingsManager.inMemory(),
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
	return { controller, mcpManager, refreshMCPTools, showCommandReport };
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

		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv", { manual: true });
		// The seeded tools reach the session even though the manager still
		// reports the lazy server itself as disconnected.
		expect(refreshMCPTools).toHaveBeenCalledWith([{ name: "fixture_tool", mcpServerName: "lazysrv" }]);
	});

	// The seed writes the tool cache under the identity of the config the
	// manager holds; the next startup looks the cache up with the config
	// discovery produces (e.g. `type: "stdio"` filled in). Seeding with the
	// raw file entry wrote a cache no later session could read, so the server
	// started tool-less again.
	test("seeds a lazy server with the config startup discovery produces", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { command: "lazy-cmd", lazy: true } as MCPServerConfig,
		});
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp test lazysrv");

		const discovered = (await loadAllMCPConfigs(projectDir)).configs.lazysrv;
		expect(discovered?.type).toBe("stdio");
		expect(mcpManager.connectServers).toHaveBeenCalledWith({ lazysrv: discovered }, expect.anything());
		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv", { manual: true });
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

		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv", { manual: true });
		expect(refreshMCPTools).toHaveBeenCalledWith([{ name: "fresh_tool", mcpServerName: "lazysrv" }]);
	});

	// PR #9793 review (Codex, mcp-command-controller.ts:1330): a server that
	// permits only one active client would see this temporary test connection
	// still open while the manager's seeding reconnect races it for the same
	// slot, and every retry in its ladder could fail.
	test("closes the test connection before seeding through the manager", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
		});
		const { controller, mcpManager } = createController();
		const order: string[] = [];
		vi.spyOn(mcpClient, "disconnectServer").mockImplementation(async () => {
			order.push("disconnect");
		});
		mcpManager.reconnectServer.mockImplementation(async () => {
			order.push("reconnect");
			return {};
		});

		await controller.handle("/mcp test lazysrv");

		expect(order).toEqual(["disconnect", "reconnect"]);
	});

	// PR #9793 review (Codex, mcp-command-controller.ts:1764): session
	// termination can hang (an HTTP server that never answers its DELETE), so
	// awaiting it must not hold `/mcp test`'s result. The close below never
	// settles; a regression leaves `handle()` pending forever.
	test("does not wait on the test connection's close when the manager already holds the server", async () => {
		await writeProjectConfig(projectDir, {
			eagersrv: { type: "stdio", command: "eager-cmd" },
		});
		const { controller, mcpManager } = createController();
		mcpManager.getConnectionStatus.mockReturnValue("connected");
		const closeCalled = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "disconnectServer").mockImplementation(() => {
			closeCalled.resolve();
			return new Promise<void>(() => {});
		});

		await controller.handle("/mcp test eagersrv");

		await closeCalled.promise;
	});

	test("a close that never settles delays seeding by a bounded wait only", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
		});
		const { controller, mcpManager } = createController();
		const closeCalled = Promise.withResolvers<void>();
		const closeGate = Promise.withResolvers<void>();
		const seeded = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "disconnectServer").mockImplementation(() => {
			closeCalled.resolve();
			return closeGate.promise;
		});
		mcpManager.reconnectServer.mockImplementation(async () => {
			seeded.resolve();
			return {};
		});

		let handled: Promise<void>;
		vi.useFakeTimers();
		try {
			handled = controller.handle("/mcp test lazysrv");
			await closeCalled.promise;
			expect(mcpManager.reconnectServer).not.toHaveBeenCalled();
			// Well past any close bound.
			vi.advanceTimersByTime(60_000);
		} finally {
			vi.useRealTimers();
		}
		// The seed must start while the close is still pending. A regression that
		// awaits the close without a bound never reaches it and fails on the test
		// timeout (real timers are back, so the timeout fires).
		await seeded.promise;
		closeGate.resolve();
		await handled;

		expect(mcpManager.reconnectServer).toHaveBeenCalledTimes(1);
		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv", { manual: true });
	});

	// PR #9793 review (Codex, mcp-command-controller.ts:1330): a server whose
	// automatic reconnects had already tripped the crash-burst breaker (see
	// `#tripReconnectBreaker` in `manager.ts`) must still seed through an
	// explicit `/mcp test` — `reconnectServer` returns `null` under an open
	// breaker unless `options.manual` resets it, exactly like `/mcp reconnect`.
	test("a /mcp test seeds through an open reconnect breaker via manual: true", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();
		mcpManager.reconnectServer.mockImplementation(async (name: string, options?: { manual?: boolean }) => {
			if (!options?.manual) return null;
			mcpManager.getTools.mockReturnValue([{ name: "fixture_tool", mcpServerName: name }]);
			return {};
		});

		await controller.handle("/mcp test lazysrv");

		expect(mcpManager.reconnectServer).toHaveBeenCalledWith("lazysrv", { manual: true });
		expect(refreshMCPTools).toHaveBeenCalledWith([{ name: "fixture_tool", mcpServerName: "lazysrv" }]);
	});
});

// PR #9793 review (Codex, manager.ts:644): a dormant lazy server keeps
// connection status "disconnected" while its cached tools are registered and
// usable, so `/mcp list` showed every healthy one as plain "not connected".
describe("/mcp list distinguishes a dormant lazy server from an unreachable one", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-list-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-list-agent-"));
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

	test("a disconnected server with registered tools lists as reachable on first use", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
			downsrv: { type: "stdio", command: "down-cmd" },
		});
		const { controller, mcpManager, showCommandReport } = createController();
		mcpManager.getTools.mockReturnValue([
			{ name: "fixture_tool", mcpServerName: "lazysrv" },
			{ name: "other_tool", mcpServerName: "lazysrv" },
		]);

		await controller.handle("/mcp list");

		const report = showCommandReport.mock.calls[0]?.[0] as { body: { render(width: number): string[] } };
		const lines = report.body.render(200).map(line => Bun.stripANSI(line).trim());
		const lazyLine = lines.find(line => line.startsWith("lazysrv")) ?? "";
		const downLine = lines.find(line => line.startsWith("downsrv")) ?? "";
		expect(lazyLine).toContain("2 tools");
		expect(lazyLine).toContain("connects on first use");
		expect(downLine).toContain("not connected");
		expect(downLine).not.toContain("connects on first use");
	});
});
