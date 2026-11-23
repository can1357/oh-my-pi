import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	callTool,
	connectToServer,
	disconnectServer,
	type HostedMCPConnection,
	listTools,
	type MCPConnectOptions,
	subscribeToResources,
	unsubscribeFromResources,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import { type MCPElicitRequest, MCPMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import type { MCPElicitHandler } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { rejectionOf } from "../helpers/rejection";
import { FakeHost, type FakeTunnel, type Message, metaOf, paramsOf, settled } from "./link-fake-host";

const TIMEOUT_ENV = "OMP_MCP_TIMEOUT_MS";
const ROOTS = [{ uri: "file:///work/project", name: "project" }];
const DISCOVER = {
	resultType: "complete",
	supportedVersions: ["2026-07-28"],
	capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
	instructions: "Use wisely.",
	_meta: { [MCPMeta.serverInfo]: { name: "fixture-server", version: "3.1.0" } },
};

describe("modern MCP client operations", () => {
	let host: FakeHost;
	let connections: HostedMCPConnection[];
	let savedTimeout: string | undefined;

	beforeEach(() => {
		host = new FakeHost();
		connections = [];
		savedTimeout = Bun.env[TIMEOUT_ENV];
		delete Bun.env[TIMEOUT_ENV];
		// Discovery is answered and list-change streams are acknowledged as the
		// host would; resource streams are left to each test.
		host.answer = (message, tunnel) => {
			if (message.method === "server/discover") {
				queueMicrotask(() => tunnel.push({ id: message.id, result: DISCOVER }));
			} else if (message.method === "subscriptions/listen" && !isResourceListen(message)) {
				queueMicrotask(() => tunnel.acknowledge(message));
			}
		};
	});

	afterEach(async () => {
		for (const connection of connections) await disconnectServer(connection);
		if (savedTimeout === undefined) delete Bun.env[TIMEOUT_ENV];
		else Bun.env[TIMEOUT_ENV] = savedTimeout;
	});

	function isResourceListen(message: Message): boolean {
		return paramsOf({ params: paramsOf(message).notifications }).resourceSubscriptions !== undefined;
	}

	async function connect(options?: MCPConnectOptions): Promise<HostedMCPConnection> {
		const connection = await connectToServer(
			"fixture",
			{ type: "http", url: "https://mcp.example.test/mcp" },
			{ access: host, roots: () => ROOTS, ...options },
		);
		connections.push(connection);
		return connection;
	}

	/** The next resource stream the session opens on `tunnel`. */
	async function nextResourceListen(tunnel: FakeTunnel): Promise<Message> {
		for (;;) {
			const listen = await tunnel.next("subscriptions/listen");
			if (isResourceListen(listen)) return listen;
		}
	}

	it("discovers the server from the host's store and opens the list-change stream", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		expect(metaOf(await tunnel.next("server/discover"))["omp/cache"]).toBe("stale-ok");
		expect(paramsOf(await tunnel.next("subscriptions/listen")).notifications).toEqual({
			toolsListChanged: true,
			promptsListChanged: true,
			resourcesListChanged: true,
		});
		expect(connection.serverInfo).toEqual({ name: "fixture-server", version: "3.1.0", title: undefined });
		expect(connection.capabilities).toEqual(DISCOVER.capabilities);
		expect(connection.instructions).toBe("Use wisely.");
	});

	it("delivers stream notifications to the owner as the server sent them, keeping acknowledgements to itself", async () => {
		const seen: { method: string; params: unknown }[] = [];
		await connect({ onNotification: (method, params) => seen.push({ method, params }) });
		const tunnel = host.tunnel;
		const listen = await tunnel.next("subscriptions/listen");

		tunnel.push({
			method: "notifications/tools/list_changed",
			params: { _meta: { [MCPMeta.subscriptionId]: listen.id } },
		});
		// A server-custom method rides the same stream; the stream tag is not the server's.
		tunnel.push({
			method: "notifications/custom/event",
			params: { n: 42, _meta: { [MCPMeta.subscriptionId]: listen.id, trace: "t-1" } },
		});

		expect(seen).toEqual([
			{ method: "notifications/tools/list_changed", params: {} },
			{ method: "notifications/custom/event", params: { n: 42, _meta: { trace: "t-1" } } },
		]);
	});

	it("lists every page with the stale-ok hint and memoizes the result", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const listing = listTools(connection);
		const first = await tunnel.next("tools/list");
		tunnel.push({
			id: first.id,
			result: { tools: [{ name: "a", inputSchema: { type: "object" } }], nextCursor: "page-2" },
		});
		const second = await tunnel.next("tools/list");
		tunnel.push({ id: second.id, result: { tools: [{ name: "b", inputSchema: { type: "object" } }] } });

		expect((await listing).map(tool => tool.name)).toEqual(["a", "b"]);
		expect(paramsOf(first).cursor).toBeUndefined();
		expect(paramsOf(second).cursor).toBe("page-2");
		expect(metaOf(second)["omp/cache"]).toBe("stale-ok");
		expect(await listTools(connection)).toBe(await listing);
		expect(tunnel.sent.filter(message => message.method === "tools/list")).toHaveLength(2);
	});

	it("answers a roots/list input request and retries with the server's state", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const calling = callTool(connection, "needs_roots", { depth: 2 });
		const first = await tunnel.next("tools/call");
		tunnel.push({
			id: first.id,
			result: {
				resultType: "input_required",
				inputRequests: { "ask-1": { method: "roots/list" } },
				requestState: "opaque-state",
			},
		});
		const retry = await tunnel.next("tools/call");
		tunnel.push({ id: retry.id, result: { resultType: "complete", content: [{ type: "text", text: "done" }] } });

		const result: Record<string, unknown> = { ...(await calling) };
		expect(result).toEqual({ resultType: "complete", content: [{ type: "text", text: "done" }] });
		expect(paramsOf(first).inputResponses).toBeUndefined();
		expect(paramsOf(first).requestState).toBeUndefined();
		expect(retry.id).not.toBe(first.id);
		expect(paramsOf(retry)).toMatchObject({
			name: "needs_roots",
			arguments: { depth: 2 },
			inputResponses: { "ask-1": { roots: ROOTS } },
			requestState: "opaque-state",
		});
	});

	it("retries without state when the server sent none", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const calling = callTool(connection, "needs_roots");
		const first = await tunnel.next("tools/call");
		tunnel.push({
			id: first.id,
			result: { resultType: "input_required", inputRequests: { r: { method: "roots/list" } } },
		});
		const retry = await tunnel.next("tools/call");
		tunnel.push({ id: retry.id, result: { content: [] } });
		await calling;

		expect("requestState" in paramsOf(retry)).toBe(false);
	});

	it("refuses input requests other than roots/list", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const calling = rejectionOf(callTool(connection, "ask_user"));
		const first = await tunnel.next("tools/call");
		tunnel.push({
			id: first.id,
			result: { resultType: "input_required", inputRequests: { q: { method: "elicitation/create", params: {} } } },
		});
		const error = await calling;

		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain('unsupported input "elicitation/create"');
		expect(tunnel.sent.filter(message => message.method === "tools/call")).toHaveLength(1);
		// Without a way to ask the user the call declares no elicitation, so the server was not allowed to ask.
		expect(metaOf(first)[MCPMeta.clientCapabilities]).toEqual({ roots: {} });
	});

	it("declares form elicitation on a call that can ask the user and retries with their answer", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;
		const asked: MCPElicitRequest[] = [];
		const elicit: MCPElicitHandler = async (_server, request) => {
			asked.push(request);
			return { action: "accept", content: { approve: true } };
		};

		const calling = callTool(connection, "delete_branch", { name: "old" }, { elicit });
		const first = await tunnel.next("tools/call");
		const schema: MCPElicitRequest["requestedSchema"] = {
			type: "object",
			properties: { approve: { type: "boolean" } },
			required: ["approve"],
		};
		tunnel.push({
			id: first.id,
			result: {
				resultType: "input_required",
				inputRequests: {
					confirm: { method: "elicitation/create", params: { message: "Delete it?", requestedSchema: schema } },
				},
				requestState: "pending-delete",
			},
		});
		const retry = await tunnel.next("tools/call");
		tunnel.push({ id: retry.id, result: { resultType: "complete", content: [{ type: "text", text: "deleted" }] } });
		await calling;

		expect(metaOf(first)[MCPMeta.clientCapabilities]).toEqual({ roots: {}, elicitation: { form: {} } });
		expect(asked).toEqual([{ mode: "form", message: "Delete it?", requestedSchema: schema }]);
		expect(paramsOf(retry)).toMatchObject({
			name: "delete_branch",
			arguments: { name: "old" },
			inputResponses: { confirm: { action: "accept", content: { approve: true } } },
			requestState: "pending-delete",
		});
		expect(metaOf(retry)[MCPMeta.clientCapabilities]).toEqual({ roots: {}, elicitation: { form: {} } });
	});

	it("refuses a URL-mode elicitation, which it never declares", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;
		let asked = false;
		const elicit: MCPElicitHandler = async () => {
			asked = true;
			return { action: "cancel" };
		};

		const calling = rejectionOf(callTool(connection, "login", {}, { elicit }));
		const first = await tunnel.next("tools/call");
		tunnel.push({
			id: first.id,
			result: {
				resultType: "input_required",
				inputRequests: {
					auth: {
						method: "elicitation/create",
						params: { mode: "url", message: "Sign in", url: "https://idp.example.test", elicitationId: "e1" },
					},
				},
			},
		});

		expect(String(await calling)).toContain('elicitation on tools/call in undeclared mode "url"');
		expect(asked).toBe(false);
		expect(tunnel.sent.filter(message => message.method === "tools/call")).toHaveLength(1);
	});

	it("refuses a form whose fields form mode does not allow before anything reaches the user", async () => {
		const malformed: Record<string, unknown>[] = [
			{ broken: null },
			{ picks: { type: "array" } },
			{ count: { type: "integer", minimum: '1" onfocus="x' } },
		];
		for (const properties of malformed) {
			const connection = await connect();
			const tunnel = host.tunnel;
			let asked = false;
			const elicit: MCPElicitHandler = async () => {
				asked = true;
				return { action: "cancel" };
			};

			const calling = rejectionOf(callTool(connection, "configure", {}, { elicit }));
			const first = await tunnel.next("tools/call");
			const [name] = Object.keys(properties);
			tunnel.push({
				id: first.id,
				result: {
					resultType: "input_required",
					inputRequests: {
						q: {
							method: "elicitation/create",
							params: { message: "Settings", requestedSchema: { type: "object", properties } },
						},
					},
				},
			});

			expect(String(await calling)).toContain(`with an unsupported field "${name}"`);
			expect(asked).toBe(false);
		}
	});

	it("stops a server that never stops asking for input", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;
		const calling = rejectionOf(callTool(connection, "loop"));
		for (let round = 0; round < 8; round++) {
			const request = await tunnel.next("tools/call");
			tunnel.push({ id: request.id, result: { resultType: "input_required", requestState: "again" } });
		}

		expect(String(await calling)).toContain("after 8 round trips");
		expect(tunnel.sent.filter(message => message.method === "tools/call")).toHaveLength(8);
	});

	it("replaces the resource stream when the watched set changes, new stream first", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const watchingA = subscribeToResources(connection, ["res://a"]);
		const listenA = await nextResourceListen(tunnel);
		tunnel.acknowledge(listenA);
		await watchingA;
		expect(paramsOf(listenA).notifications).toEqual({ resourceSubscriptions: ["res://a"] });

		const watchingB = subscribeToResources(connection, ["res://b"]);
		const listenAB = await nextResourceListen(tunnel);
		expect(paramsOf(listenAB).notifications).toEqual({ resourceSubscriptions: ["res://a", "res://b"] });
		// The old stream stays open until the new one is acknowledged.
		expect(tunnel.sent.some(message => message.method === "notifications/cancelled")).toBe(false);
		tunnel.acknowledge(listenAB);
		await watchingB;
		expect(paramsOf(await tunnel.next("notifications/cancelled")).requestId).toBe(listenA.id);

		await unsubscribeFromResources(connection, ["res://a", "res://b"]);
		expect(paramsOf(await tunnel.next("notifications/cancelled")).requestId).toBe(listenAB.id);
		expect(tunnel.sent.filter(isSubscriptionListen).filter(isResourceListen)).toHaveLength(2);
	});

	function isSubscriptionListen(message: Message): boolean {
		return message.method === "subscriptions/listen";
	}

	it("does not throw when the resource stream is refused, and asks again with the next change", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const watching = subscribeToResources(connection, ["res://a"]);
		const refused = await nextResourceListen(tunnel);
		tunnel.push({ id: refused.id, error: { code: -32603, message: "subscriptions unavailable" } });
		await watching;

		const again = subscribeToResources(connection, ["res://b"]);
		const retried = await nextResourceListen(tunnel);
		tunnel.acknowledge(retried);
		await again;

		// The refused URI is still wanted: it rides on the next stream.
		expect(paramsOf(retried).notifications).toEqual({ resourceSubscriptions: ["res://a", "res://b"] });
	});

	it("re-opens the resource stream when the host ends it", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;
		const watching = subscribeToResources(connection, ["res://a"]);
		const first = await nextResourceListen(tunnel);
		tunnel.acknowledge(first);
		await watching;

		tunnel.push({ method: "notifications/cancelled", params: { requestId: first.id } });
		const second = await nextResourceListen(tunnel);

		expect(second.id).not.toBe(first.id);
		expect(paramsOf(second).notifications).toEqual({ resourceSubscriptions: ["res://a"] });
		tunnel.acknowledge(second);
	});

	it("re-opens every stream on a new attachment", async () => {
		let reattached = 0;
		const connection = await connect({
			onReattach: () => {
				reattached++;
			},
		});
		const first = host.tunnel;
		const watching = subscribeToResources(connection, ["res://a"]);
		first.acknowledge(await nextResourceListen(first));
		await watching;

		first.drop();
		const second = await host.attached(2);
		const lists = await second.next("subscriptions/listen");
		const resources = await second.next("subscriptions/listen");
		second.acknowledge(resources);

		expect(isResourceListen(lists)).toBe(false);
		expect(paramsOf(resources).notifications).toEqual({ resourceSubscriptions: ["res://a"] });
		expect(reattached).toBe(1);
	});
	it("forgets the watched resources when the new attachment reaches another identity", async () => {
		const connection = await connect();
		const first = host.tunnel;
		const watching = subscribeToResources(connection, ["res://private-to-the-old-account"]);
		first.acknowledge(await nextResourceListen(first));
		await watching;
		const spec = connection.transport.spec;
		if (spec.transport === "stdio") throw new Error("fixture is remote");

		await connection.transport.retarget({ ...spec, headers: { Authorization: "Bearer another-account" } });
		const second = host.tunnel;
		await second.next("subscriptions/listen");
		await settled();

		// Only the list-change stream came back: the old identity's URIs are not shown to the new one.
		expect(second.sent.filter(isSubscriptionListen).filter(isResourceListen)).toEqual([]);

		const again = subscribeToResources(connection, ["res://b"]);
		const listen = await nextResourceListen(second);
		second.acknowledge(listen);
		await again;
		expect(paramsOf(listen).notifications).toEqual({ resourceSubscriptions: ["res://b"] });
	});

	it("watches again after the last watched resource was dropped", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;
		const watching = subscribeToResources(connection, ["res://a"]);
		const first = await nextResourceListen(tunnel);
		tunnel.acknowledge(first);
		await watching;

		// Dropping the last one needs no round trip; the stream must still follow the next change.
		await unsubscribeFromResources(connection, ["res://a"]);
		const rewatching = subscribeToResources(connection, ["res://a"]);
		const second = await nextResourceListen(tunnel);
		tunnel.acknowledge(second);
		await rewatching;

		expect(second.id).not.toBe(first.id);
		expect(paramsOf(second).notifications).toEqual({ resourceSubscriptions: ["res://a"] });
	});

	it("asks the server itself for discovery and lists on a live connection", async () => {
		const connection = await connect({ live: true });
		const tunnel = host.tunnel;

		const listing = listTools(connection);
		tunnel.push({ id: (await tunnel.next("tools/list")).id, result: { tools: [] } });
		await listing;

		const asked = tunnel.sent.filter(
			message => message.method === "server/discover" || message.method === "tools/list",
		);
		expect(asked.map(message => metaOf(message)["omp/cache"])).toEqual(["no-store", "no-store"]);
	});

	it("follows an empty cursor to the next page", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const listing = listTools(connection);
		const first = await tunnel.next("tools/list");
		tunnel.push({
			id: first.id,
			result: { tools: [{ name: "a", inputSchema: { type: "object" } }], nextCursor: "" },
		});
		const second = await tunnel.next("tools/list");
		tunnel.push({ id: second.id, result: { tools: [{ name: "b", inputSchema: { type: "object" } }] } });

		expect((await listing).map(tool => tool.name)).toEqual(["a", "b"]);
		expect("cursor" in paramsOf(first)).toBe(false);
		expect(paramsOf(second).cursor).toBe("");
	});

	it("rejects a list the server answered by asking for input, and memoizes nothing from it", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const listing = rejectionOf(listTools(connection));
		tunnel.push({
			id: (await tunnel.next("tools/list")).id,
			result: {
				resultType: "input_required",
				inputRequests: { r: { method: "roots/list" } },
				tools: [{ name: "smuggled", inputSchema: { type: "object" } }],
			},
		});

		expect(await listing).toMatchObject({ failure: "malformed_response", retryable: false });
		expect(connection.tools).toBeUndefined();
	});

	it("refuses to connect to a server whose discovery is not a complete result", async () => {
		host.answer = (message, tunnel) => {
			if (message.method !== "server/discover") return;
			queueMicrotask(() => tunnel.push({ id: message.id, result: { ...DISCOVER, resultType: "task" } }));
		};

		const error = await rejectionOf(connect());

		expect(error).toMatchObject({ failure: "malformed_response" });
		expect(String(error)).toContain("Unsupported MCP result type: task");
		expect(host.tunnel.released).toBe(true);
	});

	it("answers an input request whatever key the server gave it", async () => {
		const connection = await connect();
		const tunnel = host.tunnel;

		const calling = callTool(connection, "needs_roots");
		const first = await tunnel.next("tools/call");
		tunnel.push({
			id: first.id,
			result: { resultType: "input_required", inputRequests: { ["__proto__"]: { method: "roots/list" } } },
		});
		const retry = await tunnel.next("tools/call");
		tunnel.push({ id: retry.id, result: { content: [] } });
		await calling;

		const responses = paramsOf({ params: paramsOf(retry).inputResponses });
		expect(Object.hasOwn(responses, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(responses, "__proto__")?.value).toEqual({ roots: ROOTS });
	});
});
