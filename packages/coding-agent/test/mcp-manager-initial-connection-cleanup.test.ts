import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { TOOL_NAME as DELAYED_TOOL_NAME } from "./fixtures/delayed-tool-mcp";

const CONFIG: MCPStdioServerConfig = {
	type: "stdio",
	command: "fake-mcp-server",
};

class FakeTransport implements MCPTransport {
	connected = true;
	closeCalls = 0;
	onClose?: () => void;
	#closeGate?: Promise<void>;

	/** Make `close()` hang on the given gate to simulate a slow HTTP session DELETE. */
	gateClose(gate: Promise<void>): void {
		this.#closeGate = gate;
	}

	request<T>(): Promise<T> {
		throw new Error("Unexpected transport request");
	}

	async notify(): Promise<void> {}

	async close(): Promise<void> {
		this.closeCalls += 1;
		this.connected = false;
		if (this.#closeGate) await this.#closeGate;
	}
}

function fakeConnection(name: string): { connection: MCPServerConnection; transport: FakeTransport } {
	const transport = new FakeTransport();
	return {
		connection: {
			name,
			config: CONFIG,
			transport,
			serverInfo: { name: "fake", version: "1.0.0" },
			capabilities: { tools: {} },
		},
		transport,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MCPManager initial connection ownership", () => {
	it("closes a connection that resolves after disconnectAll", async () => {
		const manager = new MCPManager(process.cwd());
		const deferred = Promise.withResolvers<MCPServerConnection>();
		const connectStarted = Promise.withResolvers<void>();
		const stale = fakeConnection("server");
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			connectStarted.resolve();
			return deferred.promise;
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const loading = manager.connectServers({ server: CONFIG }, {});
		await connectStarted.promise;
		await manager.disconnectAll();
		deferred.resolve(stale.connection);
		await loading;

		expect(stale.transport.closeCalls).toBe(1);
		expect(manager.getConnectedServers()).toEqual([]);
	});

	it("closes and forgets a connection whose initial tools/list fails", async () => {
		const manager = new MCPManager(process.cwd());
		const failed = fakeConnection("server");
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(failed.connection);
		vi.spyOn(mcpClient, "listTools").mockRejectedValue(new Error("initial tools/list failed"));

		const result = await manager.connectServers({ server: CONFIG }, {});

		expect(result.errors.get("server")).toBe("initial tools/list failed");
		expect(failed.transport.closeCalls).toBe(1);
		expect(manager.getConnectedServers()).toEqual([]);
	});

	it("recovers tools after an initial handshake timeout", async () => {
		const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-initial-recovery-"));
		const manager = new MCPManager(workDir);
		const rebound = Promise.withResolvers<void>();
		const statusTypes: string[] = [];
		const statusSettled = Promise.withResolvers<void>();
		const marker = path.join(workDir, "first-start");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [path.join(import.meta.dir, "fixtures", "delayed-tool-mcp.ts"), marker],
			timeout: 100,
		};
		manager.setOnToolsChanged(tools => {
			if (tools.some(tool => tool.name === `mcp__server_${DELAYED_TOOL_NAME}`)) rebound.resolve();
		});

		try {
			const result = await manager.connectServers({ server: config }, {}, event => {
				statusTypes.push(event.type);
				if (event.type === "connected") statusSettled.resolve();
			});
			expect(result.errors.get("server")).toBe('Connection to MCP server "server" timed out after 100ms');
			await rebound.promise;
			await statusSettled.promise;

			expect(manager.getConnectionStatus("server")).toBe("connected");
			expect(manager.getTools().map(tool => tool.name)).toEqual([`mcp__server_${DELAYED_TOOL_NAME}`]);
			expect(statusTypes).toEqual(["connecting", "failed", "reconnecting", "connected"]);
		} finally {
			await manager.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 5_000);

	it("stops a startup-timeout retry when that server is disconnected", async () => {
		vi.useFakeTimers();
		const manager = new MCPManager(process.cwd());
		const retryStarted = Promise.withResolvers<void>();
		const retryGate = Promise.withResolvers<MCPServerConnection>();
		let connectCalls = 0;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			connectCalls += 1;
			if (connectCalls === 1) {
				return Promise.reject(new mcpClient.MCPConnectionTimeoutError("server", 100));
			}
			if (connectCalls === 2) {
				retryStarted.resolve();
				return retryGate.promise;
			}
			return Promise.reject(new Error("unexpected reconnect"));
		});

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await retryStarted.promise;
			await manager.disconnectServer("server");
			retryGate.reject(new Error("retry failed after disconnect"));
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();
			vi.advanceTimersByTime(10_000);
			for (let flush = 0; flush < 5; flush++) await Promise.resolve();

			expect(connectCalls).toBe(2);
			expect(manager.getConnectionStatus("server")).toBe("disconnected");
		} finally {
			vi.useRealTimers();
			await manager.disconnectAll();
		}
	});

	it("does not close a newer connection while cleaning up a stale result", async () => {
		const manager = new MCPManager(process.cwd());
		const firstDeferred = Promise.withResolvers<MCPServerConnection>();
		const secondDeferred = Promise.withResolvers<MCPServerConnection>();
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const stale = fakeConnection("server");
		const current = fakeConnection("server");
		vi.spyOn(mcpClient, "connectToServer")
			.mockImplementationOnce(() => {
				firstStarted.resolve();
				return firstDeferred.promise;
			})
			.mockImplementationOnce(() => {
				secondStarted.resolve();
				return secondDeferred.promise;
			});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const firstLoad = manager.connectServers({ server: CONFIG }, {});
		await firstStarted.promise;
		await manager.disconnectAll();
		const secondLoad = manager.connectServers({ server: CONFIG }, {});
		await secondStarted.promise;

		firstDeferred.resolve(stale.connection);
		await firstLoad;
		secondDeferred.resolve(current.connection);
		await secondLoad;

		expect(stale.transport.closeCalls).toBe(1);
		expect(current.transport.closeCalls).toBe(0);
		expect(manager.getConnectedServers()).toEqual(["server"]);
		await manager.disconnectAll();
	});

	it("reports a tools/list failure and re-enables connects even when close hangs", async () => {
		const manager = new MCPManager(process.cwd());
		const failed = fakeConnection("server");
		const stuckClose = Promise.withResolvers<void>();
		failed.transport.gateClose(stuckClose.promise);
		const connectSpy = vi
			.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(failed.connection)
			.mockRejectedValue(new Error("second connect refused"));
		vi.spyOn(mcpClient, "listTools").mockRejectedValueOnce(new Error("initial tools/list failed"));

		// close() never settles, but the failure must still surface and clear
		// pending state so the server is not silently skipped forever.
		const result = await manager.connectServers({ server: CONFIG }, {});
		expect(result.errors.get("server")).toBe("initial tools/list failed");
		expect(failed.transport.closeCalls).toBe(1);
		expect(manager.getConnectedServers()).toEqual([]);

		// A subsequent connect is attempted rather than skipped on stale pending state.
		await manager.connectServers({ server: CONFIG }, {});
		expect(connectSpy).toHaveBeenCalledTimes(2);

		stuckClose.resolve();
	});
	it("waits for the initial tools/list result and freezes that readiness snapshot", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { connected: CONFIG, failed: CONFIG },
			exaApiKeys: [],
			sources: {},
		}));
		const connected = fakeConnection("connected");
		const failed = fakeConnection("failed");
		const toolsGate = Promise.withResolvers<never[]>();
		const connectSpy = vi
			.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(connected.connection)
			.mockResolvedValueOnce(failed.connection)
			.mockResolvedValueOnce(failed.connection);
		vi.spyOn(mcpClient, "listTools")
			.mockReturnValueOnce(toolsGate.promise)
			.mockRejectedValueOnce(new Error("initial tools/list failed"))
			.mockResolvedValueOnce([]);

		const readiness = manager.waitForInitialConnections();
		const loading = manager.discoverAndConnect();
		let settled = false;
		void readiness.then(() => {
			settled = true;
		});
		await loading;
		expect(settled).toBe(false);

		toolsGate.resolve([]);
		const snapshot = await readiness;
		expect(snapshot).toEqual({
			pendingServers: [],
			connectedServers: ["connected"],
			failedServers: [{ serverName: "failed", error: "initial tools/list failed" }],
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.connectedServers)).toBe(true);

		await manager.connectServers({ failed: CONFIG }, {});
		expect(connectSpy).toHaveBeenCalledTimes(3);
		expect(await manager.waitForInitialConnections()).toBe(snapshot);
	});

	it("resolves an empty initial readiness snapshot", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: {},
			exaApiKeys: [],
			sources: {},
		}));
		const result = manager.waitForInitialConnections();
		await manager.discoverAndConnect();
		expect(await result).toEqual({ pendingServers: [], connectedServers: [], failedServers: [] });
	});

	it("captures an initial config discovery failure in readiness", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => {
			throw new Error("config discovery failed");
		});

		const readiness = manager.waitForInitialConnections();
		await expect(manager.discoverAndConnect()).rejects.toThrow("config discovery failed");
		expect(await readiness).toEqual({
			pendingServers: [],
			connectedServers: [],
			failedServers: [{ serverName: ".mcp.json", error: "config discovery failed" }],
		});
	});
	it("does not let a non-discovery connect call settle readiness before initial discovery", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { initial: CONFIG },
			exaApiKeys: [],
			sources: {},
		}));
		const initial = fakeConnection("initial");
		const toolsGate = Promise.withResolvers<never[]>();
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(initial.connection);
		vi.spyOn(mcpClient, "listTools").mockReturnValue(toolsGate.promise);

		const readiness = manager.waitForInitialConnections();
		await manager.connectServers({ initial: CONFIG }, {});
		let settled = false;
		void readiness.then(() => {
			settled = true;
		});
		await manager.discoverAndConnect();
		expect(settled).toBe(false);

		toolsGate.resolve([]);
		expect(await readiness).toEqual({
			pendingServers: [],
			connectedServers: ["initial"],
			failedServers: [],
		});
	});

	it("does not snapshot servers connected before the initial discovery", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { initial: CONFIG },
			exaApiKeys: [],
			sources: {},
		}));
		const earlier = fakeConnection("earlier");
		const initial = fakeConnection("initial");
		vi.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(earlier.connection)
			.mockResolvedValueOnce(initial.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const readiness = manager.waitForInitialConnections();
		await manager.connectServers({ earlier: CONFIG }, {});
		await manager.discoverAndConnect();

		expect(await readiness).toEqual({
			pendingServers: [],
			connectedServers: ["initial"],
			failedServers: [],
		});
	});
	it("returns already-connected servers while initial tools/list is still pending", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { server: CONFIG },
			exaApiKeys: [],
			sources: {},
		}));
		const connected = fakeConnection("server");
		const toolsStarted = Promise.withResolvers<void>();
		const toolsGate = Promise.withResolvers<never[]>();
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connected.connection);
		vi.spyOn(mcpClient, "listTools").mockImplementation(() => {
			toolsStarted.resolve();
			return toolsGate.promise;
		});

		const firstConnect = manager.connectServers({ server: CONFIG }, {}, undefined, 0);
		await toolsStarted.promise;
		const readiness = manager.waitForInitialConnections();
		const result = await manager.discoverAndConnect();
		let settled = false;
		void readiness.then(() => {
			settled = true;
		});

		expect(result.connectedServers).toEqual(["server"]);
		expect(settled).toBe(false);
		toolsGate.resolve([]);
		await firstConnect;
		expect((await readiness).connectedServers).toEqual(["server"]);
	});

	it("cancels one initial-readiness waiter and removes its abort listener", async () => {
		const manager = new MCPManager(process.cwd());
		const controller = new AbortController();
		const add = vi.spyOn(controller.signal, "addEventListener");
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		const aborted = manager.waitForInitialConnections({ signal: controller.signal });
		const otherWaiter = manager.waitForInitialConnections();
		controller.abort(new Error("caller cancelled"));

		await expect(aborted).rejects.toThrow("caller cancelled");
		expect(add).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		await manager.disconnectAll();
		await expect(otherWaiter).rejects.toThrow("disconnected");
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(manager.waitForInitialConnections({ signal: alreadyAborted.signal })).rejects.toHaveProperty(
			"name",
			"AbortError",
		);
	});

	it("rejects initial readiness when disconnected before discovery starts", async () => {
		const manager = new MCPManager(process.cwd());
		const readiness = manager.waitForInitialConnections();
		await manager.disconnectAll();
		await expect(readiness).rejects.toThrow("disconnected");
	});

	it("rejects pending initial readiness when disconnected before or during config discovery", async () => {
		const neverLoaded = Promise.withResolvers<{ configs: {}; exaApiKeys: string[]; sources: {} }>();
		const manager = new MCPManager(process.cwd(), null, () => neverLoaded.promise);
		const beforeDiscovery = manager.waitForInitialConnections();
		const discovery = manager.discoverAndConnect();
		const duringConfigLoad = manager.waitForInitialConnections();
		await manager.disconnectAll();
		await expect(beforeDiscovery).rejects.toThrow("disconnected");
		await expect(duringConfigLoad).rejects.toThrow("disconnected");
		neverLoaded.resolve({ configs: {}, exaApiKeys: [], sources: {} });
		await expect(discovery).rejects.toThrow("disconnected");
	});

	it("rejects initial readiness when disconnected during a hung tools/list", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { server: CONFIG },
			exaApiKeys: [],
			sources: {},
		}));
		const connected = fakeConnection("server");
		const toolsGate = Promise.withResolvers<never[]>();
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connected.connection);
		vi.spyOn(mcpClient, "listTools").mockReturnValue(toolsGate.promise);
		const readiness = manager.waitForInitialConnections();
		const discovery = manager.discoverAndConnect();
		await Promise.resolve();
		await manager.disconnectAll();
		await expect(readiness).rejects.toThrow("disconnected");
		toolsGate.resolve([]);
		await discovery;
	});

	it("reports the first timeout when discovery finds its retry already running", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { server: CONFIG },
			exaApiKeys: [],
			sources: {},
		}));
		const retryStarted = Promise.withResolvers<void>();
		const retryGate = Promise.withResolvers<MCPServerConnection>();
		const recovered = fakeConnection("server");
		vi.spyOn(mcpClient, "connectToServer")
			.mockRejectedValueOnce(new mcpClient.MCPConnectionTimeoutError("server", 100))
			.mockImplementationOnce(() => {
				retryStarted.resolve();
				return retryGate.promise;
			});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const readiness = manager.waitForInitialConnections();
		await manager.connectServers({ server: CONFIG }, {});
		await retryStarted.promise;
		await manager.discoverAndConnect();

		expect(await readiness).toEqual({
			pendingServers: [],
			connectedServers: [],
			failedServers: [{ serverName: "server", error: 'Connection to MCP server "server" timed out after 100ms' }],
		});

		retryGate.resolve(recovered.connection);
		await manager.waitForPendingConnections();
	});
});
