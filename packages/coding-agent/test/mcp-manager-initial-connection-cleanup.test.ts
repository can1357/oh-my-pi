import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as configValue from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConnection, MCPStdioServerConfig, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
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
	/** `resources/list` answers so far; undefined makes any request fail. */
	resourceLists?: number;
	/** Make `resources/templates/list` fail with an error other than "method not found". */
	templatesError?: Error;
	/** Hold `resources/templates/list` until this settles. */
	templatesGate?: Promise<void>;
	/** `resources/templates/list` requests so far; `onTemplatesRequest` fires on each. */
	templateLists = 0;
	onTemplatesRequest?: () => void;

	/** Make `close()` hang on the given gate to simulate a slow HTTP session DELETE. */
	gateClose(gate: Promise<void>): void {
		this.#closeGate = gate;
	}

	async request<T>(method: string): Promise<T> {
		if (this.resourceLists === undefined) throw new Error("Unexpected transport request");
		if (method === "resources/list") {
			this.resourceLists += 1;
			return { resources: [{ uri: "test://doc", name: "doc" }] } as T;
		}
		if (method === "resources/templates/list") {
			this.templateLists += 1;
			this.onTemplatesRequest?.();
			if (this.templatesError) throw this.templatesError;
			if (this.templatesGate) await this.templatesGate;
			return { resourceTemplates: [{ uriTemplate: "test://{id}", name: "by-id" }] } as T;
		}
		throw new Error(`Unexpected transport request: ${method}`);
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
			timeout: 1_000,
		};
		manager.setOnToolsChanged(tools => {
			if (tools.some(tool => tool.name === `mcp__server_${DELAYED_TOOL_NAME}`)) rebound.resolve();
		});

		try {
			const result = await manager.connectServers(
				{ server: config },
				{},
				event => {
					statusTypes.push(event.type);
					if (event.type === "connected") statusSettled.resolve();
				},
				0,
			);
			expect(result.errors.get("server")).toBe('Connection to MCP server "server" timed out after 1000ms');
			await rebound.promise;
			await statusSettled.promise;

			expect(manager.getConnectionStatus("server")).toBe("connected");
			expect(manager.getTools().map(tool => tool.name)).toEqual([`mcp__server_${DELAYED_TOOL_NAME}`]);
			expect(statusTypes).toEqual(["connecting", "failed", "reconnecting", "connected"]);
		} finally {
			await manager.disconnectAll();
			await removeWithRetries(workDir);
		}
	}, 10_000);

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

	it("aborts a handshake still in flight on disconnectAll instead of leaving it to its timeout", async () => {
		const manager = new MCPManager(process.cwd());
		const hangFixture = path.join(import.meta.dir, "fixtures", "hang-during-init-mcp.ts");
		const connect = mcpClient.connectToServer;
		const handshakes: Promise<unknown>[] = [];
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((...args) => {
			const handshake = connect(...args);
			handshakes.push(
				handshake.then(
					() => "connected",
					error => error,
				),
			);
			return handshake;
		});

		try {
			// The server never answers `initialize`; the startup window leaves it in flight.
			await manager.connectServers(
				{ hang: { type: "stdio", command: process.execPath, args: [hangFixture] } },
				{},
				undefined,
				200,
			);
			expect(handshakes).toHaveLength(1);
			await manager.disconnectAll();
			// The default connect timeout is far longer than this; only the abort can settle it.
			const outcome = await withTimeout(handshakes[0], 2_000, "handshake outlived disconnectAll");
			expect(outcome).toMatchObject({ name: "AbortError" });
		} finally {
			await manager.disconnectAll();
		}
	}, 10_000);

	it("reports only handshakes that failed before disconnectAll, not the ones it aborted", async () => {
		const manager = new MCPManager(process.cwd());
		const hangFixture = path.join(import.meta.dir, "fixtures", "hang-during-init-mcp.ts");
		const deadFailed = Promise.withResolvers<void>();

		try {
			const loading = manager.connectServers(
				{
					hang: { type: "stdio", command: process.execPath, args: [hangFixture] },
					dead: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] },
				},
				{},
				event => {
					if (event.type === "failed" && event.serverName === "dead") deadFailed.resolve();
				},
				5_000,
			);
			await deadFailed.promise;
			await manager.disconnectAll();
			const result = await withTimeout(loading, 2_000, "startup window outlived disconnectAll");
			expect([...result.errors.keys()]).toEqual(["dead"]);
			expect(result.connectedServers).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	}, 10_000);

	it("stops a reconnect still resolving its credentials on disconnectAll without starting its handshake", async () => {
		const manager = new MCPManager(process.cwd());
		const hangFixture = path.join(import.meta.dir, "fixtures", "hang-during-init-mcp.ts");
		const connectSpy = vi.spyOn(mcpClient, "connectToServer");
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [hangFixture],
			env: { PROBE: "!echo probe" },
		};

		try {
			await manager.connectServers({ hang: config }, {}, undefined, 200);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			// The reconnect is still resolving its `!command` credential when teardown runs.
			const credential = Promise.withResolvers<string | undefined>();
			vi.spyOn(configValue, "resolveConfigValue").mockImplementation(() => credential.promise);
			const reconnect = manager.reconnectServer("hang", { manual: true });
			await manager.disconnectAll();
			// Settles on the teardown alone: the credential never resolves and no handshake starts.
			expect(await withTimeout(reconnect, 2_000, "reconnect outlived disconnectAll")).toBeNull();
			expect(connectSpy).toHaveBeenCalledTimes(1);
		} finally {
			await manager.disconnectAll();
		}
	}, 10_000);

	it("settles an initial connect still resolving its credentials on disconnectAll", async () => {
		const manager = new MCPManager(process.cwd());
		const connectSpy = vi.spyOn(mcpClient, "connectToServer");
		const credential = Promise.withResolvers<string | undefined>();
		const resolving = Promise.withResolvers<void>();
		vi.spyOn(configValue, "resolveConfigValue").mockImplementation(() => {
			resolving.resolve();
			return credential.promise;
		});

		try {
			// A zero startup window waits for every initial load; only the teardown can end this one.
			const loading = manager.connectServers(
				{ server: { ...CONFIG, env: { PROBE: "!echo probe" } } },
				{},
				undefined,
				0,
			);
			await resolving.promise;
			await manager.disconnectAll();
			const result = await withTimeout(loading, 2_000, "connectServers outlived disconnectAll");
			expect(result.errors.size).toBe(0);
			expect(connectSpy).not.toHaveBeenCalled();
		} finally {
			await manager.disconnectAll();
		}
	});

	it("joins a catalog refresh whose resources landed while its templates are still listing", async () => {
		const manager = new MCPManager(process.cwd());
		const fresh = fakeConnection("server");
		fresh.connection.capabilities = { tools: {}, resources: {} };
		fresh.transport.resourceLists = 0;
		const templates = Promise.withResolvers<void>();
		const templatesRequested = Promise.withResolvers<void>();
		fresh.transport.templatesGate = templates.promise;
		fresh.transport.onTemplatesRequest = templatesRequested.resolve;
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fresh.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await manager.waitForStartup(0);
			await templatesRequested.promise;
			// `resources/list` has answered; `resources/templates/list` is held open.
			expect(fresh.connection.resources).toBeDefined();
			let settled = false;
			const ensured = manager.ensureServerResources("server").then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			templates.resolve();
			await ensured;
			expect(manager.getServerResources("server")?.templates.map(t => t.uriTemplate)).toEqual(["test://{id}"]);
			// Joined the in-flight listing rather than issuing its own.
			expect(fresh.transport.templateLists).toBe(1);
			expect(fresh.transport.resourceLists).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("retries only the templates of a catalog whose template listing failed transiently", async () => {
		const manager = new MCPManager(process.cwd());
		const fresh = fakeConnection("server");
		fresh.connection.capabilities = { tools: {}, resources: {} };
		fresh.transport.resourceLists = 0;
		fresh.transport.templatesError = new Error("HTTP 500: templates unavailable");
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fresh.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await manager.waitForStartup(0);
			await manager.ensureServerResources("server");
			expect(manager.getServerResources("server")?.templates).toEqual([]);
			// Startup listing plus one retry so far.
			expect(fresh.transport.templateLists).toBe(2);

			fresh.transport.templatesError = undefined;
			// Concurrent misses share one template retry.
			await Promise.all([manager.ensureServerResources("server"), manager.ensureServerResources("server")]);
			expect(fresh.transport.templateLists).toBe(3);
			expect(manager.getServerResources("server")).toEqual({
				resources: [{ uri: "test://doc", name: "doc" }],
				templates: [{ uriTemplate: "test://{id}", name: "by-id" }],
			});
			expect(fresh.transport.resourceLists).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("keeps a catalog whose template listing failed instead of listing its resources again", async () => {
		const manager = new MCPManager(process.cwd());
		const fresh = fakeConnection("server");
		fresh.connection.capabilities = { tools: {}, resources: {} };
		fresh.transport.resourceLists = 0;
		fresh.transport.templatesError = new Error("HTTP 500: templates unavailable");
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fresh.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const toolsHandled = Promise.withResolvers<void>();
		manager.setOnToolsChanged(() => toolsHandled.promise);

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await manager.ensureServerResources("server");
			expect(manager.getServerResources("server")).toEqual({
				resources: [{ uri: "test://doc", name: "doc" }],
				templates: [],
			});

			// Neither a later read nor the post-handshake load may blank the loaded resources.
			await manager.ensureServerResources("server");
			toolsHandled.resolve();
			await manager.waitForStartup(0);
			expect(fresh.transport.resourceLists).toBe(1);
			expect(manager.getServerResources("server")?.resources.map(r => r.uri)).toEqual(["test://doc"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("keeps a catalog a read loaded before the post-handshake load instead of listing it again", async () => {
		const manager = new MCPManager(process.cwd());
		const fresh = fakeConnection("server");
		fresh.connection.capabilities = { tools: {}, resources: {} };
		fresh.transport.resourceLists = 0;
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(fresh.connection);
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		// The startup continuation awaits the owner's tools-changed handler before it loads the
		// catalog; a resource read that arrives in that window loads it first.
		const toolsHandled = Promise.withResolvers<void>();
		manager.setOnToolsChanged(() => toolsHandled.promise);

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await manager.ensureServerResources("server");
			expect(manager.getServerResources("server")?.resources.map(r => r.uri)).toEqual(["test://doc"]);

			toolsHandled.resolve();
			await manager.waitForStartup(0);
			expect(fresh.transport.resourceLists).toBe(1);
			expect(manager.getServerResources("server")?.resources.map(r => r.uri)).toEqual(["test://doc"]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
