import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import {
	type InstalledPluginSummary,
	MarketplaceManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import type { PluginSettingsHost } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/plugin-settings";
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import {
	createPluginSettings,
	type PluginSettingsCallbacks,
	type PluginStart,
} from "../../../src/ui/overlays/plugins/settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const npm = (name: string, opts: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
	name,
	version: "1.2.3",
	path: `/cache/npm/${name}`,
	manifest: { version: "1.2.3", description: `desc ${name}` },
	enabledFeatures: null,
	enabled: true,
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

/** The plugin settings page, drawn on a terminal and fed keys the way the settings window feeds them. */
function openPage(
	callbacks: Partial<PluginSettingsCallbacks> = {},
	start?: PluginStart,
	host: PluginSettingsHost = createPluginSettingsHost(process.cwd()),
) {
	const page = createPluginSettings(host, { onClose: () => {}, onPluginChanged: () => {}, ...callbacks }, start);
	const term = createTestTerminal(() => ({ layer: page.view }), {
		columns: 120,
		rows: 40,
		theme: loadThemeSync("dark"),
	});
	const screen = (): string => {
		term.render();
		return term.screen().join("\n");
	};
	return {
		screen,
		press(id: string, text?: string): void {
			page.key({ id, kind: "press", raw: text ?? "", ...(text === undefined ? {} : { text }) } as KeyEvent);
		},
		/** Let the host's pending loads land until `needle` shows (bounded). */
		async until(needle: string): Promise<string> {
			for (let i = 0; i < 50 && !screen().includes(needle); i++) await Promise.resolve();
			return screen();
		},
		dispose(): void {
			page.dispose();
			term.dispose();
		},
	};
}

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

/**
 * The real host whose listings answer `npmPlugins` and `marketplacePlugins` (without touching the
 * plugin registries on disk).
 */
function listing(
	npmPlugins: InstalledPlugin[] | Promise<InstalledPlugin[]>,
	marketplacePlugins: InstalledPluginSummary[],
): PluginSettingsHost {
	const host = createPluginSettingsHost(process.cwd());
	const marketplaceManager = Object.create(MarketplaceManager.prototype) as MarketplaceManager;
	spies.push(spyOn(host.manager, "list").mockImplementation(() => Promise.resolve(npmPlugins)));
	spies.push(spyOn(marketplaceManager, "listInstalledPlugins").mockResolvedValue(marketplacePlugins));
	spies.push(spyOn(host, "createMarketplaceManager").mockResolvedValue(marketplaceManager));
	return host;
}

describe("plugin settings list", () => {
	it("opens a marketplace entry's detail on Enter", async () => {
		const host = listing([npm("filler")], [marketplace("pick@mkt")]);
		spies.push(spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(undefined));
		const page = openPage({}, undefined, host);
		try {
			await page.until("pick@mkt");
			page.press("down");
			page.press("enter");
			const detail = await page.until("Enabled");
			expect(detail).toContain("pick@mkt");
			expect(detail).toContain("/cache/marketplace/pick@mkt");
		} finally {
			page.dispose();
		}
	});

	it("awaits plugin-change reload callback after toggling a marketplace plugin", async () => {
		const plugin = marketplace("toggle@mkt");
		const order: string[] = [];
		const reloaded = Promise.withResolvers<void>();
		const host = listing([], [plugin]);
		spies.push(spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(undefined));
		const setEnabledSpy = spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockImplementation(
			async (pluginId, enabled, scope) => {
				order.push(`set:${pluginId}:${enabled}:${scope}`);
			},
		);
		spies.push(setEnabledSpy);
		const page = openPage(
			{
				onPluginChanged: async () => {
					order.push("reload");
					reloaded.resolve();
				},
			},
			undefined,
			host,
		);
		try {
			expect(await page.until("toggle@mkt")).toContain("toggle@mkt");
			page.press("enter");
			await page.until("Enabled");
			page.press("space", " ");
			await reloaded.promise;

			expect(setEnabledSpy).toHaveBeenCalledWith("toggle@mkt", false, "user");
			expect(order).toEqual(["set:toggle@mkt:false:user", "reload"]);
		} finally {
			page.dispose();
		}
	});

	it("closes on Escape while the plugin list is still loading", () => {
		const pending = Promise.withResolvers<InstalledPlugin[]>();
		const host = listing(pending.promise, []);
		let closed = 0;
		const page = openPage({ onClose: () => closed++ }, undefined, host);
		try {
			// Nothing has loaded yet — Escape must still dismiss the panel.
			page.press("escape");
			expect(closed).toBe(1);
			// Other keys are swallowed, not treated as close.
			page.press("enter");
			expect(closed).toBe(1);
		} finally {
			pending.resolve([]);
			page.dispose();
		}
	});

	it("still mounts the list when the npm plugin listing rejects", async () => {
		const host = listing(Promise.reject(new Error("corrupt registry")), [marketplace("survivor@mkt")]);
		let closed = 0;
		const page = openPage({ onClose: () => closed++ }, undefined, host);
		try {
			expect(await page.until("survivor@mkt")).toContain("survivor@mkt");
			// Once mounted, Escape routes through the list view's cancel path.
			page.press("escape");
			expect(closed).toBe(1);
		} finally {
			page.dispose();
		}
	});
});

describe("marketplace plugin detail", () => {
	it("exposes the enable toggle and metadata", async () => {
		spies.push(spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(undefined));
		const plugin = marketplace("plugin@mkt", { entry: { gitCommitSha: "abc1234", enabled: false } });
		const page = openPage({}, { kind: "mkt", plugin });
		try {
			const text = await page.until("plugin@mkt");
			expect(text).toContain("Enabled");
			expect(text).toContain("0.4.2");
			expect(text).toContain("abc1234");
			expect(text).toContain("user");
			expect(text).toContain("/cache/marketplace/plugin@mkt");
		} finally {
			page.dispose();
		}
	});

	it("disables the plugin when the enabled toggle is activated", async () => {
		spies.push(spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(undefined));
		const calls: boolean[] = [];
		spies.push(
			spyOn(MarketplaceManager.prototype, "setPluginEnabled").mockImplementation(async (_id, enabled) => {
				calls.push(enabled);
			}),
		);
		const changed = Promise.withResolvers<void>();
		const page = openPage(
			{ onPluginChanged: () => changed.resolve() },
			{ kind: "mkt", plugin: marketplace("toggle@mkt") },
		);
		try {
			await page.until("Enabled");
			page.press("space", " ");
			await changed.promise;
			expect(calls).toEqual([false]);
		} finally {
			page.dispose();
		}
	});

	it("renders and updates settings from the marketplace runtime package", async () => {
		const runtimePlugin = npm("omp-commit", {
			manifest: {
				version: "1.0.0",
				settings: { mainBranchProtection: { type: "boolean", default: true } },
			},
		});
		spies.push(spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(runtimePlugin));
		spies.push(spyOn(PluginManager.prototype, "getPluginSettings").mockResolvedValue({}));
		const changes: Array<[string, string, unknown]> = [];
		spies.push(
			spyOn(PluginManager.prototype, "setPluginSetting").mockImplementation(async (name, key, value) => {
				changes.push([name, key, value]);
			}),
		);
		const page = openPage({}, { kind: "mkt", plugin: marketplace("omp-commit@market") });
		try {
			const text = await page.until("mainBranchProtection");
			expect(text).toContain("mainBranchProtection");
			expect(text).toContain("true");

			page.press("down");
			page.press("space", " ");
			await Promise.resolve();
			expect(changes).toEqual([["omp-commit", "mainBranchProtection", false]]);
		} finally {
			page.dispose();
		}
	});

	it("shortens home-relative install paths to ~ before rendering", async () => {
		spies.push(spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(undefined));
		const home = os.homedir();
		const installPath = `${home}/.omp/cache/plugins/sample@mkt`;
		const page = openPage({}, { kind: "mkt", plugin: marketplace("sample@mkt", { entry: { installPath } }) });
		try {
			const text = await page.until("~/.omp/cache/plugins/sample@mkt");
			expect(text).toContain("~/.omp/cache/plugins/sample@mkt");
			expect(text).not.toContain(home);
		} finally {
			page.dispose();
		}
	});
});
