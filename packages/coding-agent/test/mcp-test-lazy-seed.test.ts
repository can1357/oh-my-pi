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
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager, type MCPReconnectPolicy } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { DeferredMCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { Component } from "@oh-my-pi/pi-tui";
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
import { TOOL_NAME } from "./fixtures/lazy-mcp";

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

/** A controller over `mcpManager`, with the session and UI hooks the tests read. */
function buildController(mcpManager: unknown) {
	const refreshMCPTools = vi.fn(async (_tools: unknown) => {});
	const showCommandReport = vi.fn();
	const presentCommandOutput = vi.fn();
	const controller = new MCPCommandController({
		chatContainer: { addChild: vi.fn() },
		present: vi.fn(),
		presentCommandOutput,
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
		// `/mcp test` reads `mcp.enableProjectConfig` before it looks the server up.
		settings: Settings.isolated(),
		session: {
			refreshMCPTools,
			modelRegistry: { authStorage: undefined },
		},
		mcpManager,
	} as never);
	return { controller, refreshMCPTools, showCommandReport, presentCommandOutput };
}

/** Plain text of the last block a command presented (the `/mcp test` result). */
function lastOutput(presentCommandOutput: { mock: { calls: unknown[][] } }): string {
	const block = presentCommandOutput.mock.calls.at(-1)?.[0] as Component | undefined;
	return (block?.render(200) ?? []).map(line => Bun.stripANSI(line)).join("\n");
}

function createController(options: { toolsAfterReconnect?: boolean } = {}) {
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
	return { ...buildController(mcpManager), mcpManager };
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

	// The test connection proving the server healthy does not mean the session
	// got its tools: the seeding connect can still fail. `/mcp test` must say so
	// instead of reporting plain success over a tool-less or stale session.
	test("tells the user when the seeding connect throws", async () => {
		await writeProjectConfig(projectDir, {
			lazysrv: { type: "stdio", command: "lazy-cmd", lazy: true },
		});
		const { controller, mcpManager, presentCommandOutput } = createController();
		mcpManager.reconnectServer.mockImplementation(async () => {
			throw new Error("spawn failed");
		});

		await controller.handle("/mcp test lazysrv");

		const output = lastOutput(presentCommandOutput);
		expect(output).toContain('Successfully connected to "lazysrv"');
		expect(output).toContain('this session could not connect "lazysrv"');
		expect(output).toContain("/mcp reconnect lazysrv");
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

// Upstream's reconnect rework (`9ecda7c84f0`) documents that a caller reaching
// `reconnectServer` while another attempt is in flight joins that attempt and
// gets its result. The `/mcp test` seed is such a caller whenever an automatic
// reconnect is in flight, such as a deferred tool's first-use connect. When the
// joined attempt failed, the seed did nothing, and `/mcp test` still reported
// plain success over a session left on its stale cached catalog. These tests
// run the real manager against the stdio fixture. Only the manager-side
// connects a scenario needs to fail are made to fail, and they fail only after
// `/mcp test` makes its manual reconnect call, so the automatic attempt is
// still in flight when the seed reaches it.
describe("/mcp test seed racing an automatic reconnect", () => {
	const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "lazy-mcp.ts");
	const NAME = "lazysrv";
	/** One attempt per reconnect, so a failed attempt settles without a retry ladder. */
	const SINGLE_ATTEMPT: MCPReconnectPolicy = { ladderMs: [], retryBaseMs: 60_000, retryMaxMs: 60_000 };
	const TOOL_DEF: MCPToolDefinition = {
		name: TOOL_NAME,
		description: "Fixture tool served by the lazy-connect fixture.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	};
	let projectDir = "";
	let agentDir = "";
	let manager: MCPManager | undefined;
	/** Resolves when `/mcp test` calls `reconnectServer` with `manual: true`. */
	let manualReconnect = Promise.withResolvers<void>();
	/** Manager-side connects still to fail. The test's own probe connection is never failed. */
	let failingConnects = 0;
	/** Resolves when a connect that is set to fail has started. */
	let failingConnectStarted = Promise.withResolvers<void>();

	function memoryStorage(): AgentStorage {
		const store = new Map<string, string>();
		return {
			getCache: (key: string) => store.get(key) ?? null,
			setCache: (key: string, value: string, _expiresAtSec: number) => {
				store.set(key, value);
			},
		} as unknown as AgentStorage;
	}

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-test-race-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-test-race-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		manualReconnect = Promise.withResolvers<void>();
		failingConnects = 0;
		failingConnectStarted = Promise.withResolvers<void>();
		const realConnect = mcpClient.connectToServer;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(async (name, config, options) => {
			if (failingConnects > 0) {
				failingConnects--;
				failingConnectStarted.resolve();
				await manualReconnect.promise;
				throw new Error("simulated connect failure");
			}
			return realConnect(name, config, options);
		});
		await writeProjectConfig(projectDir, {
			[NAME]: { type: "stdio", command: process.execPath, args: [FIXTURE_PATH], lazy: true },
		});
	});

	afterEach(async () => {
		manualReconnect.resolve();
		await manager?.disconnectAll();
		manager = undefined;
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	/** A session that started with the lazy server dormant on its cached catalog. */
	async function startSession() {
		const discovered = await loadAllMCPConfigs(projectDir);
		const config = discovered.configs[NAME];
		if (!config) throw new Error("fixture server not discovered");
		const cache = new MCPToolCache(memoryStorage());
		await cache.set(NAME, config, [TOOL_DEF]);
		const session = new MCPManager(projectDir, cache, undefined, SINGLE_ATTEMPT);
		manager = session;
		await session.connectServers(discovered.configs, discovered.sources);
		const deferred = session.getTools().find(tool => tool.mcpServerName === NAME);
		if (!(deferred instanceof DeferredMCPTool)) throw new Error("cached tool not registered as deferred");
		expect(session.getConnectionStatus(NAME)).toBe("disconnected");
		const realReconnect = session.reconnectServer.bind(session);
		vi.spyOn(session, "reconnectServer").mockImplementation((name, options) => {
			const attempt = realReconnect(name, options);
			if (options?.manual) manualReconnect.resolve();
			return attempt;
		});
		/**
		 * Call the cached tool. Its first use connects the server through the
		 * automatic reconnect path. That attempt fails once `/mcp test` reaches
		 * its seed. Resolves when the attempt is in flight.
		 */
		const firstUse = async () => {
			failingConnects = 1;
			const call = deferred.execute("call-1", {}, undefined, {} as CustomToolContext, undefined);
			await failingConnectStarted.promise;
			expect(session.getConnectionStatus(NAME)).toBe("connecting");
			return { call };
		};
		const liveTools = () =>
			session.getTools().filter(tool => tool.mcpServerName === NAME && !(tool instanceof DeferredMCPTool));
		return { session, firstUse, liveTools, ...buildController(session) };
	}

	test("an automatic reconnect that starts during the seed and fails does not end the seed", async () => {
		const { session, controller, firstUse, liveTools, refreshMCPTools, presentCommandOutput } = await startSession();
		const realConnectServers = session.connectServers.bind(session);
		let toolCall: Promise<unknown> | undefined;
		vi.spyOn(session, "connectServers").mockImplementation(async (configs, sources, onStatus, startupTimeoutMs) => {
			// The tool's first use lands after `/mcp test` checked the server's
			// status and before its seed calls `reconnectServer`.
			({ call: toolCall } = await firstUse());
			return realConnectServers(configs, sources, onStatus, startupTimeoutMs);
		});

		await controller.handle(`/mcp test ${NAME}`);

		// The seed did not stop at the failed attempt it joined.
		expect(session.getConnectionStatus(NAME)).toBe("connected");
		expect(liveTools()).toHaveLength(1);
		expect(refreshMCPTools).toHaveBeenLastCalledWith(session.getTools());
		const output = lastOutput(presentCommandOutput);
		expect(output).toContain(`Successfully connected to "${NAME}"`);
		expect(output).not.toContain("could not connect");
		// The automatic attempt failed: its tool call got the error.
		expect(await toolCall).toMatchObject({ isError: true });
	});

	test("an automatic reconnect already in flight when the test starts is waited for, then seeded over", async () => {
		const { session, controller, firstUse, liveTools, refreshMCPTools, presentCommandOutput } = await startSession();
		const { call } = await firstUse();

		await controller.handle(`/mcp test ${NAME}`);

		expect(session.getConnectionStatus(NAME)).toBe("connected");
		expect(liveTools()).toHaveLength(1);
		expect(refreshMCPTools).toHaveBeenLastCalledWith(session.getTools());
		expect(lastOutput(presentCommandOutput)).not.toContain("could not connect");
		expect(await call).toMatchObject({ isError: true });
	});

	test("a seed that cannot connect tells the user", async () => {
		const { session, controller, liveTools, presentCommandOutput } = await startSession();
		const realConnectServers = session.connectServers.bind(session);
		vi.spyOn(session, "connectServers").mockImplementation(async (configs, sources, onStatus, startupTimeoutMs) => {
			// From here on, every manager-side connect fails.
			failingConnects = Number.POSITIVE_INFINITY;
			return realConnectServers(configs, sources, onStatus, startupTimeoutMs);
		});

		await controller.handle(`/mcp test ${NAME}`);

		expect(session.getConnectionStatus(NAME)).toBe("disconnected");
		expect(liveTools()).toHaveLength(0);
		const output = lastOutput(presentCommandOutput);
		expect(output).toContain(`Successfully connected to "${NAME}"`);
		expect(output).toContain(`this session could not connect "${NAME}"`);
		expect(output).toContain(`/mcp reconnect ${NAME}`);
	});
});
