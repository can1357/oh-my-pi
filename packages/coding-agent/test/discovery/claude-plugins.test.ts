import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@pk-nerdsaver-ai/pi-coding-agent/capability/fs";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
} from "@pk-nerdsaver-ai/pi-coding-agent/discovery/helpers";
import { loadSlashCommands } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/slash-commands";
import { discoverAgents } from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import "@pk-nerdsaver-ai/pi-coding-agent/discovery/claude-plugins";
import { type MCPServer, mcpCapability } from "@pk-nerdsaver-ai/pi-coding-agent/capability/mcp";
import type { Skill } from "@pk-nerdsaver-ai/pi-coding-agent/capability/skill";
import type { SlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/capability/slash-command";

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
		expect(result).not.toBeNull();
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

describe("listClaudePluginRoots", () => {
	let tempDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await removeWithRetries(tempDir);
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

	test("parses plugin with project scope", async () => {
		const pluginsDir = path.join(tempDir, ".claude", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				"project-plugin@market": [
					{
						scope: "project",
						installPath: "/path/to/project-plugin",
						version: "2.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toHaveLength(1);
		expect(result.roots[0].scope).toBe("project");
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
						installPath: "/path/to/v1",
						version: "1.0.0",
						installedAt: "2025-01-01T00:00:00Z",
						lastUpdated: "2025-01-01T00:00:00Z",
					},
				],
			},
		};

		await fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry));

		const result = await listClaudePluginRoots(tempDir);
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
		expect(result.all.length).toBeGreaterThan(0);
		const found = result.all.find(skill => skill.name === "manifest-skill");

		expect(found).toBeDefined();
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

			expect(server).toBeDefined();
			expect(server?.url).toBe("https://mcp.context7.example/mcp");
			expect(server?.headers).toEqual({ CONTEXT7_API_KEY: "ctx7sk-test-key" });
		} finally {
			if (originalApiKey === undefined) delete process.env.OMP_PLUGIN_MCP_API_KEY;
			else process.env.OMP_PLUGIN_MCP_API_KEY = originalApiKey;
			if (originalUrl === undefined) delete process.env.OMP_PLUGIN_MCP_URL;
			else process.env.OMP_PLUGIN_MCP_URL = originalUrl;
		}
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
		expect(result.all.length).toBeGreaterThan(0);
		const found = result.all.find(command => command.name === "manifest-commands:ship");

		expect(found).toBeDefined();
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

		expect(found).toBeDefined();
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
});

describe("discoverAgents plugin precedence", () => {
	let tempDir: string;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-precedence-test-"));
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
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

		expect(found).toBeDefined();
		expect(found?.source).toBe("project");
		expect(found?.filePath).toContain(projectPluginPath);
	});
});
