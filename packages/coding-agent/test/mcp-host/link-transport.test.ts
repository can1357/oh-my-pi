import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MCPProgress } from "@oh-my-pi/pi-coding-agent/tools/mcp-progress";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import {
	encodeHostError,
	MCP_ROOTS_METHOD,
	MCP_STATUS_METHOD,
	type McpUpstreamStatus,
} from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { HostLink, type HostLinkOptions } from "@oh-my-pi/pi-coding-agent/mcp/link";
import { MCP_CLIENT_INFO, MCP_PROTOCOL_VERSION, MCPMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { rejectionOf } from "../helpers/rejection";
import { FakeHost, metaOf, paramsOf, REMOTE_SPEC, settled } from "./link-fake-host";

const TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const ROOTS = [{ uri: "file:///work/project", name: "project" }];

describe("HostLink", () => {
	let host: FakeHost;
	let links: HostLink[];
	let savedTimeout: string | undefined;

	beforeEach(() => {
		host = new FakeHost();
		links = [];
		savedTimeout = Bun.env[TIMEOUT_ENV];
		delete Bun.env[TIMEOUT_ENV];
	});

	afterEach(async () => {
		for (const link of links) await link.close();
		if (savedTimeout === undefined) delete Bun.env[TIMEOUT_ENV];
		else Bun.env[TIMEOUT_ENV] = savedTimeout;
	});

	async function connected(options?: Partial<HostLinkOptions>): Promise<HostLink> {
		const link = new HostLink({
			name: "fixture",
			spec: REMOTE_SPEC,
			instance: "manager-1",
			roots: () => ROOTS,
			idleMs: 1_000,
			access: host,
			...options,
		});
		links.push(link);
		await link.connect();
		return link;
	}

	function transportFailure(error: unknown): MCPTransportError {
		if (!(error instanceof MCPTransportError)) throw new Error(`expected an MCPTransportError, got ${String(error)}`);
		return error;
	}

	it("attaches as its manager and announces its roots", async () => {
		const link = await connected();

		expect(link.connected).toBe(true);
		expect(host.resolved).toEqual([REMOTE_SPEC]);
		expect(host.tunnel.request).toEqual({
			spec: REMOTE_SPEC,
			era: "modern",
			name: "fixture",
			instance: "manager-1",
			idleMs: 1_000,
		});
		expect(paramsOf(await host.tunnel.next(MCP_ROOTS_METHOD))).toEqual({ roots: ROOTS });
	});

	it("sends the revision, capabilities and identity on every request and keeps caller metadata", async () => {
		const link = await connected();

		const pending = link.request("tools/list", { cursor: "c1", _meta: { "omp/cache": "stale-ok" } });
		const request = await host.tunnel.next("tools/list");
		host.tunnel.push({ id: request.id, result: { tools: [] } });

		expect(await pending).toEqual({ tools: [] });
		expect(request.jsonrpc).toBe("2.0");
		expect(paramsOf(request).cursor).toBe("c1");
		expect(metaOf(request)).toEqual({
			"omp/cache": "stale-ok",
			[MCPMeta.protocolVersion]: MCP_PROTOCOL_VERSION,
			[MCPMeta.clientCapabilities]: { roots: {} },
			[MCPMeta.clientInfo]: MCP_CLIENT_INFO,
		});
		expect(metaOf(request).progressToken).toBeUndefined();
	});

	it("routes progress to the request that asked for it and status to its owner", async () => {
		const link = await connected();
		const statuses: McpUpstreamStatus[] = [];
		const other: string[] = [];
		link.onStatus = status => statuses.push(status);
		link.onNotification = method => other.push(method);

		const progress: MCPProgress[] = [];
		const pending = link.request("tools/call", { name: "slow" }, { onProgress: step => progress.push(step) });
		const request = await host.tunnel.next("tools/call");
		const token = metaOf(request).progressToken;
		host.tunnel.push({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
		host.tunnel.push({ method: "notifications/progress", params: { progressToken: "someone-else", progress: 9 } });
		host.tunnel.push({ method: MCP_STATUS_METHOD, params: { era: "modern", state: "running", pid: 42, links: 2 } });
		host.tunnel.push({ method: "notifications/tools/list_changed", params: {} });
		host.tunnel.push({ id: request.id, result: { content: [] } });
		await pending;

		expect(token).toBeDefined();
		expect(progress).toEqual([{ progress: 1, total: 2 }]);
		expect(statuses).toEqual([{ era: "modern", state: "running", pid: 42, links: 2 }]);
		expect(link.status?.pid).toBe(42);
		expect(other).toEqual(["notifications/tools/list_changed"]);
	});

	it("cancels the request on the host when its deadline passes", async () => {
		// The deadline is a real timer inside the link; 20 ms keeps the wait negligible.
		const link = await connected({ timeout: 20 });

		const error = transportFailure(await rejectionOf(link.request("tools/list")));
		const request = await host.tunnel.next("tools/list");
		const cancelled = await host.tunnel.next("notifications/cancelled");

		expect(error.failure).toBe("timeout");
		expect(error.retryable).toBe(false);
		expect(error.message).toBe("Request timeout after 20ms");
		expect(paramsOf(cancelled).requestId).toBe(request.id);
	});

	it("withdraws a request still waiting for the tunnel instead of cancelling it on the host", async () => {
		const link = await connected();
		const tunnel = host.tunnel;
		// The line that finds the tunnel full is accepted; everything after it has to wait.
		tunnel.full = true;
		const first = link.request("tools/call", { name: "first" });
		const caller = new AbortController();
		const withdrawn = rejectionOf(link.request("tools/call", { name: "withdrawn" }, { signal: caller.signal }));
		const kept = link.request("tools/call", { name: "kept" });

		caller.abort(new Error("changed my mind"));
		expect(await withdrawn).toEqual(new Error("changed my mind"));
		tunnel.drain();
		await settled();

		const calls = tunnel.sent.filter(message => message.method === "tools/call");
		expect(calls.map(call => paramsOf(call).name)).toEqual(["first", "kept"]);
		expect(tunnel.sent.map(message => message.method)).not.toContain("notifications/cancelled");
		for (const call of calls) tunnel.push({ id: call.id, result: { content: [] } });
		expect(await Promise.all([first, kept])).toEqual([{ content: [] }, { content: [] }]);
	});

	it("rejects with the abort reason and cancels the request on the host", async () => {
		const link = await connected();
		const controller = new AbortController();
		const reason = new Error("user pressed escape");

		const pending = link.request("tools/call", { name: "slow" }, { signal: controller.signal });
		const request = await host.tunnel.next("tools/call");
		controller.abort(reason);

		expect(await rejectionOf(pending)).toBe(reason);
		expect(paramsOf(await host.tunnel.next("notifications/cancelled")).requestId).toBe(request.id);
	});

	it("rebuilds the host's transport failure as the error the upstream raised", async () => {
		const link = await connected();
		const raised = new MCPTransportError({
			transport: "stdio",
			stage: "receive",
			failure: "eof",
			message: "MCP subprocess exited with code 3 before responding",
			retryable: false,
			code: 3,
		});

		const pending = link.request("tools/call", { name: "crash" });
		const request = await host.tunnel.next("tools/call");
		host.tunnel.push({ id: request.id, error: encodeHostError(raised, { code: 3, stderr: "boom" }) });
		const error = transportFailure(await rejectionOf(pending));

		expect(error.message).toBe(raised.message);
		expect({
			transport: error.transport,
			stage: error.stage,
			failure: error.failure,
			retryable: error.retryable,
			code: error.code,
		}).toEqual({ transport: "stdio", stage: "receive", failure: "eof", retryable: false, code: 3 });
	});

	it("preserves a server's JSON-RPC error", async () => {
		const link = await connected();
		const rpc = { code: -32602, message: "Unknown tool: nope", data: { tool: "nope" } };

		const pending = link.request("tools/call", { name: "nope" });
		const request = await host.tunnel.next("tools/call");
		host.tunnel.push({ id: request.id, error: rpc });
		const error = transportFailure(await rejectionOf(pending));

		expect(error.failure).toBe("json_rpc");
		expect(error.code).toBe(-32602);
		expect(error.message).toBe("MCP error -32602: Unknown tool: nope");
		expect(error.rpc).toEqual(rpc);
		expect(error.retryable).toBe(false);
	});

	function unauthorized(status: number): MCPTransportError {
		return new MCPTransportError({
			transport: "http",
			stage: "receive",
			failure: "http_status",
			message: `HTTP ${status}: unauthorized`,
			retryable: false,
			code: status,
		});
	}

	it("refreshes credentials on a 401, retargets to them and retries the request once", async () => {
		const link = await connected();
		let refreshes = 0;
		let reattached = 0;
		link.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer new" };
		};
		link.onReattach = () => {
			reattached++;
		};

		const pending = link.request("tools/call", { name: "whoami" });
		const first = host.tunnel;
		const request = await first.next("tools/call");
		first.push({ id: request.id, error: encodeHostError(unauthorized(401)) });

		const second = await host.attached(2);
		const retry = await second.next("tools/call");
		second.push({ id: retry.id, result: { content: [{ type: "text", text: "ok" }] } });

		expect(await pending).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(refreshes).toBe(1);
		expect(reattached).toBe(1);
		expect(first.closed).toBe(true);
		expect(first.released).toBe(true);
		expect(second.request.spec).toEqual({ ...REMOTE_SPEC, headers: { Authorization: "Bearer new" } });
		expect(paramsOf(retry).name).toBe("whoami");
		expect(retry.id).not.toBe(request.id);
	});

	it("gives up after one retry when the refreshed credentials are refused too", async () => {
		const link = await connected();
		let refreshes = 0;
		link.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer new" };
		};

		const pending = link.request("tools/list");
		const first = host.tunnel;
		first.push({ id: (await first.next("tools/list")).id, error: encodeHostError(unauthorized(403)) });
		const second = await host.attached(2);
		second.push({ id: (await second.next("tools/list")).id, error: encodeHostError(unauthorized(403)) });

		expect(transportFailure(await rejectionOf(pending)).code).toBe(403);
		expect(refreshes).toBe(1);
		expect(host.tunnels).toHaveLength(2);
	});

	it("keeps the auth failure when no credentials come back", async () => {
		const link = await connected();
		link.onAuthError = async () => null;

		const pending = link.request("tools/list");
		host.tunnel.push({ id: (await host.tunnel.next("tools/list")).id, error: encodeHostError(unauthorized(401)) });

		expect(transportFailure(await rejectionOf(pending)).code).toBe(401);
		expect(host.tunnels).toHaveLength(1);
		expect(link.connected).toBe(true);
	});

	it("fails in-flight requests when the tunnel drops, then re-attaches and tells its owner", async () => {
		const link = await connected();
		let reattached = 0;
		let closed = 0;
		link.onReattach = () => {
			reattached++;
		};
		link.onClose = () => closed++;

		const pending = link.request("tools/call", { name: "slow" });
		const first = host.tunnel;
		await first.next("tools/call");
		first.drop("daemon went away");
		const error = transportFailure(await rejectionOf(pending));

		expect(error.failure).toBe("closed");
		expect(error.retryable).toBe(false);
		expect(error.message).toContain("daemon went away");

		const second = await host.attached(2);
		expect(paramsOf(await second.next(MCP_ROOTS_METHOD))).toEqual({ roots: ROOTS });
		expect(second.request.instance).toBe("manager-1");

		// A request issued while the new attachment is being taken waits for it.
		const after = link.request("tools/list");
		second.push({ id: (await second.next("tools/list")).id, result: { tools: [] } });
		expect(await after).toEqual({ tools: [] });
		expect(reattached).toBe(1);
		expect(closed).toBe(0);
		expect(first.released).toBe(true);
		expect(link.connected).toBe(true);
	});

	it("reports the loss only when it cannot re-attach, and recovers when the host comes back", async () => {
		const link = await connected();
		let reattached = 0;
		let closed = 0;
		link.onReattach = () => {
			reattached++;
		};
		link.onClose = () => closed++;

		host.attachFailure = new Error("daemon unreachable");
		host.tunnel.drop();
		const error = transportFailure(await rejectionOf(link.request("tools/list")));

		expect(error.failure).toBe("closed");
		expect(error.retryable).toBe(true);
		expect(closed).toBe(1);
		expect(reattached).toBe(0);
		expect(link.connected).toBe(false);

		host.attachFailure = undefined;
		host.replace();
		await host.attached(2);
		const pending = link.request("tools/list");
		host.tunnel.push({ id: (await host.tunnel.next("tools/list")).id, result: { tools: [] } });

		expect(await pending).toEqual({ tools: [] });
		expect(reattached).toBe(1);
		expect(closed).toBe(1);
	});

	it("restarts the upstream and re-sends roots on request", async () => {
		const link = await connected();
		await host.tunnel.next(MCP_ROOTS_METHOD);

		await link.restart();
		link.setRoots();

		expect((await host.tunnel.next("omp/restart")).id).toBeUndefined();
		expect(paramsOf(await host.tunnel.next(MCP_ROOTS_METHOD))).toEqual({ roots: ROOTS });
	});

	it("releases its lease and fails what is in flight when closed", async () => {
		const link = await connected();
		const tunnel = host.tunnel;
		const pending = link.request("tools/call", { name: "slow" });
		await tunnel.next("tools/call");

		await link.close();

		expect(transportFailure(await rejectionOf(pending)).failure).toBe("closed");
		expect(tunnel.closed).toBe(true);
		expect(tunnel.released).toBe(true);
		expect(link.connected).toBe(false);
		// A closed link ignores the loss of its tunnel instead of taking a new one.
		tunnel.drop();
		expect(link.reattaching).toBe(false);
		expect(host.tunnels).toHaveLength(1);
	});
});
