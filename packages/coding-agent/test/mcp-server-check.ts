import assert from "node:assert/strict";
import { OhMyPiMcpServer } from "../src/mcp/server.ts";
import type {
	HarnessSessionInterface,
	ToolDescriptor,
	ToolInvocationRequest,
	ToolInvocationResult,
	WorkspacePolicy,
} from "../src/harness/types.ts";

const mockTools: ToolDescriptor[] = [
	{
		name: "read_file",
		description: "Read a file from disk",
		parameters: {
			type: "object",
			properties: {
				filePath: { type: "string" },
			},
			required: ["filePath"],
		},
	},
	{
		name: "custom_plugin_tool",
		description: "A custom plugin tool",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string" },
			},
		},
	},
];

const mockWorkspacePolicy: WorkspacePolicy = {
	cwd: "/test",
	readOnly: false,
};

let lastInvocationRequest: ToolInvocationRequest | undefined;

const mockHarness: HarnessSessionInterface = {
	sessionId: "test-session-123",
	workspacePolicy: mockWorkspacePolicy,
	getTools(): readonly ToolDescriptor[] {
		return mockTools;
	},
	getTool(name: string): ToolDescriptor | undefined {
		return mockTools.find(t => t.name === name);
	},
	hasTool(name: string): boolean {
		return mockTools.some(t => t.name === name);
	},
	async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
		lastInvocationRequest = request;
		if (request.toolName === "read_file") {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: "file content hello world" }],
			};
		}
		if (request.toolName === "error_tool") {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: "tool failure" }],
				isError: true,
			};
		}
		return {
			callId: request.callId,
			toolName: request.toolName,
			content: [{ type: "text", text: "ok" }],
		};
	},
};

async function runTests() {
	const server = new OhMyPiMcpServer(mockHarness);

	// 1. initialize
	const initRes = await server.handleMessage({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		},
	});
	assert.deepEqual(initRes, {
		jsonrpc: "2.0",
		id: 1,
		result: {
			protocolVersion: "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: { name: "ohmypi-mcp-server", version: "0.1.0" },
		},
	});

	// 2. tools/list
	const listRes = (await server.handleMessage({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/list",
	})) as any;
	assert.equal(listRes.jsonrpc, "2.0");
	assert.equal(listRes.id, 2);
	assert.equal(listRes.result.tools.length, 2);
	assert.equal(listRes.result.tools[0].name, "read_file");
	assert.equal(listRes.result.tools[0].description, "Read a file from disk");
	assert.equal(listRes.result.tools[0].inputSchema.type, "object");
	assert.deepEqual(listRes.result.tools[0].inputSchema.required, ["filePath"]);
	assert.equal(listRes.result.tools[1].name, "custom_plugin_tool");

	// 3. tools/call - success
	const callRes = (await server.handleMessage({
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: {
			name: "read_file",
			arguments: { filePath: "/test/hello.txt" },
		},
	})) as any;
	assert.equal(callRes.jsonrpc, "2.0");
	assert.equal(callRes.id, 3);
	assert.equal(callRes.result.content[0].type, "text");
	assert.equal(lastInvocationRequest?.toolName, "read_file");
	assert.deepEqual(lastInvocationRequest?.arguments, { filePath: "/test/hello.txt" });

	// 4. tools/call - unavailable tool
	const unavailRes = (await server.handleMessage({
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: {
			name: "non_existent_tool",
			arguments: {},
		},
	})) as any;
	assert.equal(unavailRes.jsonrpc, "2.0");
	assert.equal(unavailRes.id, 4);
	assert.equal(unavailRes.result.isError, true);

	// 5. ping
	const pingRes = await server.handleMessage({
		jsonrpc: "2.0",
		id: 5,
		method: "ping",
	});
	assert.deepEqual(pingRes, {
		jsonrpc: "2.0",
		id: 5,
		result: {},
	});

	// 6. JSON string input parsing
	const stringRes = (await server.handleMessage(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 6,
			method: "ping",
		}),
	)) as any;
	assert.deepEqual(stringRes, {
		jsonrpc: "2.0",
		id: 6,
		result: {},
	});

	// 7. connectTransport
	let receivedByTransport: any = null;
	let messageCallback: ((msg: any) => void) | null = null;
	const mockTransport = {
		send: (msg: any) => {
			receivedByTransport = msg;
		},
		onMessage: (cb: (msg: any) => void) => {
			messageCallback = cb;
		},
	};
	server.connectTransport(mockTransport);
	assert.ok(messageCallback);
	messageCallback!({
		jsonrpc: "2.0",
		id: 7,
		method: "ping",
	});
	// Wait a tick for async dispatch
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(receivedByTransport, {
		jsonrpc: "2.0",
		id: 7,
		result: {},
	});

	// 8. startStdioServer method exists
	assert.equal(typeof server.startStdioServer, "function");

	console.log("All OhMyPiMcpServer checks passed!");
}

runTests().catch(err => {
	console.error("Test failed:", err);
	process.exit(1);
});
