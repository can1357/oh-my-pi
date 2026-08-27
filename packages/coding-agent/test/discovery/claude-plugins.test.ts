import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import type { SlashCommand } from "@oh-my-pi/pi-coding-agent/capability/slash-command";

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
	test("loads rules from OMP marketplace plugins", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "omp-rules");
		await Promise.all([
			fs.mkdir(pluginsDir, { recursive: true }),
			fs.mkdir(path.join(pluginPath, "rules"), { recursive: true }),
		]);
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"omp-rules@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
						},
					],
				},
			}),
		);
		await fs.writeFile(
			path.join(pluginPath, "package.json"),
			JSON.stringify({ name: "omp-rules", omp: { extensions: ["./extension.ts"] } }),
		);
		await fs.writeFile(
			path.join(pluginPath, "rules", "style.md"),
			"---\ndescription: Marketplace style rule\n---\nUse tabs.\n",
		);

		const result = await loadCapability<Rule>("rules", { cwd: tempDir });
		const found = result.all.find(rule => rule.name === "style");

		expect(found?.description).toBe("Marketplace style rule");
		expect(found?._source?.provider).toBe("claude-plugins");
	});
	test("reads skills directory from plugin manifest skills field", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "skills", "manifest-skill"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "./.claude/skills" }),
		);
		await fs.writeFile(
			path.join(pluginPath, ".claude", "skills", "manifest-skill", "SKILL.md"),
			"---\nname: manifest-skill\ndescription: Manifest skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const found = result.all.find(skill => skill.name === "manifest-skill");

		expect(found?.path).toContain(path.join(".claude", "skills", "manifest-skill", "SKILL.md"));
	});
	test("keeps plugin skills out of slash commands while loading them as skills", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "understand-anything");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, "skills", "understand"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"understand-anything@understand-anything": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "2.7.7",
						installedAt: "2026-06-12T00:00:00Z",
						lastUpdated: "2026-06-12T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, "skills", "understand", "SKILL.md"),
			"---\nname: understand\ndescription: Build an understanding graph\n---\nAnalyze the project.\n",
		);

		const commands = await loadSlashCommands({ cwd: tempDir });
		const skills = await loadCapability<Skill>("skills", { cwd: tempDir });

		expect(commands.find(command => command.name === "understand")).toBeUndefined();
		expect(skills.all.find(skill => skill.name === "understand")?.frontmatter?.description).toBe(
			"Build an understanding graph",
		);
	});

	test("expands env placeholders in marketplace plugin MCP url and headers", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "context7");
		const originalApiKey = process.env.OMP_PLUGIN_MCP_API_KEY;
		const originalUrl = process.env.OMP_PLUGIN_MCP_URL;
		const envPlaceholder = (name: string): string => ["$", "{", name, ":-}"].join("");
		process.env.OMP_PLUGIN_MCP_API_KEY = "ctx7sk-test-key";
		process.env.OMP_PLUGIN_MCP_URL = "https://mcp.context7.example";

		try {
			await fs.mkdir(pluginsDir, { recursive: true });
			await fs.mkdir(pluginPath, { recursive: true });
			await fs.writeFile(
				path.join(pluginsDir, "installed_plugins.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						"context7@claude-plugins-official": [
							{
								scope: "user",
								installPath: pluginPath,
								version: "1.0.0",
								installedAt: "2026-06-01T00:00:00Z",
								lastUpdated: "2026-06-01T00:00:00Z",
							},
						],
					},
				}),
			);
			await fs.writeFile(
				path.join(pluginPath, ".mcp.json"),
				JSON.stringify({
					context7: {
						type: "http",
						url: `${envPlaceholder("OMP_PLUGIN_MCP_URL")}/mcp`,
						headers: {
							CONTEXT7_API_KEY: envPlaceholder("OMP_PLUGIN_MCP_API_KEY"),
						},
					},
				}),
			);

			const result = await loadCapability<MCPServer>(mcpCapability.id, {
				cwd: tempDir,
				providers: ["claude-plugins"],
			});
			const server = result.all.find(item => item.name === "context7:context7");

			expect(server?.url).toBe("https://mcp.context7.example/mcp");
			expect(server?.headers).toEqual({ CONTEXT7_API_KEY: "ctx7sk-test-key" });
		} finally {
			if (originalApiKey === undefined) delete process.env.OMP_PLUGIN_MCP_API_KEY;
			else process.env.OMP_PLUGIN_MCP_API_KEY = originalApiKey;
			if (originalUrl === undefined) delete process.env.OMP_PLUGIN_MCP_URL;
			else process.env.OMP_PLUGIN_MCP_URL = originalUrl;
		}
	});

	test("uses OMP then Claude manifest mcpServers paths before .mcp.json", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const ompPluginPath = path.join(tempDir, "plugins", "omp-pointer");
		const claudePluginPath = path.join(tempDir, "plugins", "claude-pointer");
		await fs.mkdir(pluginsDir, { recursive: true });
		await Promise.all([
			fs.mkdir(path.join(ompPluginPath, ".omp-plugin"), { recursive: true }),
			fs.mkdir(path.join(ompPluginPath, ".claude-plugin"), { recursive: true }),
			fs.mkdir(path.join(claudePluginPath, ".claude-plugin"), { recursive: true }),
		]);
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"omp-pointer@market": [
						{
							scope: "user",
							installPath: ompPluginPath,
							version: "1.0.0",
							installedAt: "2026-07-28T00:00:00Z",
							lastUpdated: "2026-07-28T00:00:00Z",
						},
					],
					"claude-pointer@market": [
						{
							scope: "user",
							installPath: claudePluginPath,
							version: "1.0.0",
							installedAt: "2026-07-28T00:00:00Z",
							lastUpdated: "2026-07-28T00:00:00Z",
						},
					],
				},
			}),
		);
		await Promise.all([
			fs.writeFile(
				path.join(ompPluginPath, ".omp-plugin", "plugin.json"),
				JSON.stringify({ mcpServers: "./mcp-omp.json" }),
			),
			fs.writeFile(
				path.join(ompPluginPath, ".claude-plugin", "plugin.json"),
				JSON.stringify({ mcpServers: "./mcp-claude.json" }),
			),
			fs.writeFile(path.join(ompPluginPath, "mcp-omp.json"), JSON.stringify({ "from-omp": { command: "omp" } })),
			fs.writeFile(
				path.join(ompPluginPath, "mcp-claude.json"),
				JSON.stringify({ "from-claude": { command: "claude" } }),
			),
			fs.writeFile(path.join(ompPluginPath, ".mcp.json"), JSON.stringify({ "from-root": { command: "root" } })),
			fs.writeFile(
				path.join(claudePluginPath, ".claude-plugin", "plugin.json"),
				JSON.stringify({ mcpServers: "./mcp-claude.json" }),
			),
			fs.writeFile(
				path.join(claudePluginPath, "mcp-claude.json"),
				JSON.stringify({ "from-claude": { command: "claude" } }),
			),
			fs.writeFile(path.join(claudePluginPath, ".mcp.json"), JSON.stringify({ "from-root": { command: "root" } })),
		]);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});

		expect(result.warnings).toEqual([]);
		expect(result.all.map(server => server.name).sort()).toEqual([
			"claude-pointer:from-claude",
			"omp-pointer:from-omp",
		]);
	});

	test("loads inline manifest mcpServers object and roots relative stdio at plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "inline-mcp");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".omp-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"inline-mcp@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2026-07-28T00:00:00Z",
							lastUpdated: "2026-07-28T00:00:00Z",
						},
					],
				},
			}),
		);
		// Inline object form: the manifest carries the server map directly, and no
		// root .mcp.json exists, so the pre-fix fallback would register nothing.
		await fs.writeFile(
			path.join(pluginPath, ".omp-plugin", "plugin.json"),
			JSON.stringify({ mcpServers: { local: { command: "./bin/server", args: ["run"] } } }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});

		expect(result.warnings).toEqual([]);
		const server = result.all.find(item => item.name === "inline-mcp:local");
		expect(server?.command).toBe(path.join(pluginPath, "bin", "server"));
		expect(server?.args).toEqual(["run"]);
	});

	test("warns when a manifest mcpServers pointer names a missing file", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "broken-pointer");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".omp-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"broken-pointer@market": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2026-07-28T00:00:00Z",
							lastUpdated: "2026-07-28T00:00:00Z",
						},
					],
				},
			}),
		);
		// Pointer names a file the plugin never shipped: discovery must say so
		// instead of silently registering nothing.
		await fs.writeFile(
			path.join(pluginPath, ".omp-plugin", "plugin.json"),
			JSON.stringify({ mcpServers: "./mcp-omp.json" }),
		);
		await fs.writeFile(path.join(pluginPath, ".mcp.json"), JSON.stringify({ "from-root": { command: "root" } }));

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["claude-plugins"],
		});

		expect(result.all.map(server => server.name)).toEqual([]);
		expect(result.warnings).toEqual([
			`[Claude Code Marketplace] [claude-plugins] Missing mcpServers file declared by broken-pointer@market: ${path.join(pluginPath, "mcp-omp.json")}`,
		]);
	});

	test("deduplicates a plugin alias of a directly configured MCP connection", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "context7");
		const directConfigPath = path.join(tempDir, ".omp", "mcp.json");
		const connection = {
			type: "http",
			url: "https://mcp.context7.example/mcp",
			headers: { CONTEXT7_API_KEY: "ctx7sk-test-key" },
		};
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await fs.mkdir(path.dirname(directConfigPath), { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"context7@claude-plugins-official": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2026-06-01T00:00:00Z",
							lastUpdated: "2026-06-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.writeFile(path.join(pluginPath, ".mcp.json"), JSON.stringify({ context7: connection }));
		await fs.writeFile(
			directConfigPath,
			JSON.stringify({
				mcpServers: { context7: connection },
			}),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempDir,
			providers: ["native", "claude-plugins"],
		});

		expect(result.items.map(server => server.name)).toEqual(["context7"]);
		expect(result.items[0]?._source.provider).toBe("native");
		expect(result.all.find(server => server.name === "context7:context7")?._shadowed).toBe(true);
	});

	test("resolves relative path-like command and cwd against the plugin config directory", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "computer-use");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });
		await fs.writeFile(
			path.join(pluginsDir, "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"computer-use@openai-bundled": [
						{
							scope: "user",
							installPath: pluginPath,
							version: "1.0.0",
							installedAt: "2026-06-01T00:00:00Z",
							lastUpdated: "2026-06-01T00:00:00Z",
						},
					],
				},
			}),
		);
		await fs.writeFile(
			path.join(pluginPath, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"computer-use": { command: "./bin/SkyComputerUseClient", args: ["mcp"], cwd: "." },
					bare: { command: "npx", args: ["-y", "@some/mcp"] },
					invalidCwd: { command: "npx", cwd: 1 },
				},
			}),
		);

		// Session cwd is deliberately outside the plugin directory.
		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: path.join(tempDir, "elsewhere"),
			providers: ["claude-plugins"],
		});
		const local = result.all.find(item => item.name === "computer-use:computer-use");
		const bare = result.all.find(item => item.name === "computer-use:bare");
		const invalidCwd = result.all.find(item => item.name === "computer-use:invalidCwd");

		expect(local?.command).toBe(path.join(pluginPath, "bin", "SkyComputerUseClient"));
		expect(local?.cwd).toBe(pluginPath);
		// Bare executables must keep resolving through PATH, not the plugin dir.
		expect(bare?.command).toBe("npx");
		expect(bare?.cwd).toBeUndefined();
		expect(invalidCwd?.command).toBe("npx");
		expect(invalidCwd?.cwd).toBeUndefined();
	});

	test("reads slash commands directory from plugin manifest slash-commands field", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ "slash-commands": "./.claude/commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "ship.md"), "Ship it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const found = result.all.find(command => command.name === "manifest-commands:ship");

		expect(found?.path).toContain(path.join(".claude", "commands", "ship.md"));
	});

	test("reads slash commands directory from plugin manifest commands field (standard Claude plugin format)", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-key");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-key@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: "./.claude/commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "plan.md"), "Plan it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const found = result.all.find(command => command.name === "manifest-commands-key:plan");

		expect(found?.path).toContain(path.join(".claude", "commands", "plan.md"));
	});

	test("commands field takes precedence over slash-commands field when both are present", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-precedence");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		// commands points to .claude/commands, slash-commands points to a different dir
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "legacy-commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-precedence@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: "./.claude/commands", "slash-commands": "./legacy-commands" }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "ship.md"), "Ship it\n");
		// This file exists only under the legacy dir — should NOT be found
		await fs.writeFile(path.join(pluginPath, "legacy-commands", "old.md"), "Old\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const found = result.all.find(command => command.name === "manifest-commands-precedence:ship");
		const notFound = result.all.find(command => command.name === "manifest-commands-precedence:old");

		expect(found).toBeDefined();
		expect(notFound).toBeUndefined();
	});
	test("ignores manifest skills directory that resolves outside plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-outside");
		const outsideDir = path.join(tempDir, "outside-skills", "outside-skill");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-outside@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: "../../outside-skills" }),
		);
		await fs.writeFile(
			path.join(outsideDir, "SKILL.md"),
			"---\nname: outside-skill\ndescription: Outside skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings[0]).toContain("Ignoring skills path outside plugin root");
		const found = result.all.find(skill => skill.name === "outside-skill");

		expect(found).toBeUndefined();
	});

	test("ignores manifest slash commands directory that resolves outside plugin root", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-outside");
		const outsideDir = path.join(tempDir, "outside-commands");
		await fs.mkdir(path.join(pluginsDir), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-outside@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ "slash-commands": "../../outside-commands" }),
		);
		await fs.writeFile(path.join(outsideDir, "ship.md"), "Ship it\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings[0]).toContain("Ignoring slash-commands path outside plugin root");
		const found = result.all.find(command => command.name === "manifest-commands-outside:ship");

		expect(found).toBeUndefined();
	});

	test("reads slash commands from array-form commands manifest field (Claude plugin path-behavior rules)", async () => {
		// Mirrors real-world plugins such as addyosmani/agent-skills whose plugin.json
		// declares `"commands": ["./.claude/commands", "./commands"]`. Both directories
		// contribute; each command lands under the plugin's namespace.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-array");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-array@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: ["./.claude/commands", "./commands"] }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "spec.md"), "Spec\n");
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "plan.md"), "Plan\n");
		await fs.writeFile(path.join(pluginPath, "commands", "review.md"), "Review\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		const names = result.all
			.filter(command => command.name.startsWith("manifest-commands-array:"))
			.map(command => command.name)
			.sort();
		expect(names).toEqual([
			"manifest-commands-array:plan",
			"manifest-commands-array:review",
			"manifest-commands-array:spec",
		]);
	});

	test("reads slash commands from array-form manifest file entries", async () => {
		// Claude plugins reference allows command paths to be either flat `.md`
		// files or directories. A manifest-declared commands field still replaces
		// default `commands/`; plugins that want defaults must list `./commands`.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-files");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "custom"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "ops"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-files@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: ["./custom/deploy.md", "./ops"] }),
		);
		await fs.writeFile(path.join(pluginPath, "custom", "deploy.md"), "Deploy\n");
		await fs.writeFile(path.join(pluginPath, "ops", "rollback.md"), "Rollback\n");
		await fs.writeFile(path.join(pluginPath, "commands", "default.md"), "Default\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.find(c => c.name === "manifest-commands-files:deploy")?.content).toBe("Deploy\n");
		expect(result.all.find(c => c.name === "manifest-commands-files:rollback")?.content).toBe("Rollback\n");
		expect(result.all.find(c => c.name === "manifest-commands-files:default")).toBeUndefined();
	});

	test("array-form commands warns on out-of-root entries while loading valid ones", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-mixed");
		const outsideDir = path.join(tempDir, "outside-commands");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude", "commands"), { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-mixed@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: ["./.claude/commands", "../../outside-commands"] }),
		);
		await fs.writeFile(path.join(pluginPath, ".claude", "commands", "spec.md"), "Spec\n");
		await fs.writeFile(path.join(outsideDir, "escape.md"), "Escape\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings.some(w => w.includes("Ignoring commands path outside plugin root"))).toBe(true);
		expect(result.all.find(c => c.name === "manifest-commands-mixed:spec")).toBeDefined();
		expect(result.all.find(c => c.name === "manifest-commands-mixed:escape")).toBeUndefined();
	});

	test("reads skills from array-form skills manifest field", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-array");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "extra-skills", "alpha"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "more-skills", "beta"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-array@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: ["./extra-skills", "./more-skills"] }),
		);
		await fs.writeFile(
			path.join(pluginPath, "extra-skills", "alpha", "SKILL.md"),
			"---\nname: alpha\ndescription: Alpha skill\n---\nBody\n",
		);
		await fs.writeFile(
			path.join(pluginPath, "more-skills", "beta", "SKILL.md"),
			"---\nname: beta\ndescription: Beta skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.find(s => s.name === "alpha")).toBeDefined();
		expect(result.all.find(s => s.name === "beta")).toBeDefined();
	});

	test("manifest skills field merges with default skills/ directory (adds, not replaces)", async () => {
		// Per Claude plugins reference "Path behavior rules":
		// `skills` adds to the default `skills/` scan; the default is always loaded
		// alongside any manifest-declared directories.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-merge");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "skills", "default-skill"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "extra-skills", "extra-skill"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-merge@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: ["./extra-skills"] }),
		);
		await fs.writeFile(
			path.join(pluginPath, "skills", "default-skill", "SKILL.md"),
			"---\nname: default-skill\ndescription: Default skill\n---\nBody\n",
		);
		await fs.writeFile(
			path.join(pluginPath, "extra-skills", "extra-skill", "SKILL.md"),
			"---\nname: extra-skill\ndescription: Extra skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.find(s => s.name === "default-skill")).toBeDefined();
		expect(result.all.find(s => s.name === "extra-skill")).toBeDefined();
	});

	test("marketplace-root skills manifest field replaces default skills directory", async () => {
		// Claude path-behavior rules carve out marketplace entries whose source is the
		// marketplace root: their manifest `skills` field selects the published
		// subdirectories instead of also loading the root `skills/` directory.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-marketplace-root");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "skills", "unpublished-root-skill"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "plugins", "published", "skills", "published-skill"), {
			recursive: true,
		});

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-marketplace-root@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, "marketplace.json"),
			JSON.stringify({
				name: "market",
				owner: { name: "Market" },
				plugins: [{ name: "manifest-skills-marketplace-root", source: "./" }],
			}),
		);
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: ["./plugins/published/skills"] }),
		);
		await fs.writeFile(
			path.join(pluginPath, "skills", "unpublished-root-skill", "SKILL.md"),
			"---\nname: unpublished-root-skill\ndescription: Unpublished root skill\n---\nBody\n",
		);
		await fs.writeFile(
			path.join(pluginPath, "plugins", "published", "skills", "published-skill", "SKILL.md"),
			"---\nname: published-skill\ndescription: Published skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.find(s => s.name === "published-skill")).toBeDefined();
		expect(result.all.find(s => s.name === "unpublished-root-skill")).toBeUndefined();
	});

	test("array-form skills entry pointing at a directory containing SKILL.md loads the single skill", async () => {
		// Per Claude plugins reference: a skills path may point directly at a directory whose
		// SKILL.md is the skill (frontmatter name → invocation, directory basename → fallback).
		// Real plugins use `"skills": ["./"]` — that entry must not silently drop the skill.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-skills-self");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "single"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-skills-self@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ skills: ["./single"] }),
		);
		await fs.writeFile(
			path.join(pluginPath, "single", "SKILL.md"),
			"---\nname: solo-skill\ndescription: Solo skill\n---\nBody\n",
		);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.find(s => s.name === "solo-skill")).toBeDefined();
	});

	test("manifest commands field replaces default commands/ directory (Claude replace semantics)", async () => {
		// Per Claude plugins reference "Path behavior rules":
		// `commands` REPLACES the default `commands/` scan when the manifest key is set.
		// A plugin that wants both must list `./commands` explicitly.
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		const pluginPath = path.join(tempDir, "plugins", "manifest-commands-replace");
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(path.join(pluginPath, ".claude-plugin"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "commands"), { recursive: true });
		await fs.mkdir(path.join(pluginPath, "admin-commands"), { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"manifest-commands-replace@market": [
					{
						scope: "user",
						installPath: pluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};
		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));
		await fs.writeFile(
			path.join(pluginPath, ".claude-plugin", "plugin.json"),
			JSON.stringify({ commands: ["./admin-commands"] }),
		);
		// This file lives under the default commands/ dir and MUST NOT load once the
		// manifest declares `commands` (Claude's documented "replaces default" semantic).
		await fs.writeFile(path.join(pluginPath, "commands", "default.md"), "Default\n");
		await fs.writeFile(path.join(pluginPath, "admin-commands", "admin.md"), "Admin\n");

		const result = await loadCapability<SlashCommand>("slash-commands", { cwd: tempDir });
		expect(result.warnings).toEqual([]);
		expect(result.all.find(c => c.name === "manifest-commands-replace:admin")).toBeDefined();
		expect(result.all.find(c => c.name === "manifest-commands-replace:default")).toBeUndefined();
	});
});

describe("discoverAgents plugin precedence", () => {
	let tempDir: string;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		delete process.env.CLAUDE_CONFIG_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-precedence-test-"));
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		await removeWithRetries(tempDir);
	});

	test("prefers project-scoped plugin agent over user-scoped plugin agent", async () => {
		const pluginRegistryDir = path.join(tempDir, ".claude", "plugins");
		const projectPluginPath = path.join(tempDir, "plugins", "project");
		const userPluginPath = path.join(tempDir, "plugins", "user");
		const agentName = "plugin-precedence-test-agent";

		await fs.mkdir(pluginRegistryDir, { recursive: true });
		await fs.mkdir(path.join(projectPluginPath, "agents"), { recursive: true });
		await fs.mkdir(path.join(userPluginPath, "agents"), { recursive: true });

		const projectAgent = `---\nname: ${agentName}\ndescription: Project plugin version\n---\nProject scope agent`;
		const userAgent = `---\nname: ${agentName}\ndescription: User plugin version\n---\nUser scope agent`;

		await fs.writeFile(path.join(projectPluginPath, "agents", "shared.md"), projectAgent);
		await fs.writeFile(path.join(userPluginPath, "agents", "shared.md"), userAgent);

		const registry = {
			version: 2,
			plugins: {
				"shared-plugin@market": [
					{
						scope: "user",
						installPath: userPluginPath,
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
					{
						scope: "project",
						projectPath: tempDir,
						installPath: projectPluginPath,
						version: "1.0.1",
						installedAt: "2025-01-02T00:00:00Z",
						lastUpdated: "2025-01-02T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginRegistryDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await discoverAgents(tempDir, tempDir);
		const found = result.agents.find(agent => agent.name === agentName);

		expect(found?.source).toBe("project");
		expect(found?.filePath).toContain(projectPluginPath);
	});
});
