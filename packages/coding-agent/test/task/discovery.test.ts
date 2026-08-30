import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import {
	clearOmpExtensionCliRoots,
	injectOmpExtensionCliRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import {
	discoverAgents,
	resolveAgentDefinitionIdentities,
	resolveAgentDefinitionIdentity,
} from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getAgentDir, getConfigAgentDirName, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

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

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		enableProvider("omp-plugins");
		clearOmpExtensionCliRoots();
		clearFsCache();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	test("treats the supplied home as authoritative over the ambient agent directory", async () => {
		const suppliedHome = path.join(tempHome, "supplied-home");
		const suppliedAgentsDir = path.resolve(suppliedHome, getConfigAgentDirName(), "agents");
		const ambientAgentDir = path.join(tempHome, "ambient-agent-dir");
		const ambientAgentsDir = path.join(ambientAgentDir, "agents");
		await Promise.all([
			fs.mkdir(suppliedAgentsDir, { recursive: true }),
			fs.mkdir(ambientAgentsDir, { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(suppliedAgentsDir, "home-authority.md"),
				["---", "name: home-authority", "description: supplied home", "---", "supplied body"].join("\n"),
			),
			fs.writeFile(
				path.join(ambientAgentsDir, "home-authority.md"),
				["---", "name: home-authority", "description: ambient directory", "---", "ambient body"].join("\n"),
			),
		]);
		setAgentDir(ambientAgentDir);
		vi.spyOn(os, "homedir").mockReturnValue(suppliedHome);

		const selected = (await discoverAgents(projectDir, suppliedHome)).agents.find(
			agent => agent.name === "home-authority",
		);

		expect(selected?.description).toBe("supplied home");
		expect(selected?.filePath).toBe(path.join(suppliedAgentsDir, "home-authority.md"));
	});

	test("keeps valid directory siblings when one agent definition is malformed", async () => {
		const agentsDir = path.resolve(tempHome, getConfigAgentDirName(), "agents");
		await fs.mkdir(agentsDir, { recursive: true });
		await Promise.all([
			fs.writeFile(
				path.join(agentsDir, "valid-sibling.md"),
				["---", "name: valid-sibling", "description: valid sibling", "---", "valid body"].join("\n"),
			),
			fs.writeFile(path.join(agentsDir, "broken-sibling.md"), ["---", "name: broken-sibling", "---"].join("\n")),
		]);

		const { agents } = await discoverAgents(projectDir, tempHome);

		expect(agents.find(agent => agent.name === "valid-sibling")?.description).toBe("valid sibling");
		expect(agents.some(agent => agent.name === "broken-sibling")).toBe(false);
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

	test("resolves the authoritative same-name winner with distinct user and extension identities", async () => {
		const extensionRoot = path.join(tempHome, "identity-extension");
		const extensionAgent = path.join(extensionRoot, "agents", "identity-agent.md");
		const userAgent = path.join(tempHome, ".omp", "agent", "agents", "identity-agent.md");
		const extensionDefinition = [
			"---",
			"name: identity-agent",
			"description: extension definition",
			"---",
			"extension body",
		].join("\n");
		const userDefinition = extensionDefinition.replace("extension definition", "user override");
		await fs.mkdir(path.dirname(extensionAgent), { recursive: true });
		await fs.mkdir(path.dirname(userAgent), { recursive: true });
		await fs.writeFile(extensionAgent, extensionDefinition);
		await fs.writeFile(
			path.join(extensionRoot, "agents", "task.md"),
			extensionDefinition.replace("identity-agent", "task"),
		);
		await fs.writeFile(userAgent, userDefinition);
		injectOmpExtensionCliRoots([extensionRoot], tempHome, projectDir, { mode: "explicit-only" });

		const selectedWithOverride = (await discoverAgents(projectDir, tempHome)).agents.find(
			agent => agent.name === "identity-agent",
		);
		const userIdentity = await resolveAgentDefinitionIdentity(projectDir, "identity-agent", tempHome);
		expect(selectedWithOverride?.description).toBe("user override");
		expect(selectedWithOverride?.source).toBe("user");
		expect(userIdentity).toMatchObject({ schemaVersion: 1, originKind: "user" });

		await fs.rm(userAgent);
		clearFsCache();
		const selectedWithoutOverride = (await discoverAgents(projectDir, tempHome)).agents.find(
			agent => agent.name === "identity-agent",
		);
		const extensionIdentity = await resolveAgentDefinitionIdentity(projectDir, "identity-agent", tempHome);
		expect(selectedWithoutOverride?.description).toBe("extension definition");
		expect(selectedWithoutOverride?.source).toBe("user");
		expect(extensionIdentity).toMatchObject({ schemaVersion: 1, originKind: "extension" });
		expect(extensionIdentity).not.toEqual(userIdentity);
		await fs.writeFile(extensionAgent, extensionDefinition.replace("extension body", "changed extension body"));
		clearFsCache();
		const changedExtensionIdentity = await resolveAgentDefinitionIdentity(projectDir, "identity-agent", tempHome);
		expect(changedExtensionIdentity?.originId).toBe(extensionIdentity?.originId);
		expect(changedExtensionIdentity?.definitionId).not.toBe(extensionIdentity?.definitionId);

		const projectAgent = path.join(projectDir, ".omp", "agents", "identity-agent.md");
		await fs.mkdir(path.dirname(projectAgent), { recursive: true });
		await fs.writeFile(projectAgent, extensionDefinition.replace("extension definition", "project override"));
		clearFsCache();
		const projectIdentity = await resolveAgentDefinitionIdentity(projectDir, "identity-agent", tempHome);
		expect(projectIdentity).toMatchObject({ schemaVersion: 1, originKind: "project" });
		expect(projectIdentity).not.toEqual(extensionIdentity);

		const extensionTaskIdentity = await resolveAgentDefinitionIdentity(projectDir, "task", tempHome);
		expect(extensionTaskIdentity).toMatchObject({ schemaVersion: 1, originKind: "extension" });
		expect(extensionTaskIdentity?.originId).toBe(extensionIdentity?.originId);
		expect(extensionTaskIdentity?.definitionId).not.toBe(extensionIdentity?.definitionId);
		await fs.rm(path.join(extensionRoot, "agents", "task.md"));
		clearFsCache();
		const bundledTaskIdentity = await resolveAgentDefinitionIdentity(projectDir, "task", tempHome);
		expect(bundledTaskIdentity).toMatchObject({ schemaVersion: 1, originKind: "bundled" });
		expect(bundledTaskIdentity).not.toEqual(extensionTaskIdentity);
	});

	test("returns a frozen null-prototype identity map for hostile and missing names", async () => {
		const userAgent = path.join(tempHome, ".omp", "agent", "agents", "hostile-name.md");
		await fs.mkdir(path.dirname(userAgent), { recursive: true });
		await fs.writeFile(
			userAgent,
			["---", "name: __proto__", "description: hostile property name", "---", "body"].join("\n"),
		);

		const identities = await resolveAgentDefinitionIdentities(projectDir, ["__proto__", "missing-agent"], tempHome);

		expect(Object.getPrototypeOf(identities)).toBeNull();
		expect(Object.isFrozen(identities)).toBe(true);
		expect(Object.keys(identities)).toEqual(["__proto__"]);
		const hostileIdentity = identities[["__", "proto__"].join("")];
		expect(hostileIdentity).toMatchObject({ schemaVersion: 1, originKind: "user" });
		expect(Object.isFrozen(hostileIdentity)).toBe(true);
		expect(Object.hasOwn(identities, "missing-agent")).toBe(false);
	});
});
