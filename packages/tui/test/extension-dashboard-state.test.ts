import { beforeAll, describe, expect, test } from "bun:test";
import { ExtensionDashboard, type ExtensionDashboardRuntime } from "../src/overlays/extensions/extension-dashboard";
import {
	applyDisabledExtensionsToState,
	buildProviderTabs,
	filterByProvider,
	MCP_SERVERS_TAB_ID,
} from "../src/overlays/extensions/state-manager";
import type { DashboardState, Extension } from "../src/overlays/extensions/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme(false);
});

function extension(overrides: Partial<Extension> & Pick<Extension, "id">): Extension {
	return {
		kind: "skill",
		name: overrides.id.replace(/^skill:/, ""),
		displayName: overrides.id.replace(/^skill:/, ""),
		path: `/tmp/${overrides.id}`,
		source: { provider: "native", providerName: "Native", level: "native" },
		state: "active",
		raw: {},
		...overrides,
	};
}

function dashboardState(extensions: Extension[], selected: Extension | null = extensions[0] ?? null): DashboardState {
	return {
		tabs: [{ id: "all", label: "ALL", enabled: true, count: extensions.length }],
		activeTabIndex: 0,
		extensions,
		tabFiltered: extensions,
		searchFiltered: extensions,
		searchQuery: "",
		listIndex: 0,
		scrollOffset: 0,
		selected,
	};
}

describe("cross-source MCP tab", () => {
	test("aggregates MCP servers from every provider into a selectable second tab", () => {
		const claudeServer = extension({
			id: "mcp:claude-server",
			kind: "mcp",
			source: { provider: "claude", providerName: "Claude Code", level: "user" },
		});
		const nativeServer = extension({
			id: "mcp:native-server",
			kind: "mcp",
			source: { provider: "mcp-json", providerName: "MCP Config", level: "user" },
		});
		const skill = extension({ id: "skill:alpha" });
		const extensions = [skill, claudeServer, nativeServer];
		const providers = [
			{ id: "claude", displayName: "Claude Code", enabled: true, userSourceEnabled: true, foreignUserSource: true },
			{
				id: "mcp-json",
				displayName: "MCP Config",
				enabled: true,
				userSourceEnabled: true,
				foreignUserSource: false,
			},
		];

		const tabs = buildProviderTabs(extensions, providers);

		expect(tabs[0]?.id).toBe("all");
		expect(tabs[1]).toMatchObject({ id: MCP_SERVERS_TAB_ID, label: "MCP Servers", enabled: true, count: 2 });
		expect(filterByProvider(extensions, MCP_SERVERS_TAB_ID)).toEqual([claudeServer, nativeServer]);
	});

	test("omits the aggregate tab when no MCP servers are discovered", () => {
		const tabs = buildProviderTabs([extension({ id: "skill:alpha" })], []);

		expect(tabs.some(tab => tab.id === MCP_SERVERS_TAB_ID)).toBe(false);
	});

	test("navigates directly from ALL to the aggregate MCP inventory", async () => {
		const skill = extension({ id: "skill:alpha" });
		const server = extension({
			id: "mcp:snowflake",
			kind: "mcp",
			name: "snowflake",
			displayName: "snowflake",
			source: { provider: "claude", providerName: "Claude Code", level: "user" },
			raw: { name: "snowflake", _source: {} },
		});
		const providers = [
			{ id: "claude", displayName: "Claude Code", enabled: true, userSourceEnabled: true, foreignUserSource: true },
		];
		const runtime: ExtensionDashboardRuntime = {
			getDisabledExtensions: () => [],
			setDisabledExtensions: () => {},
			getProviders: () => providers,
			loadExtensions: async () => [skill, server],
			toggleProvider: () => true,
			toggleUserSource: () => true,
			persistMcpToggle: async () => {},
			applyMcpToggle: async () => {},
			subscribeMcpChanges: () => [],
		};
		const dashboard = await ExtensionDashboard.create({ runtime, terminalHeight: 30 });

		dashboard.handleInput("\t");
		const rendered = dashboard.render(100).join("\n");

		expect(rendered).toContain("MCP Servers (1)");
		expect(rendered).toContain("snowflake");
		expect(rendered).not.toContain("alpha");
		expect(rendered).not.toContain("Master Switch");
		dashboard.dispose();
	});
});

describe("applyDisabledExtensionsToState", () => {
	test("immediately applies item-disabled state to every visible dashboard slice", () => {
		const selected = extension({ id: "skill:alpha" });
		const state = dashboardState([selected, extension({ id: "skill:beta" })], selected);

		const next = applyDisabledExtensionsToState(state, ["skill:alpha"]);

		expect(next.extensions[0]).toMatchObject({
			id: "skill:alpha",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		expect(next.tabFiltered[0]).toMatchObject({
			id: "skill:alpha",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		expect(next.searchFiltered[0]).toMatchObject({
			id: "skill:alpha",
			state: "disabled",
			disabledReason: "item-disabled",
		});
		expect(next.selected).toMatchObject({ id: "skill:alpha", state: "disabled", disabledReason: "item-disabled" });
		expect(next.extensions[1]).toMatchObject({ id: "skill:beta", state: "active" });
	});

	test("restores a previously item-disabled shadowed extension as shadowed", () => {
		const shadowed = extension({
			id: "skill:shadowed",
			state: "disabled",
			disabledReason: "item-disabled",
			shadowedBy: "skill:shadowing",
		});
		const state = dashboardState([shadowed], shadowed);

		const next = applyDisabledExtensionsToState(state, []);

		expect(next.extensions[0]).toMatchObject({
			id: "skill:shadowed",
			state: "shadowed",
			disabledReason: "shadowed",
			shadowedBy: "skill:shadowing",
		});
		expect(next.selected).toMatchObject({ id: "skill:shadowed", state: "shadowed", disabledReason: "shadowed" });
	});
});
