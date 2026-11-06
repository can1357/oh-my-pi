import { describe, expect, test } from "bun:test";
import {
	type MCPServerDisplay,
	type MCPConnectionDisplay,
	formatMcpHealthLabel,
	formatMcpListHint,
	inferMcpTransport,
	isDiscoveredMcpServer,
	type MCPRuntimeSource,
	snapshotMcpRuntime,
	visibleMcpTools,
} from "../src/overlays/extensions/mcp-runtime";

const source = {
	provider: "native",
	providerName: "OMP (User)",
	path: "/home/sf/.omp/agent/mcp.json",
	level: "user",
};

function server(overrides: Partial<MCPServerDisplay> = {}): MCPServerDisplay {
	return {
		name: "github",
		command: "/usr/bin/github-mcp-server",
		args: ["stdio"],
		transport: "stdio",
		_source: source,
		...overrides,
	};
}

function connection(overrides: Partial<MCPConnectionDisplay> = {}): MCPConnectionDisplay {
	return {
		name: "github",
		config: { command: "/usr/bin/github-mcp-server", args: ["stdio"] },
		serverInfo: {
			name: "github-mcp-server",
			title: "GitHub MCP Server",
			version: "0.19.0",
			description: "Access GitHub repositories, issues, and pull requests.",
		},
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

function sourceFor(status: "connected" | "connecting" | "disconnected", conn?: MCPConnectionDisplay): MCPRuntimeSource {
	return {
		getConnectionStatus: () => status,
		getConnection: () => conn,
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

	// A disconnected server with registered tools is serving a cached catalog.
	// That alone says nothing about what invoking one of them does: the manager
	// keeps a failed server's catalog registered on purpose, and for that one
	// the call is refused until `/mcp reconnect`. Only the source's dormancy
	// answer may turn the hint into a promise to connect.
	const cachedCatalog = (dormant: boolean | undefined): MCPRuntimeSource => ({
		getConnectionStatus: () => "disconnected",
		...(dormant === undefined ? {} : { isServerDormant: () => dormant }),
		getConnection: () => undefined,
		getTools: () => [{ mcpServerName: "github", mcpToolName: "search_code", description: "Search code." }],
	});

	test("a disconnected server promises a connect only while it is dormant", () => {
		const dormant = snapshotMcpRuntime(server(), cachedCatalog(true));
		expect(dormant.health).toBe("disconnected");
		expect(dormant.dormant).toBe(true);
		expect(formatMcpListHint(dormant)).toBe("1 tool · connects on first use");

		// Same registered tools, last connect failed: the catalog is reported,
		// the connect is not promised.
		const failed = snapshotMcpRuntime(server(), cachedCatalog(false));
		expect(failed.dormant).toBe(false);
		expect(formatMcpListHint(failed)).toBe("1 tool cached");

		// A source that cannot answer is not evidence of dormancy either.
		expect(formatMcpListHint(snapshotMcpRuntime(server(), cachedCatalog(undefined)))).toBe("1 tool cached");

		// No tools at all is still the one case with nothing to report.
		const empty = snapshotMcpRuntime(server(), sourceFor("disconnected"));
		expect(empty.dormant).toBe(false);
		expect(formatMcpListHint(empty)).toBe("unavailable");
	});

	test("a connected or shadowed server is never reported dormant", () => {
		// `isServerDormant` is asked about a name, and a shadowed entry shares
		// the winner's name: joining on it would promise a connect for a config
		// that owns no connection at all.
		const live: MCPRuntimeSource = { ...sourceFor("connected", connection()), isServerDormant: () => true };
		expect(snapshotMcpRuntime(server(), live).dormant).toBe(false);
		expect(snapshotMcpRuntime(server(), live, { shadowed: true }).dormant).toBe(false);
		expect(snapshotMcpRuntime(server(), live, { enabled: false }).dormant).toBe(false);
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
});
