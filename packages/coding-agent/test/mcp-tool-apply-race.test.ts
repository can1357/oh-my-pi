/**
 * Two out-of-order `tools/list` races that the per-server apply ticket alone
 * cannot resolve, because a losing response still leaves observable state
 * behind after the guard refuses its registry write.
 *
 * 1. A reconnect's `tools/list` that settles AFTER `disconnectAll()` must not
 *    resurrect the roster. `disconnectAll` clears the apply-ticket counters, so
 *    the still-outstanding reconnect response would re-claim ticket 1 on a
 *    pristine counter and restore the tools a `/mcp reload` just tore down.
 *
 * 2. A `/mcp refresh` overlapping the initial `tools/list` that answers FIRST
 *    leaves the delayed initial response to cache its obsolete definitions on
 *    the shared `connection.tools` inside `listTools()`. The apply ticket
 *    refuses the registry write, but `/status` and `listTools(connection)`
 *    consumers read `conn.tools` directly and would report the superseded
 *    count until an explicit refresh.
 *
 * Both assert an OBSERVABLE consequence — the registry a consumer sees, and the
 * count `/status` reads off `conn.tools` — never an internal counter. Each
 * losing response is awaited through a real signal the manager exposes (the
 * reconnect promise, and the `connected` status event fired on the losing
 * initial-load branch), so no guessed delay is needed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type {
	MCPServerConnection,
	MCPStdioServerConfig,
	MCPToolDefinition,
	MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";

const CONFIG: MCPStdioServerConfig = { type: "stdio", command: "fake-mcp-server" };

const TOOL_A: MCPToolDefinition = { name: "alpha", inputSchema: { type: "object" } };
const TOOL_B: MCPToolDefinition = { name: "beta", inputSchema: { type: "object" } };

class FakeTransport implements MCPTransport {
	connected = true;
	onClose?: () => void;
	request<T>(): Promise<T> {
		throw new Error("unexpected transport request");
	}
	async notify(): Promise<void> {}
	async close(): Promise<void> {
		this.connected = false;
	}
}

function fakeConnection(name: string): MCPServerConnection {
	return {
		name,
		config: CONFIG,
		transport: new FakeTransport(),
		serverInfo: { name: "fake", version: "1.0.0" },
		capabilities: { tools: {} },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MCP tool-apply race after teardown", () => {
	it("does not restore the roster from a reconnect that settles after disconnectAll", async () => {
		const manager = new MCPManager(process.cwd());
		manager.setEmptyToolsetRetryScheduleForTests("0");

		const conn1 = fakeConnection("server");
		const conn2 = fakeConnection("server");
		const reconnectListing = Promise.withResolvers<MCPToolDefinition[]>();
		const reconnectStarted = Promise.withResolvers<void>();

		vi.spyOn(mcpClient, "connectToServer").mockResolvedValueOnce(conn1).mockResolvedValueOnce(conn2);
		// Initial list wins; the reconnect's list is held open so a `/mcp reload`
		// (disconnectAll) can land while it is in flight. Mirror the real client's
		// side effect of caching the result on `connection.tools`.
		vi.spyOn(mcpClient, "listTools").mockImplementation(async (connection: MCPServerConnection) => {
			if (connection === conn1) {
				connection.tools = [TOOL_A];
				return [TOOL_A];
			}
			reconnectStarted.resolve();
			const tools = await reconnectListing.promise;
			connection.tools = tools;
			return tools;
		});

		try {
			await manager.connectServers({ server: CONFIG }, {});
			expect(manager.getTools().map(t => t.mcpToolName)).toEqual(["alpha"]);

			// A transport drop kicks off the reconnect; its `tools/list` parks on
			// the gate with `conn2` already installed in the manager.
			const reconnecting = manager.reconnectServer("server");
			await reconnectStarted.promise;
			expect(manager.getConnection("server")).toBe(conn2);

			// `/mcp reload` tears everything down while the reconnect list is still
			// outstanding: the ticket counters are cleared here.
			await manager.disconnectAll();
			expect(manager.getTools()).toEqual([]);

			// The stale reconnect response finally arrives with a fuller roster.
			// Awaiting the reconnect promise runs its identity check to completion.
			reconnectListing.resolve([TOOL_A, TOOL_B]);
			await reconnecting;

			// It must NOT re-register anything on the torn-down manager.
			expect(manager.getTools()).toEqual([]);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getConnectionStatus("server")).toBe("disconnected");
		} finally {
			reconnectListing.resolve([]);
			await manager.disconnectAll();
		}
	}, 10_000);

	it("does not restore the roster from an initial list that settles after disconnectServer", async () => {
		// The FOREGROUND apply in `connectServers` (the 250 ms startup race). A
		// `disconnectServer` lands while the initial `tools/list` is still in
		// flight: it removes the connection but leaves the apply-ticket counter,
		// so the ticket guard still passes and the fulfilled task restored the
		// disconnected server's roster. The identity re-check must refuse it.
		const manager = new MCPManager(process.cwd());
		manager.setEmptyToolsetRetryScheduleForTests("0");

		const conn = fakeConnection("server");
		const initialListing = Promise.withResolvers<MCPToolDefinition[]>();
		const listStarted = Promise.withResolvers<void>();

		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(conn);
		// The initial list parks on a gate with `conn` already registered, so a
		// `disconnectServer` can tear it down while the list is outstanding.
		vi.spyOn(mcpClient, "listTools").mockImplementation(async (connection: MCPServerConnection) => {
			listStarted.resolve();
			const tools = await initialListing.promise;
			connection.tools = tools;
			return tools;
		});

		try {
			// Fire the connect; it parks at the startup race awaiting the gated list.
			const connecting = manager.connectServers({ server: CONFIG }, {});
			await listStarted.promise;
			expect(manager.getConnection("server")).toBe(conn);

			// The server is disconnected while its initial list is still in flight.
			await manager.disconnectServer("server");
			expect(manager.getConnection("server")).toBeUndefined();

			// The stale response now fulfills within the same race window. The
			// foreground apply sees a fulfilled task, but its connection is gone.
			initialListing.resolve([TOOL_A, TOOL_B]);
			await connecting;

			// The disconnected server's tools must NOT come back.
			expect(manager.getTools()).toEqual([]);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getConnectionStatus("server")).toBe("disconnected");
		} finally {
			initialListing.resolve([]);
			await manager.disconnectAll();
		}
	}, 10_000);

	it("restores conn.tools to the winning roster when a delayed initial list loses to a refresh", async () => {
		const manager = new MCPManager(process.cwd());
		manager.setEmptyToolsetRetryScheduleForTests("0");

		const conn = fakeConnection("server");
		const initialListing = Promise.withResolvers<MCPToolDefinition[]>();
		const connectionRegistered = Promise.withResolvers<void>();
		let listCall = 0;

		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(conn);
		// Call 1 is the initial connect load (held open). Call 2 is the refresh,
		// which answers first with the fuller roster. Each caches its own result
		// on `connection.tools`, exactly as the real client does.
		vi.spyOn(mcpClient, "listTools").mockImplementation(async (connection: MCPServerConnection) => {
			listCall += 1;
			if (listCall === 1) {
				connectionRegistered.resolve();
				const tools = await initialListing.promise;
				connection.tools = tools;
				return tools;
			}
			connection.tools = [TOOL_A, TOOL_B];
			return [TOOL_A, TOOL_B];
		});

		// The losing initial-load branch fires the single `connected` status event
		// for this server (the refresh path emits none) after it restores the
		// roster. Await that instead of a guessed delay.
		const initialApplied = Promise.withResolvers<void>();
		manager.addConnectionStatusListener((event: McpConnectionStatusEvent) => {
			if (event.type === "connected" && event.serverName === "server") initialApplied.resolve();
		});

		try {
			// Fire the connect but leave its `tools/list` parked; the connection is
			// registered so a concurrent refresh can find it.
			void manager.connectServers({ server: CONFIG }, {});
			await connectionRegistered.promise;

			// `/mcp refresh` overlaps the initial load and answers first, taking the
			// later ticket and installing [alpha, beta].
			await manager.refreshServerTools("server");
			expect(manager.getTools().map(t => t.mcpToolName)).toEqual(["alpha", "beta"]);
			expect(conn.tools).toHaveLength(2);

			// The delayed initial `tools/list` now returns the older single-tool
			// roster. `listTools()` caches it on `conn.tools`; the apply ticket
			// refuses the registry write, and the losing branch fires `connected`.
			initialListing.resolve([TOOL_A]);
			await initialApplied.promise;

			// The registry still holds the refresh's roster...
			expect(manager.getTools().map(t => t.mcpToolName)).toEqual(["alpha", "beta"]);
			// ...and `/status` (which reads `conn.tools`) must agree, not report the
			// superseded single-tool count the losing response cached.
			expect(conn.tools).toHaveLength(2);
			expect((conn.tools ?? []).map(t => t.name)).toEqual(["alpha", "beta"]);
		} finally {
			initialListing.resolve([]);
			await manager.disconnectAll();
		}
	}, 10_000);
});
