import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const OTHER_SOURCES_OFF = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
};

async function writeSkill(root: string, name: string): Promise<void> {
	const dir = path.join(root, name);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "SKILL.md"), `---\ndescription: ${name} description\n---\n\n# ${name}\n`);
}

describe("OpenCode skills discovery", () => {
	let home = "";
	let cwd = "";

	beforeEach(async () => {
		home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-opencode-skills-home-")));
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-opencode-skills-cwd-")));
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		await writeSkill(path.join(home, ".config", "opencode", "skills"), "opencode-user-skill");
		await writeSkill(path.join(cwd, ".opencode", "skills"), "opencode-project-skill");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		await removeWithRetries(home);
		await removeWithRetries(cwd);
	});

	async function names(toggle: boolean, settingOverrides: Record<string, unknown> = {}): Promise<string[]> {
		await Settings.init({ inMemory: true, cwd, overrides: settingOverrides });
		const { skills } = await loadSkills({ ...OTHER_SOURCES_OFF, enableOpencodeUser: toggle, cwd });
		return skills.map(skill => skill.name).sort();
	}

	test("user skills stay off by default and the project skills load", async () => {
		expect(await names(false)).toEqual(["opencode-project-skill"]);
	});

	test("skills.enableOpencodeUser admits ~/.config/opencode/skills without enabling the provider", async () => {
		expect(await names(true, { "skills.enableOpencodeUser": true })).toEqual([
			"opencode-project-skill",
			"opencode-user-skill",
		]);
	});
});
