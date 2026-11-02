import { describe } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type FifoCase, itRefusesFifo, mod, useFifoSandbox } from "./fifo-harness";

// Files a user, a plugin's author or a marketplace places that omp reads on its
// own, after startup: plugin manifests read when a session loads plugins and by
// the plugin and marketplace commands, prompt templates, skill bodies, agent
// definitions, `--system-prompt` files and the `/advisor` editor's config. One
// case per reader and the route it takes; see `fifo-harness.ts` for how each
// case runs.
const box = useFifoSandbox("@omp-fifo-plugins-prompts-");

const j = JSON.stringify;
const pluginsDir = (): string => path.join(box.home, ".omp", "plugins");
const marketplaceDir = (): string => path.join(box.home, "marketplace");

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

/** `call`, whose error the child prints after `error `, as the command it serves reports it. */
function reported(imports: string, call: string): string {
	return `${imports}
	try {
		${call}
	} catch (error) {
		console.log("error " + String(error));
	}`;
}

const pluginManager = (): string =>
	`import { PluginManager } from ${mod("coding-agent", "extensibility/plugins/manager.ts")};
	const manager = new PluginManager(${j(box.projectDir)});`;

const installer = (): string =>
	`import { installPlugin, linkPlugin, listPlugins } from ${mod("coding-agent", "extensibility/plugins/installer.ts")};`;

const marketplaceManager = (): string =>
	`import { MarketplaceManager } from ${mod("coding-agent", "extensibility/plugins/marketplace/manager.ts")};
	const manager = new MarketplaceManager({
		marketplacesRegistryPath: ${j(path.join(pluginsDir(), "marketplaces.json"))},
		installedRegistryPath: ${j(path.join(pluginsDir(), "installed_plugins.json"))},
		marketplacesCacheDir: ${j(path.join(pluginsDir(), "cache", "marketplaces"))},
		pluginsCacheDir: ${j(path.join(pluginsDir(), "cache", "plugins"))},
	});`;

const loadPlugins = (): string =>
	`import { getEnabledPlugins } from ${mod("coding-agent", "extensibility/plugins/loader.ts")};
	await getEnabledPlugins(${j(box.projectDir)});`;

/** `~/.omp/plugins` with `probe` declared in its `package.json`. */
function declareProbePlugin(): void {
	writeJson(path.join(pluginsDir(), "package.json"), { dependencies: { probe: "^1.0.0" } });
}

/** A local marketplace `probe-market`, added as `omp marketplace add` records it, that lists plugin `probe`. */
function addLocalMarketplace(): void {
	const catalogPath = path.join(pluginsDir(), "cache", "marketplaces", "probe-market", "marketplace.json");
	writeJson(catalogPath, {
		name: "probe-market",
		owner: { name: "probe" },
		plugins: [{ name: "probe", source: "./probe" }],
	});
	const now = new Date().toISOString();
	writeJson(path.join(pluginsDir(), "marketplaces.json"), {
		version: 1,
		marketplaces: [
			{
				name: "probe-market",
				sourceType: "local",
				sourceUri: marketplaceDir(),
				catalogPath,
				addedAt: now,
				updatedAt: now,
			},
		],
	});
	fs.mkdirSync(path.join(marketplaceDir(), "probe"), { recursive: true });
}

const validateMarketplaceInstall = (): string =>
	`${marketplaceManager()}
	await manager.validateInstallPlugin("probe", "probe-market");`;

const cases: FifoCase[] = [
	// Read when a session loads its plugins.
	{
		name: "~/.omp/plugins/package.json, when a session loads plugins",
		at: () => path.join(pluginsDir(), "package.json"),
		setup: () => fs.mkdirSync(path.join(pluginsDir(), "node_modules"), { recursive: true }),
		script: loadPlugins,
		outcome: "skipped",
	},
	{
		name: "~/.omp/plugins/node_modules/<name>/package.json, when a session loads plugins",
		at: () => path.join(pluginsDir(), "node_modules", "probe", "package.json"),
		setup: declareProbePlugin,
		script: loadPlugins,
		outcome: "skipped",
	},
	// Read by `omp plugin` commands.
	{
		name: "~/.omp/plugins/package.json, read by omp plugin list",
		at: () => path.join(pluginsDir(), "package.json"),
		script: () => reported(pluginManager(), "await manager.list();"),
		outcome: "reported",
	},
	{
		name: "~/.omp/plugins/node_modules/<name>/package.json, read by omp plugin list",
		at: () => path.join(pluginsDir(), "node_modules", "probe", "package.json"),
		setup: declareProbePlugin,
		script: () => reported(pluginManager(), "await manager.list();"),
		outcome: "reported",
	},
	{
		name: "~/.omp/plugins/package.json, read by omp plugin install",
		at: () => path.join(pluginsDir(), "package.json"),
		script: () => reported(pluginManager(), 'await manager.install("probe");'),
		outcome: "reported",
	},
	{
		name: "<project>/.omp/plugins/package.json, read when a plugin is looked up",
		at: () => path.join(box.projectDir, ".omp", "plugins", "package.json"),
		script: () => reported(pluginManager(), 'await manager.getPlugin("probe");'),
		outcome: "reported",
	},
	{
		name: "~/.omp/plugins/node_modules/<name>/package.json, read by omp plugin doctor",
		at: () => path.join(pluginsDir(), "node_modules", "probe", "package.json"),
		setup: declareProbePlugin,
		script: () => reported(pluginManager(), "await manager.doctor();"),
		outcome: "reported",
	},
	{
		name: "~/.omp/plugins/node_modules/<name>/package.json, read by omp plugin upgrade",
		at: () => path.join(pluginsDir(), "node_modules", "probe", "package.json"),
		setup: declareProbePlugin,
		script: () => reported(pluginManager(), 'await manager.upgrade("probe");'),
		outcome: "reported",
	},
	{
		name: "<dir>/package.json, read by omp plugin link <dir>",
		at: () => path.join(box.projectDir, "linked", "package.json"),
		script: () => reported(pluginManager(), 'await manager.link("linked");'),
		outcome: "reported",
	},
	{
		// A marketplace install's copy, whose links lead where its author's did.
		name: "<marketplace install>/package.json, read by omp plugin list",
		at: () => path.join(box.home, "installed-probe", "package.json"),
		setup: () => {
			const now = new Date().toISOString();
			writeJson(path.join(pluginsDir(), "installed_plugins.json"), {
				version: 2,
				plugins: {
					"probe@probe-market": [
						{
							scope: "user",
							installPath: path.join(box.home, "installed-probe"),
							version: "1.0.0",
							installedAt: now,
							lastUpdated: now,
						},
					],
				},
			});
		},
		script: () => `${pluginManager()}
		await manager.list();`,
		outcome: "skipped",
	},
	// The standalone plugin installer module.
	{
		name: "~/.omp/agent/plugins/package.json, read by the plugin installer's list",
		at: () => path.join(box.agentDir, "plugins", "package.json"),
		script: () => reported(installer(), "await listPlugins();"),
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/plugins/package.json, looked at by the plugin installer's install",
		at: () => path.join(box.agentDir, "plugins", "package.json"),
		script: () => reported(installer(), 'await installPlugin("probe");'),
		outcome: "reported",
	},
	{
		// The child's working directory is the project's real path.
		name: "<dir>/package.json, read by the plugin installer's link",
		at: () => path.join(fs.realpathSync(box.projectDir), "linked", "package.json"),
		script: () => reported(installer(), 'await linkPlugin("linked");'),
		outcome: "reported",
	},
	// Read by `omp marketplace` and marketplace plugin installs.
	{
		name: "<marketplace>/.omp-plugin/marketplace.json, read by omp marketplace add",
		at: () => path.join(marketplaceDir(), ".omp-plugin", "marketplace.json"),
		script: () => reported(marketplaceManager(), `await manager.addMarketplace(${j(marketplaceDir())});`),
		outcome: "reported",
	},
	{
		name: "<marketplace>/<plugin>/package.json, read by a marketplace install",
		at: () => path.join(marketplaceDir(), "probe", "package.json"),
		setup: addLocalMarketplace,
		script: () => reported(marketplaceManager(), 'await manager.validateInstallPlugin("probe", "probe-market");'),
		outcome: "reported",
	},
	{
		name: "~/.omp/plugins/package.json, read by a marketplace install",
		at: () => path.join(pluginsDir(), "package.json"),
		setup: addLocalMarketplace,
		script: () => reported(marketplaceManager(), 'await manager.validateInstallPlugin("probe", "probe-market");'),
		outcome: "reported",
	},
	{
		name: "~/.omp/plugins/omp-plugins.lock.json, read by a marketplace install",
		at: () => path.join(pluginsDir(), "omp-plugins.lock.json"),
		setup: addLocalMarketplace,
		script: validateMarketplaceInstall,
		outcome: "skipped",
	},
	{
		name: "<marketplace>/<plugin>/.claude-plugin/plugin.json, read by a marketplace install",
		at: () => path.join(marketplaceDir(), "probe", ".claude-plugin", "plugin.json"),
		setup: addLocalMarketplace,
		script: validateMarketplaceInstall,
		outcome: "skipped",
	},
	{
		// The manifest is read by its real path.
		name: "--plugin-dir <dir>/.claude-plugin/plugin.json",
		at: () => path.join(fs.realpathSync(box.home), "plugin-dir", ".claude-plugin", "plugin.json"),
		setup: () => fs.mkdirSync(path.join(box.home, "plugin-dir"), { recursive: true }),
		script: () =>
			`import { injectPluginDirRoots } from ${mod("coding-agent", "discovery/helpers.ts")};
			await injectPluginDirRoots(${j(box.home)}, [${j(path.join(box.home, "plugin-dir"))}], ${j(box.projectDir)});`,
		outcome: "skipped",
	},
	// Prompts, skills and agents.
	{
		// The scan lists a link, never a FIFO itself: the note names the link, which starts with the FIFO's path.
		name: "~/.omp/agent/prompts/<name>.md, a link to a FIFO",
		at: () => path.join(box.agentDir, "prompts", "probe"),
		setup: () => {
			fs.mkdirSync(path.join(box.agentDir, "prompts"), { recursive: true });
			fs.symlinkSync("probe", path.join(box.agentDir, "prompts", "probe.md"));
		},
		script: () =>
			`import { loadPromptTemplates } from ${mod("coding-agent", "config/prompt-templates.ts")};
			await loadPromptTemplates({ cwd: ${j(box.projectDir)}, agentDir: ${j(box.agentDir)} });`,
		outcome: "skipped",
	},
	{
		name: "~/.omp/agent/skills/<name>/SKILL.md, when the skill is invoked",
		at: () => path.join(box.agentDir, "skills", "probe", "SKILL.md"),
		script: () =>
			reported(
				`import { buildSkillPromptMessage } from ${mod("coding-agent", "extensibility/skills.ts")};`,
				`await buildSkillPromptMessage(
					{ name: "probe", filePath: ${j(path.join(box.agentDir, "skills", "probe", "SKILL.md"))}, baseDir: ${j(path.join(box.agentDir, "skills", "probe"))} },
					{ args: "" },
				);`,
			),
		outcome: "reported",
	},
	{
		// A directory entry that is a link passes the agent scan's filter whatever it leads to.
		name: "~/.omp/agent/agents/<name>.md, a link to a FIFO",
		at: () => path.join(box.agentDir, "agents", "probe"),
		setup: () => {
			fs.mkdirSync(path.join(box.agentDir, "agents"), { recursive: true });
			fs.symlinkSync("probe", path.join(box.agentDir, "agents", "probe.md"));
		},
		script: () =>
			`import { discoverAgents } from ${mod("coding-agent", "task/discovery.ts")};
			await discoverAgents(${j(box.projectDir)}, ${j(box.home)});`,
		outcome: "skipped",
	},
	// Files a flag or a command names as configuration.
	{
		name: "--system-prompt <file>",
		at: () => path.join(box.projectDir, "system-prompt.md"),
		script: () =>
			`import { resolvePromptInput } from ${mod("coding-agent", "system-prompt.ts")};
			await resolvePromptInput(${j(path.join(box.projectDir, "system-prompt.md"))}, "system prompt");`,
		outcome: "skipped",
	},
	{
		name: "--system-prompt-template <file>",
		at: () => path.join(box.projectDir, "system-prompt-template.md"),
		script: () =>
			reported(
				`import { loadSystemPromptTemplateFile } from ${mod("coding-agent", "system-prompt.ts")};`,
				`await loadSystemPromptTemplateFile(${j(path.join(box.projectDir, "system-prompt-template.md"))});`,
			),
		outcome: "reported",
	},
	{
		name: "~/.omp/agent/WATCHDOG.yml, opened by /advisor",
		at: () => path.join(box.agentDir, "WATCHDOG.yml"),
		script: () =>
			`import { loadWatchdogConfigFile } from ${mod("coding-agent", "advisor/config.ts")};
			await loadWatchdogConfigFile(${j(path.join(box.agentDir, "WATCHDOG.yml"))});`,
		outcome: "skipped",
	},
];

describe.skipIf(process.platform === "win32")(
	"a FIFO at a plugin, prompt or agent file is neither waited on nor read",
	() => {
		for (const c of cases) itRefusesFifo(box, c);
	},
);
