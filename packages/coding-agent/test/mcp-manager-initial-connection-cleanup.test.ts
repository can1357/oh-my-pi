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
});
