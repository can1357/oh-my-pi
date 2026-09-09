import { describe, expect, it } from "bun:test";
import {
	listResources,
	listResourceTemplates,
	readResource,
	serverSupportsResourceSubscriptions,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "@oh-my-pi/pi-coding-agent/mcp/client";
import type {
	MCPResource,
	MCPResourceReadResult,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

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
