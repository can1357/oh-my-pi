import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	applyMcpToggleRuntime,
	formatMcpHealthLabel,
	formatMcpListHint,
	inferMcpTransport,
	isDiscoveredMcpServer,
	type MCPRuntimeSource,
	snapshotMcpRuntime,
	visibleMcpTools,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";

function stubCustomTool(name: string): CustomTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute() {
			return { content: [{ type: "text", text: "" }] };
		},
	};
}

const source: SourceMeta = {
	provider: "native",
	providerName: "OMP (User)",
	path: "/home/sf/.omp/agent/mcp.json",
	level: "user",
};

function server(overrides: Partial<MCPServer> = {}): MCPServer {
	return {
		name: "github",
		command: "/usr/bin/github-mcp-server",
		args: ["stdio"],
		transport: "stdio",
		_source: source,
		...overrides,
	};
}

function transport(): MCPTransport {
	return {
		connected: true,
		request() {
			return Promise.reject(new Error("unused"));
		},
		notify() {
			return Promise.resolve();
		},
		close() {
			return Promise.resolve();
		},
	};
}

function connection(overrides: Partial<MCPServerConnection> = {}): MCPServerConnection {
	return {
		name: "github",
		config: { command: "/usr/bin/github-mcp-server", args: ["stdio"] },
		transport: transport(),
		serverInfo: {
			name: "github-mcp-server",
			title: "GitHub MCP Server",
			version: "0.19.0",
			description: "Access GitHub repositories, issues, and pull requests.",
		},
		capabilities: { tools: {}, resources: {}, prompts: {} },
		tools: [
			{
				name: "search_code",
				description: "Search code across GitHub repositories.",
				inputSchema: {
					type: "object",
					required: ["query"],
					properties: {
						query: { type: "string", description: "Search query" },
						language: { type: "string", description: "Optional language filter" },
					},
				},
			},
			{ name: "get_pull_request", description: "Get pull request details.", inputSchema: { type: "object" } },
		],
		resources: [{ uri: "github://repo", name: "repo" }],
		prompts: [{ name: "review_pr", description: "Review a pull request" }],
		instructions: "Prefer search_code over cloning.",
		...overrides,
	};
}

function sourceFor(status: "connected" | "connecting" | "disconnected", conn?: MCPServerConnection): MCPRuntimeSource {
	return {
		getConnectionStatus: () => status,
		getConnection: () => conn,
		getFilterEmptyToolCount: () => undefined,
		getTools: () =>
			(conn?.tools ?? []).map(tool => ({
				mcpServerName: conn?.name,
				mcpToolName: tool.name,
				description: tool.description,
			})),
		getServerResources: () =>
			conn ? { resources: conn.resources ?? [], templates: conn.resourceTemplates ?? [] } : undefined,
		getServerPrompts: () => conn?.prompts,
	};
}

describe("snapshotMcpRuntime", () => {
	test("does not treat command/url as a description", () => {
		const snap = snapshotMcpRuntime(server(), undefined);
		expect(snap.description).toBeUndefined();
		expect(snap.command).toBe("/usr/bin/github-mcp-server");
		expect(snap.health).toBe("disconnected");
		expect(snap.transport).toBe("stdio");
	});

	test("joins live connection identity, tools, and instructions", () => {
		const conn = connection();
		const snap = snapshotMcpRuntime(server(), sourceFor("connected", conn));
		expect(snap.health).toBe("connected");
		expect(snap.title).toBe("GitHub MCP Server");
		expect(snap.description).toBe("Access GitHub repositories, issues, and pull requests.");
		expect(snap.implementationName).toBe("github-mcp-server");
		expect(snap.implementationVersion).toBe("0.19.0");
		expect(snap.tools.map(t => t.name)).toEqual(["search_code", "get_pull_request"]);
		expect(snap.tools[0]?.description).toBe("Search code across GitHub repositories.");
		expect(snap.tools[0]?.parameters).toEqual({
			type: "object",
			required: ["query"],
			properties: {
				query: { type: "string", description: "Search query" },
				language: { type: "string", description: "Optional language filter" },
			},
		});
		expect(snap.resources).toHaveLength(1);
		expect(snap.prompts).toHaveLength(1);
		expect(snap.instructions).toBe("Prefer search_code over cloning.");
		expect(formatMcpListHint(snap)).toBe("2 tools · 1 resource · 1 prompt");
	});
	test("maps connecting and inactive separately from enabled-in-config", () => {
		expect(snapshotMcpRuntime(server(), sourceFor("connecting")).health).toBe("connecting");
		expect(snapshotMcpRuntime(server(), sourceFor("disconnected")).health).toBe("disconnected");
		expect(snapshotMcpRuntime(server({ enabled: false }), sourceFor("connected", connection())).health).toBe(
			"inactive",
		);
		expect(snapshotMcpRuntime(server(), sourceFor("connected", connection()), { enabled: false }).health).toBe(
			"inactive",
		);
	});

	test("does not join a shadowed same-name config against the winner", () => {
		const winner = connection();
		const snap = snapshotMcpRuntime(server({ command: "/usr/bin/shadowed-github" }), sourceFor("connected", winner), {
			shadowed: true,
		});
		expect(snap.health).toBe("disconnected");
		expect(snap.title).toBeUndefined();
		expect(snap.description).toBeUndefined();
		expect(snap.tools).toEqual([]);
		expect(snap.instructions).toBeUndefined();
		expect(snap.command).toBe("/usr/bin/shadowed-github");
	});

	test("infers http from url when transport is omitted", () => {
		expect(inferMcpTransport({ name: "remote", url: "https://example.test/mcp", _source: source })).toBe("http");
		expect(inferMcpTransport({ type: "sse", url: "https://example.test/sse" })).toBe("sse");
		expect(isDiscoveredMcpServer(server())).toBe(true);
		expect(isDiscoveredMcpServer({ command: "echo" })).toBe(false);
	});

	test("visibleMcpTools truncates with a leftover count", () => {
		const tools = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${i}` }));
		const { shown, hidden } = visibleMcpTools(tools, 8);
		expect(shown).toHaveLength(8);
		expect(hidden).toBe(4);
		expect(formatMcpHealthLabel("disconnected")).toBe("Not connected");
	});

	test("strips OSC/BEL/tabs from server-provided display fields before theming", () => {
		const dirty = connection({
			serverInfo: {
				name: "github-mcp-server",
				title: "GitHub\nMCP\tServer",
				version: "0.19.0",
				description: "Access\x1b[31m GitHub",
			},
			tools: [
				{
					name: "search_code",
					description: "Search\x07 code",
					inputSchema: { type: "object" },
				},
			],
			instructions: "Prefer\x1b[1m search_code",
		});
		const snap = snapshotMcpRuntime(server(), sourceFor("connected", dirty));
		expect(snap.title).toBe("GitHub MCP   Server");
		expect(snap.title).not.toContain("\n");
		expect(snap.title).not.toContain("\t");
		expect(snap.description).toBe("Access GitHub");
		expect(snap.tools[0]?.description).toBe("Search code");
		expect(snap.instructions).toBe("Prefer search_code");
	});
	test("reports filter-empty health when the filter excluded every advertised tool", () => {
		const conn = connection();
		const filterEmptySource: MCPRuntimeSource = {
			...sourceFor("connected", conn),
			getFilterEmptyToolCount: () => 2,
		};
		const snap = snapshotMcpRuntime(server(), filterEmptySource);
		expect(snap.health).toBe("filter-empty");
		expect(formatMcpHealthLabel("filter-empty")).toBe("Filter excludes all tools");
		expect(formatMcpListHint(snap)).toBe("tool filter excludes every tool");
	});
	test("a configured filter renders raw definitions selected to the manager set", () => {
		// Regression: filtered mode previously rendered manager tools, which
		// drop the MCP title; and unfiltered mode showed the raw pre-filter
		// list including excluded tools. The correct render is the raw
		// definitions selected down to the manager's filtered names.
		const conn = connection({
			config: { command: "/usr/bin/github-mcp-server", enabledTools: ["search_code"] },
			tools: [
				{
					name: "search_code",
					title: "Search code tool",
					description: "Search code across GitHub repositories.",
					inputSchema: { type: "object" },
				},
				{
					name: "delete_everything",
					description: "Destructive tool excluded by the filter.",
					inputSchema: { type: "object" },
				},
			],
		});
		const filteredSource: MCPRuntimeSource = {
			...sourceFor("connected", conn),
			getFilterEmptyToolCount: () => undefined,
			getTools: () => [
				{
					mcpServerName: "github",
					mcpToolName: "search_code",
					description: "Search code across GitHub repositories.",
					label: "mcp__github_search_code",
				},
			],
		};
		const snap = snapshotMcpRuntime(server(), filteredSource);
		expect(snap.tools.map(t => t.name)).toEqual(["search_code"]);
		expect(snap.tools[0]?.title).toBe("Search code tool");
		expect(snap.tools[0]?.description).toBe("Search code across GitHub repositories.");
	});
});

describe("applyMcpToggleRuntime", () => {
	test("disable disconnects the live manager and refreshes session tools", async () => {
		const disconnected: string[] = [];
		const refreshed: CustomTool[][] = [];
		const tools = [stubCustomTool("other_tool")];
		await applyMcpToggleRuntime({
			name: "github",
			enabled: false,
			cwd: "/tmp",
			manager: {
				getConnectionStatus: () => "connected",
				getTools: () => tools,
				disconnectServer: async name => {
					disconnected.push(name);
				},
				connectServers: async () => {
					throw new Error("disable must not reconnect");
				},
			},
			session: {
				refreshMCPTools: next => {
					refreshed.push(next);
				},
			},
		});
		expect(disconnected).toEqual(["github"]);
		expect(refreshed).toEqual([tools]);
	});

	test("enable reconnects a disconnected server then refreshes session tools", async () => {
		const connected: Array<Record<string, { command: string }>> = [];
		const refreshed: CustomTool[][] = [];
		const tools = [stubCustomTool("github_search")];
		await applyMcpToggleRuntime({
			name: "github",
			enabled: true,
			cwd: "/tmp/project",
			loadConfigs: async () => ({
				configs: { github: { command: "github-mcp-server" } },
				sources: {},
				exaApiKeys: [],
			}),
			manager: {
				getConnectionStatus: () => "disconnected",
				getTools: () => tools,
				disconnectServer: async () => {
					throw new Error("enable must not disconnect");
				},
				connectServers: async configs => {
					connected.push(configs as Record<string, { command: string }>);
					return { errors: new Map() };
				},
			},
			session: {
				refreshMCPTools: next => {
					refreshed.push(next);
				},
			},
		});
		expect(connected).toEqual([{ github: { command: "github-mcp-server" } }]);
		expect(refreshed).toEqual([tools]);
	});

	test("enable passes startup discovery filters into config load", async () => {
		const loads: Array<{ cwd: string; options: unknown }> = [];
		const connected: string[] = [];
		await applyMcpToggleRuntime({
			name: "project-only",
			enabled: true,
			cwd: "/tmp/project",
			discovery: { enableProjectConfig: false, filterExa: true, filterBrowser: true },
			loadConfigs: async (cwd, options) => {
				loads.push({ cwd, options });
				return { configs: {}, sources: {}, exaApiKeys: [] };
			},
			manager: {
				getConnectionStatus: () => "disconnected",
				getTools: () => [],
				disconnectServer: async () => {
					throw new Error("enable must not disconnect");
				},
				connectServers: async configs => {
					connected.push(...Object.keys(configs));
					return { errors: new Map() };
				},
			},
		});
		expect(loads).toEqual([
			{
				cwd: "/tmp/project",
				options: { enableProjectConfig: false, filterExa: true, filterBrowser: true },
			},
		]);
		expect(connected).toEqual([]);
	});
});
