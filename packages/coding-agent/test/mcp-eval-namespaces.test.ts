import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { SkillDescriptionStore } from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import { groupMCPNamespaces, MCPEvalNamespaceCatalog } from "@oh-my-pi/pi-coding-agent/mcp/eval-namespaces";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function mcpTool(server: string, tool: string, description = `${tool} on ${server}`): AgentTool {
	// A registry entry carries its MCP route beside the AgentTool fields.
	const entry = {
		name: createMCPToolName(server, tool),
		label: `${server}/${tool}`,
		description,
		parameters: type({ "query?": "string" }),
		mcpServerName: server,
		mcpToolName: tool,
		async execute() {
			return { content: [] };
		},
	};
	return entry;
}

describe("groupMCPNamespaces", () => {
	it("names namespaces after the minted server half, avoiding globals either kernel already binds", () => {
		const namespaces = groupMCPNamespaces(
			[
				mcpTool("github", "github_search"),
				mcpTool("github", "import"),
				mcpTool("fetch", "get"),
				mcpTool("browser", "open"),
				mcpTool("123", "ping"),
				mcpTool("linear", "list"),
				mcpTool("foo.bar", "a"),
				mcpTool("foo_bar", "b"),
			],
			new Set(["linear"]),
		);
		expect(
			namespaces.map(namespace => ({
				name: namespace.name,
				servers: namespace.servers,
				methods: namespace.methods.map(method => `${method.name}→${method.tool.name}`),
			})),
		).toEqual([
			{ name: "mcp_123", servers: ["123"], methods: ["ping→mcp__123_ping"] },
			{ name: "browser_mcp", servers: ["browser"], methods: ["open→mcp__browser_open"] },
			{ name: "fetch_mcp", servers: ["fetch"], methods: ["get→mcp__fetch_get"] },
			{ name: "foo_bar", servers: ["foo.bar", "foo_bar"], methods: ["a→mcp__foo_bar_a", "b→mcp__foo_bar_b"] },
			{ name: "github", servers: ["github"], methods: ["import_→mcp__github_import", "search→mcp__github_search"] },
			{ name: "linear_mcp", servers: ["linear"], methods: ["list→mcp__linear_list"] },
		]);
	});
});

describe("MCPEvalNamespaceCatalog", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it("lists a namespace without a hint until generated, then reuses the cached hint", async () => {
		const dir = path.join(os.tmpdir(), `mcp-eval-ns-${Snowflake.next()}`);
		dirs.push(dir);
		const store = SkillDescriptionStore.open(path.join(dir, "hints.db"));
		try {
			const requests: string[] = [];
			const compress = {
				modelKey: () => "test/fast",
				compress: async (_name: string, _description: string, request: string) => {
					requests.push(request);
					return "GitHub issues and pull requests";
				},
			};
			const tools = [mcpTool("github", "search_issues", "Search issues by query.")];
			const first = new MCPEvalNamespaceCatalog({ store, compress });
			expect(first.preludes(tools, new Set()).map(prelude => prelude.summary)).toEqual([""]);
			await first.waitForPending();
			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("search_issues: Search issues by query.");
			// The session that asked keeps its rendered (empty) hint; the next one gets the answer.
			expect(first.preludes(tools, new Set())[0].summary).toBe("");
			const second = new MCPEvalNamespaceCatalog({ store, compress });
			expect(second.preludes(tools, new Set())[0].summary).toBe("GitHub issues and pull requests");
			// A changed function listing is a new request.
			const changed = [...tools, mcpTool("github", "create_issue", "Open an issue.")];
			expect(second.preludes(changed, new Set())[0].summary).toBe("");
		} finally {
			await store.close();
		}
	});

	it("installs methods that return structured content and throw on tool errors", async () => {
		const [prelude] = new MCPEvalNamespaceCatalog().preludes([mcpTool("github", "search_issues")], new Set());
		const calls: Array<[string, unknown]> = [];
		const context = vm.createContext({
			__omp_call_tool__: async (name: string, args: { query?: string }) => {
				calls.push([name, args]);
				if (args.query === "boom") return { text: "Error: exploded", details: {}, hasError: true };
				if (args.query === "text") return "plain";
				return { text: "{}", details: { structuredContent: { hits: 1 } } };
			},
		});
		vm.runInContext(prelude.javascript, context);
		const github = vm.runInContext("github", context);
		expect(await github.search_issues({ query: "x" })).toEqual({ hits: 1 });
		expect(await github.search_issues({ query: "text" })).toBe("plain");
		await expect(github.search_issues({ query: "boom" })).rejects.toThrow("Error: exploded");
		expect(calls[0]).toEqual(["mcp__github_search_issues", { query: "x" }]);
	});
});
