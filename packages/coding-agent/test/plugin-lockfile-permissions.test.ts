import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { MarketplaceManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/manager";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** POSIX mode bits of a file; meaningless on Windows, where the tests are skipped. */
async function modeOf(file: string): Promise<number> {
	return (await fs.stat(file)).mode & 0o777;
}

describe("plugin runtime lockfile permissions", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let lockfile: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-lock-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		lockfile = path.join(pluginsDir, "omp-plugins.lock.json");

		spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	// A setting a plugin marks `secret` is a credential the user asked to be
	// masked. A lockfile an earlier install left world-readable must not receive
	// it: the write publishes a new owner-only file instead of rewriting that inode.
	test.skipIf(process.platform === "win32")(
		"a plugin setting replaces a world-readable lockfile with an owner-only one",
		async () => {
			await fs.mkdir(pluginsDir, { recursive: true });
			await fs.writeFile(lockfile, JSON.stringify({ plugins: {}, settings: {} }));
			await fs.chmod(lockfile, 0o644);
			const before = (await fs.stat(lockfile)).ino;

			await new PluginManager(tmpRoot).setPluginSetting("omp-commit", "apiToken", "sk-live-secret");

			expect(await fs.readFile(lockfile, "utf8")).toContain("sk-live-secret");
			expect(await modeOf(lockfile)).toBe(0o600);
			expect((await fs.stat(lockfile)).ino).not.toBe(before);
			expect((await fs.readdir(pluginsDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		},
	);

	test.skipIf(process.platform === "win32")(
		"the marketplace plugin state is written to an owner-only lockfile",
		async () => {
			const installPath = path.join(pluginsDir, "cache", "omp-commit");
			await fs.mkdir(installPath, { recursive: true });
			await fs.writeFile(
				path.join(installPath, "package.json"),
				JSON.stringify({ name: "omp-commit", version: "1.0.0" }),
			);
			const installedRegistryPath = path.join(pluginsDir, "installed_plugins.json");
			await fs.writeFile(
				installedRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"omp-commit@sample": [
							{
								scope: "user",
								installPath,
								version: "1.0.0",
								installedAt: "2026-01-01T00:00:00Z",
								lastUpdated: "2026-01-01T00:00:00Z",
							},
						],
					},
				}),
			);

			// A lockfile an earlier install left world-readable.
			await fs.mkdir(pluginsDir, { recursive: true });
			await fs.writeFile(
				lockfile,
				JSON.stringify({
					plugins: { "omp-commit": { version: "1.0.0", enabledFeatures: null, enabled: true } },
					settings: { "omp-commit": { apiToken: "sk-live-secret" } },
				}),
			);
			await fs.chmod(lockfile, 0o644);

			const manager = new MarketplaceManager({
				marketplacesRegistryPath: path.join(pluginsDir, "marketplaces.json"),
				installedRegistryPath,
				marketplacesCacheDir: path.join(pluginsDir, "cache", "marketplaces"),
				pluginsCacheDir: path.join(pluginsDir, "cache", "plugins"),
			});
			await manager.setPluginEnabled("omp-commit@sample", false);

			expect(await modeOf(lockfile)).toBe(0o600);
			const runtime = JSON.parse(await fs.readFile(lockfile, "utf8"));
			expect(runtime.plugins["omp-commit"].enabled).toBe(false);
			expect(runtime.settings["omp-commit"].apiToken).toBe("sk-live-secret");
		},
	);
});
