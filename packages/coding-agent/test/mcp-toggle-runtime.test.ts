import { describe, expect, test } from "bun:test";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { applyMcpToggleRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";

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
