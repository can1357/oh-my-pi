import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	getSupportedMCPSubscriptionFilter,
	listenToNotifications,
	listResources,
	listResourceTemplates,
	readResource,
	serverSupportsResourceSubscriptions,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/client";
import type {
	MCPResource,
	MCPResourceReadResult,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPTransport,
} from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport, createModernMockConnection } from "./mcp-test-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("listResources", () => {
	it("returns empty array when server does not support resources", async () => {
		const transport = createMockTransport(new Map());
		const conn = createMockConnection({}, transport);
		const result = await listResources(conn);
		expect(result).toEqual([]);
	});

	it("fetches and caches resources on first call", async () => {
		const resources: MCPResource[] = [
			{ uri: "file:///a.txt", name: "a.txt" },
			{ uri: "file:///b.txt", name: "b.txt" },
		];
		const page: MCPResourcesListResult = { resources };
		const transport = createMockTransport(new Map([["resources/list", [page]]]));
		const conn = createMockConnection({ resources: {} }, transport);

		const result = await listResources(conn);
		expect(result).toHaveLength(2);
		expect(result[0].uri).toBe("file:///a.txt");
		expect(result[1].uri).toBe("file:///b.txt");
		expect(conn.resources).toBe(result);
	});

	it("returns cached resources on second call without making another request", async () => {
		const resources: MCPResource[] = [{ uri: "file:///c.txt", name: "c.txt" }];
		const page: MCPResourcesListResult = { resources };
		// Only one response queued — second transport hit would throw
		const transport = createMockTransport(new Map([["resources/list", [page]]]));
		const conn = createMockConnection({ resources: {} }, transport);

		const first = await listResources(conn);
		const second = await listResources(conn);
		expect(second).toBe(first);
	});

	it("handles pagination with multiple pages", async () => {
		const page1: MCPResourcesListResult = {
			resources: [{ uri: "file:///p1.txt", name: "p1.txt" }],
			nextCursor: "c1",
		};
		const page2: MCPResourcesListResult = {
			resources: [{ uri: "file:///p2.txt", name: "p2.txt" }],
		};
		const transport = createMockTransport(new Map([["resources/list", [page1, page2]]]));
		const conn = createMockConnection({ resources: {} }, transport);

		const result = await listResources(conn);
		expect(result).toHaveLength(2);
		expect(result[0].uri).toBe("file:///p1.txt");
		expect(result[1].uri).toBe("file:///p2.txt");
	});

	it("honors modern TTL freshness and retains exact page metadata", async () => {
		let now = 10_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let requests = 0;
		const metadata = { "com.example/cache-tag": { revision: 1 } };
		const transport = createMockTransport(
			new Map([
				[
					"resources/list",
					[
						{
							resultType: "complete",
							ttlMs: 5,
							cacheScope: "public",
							_meta: metadata,
							resources: [{ uri: "file:///fresh.txt", name: "fresh.txt" }],
						},
						{
							resultType: "complete",
							ttlMs: 5,
							cacheScope: "public",
							resources: [{ uri: "file:///refetched.txt", name: "refetched.txt" }],
						},
					],
				],
			]),
			() => requests++,
		);
		const conn = createModernMockConnection({ resources: {} }, transport);

		const first = await listResources(conn);
		expect(await listResources(conn)).toBe(first);
		expect(requests).toBe(1);
		expect(conn.resultHints?.resources?.pages[0]?._meta).toBe(metadata);

		now += 5;
		const refetched = await listResources(conn);
		expect(refetched[0]?.uri).toBe("file:///refetched.txt");
		expect(requests).toBe(2);
	});

	it("does not reuse a modern paginated result when page scopes disagree", async () => {
		let requests = 0;
		const pages = [
			{
				resultType: "complete",
				ttlMs: 10_000,
				cacheScope: "public",
				resources: [{ uri: "file:///one", name: "one" }],
				nextCursor: "next",
			},
			{
				resultType: "complete",
				ttlMs: 2_000,
				cacheScope: "private",
				resources: [{ uri: "file:///two", name: "two" }],
			},
		];
		const transport = createMockTransport(new Map([["resources/list", [...pages, ...pages]]]), () => requests++);
		const conn = createModernMockConnection({ resources: {} }, transport);

		expect(await listResources(conn)).toHaveLength(2);
		expect(conn.resources).toBeUndefined();
		expect(conn.resultHints?.resources).toMatchObject({
			era: "modern",
			ttlMs: 2_000,
			cacheScope: "private",
			scopeConsistent: false,
		});
		expect(await listResources(conn)).toHaveLength(2);
		expect(requests).toBe(4);
	});

	it("rejects modern list results that omit required cache hints", async () => {
		const conn = createModernMockConnection(
			{ resources: {} },
			createMockTransport(new Map([["resources/list", [{ resultType: "complete", resources: [] }]]])),
		);
		await expect(listResources(conn)).rejects.toThrow("ttlMs");
		expect(conn.resources).toBeUndefined();
	});
});

describe("listResourceTemplates", () => {
	it("returns empty array when server does not support resources", async () => {
		const transport = createMockTransport(new Map());
		const conn = createMockConnection({}, transport);
		const result = await listResourceTemplates(conn);
		expect(result).toEqual([]);
	});

	it("fetches and caches templates", async () => {
		const templates: MCPResourceTemplate[] = [{ uriTemplate: "file:///{path}", name: "path-template" }];
		const page: MCPResourceTemplatesListResult = { resourceTemplates: templates };
		const transport = createMockTransport(new Map([["resources/templates/list", [page]]]));
		const conn = createMockConnection({ resources: {} }, transport);

		const result = await listResourceTemplates(conn);
		expect(result).toHaveLength(1);
		expect(result[0].uriTemplate).toBe("file:///{path}");
		expect(conn.resourceTemplates).toBe(result);

		// Second call should return cached value without hitting transport
		const second = await listResourceTemplates(conn);
		expect(second).toBe(result);
	});
});

describe("readResource", () => {
	it("sends resources/read with URI and returns contents", async () => {
		const readResult: MCPResourceReadResult = {
			contents: [{ uri: "file:///a.txt", mimeType: "text/plain", text: "hello" }],
		};
		let requestParams: Record<string, unknown> | undefined;
		const transport = createMockTransport(new Map([["resources/read", [readResult]]]), (_method, params) => {
			requestParams = params;
		});
		const conn = createMockConnection({ resources: {} }, transport);

		const result = await readResource(conn, "file:///a.txt");
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].text).toBe("hello");
		expect(result.contents[0].mimeType).toBe("text/plain");
		expect(requestParams).toEqual({ uri: "file:///a.txt" });
	});

	it("handles binary blobs", async () => {
		const readResult: MCPResourceReadResult = {
			contents: [{ uri: "file:///img.png", mimeType: "image/png", blob: "base64data" }],
		};
		const transport = createMockTransport(new Map([["resources/read", [readResult]]]));
		const conn = createMockConnection({ resources: {} }, transport);

		const result = await readResource(conn, "file:///img.png");
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].blob).toBe("base64data");
		expect(result.contents[0].text).toBeUndefined();
	});

	it("caches private modern reads only within the exact connection and URI", async () => {
		let requests = 0;
		const response = {
			resultType: "complete",
			ttlMs: 10_000,
			cacheScope: "private",
			_meta: { "com.example/read": "private" },
			contents: [{ uri: "file:///private.txt", text: "secret" }],
		};
		const firstConnection = createModernMockConnection(
			{ resources: {} },
			createMockTransport(new Map([["resources/read", [response]]]), () => requests++),
		);
		const secondConnection = createModernMockConnection(
			{ resources: {} },
			createMockTransport(new Map([["resources/read", [response]]]), () => requests++),
		);

		const first = await readResource(firstConnection, "file:///private.txt");
		expect(await readResource(firstConnection, "file:///private.txt")).toBe(first);
		expect(firstConnection.resultHints?.resourceReads?.get("file:///private.txt")?.pages[0]?._meta).toBe(
			response._meta,
		);
		await readResource(secondConnection, "file:///private.txt");
		expect(requests).toBe(2);
	});

	it("invalidates private modern reads when the transport authentication revision changes", async () => {
		let authenticationRevision = 1;
		let requests = 0;
		const transport = createMockTransport(
			new Map([
				[
					"resources/read",
					[
						{
							resultType: "complete",
							ttlMs: 10_000,
							cacheScope: "private",
							contents: [{ uri: "file:///private.txt", text: "first identity" }],
						},
						{
							resultType: "complete",
							ttlMs: 10_000,
							cacheScope: "private",
							contents: [{ uri: "file:///private.txt", text: "rotated identity" }],
						},
					],
				],
			]),
			() => requests++,
		);
		transport.getAuthenticationContextRevision = () => authenticationRevision;
		const connection = createModernMockConnection({ resources: {} }, transport);

		expect((await readResource(connection, "file:///private.txt")).contents[0]?.text).toBe("first identity");
		expect((await readResource(connection, "file:///private.txt")).contents[0]?.text).toBe("first identity");
		authenticationRevision++;
		expect((await readResource(connection, "file:///private.txt")).contents[0]?.text).toBe("rotated identity");
		expect(requests).toBe(2);
		expect(connection.resultHints?.resourceReads?.get("file:///private.txt")).toMatchObject({
			authenticationContextRevision: authenticationRevision,
		});
	});

	it("re-fetches zero-TTL modern reads and rejects missing hints", async () => {
		let requests = 0;
		const zeroTtl = {
			resultType: "complete",
			ttlMs: 0,
			cacheScope: "public",
			contents: [{ uri: "file:///volatile.txt", text: "volatile" }],
		};
		const zeroConnection = createModernMockConnection(
			{ resources: {} },
			createMockTransport(new Map([["resources/read", [zeroTtl, zeroTtl]]]), () => requests++),
		);
		await readResource(zeroConnection, "file:///volatile.txt");
		await readResource(zeroConnection, "file:///volatile.txt");
		expect(requests).toBe(2);
		expect(zeroConnection.resourceReads).toBeUndefined();

		const missingConnection = createModernMockConnection(
			{ resources: {} },
			createMockTransport(
				new Map([
					["resources/read", [{ resultType: "complete", contents: [{ uri: "file:///missing.txt", text: "x" }] }]],
				]),
			),
		);
		await expect(readResource(missingConnection, "file:///missing.txt")).rejects.toThrow("ttlMs");
	});
});

describe("serverSupportsResources", () => {
	it("returns true when resources capability exists", () => {
		expect(serverSupportsResources({ resources: {} })).toBe(true);
		expect(serverSupportsResources({ resources: { subscribe: true } })).toBe(true);
		expect(serverSupportsResources({ resources: { listChanged: true } })).toBe(true);
	});

	it("returns false when resources capability is absent", () => {
		expect(serverSupportsResources({})).toBe(false);
		expect(serverSupportsResources({ tools: {} })).toBe(false);
	});
});

describe("serverSupportsResourceSubscriptions", () => {
	it("returns true when capabilities.resources.subscribe is true", () => {
		expect(serverSupportsResourceSubscriptions({ resources: { subscribe: true } })).toBe(true);
	});

	it("returns false when resources capability exists but subscribe is absent", () => {
		expect(serverSupportsResourceSubscriptions({ resources: {} })).toBe(false);
	});

	it("returns false when no resources capability", () => {
		expect(serverSupportsResourceSubscriptions({})).toBe(false);
	});
});

describe("subscribeToResources", () => {
	it("does not throw when one subscription fails", async () => {
		const transport: MCPTransport = {
			connected: true,
			async request<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
				if (params?.uri === "fail://x") throw new Error("boom");
				return {} as T;
			},
			async notify() {},
			async close() {},
		};
		const conn = createMockConnection({ resources: { subscribe: true } }, transport);
		await subscribeToResources(conn, ["test://ok", "fail://x"]);
	});
});

describe("unsubscribeFromResources", () => {
	it("does not throw when one unsubscription fails", async () => {
		const transport: MCPTransport = {
			connected: true,
			async request<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
				if (params?.uri === "fail://x") throw new Error("boom");
				return {} as T;
			},
			async notify() {},
			async close() {},
		};
		const conn = createMockConnection({ resources: { subscribe: true } }, transport);
		await unsubscribeFromResources(conn, ["test://ok", "fail://x"]);
	});
});

describe("modern subscriptions/listen capability gating", () => {
	it("intersects the listener filter with exact advertised listChanged and resources.subscribe flags", async () => {
		let received: unknown;
		const transport: MCPTransport = {
			connected: true,
			async request<T>(): Promise<T> {
				throw new Error("Modern listener must not use the ordinary request hook");
			},
			async notify() {},
			async close() {},
			async listen(params) {
				received = params;
				return {
					requestId: "listen-1",
					requestedNotifications: params.notifications,
					acknowledgedNotifications: params.notifications,
					acknowledged: Promise.resolve(params.notifications),
					completion: Promise.resolve(),
					async cancel() {},
				};
			},
		};
		const connection = createModernMockConnection(
			{
				tools: { listChanged: true },
				prompts: { listChanged: false },
				resources: { subscribe: true, listChanged: false },
			},
			transport,
		);
		const requested = {
			toolsListChanged: true,
			promptsListChanged: true,
			resourcesListChanged: true,
			resourceSubscriptions: ["file:///one", "file:///one", "file:///two"],
		};

		expect(getSupportedMCPSubscriptionFilter(connection, requested)).toEqual({
			toolsListChanged: true,
			resourceSubscriptions: ["file:///one", "file:///two"],
		});
		const listener = await listenToNotifications(connection, requested);
		expect(listener?.requestId).toBe("listen-1");
		expect(received).toEqual({
			notifications: {
				toolsListChanged: true,
				resourceSubscriptions: ["file:///one", "file:///two"],
			},
		});
	});

	it("treats capability absence as non-fatal and does not call a transport listener", async () => {
		let listenCalls = 0;
		const transport: MCPTransport = {
			connected: true,
			async request<T>(): Promise<T> {
				return {} as T;
			},
			async notify() {},
			async close() {},
			async listen() {
				listenCalls++;
				throw new Error("should not listen");
			},
		};
		const connection = createModernMockConnection({ tools: {}, resources: {}, prompts: {} }, transport);
		await expect(
			listenToNotifications(connection, {
				toolsListChanged: true,
				promptsListChanged: true,
				resourcesListChanged: true,
				resourceSubscriptions: ["file:///one"],
			}),
		).resolves.toBeUndefined();
		expect(listenCalls).toBe(0);
	});

	it("never emits removed legacy resource RPCs on a modern connection", async () => {
		const methods: string[] = [];
		const transport: MCPTransport = {
			connected: true,
			async request<T>(method: string): Promise<T> {
				methods.push(method);
				return {} as T;
			},
			async notify() {},
			async close() {},
		};
		const connection = createModernMockConnection({ resources: { subscribe: true } }, transport);
		await subscribeToResources(connection, ["file:///one"]);
		await unsubscribeFromResources(connection, ["file:///one"]);
		expect(methods).toEqual([]);
	});
});
