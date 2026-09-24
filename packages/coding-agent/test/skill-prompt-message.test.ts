import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

async function createSkill(body: string): Promise<{ dir: string; skill: Skill }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skill-prompt-${Snowflake.next()}-`));
	const filePath = path.join(dir, "SKILL.md");
	await Bun.write(filePath, `---\nname: reviewer\ndescription: Review code\n---\n\n${body}\n`);
	return {
		dir,
		skill: {
			name: "reviewer",
			description: "Review code",
			filePath,
			baseDir: dir,
			source: "test",
		},
	};
}

describe("buildSkillPromptMessage", () => {
	test("defaults public skill prompt rendering to user-invoked bug-fix directory guidance", async () => {
		const { dir, skill } = await createSkill("Review the supplied code carefully.");
		try {
			const built = await buildSkillPromptMessage([skill], {
				args: "focus on risks",
				prompt: "/skill:reviewer focus on risks",
			});

			expect(built.message).toContain("Review the supplied code carefully.");
			expect(built.message).toContain(`[Skill directory: ${dir}]`);
			expect(built.message).toContain("focus on risks");
			// The raw draft is display-only: it never reaches the wire text.
			expect(built.message).not.toContain("/skill:reviewer");
			expect(built.details).toMatchObject({
				name: "reviewer",
				path: skill.filePath,
				args: "focus on risks",
				prompt: "/skill:reviewer focus on risks",
				lineCount: 1,
				skills: [{ name: "reviewer", path: skill.filePath, lineCount: 1 }],
			});
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("renders multiple skills in single prompt", async () => {
		const skill1 = await createSkill("Body 1");
		const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skill-prompt-2-${Snowflake.next()}-`));
		const filePath2 = path.join(dir2, "SKILL.md");
		await Bun.write(filePath2, `---\nname: helper\ndescription: Help\n---\n\nBody 2\n`);
		const skill2 = {
			name: "helper",
			description: "Help",
			filePath: filePath2,
			baseDir: dir2,
			source: "test",
		};
		try {
			const built = await buildSkillPromptMessage([skill1.skill, skill2], {
				args: "do both",
				prompt: "/skill:reviewer /skill:helper do both",
			});

			expect(built.message).toContain('User invoked the "reviewer" skill');
			expect(built.message).toContain("Body 1");
			expect(built.message).toContain(`[Skill directory: ${skill1.dir}]`);
			expect(built.message).toContain('User invoked the "helper" skill');
			expect(built.message).toContain("Body 2");
			expect(built.message).toContain(`[Skill directory: ${dir2}]`);
			expect(built.message).toContain("User: do both");
			expect(built.details.skills).toEqual([
				{ name: "reviewer", path: skill1.skill.filePath, lineCount: 1 },
				{ name: "helper", path: filePath2, lineCount: 1 },
			]);
		} finally {
			await removeWithRetries(skill1.dir);
			await removeWithRetries(dir2);
		}
	});

	test("keeps autoload skills on non-user minimal framing", async () => {
		const { dir, skill } = await createSkill("Review silently loaded context.");
		try {
			const built = await buildSkillPromptMessage([skill], { args: "" }, "autoload");

			expect(built.message).toContain("Review silently loaded context.");
			expect(built.message).toContain(`Skill: ${skill.filePath}`);
			expect(built.message).not.toContain("The user has invoked");
			expect(built.message).not.toContain("[Skill directory:");
			expect(built.details).toMatchObject({ name: "reviewer", path: skill.filePath, lineCount: 1 });
		} finally {
			await removeWithRetries(dir);
		}
	});
});
