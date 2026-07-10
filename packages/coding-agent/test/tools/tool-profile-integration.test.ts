import { describe, expect, it } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	buildDiscoverableToolSearchIndex,
	type DiscoverableTool,
} from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/tool-index";
import {
	createTools,
	filterInitialToolsForDiscoveryAll,
	type ToolSession,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { SearchToolBm25Tool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/search-tool-bm25";
import {
	isToolCapabilityAllowed,
	type ResolvedToolProfile,
	resolveToolProfile,
	type ToolSource,
} from "@pk-nerdsaver-ai/pi-coding-agent/tools/tool-profiles";

function createToolSession(toolProfile?: ResolvedToolProfile): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"tools.discoveryMode": "off",
			"mcp.discoveryMode": false,
			"bash.enabled": true,
			"todo.enabled": false,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		skipPythonPreflight: true,
		toolProfile,
	};
}

function discoverable(
	name: string,
	label: string,
	source: DiscoverableTool["source"],
	summary: string,
): DiscoverableTool {
	return { name, label, source, summary, schemaKeys: [] };
}

describe("resolved tool profile integration", () => {
	it("enforces explicit deny-all during construction while undefined preserves legacy unrestricted tools", async () => {
		const denyAll = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			agentTools: [],
			requireYield: true,
		});
		const constrained = await createTools(createToolSession(denyAll), ["read", "bash", "yield"]);
		const legacy = await createTools(createToolSession(undefined), ["read", "bash", "yield"]);

		expect(constrained.map(tool => tool.name).sort()).toEqual(["resolve", "yield"]);
		expect(legacy.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "bash", "yield", "resolve"]));
		expect(SearchToolBm25Tool.createIf(createToolSession(denyAll), { toolProfile: denyAll })).toBeNull();
	});

	it("does not let restored, forced, or automatic names exceed the source-qualified ceiling", () => {
		const profile = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			declaredCapabilities: [
				{ source: "builtin", name: "read" },
				{ source: "mcp", name: "mcp__docs_search" },
			],
		});
		const sourceOf = (name: string): ToolSource | undefined => {
			if (name.startsWith("mcp__")) return "mcp";
			if (name.startsWith("extension_")) return "extension";
			if (name === "read" || name === "bash") return "builtin";
			return undefined;
		};

		const active = filterInitialToolsForDiscoveryAll(
			["read", "bash", "mcp__docs_search", "mcp__deploy", "extension_read"],
			{
				loadModeOf: name => (name === "read" || name === "bash" ? "essential" : undefined),
				essentialNames: new Set(["read", "bash"]),
				explicitlyRequested: new Set(),
				restored: new Set(["bash", "mcp__deploy"]),
				forceActive: new Set(["extension_read"]),
				toolProfile: profile,
				sourceOf,
			},
		);

		expect(active).toEqual(["read", "mcp__docs_search"]);
		expect(isToolCapabilityAllowed(profile, { source: "builtin", name: "read" })).toBe(true);
		expect(isToolCapabilityAllowed(profile, { source: "extension", name: "read" })).toBe(false);
	});

	it("filters BM25 results and activation by MCP or extension source before callbacks run", async () => {
		const profile = resolveToolProfile({
			tier: "frontier",
			autonomy: "independent",
			declaredCapabilities: [
				{ source: "builtin", name: "search_tool_bm25" },
				{ source: "builtin", name: "read" },
				{ source: "mcp", name: "mcp__docs_search" },
			],
		});
		const tools: DiscoverableTool[] = [
			discoverable("read", "Builtin Read", "builtin", "read documentation files"),
			discoverable("read", "Extension Read", "extension", "read documentation files"),
			discoverable("mcp__docs_search", "Docs Search", "mcp", "search documentation"),
			discoverable("mcp__deploy", "Deploy", "mcp", "deploy documentation service"),
		];
		const activated: string[] = [];
		const session: ToolSession = {
			...createToolSession(profile),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			isToolDiscoveryEnabled: () => true,
			getDiscoverableTools: () => tools,
			getDiscoverableToolSearchIndex: () => buildDiscoverableToolSearchIndex(tools),
			getSelectedDiscoveredToolNames: () => [...activated],
			activateDiscoveredTools: async names => {
				activated.push(...names);
				return names;
			},
		};
		const tool = SearchToolBm25Tool.createIf(session, { toolProfile: profile });
		expect(tool).not.toBeNull();

		const result = await tool?.execute("search-profile", { query: "read search documentation", limit: 8 });
		const labels = result?.details?.tools.map(match => match.label) ?? [];
		expect(labels).toContain("Builtin Read");
		expect(labels).toContain("Docs Search");
		expect(labels).not.toContain("Extension Read");
		expect(labels).not.toContain("Deploy");
		expect(activated).toEqual(expect.arrayContaining(["read", "mcp__docs_search"]));
		expect(activated).not.toContain("mcp__deploy");
	});
});
