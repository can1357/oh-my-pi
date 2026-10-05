import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
		await writeSkill(path.join(home, ".config", "opencode", "skills"), "opencode-user-skill");
		await writeSkill(path.join(cwd, ".opencode", "skills"), "opencode-project-skill");
		// The process-global settings stay uninitialized: only the options passed to loadSkills() decide.
		resetSettingsForTest();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(home);
		await removeWithRetries(cwd);
	});

	async function opencodeSkills(overrides: Record<string, unknown>): Promise<string[]> {
		const sessionSettings = Settings.isolated(overrides);
		const { skills } = await loadSkills({ ...cfgSkills.get(sessionSettings), cwd });
		return skills
			.filter(skill => skill.source.startsWith("opencode:"))
			.map(skill => skill.name)
			.sort();
	}

	test("user skills stay off by default and the project skills load", async () => {
		expect(await opencodeSkills({})).toEqual(["opencode-project-skill"]);
	});

	test("a session's skills.enableOpencodeUser admits ~/.config/opencode/skills without enabling the provider", async () => {
		expect(await opencodeSkills({ "skills.enableOpencodeUser": true })).toEqual([
			"opencode-project-skill",
			"opencode-user-skill",
		]);
	});

	test("one session's opt-in does not leak into the next", async () => {
		expect(await opencodeSkills({ "skills.enableOpencodeUser": true })).toContain("opencode-user-skill");
		expect(await opencodeSkills({})).toEqual(["opencode-project-skill"]);
	});
});
