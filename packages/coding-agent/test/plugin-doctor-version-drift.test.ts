import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import type { PluginRuntimeState } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Regression for #11090: `omp-plugins.lock.json` can diverge from the package
// version in node_modules. `plugin doctor` must surface the stale copy instead
// of treating the on-disk manifest alone as proof of health.
describe("PluginManager.doctor version drift", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-drift-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(pluginsDir, "omp-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	async function seed(name: string, diskVersion: string, lockVersion: string): Promise<void> {
		const installedDir = path.join(pluginsNodeModules, name);
		await fs.mkdir(installedDir, { recursive: true });
		await Bun.write(
			path.join(installedDir, "package.json"),
			JSON.stringify({ name, version: diskVersion, omp: { version: diskVersion } }, null, 2),
		);
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [name]: `^${lockVersion}` } }, null, 2),
		);
		const state: PluginRuntimeState = { version: lockVersion, enabledFeatures: null, enabled: true };
		await Bun.write(
			path.join(pluginsDir, "omp-plugins.lock.json"),
			JSON.stringify({ plugins: { [name]: state }, settings: {} }, null, 2),
		);
	}

	test("reports an error when the lock version differs from the installed version", async () => {
		await seed("@scope/plugin", "1.0.2", "1.0.3");

		const checks = await new PluginManager(tmpRoot).doctor();
		const drift = checks.find(c => c.name === "plugin:@scope/plugin:version");

		expect(drift).toBeDefined();
		expect(drift?.status).toBe("error");
		expect(drift?.message).toContain("v1.0.3");
		expect(drift?.message).toContain("v1.0.2");
	});

	test("reconciles version drift by re-extracting only the drifted package", async () => {
		const name = "@scope/plugin";
		const expectedVersion = "1.0.3";
		await seed(name, "1.0.2", expectedVersion);
		const packagePath = path.join(pluginsNodeModules, name, "package.json");
		const reinstalled = JSON.stringify({ name, version: expectedVersion, omp: { version: expectedVersion } });
		const install = Bun.spawn(["bun", "-e", ""], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		Object.defineProperty(install, "exited", {
			get: async () => {
				await Bun.write(packagePath, reinstalled);
				return 0;
			},
		});
		const spawnSpy = vi.spyOn(Bun, "spawn").mockReturnValue(install);

		const checks = await new PluginManager(tmpRoot).doctor({ fix: true });

		// Targeted repair: bare `bun install` (no global `--force` that would
		// re-extract sibling plugins).
		expect(spawnSpy).toHaveBeenCalledWith(["bun", "install"], expect.objectContaining({ cwd: pluginsDir }));
		expect(checks.find(c => c.name === `plugin:${name}:version`)).toEqual({
			name: `plugin:${name}:version`,
			status: "ok",
			message: `Reconciled version drift: node_modules now matches lock v${expectedVersion}`,
			fixed: true,
		});
		// Rescan: the plugin check reflects the freshly installed version.
		expect(checks.find(c => c.name === `plugin:${name}`)?.message).toBe(`v${expectedVersion}`);
	});

	test("revalidates the repaired plugin so a newly broken manifest surfaces", async () => {
		const name = "@scope/plugin";
		const expectedVersion = "1.0.3";
		await seed(name, "1.0.2", expectedVersion);
		const packagePath = path.join(pluginsNodeModules, name, "package.json");
		// The repaired version declares a tools entry that is missing on disk.
		const reinstalled = JSON.stringify({
			name,
			version: expectedVersion,
			omp: { version: expectedVersion, tools: "./missing.js" },
		});
		const install = Bun.spawn(["bun", "-e", ""], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		Object.defineProperty(install, "exited", {
			get: async () => {
				await Bun.write(packagePath, reinstalled);
				return 0;
			},
		});
		vi.spyOn(Bun, "spawn").mockReturnValue(install);

		const checks = await new PluginManager(tmpRoot).doctor({ fix: true });

		expect(checks.find(c => c.name === `plugin:${name}:version`)?.fixed).toBe(true);
		expect(checks.find(c => c.name === `plugin:${name}:tools`)).toEqual({
			name: `plugin:${name}:tools`,
			status: "error",
			message: `Tools entry "./missing.js" not found`,
		});
	});

	test("does not report version drift for a config-only local link", async () => {
		const name = "@scope/plugin";
		await seed(name, "1.0.2", "1.0.2");
		const sourcePath = path.join(tmpRoot, "linked-plugin");
		await fs.mkdir(sourcePath, { recursive: true });
		await Bun.write(
			path.join(sourcePath, "package.json"),
			JSON.stringify({ name, version: "1.0.3", omp: { version: "1.0.3" } }),
		);
		const installedPath = path.join(pluginsNodeModules, name);
		await fs.rm(installedPath, { recursive: true });
		await fs.symlink(sourcePath, installedPath);
		await Bun.write(
			path.join(pluginsDir, "package.json"),
			JSON.stringify({ name: "omp-plugins", private: true, dependencies: {} }),
		);

		const checks = await new PluginManager(tmpRoot).doctor();

		expect(checks.find(c => c.name === `plugin:${name}`)?.message).toBe("v1.0.3");
		expect(checks.some(c => c.name === `plugin:${name}:version`)).toBe(false);
	});

	test("does not report drift when the lock version matches the installed version", async () => {
		await seed("@scope/plugin", "1.0.3", "1.0.3");

		const checks = await new PluginManager(tmpRoot).doctor();

		expect(checks.some(c => c.name === "plugin:@scope/plugin:version")).toBe(false);
		expect(checks.filter(c => c.status === "error")).toHaveLength(0);
	});
});
