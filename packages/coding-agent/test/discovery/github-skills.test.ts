/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1906
 *
 * The `github` discovery provider previously registered only context-files and
 * instructions, leaving `.github/skills/<name>/SKILL.md` — the layout GitHub
 * documents for agent skills — silently unscanned. This test pins the wiring:
 * loading the `skills` capability with the github provider scoped to a cwd
 * containing `.github/skills/<name>/SKILL.md` must surface the skill.
 *
 * @see https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/capability/skill";
import "@oh-my-pi/pi-coding-agent/discovery/github";

function writeSkill(root: string, name: string, description: string | null): void {
	const skillDir = path.join(root, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const frontmatter =
		description === null ? `---\nname: ${name}\n---\n` : `---\nname: ${name}\ndescription: ${description}\n---\n`;
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), `${frontmatter}\n# ${name}\n\nSkill body.\n`);
}

describe("github discovery — skills", () => {
	let tempDir!: string;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-github-skills-"));
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	test("discovers .github/skills/<name>/SKILL.md via the github provider", async () => {
		writeSkill(path.join(tempDir, ".github", "skills"), "demo-skill", "Demo skill for Copilot");

		const result = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["github"] });

		const found = result.all.find(skill => skill.name === "demo-skill");
		expect(found).toBeDefined();
		expect(found?.path).toBe(path.join(tempDir, ".github", "skills", "demo-skill", "SKILL.md"));
		expect(found?.level).toBe("project");
		expect(found?._source.provider).toBe("github");
		expect(result.warnings).toEqual([]);
	});

	test("skips skills missing a description (matches GitHub agent-skills standard)", async () => {
		writeSkill(path.join(tempDir, ".github", "skills"), "no-desc", null);

		const result = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["github"] });

		expect(result.all.find(skill => skill.name === "no-desc")).toBeUndefined();
	});

	test("returns no skills when .github/skills/ is absent", async () => {
		const result = await loadCapability<Skill>("skills", { cwd: tempDir, providers: ["github"] });

		expect(result.all).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});
