import { expect, test, vi } from "bun:test";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { HostLink } from "@oh-my-pi/pi-coding-agent/mcp/link";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type {
	MCPRequestOptions,
	MCPServerConnection,
	MCPToolDefinition,
	MCPTransport,
} from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMCPProxyTools } from "@oh-my-pi/pi-coding-agent/task/executor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { FakeHost, REMOTE_SPEC } from "./mcp-host/link-fake-host";

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

	const tools = createMCPProxyTools(manager, "child");
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

test.each([180_000, 0])("MCP proxy honors a link deadline of %i beyond 60s", async timeout => {
	// The link owns the deadline; an environment override would replace both rows' values.
	const savedTimeout = Bun.env.OMP_MCP_TIMEOUT_MS;
	delete Bun.env.OMP_MCP_TIMEOUT_MS;
	const host = new FakeHost();
	const link = new HostLink({
		name: "test-server",
		spec: REMOTE_SPEC,
		instance: "manager-1",
		roots: () => [],
		idleMs: 1_000,
		timeout,
		access: host,
	});
	const manager = new MCPManager(process.cwd());
	mockSourceTool(manager, {
		name: "test-server",
		config: { type: "http", url: REMOTE_SPEC.url, timeout },
		transport: link,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	});
	try {
		await link.connect();
		const [proxy] = createMCPProxyTools(manager, "child");
		if (!proxy?.execute) throw new Error("Tool execute method missing");
		vi.useFakeTimers();
		const resultPromise = proxy.execute("queued-report", {}, undefined, {} as CustomToolContext);
		const call = await host.tunnel.next("tools/call");
		// Advance the proxy's and the link's timers while the host holds the call.
		// The former independent 60s watchdog discarded this server's answer.
		vi.advanceTimersByTime(61_000);
		host.tunnel.push({
			id: call.id,
			result: { resultType: "complete", content: [{ type: "text", text: "Queued report completed" }] },
		});
		const result = await resultPromise;
		expect(result.content).toEqual([{ type: "text", text: "Queued report completed" }]);
		expect(result.isError).not.toBe(true);
	} finally {
		vi.useRealTimers();
		await link.close();
		vi.restoreAllMocks();
		if (savedTimeout === undefined) delete Bun.env.OMP_MCP_TIMEOUT_MS;
		else Bun.env.OMP_MCP_TIMEOUT_MS = savedTimeout;
	}
});
