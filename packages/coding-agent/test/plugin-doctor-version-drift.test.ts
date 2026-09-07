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

	test("force-reinstalls dependencies before marking version drift fixed", async () => {
		const name = "@scope/plugin";
		const expectedVersion = "1.0.3";
		await seed(name, "1.0.2", expectedVersion);
		const packagePath = path.join(pluginsNodeModules, name, "package.json");
		const replacement = JSON.stringify({
			name,
			version: expectedVersion,
			omp: { version: expectedVersion },
		});
		const repair = Bun.spawn(["bun", "-e", ""], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		Object.defineProperty(repair, "exited", {
			get: async () => {
				await Bun.write(packagePath, replacement);
				return 0;
			},
		});
		const spawnSpy = vi.spyOn(Bun, "spawn").mockReturnValue(repair);

		const checks = await new PluginManager(tmpRoot).doctor({ fix: true });
		expect(spawnSpy).toHaveBeenCalledWith(
			["bun", "install", "--force"],
			expect.objectContaining({ cwd: pluginsDir }),
		);
		const drift = checks.find(c => c.name === `plugin:${name}:version`);

		expect(drift).toEqual({
			name: `plugin:${name}:version`,
			status: "ok",
			message: `Reconciled version drift: node_modules now matches lock v${expectedVersion}`,
			fixed: true,
		});
	});

	test("does not report drift when the lock version matches the installed version", async () => {
		await seed("@scope/plugin", "1.0.3", "1.0.3");

		const checks = await new PluginManager(tmpRoot).doctor();

		expect(checks.some(c => c.name === "plugin:@scope/plugin:version")).toBe(false);
		expect(checks.filter(c => c.status === "error")).toHaveLength(0);
	});
});
