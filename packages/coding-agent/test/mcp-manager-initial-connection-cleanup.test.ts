import { afterEach, describe, expect, it, vi } from "bun:test";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";

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
