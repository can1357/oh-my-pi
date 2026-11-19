/**
 * Regression test for `omp plugin config validate` (#9106).
 *
 * `handleConfigValidate` used to enumerate only `PluginManager.list()`, which
 * intentionally omits marketplace runtime packages — so an invalid constrained
 * value stored for a marketplace plugin (e.g. after a schema-changing upgrade or
 * a bad TUI write) was skipped and validation falsely reported success. The fix
 * adds a marketplace-aware enumeration path.
 *
 * `flags.json` is set so the renderer takes the JSON branch and avoids the theme.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { InstalledPluginSummary } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";

describe("runPluginCommand({ action: 'config', args: ['validate'] })", () => {
	const output: string[] = [];

	beforeEach(() => {
		output.length = 0;
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		});
		spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(() => {
		mock.restore();
	});

	test("reports an invalid stored value on a marketplace plugin that list() omits", async () => {
		const summary: InstalledPluginSummary = {
			id: "omp-commit@market",
			scope: "user",
			entries: [
				{
					scope: "user",
					installPath: "/cache/omp-commit",
					version: "2.0.0",
					installedAt: "2026-08-20T00:00:00.000Z",
					lastUpdated: "2026-08-20T00:00:00.000Z",
				},
			],
		};
		const resolved: InstalledPlugin = {
			name: "omp-commit",
			version: "2.0.0",
			path: "/cache/omp-commit",
			manifest: {
				version: "2.0.0",
				settings: { splitMode: { type: "enum", values: ["auto", "manual"], default: "auto" } },
			},
			enabledFeatures: null,
			enabled: true,
		};

		// list() omits marketplace runtime packages by design.
		spyOn(PluginManager.prototype, "list").mockResolvedValue([]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([summary]);
		const getPlugin = spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(resolved);
		spyOn(PluginManager.prototype, "getPluginSettings").mockResolvedValue({ splitMode: "bogus" });

		await runPluginCommand({ action: "config", args: ["validate"], flags: { json: true } });

		// Resolved through the trusted marketplace install path.
		expect(getPlugin).toHaveBeenCalledWith("omp-commit", { path: "/cache/omp-commit" });

		const report = JSON.parse(output.join("\n")) as {
			valid: boolean;
			errors: Array<{ plugin: string; key: string }>;
		};
		expect(report.valid).toBe(false);
		expect(report.errors).toContainEqual(expect.objectContaining({ plugin: "omp-commit", key: "splitMode" }));
	});

	test("validates against the active project schema over a same-named user plugin", async () => {
		const userPlugin: InstalledPlugin = {
			name: "omp-commit",
			version: "1.0.0",
			path: "/user/omp-commit",
			manifest: {
				version: "1.0.0",
				settings: { splitMode: { type: "enum", values: ["legacy"], default: "legacy" } },
			},
			enabledFeatures: null,
			enabled: true,
		};
		const projectPlugin: InstalledPlugin = {
			...userPlugin,
			version: "2.0.0",
			path: "/project/omp-commit",
			manifest: {
				version: "2.0.0",
				settings: { splitMode: { type: "enum", values: ["auto", "manual"], default: "auto" } },
			},
		};
		const summary: InstalledPluginSummary = {
			id: "omp-commit@market",
			scope: "project",
			entries: [
				{
					scope: "project",
					installPath: projectPlugin.path,
					version: projectPlugin.version,
					installedAt: "2026-08-20T00:00:00.000Z",
					lastUpdated: "2026-08-20T00:00:00.000Z",
				},
			],
		};

		spyOn(PluginManager.prototype, "list").mockResolvedValue([userPlugin]);
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([summary]);
		const getPlugin = spyOn(PluginManager.prototype, "getPlugin").mockResolvedValue(projectPlugin);
		spyOn(PluginManager.prototype, "getPluginSettings").mockResolvedValue({ splitMode: "legacy" });

		await runPluginCommand({ action: "config", args: ["validate"], flags: { json: true } });

		expect(getPlugin).toHaveBeenCalledWith("omp-commit");
		const report = JSON.parse(output.join("\n")) as {
			valid: boolean;
			errors: Array<{ plugin: string; key: string }>;
		};
		expect(report.valid).toBe(false);
		expect(report.errors).toContainEqual(expect.objectContaining({ plugin: "omp-commit", key: "splitMode" }));
	});
});
