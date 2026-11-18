import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type DownloadActivity, onDownloadActivity } from "@oh-my-pi/pi-coding-agent/downloads/activity";
import { SkillDescriptionStore } from "@oh-my-pi/pi-coding-agent/extensibility/skill-descriptions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import {
	EVAL_MCP_BRIDGE_NAME,
	groupMCPNamespaces,
	MCPEvalNamespaceCatalog,
	mcpNamespaceValue,
} from "@oh-my-pi/pi-coding-agent/mcp/eval-namespaces";
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

	it("names the MCP server, not its namespace, in the activity shown while a hint is generated", async () => {
		const dir = path.join(os.tmpdir(), `mcp-eval-ns-${Snowflake.next()}`);
		dirs.push(dir);
		const store = SkillDescriptionStore.open(path.join(dir, "hints.db"));
		const seen: DownloadActivity[] = [];
		const stop = onDownloadActivity(activity => seen.push(activity));
		try {
			const catalog = new MCPEvalNamespaceCatalog({
				store,
				compress: { modelKey: () => "test/fast", compress: async () => "Fetch web pages by URL" },
			});
			expect(catalog.preludes([mcpTool("fetch", "get")], new Set())[0].name).toBe("fetch_mcp");
			await catalog.waitForPending();

			expect(seen.map(activity => [activity.label, activity.state])).toEqual([
				["Optimizing MCP: fetch", "running"],
				["Optimizing MCP: fetch", "done"],
			]);
		} finally {
			stop();
			await store.close();
		}
	});

	it("installs methods that send their tool and arguments to the __mcp__ bridge op", async () => {
		const [prelude] = new MCPEvalNamespaceCatalog().preludes([mcpTool("github", "search_issues")], new Set());
		const calls: Array<[string, unknown]> = [];
		const context = vm.createContext({
			__omp_call_tool__: async (name: string, args: unknown) => {
				calls.push([name, args]);
				return "ok";
			},
		});
		vm.runInContext(prelude.javascript, context);
		expect(await vm.runInContext("github.search_issues({ query: 'x' })", context)).toBe("ok");
		expect(calls).toEqual([
			[
				EVAL_MCP_BRIDGE_NAME,
				{ tool: "mcp__github_search_issues", label: "github.search_issues", args: { query: "x" } },
			],
		]);
	});
});

describe("mcpNamespaceValue", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});
	const localOptions = () => {
		const dir = path.join(os.tmpdir(), `mcp-eval-ns-local-${Snowflake.next()}`);
		dirs.push(dir);
		return { getArtifactsDir: () => dir, getSessionId: () => "session" };
	};

	it("resolves to structured content, else text, when the result carries no media or resources", async () => {
		const local = localOptions();
		const text = {
			content: [{ type: "text" as const, text: "plain" }],
			details: { rawContent: [{ type: "text", text: "plain" }] },
		};
		expect(await mcpNamespaceValue("github.search", text, local)).toBe("plain");
		const structured = { ...text, details: { ...text.details, structuredContent: { hits: 2 } } };
		expect(await mcpNamespaceValue("github.search", structured, local)).toEqual({ hits: 2 });
	});

	it("saves images and binary resources under local:// and maps resource links", async () => {
		const local = localOptions();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
		const value = await mcpNamespaceValue(
			"github.shot",
			{
				content: [{ type: "text", text: "rendered for the model" }],
				details: {
					rawContent: [
						{ type: "text", text: "caption" },
						{ type: "image", data: png, mimeType: "image/png" },
						{ type: "resource", resource: { uri: "repo://readme", mimeType: "text/markdown", text: "# Hi" } },
						{ type: "resource", resource: { uri: "repo://logo", mimeType: "application/pdf", blob: png } },
						{ type: "resource_link", uri: "repo://issues/1", name: "Issue 1", mimeType: "application/json" },
					],
				},
			},
			local,
		);
		if (typeof value !== "object" || !Array.isArray(value.images) || !Array.isArray(value.resources)) {
			throw new Error(`expected a media result, got ${JSON.stringify(value)}`);
		}
		expect(value.text).toBe("caption");
		expect(value.images).toEqual([expect.stringMatching(/^local:\/\/mcp\/github\.shot-[0-9a-f]+\.png$/)]);
		expect([...(await Bun.file(resolveLocalUrlToPath(value.images[0], local)).bytes())]).toEqual([
			0x89, 0x50, 0x4e, 0x47,
		]);
		const [readme, logo, link] = value.resources;
		expect(readme).toEqual({ uri: "repo://readme", mimeType: "text/markdown", text: "# Hi" });
		expect(logo).toEqual({ uri: "repo://logo", mimeType: "application/pdf", path: expect.stringMatching(/\.pdf$/) });
		expect(await Bun.file(resolveLocalUrlToPath(logo.path ?? "", local)).exists()).toBe(true);
		expect(link).toEqual({ uri: "repo://issues/1", name: "Issue 1", mimeType: "application/json" });
	});

	it("throws the tool's error text", async () => {
		await expect(
			mcpNamespaceValue(
				"github.search",
				{ content: [{ type: "text", text: "Error: rate limited" }], details: { isError: true }, isError: true },
				localOptions(),
			),
		).rejects.toThrow("Error: rate limited");
	});
});
