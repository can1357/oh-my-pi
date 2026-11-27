import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { enableProvider, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	parseClaudePluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { loadSkills, loadSkillPromptBody } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
<<<<<<< HEAD
import { __resetDirsFromEnvForTests, getPluginsDir, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
=======
import { __resetDirsFromEnvForTests, logger, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
>>>>>>> c14ad6c5db (refactor(discovery): pruned foreign user-level config and minor providers)
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";

describe("parseClaudePluginsRegistry", () => {
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

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfileEnv = process.env.OMP_PROFILE;
		originalPiProfileEnv = process.env.PI_PROFILE;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-"));
		testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-test-agent-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
		// Point the agent dir at a temp dir so user-scope discovery (native MCP
		// config, skills, etc.) cannot read the real ~/.omp/agent profile.
		setAgentDir(testAgentDir);
		enableProvider("claude-plugins");
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
		enableProvider("claude-plugins");
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempDir);
		await removeWithRetries(testAgentDir);
	});

	test("returns empty roots when no registry file exists", async () => {
		const result = await listClaudePluginRoots(tempDir);
		expect(result.roots).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	test("logs registry warnings once per cached computation", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		const registryPath = path.join(pluginsDir, "installed_plugins.json");
		await fs.writeFile(registryPath, "not json");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const first = await listClaudePluginRoots(tempDir);
		const second = await listClaudePluginRoots(tempDir);

		expect(first.warnings).toEqual([`Failed to parse OMP plugin registry: ${registryPath}`]);
		expect(second).toBe(first);
		expect(warnSpy.mock.calls.filter(([message]) => message === first.warnings[0])).toHaveLength(1);
	});

	test("logs registry warnings once for concurrent callers", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
		await fs.mkdir(pluginsDir, { recursive: true });
		const registryPath = path.join(pluginsDir, "installed_plugins.json");
		await fs.writeFile(registryPath, "not json");
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const results = await Promise.all([
			listClaudePluginRoots(tempDir),
			listClaudePluginRoots(tempDir),
			listClaudePluginRoots(tempDir),
		]);

		const message = `Failed to parse OMP plugin registry: ${registryPath}`;
		for (const result of results) expect(result.warnings).toEqual([message]);
		expect(warnSpy.mock.calls.filter(([m]) => m === message)).toHaveLength(1);
	});

	test("parses plugin with user scope", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
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
			origin: "omp",
		});
	});

	test("handles multiple entries per plugin ID", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
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

		const result = await listClaudePluginRoots(tempDir, tempDir);
		// Should return both entries, not just the first one
		expect(result.roots).toHaveLength(2);
		expect(result.roots[0].version).toBe("2.0.0");
		expect(result.roots[0].scope).toBe("user");
		expect(result.roots[1].version).toBe("1.0.0");
		expect(result.roots[1].scope).toBe("project");
	});

	test("warns on invalid plugin ID format", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
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
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
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
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
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

	test("isolates cached plugin roots by home", async () => {
		const firstHome = path.join(tempDir, "first-home");
		const secondHome = path.join(tempDir, "second-home");
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

	test("derives the namespace from the plugin name, not the Claude cache version segment (#12151)", async () => {
		// Claude Code's own plugin cache keeps marketplace/plugin/version as
		// three separate path segments (`.../cache/<marketplace>/<plugin>/<version>/skills/...`),
		// unlike OMP's single joined `<marketplace>___<plugin>___<version>` cache
		// directory. Deriving the namespace from the path segment owning `skills/`
		// would read the shared version ("1.0.0" → "1-0-0") for both plugins here,
		// colliding them together instead of keeping their own plugin identities.
		const marketRoot = path.join(tempDir, ".claude", "plugins", "cache", "test-market");
		const pluginARoot = path.join(marketRoot, "plugin-a", "1.0.0");
		const pluginBRoot = path.join(marketRoot, "plugin-b", "1.0.0");
		const ompRegistryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");

		await Promise.all([
			fs.mkdir(path.join(pluginARoot, "skills", "shared-skill"), { recursive: true }),
			fs.mkdir(path.join(pluginBRoot, "skills", "shared-skill"), { recursive: true }),
			fs.mkdir(path.dirname(ompRegistryPath), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(pluginARoot, "skills", "shared-skill", "SKILL.md"),
				"---\nname: shared-skill\ndescription: Plugin A's skill.\n---\nPlugin A body\n",
			),
			fs.writeFile(
				path.join(pluginBRoot, "skills", "shared-skill", "SKILL.md"),
				"---\nname: shared-skill\ndescription: Plugin B's skill.\n---\nPlugin B body\n",
			),
			fs.writeFile(
				ompRegistryPath,
				JSON.stringify({
					version: 2,
					plugins: {
						"plugin-a@test-market": [{ scope: "user", installPath: pluginARoot, version: "1.0.0" }],
						"plugin-b@test-market": [{ scope: "user", installPath: pluginBRoot, version: "1.0.0" }],
					},
				}),
			),
		]);

		const { skills, warnings } = await loadSkills({ cwd: tempDir });
		const names = skills
			.map(skill => skill.name)
			.filter(name => name === "shared-skill" || name.endsWith("/shared-skill"))
			.sort();
		// "plugin-a" is admitted first (bare); "plugin-b" is namespaced by its
		// own plugin name, never by the version segment both share.
		expect(names).toEqual(["plugin-b/shared-skill", "shared-skill"]);
		expect(warnings.some(warning => warning.message.includes("1-0-0"))).toBe(false);
	});

	test("ignores Claude Code's own plugin registry", async () => {
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

		const roots = await listClaudePluginRoots(tempDir, tempDir);
		expect(roots.roots.map(root => root.id)).toEqual(["omp-owned@market"]);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir });
		expect(result.all.find(skill => skill.name === "omp-demo")?._source.provider).toBe("claude-plugins");
		expect(result.all.find(skill => skill.name === "claude-demo")).toBeUndefined();
	});

	for (const catalogDir of [".claude-plugin", ".omp-plugin"]) {
		test(`marketplace-root ${catalogDir} entry limits shared skills to declared paths`, async () => {
			const pluginPath = path.join(tempDir, "plugins", "anthropic-skills");
			const registryPath = path.join(tempDir, ".omp", "plugins", "installed_plugins.json");
			await Promise.all([
				fs.mkdir(path.join(pluginPath, "skills", "xlsx"), { recursive: true }),
				fs.mkdir(path.join(pluginPath, "skills", "skill-creator"), { recursive: true }),
				fs.mkdir(path.dirname(registryPath), { recursive: true }),
				fs.mkdir(path.join(pluginPath, catalogDir), { recursive: true }),
			]);
			await Promise.all([
				fs.writeFile(
					path.join(pluginPath, "skills", "xlsx", "SKILL.md"),
					"---\nname: xlsx\ndescription: Spreadsheet skill\n---\nBody\n",
				),
				fs.writeFile(
					path.join(pluginPath, "skills", "skill-creator", "SKILL.md"),
					"---\nname: skill-creator\ndescription: Skill creation skill\n---\nBody\n",
				),
				fs.writeFile(
					path.join(pluginPath, catalogDir, "marketplace.json"),
					JSON.stringify({
						name: "anthropic-agent-skills",
						owner: { name: "Anthropic" },
						plugins: [
							{
								name: "document-skills",
								source: "./",
								strict: false,
								skills: ["./skills/xlsx"],
							},
							{
								name: "example-skills",
								source: "./",
								strict: false,
								skills: ["./skills/skill-creator"],
							},
						],
					}),
				),
				fs.writeFile(
					registryPath,
					JSON.stringify({
						version: 2,
						plugins: {
							"document-skills@anthropic-agent-skills": [
								{ scope: "user", installPath: pluginPath, version: "1.0.0" },
							],
						},
					}),
				),
			]);

			const result = await loadCapability<Skill>("skills", { cwd: tempDir });

			expect(result.all.find(skill => skill.name === "xlsx")).toBeDefined();
			expect(result.all.find(skill => skill.name === "skill-creator")).toBeUndefined();
		});
	}

	test("defaults scope to user when not specified", async () => {
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
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

	// oxlint-disable-next-line no-template-curly-in-string -- literal plugin variable under test
	test("substitutes ${CLAUDE_PLUGIN_ROOT} in plugin skill and command Markdown bodies (#20165)", async () => {
		// Claude Code resolves the variables anywhere in the Markdown body of
		// skills, commands and agents when it loads the content. OMP must do the
		// same so plugins can reference bundled scripts relative to the plugin
		// install path (the variables are not exported to the bash tool).
		const pluginPath = path.join(tempDir, "plugins", "var-plugin");
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
		const registry = {
			version: 2,
			plugins: {
				"var-plugin@test-market": [{ scope: "user", installPath: pluginPath, version: "1.0.0" }],
			},
		};
		await Promise.all([
			fs.mkdir(path.join(pluginPath, "skills", "var-skill"), { recursive: true }),
			fs.mkdir(path.join(pluginPath, "commands"), { recursive: true }),
			fs.mkdir(pluginsDir, { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(pluginPath, "skills", "var-skill", "SKILL.md"),
				// oxlint-disable-next-line no-template-curly-in-string -- literal plugin variable under test
				'---\nname: var-skill\ndescription: Uses the plugin root.\n---\nRun `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/x.py"`.\n',
			),
			fs.writeFile(
				path.join(pluginPath, "commands", "var-cmd.md"),
				// oxlint-disable-next-line no-template-curly-in-string -- literal plugin variable under test
				"Read ${CLAUDE_PLUGIN_ROOT}/shared/notes.md, then run ${OMP_PLUGIN_ROOT}/scripts/y.sh.\n",
			),
			fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry)),
		]);

		const { skills } = await loadSkills({ cwd: tempDir });
		const skill = skills.find(s => s.name === "var-skill");
		expect(skill).toBeDefined();
		expect(skill?.pluginRoot).toBe(pluginPath);

		// `/skill:` expansion reads the body from disk (`loadSkillPromptBody`);
		// the substitution must happen there too, not only at discovery time.
		const body = await loadSkillPromptBody(skill!);
		expect(body).toBe(`Run \`python3 "${pluginPath}/scripts/x.py"\`.`);

		const commands = await loadSlashCommands({ cwd: tempDir });
		const cmd = commands.find(c => c.name === "var-plugin:var-cmd");
		expect(cmd).toBeDefined();
		expect(cmd?.content).toBe(`Read ${pluginPath}/shared/notes.md, then run ${pluginPath}/scripts/y.sh.\n`);
	});

	test.each([false, true])("plugin-root SKILL.md with absent skills/ (explicit path: %s)", async declared => {
		const pluginPath = path.join(tempDir, "plugins", "db");
		const pluginsDir = path.join(tempDir, ".omp", "plugins");
		const registry = {
			version: 2,
			plugins: { "db@test-market": [{ scope: "user", installPath: pluginPath, version: "1.0.0" }] },
		};
		await Promise.all([
			fs.mkdir(path.join(pluginPath, "reference", "nested"), { recursive: true }),
			fs.mkdir(pluginsDir, { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(path.join(pluginPath, "SKILL.md"), "---\nname: db\ndescription: Database router.\n---\nRoute.\n"),
			fs.writeFile(
				path.join(pluginPath, "reference", "nested", "SKILL.md"),
				"---\nname: nested\ndescription: Not a skill.\n---\nNo.\n",
			),
			fs.writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify(registry)),
		]);

		if (declared) {
			await fs.mkdir(path.join(pluginPath, ".claude-plugin"));
			await fs.writeFile(
				path.join(pluginPath, ".claude-plugin", "plugin.json"),
				JSON.stringify({ skills: "./skills" }),
			);
		}
		const { skills } = await loadSkills({ cwd: tempDir });
		const names = skills.filter(s => s.pluginRoot === pluginPath).map(s => s.name);
		expect(names).toEqual(declared ? [] : ["db"]);
	});
});

describe("claude-plugins flat .mcp.json shape", () => {
	let tempDir: string;
	let originalHome: string | undefined;

	beforeEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		originalHome = process.env.HOME;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugins-flat-mcp-"));
		process.env.HOME = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		clearClaudePluginRootsCache();
		clearFsCache();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		await removeWithRetries(tempDir);
	});

	async function setupPlugin(pluginId: string, mcpJson: unknown): Promise<void> {
		const pluginsDir = getPluginsDir(tempDir);
		const pluginPath = path.join(tempDir, "plugins", pluginId);
		await fs.mkdir(pluginsDir, { recursive: true });
		await fs.mkdir(pluginPath, { recursive: true });

		const registry = {
			version: 2,
			plugins: {
				[`${pluginId}@claude-plugins-official`]: [
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
		await fs.writeFile(path.join(pluginPath, ".mcp.json"), JSON.stringify(mcpJson));
	}

	test("flat shape (top-level keys are server names) registers servers", async () => {
		await setupPlugin("context7", {
			context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
		});

		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		const found = result.all.find(s => s.name === "context7:context7");
		expect(found).toBeDefined();
		expect(found?.command).toBe("npx");
		expect(found?.args).toEqual(["-y", "@upstash/context7-mcp"]);
	});

	test("flat shape with HTTP transport (url) registers", async () => {
		await setupPlugin("gitlab", {
			gitlab: { url: "https://gitlab.com/mcp", type: "http" },
		});

		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		const found = result.all.find(s => s.name === "gitlab:gitlab");
		expect(found).toBeDefined();
		expect(found?.url).toBe("https://gitlab.com/mcp");
		expect(found?.transport).toBe("http");
	});

	test("flat shape skips entries without command/url", async () => {
		await setupPlugin("mixed", {
			good: { command: "npx" },
			bad: { description: "missing command and url" },
		});

		const result = await loadCapability<MCPServer>("mcps", { cwd: tempDir });
		expect(result.all.find(s => s.name === "mixed:good")).toBeDefined();
		expect(result.all.find(s => s.name === "mixed:bad")).toBeUndefined();
	});
});
