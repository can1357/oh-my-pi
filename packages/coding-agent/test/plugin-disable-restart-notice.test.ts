/**
 * `omp plugin disable` must not report a clean disable while the plugin keeps
 * intercepting in every already-running session (#9722), and it must name the
 * scope that still loads the plugin when only one scope was disabled.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

let logged: string[] = [];

const entry = (scope: "user" | "project", enabled: boolean): InstalledPluginEntry => ({
	scope,
	installPath: `/cache/marketplace/shared@mkt/${scope}`,
	version: "0.4.2",
	installedAt: "2026-01-02T03:04:05.000Z",
	lastUpdated: "2026-02-03T04:05:06.000Z",
	enabled,
});

const bothScopesInstalled: InstalledPluginSummary[] = [
	{ id: "shared@mkt", scope: "project", entries: [entry("project", true)] },
	{ id: "shared@mkt", scope: "user", shadowedBy: "project", entries: [entry("user", true)] },
];

beforeEach(async () => {
	await initTheme();
	logged = [];
	spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logged.push(stripVTControlCharacters(args.map(String).join(" ")));
	});
	spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	mock.restore();
});

describe("omp plugin disable restart caveat", () => {
	test("disable names the plugin that running sessions keep bound", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(PluginManager.prototype, "setEnabled").mockResolvedValue(undefined);

		await runPluginCommand({ action: "disable", args: ["caveat-plugin"], flags: {} });

		expect(logged.join("\n")).toContain("Running sessions keep caveat-plugin bound until they restart.");
	});

	test("enable says nothing about restarts", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(PluginManager.prototype, "setEnabled").mockResolvedValue(undefined);

		await runPluginCommand({ action: "enable", args: ["caveat-plugin"], flags: {} });

		expect(logged.join("\n")).not.toContain("until they restart");
	});

	test("--json keeps stdout parseable", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(PluginManager.prototype, "setEnabled").mockResolvedValue(undefined);

		await runPluginCommand({ action: "disable", args: ["caveat-plugin"], flags: { json: true } });

		expect(logged).toEqual(['{"disabled":"caveat-plugin"}']);
	});

	test("an install left enabled in another scope is named instead of the restart caveat", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins")
			.mockResolvedValueOnce(bothScopesInstalled)
			// Disabling the user entry leaves the project install loading it.
			.mockResolvedValueOnce([
				{ id: "shared@mkt", scope: "project", entries: [entry("project", true)] },
				{ id: "shared@mkt", scope: "user", entries: [entry("user", false)] },
			]);
		spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue(undefined);

		await runPluginCommand({ action: "disable", args: ["shared@mkt"], flags: {} });

		expect(logged.join("\n")).toContain("shared@mkt is still enabled by a project install.");
		expect(logged.join("\n")).not.toContain("bound until they restart");
	});

	test("disabling the project scope names the user install that still enables it", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins")
			.mockResolvedValueOnce(bothScopesInstalled)
			// The project entry is off now, so the user install is what loads it.
			.mockResolvedValueOnce([{ id: "shared@mkt", scope: "user", entries: [entry("user", true)] }]);
		spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue(undefined);

		await runPluginCommand({ action: "disable", args: ["shared@mkt"], flags: { scope: "project" } });

		expect(logged.join("\n")).toContain("shared@mkt is still enabled by a user install.");
		expect(logged.join("\n")).not.toContain("still enabled by a project install");
	});

	test("a failed post-disable registry read still reports the disable, not a failure", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins")
			.mockResolvedValueOnce(bothScopesInstalled)
			.mockRejectedValueOnce(new Error("registry read failed"));
		spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue(undefined);

		await runPluginCommand({ action: "disable", args: ["shared@mkt"], flags: {} });

		expect(logged.join("\n")).toContain("Running sessions keep shared@mkt bound until they restart.");
		expect(logged.join("\n")).not.toContain("Failed to disable");
	});
});
