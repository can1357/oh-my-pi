import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { clearAgentPluginRootCache } from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { clearClaudePluginRootsCache, injectPluginDirRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const OMP_AGENT_MD = [
	"---",
	"name: omp-test-agent",
	"description: OMP-native test agent.",
	"---",
	"You are an OMP task agent.",
].join("\n");

const OMP_PLUGIN_AGENT_MD = [
	"---",
	"name: loom-verify-spec",
	"description: Plugin-shipped verification agent.",
	"---",
	"You verify the loom spec.",
].join("\n");

const CLAUDE_AGENT_MD = [
	"---",
	"name: cc-test-agent",
	"description: Test Claude Code agent.",
	"tools: Read, Grep, Glob, Bash",
	"model: sonnet",
	"color: purple",
	"---",
	"You are a Claude Code custom subagent.",
].join("\n");

async function writeOmpPluginAgent(home: string): Promise<void> {
	const userPluginsRoot = path.join(home, ".omp", "plugins");
	const pluginRoot = path.join(userPluginsRoot, "node_modules", "loom");
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "loom", version: "1.0.0", omp: { version: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(userPluginsRoot, "package.json"),
		JSON.stringify({
			name: "omp-plugins-root",
			version: "0.0.0",
			dependencies: { loom: "1.0.0" },
		}),
	);
	await fs.writeFile(path.join(pluginRoot, "agents", "loom-verify-spec.md"), OMP_PLUGIN_AGENT_MD);
}

function agentMd(name: string, model: string): string {
	return ["---", `name: ${name}`, `description: ${name} probe.`, `model: ${model}`, "---", `body ${name}`].join("\n");
}

// Register an omp-installed marketplace plugin via the OMP plugin registry
// (`~/.omp/plugins/installed_plugins.json`), the path listClaudePluginRoots
// reads as origin "omp" — distinct from the node_modules path above. `manifest`
// controls the declared plugin dialect: `.omp-plugin/plugin.json` (OMP-native),
// `.claude-plugin/plugin.json` (Claude Code), `both` (OMP wins by precedence),
// or `none` (bare directory).
async function writeOmpMarketplacePlugin(
	home: string,
	options: {
		agentName: string;
		model: string;
		manifest: "omp" | "claude" | "both" | "none";
	},
): Promise<void> {
	const pluginRoot = path.join(home, "marketplace-cache", options.agentName);
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "agents", `${options.agentName}.md`),
		agentMd(options.agentName, options.model),
	);

	const wantsOmp = options.manifest === "omp" || options.manifest === "both";
	const wantsClaude = options.manifest === "claude" || options.manifest === "both";
	if (wantsOmp) {
		await fs.mkdir(path.join(pluginRoot, ".omp-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginRoot, ".omp-plugin", "plugin.json"),
			JSON.stringify({ name: options.agentName }),
		);
	}
	if (wantsClaude) {
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: options.agentName }),
		);
	}

	const registryDir = path.join(home, ".omp", "plugins");
	await fs.mkdir(registryDir, { recursive: true });
	await fs.writeFile(
		path.join(registryDir, "installed_plugins.json"),
		JSON.stringify({
			version: 1,
			plugins: {
				[`${options.agentName}@my-marketplace`]: [
					{ installPath: pluginRoot, version: "1.0.0", scope: "user", enabled: true },
				],
			},
		}),
	);
}

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		enableProvider("omp-plugins");
		clearOmpExtensionCliRoots();
		await injectPluginDirRoots(tempHome, []);
		clearClaudePluginRootsCache();
		clearAgentPluginRootCache();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	test("loads OMP agents but skips Claude Code custom agents", async () => {
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "agents", "omp-test-agent.md"), OMP_AGENT_MD);

		await fs.mkdir(path.join(tempHome, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(tempHome, ".claude", "agents", "user-cc-test-agent.md"), CLAUDE_AGENT_MD);
		await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "agents", "project-cc-test-agent.md"), CLAUDE_AGENT_MD);

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("omp-test-agent");
		expect(names).not.toContain("cc-test-agent");
		expect(projectAgentsDir).toBe(path.join(projectDir, ".omp", "agents"));
	});

	test("loads agents from OMP npm plugins under <home>/.omp/plugins/node_modules", async () => {
		await writeOmpPluginAgent(tempHome);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("loom-verify-spec");
	});

	test("excludes OMP npm plugin agents when omp-plugins is disabled", async () => {
		await writeOmpPluginAgent(tempHome);
		disableProvider("omp-plugins");

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).not.toContain("loom-verify-spec");
	});

	test("CLI extension agents win over project `extensions:` settings on dedup", async () => {
		// listOmpExtensionRoots returns roots in source-precedence order
		// (CLI > project settings > user settings > installed plugins). Agents
		// must honor that order so the `task` surface dedups identically to
		// the skills/hooks/tools surface in discovery/omp-plugins.ts.
		const cliExt = path.join(tempHome, "cli-ext");
		const projectExt = path.join(tempHome, "project-ext");
		await fs.mkdir(path.join(cliExt, "agents"), { recursive: true });
		await fs.mkdir(path.join(projectExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(cliExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-cli", "---", "cli body"].join("\n"),
		);
		await fs.writeFile(
			path.join(projectExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-project-settings", "---", "project body"].join("\n"),
		);

		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
		injectOmpExtensionCliRoots([cliExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const collide = agents.find(agent => agent.name === "collide");

		expect(collide).toBeDefined();
		expect(collide?.description).toBe("from-cli");
		expect(collide?.filePath).toBe(path.join(cliExt, "agents", "collide.md"));
	});

	test("ignores missing team prompts on shadowed definitions while preserving precedence", async () => {
		const projectAgents = path.join(projectDir, ".omp", "agents");
		const extension = path.join(tempHome, "shadowed-extension");
		await fs.mkdir(projectAgents, { recursive: true });
		await fs.mkdir(path.join(extension, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(projectAgents, "a-winner.md"),
			"---\nname: collision\ndescription: project winner\nteam-prompt: winner.txt\n---\nProject body\n",
		);
		await fs.writeFile(path.join(projectAgents, "winner.txt"), "Winning prompt");
		await fs.writeFile(
			path.join(projectAgents, "z-shadowed.md"),
			"---\nname: collision\ndescription: same-directory loser\nteam-prompt: missing-local.txt\n---\nLoser\n",
		);
		await fs.writeFile(
			path.join(extension, "agents", "collision.md"),
			"---\nname: collision\ndescription: extension loser\nteam-prompt: missing-extension.txt\n---\nLoser\n",
		);
		injectOmpExtensionCliRoots([extension], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const matches = agents.filter(agent => agent.name === "collision");
		expect(matches).toHaveLength(1);
		expect(matches[0].description).toBe("project winner");
		expect(matches[0].filePath).toBe(path.join(projectAgents, "a-winner.md"));
		expect(matches[0].teamSystemPrompt).toBe("Winning prompt");
	});

	test("reports the winning definition and missing prompt rather than falling back to a valid shadowed definition", async () => {
		const projectAgents = path.join(projectDir, ".omp", "agents");
		const extension = path.join(tempHome, "fallback-extension");
		const winner = path.join(projectAgents, "winner.md");
		const missing = path.join(projectAgents, "missing.txt");
		await fs.mkdir(projectAgents, { recursive: true });
		await fs.mkdir(path.join(extension, "agents"), { recursive: true });
		await fs.writeFile(winner, "---\nname: collision\ndescription: winner\nteam-prompt: missing.txt\n---\nWinner\n");
		await fs.writeFile(
			path.join(extension, "agents", "collision.md"),
			"---\nname: collision\ndescription: loser\n---\nLoser\n",
		);
		injectOmpExtensionCliRoots([extension], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const matches = agents.filter(agent => agent.name === "collision");
		expect(matches).toHaveLength(1);
		expect(matches[0].filePath).toBe(winner);
		expect(matches[0].description).toBe("winner");
		const error = (matches[0] as (typeof matches)[0] & { teamPromptError?: string }).teamPromptError;
		expect(error).toContain("collision");
		expect(error).toContain(missing);
		expect(error).toContain("ENOENT");
		expect(agents.some(agent => agent.source === "bundled")).toBe(true);
	});

	test("keeps ordinary agents usable when another agent's team prompt is missing", async () => {
		const dir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "normal.md"), OMP_AGENT_MD);
		await fs.writeFile(
			path.join(dir, "broken.md"),
			"---\nname: broken\ndescription: broken team prompt\nteam-prompt: missing.txt\n---\nOrdinary body\n",
		);
		const { agents } = await discoverAgents(projectDir, tempHome);
		expect(agents.find(agent => agent.name === "omp-test-agent")?.systemPrompt).toContain("OMP task agent");
		expect(agents.find(agent => agent.name === "broken")?.systemPrompt).toContain("Ordinary body");
	});

	for (const [label, value] of [
		["empty", '""'],
		["whitespace", '"   "'],
		["number", "42"],
		["boolean", "false"],
		["null", "null"],
		["array", "[prompt.txt]"],
		["object", "{path: prompt.txt}"],
	] as const) {
		test(`records an error for a ${label} team-prompt`, async () => {
			const dir = path.join(projectDir, ".omp", "agents");
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				path.join(dir, "invalid.md"),
				`---\nname: invalid\ndescription: invalid prompt\nteam-prompt: ${value}\n---\nBody\n`,
			);
			const { agents } = await discoverAgents(projectDir, tempHome);
			const agent = agents.find(candidate => candidate.name === "invalid") as
				| ((typeof agents)[number] & { teamPromptError?: string })
				| undefined;
			expect(agent?.teamPromptError).toContain("invalid");
			expect(agent?.teamSystemPrompt).toBeUndefined();
		});
	}

	test("loads a nested relative team prompt within the definition directory", async () => {
		const dir = path.join(projectDir, ".omp", "agents");
		await fs.mkdir(path.join(dir, "prompts"), { recursive: true });
		await fs.writeFile(path.join(dir, "prompts", "team.txt"), "Nested team prompt");
		await fs.writeFile(
			path.join(dir, "nested.md"),
			"---\nname: nested\ndescription: nested prompt\nteam-prompt: prompts/team.txt\n---\nBody\n",
		);
		const { agents } = await discoverAgents(projectDir, tempHome);
		expect(agents.find(agent => agent.name === "nested")?.teamSystemPrompt).toBe("Nested team prompt");
	});

	for (const kind of ["absolute", "traversal", "symlink"] as const) {
		test(`rejects a team prompt using ${kind} to access an untrusted path`, async () => {
			const dir = path.join(projectDir, ".omp", "agents");
			const outside = path.join(projectDir, ".omp", "agents-outside");
			await fs.mkdir(dir, { recursive: true });
			await fs.mkdir(outside, { recursive: true });
			await fs.writeFile(path.join(outside, "secret.txt"), "Outside prompt must not load");
			let promptPath: string;
			if (kind === "absolute") {
				promptPath = path.join(dir, "inside.txt");
				await fs.writeFile(promptPath, "Absolute path must not load");
			} else if (kind === "traversal") {
				promptPath = "../agents-outside/secret.txt";
			} else {
				await fs.symlink(outside, path.join(dir, "link"), "junction");
				promptPath = "link/secret.txt";
			}
			await fs.writeFile(
				path.join(dir, "unsafe.md"),
				`---\nname: unsafe\ndescription: unsafe prompt\nteam-prompt: ${JSON.stringify(promptPath)}\n---\nBody\n`,
			);
			const { agents } = await discoverAgents(projectDir, tempHome);
			const agent = agents.find(candidate => candidate.name === "unsafe") as
				| ((typeof agents)[number] & { teamPromptError?: string })
				| undefined;
			expect(agent?.teamPromptError).toContain("unsafe");
			expect(agent?.teamSystemPrompt).toBeUndefined();
		});
	}

	test("explicit-only CLI roots expose only explicitly named package agents", async () => {
		const staleExt = path.join(tempHome, "stale-ext");
		const explicitExt = path.join(tempHome, "explicit-ext");
		const settingsExt = path.join(tempHome, "settings-ext");
		for (const [root, name] of [
			[staleExt, "stale-agent"],
			[explicitExt, "explicit-agent"],
			[settingsExt, "settings-agent"],
		] as const) {
			await fs.mkdir(path.join(root, "agents"), { recursive: true });
			await fs.writeFile(
				path.join(root, "agents", `${name}.md`),
				["---", `name: ${name}`, `description: ${name}`, "---", `${name} body`].join("\n"),
			);
		}
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".omp", "settings.json"), JSON.stringify({ extensions: [settingsExt] }));
		await writeOmpPluginAgent(tempHome);

		injectOmpExtensionCliRoots([staleExt], tempHome, projectDir);
		injectOmpExtensionCliRoots([explicitExt], tempHome, projectDir, {
			mode: "explicit-only",
			replace: true,
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("explicit-agent");
		expect(names).not.toEqual(expect.arrayContaining(["stale-agent", "settings-agent", "loom-verify-spec"]));
	});

	test("discovers agents from a --plugin-dir root with the foreign claude-plugins opt-in off (#11151)", async () => {
		// `--plugin-dir` roots ride the shared plugin registry as user-scope, origin
		// "plugin-dir" entries. The claude-plugins foreign opt-in is off by default, so
		// gating user-scope roots purely on scope (as before) dropped these agents.
		const pluginDir = path.join(tempHome, "my-plugin");
		await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(pluginDir, "agents", "plugin-dir-agent.md"),
			["---", "name: plugin-dir-agent", "description: agent shipped in a --plugin-dir plugin.", "---", "body"].join(
				"\n",
			),
		);
		await injectPluginDirRoots(tempHome, [pluginDir], projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("plugin-dir-agent");
	});

	test("honors model frontmatter of OMP-native omp-installed marketplace plugin agents (#12028)", async () => {
		// omp-installed marketplace plugins ride the shared plugin registry as
		// origin "omp" roots. An OMP-native package (no Claude manifest) uses OMP
		// model selectors, so `model:` must survive discovery.
		enableProvider("claude-plugins");
		await writeOmpMarketplacePlugin(tempHome, {
			agentName: "omp-probe",
			model: '["@advisor", "@smol"]',
			manifest: "none",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "omp-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toEqual(["@advisor", "@smol"]);
	});

	test("drops model frontmatter of a Claude-format plugin installed via the OMP registry (#12031 review)", async () => {
		// origin "omp" but a `.claude-plugin` package: its `model: sonnet` is a
		// Claude alias, not an OMP selector, so it must still be stripped.
		enableProvider("claude-plugins");
		await writeOmpMarketplacePlugin(tempHome, {
			agentName: "claude-probe",
			model: "sonnet",
			manifest: "claude",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "claude-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toBeUndefined();
	});

	test("honors model frontmatter when a plugin declares both OMP and Claude manifests (#12031 review)", async () => {
		// `.omp-plugin/plugin.json` wins over a sibling `.claude-plugin/plugin.json`,
		// mirroring the MCP-config precedence, so OMP selectors survive.
		enableProvider("claude-plugins");
		await writeOmpMarketplacePlugin(tempHome, {
			agentName: "hybrid-probe",
			model: '["@advisor", "@smol"]',
			manifest: "both",
		});

		const { agents } = await discoverAgents(projectDir, tempHome);
		const agent = agents.find(candidate => candidate.name === "hybrid-probe");

		expect(agent).toBeDefined();
		expect(agent?.model).toEqual(["@advisor", "@smol"]);
	});
});
