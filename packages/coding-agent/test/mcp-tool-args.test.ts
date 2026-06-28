import { describe, expect, it } from "bun:test";
import type { CustomToolContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools";
import { DeferredMCPTool, MCPTool, type MCPToolDefinition } from "@pk-nerdsaver-ai/pi-coding-agent/mcp";
import type { MCPServerConnection } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

type CapturedRequest = {
	method: string;
	params: Record<string, unknown> | undefined;
};

const unusedContext = {} as CustomToolContext;

function createSearchToolDefinition(): MCPToolDefinition {
	return {
		name: "search",
		description: "Search symbols or file locations",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string" },
				language: { type: "string" },
				file: { type: "string" },
				line: { type: "number" },
				column: { type: "number" },
				filters: { type: "object" },
				exact: { type: "boolean" },
			},
			required: ["symbol", "language"],
		},
	};
}

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

describe("MCP tool arguments", () => {
	it("omits optional empty placeholders before tools/call", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "", file: "", line: 0, filters: {}, exact: false },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "", line: 0, exact: false },
				},
			},
		]);
	});

	it("omits optional empty placeholders for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ symbol: "Foo", language: "TypeScript", file: "", column: "", filters: {} },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: {
					name: "search",
					arguments: { symbol: "Foo", language: "TypeScript" },
				},
			},
		]);
	});

	it("strips the harness intent field before tools/call", async () => {
		// Regression: the harness injects `i` into every tool's wire schema and
		// the eval `tool.*` bridge forwards it verbatim. Strict-schema MCP
		// servers (e.g. Linear) reject every such call with
		// `unrecognized_keys: ["i"]`. The MCP boundary owns the contract; `i`
		// must never reach `tools/call`.
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), createSearchToolDefinition());

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "looking up Foo", symbol: "Foo", language: "TypeScript", file: "" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Foo", language: "TypeScript" } },
			},
		]);
	});

	it("strips the harness intent field for deferred MCP tools", async () => {
		const calls: CapturedRequest[] = [];
		const connection = createCapturedConnection(calls);
		const tool = new DeferredMCPTool("intellij-index", createSearchToolDefinition(), async () => connection);

		await tool.execute(
			"call-1",
			{ [INTENT_FIELD]: "deferred lookup", symbol: "Bar", language: "TypeScript" },
			undefined,
			unusedContext,
			undefined,
		);

		expect(calls).toEqual([
			{
				method: "tools/call",
				params: { name: "search", arguments: { symbol: "Bar", language: "TypeScript" } },
			},
		]);
	});

	it("preserves `i` when the server's own schema declares it", async () => {
		// A server that legitimately exposes `i` as one of its parameters
		// must receive the caller-supplied value untouched. The boundary
		// guard checks the server's declared `properties` and steps aside.
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "echo",
			description: "Echo a single token",
			inputSchema: {
				type: "object",
				properties: { i: { type: "string" } },
				required: ["i"],
			},
		};
		const tool = new MCPTool(createCapturedConnection(calls), definition);

		await tool.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "hello" } } }]);
	});
});
