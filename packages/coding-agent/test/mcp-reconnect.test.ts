import { describe, expect, it, vi } from "bun:test";
import { createMCPJsonRpcError, MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { MCPReconnect } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import {
	createMCPToolName,
	DeferredMCPTool,
	deduplicateMCPToolsByName,
	isRetriableConnectionError,
	MCPTool,
} from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type {
	MCPImageContent,
	MCPServerConnection,
	MCPToolCallResult,
	MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock transport where `request` is controlled by the caller. */
function mockTransport(requestFn: (...args: Parameters<MCPTransport["request"]>) => Promise<unknown>): MCPTransport {
	return {
		connected: true,
		request: requestFn as MCPTransport["request"],
		async notify() {},
		async close() {},
	};
}

const TOOL_DEF = { name: "do_stuff", inputSchema: { type: "object" as const } };

function toolCallResult(text: string, isError = false): MCPToolCallResult {
	return { content: [{ type: "text", text }], isError };
}

function makeConnection(transport: MCPTransport, name = "test-server"): MCPServerConnection {
	return {
		name,
		config: { type: "stdio" as const, command: "echo" },
		transport,
		serverInfo: { name: "test", version: "1.0" },
		capabilities: { tools: {} },
	};
}

// ---------------------------------------------------------------------------
// deduplicateMCPToolsByName
// ---------------------------------------------------------------------------

describe("deduplicateMCPToolsByName", () => {
	it("keeps the same collision winner after a reconnect reorders the tool list", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const dotted = { name: "mcp__foo_bar_lookup", mcpServerName: "foo.bar", mcpToolName: "lookup" };
			const underscored = { name: "mcp__foo_bar_lookup", mcpServerName: "foo_bar", mcpToolName: "lookup" };

			const before = deduplicateMCPToolsByName([dotted, underscored]);
			expect(before).toEqual([dotted]);

			// Simulate MCPManager#replaceServerTools on the current winner: its
			// tools are removed and re-appended, reordering it behind the loser.
			// The minted name must not silently switch owners.
			const after = deduplicateMCPToolsByName([underscored, dotted]);
			expect(after).toEqual([dotted]);
		} finally {
			warn.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// createMCPToolName
// ---------------------------------------------------------------------------

describe("createMCPToolName", () => {
	it("caps overlong names at 64 chars so strict validators accept them (#9130)", () => {
		// chrome-devtools-mcp's performance_analyze_insight minted to 68 chars,
		// which Meta/OpenAI Responses reject with HTTP 400 "name must be at most
		// 64 characters".
		const name = createMCPToolName("chrome-devtools-mcp", "chrome_devtools_performance_analyze_insight");
		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		// A readable prefix survives the cap.
		expect(name.startsWith("mcp__chrome_devtools_mcp_")).toBe(true);
	});

	it("leaves names within the limit untouched", () => {
		expect(createMCPToolName("puppeteer", "puppeteer_screenshot")).toBe("mcp__puppeteer_screenshot");
	});

	it("is deterministic and keeps distinct overlong names distinct", () => {
		const a = createMCPToolName("chrome-devtools-mcp", "chrome_devtools_performance_analyze_insight");
		const b = createMCPToolName("chrome-devtools-mcp", "chrome_devtools_performance_analyze_insight");
		const c = createMCPToolName("chrome-devtools-mcp", "chrome_devtools_performance_analyze_something_else_entirely");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(c.length).toBeLessThanOrEqual(64);
	});
});

// ---------------------------------------------------------------------------
// isRetriableConnectionError
// ---------------------------------------------------------------------------

describe("isRetriableConnectionError", () => {
	const retriable = [
		"ECONNREFUSED",
		"ECONNRESET",
		"EPIPE",
		"ENETUNREACH",
		"EHOSTUNREACH",
		"fetch failed",
		"Transport not connected",
		"network error",
		"HTTP 404: Not Found",
		"HTTP 502: Bad Gateway",
		"HTTP 503: Service Unavailable",
		"Transport closed",
	];

	for (const msg of retriable) {
		it(`matches: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(true);
		});
	}

	const nonRetriable = [
		"MCP error -32603: Server still initializing",
		"HTTP 401: Unauthorized",
		"HTTP 403: Forbidden",
		"HTTP 400: Bad Request",
		"Request timeout after 30000ms",
		"SSE response timeout after 30000ms",
		"Tool not found: do_stuff",
	];

	for (const msg of nonRetriable) {
		it(`does not match: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(false);
		});
	}

	it("uses typed transport metadata without retrying ambiguous timeouts", () => {
		expect(
			isRetriableConnectionError(
				new MCPTransportError({
					transport: "http",
					stage: "send",
					failure: "reset",
					message: "Connection reset",
					retryable: true,
				}),
			),
		).toBe(true);
		expect(
			isRetriableConnectionError(
				new MCPTransportError({
					transport: "http",
					stage: "receive",
					failure: "timeout",
					message: "Request timeout",
					retryable: false,
				}),
			),
		).toBe(false);
	});

	it("returns false for non-Error values", () => {
		expect(isRetriableConnectionError("ECONNREFUSED")).toBe(false);
		expect(isRetriableConnectionError(null)).toBe(false);
		expect(isRetriableConnectionError(undefined)).toBe(false);
		expect(isRetriableConnectionError({ message: "ECONNREFUSED" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// MCPTool.execute retry behavior
// ---------------------------------------------------------------------------

describe("MCPTool.execute retry on connection error", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];

	it("retries once on retriable error when reconnect succeeds", async () => {
		let callCount = 0;
		const failTransport = mockTransport(async () => {
			callCount++;
			throw new Error("ECONNREFUSED");
		});
		const successTransport = mockTransport(async () => {
			callCount++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(failTransport);
		const newConn = makeConnection(successTransport, "test-server-new");
		const reconnect: MCPReconnect = async () => newConn;

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(callCount).toBe(2); // 1 fail + 1 retry
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("preserves image blocks returned by MCP tools", async () => {
		const image: MCPImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
		const transport = mockTransport(async () => ({
			content: [{ type: "text", text: "Screenshot captured" }, image],
		}));
		const tool = new MCPTool(makeConnection(transport), TOOL_DEF);

		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.content).toEqual([{ type: "text", text: "Screenshot captured" }, image]);
	});

	it("retries on transport closed and rebinding succeeds", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const closedTransport = mockTransport(async () => {
			oldCalls++;
			throw new Error("Transport closed");
		});
		const reopenedTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(closedTransport);
		const newConn = makeConnection(reopenedTransport, "test-server-transport-closed");
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return newConn;
		};

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(reconnects).toBe(1);
		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(1);
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("reuses refreshed connection on later call", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let reconnects = 0;
		const oldTransport = mockTransport(async () => {
			oldCalls++;
			throw new Error("ECONNREFUSED");
		});
		const newTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("ok");
		});

		const oldConn = makeConnection(oldTransport);
		const newConn = makeConnection(newTransport, "test-server-rebound");
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return newConn;
		};

		const tool = new MCPTool(oldConn, TOOL_DEF, reconnect);
		const first = await tool.execute("call-1", {}, noop, noCtx);
		const second = await tool.execute("call-2", {}, noop, noCtx);

		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(2);
		expect(reconnects).toBe(1);
		expect(first.details?.isError).toBeFalsy();
		expect(second.details?.isError).toBeFalsy();
		expect(first.content[0]).toEqual({ type: "text", text: "ok" });
		expect(second.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("returns error result when reconnect returns null", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNRESET");
		});
		const reconnect: MCPReconnect = async () => null;

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("failure: reset"),
		});
	});

	it("does not retry on non-retriable error", async () => {
		let reconnectCalled = false;
		const failTransport = mockTransport(async () => {
			throw new Error("MCP error -32603: Internal error");
		});
		const reconnect: MCPReconnect = async () => {
			reconnectCalled = true;
			return null;
		};

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(reconnectCalled).toBe(false);
		expect(result.details?.isError).toBe(true);
	});

	it("does not reconnect and replay a non-retryable accepted SSE EOF", async () => {
		let calls = 0;
		let reconnects = 0;
		const failTransport = mockTransport(async () => {
			calls++;
			throw new MCPTransportError({
				transport: "http",
				stage: "receive",
				failure: "eof",
				message: "No response received after the server accepted the POST",
				retryable: false,
			});
		});
		const reconnect: MCPReconnect = async () => {
			reconnects++;
			return makeConnection(mockTransport(async () => toolCallResult("duplicated")));
		};
		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);

		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(calls).toBe(1);
		expect(reconnects).toBe(0);
		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("retryable: no"),
		});
	});

	it("renders server, tool, protocol data, trace ID, retryability, and one next step", async () => {
		const failTransport = mockTransport(async () => {
			throw createMCPJsonRpcError("stdio", {
				code: -32042,
				message: "upstream rejected the call",
				data: { detail: "invalid input", token: "server-secret", traceId: "trace-abc123" },
			});
		});
		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF);

		const result = await tool.execute("call-1", {}, noop, noCtx);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected an MCP text diagnostic");

		expect(content.text).toContain("server: test-server");
		expect(content.text).toContain("tool: do_stuff");
		expect(content.text).toContain("transport: stdio");
		expect(content.text).toContain("stage: protocol");
		expect(content.text).toContain("failure: json_rpc");
		expect(content.text).toContain("retryable: no");
		expect(content.text).toContain("code: -32042");
		expect(content.text).toContain("trace_id: trace-abc123");
		expect(content.text).toContain('"token":"[redacted]"');
		expect(content.text).not.toContain("server-secret");
		expect(content.text.match(/^next: /gm)).toHaveLength(1);
	});

	it("redacts compound credential keys in JSON-RPC error data", () => {
		const error = createMCPJsonRpcError("http", {
			code: -32001,
			message: "server echoed its OAuth config",
			data: {
				client_secret: "cs-leak",
				clientSecret: "cs-camel-leak",
				private_key: "pk-leak",
				signingSecret: "sign-leak",
				access_token: "at-leak",
				apiKey: "ak-leak",
				note: "safe-detail",
			},
		});
		if (error.data === undefined) throw new Error("Expected serialized error data");

		for (const leaked of ["cs-leak", "cs-camel-leak", "pk-leak", "sign-leak", "at-leak", "ak-leak"]) {
			expect(error.data).not.toContain(leaked);
		}
		expect(error.data).toContain('"note":"safe-detail"');
		expect(error.data).toContain("[redacted]");
	});

	it("does not retry when no reconnect callback", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNREFUSED");
		});

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF); // no reconnect
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("failure: connect"),
		});
	});

	it("returns error from retry when retry also fails", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNREFUSED");
		});
		const retryFailTransport = mockTransport(async () => {
			throw new Error("HTTP 503: Service Unavailable");
		});
		const reconnect: MCPReconnect = async () => makeConnection(retryFailTransport);

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("failure: http_status"),
		});
	});

	it("preserves provider info from new connection on successful retry", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("fetch failed");
		});
		const successTransport = mockTransport(async () => toolCallResult("ok"));

		const oldConn = makeConnection(failTransport);
		oldConn._source = { provider: "old-provider", providerName: "Old", path: "/old", level: "user" };
		const newConn = makeConnection(successTransport);
		newConn._source = { provider: "new-provider", providerName: "New", path: "/new", level: "user" };

		const tool = new MCPTool(oldConn, TOOL_DEF, async () => newConn);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.provider).toBe("new-provider");
		expect(result.details?.providerName).toBe("New");
	});

	it("falls back to original provider when new connection has no source", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("fetch failed");
		});
		const successTransport = mockTransport(async () => toolCallResult("ok"));

		const oldConn = makeConnection(failTransport);
		oldConn._source = { provider: "orig", providerName: "Original", path: "/orig", level: "user" };
		const newConn = makeConnection(successTransport);
		// newConn has no _source

		const tool = new MCPTool(oldConn, TOOL_DEF, async () => newConn);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(result.details?.provider).toBe("orig");
		expect(result.details?.providerName).toBe("Original");
	});
	it("reconnects once when a tool result carries an OAuth challenge", async () => {
		let oldCalls = 0;
		let newCalls = 0;
		let challenge: unknown;
		const oldTransport = mockTransport(async () => {
			oldCalls++;
			return {
				...toolCallResult("authorize me", true),
				_meta: { "mcp/www_authenticate": ['Bearer resource_metadata="https://mcp.example/meta"'] },
			};
		});
		const newTransport = mockTransport(async () => {
			newCalls++;
			return toolCallResult("authorized");
		});
		const newConn = makeConnection(newTransport, "test-server-authorized");
		const reconnect: MCPReconnect = async options => {
			challenge = options?.authChallenge;
			return newConn;
		};

		const tool = new MCPTool(makeConnection(oldTransport), TOOL_DEF, reconnect);
		const result = await tool.execute("call-1", {}, noop, noCtx);

		expect(oldCalls).toBe(1);
		expect(newCalls).toBe(1);
		expect(challenge).toEqual({
			wwwAuthenticate: ['Bearer resource_metadata="https://mcp.example/meta"'],
		});
		expect(result.details?.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: "text", text: "authorized" });
	});

	it("preserves the OAuth challenge metadata when no reconnect handler exists", async () => {
		const result = await new MCPTool(
			makeConnection(
				mockTransport(async () => ({
					...toolCallResult("authorize me", true),
					_meta: { "mcp/www_authenticate": ["Bearer"] },
				})),
			),
			TOOL_DEF,
		).execute("call-1", {}, noop, noCtx);

		expect(result.details?.isError).toBe(true);
		expect(result.details?.mcpMeta).toEqual({ "mcp/www_authenticate": ["Bearer"] });
	});
});

describe("reconnect abort propagation", () => {
	const noop = () => {};
	const noCtx = {} as Parameters<MCPTool["execute"]>[3];
	const noDeferredCtx = {} as Parameters<DeferredMCPTool["execute"]>[3];

	it("throws ToolAbortError when MCPTool reconnect is aborted", async () => {
		const failTransport = mockTransport(async () => {
			throw new Error("ECONNRESET");
		});
		const { promise } = Promise.withResolvers<MCPServerConnection | null>();
		const reconnect: MCPReconnect = async () => promise;

		const tool = new MCPTool(makeConnection(failTransport), TOOL_DEF, reconnect);
		const controller = new AbortController();
		const pending = tool.execute("call-1", {}, noop, noCtx, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});

	it("throws ToolAbortError when DeferredMCPTool reconnect is aborted", async () => {
		const getConnection = async () => {
			throw new Error("MCP server not connected");
		};
		const { promise } = Promise.withResolvers<MCPServerConnection | null>();
		const reconnect: MCPReconnect = async () => promise;

		const tool = new DeferredMCPTool("test-server", TOOL_DEF, getConnection, undefined, reconnect);
		const controller = new AbortController();
		const pending = tool.execute("call-1", {}, noop, noDeferredCtx, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
	});
});
