import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runSkillsCommand } from "../../src/commands/skills";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("runSkillsCommand", () => {
	test("lists skills for a directory with public metadata", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-cmd-"));
		const skillsRoot = path.join(directory, "skills-fixture");
		await fs.mkdir(path.join(skillsRoot, "first", "calendar"), { recursive: true });
		await fs.mkdir(path.join(skillsRoot, "second", "reviewer"), { recursive: true });
		await Bun.write(
			path.join(skillsRoot, "first", "calendar", "SKILL.md"),
			"---\nname: calendar\ndescription: First calendar.\n---\n\n# Calendar (First)\n",
		);
		await Bun.write(
			path.join(skillsRoot, "second", "reviewer", "SKILL.md"),
			"---\nname: reviewer\ndescription: Review code.\n---\n\n# Reviewer\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: [path.join(skillsRoot, "first"), path.join(skillsRoot, "second")] },
			});

			expect(result.skills.map(skill => skill.name).sort()).toEqual(["calendar", "reviewer"]);
			const reviewer = result.skills.find(skill => skill.name === "reviewer");
			expect(reviewer?.description).toBe("Review code.");
			expect(reviewer?.filePath).toBe(path.join(skillsRoot, "second", "reviewer", "SKILL.md"));
			expect(reviewer?.baseDir).toBe(path.join(skillsRoot, "second", "reviewer"));
			expect(reviewer?.source).toBe("custom:user");
			expect(reviewer?.hide).toBe(false);
			// The public shape is fixed: internal `_source`/`containRoot` stay out.
			expect(Object.keys(result.skills[0]).sort()).toEqual([
				"baseDir",
				"description",
				"filePath",
				"hide",
				"name",
				"source",
			]);
		} finally {
			await removeWithRetries(directory);
		}
	});

	test("resolves relative custom directories against the requested directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skills-rel-${Snowflake.next()}-`));
		await fs.mkdir(path.join(directory, "rel-root", "calendar"), { recursive: true });
		await Bun.write(
			path.join(directory, "rel-root", "calendar", "SKILL.md"),
			"---\nname: calendar\ndescription: Relative calendar.\n---\n\n# Calendar\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: ["rel-root"] },
			});
			expect(result.skills.map(skill => skill.name)).toEqual(["calendar"]);
			expect(result.skills[0].filePath).toBe(path.join(directory, "rel-root", "calendar", "SKILL.md"));
		} finally {
			await removeWithRetries(directory);
		}
	});
});
