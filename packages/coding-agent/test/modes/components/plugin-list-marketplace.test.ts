import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { stripVTControlCharacters } from "node:util";
import { PluginManager } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins";
import {
	type InstalledPluginSummary,
	MarketplaceManager,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/plugins/types";
import {
	MarketplacePluginDetailComponent,
	PluginListComponent,
	type PluginListEntry,
	PluginSettingsComponent,
} from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/plugin-settings";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";

beforeAll(async () => {
	await initTheme();
});

const npm = (name: string, opts: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
	name,
	version: "1.2.3",
	path: `/cache/npm/${name}`,
	manifest: { version: "1.2.3", description: `desc ${name}` },
	enabledFeatures: null,
	enabled: true,
	scope: "user",
	...opts,
});

const marketplace = (
	id: string,
	opts: Partial<Omit<InstalledPluginSummary, "id" | "entries">> & {
		entry?: Partial<InstalledPluginSummary["entries"][number]>;
	} = {},
): InstalledPluginSummary => ({
	id,
	scope: opts.scope ?? "user",
	shadowedBy: opts.shadowedBy,
	entries: [
		{
			scope: opts.scope ?? "user",
			installPath: `/cache/marketplace/${id}`,
			version: "0.4.2",
			installedAt: "2026-01-02T03:04:05.000Z",
			lastUpdated: "2026-02-03T04:05:06.000Z",
			enabled: true,
			...opts.entry,
		},
	],
});

describe("PluginListComponent", () => {
	it("renders marketplace plugins when no npm plugins are installed", () => {
		const entries: PluginListEntry[] = [
			{ kind: "marketplace", plugin: marketplace("developer-essentials@claude-code-workflows") },
			{ kind: "marketplace", plugin: marketplace("hyperpowers@withzombies-hyper") },
		];

		const component = new PluginListComponent(entries, {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).not.toContain("No plugins installed");
		expect(text).toContain("developer-essentials@claude-code-workflows");
		expect(text).toContain("hyperpowers@withzombies-hyper");
		expect(text).toContain("[marketplace]");
	});

	it("renders npm and marketplace plugins together with kind badges", () => {
		const entries: PluginListEntry[] = [
			{ kind: "npm", plugin: npm("local-plugin") },
			{ kind: "marketplace", plugin: marketplace("remote@mkt") },
		];

		const component = new PluginListComponent(entries, {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("local-plugin");
		expect(text).toContain("[npm]");
		expect(text).toContain("remote@mkt");
		expect(text).toContain("[marketplace]");
	});

	it("marks shadowed marketplace entries and surfaces scope tag", () => {
		const entries: PluginListEntry[] = [
			{
				kind: "marketplace",
				plugin: marketplace("shared@mkt", { scope: "user", shadowedBy: "project" }),
			},
		];

		const component = new PluginListComponent(entries, {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("[user]");
		expect(text).toContain("shadowed");
	});

	it("empty-state mentions both npm and marketplace install commands", () => {
		const component = new PluginListComponent([], {
			onNpmSelect: () => {},
			onMarketplaceSelect: () => {},
			onCancel: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("No plugins installed");
		expect(text).toContain(`${APP_NAME} plugin install <package>`);
		expect(text).toContain(`${APP_NAME} plugin install <name>@<marketplace>`);
	});

	it("routes enter on a marketplace entry to onMarketplaceSelect", () => {
		const target = marketplace("pick@mkt");
		let selected: InstalledPluginSummary | null = null;
		const component = new PluginListComponent(
			[
				{ kind: "npm", plugin: npm("filler") },
				{ kind: "marketplace", plugin: target },
			],
			{
				onNpmSelect: () => {
					throw new Error("npm callback should not fire for marketplace selection");
				},
				onMarketplaceSelect: plugin => {
					selected = plugin;
				},
				onCancel: () => {},
			},
		);

		// Move down to the marketplace entry, then confirm with Enter.
		component.handleInput("\x1b[B");
		component.handleInput("\n");

		expect(selected).not.toBeNull();
		expect(selected!.id).toBe("pick@mkt");
	});
});

describe("PluginSettingsComponent", () => {
	it("awaits plugin-change reload callback after toggling a marketplace plugin", async () => {
		const plugin = marketplace("toggle@mkt");
		const order: string[] = [];
		const reloaded = Promise.withResolvers<void>();
		const npmListSpy = spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		const listInstalledSpy = spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([plugin]);
		const setEnabledSpy = spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockImplementation(
			async (pluginId, enabled, scope) => {
				order.push(`set:${pluginId}:${enabled}:${scope}`);
			},
		);

		try {
			const component = new PluginSettingsComponent(process.cwd(), {
				onClose: () => {},
				onPluginChanged: async () => {
					order.push("reload");
					reloaded.resolve();
				},
			});

			for (let i = 0; i < 20; i++) {
				if (stripVTControlCharacters(component.render(120).join("\n")).includes("toggle@mkt")) break;
				await Bun.sleep(1);
			}
			expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain("toggle@mkt");
			component.handleInput("\n");
			component.handleInput(" ");
			await reloaded.promise;

			expect(setEnabledSpy).toHaveBeenCalledWith("toggle@mkt", false, "user");
			expect(order).toEqual(["set:toggle@mkt:false:user", "reload"]);
		} finally {
			npmListSpy.mockRestore();
			listInstalledSpy.mockRestore();
			setEnabledSpy.mockRestore();
		}
	});

	it("closes on Escape while the plugin list is still loading", async () => {
		const pending = Promise.withResolvers<InstalledPlugin[]>();
		const npmListSpy = spyOn(PluginManager.prototype, "list").mockReturnValue(pending.promise);
		const listInstalledSpy = spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);

		try {
			let closed = 0;
			const component = new PluginSettingsComponent(process.cwd(), {
				onClose: () => {
					closed++;
				},
				onPluginChanged: () => {},
			});

			// No child view has mounted yet — Escape must still dismiss the panel.
			component.handleInput("\x1b");
			expect(closed).toBe(1);

			// Other keys are swallowed, not treated as close.
			component.handleInput("\n");
			expect(closed).toBe(1);
		} finally {
			pending.resolve([]);
			npmListSpy.mockRestore();
			listInstalledSpy.mockRestore();
		}
	});

	it("still mounts the list when the npm plugin listing rejects", async () => {
		const npmListSpy = spyOn(PluginManager.prototype, "list").mockRejectedValue(new Error("corrupt registry"));
		const listInstalledSpy = spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
			marketplace("survivor@mkt"),
		]);

		try {
			let closed = 0;
			const component = new PluginSettingsComponent(process.cwd(), {
				onClose: () => {
					closed++;
				},
				onPluginChanged: () => {},
			});

			for (let i = 0; i < 20; i++) {
				if (stripVTControlCharacters(component.render(120).join("\n")).includes("survivor@mkt")) break;
				await Bun.sleep(1);
			}
			expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain("survivor@mkt");

			// Once mounted, Escape routes through the list view's cancel path.
			component.handleInput("\x1b");
			expect(closed).toBe(1);
		} finally {
			npmListSpy.mockRestore();
			listInstalledSpy.mockRestore();
		}
	});
});

describe("MarketplacePluginDetailComponent", () => {
	it("exposes the enable toggle and metadata", () => {
		const plugin = marketplace("plugin@mkt", {
			entry: { gitCommitSha: "abc1234", enabled: false },
		});

		const component = new MarketplacePluginDetailComponent(plugin, {
			onEnabledChange: () => {},
			onBack: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		expect(text).toContain("plugin@mkt");
		expect(text).toContain("Enabled");
		// Read-only metadata must surface, including scope and the git commit SHA.
		expect(text).toContain("0.4.2");
		expect(text).toContain("abc1234");
		expect(text).toContain("user");
		expect(text).toContain("/cache/marketplace/plugin@mkt");
	});

	it("invokes onEnabledChange when the enabled toggle is activated", () => {
		const calls: boolean[] = [];
		const component = new MarketplacePluginDetailComponent(marketplace("toggle@mkt"), {
			onEnabledChange: enabled => calls.push(enabled),
			onBack: () => {},
		});

		// Activate the Enabled toggle (it is the first item). Space cycles its value.
		component.handleInput(" ");

		expect(calls).toEqual([false]);
	});

	it("shortens home-relative install paths to ~ before rendering", () => {
		const home = os.homedir();
		const installPath = `${home}/.ompk/cache/plugins/sample@mkt`;
		const plugin = marketplace("sample@mkt", { entry: { installPath } });

		const component = new MarketplacePluginDetailComponent(plugin, {
			onEnabledChange: () => {},
			onBack: () => {},
		});

		const text = stripVTControlCharacters(component.render(120).join("\n"));
		// `shortenPath` keeps the rest of the path intact but replaces $HOME with `~`,
		// so the user's home directory never leaks into the rendered TUI surface.
		expect(text).toContain("~/.ompk/cache/plugins/sample@mkt");
		expect(text).not.toContain(home);
	});
});
