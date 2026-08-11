import { describe, expect, it } from "bun:test";
import { composeSignals, DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	type MCPRequestOptions,
	type MCPServerConnection,
	type MCPToolDefinition,
	type MCPTransport,
} from "../src/mcp/types";
import { ToolAbortError } from "../src/tools/tool-errors";

function createMockConnection(name = "test-server"): MCPServerConnection {
	const transport: MCPTransport = {
		connected: true,
		request<T>(_method: string, _params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
			return new Promise<T>((_resolve, reject) => {
				const signal = options?.signal;
				const onAbort = () => reject(signal?.reason ?? new ToolAbortError("MCP request aborted"));
				if (!signal) return;
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		},
		async notify() {},
		async close() {},
	};
	const capabilities = {};
	return {
		name,
		config: { type: "stdio", command: "mock" },
		transport,
		serverInfo: { name, version: "1.0.0" },
		capabilities,
		protocol: {
			era: "modern",
			version: MCP_MODERN_PROTOCOL_VERSION,
			supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
			clientCapabilities: {},
			capabilities,
		},
	};
}

const mockToolDefinition: MCPToolDefinition = {
	name: "echo",
	description: "Echo input",
	inputSchema: {
		type: "object",
		properties: {
			message: { type: "string" },
		},
	},
};

const dummyContext = {} as unknown as Parameters<MCPTool["execute"]>[3];

describe("composeSignals", () => {
	it("returns undefined signal when neither signal is provided", () => {
		const { signal, cleanup } = composeSignals(undefined, undefined);
		expect(signal).toBeUndefined();
		cleanup();
	});

	it("returns disposal signal when only disposal signal is provided", () => {
		const disposal = new AbortController();
		const { signal, cleanup } = composeSignals(undefined, disposal.signal);
		expect(signal).toBe(disposal.signal);
		cleanup();
	});

	it("returns caller signal when only caller signal is provided", () => {
		const caller = new AbortController();
		const { signal, cleanup } = composeSignals(caller.signal, undefined);
		expect(signal).toBe(caller.signal);
		cleanup();
	});

	it("merges signals and aborts when caller signal aborts", () => {
		const caller = new AbortController();
		const disposal = new AbortController();
		const { signal: merged, cleanup } = composeSignals(caller.signal, disposal.signal);

		expect(merged).toBeDefined();
		expect(merged?.aborted).toBe(false);

		caller.abort(new Error("caller aborted"));
		expect(merged?.aborted).toBe(true);
		expect(merged?.reason).toEqual(new Error("caller aborted"));
		cleanup();
	});

	it("merges signals and aborts when disposal signal aborts", () => {
		const caller = new AbortController();
		const disposal = new AbortController();
		const { signal: merged, cleanup } = composeSignals(caller.signal, disposal.signal);

		expect(merged).toBeDefined();
		expect(merged?.aborted).toBe(false);

		disposal.abort(new ToolAbortError("bridge disposed"));
		expect(merged?.aborted).toBe(true);
		expect(merged?.reason).toEqual(new ToolAbortError("bridge disposed"));
		cleanup();
	});

	it("removes event listeners when cleanup is called", () => {
		const caller = new AbortController();
		const disposal = new AbortController();
		const { signal: merged, cleanup } = composeSignals(caller.signal, disposal.signal);

		cleanup();

		caller.abort(new Error("caller late abort"));
		expect(merged?.aborted).toBe(false);
	});

	it("handles already-aborted signals synchronously", () => {
		const caller = new AbortController();
		caller.abort(new Error("caller already dead"));
		const disposal = new AbortController();

		const { signal: merged, cleanup } = composeSignals(caller.signal, disposal.signal);
		expect(merged?.aborted).toBe(true);
		expect(merged?.reason).toEqual(new Error("caller already dead"));
		cleanup();
	});
});

describe("MCPTool cancellation and disposal", () => {
	it("aborts active execution when tool is disposed mid-execution", async () => {
		const conn = createMockConnection();

		const tool = new MCPTool(conn, mockToolDefinition, undefined, undefined);

		// Override connection or mock call
		const executePromise = tool.execute("call-1", { message: "hello" }, undefined, dummyContext);

		// Dispose the tool while execution is pending
		tool.dispose();

		await expect(executePromise).rejects.toThrow(ToolAbortError);
	});

	it("aborts active execution when disposalSignal fires mid-execution", async () => {
		const conn = createMockConnection();
		const disposalController = new AbortController();

		const tool = new MCPTool(conn, mockToolDefinition, undefined, undefined, disposalController.signal);

		const executePromise = tool.execute("call-2", { message: "hello" }, undefined, dummyContext);

		disposalController.abort(new ToolAbortError("server shutdown"));

		await expect(executePromise).rejects.toThrow(ToolAbortError);
	});

	it("preserves caller abort behavior when caller signal aborts", async () => {
		const conn = createMockConnection();
		const callerController = new AbortController();

		const tool = new MCPTool(conn, mockToolDefinition);

		const executePromise = tool.execute(
			"call-3",
			{ message: "hello" },
			undefined,
			dummyContext,
			callerController.signal,
		);

		callerController.abort(new ToolAbortError("user cancelled"));

		await expect(executePromise).rejects.toThrow(ToolAbortError);
	});

	it("throws ToolAbortError immediately if caller signal is already aborted", async () => {
		const conn = createMockConnection();
		const callerController = new AbortController();
		callerController.abort(new ToolAbortError("already cancelled"));

		const tool = new MCPTool(conn, mockToolDefinition);

		await expect(
			tool.execute("call-4", { message: "hello" }, undefined, dummyContext, callerController.signal),
		).rejects.toThrow(ToolAbortError);
	});
});

describe("DeferredMCPTool cancellation and disposal", () => {
	it("aborts active getConnection when tool is disposed mid-resolution", async () => {
		const connPromise = new Promise<MCPServerConnection>(() => {});

		const tool = new DeferredMCPTool("deferred-server", mockToolDefinition, () => connPromise);

		const executePromise = tool.execute("call-def-1", { message: "hello" }, undefined, dummyContext);

		tool.dispose();

		await expect(executePromise).rejects.toThrow(ToolAbortError);
	});

	it("aborts active getConnection when caller signal aborts", async () => {
		const callerController = new AbortController();
		const connPromise = new Promise<MCPServerConnection>(() => {});

		const tool = new DeferredMCPTool("deferred-server", mockToolDefinition, () => connPromise);

		const executePromise = tool.execute(
			"call-def-2",
			{ message: "hello" },
			undefined,
			dummyContext,
			callerController.signal,
		);

		callerController.abort(new ToolAbortError("user stopped deferred call"));

		await expect(executePromise).rejects.toThrow(ToolAbortError);
	});
});
