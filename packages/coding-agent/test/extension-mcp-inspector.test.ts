import { beforeAll, describe, expect, test } from "bun:test";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import { InspectorPanel } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/inspector-panel";
import type { MCPRuntimeSource } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

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

const githubServer: MCPServer = {
	name: "github",
	command: "/usr/bin/github-mcp-server",
	args: ["stdio"],
	transport: "stdio",
	_source: {
		provider: "native",
		providerName: "OMP (User)",
		path: "/home/sf/.omp/agent/mcp.json",
		level: "user",
	},
};

function mcpExtension(state: Extension["state"] = "active"): Extension {
	return {
		id: "mcp:github",
		kind: "mcp",
		name: "github",
		displayName: "github",
		path: githubServer._source.path,
		source: {
			provider: githubServer._source.provider,
			providerName: githubServer._source.providerName,
			level: githubServer._source.level,
		},
		state,
		raw: githubServer,
	};
}

function connectedSource(): MCPRuntimeSource {
	const conn: MCPServerConnection = {
		name: "github",
		config: { command: "/usr/bin/github-mcp-server", args: ["stdio"] },
		transport: transport(),
		serverInfo: {
			name: "github-mcp-server",
			title: "GitHub MCP Server",
			version: "0.19.0",
			description: "Access GitHub repositories, issues, and pull requests.",
		},
		capabilities: { tools: {}, resources: {} },
		tools: [
			{
				name: "search_code",
				description: "Search code across GitHub repositories.",
				inputSchema: {
					type: "object",
					required: ["query"],
					properties: {
						query: { type: "string", description: "Search query" },
						language: { type: "string" },
					},
				},
			},
			{
				name: "create_issue",
				description: "Create a new issue in a repository.",
				inputSchema: {
					type: "object",
					required: ["title"],
					properties: { title: { type: "string", description: "Issue title" } },
				},
			},
		],
		resources: [{ uri: "github://repo", name: "repo" }],
		instructions: "Prefer search_code over cloning.",
	};
	return {
		getConnectionStatus: () => "connected",
		getConnection: () => conn,
		getTools: () =>
			conn.tools!.map(tool => ({
				mcpServerName: "github",
				mcpToolName: tool.name,
				description: tool.description,
			})),
		getServerResources: () => ({ resources: conn.resources ?? [], templates: [] }),
		getServerPrompts: () => [],
	};
}

describe("MCP inspector runtime join", () => {
	test("shows identity, health, tools, then plumbing last", () => {
		const panel = new InspectorPanel();
		panel.setMcpSource(connectedSource());
		panel.setExtension(mcpExtension());
		const text = Bun.stripANSI(panel.render(72).join("\n"));

		expect(text).toContain("github");
		expect(text).toContain("GitHub MCP Server");
		expect(text).toContain("Access GitHub repositories, issues, and pull requests.");
		expect(text).toContain("Connected");
		expect(text).toContain("stdio");
		expect(text).toContain("github-mcp-server 0.19.0");
		expect(text).toContain("search_code");
		expect(text).toContain("Search code across GitHub repositories.");
		expect(text).toContain("Prefer search_code over cloning.");
		expect(text).not.toContain("Server guidance");
		expect(text).not.toContain("Connection");
		expect(text).toContain("/usr/bin/github-mcp-server");

		expect(text).not.toContain("Type: mcp");
		expect(text).not.toMatch(/Status:\s+.*Active/);
		expect(text.indexOf("Access GitHub")).toBeLessThan(text.indexOf("Command"));
		expect(text.indexOf("Prefer search_code")).toBeLessThan(text.indexOf("Origin"));
		expect(text.indexOf("Prefer search_code")).toBeLessThan(text.indexOf("search_code"));
		expect(text.indexOf("search_code")).toBeLessThan(text.indexOf("Command"));
		expect(text).not.toMatch(/^.*github-mcp-server\n.*Type:/s);
	});

	test("inlines short MCP tool args and keeps long schemas collapsed", () => {
		const panel = new InspectorPanel();
		panel.setMcpSource(connectedSource());
		panel.setExtension(mcpExtension());
		const collapsed = Bun.stripANSI(panel.render(72).join("\n"));
		expect(collapsed).toContain("search_code");
		expect(collapsed).toContain("query");
		expect(collapsed).toContain("Search query");
		expect(collapsed).toContain("title");
		expect(collapsed).toContain("Issue title");
		expect(collapsed).not.toContain("1 arg");
		expect(collapsed).not.toMatch(/args \(.* to expand\)/);

		const long = connectedSource();
		const conn = long.getConnection("github")!;
		conn.tools = [
			{
				name: "search_code",
				description: "Search code across GitHub repositories.",
				inputSchema: {
					type: "object",
					required: ["query"],
					properties: {
						query: { type: "string" },
						a: { type: "string" },
						b: { type: "string" },
						c: { type: "string" },
						d: { type: "string" },
					},
				},
			},
		];
		const longPanel = new InspectorPanel();
		longPanel.setMcpSource(long);
		longPanel.setExtension(mcpExtension());
		const longCollapsed = Bun.stripANSI(longPanel.render(72).join("\n"));
		expect(longCollapsed).toContain("5 args");
		expect(longCollapsed).toMatch(/args \(.* to expand\)/);
		expect(longCollapsed).not.toMatch(/query\s+string/);

		longPanel.toggleExpanded();
		const expanded = Bun.stripANSI(longPanel.render(72).join("\n"));
		expect(expanded).toMatch(/query\s+string/);
		expect(expanded).toContain("Required");
	});

	test("does not present a dead server as Active", () => {
		const panel = new InspectorPanel();
		panel.setMcpSource({
			getConnectionStatus: () => "disconnected",
			getConnection: () => undefined,
			getTools: () => [],
		});
		panel.setExtension(mcpExtension());
		const text = Bun.stripANSI(panel.render(72).join("\n"));
		expect(text).toContain("Not connected");
		expect(text).not.toMatch(/Status:\s+.*Active/);
		expect(text).not.toContain("unknown");
	});

	test("wraps a long command instead of ellipsizing it", () => {
		const panel = new InspectorPanel();
		panel.setMcpSource(connectedSource());
		panel.setExtension({
			...mcpExtension(),
			raw: {
				...githubServer,
				command: "/home/sf/worlds/personal/.omp/bin/gog-mcp-readonly",
			},
		});
		const text = Bun.stripANSI(panel.render(42).join("\n"));
		const command = text.slice(text.indexOf("Command"));
		expect(command.split("\n").some(line => line.includes("…") || line.endsWith("..."))).toBe(false);
		expect(command.replace(/\s+/g, "")).toContain("gog-mcp-readonly");
		expect(command).toContain("Command");
		expect(text).not.toContain("Connection");
	});

	test("collapses large resource and prompt catalogs until expand", () => {
		const resources = Array.from({ length: 20 }, (_, i) => ({
			uri: `github://repo/${i}`,
			name: `resource_${i}`,
		}));
		const prompts = Array.from({ length: 12 }, (_, i) => ({ name: `prompt_${i}` }));
		const panel = new InspectorPanel();
		panel.setMcpSource({
			getConnectionStatus: () => "connected",
			getConnection: () => ({
				name: "github",
				config: { command: "/usr/bin/github-mcp-server" },
				transport: transport(),
				serverInfo: { name: "github-mcp-server", version: "0.19.0" },
				capabilities: { resources: {}, prompts: {} },
				tools: [],
				resources,
				prompts,
			}),
			getTools: () => [],
			getServerResources: () => ({ resources, templates: [] }),
			getServerPrompts: () => prompts,
		});
		panel.setExtension(mcpExtension());
		const collapsed = Bun.stripANSI(panel.render(72).join("\n"));
		expect(collapsed).toContain("resource_0");
		expect(collapsed).not.toContain("resource_19");
		expect(collapsed).toContain("prompt_0");
		expect(collapsed).not.toContain("prompt_11");
		expect(collapsed).toMatch(/more \(.* to expand\)/);

		panel.toggleExpanded();
		const expanded = Bun.stripANSI(panel.render(72).join("\n"));
		expect(expanded).toContain("resource_19");
		expect(expanded).toContain("prompt_11");
	});

	test("expand is per selected extension, not a session-wide toggle", () => {
		const resources = Array.from({ length: 20 }, (_, i) => ({
			uri: `github://repo/${i}`,
			name: `resource_${i}`,
		}));
		const otherResources = Array.from({ length: 20 }, (_, i) => ({
			uri: `linear://issue/${i}`,
			name: `issue_${i}`,
		}));
		const panel = new InspectorPanel();
		panel.setMcpSource({
			getConnectionStatus: name => (name === "github" || name === "linear" ? "connected" : "disconnected"),
			getConnection: name => {
				if (name === "github") {
					return {
						name: "github",
						config: { command: "/usr/bin/github-mcp-server" },
						transport: transport(),
						serverInfo: { name: "github-mcp-server", version: "0.19.0" },
						capabilities: { resources: {} },
						tools: [],
						resources,
					};
				}
				if (name === "linear") {
					return {
						name: "linear",
						config: { command: "/usr/bin/linear-mcp" },
						transport: transport(),
						serverInfo: { name: "linear-mcp", version: "1.0.0" },
						capabilities: { resources: {} },
						tools: [],
						resources: otherResources,
					};
				}
				return undefined;
			},
			getTools: () => [],
			getServerResources: name =>
				name === "linear" ? { resources: otherResources, templates: [] } : { resources, templates: [] },
			getServerPrompts: () => [],
		});
		panel.setExtension(mcpExtension());
		panel.toggleExpanded();
		expect(Bun.stripANSI(panel.render(72).join("\n"))).toContain("resource_19");

		panel.setExtension({
			id: "mcp:linear",
			kind: "mcp",
			name: "linear",
			displayName: "linear",
			path: "/home/sf/.omp/agent/mcp.json",
			source: {
				provider: "native",
				providerName: "OMP (User)",
				level: "user",
			},
			state: "active",
			raw: {
				name: "linear",
				command: "/usr/bin/linear-mcp",
				transport: "stdio",
				_source: {
					provider: "native",
					providerName: "OMP (User)",
					path: "/home/sf/.omp/agent/mcp.json",
					level: "user",
				},
			},
		});
		const other = Bun.stripANSI(panel.render(72).join("\n"));
		expect(other).toContain("issue_0");
		expect(other).not.toContain("issue_19");
		expect(other).toMatch(/more \(.* to expand\)/);

		panel.setExtension({ ...mcpExtension() });
		const back = Bun.stripANSI(panel.render(72).join("\n"));
		expect(back).toContain("resource_0");
		expect(back).not.toContain("resource_19");

		panel.toggleExpanded();
		panel.setExtension({ ...mcpExtension() });
		expect(Bun.stripANSI(panel.render(72).join("\n"))).toContain("resource_19");
	});
});

describe("MCP list runtime join", () => {
	test("connected row shows tool/resource counts instead of transport", () => {
		const list = new ExtensionList([mcpExtension()], { mcpSource: connectedSource() });
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("github");
		expect(text).toContain("2 tools · 1 resource");
		expect(text).not.toMatch(/github\s+stdio/);
	});

	test("disconnected enabled server is unavailable, not Active", () => {
		const list = new ExtensionList([mcpExtension()], {
			mcpSource: {
				getConnectionStatus: () => "disconnected",
				getConnection: () => undefined,
				getTools: () => [],
			},
		});
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("unavailable");
	});

	test("shadowed same-name config does not inherit the winner's health or tools", () => {
		const winner = mcpExtension("active");
		const shadowed: Extension = {
			...mcpExtension("shadowed"),
			id: "mcp:github",
			path: "/home/sf/.omp/agent/mcp.json",
			shadowedBy: "github",
			raw: { ...githubServer, command: "/usr/bin/shadowed-github" },
		};
		const list = new ExtensionList([winner, shadowed], { mcpSource: connectedSource() });
		list.setFocused(true);
		const text = Bun.stripANSI(list.render(80).join("\n"));
		expect(text).toContain("2 tools · 1 resource");
		const winnerIdx = text.indexOf("2 tools · 1 resource");
		const secondGithub = text.indexOf("github", winnerIdx + 1);
		expect(secondGithub).toBeGreaterThan(-1);
		expect(text.slice(secondGithub)).not.toContain("2 tools");
		expect(text.slice(secondGithub)).not.toContain("Connected");

		const panel = new InspectorPanel();
		panel.setMcpSource(connectedSource());
		panel.setExtension(shadowed);
		const inspector = Bun.stripANSI(panel.render(72).join("\n"));
		expect(inspector).toContain("Shadowed");
		expect(inspector).not.toContain("Connected");
		expect(inspector).not.toContain("search_code");
		expect(inspector).not.toContain("GitHub MCP Server");
		expect(inspector).toContain("/usr/bin/shadowed-github");
	});

	test("shadowed rows with the production duplicate id are not toggleable", () => {
		const toggles: Array<{ id: string; enabled: boolean }> = [];
		const winner = mcpExtension("active");
		const shadowed: Extension = {
			...mcpExtension("shadowed"),
			id: "mcp:github",
			path: "/home/sf/.omp/agent/mcp.json",
			shadowedBy: "github",
			raw: { ...githubServer, command: "/usr/bin/shadowed-github" },
		};
		const list = new ExtensionList([winner, shadowed], {
			mcpSource: connectedSource(),
			onToggle: (id, enabled) => toggles.push({ id, enabled }),
		});
		list.setFocused(true);
		list.render(80);
		list.handleClick(4);
		expect(list.getSelectedExtension()?.state).toBe("shadowed");
		expect(list.getSelectedExtension()?.id).toBe("mcp:github");
		list.handleClick(4);
		list.handleInput(" ");
		expect(toggles).toEqual([]);

		list.handleClick(3);
		list.handleClick(3);
		expect(toggles).toEqual([{ id: "mcp:github", enabled: false }]);
	});

	test("disabled shadowed loser with the production duplicate id is not toggleable", () => {
		const toggles: Array<{ id: string; enabled: boolean }> = [];
		const winner = mcpExtension("active");
		const loser: Extension = {
			...mcpExtension("disabled"),
			id: "mcp:github",
			path: "/home/sf/.omp/agent/mcp.json",
			disabledReason: "item-disabled",
			raw: { ...githubServer, enabled: false, _shadowed: true, command: "/usr/bin/shadowed-github" },
		};
		const list = new ExtensionList([winner, loser], {
			mcpSource: connectedSource(),
			onToggle: (id, enabled) => toggles.push({ id, enabled }),
		});
		list.setFocused(true);
		list.render(80);
		list.handleClick(4);
		expect(list.getSelectedExtension()?.state).toBe("disabled");
		expect(list.getSelectedExtension()?.id).toBe("mcp:github");
		list.handleClick(4);
		list.handleInput(" ");
		expect(toggles).toEqual([]);

		const rendered = Bun.stripANSI(list.render(80).join("\n"));
		const secondGithub = rendered.indexOf("github", rendered.indexOf("2 tools · 1 resource") + 1);
		expect(secondGithub).toBeGreaterThan(-1);
		expect(rendered.slice(secondGithub)).not.toContain("2 tools");
	});
});
