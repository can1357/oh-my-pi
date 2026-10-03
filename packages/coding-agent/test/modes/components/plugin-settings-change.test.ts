/**
 * The Settings → Plugins toggle must hand its consumer the toggled plugin, the
 * direction, and any other scope still enabling it, so the running session can
 * warn that it keeps the plugin bound (#9722). The toggle writes one scope, so
 * a disable that leaves another install on cannot claim a restart is enough.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPluginSummary } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { PluginSettingsComponent, type PluginSettingsChange } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const npmPlugin = (name: string): InstalledPlugin => ({
	name,
	version: "1.2.3",
	path: `/cache/npm/${name}`,
	manifest: { version: "1.2.3", description: `desc ${name}` },
	enabledFeatures: null,
	enabled: true,
});

const marketplacePlugin = (id: string, scope: "user" | "project" = "user"): InstalledPluginSummary => ({
	id,
	scope,
	entries: [
		{
			scope,
			installPath: `/cache/marketplace/${id}`,
			version: "0.4.2",
			installedAt: "2026-01-02T03:04:05.000Z",
			lastUpdated: "2026-02-03T04:05:06.000Z",
			enabled: true,
		},
	],
});

beforeEach(async () => {
	await initTheme();
});

afterEach(() => {
	mock.restore();
});

/** Mounts the component and resolves once its async plugin list has rendered. */
async function mount(needle: string, changes: (PluginSettingsChange | undefined)[]) {
	const mounted = Promise.withResolvers<void>();
	const changed = Promise.withResolvers<void>();
	const component = new PluginSettingsComponent(createPluginSettingsHost(process.cwd()), {
		onClose: () => {},
		onPluginChanged: change => {
			changes.push(change);
			changed.resolve();
		},
		requestRender: () => mounted.resolve(),
	});
	await mounted.promise;
	expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain(needle);
	return { component, changed };
}

describe("Settings → Plugins toggle reports the change", () => {
	test("disabling a marketplace plugin reports its id and direction", async () => {
		const changes: (PluginSettingsChange | undefined)[] = [];
		spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([marketplacePlugin("toggle@mkt")]);
		spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue(undefined);

		const { component, changed } = await mount("toggle@mkt", changes);
		component.handleInput("\n");
		component.handleInput(" ");
		await changed.promise;

		expect(changes).toEqual([{ pluginName: "toggle@mkt", enabled: false }]);
	});

	test("disabling an entry another scope keeps enabled carries that scope", async () => {
		const changes: (PluginSettingsChange | undefined)[] = [];
		spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins")
			.mockResolvedValueOnce([marketplacePlugin("shared@mkt")])
			// The toggled user entry is off now; the project install still loads it.
			.mockResolvedValueOnce([marketplacePlugin("shared@mkt", "project")]);
		spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue(undefined);

		const { component, changed } = await mount("shared@mkt", changes);
		component.handleInput("\n");
		component.handleInput(" ");
		await changed.promise;

		expect(changes).toEqual([{ pluginName: "shared@mkt", enabled: false, stillEnabledBy: "project" }]);
	});

	test("a failed post-toggle registry read still reports the change", async () => {
		const changes: (PluginSettingsChange | undefined)[] = [];
		spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins")
			.mockResolvedValueOnce([marketplacePlugin("shared@mkt")])
			.mockRejectedValueOnce(new Error("registry read failed"));
		spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockResolvedValue(undefined);

		const { component, changed } = await mount("shared@mkt", changes);
		component.handleInput("\n");
		component.handleInput(" ");
		await changed.promise;

		expect(changes).toEqual([{ pluginName: "shared@mkt", enabled: false }]);
	});

	test("disabling an npm plugin reports its name and direction", async () => {
		const changes: (PluginSettingsChange | undefined)[] = [];
		spyOn(PluginManager.prototype, "list").mockResolvedValue([npmPlugin("npm-toggle")]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(PluginManager.prototype, "setEnabled").mockResolvedValue(undefined);

		const { component, changed } = await mount("npm-toggle", changes);
		component.handleInput("\n");
		// The npm detail builds its settings list in an async rebuild, so the
		// toggle keypress only lands after those microtasks settle.
		await Promise.resolve();
		await Promise.resolve();
		component.handleInput(" ");
		await changed.promise;

		expect(changes).toEqual([{ pluginName: "npm-toggle", enabled: false }]);
	});
});
