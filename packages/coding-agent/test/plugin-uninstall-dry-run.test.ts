/**
 * Regression tests for `omp plugin uninstall <plugin> --dry-run` (#8178).
 *
 * `--dry-run` must be non-mutating: it reports what would be removed and
 * leaves the installed plugin list untouched. Before the fix, `handleUninstall`
 * dropped the parsed `dryRun` flag and unconditionally called the removal
 * methods, so a dry-run actually uninstalled the plugin on both the npm and
 * marketplace routes.
 *
 * `runPluginCommand` does not initialize the theme on its own, so tests that exercise
 * rendered success or error output initialize it explicitly.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPluginSummary } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("runPluginCommand({ action: 'uninstall', flags: { dryRun } })", () => {
	beforeEach(async () => {
		await initTheme();
		spyOn(console, "log").mockImplementation(() => undefined);
		spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		mock.restore();
	});

	test("npm route: --dry-run never calls PluginManager.uninstall", async () => {
		// No marketplace-installed plugins → the name routes down the npm path.
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const mktUninstall = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);
		try {
			await runPluginCommand({ action: "uninstall", args: ["zmarketplace"], flags: { dryRun: true, json: true } });
			expect(npmUninstall).not.toHaveBeenCalled();
			expect(mktUninstall).not.toHaveBeenCalled();
		} finally {
			npmUninstall.mockRestore();
			mktUninstall.mockRestore();
		}
	});

	test("marketplace route: --dry-run delegates scope validation without npm removal", async () => {
		const installed: InstalledPluginSummary = {
			id: "hello@local",
			scope: "user",
			entries: [
				{
					scope: "user",
					installPath: "/tmp/hello",
					version: "1.0.0",
					installedAt: new Date().toISOString(),
					lastUpdated: new Date().toISOString(),
				},
			],
		};
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([installed]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const mktUninstall = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);
		try {
			await runPluginCommand({ action: "uninstall", args: ["hello@local"], flags: { dryRun: true, json: true } });
			expect(mktUninstall).toHaveBeenCalledTimes(1);
			expect(mktUninstall.mock.calls[0]).toEqual(["hello@local", undefined, { dryRun: true }]);
			expect(npmUninstall).not.toHaveBeenCalled();
		} finally {
			npmUninstall.mockRestore();
			mktUninstall.mockRestore();
		}
	});

	test("without --dry-run the npm route still uninstalls", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(PluginManager.prototype, "list").mockResolvedValue([{ name: "zmarketplace" }] as never);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		try {
			await runPluginCommand({ action: "uninstall", args: ["zmarketplace"], flags: { json: true } });
			expect(npmUninstall).toHaveBeenCalledTimes(1);
			expect(npmUninstall.mock.calls[0]?.[0]).toBe("zmarketplace");
		} finally {
			npmUninstall.mockRestore();
		}
	});
	test("a unique bare marketplace name uninstalls its qualified plugin", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
			{ id: "hello@local", scope: "user", entries: [] },
		]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const mktUninstall = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);

		await runPluginCommand({ action: "uninstall", args: ["hello"], flags: { json: true } });

		expect(mktUninstall).toHaveBeenCalledWith("hello@local", undefined);
		expect(npmUninstall).not.toHaveBeenCalled();
	});

	test("an unknown npm name errors without reporting a false uninstall", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);
		spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		await expect(
			runPluginCommand({ action: "uninstall", args: ["not-installed"], flags: { json: true } }),
		).rejects.toThrow("process.exit");

		expect(exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not-installed is not installed"));
		expect(npmUninstall).not.toHaveBeenCalled();
	});
	test("an ambiguous bare marketplace name lists qualified candidates without uninstalling", async () => {
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
			{ id: "hello@one", scope: "user", entries: [] },
			{ id: "hello@two", scope: "user", entries: [] },
		]);
		const npmUninstall = spyOn(PluginManager.prototype, "uninstall").mockResolvedValue(undefined);
		const mktUninstall = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);
		const exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit");
		});

		await expect(runPluginCommand({ action: "uninstall", args: ["hello"], flags: { json: true } })).rejects.toThrow(
			"process.exit",
		);

		expect(exit).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("hello@one, hello@two"));
		expect(npmUninstall).not.toHaveBeenCalled();
		expect(mktUninstall).not.toHaveBeenCalled();
	});
});
