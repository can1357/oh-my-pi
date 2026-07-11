import { describe, expect, it } from "bun:test";
import type { DiscoverableTool } from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/tool-index";
import {
	buildDiscoverableToolSearchIndex,
	searchDiscoverableTools,
} from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/tool-index";

describe("generic index: DiscoverableTool round-trip", () => {
	const tools: DiscoverableTool[] = [
		{
			name: "glob",
			label: "glob",
			summary: "Find files matching a glob pattern",
			source: "builtin",
			schemaKeys: ["pattern", "path"],
		},
		{
			name: "mcp__gh_search",
			label: "github/search",
			summary: "Search GitHub repositories",
			source: "mcp",
			serverName: "github",
			mcpToolName: "search",
			schemaKeys: ["query"],
		},
	];

	it("builds and searches without loss", () => {
		const index = buildDiscoverableToolSearchIndex(tools);
		expect(index.documents).toHaveLength(2);

		const findResults = searchDiscoverableTools(index, "find files", 3);
		expect(findResults.some((r: any) => r.tool.name === "glob")).toBe(true);

		const ghResults = searchDiscoverableTools(index, "github search", 3);
		expect(ghResults.some((r: any) => r.tool.name === "mcp__gh_search")).toBe(true);
	});

	it("preserves source field in search results", () => {
		const index = buildDiscoverableToolSearchIndex(tools);
		const results = searchDiscoverableTools(index, "github", 3);
		const ghResult = results.find((r: any) => r.tool.name === "mcp__gh_search");
		expect(ghResult).toBeDefined();
		expect(ghResult!.tool.source).toBe("mcp");
	});
});
