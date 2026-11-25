/**
 * G7: plugin discovery must not trust project plugin config a sandboxed command created or replaced
 * (a path in the sandbox-created ledger): the project plugin root, the project installed-plugins
 * registry (and the installs it names), and `.claude/settings*.json` `enabledPlugins`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as capabilityFs from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearClaudePluginRootsCache, listClaudePluginRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { recordSandboxCreated } from "@oh-my-pi/pi-coding-agent/sandbox/ledger";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

let root: string;
let home: string;
let project: string;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function ledger(target: string): void {
	recordSandboxCreated([{ path: target, real: target, workspace: project, at: Date.now() }]);
}

const registryEntry = (installPath: string) => ({
	scope: "project",
	installPath,
	version: "1.0.0",
	installedAt: "2025-01-01T00:00:00Z",
	lastUpdated: "2025-01-01T00:00:00Z",
});

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-plugin-ledger-")));
	home = path.join(root, "home");
	project = path.join(root, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	// The ledger lives in the agent dir; an empty one per test starts nothing ledgered.
	setAgentDir(path.join(root, "agent"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
	clearClaudePluginRootsCache();
	capabilityFs.clearCache();
});

afterEach(() => {
	clearClaudePluginRootsCache();
	capabilityFs.clearCache();
	vi.restoreAllMocks();
	__resetDirsFromEnvForTests();
	removeSyncWithRetries(root);
});

describe("getEnabledPlugins", () => {
	function plantProjectPlugin(): string {
		const pluginsDir = path.join(project, ".omp", "plugins");
		writeJson(path.join(pluginsDir, "installed_plugins.json"), { version: 2, plugins: {} });
		writeJson(path.join(pluginsDir, "package.json"), { dependencies: { "evil-plugin": "1.0.0" } });
		writeJson(path.join(pluginsDir, "node_modules", "evil-plugin", "package.json"), {
			name: "evil-plugin",
			version: "1.0.0",
			omp: { extensions: ["ext.ts"] },
		});
		return pluginsDir;
	}

	test("loads a project plugin root that is not ledgered", async () => {
		plantProjectPlugin();
		const plugins = await getEnabledPlugins(project, { home });
		expect(plugins.map(plugin => [plugin.name, plugin.scope])).toEqual([["evil-plugin", "project"]]);
	});

	test("ignores a ledgered project plugin root, and a ledger entry added after a cached load takes effect", async () => {
		const pluginsDir = plantProjectPlugin();
		expect((await getEnabledPlugins(project, { home })).map(plugin => plugin.name)).toEqual(["evil-plugin"]);

		ledger(pluginsDir);
		expect(await getEnabledPlugins(project, { home })).toEqual([]);
	});

	test("ignores a project plugin root whose registry file alone is ledgered", async () => {
		const pluginsDir = plantProjectPlugin();
		ledger(path.join(pluginsDir, "installed_plugins.json"));
		expect(await getEnabledPlugins(project, { home })).toEqual([]);
	});

	test("ignores one ledgered plugin and keeps its trusted sibling", async () => {
		const pluginsDir = plantProjectPlugin();
		writeJson(path.join(pluginsDir, "package.json"), {
			dependencies: { "evil-plugin": "1.0.0", "good-plugin": "1.0.0" },
		});
		writeJson(path.join(pluginsDir, "node_modules", "good-plugin", "package.json"), {
			name: "good-plugin",
			version: "1.0.0",
			omp: { extensions: ["ext.ts"] },
		});
		ledger(path.join(pluginsDir, "node_modules", "evil-plugin"));
		expect((await getEnabledPlugins(project, { home })).map(plugin => plugin.name)).toEqual(["good-plugin"]);
	});
});

describe("listClaudePluginRoots", () => {
	function plantProjectRegistry(...installs: Array<[id: string, installPath: string]>): string {
		const registry = path.join(project, ".omp", "plugins", "installed_plugins.json");
		writeJson(registry, {
			version: 2,
			plugins: Object.fromEntries(installs.map(([id, installPath]) => [id, [registryEntry(installPath)]])),
		});
		return registry;
	}

	test("loads a project registry that is not ledgered", async () => {
		plantProjectRegistry(["evil@market", path.join(root, "evil-plugin")]);
		const { roots } = await listClaudePluginRoots(home, project);
		expect(roots.map(r => r.id)).toEqual(["evil@market"]);
	});

	test("ignores a ledgered project registry, and a ledger entry added after a cached read takes effect", async () => {
		const registry = plantProjectRegistry(["evil@market", path.join(root, "evil-plugin")]);
		expect((await listClaudePluginRoots(home, project)).roots.map(r => r.id)).toEqual(["evil@market"]);

		ledger(registry);
		expect((await listClaudePluginRoots(home, project)).roots).toEqual([]);
	});

	test("ignores a ledgered .omp directory holding the project registry", async () => {
		plantProjectRegistry(["evil@market", path.join(root, "evil-plugin")]);
		ledger(path.join(project, ".omp"));
		expect((await listClaudePluginRoots(home, project)).roots).toEqual([]);
	});

	test("skips only the project-registry entry whose installPath is ledgered", async () => {
		const evil = path.join(project, "vendor", "evil-plugin");
		plantProjectRegistry(["evil@market", evil], ["fine@market", path.join(root, "fine-plugin")]);
		ledger(path.join(project, "vendor"));
		expect((await listClaudePluginRoots(home, project)).roots.map(r => r.id)).toEqual(["fine@market"]);
	});

	test("a path ledgered while the enumeration reads settings is not served from the cache afterwards", async () => {
		const registry = plantProjectRegistry(["evil@market", path.join(root, "evil-plugin")]);
		const realReadFile = capabilityFs.readFile;
		let ledgered = false;
		// Another discovery path ledgers the registry between this enumeration's ledger read and its
		// cache key: here, while it reads the first Claude settings file.
		vi.spyOn(capabilityFs, "readFile").mockImplementation(async file => {
			if (!ledgered && path.basename(file) === "settings.json") {
				ledgered = true;
				ledger(registry);
			}
			return realReadFile(file);
		});
		await listClaudePluginRoots(home, project);
		expect(ledgered).toBe(true);
		expect((await listClaudePluginRoots(home, project)).roots).toEqual([]);
	});

	describe("enabledPlugins in project settings", () => {
		function plantMutedUserPlugin(): string {
			writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
				version: 2,
				plugins: { "muted@market": [{ ...registryEntry("/plugins/muted"), scope: "user" }] },
			});
			const settings = path.join(project, ".claude", "settings.json");
			writeJson(settings, { enabledPlugins: { "muted@market": false } });
			return settings;
		}

		test("honours project settings that are not ledgered", async () => {
			plantMutedUserPlugin();
			expect((await listClaudePluginRoots(home, project)).roots).toEqual([]);
		});

		test("ignores ledgered project settings, and a ledger entry added after a cached read takes effect", async () => {
			const settings = plantMutedUserPlugin();
			expect((await listClaudePluginRoots(home, project)).roots).toEqual([]);

			ledger(settings);
			expect((await listClaudePluginRoots(home, project)).roots.map(r => r.id)).toEqual(["muted@market"]);
		});

		test("ignores ledgered settings.local.json while keeping settings.json", async () => {
			writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
				version: 2,
				plugins: {
					"muted@market": [{ ...registryEntry("/plugins/muted"), scope: "user" }],
					"other@market": [{ ...registryEntry("/plugins/other"), scope: "user" }],
				},
			});
			writeJson(path.join(project, ".claude", "settings.json"), { enabledPlugins: { "muted@market": false } });
			const local = path.join(project, ".claude", "settings.local.json");
			writeJson(local, { enabledPlugins: { "muted@market": true, "other@market": false } });
			ledger(local);
			expect((await listClaudePluginRoots(home, project)).roots.map(r => r.id)).toEqual(["other@market"]);
		});
	});
});
