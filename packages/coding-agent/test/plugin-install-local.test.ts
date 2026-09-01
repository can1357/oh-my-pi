/**
 * Routing tests for `omp plugin install <local-path>` (#1945).
 *
 * Two layers of coverage:
 *  1. Spy-based: `runPluginCommand` with a local path calls
 *     `PluginManager.link` and NEVER `PluginManager.install` (the npm path
 *     that produced `Invalid package name: .`).
 *  2. End-to-end: with a real on-disk plugin directory, the install routes
 *     through `link` and produces the symlink + lockfile entry users expect.
 *
 * `flags.json` is set everywhere so the renderer takes the JSON branch and
 * avoids the theme (`runPluginCommand` does not initialize the theme on its
 * own — `commands/plugin.ts` does).
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPluginCommand } from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FAKE_INSTALLED: InstalledPlugin = {
	name: "kimi-datasource",
	version: "1.0.0",
	path: "/tmp/fake/plugins/node_modules/kimi-datasource",
	manifest: { version: "1.0.0" },
	enabledFeatures: null,
	enabled: true,
};

async function createLocalPlugin(root: string): Promise<string> {
	const localPlugin = path.join(root, "kimi-datasource");
	await fs.mkdir(localPlugin, { recursive: true });
	await Bun.write(
		path.join(localPlugin, "package.json"),
		JSON.stringify({
			name: "kimi-datasource",
			version: "1.0.0",
			omp: { extensions: ["./src/extension.ts"] },
		}),
	);
	return localPlugin;
}

describe("runPluginCommand({ action: 'install', args: [<local>] })", () => {
	let tmpRoot: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-install-local-"));
		const pluginsDir = path.join(tmpRoot, "plugins");
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });

		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "omp-plugins.lock.json"));
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
		// runPluginCommand always builds a MarketplaceManager to enumerate
		// registered marketplaces. Stub the registry list so classification has
		// no marketplace candidates to confuse local paths with.
		spyOn(MarketplaceManager.prototype, "listMarketplaces").mockResolvedValue([]);

		// Swallow CLI output so test logs stay clean.
		spyOn(console, "log").mockImplementation(() => undefined);
		spyOn(console, "error").mockImplementation(() => undefined);
	});
	afterEach(async () => {
		// Restore every spy installed in beforeEach plus the per-test
		// linkSpy/installSpy/console spies. Without this, the piUtils.*
		// stubs leak into sibling test files (e.g. marketplace/manager.test.ts
		// breaks because listMarketplaces() still returns []).
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	test("dispatches a local path to link() instead of install()", async () => {
		const linkSpy = spyOn(PluginManager.prototype, "link").mockResolvedValue(FAKE_INSTALLED);
		const installSpy = spyOn(PluginManager.prototype, "install").mockResolvedValue(FAKE_INSTALLED);
		try {
			await runPluginCommand({ action: "install", args: ["."], flags: { json: true } });
			expect(linkSpy).toHaveBeenCalledTimes(1);
			expect(linkSpy.mock.calls[0]?.[0]).toBe(".");
			expect(installSpy).not.toHaveBeenCalled();
		} finally {
			linkSpy.mockRestore();
			installSpy.mockRestore();
		}
	});

	test("npm-style spec still dispatches to install(), not link()", async () => {
		// Guard against an overly-eager local detector: a bare package name with
		// no path-like prefix must continue down the npm path.
		const linkSpy = spyOn(PluginManager.prototype, "link").mockResolvedValue(FAKE_INSTALLED);
		const installSpy = spyOn(PluginManager.prototype, "install").mockResolvedValue(FAKE_INSTALLED);
		try {
			await runPluginCommand({ action: "install", args: ["some-pkg"], flags: { json: true } });
			expect(installSpy).toHaveBeenCalledTimes(1);
			expect(installSpy.mock.calls[0]?.[0]).toBe("some-pkg");
			expect(linkSpy).not.toHaveBeenCalled();
		} finally {
			linkSpy.mockRestore();
			installSpy.mockRestore();
		}
	});

	test("--dry-run on a local path neither links nor installs", async () => {
		const linkSpy = spyOn(PluginManager.prototype, "link").mockResolvedValue(FAKE_INSTALLED);
		const installSpy = spyOn(PluginManager.prototype, "install").mockResolvedValue(FAKE_INSTALLED);
		try {
			await runPluginCommand({ action: "install", args: ["."], flags: { dryRun: true, json: true } });
			expect(linkSpy).not.toHaveBeenCalled();
			expect(installSpy).not.toHaveBeenCalled();
		} finally {
			linkSpy.mockRestore();
			installSpy.mockRestore();
		}
	});

	test("real local plugin directory: install symlinks it like link would", async () => {
		// End-to-end: stage a real plugin folder, route through plugin-cli
		// (no spies on PluginManager.link), and verify the resulting symlink
		// + lockfile entry. Pins the contract that local-path installs
		// symlink rather than copy-install, matching `omp plugin link`.
		const localPlugin = await createLocalPlugin(tmpRoot);

		await runPluginCommand({ action: "install", args: [localPlugin], flags: { json: true } });

		const linkTarget = path.join(tmpRoot, "plugins", "node_modules", "kimi-datasource");
		const stat = await fs.lstat(linkTarget);
		expect(stat.isSymbolicLink()).toBe(true);
		expect(await fs.readlink(linkTarget)).toBe(localPlugin);

		const lock = await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).json();
		expect(lock.plugins["kimi-datasource"]).toEqual({
			version: "1.0.0",
			enabledFeatures: null,
			enabled: true,
		});
	});
	test("list --json includes linked local plugin without package dependencies", async () => {
		const localPlugin = await createLocalPlugin(tmpRoot);
		const output: string[] = [];
		spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
		spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);

		await runPluginCommand({ action: "link", args: [localPlugin], flags: { json: true } });
		output.length = 0;
		await runPluginCommand({ action: "list", args: [], flags: { json: true } });

		const listed = JSON.parse(output.join("\n")) as { npm: InstalledPlugin[] };
		expect(listed.npm.map(plugin => plugin.name)).toContain("kimi-datasource");
	});

	test("doctor --fix preserves linked local plugin state without package dependencies", async () => {
		await Bun.write(
			path.join(tmpRoot, "plugins", "package.json"),
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }),
		);
		const localPlugin = await createLocalPlugin(tmpRoot);
		const manager = new PluginManager(tmpRoot);

		await manager.link(localPlugin);
		const checks = await manager.doctor({ fix: true });

		expect(checks.find(check => check.name === "orphan:kimi-datasource")).toBeUndefined();
		const lock = await Bun.file(path.join(tmpRoot, "omp-plugins.lock.json")).json();
		expect(lock.plugins["kimi-datasource"]).toEqual({
			version: "1.0.0",
			enabledFeatures: null,
			enabled: true,
		});
		expect((await manager.list()).map(plugin => plugin.name)).toContain("kimi-datasource");
	});
});
