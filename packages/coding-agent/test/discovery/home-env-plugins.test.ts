import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	disableUserSource,
	enableProvider,
	enableUserSource,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { __resetDirsFromEnvForTests, pathIsWithin, removeWithRetries } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"CLAUDE_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const HOME_KEY = process.platform === "win32" ? "USERPROFILE" : "HOME";

async function installPlugin(home: string, registryDir: string, plugin: string, skill: string): Promise<void> {
	const installPath = path.join(home, "plugin-installs", plugin);
	const skillFile = path.join(installPath, "skills", skill, "SKILL.md");
	const registryPath = path.join(home, registryDir, "plugins", "installed_plugins.json");
	await fs.mkdir(path.dirname(skillFile), { recursive: true });
	await fs.mkdir(path.dirname(registryPath), { recursive: true });
	await fs.writeFile(skillFile, `---\nname: ${skill}\ndescription: ${skill} fixture\n---\nBody\n`);
	await fs.writeFile(
		registryPath,
		JSON.stringify({
			version: 2,
			plugins: { [`${plugin}@market`]: [{ scope: "user", installPath, version: "1.0.0" }] },
		}),
	);
}

// Bun's os.homedir() keeps the home the process started with, so a test (or a
// subagent worker) that points HOME at a temp dir used to discover the
// developer's real ~/.omp and ~/.claude plugins.
describe("plugin discovery under a HOME set after start-up", () => {
	let root = "";
	let home = "";
	let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		savedEnv = {};
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-home-env-plugins-"));
		home = path.join(root, "home");
		for (const key of ENV_KEYS) delete process.env[key];
		process.env[HOME_KEY] = home;
		__resetDirsFromEnvForTests();
		clearClaudePluginRootsCache();
		clearFsCache();
		enableProvider("claude-plugins");
		enableUserSource("claude-plugins");
	});

	afterEach(async () => {
		disableUserSource("claude-plugins");
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		clearClaudePluginRootsCache();
		clearFsCache();
		await removeWithRetries(root);
	});

	test("reads omp and Claude plugin registries from the runtime home only", async () => {
		await installPlugin(home, ".omp", "omp-owned", "runtime-home-omp-skill");
		await installPlugin(home, ".claude", "claude-owned", "runtime-home-claude-skill");
		const cwd = path.join(root, "work");
		await fs.mkdir(cwd, { recursive: true });

		const result = await loadCapability<Skill>("skills", { cwd });
		const pluginSkills = result.all.filter(skill => skill._source.provider === "claude-plugins");

		expect(pluginSkills.map(skill => skill.name).sort()).toEqual([
			"runtime-home-claude-skill",
			"runtime-home-omp-skill",
		]);
		for (const skill of pluginSkills) expect(pathIsWithin(home, skill.path)).toBe(true);
	});
});
