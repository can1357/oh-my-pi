import { describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
} from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/tool-index";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import {
	renderSearchToolBm25Description,
	SearchToolBm25Tool,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools/search-tool-bm25";

type DiscoveryToolSession = ToolSession & {
	isMCPDiscoveryEnabled: () => boolean;
	getDiscoverableTools: (filter?: { source?: DiscoverableTool["source"] }) => DiscoverableTool[];
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	getSelectedMCPToolNames: () => string[];
	activateDiscoveredMCPTools: (toolNames: string[]) => Promise<string[]>;
	getSelected: () => string[];
};

function createSession(tools: DiscoverableTool[], overrides: Partial<DiscoveryToolSession> = {}): DiscoveryToolSession {
	const selected: string[] = [];
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "mcp.discoveryMode": true }),
		isMCPDiscoveryEnabled: () => true,
		getDiscoverableTools: () => tools,
		getSelectedMCPToolNames: () => [...selected],
		activateDiscoveredMCPTools: async (toolNames: string[]) => {
			for (const name of toolNames) {
				if (!selected.includes(name)) {
					selected.push(name);
				}
			}
			return toolNames;
		},
		getSelected: () => [...selected],
		...overrides,
	};
}

/** Helper to create a discoverable MCP tool. */
function mcpTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	summary: string,
	schemaKeys: string[],
): DiscoverableTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		summary,
		source: "mcp",
		serverName,
		mcpToolName,
		schemaKeys,
	};
}

/** Helper to create a discoverable built-in tool. */
function builtinTool(name: string, summary: string, schemaKeys: string[] = []): DiscoverableTool {
	return {
		name,
		label: name,
		summary,
		source: "builtin",
		schemaKeys,
	};
}

describe("SearchToolBm25Tool", () => {
	const discoverableTools: DiscoverableTool[] = [
		mcpTool(
			"mcp__github_create_issue",
			"github",
			"create_issue",
			"Create a GitHub issue in the selected repository",
			["owner", "repo", "title", "body"],
		),
		mcpTool("mcp__github_list_pull_requests", "github", "list_pull_requests", "List pull requests for a repository", [
			"owner",
			"repo",
			"state",
		]),
		mcpTool("mcp__slack_post_message", "slack", "post_message", "Post a message to a Slack channel", [
			"channel",
			"text",
		]),
	];

	it("uses the session-provided cached search index during execution", async () => {
		let rawToolsCalls = 0;
		let searchIndexCalls = 0;
		const searchIndex = buildDiscoverableToolSearchIndex(discoverableTools);
		const session = createSession(discoverableTools, {
			getDiscoverableTools: () => {
				rawToolsCalls++;
				return discoverableTools;
			},
			getDiscoverableToolSearchIndex: () => {
				searchIndexCalls++;
				return searchIndex;
			},
		});
		const tool = new SearchToolBm25Tool(session);
		expect(rawToolsCalls).toBe(0);

		const result = await tool.execute("call-index", { query: "github" });
		expect(searchIndexCalls).toBe(1);
		expect(rawToolsCalls).toBe(0);
		expect(result.details?.tools.map(match => match.name)).toEqual([
			"mcp__github_create_issue",
			"mcp__github_list_pull_requests",
		]);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					query: "github",
					activated_tools: ["mcp__github_create_issue", "mcp__github_list_pull_requests"],
					match_count: 2,
					total_tools: 3,
					// Each match carries a compact signature so the model can call a
					// just-activated tool without guessing its call shape. These MCP
					// fixtures have no signature — params falls back to schema keys.
					tools: [
						{
							name: "mcp__github_create_issue",
							description: "Create a GitHub issue in the selected repository",
							params: ["owner", "repo", "title", "body"],
						},
						{
							name: "mcp__github_list_pull_requests",
							description: "List pull requests for a repository",
							params: ["owner", "repo", "state"],
						},
					],
				}),
			},
		]);
	});

	it("returns ranked matches and unions activated tools across repeated searches", async () => {
		const session = createSession(discoverableTools);
		const tool = new SearchToolBm25Tool(session);

		const firstResult = await tool.execute("call-1", { query: "github issue", limit: 1 });
		const firstDetails = firstResult.details;
		expect(firstDetails?.tools.map(match => match.name)).toEqual(["mcp__github_create_issue"]);
		expect(firstDetails?.active_selected_tools).toEqual(["mcp__github_create_issue"]);
		expect(session.getSelected()).toEqual(["mcp__github_create_issue"]);

		const secondResult = await tool.execute("call-2", { query: "slack message", limit: 1 });
		const secondDetails = secondResult.details;
		expect(secondDetails?.tools.map(match => match.name)).toEqual(["mcp__slack_post_message"]);
		expect(secondDetails?.active_selected_tools).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
		expect(session.getSelected()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
	});

	it("skips already-selected matches before applying limit", async () => {
		const session = createSession(discoverableTools);
		const tool = new SearchToolBm25Tool(session);

		const firstResult = await tool.execute("call-github-1", { query: "github", limit: 1 });
		expect(firstResult.details?.tools.map(match => match.name)).toEqual(["mcp__github_create_issue"]);
		expect(firstResult.details?.activated_tools).toEqual(["mcp__github_create_issue"]);

		const secondResult = await tool.execute("call-github-2", { query: "github", limit: 1 });
		expect(secondResult.details?.tools.map(match => match.name)).toEqual(["mcp__github_list_pull_requests"]);
		expect(secondResult.details?.activated_tools).toEqual(["mcp__github_list_pull_requests"]);
		expect(secondResult.details?.active_selected_tools).toEqual([
			"mcp__github_create_issue",
			"mcp__github_list_pull_requests",
		]);

		const exhaustedResult = await tool.execute("call-github-3", { query: "github", limit: 1 });
		expect(exhaustedResult.details?.tools).toEqual([]);
		expect(exhaustedResult.details?.activated_tools).toEqual([]);
		expect(exhaustedResult.details?.active_selected_tools).toEqual([
			"mcp__github_create_issue",
			"mcp__github_list_pull_requests",
		]);
	});

	it("rejects invalid input", async () => {
		const tool = new SearchToolBm25Tool(createSession(discoverableTools));

		await expect(tool.execute("call-empty", { query: "   " })).rejects.toThrow(
			"Query is required and must not be empty.",
		);
		await expect(tool.execute("call-limit", { query: "github", limit: 0 as never })).rejects.toThrow(
			"Limit must be a positive integer.",
		);
	});

	it("rejects execution when discovery mode is disabled", async () => {
		const tool = new SearchToolBm25Tool(
			createSession(discoverableTools, {
				isMCPDiscoveryEnabled: () => false,
				settings: Settings.isolated({ "mcp.discoveryMode": false }),
			}),
		);

		await expect(tool.execute("call-disabled", { query: "github" })).rejects.toThrow("Tool discovery is disabled.");
	});

	it("discovers built-in tools when using the new tools.discoveryMode=all setting", async () => {
		const builtinTools: DiscoverableTool[] = [
			builtinTool("find", "Find files and directories matching a glob pattern"),
			builtinTool("search", "Search file contents using ripgrep"),
		];
		const allTools = [...discoverableTools, ...builtinTools];
		const session = createSession(discoverableTools, {
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			getDiscoverableTools: () => allTools,
		});
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-builtin", { query: "find files" });
		const names = result.details?.tools.map(t => t.name) ?? [];
		expect(names).toContain("find");
	});

	it("reports param signatures (optionality + op enums) in the result content", async () => {
		const irc: DiscoverableTool = {
			...builtinTool("irc", "Send and receive messages between agents"),
			signature: ["await?", "from?", "message?", "op(send|wait|inbox|list|complete)", "peek?", "to?"],
		};
		const session = createSession([irc], {
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			getDiscoverableTools: () => [irc],
		});
		const tool = new SearchToolBm25Tool(session);

		const result = await tool.execute("call-signature", { query: "irc send message agents" });
		const text = result.content.find(part => part.type === "text");
		const parsed = JSON.parse((text as { text: string } | undefined)?.text ?? "{}") as {
			tools: Array<{ name: string; params: string[] }>;
		};
		expect(parsed.tools[0]?.name).toBe("irc");
		expect(parsed.tools[0]?.params).toContain("op(send|wait|inbox|list|complete)");
		expect(parsed.tools[0]?.params).toContain("to?");
	});
});

describe("renderSearchToolBm25Description", () => {
	function lineWith(rendered: string, prefix: string): string | undefined {
		return rendered.split("\n").find(line => line.startsWith(prefix));
	}

	it("lists discoverable built-in tool names alphabetically without leaking them into the MCP server line", () => {
		const rendered = renderSearchToolBm25Description([
			builtinTool("write", "Create or overwrite a file"),
			builtinTool("find", "Find files by name"),
			builtinTool("search", "Search file contents"),
			mcpTool("mcp__github_create_issue", "github", "create_issue", "Create a GitHub issue", ["owner"]),
			mcpTool("mcp__slack_post_message", "slack", "post_message", "Post a message to Slack", ["channel"]),
		]);

		// Built-in names are present verbatim, alphabetically ordered, on their own line.
		expect(lineWith(rendered, "Discoverable built-in tools:")).toBe(
			"Discoverable built-in tools: find, search, write.",
		);

		// Built-in names must not bleed into the MCP server-summary line.
		const mcpLine = lineWith(rendered, "Discoverable MCP servers");
		expect(mcpLine).toBe("Discoverable MCP servers in this session: github (1 tool), slack (1 tool).");
		expect(mcpLine).not.toContain("write");
		expect(mcpLine).not.toContain("find");
		expect(rendered).toContain(
			"Discoverable MCP servers in this session: github (1 tool), slack (1 tool).\n" +
				"Discoverable built-in tools: find, search, write.\n" +
				"Total discoverable tools available: 5.",
		);
	});

	it("omits the built-in line when the corpus has no built-ins (mcp-only mode)", () => {
		const rendered = renderSearchToolBm25Description([
			mcpTool("mcp__github_create_issue", "github", "create_issue", "Create a GitHub issue", ["owner"]),
		]);

		expect(rendered).not.toContain("Discoverable built-in tools:");
		expect(rendered).toContain(
			"Discoverable MCP servers in this session: github (1 tool).\nTotal discoverable tools available: 1.",
		);
	});

	it("keeps built-ins counted in the total discoverable tools line", () => {
		const rendered = renderSearchToolBm25Description([
			builtinTool("write", "Create or overwrite a file"),
			builtinTool("find", "Find files by name"),
			mcpTool("mcp__slack_post_message", "slack", "post_message", "Post a message to Slack", ["channel"]),
		]);

		expect(rendered).toContain("Total discoverable tools available: 3.");
	});
});
