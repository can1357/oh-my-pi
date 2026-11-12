import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "../../src/mcp/client";
import type { LoadMCPConfigsResult } from "../../src/mcp/config";
import {
	createMcpConfigHotReloadSubsystem,
	createMcpServersHotReloadSubsystem,
	describeMcpConfigRefresh,
	mcpConfigSignature,
} from "../../src/mcp/config-hot-reload";
import { HotReloadCoordinator } from "../../src/session/hot-reload";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPServerConfig, MCPServerConnection, MCPTransport } from "../../src/mcp/types";

function createFakeTransport(): MCPTransport {
	let isConnected = true;
	return {
		get connected() {
			return isConnected;
		},
		async request<T = unknown>(method: string): Promise<T> {
			if (method === "tools/list") {
				return {
					tools: [
						{
							name: "ping",
							description: "ping tool",
							inputSchema: { type: "object" },
						},
					],
				} as T;
			}
			return {} as T;
		},
		async notify(): Promise<void> {},
		async close(): Promise<void> {
			isConnected = false;
		},
	};
}

describe("describeMcpConfigRefresh", () => {
	it("is silent when nothing changed and nothing failed", () => {
		expect(
			describeMcpConfigRefresh({
				added: [],
				updated: [],
				removed: [],
				errors: [],
			}),
		).toBeUndefined();
	});

	it("formats added, updated, and removed counts", () => {
		expect(
			describeMcpConfigRefresh({
				added: ["mcp-gateway"],
				updated: ["linear"],
				removed: ["old"],
				errors: [],
			}),
		).toEqual({
			level: "info",
			message: "mcp config reloaded: +1 ~1 -1",
		});
	});

	it("lists failed servers and downgrades to a warning", () => {
		expect(
			describeMcpConfigRefresh({
				added: ["ok-srv"],
				updated: [],
				removed: [],
				errors: [{ serverName: "bad-srv", error: "connection refused" }],
			}),
		).toEqual({
			level: "warning",
			message: "mcp config reloaded: +1 ~0 -0, 1 failed\n  bad-srv: connection refused",
		});
		expect(
			describeMcpConfigRefresh({
				added: [],
				updated: [],
				removed: [],
				errors: [{ server: "bad-reconcile", error: "timeout" }],
			}),
		).toEqual({
			level: "warning",
			message: "mcp config unchanged: +0 ~0 -0, 1 failed\n  bad-reconcile: timeout",
		});
	});
});

describe("mcpConfigSignature", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-sig-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("changes when a watched config file is created, edited, or deleted, and ignores a no-op touch", async () => {
		const mcpPath = path.join(dir, "mcp.json");
		const missingSig = await mcpConfigSignature([mcpPath]);

		await Bun.write(mcpPath, '{"mcpServers":{"a":{"command":"echo"}}}\n');
		const createdSig = await mcpConfigSignature([mcpPath]);
		expect(createdSig).not.toBe(missingSig);

		const future = new Date(Date.now() + 60_000);
		await fs.utimes(mcpPath, future, future);
		expect(await mcpConfigSignature([mcpPath])).toBe(createdSig);

		await Bun.write(mcpPath, '{"mcpServers":{"a":{"command":"echo"},"b":{"command":"true"}}}\n');
		const editedSig = await mcpConfigSignature([mcpPath]);
		expect(editedSig).not.toBe(createdSig);

		await fs.rm(mcpPath);
		expect(await mcpConfigSignature([mcpPath])).toBe(missingSig);
	});
});

describe("createMcpConfigHotReloadSubsystem", () => {
	let dir: string;
	let mcpPath: string;
	let busy: boolean;
	let idleListeners: Array<() => void>;
	let reloads: number;
	let notices: string[];
	let watcher: HotReloadCoordinator;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-config-watch-"));
		mcpPath = path.join(dir, "mcp.json");
		await Bun.write(mcpPath, '{"mcpServers":{}}\n');
		busy = false;
		idleListeners = [];
		reloads = 0;
		notices = [];
		watcher = new HotReloadCoordinator({
			subsystems: [
				createMcpConfigHotReloadSubsystem({
					paths: () => [mcpPath],
					reload: async () => {
						reloads++;
						return { added: ["mcp-gateway"], updated: [], removed: [], errors: [] };
					},
				}),
			],
			isBusy: () => busy,
			onIdle: listener => {
				idleListeners.push(listener);
				return () => {
					idleListeners = idleListeners.filter(l => l !== listener);
				};
			},
			notify: (level, message) => {
				notices.push(`${level}:${message}`);
			},
			pollIntervalMs: 3_600_000,
		});
	});

	afterEach(async () => {
		watcher.stop();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("reloads nothing while mcp.json is unchanged", async () => {
		await watcher.start();
		await watcher.poll();
		expect([reloads, notices]).toEqual([0, []]);
	});

	it("reloads and emits a notice when mcp.json changes while idle", async () => {
		await watcher.start();
		await Bun.write(mcpPath, '{"mcpServers":{"mcp-gateway":{"type":"http","url":"http://localhost:4600/mcp"}}}\n');
		await watcher.poll();
		expect(reloads).toBe(1);
		expect(notices).toEqual(["info:mcp config reloaded: +1 ~0 -0"]);
	});

	it("defers reload while busy, announces once, and flushes on idle", async () => {
		await watcher.start();
		busy = true;
		await Bun.write(mcpPath, '{"mcpServers":{"a":{"command":"echo"}}}\n');
		await watcher.poll();
		await Bun.write(mcpPath, '{"mcpServers":{"a":{"command":"echo"},"b":{"command":"true"}}}\n');
		await watcher.poll();

		expect(reloads).toBe(0);
		expect(notices).toEqual(["info:MCP config changed; reload deferred until the current turn ends"]);

		busy = false;
		for (const listener of idleListeners) listener();
		await watcher.poll();

		expect(reloads).toBe(1);
		expect(notices).toEqual([
			"info:MCP config changed; reload deferred until the current turn ends",
			"info:mcp config reloaded: +1 ~0 -0",
		]);
	});

	it("supports the sdk cwd/agentDir/reconcile option shape without explicit paths()", async () => {
		const sdkWatcher = new HotReloadCoordinator({
			subsystems: [
				createMcpConfigHotReloadSubsystem({
					cwd: () => dir,
					agentDir: dir,
					reconcile: async () => {
						reloads++;
						return { added: ["mcp-gateway"], updated: [], removed: [], errors: [] };
					},
				}),
			],
			isBusy: () => false,
			onIdle: () => () => {},
			notify: (level, message) => {
				notices.push(`${level}:${message}`);
			},
			pollIntervalMs: 3_600_000,
		});
		try {
			await sdkWatcher.start();
			await Bun.write(mcpPath, '{"mcpServers":{"mcp-gateway":{"type":"http","url":"http://localhost:4600/mcp"}}}\n');
			await sdkWatcher.poll();
			expect(reloads).toBe(1);
			expect(notices).toBeDefined();
			expect(notices).toEqual(["info:mcp config reloaded: +1 ~0 -0"]);
		} finally {
			sdkWatcher.stop();
		}
	});

	it("createMcpServersHotReloadSubsystem defers stdio server binary reconnects while busy and reconnects on idle", async () => {
		const { HotReloadCoordinator } = await import("../../src/session/hot-reload");
		let isBusy = true;
		const idleListeners = new Set<() => void>();
		const coordinatorNotices: string[] = [];
		const reconnected: string[][] = [];
		const changedQueue: string[] = [];
		const coordinator = new HotReloadCoordinator({
			isBusy: () => isBusy,
			onIdle: listener => {
				idleListeners.add(listener);
				return () => idleListeners.delete(listener);
			},
			notify: (level, message, source) => {
				coordinatorNotices.push(`${level}:${source ?? ""}:${message}`);
			},
			pollIntervalMs: 3_600_000,
		});
		coordinator.register(
			createMcpServersHotReloadSubsystem({
				poll: async () => {},
				takeChangedServers: () => {
					const items = [...changedQueue];
					changedQueue.length = 0;
					return items;
				},
				reconnectServers: async names => {
					reconnected.push([...names]);
					return { added: [], updated: [...names], removed: [], errors: [] };
				},
			}),
		);
		try {
			await coordinator.start();
			changedQueue.push("local-stdio");
			await coordinator.poll();
			expect(reconnected).toEqual([]);
			expect(coordinatorNotices).toEqual([
				"info:mcp:MCP server binary changed; reload deferred until the current turn ends",
			]);

			isBusy = false;
			for (const listener of idleListeners) listener();
			await coordinator.poll();
			expect(reconnected).toEqual([["local-stdio"]]);
			expect(coordinatorNotices).toEqual([
				"info:mcp:MCP server binary changed; reload deferred until the current turn ends",
				"info:mcp:mcp config reloaded: +0 ~1 -0",
			]);
		} finally {
			coordinator.stop();
		}
	});
});

describe("MCPManager.reconcileConfigs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds new servers, updates modified servers, and disconnects removed servers", async () => {
		let currentResult: LoadMCPConfigsResult = {
			configs: {
				alpha: { type: "http", url: "http://localhost:4001/mcp" },
			},
			exaApiKeys: [],
			sources: {
				alpha: {
					provider: "mcp-json",
					providerName: "mcp.json",
					path: "/tmp/mcp.json",
					level: "user",
				},
			},
		};

		const connectCalls: string[] = [];
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((async (
			name: string,
			config: MCPServerConfig,
		): Promise<MCPServerConnection> => {
			connectCalls.push(`${name}:${(config as { url?: string }).url ?? ""}`);
			return {
				name,
				config,
				transport: createFakeTransport(),
				serverInfo: { name, version: "1.0.0" },
				capabilities: { tools: {} },
			};
		}) as never);

		const manager = new MCPManager("/tmp", null, async () => currentResult);

		await manager.discoverAndConnect();
		expect(manager.getConnectedServers()).toEqual(["alpha"]);

		// Add beta, update alpha's URL
		currentResult = {
			configs: {
				alpha: { type: "http", url: "http://localhost:4002/mcp" },
				beta: { type: "http", url: "http://localhost:4003/mcp" },
			},
			exaApiKeys: [],
			sources: {
				alpha: {
					provider: "mcp-json",
					providerName: "mcp.json",
					path: "/tmp/mcp.json",
					level: "user",
				},
				beta: {
					provider: "mcp-json",
					providerName: "mcp.json",
					path: "/tmp/mcp.json",
					level: "user",
				},
			},
		};

		const firstReconcile = await manager.reconcileConfigs();
		expect(firstReconcile).toEqual({
			added: ["beta"],
			updated: ["alpha"],
			removed: [],
			errors: [],
		});
		expect(manager.getConnectedServers().sort()).toEqual(["alpha", "beta"]);

		// Remove alpha, leave beta untouched
		const callsBeforeRemove = connectCalls.length;
		currentResult = {
			configs: {
				beta: { type: "http", url: "http://localhost:4003/mcp" },
			},
			exaApiKeys: [],
			sources: {
				beta: {
					provider: "mcp-json",
					providerName: "mcp.json",
					path: "/tmp/mcp.json",
					level: "user",
				},
			},
		};

		const secondReconcile = await manager.reconcileConfigs();
		expect(secondReconcile).toEqual({
			added: [],
			updated: [],
			removed: ["alpha"],
			errors: [],
		});
		expect(manager.getConnectedServers()).toEqual(["beta"]);
		expect(connectCalls.length).toBe(callsBeforeRemove);

		await manager.disconnectAll();
	});
});
