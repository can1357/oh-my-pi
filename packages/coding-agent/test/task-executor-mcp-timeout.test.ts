import { expect, test, vi } from "bun:test";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { MCPManager } from "../src/mcp/manager";
import { MCPTool } from "../src/mcp/tool-bridge";
import type { MCPRequestOptions, MCPServerConnection, MCPToolDefinition, MCPTransport } from "../src/mcp/types";
import { createMCPProxyTools } from "../src/task/executor";
import { ToolAbortError } from "../src/tools/tool-errors";

function createFakeConnection() {
	let capturedSignal: AbortSignal | undefined;
	const { promise: requestPromise, reject } = Promise.withResolvers<never>();
	let isRequestCalled = false;

	const transport: MCPTransport = {
		async request(_method: string, _params?: Record<string, unknown>, options?: MCPRequestOptions) {
			isRequestCalled = true;
			capturedSignal = options?.signal;
			if (capturedSignal?.aborted) {
				reject(new Error("aborted"));
				return requestPromise;
			}
			capturedSignal?.addEventListener("abort", () => {
				reject(new Error("aborted"));
			});
			return requestPromise;
		},
		async notify() {},
		async close() {},
		connected: true,
	};

	const connection: MCPServerConnection = {
		name: "test-server",
		config: { command: "test", args: [] },
		transport,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	};

	return {
		connection,
		getCapturedSignal: () => capturedSignal,
		requestPromise,
		rejectRequest: reject,
		requestCalled: () => isRequestCalled,
	};
}

const TOOL_DEFINITION: MCPToolDefinition = {
	name: "test_tool",
	description: "A test tool",
	inputSchema: { type: "object", properties: {} },
};

/** Register a real MCPTool bound to `connection` as the sole source tool. */
function mockSourceTool(manager: MCPManager, connection: MCPServerConnection): void {
	vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(connection, TOOL_DEFINITION)]);
}

test("MCP proxy tool aborts underlying operation on caller abort", async () => {
	const fake = createFakeConnection();
	const manager = new MCPManager(process.cwd());
	mockSourceTool(manager, fake.connection);

	const tools = createMCPProxyTools(manager);
	const proxyTool = tools[0];
	if (!proxyTool?.execute) {
		expect.unreachable("Tool execute method missing");
		return;
	}

	const ac = new AbortController();
	const executePromise = proxyTool.execute("call_1", {}, () => {}, {} as CustomToolContext, ac.signal);

	// Let the promise reach transport.request
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();

	expect(fake.requestCalled()).toBe(true);
	const capturedSignal = fake.getCapturedSignal();
	expect(capturedSignal).toBeDefined();
	if (!capturedSignal) return;
	expect(capturedSignal.aborted).toBe(false);

	ac.abort();

	try {
		await executePromise;
		expect.unreachable("Expected ToolAbortError");
	} catch (e: unknown) {
		expect(e instanceof ToolAbortError).toBe(true);
	}

	expect(capturedSignal.aborted).toBe(true);
});

test("MCP proxy tool aborts underlying operation on timeout", async () => {
	vi.useFakeTimers();
	try {
		const fake = createFakeConnection();
		const manager = new MCPManager(process.cwd());
		mockSourceTool(manager, fake.connection);

		const tools = createMCPProxyTools(manager);
		const proxyTool = tools[0];
		if (!proxyTool?.execute) {
			expect.unreachable("Tool execute method missing");
			return;
		}

		const executePromise = proxyTool.execute("call_1", {}, () => {}, {} as CustomToolContext, undefined);

		// Let the promise reach transport.request
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(fake.requestCalled()).toBe(true);
		const capturedSignal = fake.getCapturedSignal();
		expect(capturedSignal).toBeDefined();
		if (!capturedSignal) return;
		expect(capturedSignal.aborted).toBe(false);

		// MCP_CALL_TIMEOUT_MS is 60_000
		vi.advanceTimersByTime(65_000);

		// On timeout, the tool returns an error content array rather than throwing ToolAbortError
		const result = await executePromise;
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			expect.unreachable("Expected text content block");
			return;
		}
		expect(result.content[0].text).toContain("MCP error: MCP tool call timed out");

		expect(capturedSignal.aborted).toBe(true);
	} finally {
		vi.useRealTimers();
	}
});
