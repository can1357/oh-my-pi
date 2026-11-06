import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createExtensionDashboardRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/dashboard-runtime";
import { applyMcpToggleRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

test("dashboard MCP enable includes the session's explicit extension roots", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dashboard-mcp-root-"));
	const project = path.join(root, "project");
	const extension = path.join(root, "extension");
	const home = path.join(root, "home");
	const originalHome = process.env.HOME;
	try {
		await fs.mkdir(path.join(project, ".git"), { recursive: true });
		await fs.mkdir(home, { recursive: true });
		await Bun.write(
			path.join(extension, "package.json"),
			JSON.stringify({ name: "dashboard-extension", omp: { extensions: ["./main.ts"] } }),
		);
		await Bun.write(path.join(extension, "main.ts"), "export default function (_pi) {}\n");
		await Bun.write(
			path.join(extension, ".mcp.json"),
			JSON.stringify({ mcpServers: { dashboard: { command: "dashboard-mcp" } } }),
		);
		process.env.HOME = home;
		vi.spyOn(os, "homedir").mockReturnValue(home);
		clearFsCache();
		const roots: EffectiveExtensionRoots = {
			explicit: [extension],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		};
		const connected: Array<Record<string, { command?: string }>> = [];
		const runtime = createExtensionDashboardRuntime({
			cwd: project,
			settings: Settings.isolated(),
			mcpManager: {
				getConnectionStatus: () => "disconnected",
				getTools: () => [],
				disconnectServer: async () => {},
				connectServers: async (configs: Record<string, { command?: string }>) => {
					connected.push(configs);
					return { errors: new Map() };
				},
			} as never,
			extensionRoots: roots,
		});

		await runtime.applyMcpToggle("dashboard", true);

		expect(connected).toEqual([{ dashboard: expect.objectContaining({ command: "dashboard-mcp" }) }]);
	} finally {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(root);
	}
});
