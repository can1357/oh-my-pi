import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listOmpExtensionRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import {
	MarketplaceManager,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	writeMarketplacesRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Minimal marketplace fixture, built once into a temp dir (see beforeAll). It carries only
// what these tests assert — one plugin entry plus a plugin.json for the version-fallback path —
// so each install's recursive cache copy stays a single file rather than the full shared fixture.
let FIXTURE_DIR: string;

function buildMinimalFixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-fixture-"));
	const pluginDir = path.join(root, "plugins", "hello-plugin");
	fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
	fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
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
	// Consulted only when the catalog version is stripped (the version-fallback test).
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

// ── Test helper ───────────────────────────────────────────────────────────────

interface TestContext {
	manager: MarketplaceManager;
	tmpDir: string;
	/** Incremented each time clearPluginRootsCache is called. */
	clearCount: () => number;
}

function createTestContext(): TestContext {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-test-"));

	const dirs = {
		mktRegistry: path.join(tmpDir, "marketplaces.json"),
		instRegistry: path.join(tmpDir, "installed_plugins.json"),
		projectInstRegistry: path.join(tmpDir, "project_installed_plugins.json"),
		mktCache: path.join(tmpDir, "cache", "marketplaces"),
		plugCache: path.join(tmpDir, "cache", "plugins"),
	};

	let count = 0;

	const manager = new MarketplaceManager({
		marketplacesRegistryPath: dirs.mktRegistry,
		installedRegistryPath: dirs.instRegistry,
		projectInstalledRegistryPath: dirs.projectInstRegistry,
		marketplacesCacheDir: dirs.mktCache,
		pluginsCacheDir: dirs.plugCache,
		clearPluginRootsCache: () => {
			count++;
		},
	});

	return { manager, tmpDir, clearCount: () => count };
}

function mockPluginManagerPaths(root: string) {
	return [
		spyOn(piUtils, "getPluginsDir").mockReturnValue(root),
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(root, "node_modules")),
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(root, "package.json")),
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(root, "omp-plugins.lock.json")),
		spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(root, "plugin-overrides.json")),
	];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MarketplaceManager", () => {
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

	// ── Marketplace lifecycle ──────────────────────────────────────────────

	it("addMarketplace with local fixture → appears in listMarketplaces", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);

		const list = await ctx.manager.listMarketplaces();
		expect(list).toHaveLength(1);
		expect(list[0].name).toBe("test-marketplace");
	});

	it("addMarketplace with duplicate name → throws", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await expect(ctx.manager.addMarketplace(FIXTURE_DIR)).rejects.toThrow(/already exists/);
	});

	it("removeMarketplace → gone from list and catalog cache removed", async () => {
		const entry = await ctx.manager.addMarketplace(FIXTURE_DIR);

		// Catalog file should exist in cache
		expect(fs.existsSync(entry.catalogPath)).toBe(true);

		await ctx.manager.removeMarketplace("test-marketplace");

		const list = await ctx.manager.listMarketplaces();
		expect(list).toHaveLength(0);

		// Catalog cache dir should be gone
		const catalogDir = path.dirname(entry.catalogPath);
		expect(fs.existsSync(catalogDir)).toBe(false);
	});

	it("updateMarketplace on nonexistent marketplace → throws", async () => {
		await expect(ctx.manager.updateMarketplace("ghost")).rejects.toThrow(/not found/);
	});

	it("updateMarketplace re-fetches and updates updatedAt", async () => {
		const added = await ctx.manager.addMarketplace(FIXTURE_DIR);

		const updated = await ctx.manager.updateMarketplace("test-marketplace");
		expect(updated.addedAt).toBe(added.addedAt);
		// updatedAt must be at or after addedAt
		expect(new Date(updated.updatedAt) >= new Date(added.addedAt)).toBe(true);
	});

	it("updateMarketplace expands a home-relative catalog path", async () => {
		const fakeHome = fs.mkdtempSync(path.join(ctx.tmpDir, "home-"));
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
		const registryPath = path.join(ctx.tmpDir, "marketplaces.json");
		const originalCwd = process.cwd();
		const cwd = path.join(ctx.tmpDir, "cwd");

		try {
			const added = await ctx.manager.addMarketplace(FIXTURE_DIR);
			const catalogPath = "~/.omp/plugins/cache/marketplaces/test-marketplace/marketplace.json";
			const registry = await readMarketplacesRegistry(registryPath);
			await writeMarketplacesRegistry(registryPath, {
				...registry,
				marketplaces: [{ ...added, catalogPath }],
			});
			fs.mkdirSync(cwd);
			process.chdir(cwd);

			await ctx.manager.updateMarketplace("test-marketplace");

			expect(fs.existsSync(path.join(fakeHome, catalogPath.slice(2)))).toBe(true);
			expect(fs.existsSync(path.join(cwd, catalogPath))).toBe(false);
		} finally {
			process.chdir(originalCwd);
			homedirSpy.mockRestore();
		}
	});

	// ── Plugin discovery ───────────────────────────────────────────────────

	it("listAvailablePlugins → returns catalog entries", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const plugins = await ctx.manager.listAvailablePlugins();
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("hello-plugin");
	});

	it("listAvailablePlugins(marketplace) → filtered to that marketplace", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const plugins = await ctx.manager.listAvailablePlugins("test-marketplace");
		expect(plugins).toHaveLength(1);
		expect(plugins[0].name).toBe("hello-plugin");
	});

	it("listAvailablePlugins(unknown) → throws", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await expect(ctx.manager.listAvailablePlugins("no-such")).rejects.toThrow(/not found/);
	});

	// ── Install ────────────────────────────────────────────────────────────

	it("installPlugin → plugin in cache + in registry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		expect(instEntry.scope).toBe("user");
		expect(fs.existsSync(instEntry.installPath)).toBe(true);
		const linkPath = path.join(ctx.tmpDir, "node_modules", "hello-plugin");
		expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(instEntry.installPath));

		const runtimeConfig = await Bun.file(path.join(ctx.tmpDir, "omp-plugins.lock.json")).json();
		expect(runtimeConfig.plugins["hello-plugin"]).toEqual({
			version: "1.0.0",
			enabledFeatures: null,
			enabled: true,
		});

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(1);
		expect(installed[0].id).toBe("hello-plugin@test-marketplace");
	});

	it("installPlugin rejects package names that escape node_modules", async () => {
		const marketplaceDir = path.join(ctx.tmpDir, "bad-package-marketplace");
		const pluginDir = path.join(marketplaceDir, "plugins", "bad-package");
		fs.mkdirSync(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		fs.mkdirSync(pluginDir, { recursive: true });
		await Bun.write(
			path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
			`${JSON.stringify(
				{
					name: "bad-package-marketplace",
					owner: { name: "Test Author" },
					plugins: [{ name: "bad-package", source: "./plugins/bad-package", version: "1.0.0" }],
				},
				null,
				2,
			)}\n`,
		);
		await Bun.write(path.join(pluginDir, "package.json"), `${JSON.stringify({ name: "../outside" })}\n`);
		await Bun.write(path.join(ctx.tmpDir, "outside"), "sentinel\n");

		await ctx.manager.addMarketplace(marketplaceDir);
		await expect(ctx.manager.installPlugin("bad-package", "bad-package-marketplace")).rejects.toThrow(
			/Invalid marketplace plugin package name/,
		);

		expect(await Bun.file(path.join(ctx.tmpDir, "outside")).text()).toBe("sentinel\n");
		expect(fs.existsSync(path.join(ctx.tmpDir, "node_modules"))).toBe(false);
		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(0);
	});

	it("installPlugin exposes marketplace package to the runtime loader", async () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-home-"));
		try {
			const pluginsDir = path.join(tmpHome, ".omp", "plugins");
			const manager = new MarketplaceManager({
				marketplacesRegistryPath: path.join(tmpHome, ".omp", "marketplaces.json"),
				installedRegistryPath: path.join(pluginsDir, "installed_plugins.json"),
				marketplacesCacheDir: path.join(pluginsDir, "cache", "marketplaces"),
				pluginsCacheDir: path.join(pluginsDir, "cache", "plugins"),
			});

			await manager.addMarketplace(FIXTURE_DIR);
			await manager.installPlugin("hello-plugin", "test-marketplace");

			const enabled = await getEnabledPlugins(ctx.tmpDir, { home: tmpHome });
			expect(enabled.map(plugin => plugin.name)).toEqual(["hello-plugin"]);
			expect(enabled[0].path).toBe(path.join(pluginsDir, "node_modules", "hello-plugin"));
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("installPlugin keeps marketplace packages out of the npm plugin list", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		const spies = mockPluginManagerPaths(ctx.tmpDir);
		try {
			const plugins = await new PluginManager(ctx.tmpDir).list();
			expect(plugins.map(plugin => plugin.name)).toEqual([]);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("hides legacy marketplace entries that pre-date the scope field", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		const registryPath = path.join(ctx.tmpDir, "installed_plugins.json");
		const registry = (await Bun.file(registryPath).json()) as {
			version: number;
			plugins: Record<string, Array<Record<string, unknown>>>;
		};
		for (const entries of Object.values(registry.plugins)) {
			for (const entry of entries) {
				delete entry.scope;
			}
		}
		await Bun.write(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

		const spies = mockPluginManagerPaths(ctx.tmpDir);
		try {
			const manager = new PluginManager(ctx.tmpDir);
			const plugins = await manager.list();
			const checks = await manager.doctor();

			expect(plugins.map(plugin => plugin.name)).toEqual([]);
			expect(checks.filter(check => check.name.includes("hello-plugin"))).toEqual([]);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("installPlugin keeps same-name local runtime links visible", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		const localPlugin = path.join(ctx.tmpDir, "local-dev-plugin");
		await Bun.write(
			path.join(localPlugin, "package.json"),
			`${JSON.stringify({
				name: "hello-plugin",
				version: "9.9.9",
				omp: { tools: "tools" },
			})}\n`,
		);
		fs.mkdirSync(path.join(localPlugin, "tools"), { recursive: true });
		const linkPath = path.join(ctx.tmpDir, "node_modules", "hello-plugin");
		fs.rmSync(linkPath, { recursive: true, force: true });
		fs.symlinkSync(localPlugin, linkPath, "dir");

		const spies = mockPluginManagerPaths(ctx.tmpDir);
		try {
			const manager = new PluginManager(ctx.tmpDir);
			const plugins = await manager.list();
			const checks = await manager.doctor();

			expect(plugins.map(plugin => `${plugin.name}@${plugin.version}`)).toEqual(["hello-plugin@9.9.9"]);
			expect(checks).toContainEqual({
				name: "plugin:hello-plugin",
				status: "ok",
				message: "v9.9.9",
			});
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("installPlugin keeps marketplace packages out of OMP extension roots", async () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-home-"));
		try {
			const pluginsDir = path.join(tmpHome, ".omp", "plugins");
			const manager = new MarketplaceManager({
				marketplacesRegistryPath: path.join(tmpHome, ".omp", "marketplaces.json"),
				installedRegistryPath: path.join(pluginsDir, "installed_plugins.json"),
				marketplacesCacheDir: path.join(pluginsDir, "cache", "marketplaces"),
				pluginsCacheDir: path.join(pluginsDir, "cache", "plugins"),
			});

			await manager.addMarketplace(FIXTURE_DIR);
			await manager.installPlugin("hello-plugin", "test-marketplace");

			const roots = await listOmpExtensionRoots({ cwd: tmpHome, home: tmpHome, repoRoot: null });
			expect(roots.map(root => root.name)).toEqual([]);
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
		}
	});

	it("installPlugin with scope:project exposes the marketplace package to the runtime loader", async () => {
		const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-home-"));
		const projectAnchor = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-project-"));
		try {
			const userPluginsDir = path.join(tmpHome, ".omp", "plugins");
			const projectPluginsDir = path.join(projectAnchor, ".omp", "plugins");
			fs.mkdirSync(projectPluginsDir, { recursive: true });
			const manager = new MarketplaceManager({
				marketplacesRegistryPath: path.join(tmpHome, ".omp", "marketplaces.json"),
				installedRegistryPath: path.join(userPluginsDir, "installed_plugins.json"),
				projectInstalledRegistryPath: path.join(projectPluginsDir, "installed_plugins.json"),
				marketplacesCacheDir: path.join(userPluginsDir, "cache", "marketplaces"),
				pluginsCacheDir: path.join(userPluginsDir, "cache", "plugins"),
			});

			await manager.addMarketplace(FIXTURE_DIR);
			await manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

			// Project-scope install must surface via the runtime loader when cwd is inside the anchor.
			const enabled = await getEnabledPlugins(projectAnchor, { home: tmpHome });
			expect(enabled.map(plugin => plugin.name)).toEqual(["hello-plugin"]);
			expect(enabled[0].path).toBe(path.join(projectPluginsDir, "node_modules", "hello-plugin"));

			// The runtime symlink and lockfile must live under the project plugins root.
			const projectLink = path.join(projectPluginsDir, "node_modules", "hello-plugin");
			expect(fs.realpathSync(projectLink)).toBe(
				fs.realpathSync(path.join(userPluginsDir, "cache", "plugins", "test-marketplace___hello-plugin___1.0.0")),
			);
			const projectLock = await Bun.file(path.join(projectPluginsDir, "omp-plugins.lock.json")).json();
			expect(projectLock.plugins["hello-plugin"]).toEqual({
				version: "1.0.0",
				enabledFeatures: null,
				enabled: true,
			});

			// User-scope tree stays untouched.
			expect(fs.existsSync(path.join(userPluginsDir, "node_modules", "hello-plugin"))).toBe(false);
			expect(fs.existsSync(path.join(userPluginsDir, "omp-plugins.lock.json"))).toBe(false);
		} finally {
			fs.rmSync(tmpHome, { recursive: true, force: true });
			fs.rmSync(projectAnchor, { recursive: true, force: true });
		}
	});

	it("installPlugin embeds config-only marketplace LSP metadata", async () => {
		const marketplaceDir = path.join(ctx.tmpDir, "config-only-marketplace");
		const pluginDir = path.join(marketplaceDir, "plugins", "csharp-lsp");
		await fs.promises.mkdir(pluginDir, { recursive: true });
		await Bun.write(path.join(pluginDir, "README.md"), "config-only C# LSP plugin\n");
		await fs.promises.mkdir(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		await Bun.write(
			path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
			`${JSON.stringify(
				{
					name: "config-only-marketplace",
					owner: { name: "Test Author" },
					plugins: [
						{
							name: "csharp-lsp",
							source: "./plugins/csharp-lsp",
							version: "1.0.0",
							lspServers: {
								"csharp-ls": {
									command: "csharp-ls",
									extensionToLanguage: { ".cs": "csharp" },
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		await ctx.manager.addMarketplace(marketplaceDir);
		const instEntry = await ctx.manager.installPlugin("csharp-lsp", "config-only-marketplace");

		const lspConfig = await Bun.file(path.join(instEntry.installPath, ".lsp.json")).json();
		expect(lspConfig).toEqual({
			servers: {
				"csharp-ls": {
					command: "csharp-ls",
					extensionToLanguage: { ".cs": "csharp" },
				},
			},
		});

		const spies = mockPluginManagerPaths(ctx.tmpDir);
		try {
			const manager = new PluginManager(ctx.tmpDir);
			const plugins = await manager.list();
			const checks = await manager.doctor();

			expect(plugins.map(plugin => plugin.name)).toEqual([]);
			expect(checks.filter(check => check.name.includes("csharp-lsp"))).toEqual([]);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("installPlugin embeds config-only marketplace DAP metadata", async () => {
		const marketplaceDir = path.join(ctx.tmpDir, "config-only-dap-marketplace");
		const pluginDir = path.join(marketplaceDir, "plugins", "ruby-dap");
		await fs.promises.mkdir(pluginDir, { recursive: true });
		await Bun.write(path.join(pluginDir, "README.md"), "config-only Ruby DAP plugin\n");
		await fs.promises.mkdir(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		await Bun.write(
			path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
			`${JSON.stringify(
				{
					name: "config-only-dap-marketplace",
					owner: { name: "Test Author" },
					plugins: [
						{
							name: "ruby-dap",
							source: "./plugins/ruby-dap",
							version: "1.0.0",
							dapAdapters: {
								"ruby-debug": {
									command: "ruby-debug-adapter",
									fileTypes: [".rb"],
								},
							},
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		await ctx.manager.addMarketplace(marketplaceDir);
		const instEntry = await ctx.manager.installPlugin("ruby-dap", "config-only-dap-marketplace");

		const dapConfig = await Bun.file(path.join(instEntry.installPath, ".dap.json")).json();
		expect(dapConfig).toEqual({
			adapters: {
				"ruby-debug": {
					command: "ruby-debug-adapter",
					fileTypes: [".rb"],
				},
			},
		});
	});

	it("installPlugin preserves YAML extension when embedding DAP metadata files", async () => {
		const marketplaceDir = path.join(ctx.tmpDir, "yaml-dap-marketplace");
		const pluginDir = path.join(marketplaceDir, "plugins", "ruby-dap-yaml");
		await fs.promises.mkdir(pluginDir, { recursive: true });
		await Bun.write(
			path.join(pluginDir, "dap.yaml"),
			["adapters:", "  ruby-debug:", "    command: ruby-debug-adapter", "    fileTypes:", "      - .rb", ""].join(
				"\n",
			),
		);
		await fs.promises.mkdir(path.join(marketplaceDir, ".claude-plugin"), { recursive: true });
		await Bun.write(
			path.join(marketplaceDir, ".claude-plugin", "marketplace.json"),
			`${JSON.stringify(
				{
					name: "yaml-dap-marketplace",
					owner: { name: "Test Author" },
					plugins: [
						{
							name: "ruby-dap-yaml",
							source: "./plugins/ruby-dap-yaml",
							version: "1.0.0",
							dapAdapters: "dap.yaml",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		await ctx.manager.addMarketplace(marketplaceDir);
		const instEntry = await ctx.manager.installPlugin("ruby-dap-yaml", "yaml-dap-marketplace");

		expect(fs.existsSync(path.join(instEntry.installPath, ".dap.yaml"))).toBe(true);
		expect(fs.existsSync(path.join(instEntry.installPath, ".dap.json"))).toBe(false);
		expect(await Bun.file(path.join(instEntry.installPath, ".dap.yaml")).text()).toContain("ruby-debug-adapter");
	});

	it("installPlugin with scope:project → persisted in project registry, isolated from user", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", {
			scope: "project",
		});
		expect(instEntry.scope).toBe("project");
		expect(fs.existsSync(instEntry.installPath)).toBe(true);

		// Persisted to the project registry with project scope — and absent from the user registry.
		const projectReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "project_installed_plugins.json"));
		expect(projectReg.plugins["hello-plugin@test-marketplace"]?.[0].scope).toBe("project");
		const userReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(userReg.plugins["hello-plugin@test-marketplace"]).toBeUndefined();
	});

	it("installPlugin already installed → throws without force", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		await expect(ctx.manager.installPlugin("hello-plugin", "test-marketplace")).rejects.toThrow(/already installed/);
	});

	it("installPlugin with force:true → replaces existing", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const first = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		await ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", false);
		const second = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", {
			force: true,
		});

		expect(second.installPath).toBe(first.installPath);
		expect(fs.existsSync(second.installPath)).toBe(true);

		const runtimeConfig = await Bun.file(path.join(ctx.tmpDir, "omp-plugins.lock.json")).json();
		expect(runtimeConfig.plugins["hello-plugin"].enabled).toBe(false);

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(1);
	});

	it("installPlugin with nonexistent marketplace → clear error", async () => {
		await expect(ctx.manager.installPlugin("hello-plugin", "no-such-market")).rejects.toThrow(
			/Marketplace "no-such-market" not found/,
		);
	});

	it("installPlugin with nonexistent plugin in catalog → clear error", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await expect(ctx.manager.installPlugin("ghost-plugin", "test-marketplace")).rejects.toThrow(
			/Plugin "ghost-plugin" not found in marketplace "test-marketplace"/,
		);
	});

	// ── Uninstall ──────────────────────────────────────────────────────────

	it("uninstallPlugin → cache removed + deregistered", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace");

		expect(fs.existsSync(instEntry.installPath)).toBe(false);
		expect(fs.existsSync(path.join(ctx.tmpDir, "node_modules", "hello-plugin"))).toBe(false);

		const runtimeConfig = await Bun.file(path.join(ctx.tmpDir, "omp-plugins.lock.json")).json();
		expect(runtimeConfig.plugins["hello-plugin"]).toBeUndefined();

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed).toHaveLength(0);
	});

	it("uninstallPlugin nonexistent → throws", async () => {
		await expect(ctx.manager.uninstallPlugin("ghost-plugin@nowhere")).rejects.toThrow(/not installed/);
	});

	it("uninstallPlugin with invalid ID format → throws clear error", async () => {
		await expect(ctx.manager.uninstallPlugin("no-at-sign")).rejects.toThrow(/Invalid plugin ID format/);
	});

	// ── setPluginEnabled ───────────────────────────────────────────────────

	it("setPluginEnabled → persisted in registry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

		await ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", false);

		const installed = await ctx.manager.listInstalledPlugins();
		expect(installed[0].entries[0].enabled).toBe(false);
		let runtimeConfig = await Bun.file(path.join(ctx.tmpDir, "omp-plugins.lock.json")).json();
		expect(runtimeConfig.plugins["hello-plugin"].enabled).toBe(false);

		await ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", true);
		const updated = await ctx.manager.listInstalledPlugins();
		runtimeConfig = await Bun.file(path.join(ctx.tmpDir, "omp-plugins.lock.json")).json();
		expect(runtimeConfig.plugins["hello-plugin"].enabled).toBe(true);
		expect(updated[0].entries[0].enabled).toBe(true);
	});

	it("setPluginEnabled on nonexistent plugin → throws", async () => {
		await expect(ctx.manager.setPluginEnabled("ghost@nowhere", true)).rejects.toThrow(/not installed/);
	});

	// ── version fallback ───────────────────────────────────────────────────

	it("installPlugin falls back to plugin.json version when catalog version is missing", async () => {
		// Write a catalog without a version field on the plugin
		await ctx.manager.addMarketplace(FIXTURE_DIR);

		// Mutate the cached catalog to remove version
		const list = await ctx.manager.listMarketplaces();
		const catalogPath = list[0].catalogPath;
		const content = await Bun.file(catalogPath).text();
		const catalog = JSON.parse(content) as {
			plugins: Array<Record<string, unknown>>;
		};
		catalog.plugins[0] = { ...catalog.plugins[0] };
		delete catalog.plugins[0].version;
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const instEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
		// No catalog version, but fixture's .claude-plugin/plugin.json has version "1.0.0"
		expect(instEntry.version).toBe("1.0.0");
	});
	// ── Scope feature ────────────────────────────────────────────────────────

	it("installPlugin scope:project when no projectInstalledRegistryPath → throws", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mgr-noproj-"));
		try {
			const noProjectManager = new MarketplaceManager({
				marketplacesRegistryPath: path.join(tmp, "marketplaces.json"),
				installedRegistryPath: path.join(tmp, "installed_plugins.json"),
				marketplacesCacheDir: path.join(tmp, "cache", "marketplaces"),
				pluginsCacheDir: path.join(tmp, "cache", "plugins"),
			});
			await noProjectManager.addMarketplace(FIXTURE_DIR);
			await expect(
				noProjectManager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" }),
			).rejects.toThrow(/project directory/);
		} finally {
			removeSyncWithRetries(tmp);
		}
	});

	it("plugin in both scopes, no scope arg → uninstall/setPluginEnabled/upgrade all throw disambiguation", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		// Each mutating op refuses an ambiguous (both-scope) target before touching any state,
		// so the three assertions share one setup without interfering.
		await expect(ctx.manager.uninstallPlugin("hello-plugin@test-marketplace")).rejects.toThrow(
			/both user and project scope/,
		);
		await expect(ctx.manager.setPluginEnabled("hello-plugin@test-marketplace", false)).rejects.toThrow(
			/both user and project scope/,
		);
		await expect(ctx.manager.upgradePlugin("hello-plugin@test-marketplace")).rejects.toThrow(
			/both user and project scope/,
		);
	});

	it("uninstallPlugin dryRun preserves ambiguity checks and both scoped entries", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await expect(
			ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", undefined, { dryRun: true }),
		).rejects.toThrow(/both user and project scope/);
		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", "user", { dryRun: true });

		const userReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		const projectReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "project_installed_plugins.json"));
		expect(userReg.plugins["hello-plugin@test-marketplace"]).toBeDefined();
		expect(projectReg.plugins["hello-plugin@test-marketplace"]).toBeDefined();
	});

	it("uninstallPlugin dryRun rejects a scope where the plugin is not installed", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await expect(
			ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", "user", { dryRun: true }),
		).rejects.toThrow(/not installed in user scope/);

		const projectReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "project_installed_plugins.json"));
		expect(projectReg.plugins["hello-plugin@test-marketplace"]).toBeDefined();
	});

	it("uninstallPlugin scope:user removes only user entry, keeps project entry", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", "user");

		const userReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "installed_plugins.json"));
		expect(userReg.plugins["hello-plugin@test-marketplace"]).toBeUndefined();

		const projectReg = await readInstalledPluginsRegistry(path.join(ctx.tmpDir, "project_installed_plugins.json"));
		expect(projectReg.plugins["hello-plugin@test-marketplace"]).toBeDefined();
		expect(projectReg.plugins["hello-plugin@test-marketplace"]![0].scope).toBe("project");
	});

	it("uninstallPlugin does not delete cache dir when other scope still references it", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		const userEntry = await ctx.manager.installPlugin("hello-plugin", "test-marketplace", {
			scope: "user",
		});
		// Same plugin+version → same cache path for the project-scope install.
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		await ctx.manager.uninstallPlugin("hello-plugin@test-marketplace", "user");

		// Cache must still exist — project scope still references it.
		expect(fs.existsSync(userEntry.installPath)).toBe(true);
	});

	it("listInstalledPlugins marks user entry as shadowed when project entry exists for same ID", async () => {
		await ctx.manager.addMarketplace(FIXTURE_DIR);
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
		await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });

		const installed = await ctx.manager.listInstalledPlugins();
		const userSummary = installed.find(p => p.id === "hello-plugin@test-marketplace" && p.scope === "user");
		expect(userSummary).toBeDefined();
		expect(userSummary!.shadowedBy).toBe("project");
	});

	// ── auto-update ──────────────────────────────────────────────────────────

	describe("auto-update", () => {
		// Read catalogPath from the (single) registered marketplace.
		async function getCatalogPath(): Promise<string> {
			const list = await ctx.manager.listMarketplaces();
			return list[0].catalogPath;
		}

		// Overwrite the version field on the first plugin entry in the cached catalog.
		async function bumpCatalogVersion(newVersion: string): Promise<void> {
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<Record<string, unknown>> };
			catalog.plugins[0] = { ...catalog.plugins[0], version: newVersion };
			await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
		}

		// Directly patch updatedAt in the marketplaces registry file.
		function setMarketplaceUpdatedAt(iso: string): void {
			const regPath = path.join(ctx.tmpDir, "marketplaces.json");
			const reg = JSON.parse(fs.readFileSync(regPath, "utf-8")) as {
				version: number;
				marketplaces: Array<{ updatedAt: string }>;
			};
			reg.marketplaces[0].updatedAt = iso;
			fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
		}

		it("checkForUpdates returns outdated plugins", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			await bumpCatalogVersion("2.0.0");

			const updates = await ctx.manager.checkForUpdates();

			expect(updates).toHaveLength(1);
			expect(updates[0]).toEqual({
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				from: "1.0.0",
				to: "2.0.0",
			});
		});

		it("checkForUpdates returns empty when up to date", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			// Catalog and installed version are both 1.0.0 — nothing to report.

			const updates = await ctx.manager.checkForUpdates();
			expect(updates).toEqual([]);
		});

		it("checkForUpdates skips plugins with no catalog version", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

			// Strip the version field from the cached catalog entry.
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<Record<string, unknown>> };
			delete catalog.plugins[0].version;
			await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

			const updates = await ctx.manager.checkForUpdates();
			expect(updates).toEqual([]);
		});

		it("checkForUpdates handles missing catalog gracefully", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

			// Delete the cached catalog file; checkForUpdates must skip rather than throw.
			const catalogPath = await getCatalogPath();
			fs.unlinkSync(catalogPath);

			const updates = await ctx.manager.checkForUpdates();
			expect(updates).toEqual([]);
		});

		it("upgradePlugin updates the installed version", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			await bumpCatalogVersion("2.0.0");

			const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace");
			expect(entry.version).toBe("2.0.0");

			// Confirm the registry reflects the new version.
			const installed = await ctx.manager.listInstalledPlugins();
			expect(installed).toHaveLength(1);
			expect(installed[0].entries[0].version).toBe("2.0.0");
		});

		it("upgradePlugin rejects invalid plugin ID", async () => {
			await expect(ctx.manager.upgradePlugin("no-at-sign")).rejects.toThrow(/Invalid plugin ID/);
		});

		it("upgradePlugin preserves the scope of the existing install", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });
			await bumpCatalogVersion("2.0.0");

			const entry = await ctx.manager.upgradePlugin("hello-plugin@test-marketplace");
			expect(entry.scope).toBe("project");
			expect(entry.version).toBe("2.0.0");
		});

		it("upgradeAllPlugins upgrades outdated plugins and returns results", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");

			// Inject a second plugin that has no catalog entry — checkForUpdates will skip it,
			// proving upgradeAllPlugins only acts on genuinely outdated plugins.
			const instRegPath = path.join(ctx.tmpDir, "installed_plugins.json");
			const reg = JSON.parse(fs.readFileSync(instRegPath, "utf-8")) as {
				version: number;
				plugins: Record<string, unknown[]>;
			};
			const now = new Date().toISOString();
			reg.plugins["phantom-plugin@test-marketplace"] = [
				{ scope: "user", installPath: "/nonexistent", version: "1.0.0", installedAt: now, lastUpdated: now },
			];
			fs.writeFileSync(instRegPath, JSON.stringify(reg, null, 2));

			// Only hello-plugin gets a version bump in the catalog.
			await bumpCatalogVersion("2.0.0");

			const results = await ctx.manager.upgradeAllPlugins();

			expect(results).toHaveLength(1);
			expect(results[0]).toEqual({
				pluginId: "hello-plugin@test-marketplace",
				scope: "user",
				from: "1.0.0",
				to: "2.0.0",
			});
		});

		it("upgradeAllPlugins returns empty array when all plugins are up to date", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace");
			// No catalog modification — installed and catalog both at 1.0.0.

			const results = await ctx.manager.upgradeAllPlugins();
			expect(results).toEqual([]);
		});

		it("refreshStaleMarketplaces skips fresh marketplaces", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			// updatedAt is just now — not past the 24-hour threshold.
			await bumpCatalogVersion("2.0.0");

			await ctx.manager.refreshStaleMarketplaces();

			// Catalog should remain at 2.0.0 — the marketplace was not re-fetched.
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<{ version?: string }> };
			expect(catalog.plugins[0].version).toBe("2.0.0");
		});

		it("refreshStaleMarketplaces re-fetches stale marketplaces", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			// Tamper with catalog to simulate drift from the real source.
			await bumpCatalogVersion("2.0.0");

			// Force updatedAt to 25 hours ago — past the 24-hour staleness threshold.
			const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
			setMarketplaceUpdatedAt(staleDate);

			await ctx.manager.refreshStaleMarketplaces();

			// updateMarketplace re-fetches from FIXTURE_DIR which has version 1.0.0.
			const catalogPath = await getCatalogPath();
			const content = await Bun.file(catalogPath).text();
			const catalog = JSON.parse(content) as { plugins: Array<{ version?: string }> };
			expect(catalog.plugins[0].version).toBe("1.0.0");
		});

		it("upgradePluginAcrossScopes upgrades in all scopes, returns both entries", async () => {
			await ctx.manager.addMarketplace(FIXTURE_DIR);
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "user" });
			await ctx.manager.installPlugin("hello-plugin", "test-marketplace", { scope: "project" });
			await bumpCatalogVersion("2.0.0");

			const entries = await ctx.manager.upgradePluginAcrossScopes("hello-plugin@test-marketplace");

			expect(entries).toHaveLength(2);
			const scopes = entries.map(e => e.scope).sort();
			expect(scopes).toEqual(["project", "user"]);
			for (const entry of entries) {
				expect(entry.version).toBe("2.0.0");
			}
		});
	});
});
