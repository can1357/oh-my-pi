/**
 * Regression: OMP-native user-level config discovery must follow the active
 * profile. A profile relocates the agent directory to ~/.omp/profiles/<name>/agent;
 * the native provider used to read user config (commands, skills, rules, etc.)
 * from the literal home (~/.omp/agent) via `ctx.home`, leaking the default
 * profile's config into every profile. Discovery now resolves the user scope
 * through getAgentDir(), so a profile sees only its own config.
 *
 * Covers two code paths: getConfigDirs() (slash commands) and a direct
 * getAgentDir() join (skills). `os.homedir()` is mocked so the old code path
 * (ctx.home + ".omp/agent") points at the tempdir decoys below; without the fix
 * each test would load the default-profile fixture instead of the profile one.
 *
 * MCP has its own regression in mcp-profile.test.ts (separate paths array).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type Skill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { type SlashCommand, slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

async function writeSkill(skillsDir: string, name: string): Promise<void> {
	await writeFile(
		path.join(skillsDir, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: Skill ${name}.\n---\nBody.\n`,
	);
}

describe("native user-level config discovery follows the active profile", () => {
	let tempHome = "";
	let projectDir = "";
	let profileAgentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-iso-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-iso-project-"));
		profileAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-iso-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(profileAgentDir);

		// Active profile's config.
		await writeFile(path.join(profileAgentDir, "commands", "profile-cmd.md"), "Profile command.\n");
		await writeSkill(path.join(profileAgentDir, "skills"), "profile-skill");

		// Decoy: default profile's config at the literal-home path the old loader read.
		const defaultAgentDir = path.join(tempHome, ".omp", "agent");
		await writeFile(path.join(defaultAgentDir, "commands", "default-cmd.md"), "Default command.\n");
		await writeSkill(path.join(defaultAgentDir, "skills"), "default-skill");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(profileAgentDir);
	});

	test("slash commands resolve from the profile, not the default agent dir", async () => {
		clearFsCache();
		const result = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: projectDir,
			providers: ["native"],
		});
		const names = result.items.map(c => c.name);

		expect(names).toContain("profile-cmd");
		expect(names).not.toContain("default-cmd");
		expect(result.items.find(c => c.name === "profile-cmd")?._source.path).toBe(
			path.join(profileAgentDir, "commands", "profile-cmd.md"),
		);
	});

	test("skills resolve from the profile, not the default agent dir", async () => {
		clearFsCache();
		const result = await loadCapability<Skill>(skillCapability.id, {
			cwd: projectDir,
			providers: ["native"],
		});
		const names = result.items.map(s => s.name);

		expect(names).toContain("profile-skill");
		expect(names).not.toContain("default-skill");
		expect(result.items.find(s => s.name === "profile-skill")?._source.path).toBe(
			path.join(profileAgentDir, "skills", "profile-skill", "SKILL.md"),
		);
	});
});
