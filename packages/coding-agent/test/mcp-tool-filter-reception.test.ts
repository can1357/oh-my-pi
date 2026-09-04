/**
 * Integration test for MCP tool filtering at the reception boundary (`listTools`).
 *
 * Contracts defended here:
 * - `listTools` filters tools immediately upon receiving them from `tools/list`.
 * - `connection.tools` contains ONLY the allowed tools.
 * - Tool definitions, descriptions, and input schemas survive filtering untouched.
 * - Second call to `listTools` returns the cached filtered tools.
 * - An all-excluding filter returns [] without throwing or disconnecting the transport.
 */
import { describe, expect, it } from "bun:test";
import { listTools } from "../src/mcp/client";
import type { MCPToolDefinition, MCPToolsListResult } from "../src/mcp/types";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const FIXTURE_TOOLS: MCPToolDefinition[] = [
	{
		name: "search",
		description: "Search documents",
		inputSchema: { type: "object", properties: { query: { type: "string" } } },
	},
	{
		name: "read_file",
		description: "Read file contents",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
	},
	{
		name: "write_file",
		description: "Write file contents",
		inputSchema: { type: "object", properties: { path: { type: "string" }, data: { type: "string" } } },
	},
	{
		name: "admin/delete",
		description: "Delete a resource",
		inputSchema: { type: "object" },
	},
];

function createConnectionWithTools(config: { enabledTools?: string[]; disabledTools?: string[] }) {
	const listResult: MCPToolsListResult = { tools: FIXTURE_TOOLS };
	const transport = createMockTransport(new Map([["tools/list", [listResult]]]));
	const conn = createMockConnection({ tools: {} }, transport);
	conn.config = {
		...conn.config,
		...config,
	};
	return conn;
}

describe("MCP tool filtering at reception boundary (listTools)", () => {
	it("filters tools using enabledTools allowlist", async () => {
		const conn = createConnectionWithTools({ enabledTools: ["read_*", "admin*"] });
		const tools = await listTools(conn);

		expect(tools.map(t => t.name)).toEqual(["read_file", "admin/delete"]);
		expect(conn.tools?.map(t => t.name)).toEqual(["read_file", "admin/delete"]);
		// Definition schemas are preserved
		expect(tools[0]).toEqual(FIXTURE_TOOLS[1]);
		expect(tools[1]).toEqual(FIXTURE_TOOLS[3]);
	});

	it("applies disabledTools denylist with deny subtracting from allow", async () => {
		const conn = createConnectionWithTools({
			enabledTools: ["read_*", "admin*"],
			disabledTools: ["admin/*"],
		});
		const tools = await listTools(conn);

		expect(tools.map(t => t.name)).toEqual(["read_file"]);
		expect(conn.tools?.map(t => t.name)).toEqual(["read_file"]);
	});

	it("caches filtered tools on connection for subsequent calls", async () => {
		const conn = createConnectionWithTools({ enabledTools: ["search"] });
		const first = await listTools(conn);
		expect(first.map(t => t.name)).toEqual(["search"]);

		// Second call returns cached tools without querying transport again
		const second = await listTools(conn);
		expect(second).toBe(first);
		expect(conn.tools).toBe(first);
	});

	it("returns empty array and keeps connection alive when filter excludes all tools", async () => {
		const conn = createConnectionWithTools({ enabledTools: ["nonexistent_*"] });
		const tools = await listTools(conn);

		expect(tools).toEqual([]);
		expect(conn.tools).toEqual([]);
		expect(conn.transport.connected).toBe(true);
	});
});
