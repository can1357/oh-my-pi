/**
 * `MCPManager` on a scripted MCP host: what it reports and does when links
 * re-attach, credentials are refused, reloads fail or servers are disabled
 * mid-connect. The host's side of every tunnel is played by the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeHostError, MCP_RESTART_METHOD, MCP_STATUS_METHOD } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { HostLink } from "@oh-my-pi/pi-coding-agent/mcp/link";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { reconnectMcpManagerServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { FakeHost, type FakeTunnel, type Message, paramsOf, settled, unauthorized } from "./link-fake-host";

const TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const SERVER = "srv";
const URL = "https://mcp.example.test/mcp";
const PONG = { content: [{ type: "text", text: "pong" }] };
const TOOLS = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

/** What the scripted host replies to one request: a `result`, an `error`, or nothing at all. */
type Reply = { result: unknown } | { error: unknown } | undefined;
type Answer = (message: Message, tunnel: FakeTunnel) => Reply;

describe("MCPManager on a scripted host", () => {
	let host: FakeHost;
	let manager: MCPManager;
	let workDir = "";
	let tokenFile = "";
	let answers: Record<string, Answer>;
	let events: McpConnectionStatusEvent[];
	let calls = 0;
	let savedTimeout: string | undefined;

	beforeEach(() => {
		savedTimeout = Bun.env[TIMEOUT_ENV];
		delete Bun.env[TIMEOUT_ENV];
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-link-manager-"));
		tokenFile = path.join(workDir, "token");
		fs.writeFileSync(tokenFile, "Bearer token-1");
		answers = {
			"server/discover": () => ({ result: { resultType: "complete", capabilities: { tools: {} } } }),
			"tools/list": () => ({ result: TOOLS }),
			"tools/call": () => ({ result: PONG }),
		};
		host = new FakeHost();
		host.answer = (message, tunnel) => {
			const method = message.method;
			if (typeof method !== "string" || message.id === undefined) return;
			if (method === "subscriptions/listen") {
				queueMicrotask(() => tunnel.acknowledge(message));
				return;
			}
			const reply = answers[method]?.(message, tunnel);
			if (reply) queueMicrotask(() => tunnel.push({ id: message.id, ...reply }));
		};
		manager = new MCPManager(workDir, undefined, undefined, host);
		events = [];
		manager.addConnectionStatusListener(event => events.push(event));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
		if (savedTimeout === undefined) delete Bun.env[TIMEOUT_ENV];
		else Bun.env[TIMEOUT_ENV] = savedTimeout;
	});

	/** A server whose `Authorization` header is minted by reading the token file. */
	function minted(): MCPHttpServerConfig {
		return { type: "http", url: URL, headers: { Authorization: `!cat '${tokenFile}'` } };
	}

	async function connect(config: MCPHttpServerConfig = { type: "http", url: URL }): Promise<FakeTunnel> {
		await manager.connectServers({ [SERVER]: config }, {});
		expect((await manager.waitForStartup(0)).connected).toEqual([SERVER]);
		return host.tunnel;
	}

	function ping() {
		const tool = manager.getTools().find(tool => tool.mcpServerName === SERVER);
		if (!tool) throw new Error("ping is not registered");
		return tool.execute(`call-${++calls}`, {}, noop, noCtx);
	}

	function link(): HostLink {
		const transport = manager.getConnection(SERVER)?.transport;
		if (!(transport instanceof HostLink)) throw new Error("server has no link");
		return transport;
	}

	function authorization(tunnel: FakeTunnel): string | undefined {
		const spec = tunnel.request.spec;
		return spec.transport === "stdio" ? undefined : spec.headers.Authorization;
	}

	function restarts(tunnel: FakeTunnel): Message[] {
		return tunnel.sent.filter(message => message.method === MCP_RESTART_METHOD);
	}

	function nextStatus(type: McpConnectionStatusEvent["type"]): Promise<McpConnectionStatusEvent> {
		const { promise, resolve } = Promise.withResolvers<McpConnectionStatusEvent>();
		const stop = manager.addConnectionStatusListener(event => {
			if (event.type !== type) return;
			stop();
			resolve(event);
		});
		return promise;
	}

	/** Refuse `method` with a 401 on the given tunnels, answer it normally on every other. */
	function refuseOn(method: string, refused: Set<FakeTunnel>): void {
		const normally = answers[method];
		answers[method] = (message, tunnel) =>
			refused.has(tunnel) ? { error: encodeHostError(unauthorized()) } : normally?.(message, tunnel);
	}

	it("does not call a server connected when the reload after a re-attach failed", async () => {
		const first = await connect();
		answers["tools/list"] = () => ({ error: { code: -32603, message: "catalog unavailable" } });
		const failed = nextStatus("failed");

		first.drop();
		await failed;
		const startup = await manager.waitForStartup(0);

		// Attached again and still holding the tools it had, but nothing was loaded on this attachment.
		expect(link().connected).toBe(true);
		expect(manager.getTools()).toHaveLength(1);
		expect(manager.getConnectionStatus(SERVER)).toBe("disconnected");
		expect(startup.connected).toEqual([]);
		expect(startup.failed).toEqual([{ name: SERVER, error: expect.stringContaining("catalog unavailable") }]);

		answers["tools/list"] = () => ({ result: TOOLS });
		expect(await manager.reconnectServer(SERVER)).not.toBeNull();
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
		expect((await manager.waitForStartup(0)).connected).toEqual([SERVER]);
	});

	it("reports a server whose link cannot re-attach as unavailable while its tools stay registered", async () => {
		const first = await connect();
		host.attachFailure = new Error("host unreachable");
		const failed = nextStatus("failed");

		first.drop();
		expect(await failed).toMatchObject({ serverName: SERVER, error: expect.stringContaining("host unreachable") });
		const startup = await manager.waitForStartup(0);

		expect(manager.getConnectionStatus(SERVER)).toBe("disconnected");
		expect(startup.connected).toEqual([]);
		expect(startup.failed.map(entry => entry.name)).toEqual([SERVER]);
		expect(manager.getTools()).toHaveLength(1);
	});

	/** A manager whose config discovery finds `config` as the only server. */
	function discovering(config: MCPHttpServerConfig): MCPManager {
		return new MCPManager(
			workDir,
			async () => ({ configs: { [SERVER]: config }, sources: {}, exaApiKeys: [] }),
			undefined,
			host,
		);
	}

	it("names a startup server's tools while its first mount runs, never a later reconnect's", async () => {
		manager = discovering({ type: "http", url: URL });
		const seen: boolean[] = [];
		manager.setOnToolsChanged(async tools => {
			for (const tool of tools) seen.push(manager.isStartupMount(tool.name));
		});
		await manager.discoverAndConnect({ startup: true });
		await manager.waitForStartup(0);

		// The first mount ran inside the startup; once it is done, the server is past it.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every(Boolean)).toBe(true);
		const [tool] = manager.getTools();
		expect(manager.isStartupMount(tool!.name)).toBe(false);

		seen.length = 0;
		expect(await manager.reconnectServer(SERVER)).not.toBeNull();
		await settled();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.some(Boolean)).toBe(false);
	});

	it("keeps a timed-out startup connect's retry in the startup until the refresh it starts is done", async () => {
		// The first discovery never answers, so the startup connect times out and retries; the retry is answered.
		const answered = answers["server/discover"];
		let discovers = 0;
		answers["server/discover"] = (message, tunnel) => (++discovers === 1 ? undefined : answered?.(message, tunnel));
		// A real 50 ms connect timeout: the timeout is what starts the retry under test.
		manager = discovering({ type: "http", url: URL, timeout: 50 });
		const refreshing = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		manager.setOnToolsChanged(async tools => {
			const [tool] = tools;
			if (!tool) return;
			refreshing.resolve(tool.name);
			await release.promise;
		});
		await manager.discoverAndConnect({ startup: true });

		// The retry mounted the tools and settled; the owner's refresh it fired is still running: still the startup.
		const name = await refreshing.promise;
		await settled();
		expect(manager.isStartupMount(name)).toBe(true);
		release.resolve();
		await settled();
		expect(manager.isStartupMount(name)).toBe(false);
	});

	it("does not claim a server an earlier connect already brought up for the startup", async () => {
		// `/extensions` enabled the server before the deferred startup discovery found it.
		manager = discovering({ type: "http", url: URL });
		await manager.connectServers({ [SERVER]: { type: "http", url: URL } }, {});
		await manager.waitForStartup(0);
		await manager.discoverAndConnect({ startup: true });
		await manager.waitForStartup(0);

		const [tool] = manager.getTools();
		expect(manager.isStartupMount(tool!.name)).toBe(false);
	});

	it("still names a startup tool the server removed while its first mount runs", async () => {
		manager = discovering({ type: "http", url: URL });
		const mounted = Promise.withResolvers<string>();
		const release = Promise.withResolvers<void>();
		manager.setOnToolsChanged(async tools => {
			const [tool] = tools;
			if (!tool) return;
			mounted.resolve(tool.name);
			await release.promise;
		});
		await manager.discoverAndConnect({ startup: true });
		const name = await mounted.promise;

		// The server drops the tool before the first mount's refresh is done.
		answers["tools/list"] = () => ({ result: { tools: [] } });
		const refresh = manager.refreshServerTools(SERVER);
		await settled();
		expect(manager.getTools()).toHaveLength(0);
		expect(manager.isStartupMount(name)).toBe(true);
		release.resolve();
		await refresh;
	});

	it("reports a reauth reconnect by its outcome, not by the link being attached", async () => {
		const config: MCPHttpServerConfig = { type: "http", url: URL };
		await connect(config);
		answers["tools/list"] = () => ({ error: { code: -32603, message: "catalog unavailable" } });

		expect(await reconnectMcpManagerServer(manager, SERVER, config)).toBe("disconnected");
		expect(link().connected).toBe(true);
	});

	it("gives the unit back when a server is disabled while it connects, and ignores what its link still reports", async () => {
		// The host attaches, then the server never answers discovery; no timeout would end the connect.
		answers["server/discover"] = () => undefined;
		const connecting = manager.connectServers({ [SERVER]: { type: "http", url: URL, timeout: 0 } }, {}, undefined, 1);
		const tunnel = await host.attached(1);
		tunnel.push({ method: MCP_STATUS_METHOD, params: { era: "modern", state: "starting", links: 1 } });
		expect(manager.getServerRuntime(SERVER)).toMatchObject({ state: "starting" });
		await connecting;

		await manager.disconnectServer(SERVER);
		await settled();

		expect(tunnel.closed).toBe(true);
		expect(tunnel.released).toBe(true);
		tunnel.push({ method: MCP_STATUS_METHOD, params: { era: "modern", state: "running", pid: 7, links: 1 } });
		expect(manager.getServerRuntime(SERVER)).toBeUndefined();
		expect(manager.getConnectionStatus(SERVER)).toBe("disconnected");
		expect(events.filter(event => event.type === "failed")).toEqual([]);
	});

	it("restarts the upstream on a manual reconnect only, and moves the link instead when the host is elsewhere", async () => {
		const first = await connect();

		expect(await manager.reconnectServer(SERVER)).not.toBeNull();
		expect(restarts(first)).toHaveLength(0);
		expect(await manager.reconnectServer(SERVER, { manual: true })).not.toBeNull();
		expect(restarts(first)).toHaveLength(1);
		expect(host.tunnels).toHaveLength(1);

		// `mcp.shared` was toggled: the server now belongs on another host.
		vi.spyOn(link(), "hostMoved").mockResolvedValue(true);
		expect(await manager.reconnectServer(SERVER, { manual: true })).not.toBeNull();

		expect(host.tunnels).toHaveLength(2);
		expect(first.released).toBe(true);
		expect(restarts(first)).toHaveLength(1);
		expect(restarts(host.tunnel)).toHaveLength(0);
		expect(manager.getConnectionStatus(SERVER)).toBe("connected");
	});

	it("restarts a handshake-era upstream whose session expired, never a shared modern one", async () => {
		const tunnel = await connect();

		tunnel.push({ method: MCP_STATUS_METHOD, params: { era: "modern", state: "running", links: 2 } });
		expect(await manager.reconnectServer(SERVER, { staleSession: true })).not.toBeNull();
		expect(restarts(tunnel)).toHaveLength(0);

		tunnel.push({ method: MCP_STATUS_METHOD, params: { era: "legacy", state: "running", links: 1 } });
		expect(await manager.reconnectServer(SERVER, { staleSession: true })).not.toBeNull();
		expect(restarts(tunnel)).toHaveLength(1);
		expect(host.tunnels).toHaveLength(1);
	});

	it("refreshes a token the era probe refuses on the first connect", async () => {
		// The server rotated its token after omp read the old one.
		host.onResolve = () => fs.writeFileSync(tokenFile, "Bearer token-2");
		host.resolveFailures.push(unauthorized());

		const tunnel = await connect(minted());

		expect(host.resolved.map(spec => (spec.transport === "stdio" ? undefined : spec.headers.Authorization))).toEqual([
			"Bearer token-1",
			"Bearer token-2",
		]);
		expect(authorization(tunnel)).toBe("Bearer token-2");
	});

	it("recovers from a 401 only once the server's config has refreshable credentials", async () => {
		const literal: MCPHttpServerConfig = { type: "http", url: URL, headers: { Authorization: "Bearer literal" } };
		const first = await connect(literal);
		const refused = new Set([first]);
		refuseOn("tools/call", refused);

		// A literal header cannot be refreshed: the refusal is the result.
		expect((await ping()).details?.isError).toBe(true);
		expect(host.tunnels).toHaveLength(1);

		// `/mcp reauth` moved the server to minted credentials; the same link must now recover.
		await manager.updateServerConfig(SERVER, minted());
		expect(await manager.reconnectServer(SERVER, { manual: true })).not.toBeNull();
		const second = host.tunnel;
		expect(authorization(second)).toBe("Bearer token-1");
		refused.add(second);
		fs.writeFileSync(tokenFile, "Bearer token-2");

		const recovered = await ping();

		expect(recovered.details?.isError).toBeFalsy();
		expect(recovered.content[0]).toEqual({ type: "text", text: "pong" });
		expect(host.tunnels).toHaveLength(3);
		expect(authorization(host.tunnel)).toBe("Bearer token-2");
	});

	it("refreshes once when the reload after a refresh is refused as well", async () => {
		const first = await connect(minted());
		refuseOn("tools/call", new Set([first]));
		// Whatever is minted, the server refuses to describe itself to it.
		const normally = answers["server/discover"];
		answers["server/discover"] = (message, tunnel) =>
			tunnel === first ? normally?.(message, tunnel) : { error: encodeHostError(unauthorized()) };
		const failed = nextStatus("failed");
		fs.writeFileSync(tokenFile, "Bearer token-2");

		const result = await ping();
		await failed;
		await settled();

		// One refresh served the call; the refused reload ended the recovery instead of minting again.
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
		expect(host.tunnels).toHaveLength(2);
		expect(manager.getConnectionStatus(SERVER)).toBe("disconnected");
	});

	it("watches the new identity's resources after a credential refresh, none of the old one's", async () => {
		answers["server/discover"] = () => ({
			result: { resultType: "complete", capabilities: { tools: {}, resources: { subscribe: true } } },
		});
		answers["resources/templates/list"] = () => ({ result: { resourceTemplates: [] } });
		answers["resources/list"] = (_message, tunnel) => ({
			result: {
				resources: [{ uri: tunnel === host.tunnels[0] ? "res://old-account" : "res://new-account", name: "doc" }],
			},
		});
		const resourceListen = async (tunnel: FakeTunnel): Promise<unknown> => {
			for (;;) {
				const filter = paramsOf({ params: paramsOf(await tunnel.next("subscriptions/listen")).notifications });
				if (filter.resourceSubscriptions !== undefined) return filter.resourceSubscriptions;
			}
		};
		manager.setNotificationsEnabled(true);
		const first = await connect(minted());
		expect(await resourceListen(first)).toEqual(["res://old-account"]);

		refuseOn("tools/call", new Set([first]));
		fs.writeFileSync(tokenFile, "Bearer token-2");
		await ping();
		const second = host.tunnel;

		expect(second).not.toBe(first);
		expect(await resourceListen(second)).toEqual(["res://new-account"]);
		await settled();
		const watched = second.sent
			.filter(message => message.method === "subscriptions/listen")
			.map(message => paramsOf({ params: paramsOf(message).notifications }).resourceSubscriptions);
		expect(watched.flat()).not.toContain("res://old-account");
	});
});
