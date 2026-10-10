/**
 * Regression tests for `omp plugin upgrade <plugin> --dry-run`.
 *
 * `--dry-run` must be non-mutating: the plugin stays installed at its current
 * version, the registry is untouched, and no cache directory is written or
 * removed — only the would-be version is resolved and reported. Before the
 * fix, `handleUpgrade` dropped the `dryRun` flag and upgraded for real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	getCachedPluginPath,
	MarketplaceManager,
	readInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Minimal marketplace fixture, built once into a temp dir (same shape as
// manager.test.ts's buildMinimalFixture): one plugin entry plus a plugin.json
// for the manifest-fallback path.
let FIXTURE_DIR: string;

function buildMinimalFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-upgrade-fixture-"));
	const pluginDir = path.join(root, "plugins", "hello-plugin");
	fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
	fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
	fs.mkdirSync(path.join(pluginDir, "extensions"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "test-marketplace",
			owner: { name: "Test Author", email: "test@example.com" },
			metadata: { description: "A test marketplace for unit tests", version: "1.0.0" },
			plugins: [
				{
					name: "hello-plugin",
					source: "./plugins/hello-plugin",
					description: "A test plugin that greets",
					version: "1.0.0",
				},
			],
		}),
	);
	// Consulted only when the catalog version is stripped (the manifest-fallback test).
	fs.writeFileSync(
		path.join(pluginDir, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "hello-plugin", version: "1.0.0" }),
	);
	fs.writeFileSync(
		path.join(pluginDir, "package.json"),
		JSON.stringify({
			name: "hello-plugin",
			version: "1.0.0",
			omp: { extensions: ["./extensions"] },
		}),
	);
	fs.writeFileSync(path.join(pluginDir, "extensions", "index.ts"), "export default {};\n");
	return root;
}

interface TestContext {
	manager: MarketplaceManager;
	tmpDir: string;
	mktCacheDir: string;
	plugCacheDir: string;
	catalogPath: string;
}

function createTestContext(): TestContext {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-upgrade-test-"));

	const mktCacheDir = path.join(tmpDir, "cache", "marketplaces");
	const plugCacheDir = path.join(tmpDir, "cache", "plugins");

	const manager = new MarketplaceManager({
		marketplacesRegistryPath: path.join(tmpDir, "marketplaces.json"),
		installedRegistryPath: path.join(tmpDir, "installed_plugins.json"),
		marketplacesCacheDir: mktCacheDir,
		pluginsCacheDir: plugCacheDir,
	});

	return {
		manager,
		tmpDir,
		mktCacheDir,
		plugCacheDir,
		catalogPath: path.join(mktCacheDir, "test-marketplace", "marketplace.json"),
	};
}


describe("MarketplaceManager upgrade --dry-run", () => {

async function bumpCatalogVersionTo(version: string): Promise<void> {
	const catalog = (await Bun.file(ctx.catalogPath).json()) as { plugins: Array<{ version?: string }> };
	catalog.plugins[0].version = version;
	await Bun.write(ctx.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}
	let ctx: TestContext;

	beforeAll(() => {
		FIXTURE_DIR = buildMinimalFixture();
	});

	afterAll(() => {
		removeSyncWithRetries(FIXTURE_DIR);
	});

	beforeEach(() => {
		ctx = createTestContext();
	});

	afterEach(() => {
		removeSyncWithRetries(ctx.tmpDir);
	});

	/** Adds the fixture marketplace, installs hello-plugin at 1.0.0, bumps the catalog to 2.0.0. */
	async function setupStaleInstall(): Promise<string> {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		await bumpCatalogVersionTo("2.0.0");
		const installPathA = getCachedPluginPath(ctx.plugCacheDir, "test-marketplace", "hello-plugin", "1.0.0");
		expect(fs.existsSync(installPathA)).toBe(true);
		return installPathA;
	}

	it("dryRun: plugin stays at version A on disk and entry reports the would-be version", async () => {
		const installPathA = await setupStaleInstall();

		const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace", undefined, { dryRun: true });

		// Reports the would-be version, not the installed one.
		expect(entry.version).toBe("2.0.0");
		// installPath is where the cache WOULD land.
		expect(entry.installPath).toBe(getCachedPluginPath(ctx.plugCacheDir, "test-marketplace", "hello-plugin", "2.0.0"));

		// Nothing mutated: old cache version still present, new one absent.
		expect(fs.existsSync(installPathA)).toBe(true);
		expect(fs.existsSync(entry.installPath)).toBe(false);

		// Registry still says 1.0.0.
		const reg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		const installed = reg.plugins["hello-plugin@test-marketplace"];
		expect(installed).toBeDefined();
		expect(installed![0].version).toBe("1.0.0");
		// Only the 1.0.0 version dir exists under the plugin cache.
		const versionDirs = fs
			.readdirSync(ctx.plugCacheDir)
			.filter(d => d.startsWith("test-marketplace___hello-plugin___"))
			.sort();
		expect(versionDirs).toEqual(["test-marketplace___hello-plugin___1.0.0"]);
	});

	it("dryRun: versionless catalog entry falls back to the plugin manifest", async () => {
		const installPathA = await setupStaleInstall();
		const catalog = (await Bun.file(ctx.catalogPath).json()) as { plugins: Array<{ version?: string }> };
		delete catalog.plugins[0].version;
		await Bun.write(ctx.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
		// Bump the manifest version so the fallback resolves to it.
		const manifestPath = path.join(FIXTURE_DIR, "plugins", "hello-plugin", ".claude-plugin", "plugin.json");
		fs.writeFileSync(manifestPath, JSON.stringify({ name: "hello-plugin", version: "3.0.0" }));

		try {
			const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace", undefined, { dryRun: true });
			expect(entry.version).toBe("3.0.0");
			expect(fs.existsSync(installPathA)).toBe(true);
			const reg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
			expect(reg.plugins["hello-plugin@test-marketplace"]![0].version).toBe("1.0.0");
		} finally {
			fs.writeFileSync(manifestPath, JSON.stringify({ name: "hello-plugin", version: "1.0.0" }));
		}
	});

	it("without dryRun: the same setup upgrades to 2.0.0", async () => {
		const installPathA = await setupStaleInstall();

		const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace");

		expect(entry.version).toBe("2.0.0");
		const reg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(reg.plugins["hello-plugin@test-marketplace"]![0].version).toBe("2.0.0");

		// Old cache version removed, new one present.
		expect(fs.existsSync(installPathA)).toBe(false);
		expect(fs.existsSync(entry.installPath)).toBe(true);
	});

	it("without dryRun: upgradeAllPlugins upgrades the stale plugin", async () => {
		await setupStaleInstall();

		const results = await ctx.manager.upgradeAllPlugins();
		expect(results).toEqual([
			{ pluginId: "hello-plugin@test-marketplace", scope: "user", from: "1.0.0", to: "2.0.0" },
		]);
		const reg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(reg.plugins["hello-plugin@test-marketplace"]![0].version).toBe("2.0.0");
	});

	it("upgradeAllPlugins with dryRun reports the would-be version without mutating", async () => {
		const installPathA = await setupStaleInstall();

		const results = await ctx.manager.upgradeAllPlugins({ dryRun: true });
		expect(results).toEqual([
			{ pluginId: "hello-plugin@test-marketplace", scope: "user", from: "1.0.0", to: "2.0.0" },
		]);

		const reg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(reg.plugins["hello-plugin@test-marketplace"]![0].version).toBe("1.0.0");
		expect(fs.existsSync(installPathA)).toBe(true);
	});
});
