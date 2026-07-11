import { describe, expect, it } from "bun:test";
import type { DiscoverableTool } from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/tool-index";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	filterBySource,
	formatDiscoverableToolServerSummary,
	getDiscoverableTool,
	isMCPToolName,
	searchDiscoverableTools,
	selectDiscoverableToolNamesByServer,
	summarizeDiscoverableTools,
} from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/tool-index";
import { type } from "arktype";

// ─── Minimal AgentTool stub ───────────────────────────────────────────────────

function makeAgentTool(
	name: string,
	opts: {
		label?: string;
		description?: string;
		mcpServerName?: string;
		mcpToolName?: string;
		parameters?: object;
	} = {},
) {
	return {
		name,
		label: opts.label ?? name,
		description: opts.description ?? `${name} description`,
		mcpServerName: opts.mcpServerName,
		mcpToolName: opts.mcpToolName,
		parameters: opts.parameters,
		strict: false,
		async execute() {
			return { content: [] };
		},
	} as any;
}

function mcpAgentTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[] = [],
) {
	const properties = Object.fromEntries(schemaKeys.map(k => [k, { type: "string" }]));
	return makeAgentTool(name, {
		label: `${serverName}/${mcpToolName}`,
		description,
		mcpServerName: serverName,
		mcpToolName,
		parameters: { type: "object", properties },
	});
}

// ─── isMCPToolName ────────────────────────────────────────────────────────────

describe("isMCPToolName", () => {
	it("returns true for mcp__ prefixed names", () => {
		expect(isMCPToolName("mcp__github_search")).toBe(true);
		expect(isMCPToolName("mcp__")).toBe(true);
	});
	it("returns false for non-mcp names", () => {
		expect(isMCPToolName("read")).toBe(false);
		expect(isMCPToolName("bash")).toBe(false);
		expect(isMCPToolName("")).toBe(false);
	});
});

// ─── getDiscoverableTool ──────────────────────────────────────────────────────

describe("getDiscoverableTool", () => {
	it("infers source=mcp from mcp__ prefix", () => {
		const tool = mcpAgentTool("mcp__gh_search", "github", "search", "Search repositories", ["query"]);
		const result = getDiscoverableTool(tool);
		expect(result).not.toBeNull();
		expect(result!.source).toBe("mcp");
		expect(result!.serverName).toBe("github");
		expect(result!.mcpToolName).toBe("search");
	});

	it("infers source=builtin for non-mcp names", () => {
		const tool = makeAgentTool("read", { description: "Read a file" });
		const result = getDiscoverableTool(tool);
		expect(result).not.toBeNull();
		expect(result!.source).toBe("builtin");
		expect(result!.serverName).toBeUndefined();
	});

	it("respects source override", () => {
		const tool = makeAgentTool("my_ext_tool", { description: "Custom extension tool" });
		const result = getDiscoverableTool(tool, { source: "extension" });
		expect(result!.source).toBe("extension");
	});

	it("falls back to description (first 200 chars) as summary when no summary override", () => {
		const longDesc = "A".repeat(300);
		const tool = makeAgentTool("foo", { description: longDesc });
		const result = getDiscoverableTool(tool);
		expect(result!.summary).toBe("A".repeat(200));
	});

	it("uses summary override when provided", () => {
		const tool = makeAgentTool("foo", { description: "Long description..." });
		const result = getDiscoverableTool(tool, { summary: "Short summary" });
		expect(result!.summary).toBe("Short summary");
	});

	it("extracts schema keys from parameters.properties", () => {
		const tool = makeAgentTool("foo", {
			parameters: { type: "object", properties: { alpha: {}, beta: {}, gamma: {} } },
		});
		const result = getDiscoverableTool(tool);
		// sorted alphabetically
		expect(result!.schemaKeys).toEqual(["alpha", "beta", "gamma"]);
	});

	it("extracts schema keys from Zod-schema parameters via wire conversion", () => {
		const tool = makeAgentTool("foo", {
			parameters: type({ gamma: "string", alpha: "number?", beta: "boolean" }),
		});
		const result = getDiscoverableTool(tool);
		expect(result!.schemaKeys).toEqual(["alpha", "beta", "gamma"]);
	});
});

// ─── collectDiscoverableTools ─────────────────────────────────────────────────

describe("collectDiscoverableTools", () => {
	it("collects all tools from an iterable", () => {
		const tools = [makeAgentTool("read"), makeAgentTool("bash"), makeAgentTool("edit")];
		const result = collectDiscoverableTools(tools);
		expect(result).toHaveLength(3);
		expect(result.map(t => t.name)).toEqual(["read", "bash", "edit"]);
	});

	it("overrides source when specified", () => {
		const tools = [makeAgentTool("custom_tool")];
		const result = collectDiscoverableTools(tools, { source: "extension" });
		expect(result[0]!.source).toBe("extension");
	});

	it("uses summaryMap when provided", () => {
		const tools = [makeAgentTool("read", { description: "Reads a file from disk" })];
		const summaryMap = new Map([["read", "Short one-liner"]]);
		const result = collectDiscoverableTools(tools, { summaryMap });
		expect(result[0]!.summary).toBe("Short one-liner");
	});
});

// ─── filterBySource ───────────────────────────────────────────────────────────

describe("filterBySource", () => {
	const mixed: DiscoverableTool[] = [
		{ name: "read", label: "read", summary: "x", source: "builtin", schemaKeys: [] },
		{ name: "mcp__gh", label: "gh", summary: "x", source: "mcp", serverName: "gh", schemaKeys: [] },
		{ name: "ext_foo", label: "ext_foo", summary: "x", source: "extension", schemaKeys: [] },
	];

	it("filters by builtin", () => {
		expect(filterBySource(mixed, "builtin").map(t => t.name)).toEqual(["read"]);
	});
	it("filters by mcp", () => {
		expect(filterBySource(mixed, "mcp").map(t => t.name)).toEqual(["mcp__gh"]);
	});
	it("filters by extension", () => {
		expect(filterBySource(mixed, "extension").map(t => t.name)).toEqual(["ext_foo"]);
	});
});

// ─── summarizeDiscoverableTools ───────────────────────────────────────────────

describe("summarizeDiscoverableTools", () => {
	it("groups tools by server and counts them", () => {
		const tools: DiscoverableTool[] = [
			{ name: "mcp__gh_1", label: "gh/1", summary: "x", source: "mcp", serverName: "github", schemaKeys: [] },
			{ name: "mcp__gh_2", label: "gh/2", summary: "x", source: "mcp", serverName: "github", schemaKeys: [] },
			{ name: "mcp__sl_1", label: "sl/1", summary: "x", source: "mcp", serverName: "slack", schemaKeys: [] },
			{ name: "builtin_read", label: "read", summary: "x", source: "builtin", schemaKeys: [] },
		];
		const summary = summarizeDiscoverableTools(tools);
		expect(summary.toolCount).toBe(4);
		expect(summary.servers).toHaveLength(2);
		// Alphabetical order
		expect(summary.servers[0]).toEqual({ name: "github", toolCount: 2 });
		expect(summary.servers[1]).toEqual({ name: "slack", toolCount: 1 });
	});

	it("returns empty servers for tools without serverName", () => {
		const tools: DiscoverableTool[] = [
			{ name: "read", label: "read", summary: "x", source: "builtin", schemaKeys: [] },
		];
		const summary = summarizeDiscoverableTools(tools);
		expect(summary.toolCount).toBe(1);
		expect(summary.servers).toHaveLength(0);
	});
});

// ─── formatDiscoverableToolServerSummary ─────────────────────────────────────

describe("formatDiscoverableToolServerSummary", () => {
	it("formats singular", () => {
		expect(formatDiscoverableToolServerSummary({ name: "github", toolCount: 1 })).toBe("github (1 tool)");
	});
	it("formats plural", () => {
		expect(formatDiscoverableToolServerSummary({ name: "slack", toolCount: 3 })).toBe("slack (3 tools)");
	});
});

// ─── selectDiscoverableToolNamesByServer ──────────────────────────────────────

describe("selectDiscoverableToolNamesByServer", () => {
	const tools: DiscoverableTool[] = [
		{ name: "mcp__gh_1", label: "gh/1", summary: "x", source: "mcp", serverName: "github", schemaKeys: [] },
		{ name: "mcp__sl_1", label: "sl/1", summary: "x", source: "mcp", serverName: "slack", schemaKeys: [] },
		{ name: "read", label: "read", summary: "x", source: "builtin", schemaKeys: [] },
	];

	it("returns names for tools in the specified servers", () => {
		const result = selectDiscoverableToolNamesByServer(tools, new Set(["github"]));
		expect(result).toEqual(["mcp__gh_1"]);
	});

	it("returns empty array when serverNames is empty", () => {
		expect(selectDiscoverableToolNamesByServer(tools, new Set())).toEqual([]);
	});
});

// ─── buildDiscoverableToolSearchIndex + searchDiscoverableTools ───────────────

describe("BM25 search", () => {
	const tools: DiscoverableTool[] = [
		{
			name: "mcp__github_create_issue",
			label: "github/create_issue",
			summary: "Create a GitHub issue in the selected repository",
			source: "mcp",
			serverName: "github",
			mcpToolName: "create_issue",
			schemaKeys: ["owner", "repo", "title", "body"],
		},
		{
			name: "mcp__github_list_prs",
			label: "github/list_pull_requests",
			summary: "List pull requests for a GitHub repository",
			source: "mcp",
			serverName: "github",
			mcpToolName: "list_pull_requests",
			schemaKeys: ["owner", "repo", "state"],
		},
		{
			name: "mcp__slack_post",
			label: "slack/post_message",
			summary: "Post a message to a Slack channel",
			source: "mcp",
			serverName: "slack",
			mcpToolName: "post_message",
			schemaKeys: ["channel", "text"],
		},
		{
			name: "glob",
			label: "glob",
			summary: "Find files and directories matching a glob pattern",
			source: "builtin",
			schemaKeys: ["pattern", "path"],
		},
	];

	const index = buildDiscoverableToolSearchIndex(tools);

	it("builds an index with the correct document count", () => {
		expect(index.documents).toHaveLength(4);
	});

	it("returns ranked matches for a query", () => {
		const results = searchDiscoverableTools(index, "github issue", 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.tool.name).toBe("mcp__github_create_issue");
		expect(results[0]!.score).toBeGreaterThan(0);
	});

	it("finds built-in tools too", () => {
		const results = searchDiscoverableTools(index, "find files", 5);
		expect(results.some(r => r.tool.name === "glob")).toBe(true);
	});

	it("respects the limit", () => {
		const results = searchDiscoverableTools(index, "github", 1);
		expect(results).toHaveLength(1);
	});

	it("returns empty array for query matching nothing", () => {
		const results = searchDiscoverableTools(index, "xyzzy_nonexistent_term_12345", 5);
		expect(results).toHaveLength(0);
	});

	it("throws for empty query", () => {
		expect(() => searchDiscoverableTools(index, "   ", 5)).toThrow(
			"Query must contain at least one letter or number.",
		);
	});

	it("returns empty array when index has no documents", () => {
		const emptyIndex = buildDiscoverableToolSearchIndex([]);
		const results = searchDiscoverableTools(emptyIndex, "github", 5);
		expect(results).toHaveLength(0);
	});
});
