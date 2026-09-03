import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { disableUserSource, enableProvider, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";

describe("parseClaudePluginsRegistry", () => {
	test("parses valid registry", () => {
		const content = JSON.stringify({
			version: 2,
			plugins: {
				"my-plugin@marketplace": [
					{
						scope: "user",
						installPath: "/path/to/plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		});

		const result = parseClaudePluginsRegistry(content);
		expect(result?.version).toBe(2);
		expect(result?.plugins["my-plugin@marketplace"]).toHaveLength(1);
	});

	test("returns null for invalid JSON", () => {
		expect(parseClaudePluginsRegistry("not json")).toBeNull();
	});

	test("returns null for missing version", () => {
		const content = JSON.stringify({ plugins: {} });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for missing plugins", () => {
		const content = JSON.stringify({ version: 2 });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});

	test("returns null for null plugins", () => {
		const content = JSON.stringify({ version: 2, plugins: null });
		expect(parseClaudePluginsRegistry(content)).toBeNull();
	});
});

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("listClaudePluginRoots", () => {
	let tempDir: string;
	let testAgentDir: string;
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalOmpProfileEnv: string | undefined;
	let originalPiProfileEnv: string | undefined;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
		testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-agent-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		// Point the agent dir at a temp dir so user-scope discovery (native MCP
		// config, skills, etc.) cannot read the real ~/.omp/agent profile.
		setAgentDir(testAgentDir);
		enableProvider("claude-plugins");
		disableUserSource("claude-plugins");
		disableUserSource("claude");
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		// setAgentDir() clears the profile env vars and snapshots the agent dir,
		// so restore every env var it can touch before rebuilding the resolver.
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnvValue("PI_PROFILE", originalPiProfileEnv);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		enableProvider("claude-plugins");
		disableUserSource("claude-plugins");
		disableUserSource("claude");
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempDir);
		await removeWithRetries(testAgentDir);
	});

	test("returns empty roots when no registry file exists", async () => {
		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("parses plugin with user scope", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"test-plugin@test-market": [
					{
						scope: "user",
						installPath: "/path/to/test-plugin",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0]).toEqual({
			id: "test-plugin@test-market",
			marketplace: "test-market",
			plugin: "test-plugin",
			version: "1.0.0",
			path: "/path/to/test-plugin",
			scope: "user",
			origin: "claude",
		});
	});

	test("reads the user plugin registry from CLAUDE_CONFIG_DIR", async () => {
		const relocated = path.join(tempDir, "relocated-claude");
		const pluginsDir = path.join(relocated, "plugins");
		process.env.CLAUDE_CONFIG_DIR = relocated;
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"relocated@market": [
						{
							scope: "user",
							installPath: "/path/to/relocated",
							version: "1.0.0",
						},
					],
				},
			}),
		);

		const result = await listClaudePluginRoots(tempDir);

		expect(result.roots).toEqual([
			{
				id: "relocated@market",
				marketplace: "market",
				plugin: "relocated",
				version: "1.0.0",
				path: "/path/to/relocated",
				scope: "user",
				origin: "claude",
			},
		]);
	});

	test("isolates local and project plugins to their canonical project", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const projectA = path.join(tempDir, "project-a");
		const projectB = path.join(tempDir, "project-b");
		const projectBAlias = path.join(tempDir, "project-b-alias");
		const projectBSubdir = path.join(projectB, "packages", "app");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(projectA, ".git"), { recursive: true }),
			fs.mkdir(path.join(projectB, ".git"), { recursive: true }),
			fs.mkdir(projectBSubdir, { recursive: true }),
		]);
		await fs.symlink(projectB, projectBAlias, "dir");

		const entry = (scope: "user" | "project" | "local", installPath: string, projectPath?: string) => ({
			scope,
			installPath,
			projectPath,
			version: "1.0.0",
			installedAt: "2025-01-01T00:00:00Z",
			lastUpdated: "2025-01-01T00:00:00Z",
		});
		const registry = {
			version: 2,
			plugins: {
				"user-plugin@market": [entry("user", "/plugins/user")],
				"active-local-plugin@market": [entry("local", "/plugins/active-local", projectB)],
				"foreign-local-plugin@market": [entry("local", "/plugins/foreign-local", projectA)],
				"active-project-plugin@market": [entry("project", "/plugins/active-project", projectB)],
				"foreign-project-plugin@market": [entry("project", "/plugins/foreign-project", projectA)],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir, path.join(projectBAlias, "packages", "app"));

		expect(result.roots.map(root => root.id)).toEqual([
			"user-plugin@market",
			"active-local-plugin@market",
			"active-project-plugin@market",
		]);
		expect(result.roots.filter(root => root.id !== "user-plugin@market").map(root => root.scope)).toEqual([
			"project",
			"project",
		]);
	});

	test("hides a plugin the user switched off with enabledPlugins in project settings", async () => {
		// Contract: a plugin Claude Code would not load in this project (enabledPlugins:false in
		// .claude/settings.local.json) must not contribute skills/MCP/commands here either.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const project = path.join(tempDir, "project");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(project, ".claude"), { recursive: true }),
			fs.mkdir(path.join(project, ".git"), { recursive: true }),
		]);
		const entry = (installPath: string) => ({
			scope: "user",
			installPath,
			version: "1.0.0",
			installedAt: "2025-01-01T00:00:00Z",
			lastUpdated: "2025-01-01T00:00:00Z",
		});
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"kept@market": [entry("/plugins/kept")],
					"muted@market": [entry("/plugins/muted")],
					"muted-then-restored@market": [entry("/plugins/restored")],
				},
			}),
		);
		// settings.json turns two off; settings.local.json turns one of them back on (local wins).
		await fs.writeFile(
			path.join(project, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "muted@market": false, "muted-then-restored@market": false } }),
		);
		await fs.writeFile(
			path.join(project, ".claude", "settings.local.json"),
			JSON.stringify({ enabledPlugins: { "muted-then-restored@market": true } }),
		);

		const inProject = await listClaudePluginRoots(tempDir, project);
		expect(inProject.roots.map(root => root.id).sort()).toEqual(["kept@market", "muted-then-restored@market"]);

		// The switch is per project: elsewhere the same user-scope install still loads.
		const elsewhere = path.join(tempDir, "elsewhere");
		await fs.mkdir(path.join(elsewhere, ".git"), { recursive: true });
		const outside = await listClaudePluginRoots(tempDir, elsewhere);
		expect(outside.roots.map(root => root.id).sort()).toEqual([
			"kept@market",
			"muted-then-restored@market",
			"muted@market",
		]);
	});

	test("enabledPlugins:true opts a local-scope install into a project with a different projectPath", async () => {
		// Contract: Claude Code loads a plugin wherever enabledPlugins says true, regardless of
		// which directory the local-scope install was recorded under. Without this, a plugin
		// installed from a parent directory never loads from the child project it is enabled in.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const parent = path.join(tempDir, "clients");
		const child = path.join(parent, "acme");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(child, ".claude"), { recursive: true }),
			fs.mkdir(path.join(child, ".git"), { recursive: true }),
		]);
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"acme@market": [
						{
							scope: "local",
							installPath: "/plugins/acme",
							projectPath: parent,
							version: "1.0.0",
							installedAt: "2025-01-01T00:00:00Z",
							lastUpdated: "2025-01-01T00:00:00Z",
						},
					],
				},
			}),
		);

		const before = await listClaudePluginRoots(tempDir, child);
		expect(before.roots).toEqual([]);

		clearClaudePluginRootsCache();
		clearFsCache();
		await fs.writeFile(
			path.join(child, ".claude", "settings.local.json"),
			JSON.stringify({ enabledPlugins: { "acme@market": true } }),
		);
		const after = await listClaudePluginRoots(tempDir, child);
		expect(after.roots.map(root => root.id)).toEqual(["acme@market"]);
		expect(after.roots[0]?.scope).toBe("project");
	});

	test("handles multiple entries per plugin ID", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"multi-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/v2",
						version: "2.0.0",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
					{
						scope: "project",
						projectPath: tempDir,
						installPath: "/path/to/v1",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir, tempDir);
		// Should return both entries, not just the first one
		expect(result.roots).toHaveLength(2);
		expect(result.roots[0].version).toBe("2.0.0");
		expect(result.roots[0].scope).toBe("user");
		expect(result.roots[1].version).toBe("1.0.0");
		expect(result.roots[1].scope).toBe("project");
	});

	test("warns on invalid plugin ID format", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"invalid-no-at-symbol": [
					{
						scope: "user",
						installPath: "/path/to/invalid",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("Invalid plugin ID format");
	});

	test("warns on entry without installPath", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-path@market": [
					{
						scope: "user",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(0);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("has no installPath");
	});

	test("caches results for same home directory", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry: {
			version: number;
			plugins: Record<
				string,
				Array<{ scope: string; installPath: string; version: string; installedAt: string; lastUpdated: string }>
			>;
		} = {
			version: 2,
			plugins: {
				"cached-plugin@market": [
					{
						scope: "user",
						installPath: "/path/to/cached",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// First call
		const result1 = await listClaudePluginRoots(tempDir);
		expect(result1.roots).toHaveLength(1);

		// Modify the file
		registry.plugins["new-plugin@market"] = [
			{
				scope: "user",
				installPath: "/path/to/new",
				version: "1.0.0",
				installedAt: "2025-01-01T00:00:00Z",
				lastUpdated: "2025-01-01T00:00:00Z",
			},
		];
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		// Second call should return cached result (still 1 plugin)
		const result2 = await listClaudePluginRoots(tempDir);
		expect(result2.roots).toHaveLength(1);

		// After clearing cache, should see new plugin
		clearClaudePluginRootsCache();
		clearFsCache(); // Also clear fs cache so the file is re-read
		const result3 = await listClaudePluginRoots(tempDir);
		expect(result3.roots).toHaveLength(2);
	});

	test("isolates cached OMP plugin roots by home when Claude config is shared", async () => {
		const sharedClaudeConfig = path.join(tempDir, "shared-claude");
		const firstHome = path.join(tempDir, "first-home");
		const secondHome = path.join(tempDir, "second-home");
		process.env.CLAUDE_CONFIG_DIR = sharedClaudeConfig;
		for (const [home, pluginId] of [
			[firstHome, "first@market"],
			[secondHome, "second@market"],
		] as const) {
			const pluginsDir = path.join(home, ".omp", "plugins");
			await fs.mkdir(pluginsDir, { recursive: true });
			await fs.writeFile(
				path.join(pluginsDir, "installed_plugins.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						[pluginId]: [
							{
								scope: "user",
								installPath: `/path/to/${pluginId.split("@")[0]}`,
								version: "1.0.0",
							},
						],
					},
				}),
			);
		}

		const first = await listClaudePluginRoots(firstHome);
		const second = await listClaudePluginRoots(secondHome);

		expect(first.roots.map(root => root.id)).toEqual(["first@market"]);
		expect(second.roots.map(root => root.id)).toEqual(["second@market"]);
	});

	test("loads OMP user skills without opting into foreign Claude skills", async () => {
		const ompPluginPath = path.join(tempDir, "plugins", "omp-owned");
		const claudePluginPath = path.join(tempDir, "plugins", "claude-owned");
		const ompRegistryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
		const claudeRegistryPath = path.join(tempDir, ".claude", "plugins", "installed_plugins.json");
		await Promise.all([
			fs.mkdir(path.join(ompPluginPath, "skills", "omp-demo"), { recursive: true }),
			fs.mkdir(path.join(claudePluginPath, "skills", "claude-demo"), { recursive: true }),
			fs.mkdir(path.dirname(ompRegistryPath), { recursive: true }),
			fs.mkdir(path.dirname(claudeRegistryPath), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(ompPluginPath, "skills", "omp-demo", "SKILL.md"),
				"---\nname: omp-demo\ndescription: OMP skill\n---\nBody\n",
			),
			fs.writeFile(
				path.join(claudePluginPath, "skills", "claude-demo", "SKILL.md"),
				"---\nname: claude-demo\ndescription: Claude skill\n---\nBody\n",
			),
			fs.writeFile(
				ompRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"omp-owned@market": [{ scope: "user", installPath: ompPluginPath, version: "1.0.0" }],
					},
				}),
			),
			fs.writeFile(
				claudeRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"claude-owned@market": [{ scope: "user", installPath: claudePluginPath, version: "1.0.0" }],
					},
				}),
			),
		]);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });

		expect(result.all.find(skill => skill.name === "omp-demo")?._source.provider).toBe("claude-plugins");
		expect(result.all.find(skill => skill.name === "claude-demo")).toBeUndefined();
	});

	test("defaults scope to user when not specified", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"no-scope@market": [
					{
						installPath: "/path/to/no-scope",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("user");
	});
});
