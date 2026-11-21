import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as configValue from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerCapabilities, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { TOOL_NAME as DELAYED_TOOL_NAME } from "./fixtures/delayed-tool-mcp";
import { FakeHost } from "./mcp-host/link-fake-host";

const CONFIG: MCPStdioServerConfig = {
	type: "stdio",
	command: "fake-mcp-server",
};

/** The real connect, taken before any test replaces it. */
const connectToServer = mcpClient.connectToServer;
const TEMPLATES_LIST = "resources/templates/list";

/**
 * One server played by a scripted MCP host. Connections to it are real down
 * to the link; the test decides how the server's catalog requests answer.
 */
class ScriptedServer {
	readonly host = new FakeHost();
	/** Make `resources/templates/list` fail with this message, an error other than "method not found". */
	templatesError?: string;
	/** Hold `resources/templates/list` until this settles. */
	templatesGate?: Promise<void>;
	/** Fires on each `resources/templates/list` request. */
	onTemplatesRequest?: () => void;

	constructor(capabilities: MCPServerCapabilities = { tools: {} }) {
		this.host.answer = (request, tunnel) => {
			const reply = (result: Record<string, unknown>) => {
				queueMicrotask(() => tunnel.push({ id: request.id, result }));
			};
			switch (request.method) {
				case "server/discover":
					reply({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities });
					break;
				case "subscriptions/listen":
					queueMicrotask(() => tunnel.acknowledge(request));
					break;
				case "resources/list":
					reply({ resources: [{ uri: "test://doc", name: "doc" }] });
					break;
				case TEMPLATES_LIST: {
					this.onTemplatesRequest?.();
					const message = this.templatesError;
					if (message) {
						queueMicrotask(() => tunnel.push({ id: request.id, error: { code: -32603, message } }));
						break;
					}
					void (this.templatesGate ?? Promise.resolve()).then(() =>
						reply({ resourceTemplates: [{ uriTemplate: "test://{id}", name: "by-id" }] }),
					);
					break;
				}
			}
		};
	}

	/** A live connection to the server on a tunnel of its own: `host.tunnels` lists them in connect order. */
	connect(): Promise<mcpClient.HostedMCPConnection> {
		return connectToServer("server", CONFIG, { access: this.host });
	}

	/** How many `method` requests reached the server, over every connection. */
	requests(method: string): number {
		return this.host.tunnels.flatMap(tunnel => tunnel.sent).filter(request => request.method === method).length;
	}
}

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeLocalMcpHost();
});

describe("MCPManager initial connection ownership", () => {
	it("closes a connection that resolves after disconnectAll", async () => {
		const manager = new MCPManager(process.cwd());
		const server = new ScriptedServer();
		const stale = await server.connect();
		const deferred = Promise.withResolvers<mcpClient.HostedMCPConnection>();
		const connectStarted = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(() => {
			connectStarted.resolve();
			return deferred.promise;
		});
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		const loading = manager.connectServers({ server: CONFIG }, {});
		await connectStarted.promise;
		await manager.disconnectAll();
		deferred.resolve(stale);
		await loading;

		expect(server.host.tunnel.released).toBe(true);
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
		const retryGate = Promise.withResolvers<mcpClient.HostedMCPConnection>();
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
		const firstDeferred = Promise.withResolvers<mcpClient.HostedMCPConnection>();
		const secondDeferred = Promise.withResolvers<mcpClient.HostedMCPConnection>();
		const firstStarted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const server = new ScriptedServer();
		const stale = await server.connect();
		const current = await server.connect();
		const [staleTunnel, currentTunnel] = server.host.tunnels;
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

		firstDeferred.resolve(stale);
		await firstLoad;
		secondDeferred.resolve(current);
		await secondLoad;

		expect(staleTunnel?.released).toBe(true);
		expect(currentTunnel?.released).toBe(false);
		expect(manager.getConnectedServers()).toEqual(["server"]);
		await manager.disconnectAll();
	});

	it("reports a tools/list failure and re-enables connects even when close hangs", async () => {
		const manager = new MCPManager(process.cwd());
		const failed = await new ScriptedServer().connect();
		const stuckClose = Promise.withResolvers<void>();
		const close = vi.spyOn(failed.transport, "close").mockReturnValue(stuckClose.promise);
		const connectSpy = vi
			.spyOn(mcpClient, "connectToServer")
			.mockResolvedValueOnce(failed)
			.mockRejectedValue(new Error("second connect refused"));
		vi.spyOn(mcpClient, "listTools").mockRejectedValueOnce(new Error("initial tools/list failed"));

		// close() never settles, but the failure must still surface and clear
		// pending state so the server is not silently skipped forever.
		const result = await manager.connectServers({ server: CONFIG }, {});
		expect(result.errors.get("server")).toBe("initial tools/list failed");
		expect(close).toHaveBeenCalledTimes(1);
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
		const connect = mcpClient.connectToServer;
		const connectStarted = Promise.withResolvers<void>();
		const connectSpy = vi.spyOn(mcpClient, "connectToServer").mockImplementation((...args) => {
			connectStarted.resolve();
			return connect(...args);
		});
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: [hangFixture],
			env: { PROBE: "!echo probe" },
		};

		try {
			await manager.connectServers({ hang: config }, {}, undefined, 200);
			// The initial connect starts once its `!command` credential resolves, which
			// can outlast the startup window on a loaded host; wait for it, not a timer.
			await connectStarted.promise;
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
		const server = new ScriptedServer({ tools: {}, resources: {} });
		const templates = Promise.withResolvers<void>();
		const templatesRequested = Promise.withResolvers<void>();
		server.templatesGate = templates.promise;
		server.onTemplatesRequest = templatesRequested.resolve;
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(await server.connect());
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);
		const listResources = mcpClient.listResources;
		const resourcesListed = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "listResources").mockImplementation(async (...args) => {
			const resources = await listResources(...args);
			resourcesListed.resolve();
			return resources;
		});

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await manager.waitForStartup(0);
			// `resources/list` has answered; `resources/templates/list` is held open.
			await resourcesListed.promise;
			await templatesRequested.promise;
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
			expect(server.requests(TEMPLATES_LIST)).toBe(1);
			expect(server.requests("resources/list")).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("retries only the templates of a catalog whose template listing failed transiently", async () => {
		const manager = new MCPManager(process.cwd());
		const server = new ScriptedServer({ tools: {}, resources: {} });
		server.templatesError = "templates unavailable";
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(await server.connect());
		vi.spyOn(mcpClient, "listTools").mockResolvedValue([]);

		try {
			await manager.connectServers({ server: CONFIG }, {});
			await manager.waitForStartup(0);
			// Settles the startup listing, whose templates failed.
			await manager.ensureServerResources("server");
			expect(manager.getServerResources("server")?.templates).toEqual([]);
			const failedListings = server.requests(TEMPLATES_LIST);

			// A later miss asks for the templates again.
			await manager.ensureServerResources("server");
			expect(server.requests(TEMPLATES_LIST)).toBe(failedListings + 1);

			server.templatesError = undefined;
			// Concurrent misses share one template retry.
			await Promise.all([manager.ensureServerResources("server"), manager.ensureServerResources("server")]);
			expect(server.requests(TEMPLATES_LIST)).toBe(failedListings + 2);
			expect(manager.getServerResources("server")).toEqual({
				resources: [{ uri: "test://doc", name: "doc" }],
				templates: [{ uriTemplate: "test://{id}", name: "by-id" }],
			});
			expect(server.requests("resources/list")).toBe(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("keeps a catalog whose template listing failed instead of listing its resources again", async () => {
		const manager = new MCPManager(process.cwd());
		const server = new ScriptedServer({ tools: {}, resources: {} });
		server.templatesError = "templates unavailable";
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(await server.connect());
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
			expect(server.requests("resources/list")).toBe(1);
			expect(manager.getServerResources("server")?.resources.map(r => r.uri)).toEqual(["test://doc"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	it("keeps a catalog a read loaded before the post-handshake load instead of listing it again", async () => {
		const manager = new MCPManager(process.cwd());
		const server = new ScriptedServer({ tools: {}, resources: {} });
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(await server.connect());
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
			expect(server.requests("resources/list")).toBe(1);
			expect(manager.getServerResources("server")?.resources.map(r => r.uri)).toEqual(["test://doc"]);
		} finally {
			await manager.disconnectAll();
		}
	});
});
