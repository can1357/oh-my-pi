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

async function createSkillFromRaw(raw: string): Promise<{ dir: string; skill: Skill }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skill-prompt-${Snowflake.next()}-`));
	const filePath = path.join(dir, "SKILL.md");
	await Bun.write(filePath, raw);
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
			const built = await buildSkillPromptMessage(skill, {
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
			});
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("keeps autoload skills on non-user minimal framing", async () => {
		const { dir, skill } = await createSkill("Review silently loaded context.");
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" }, "autoload");

			expect(built.message).toContain("Review silently loaded context.");
			expect(built.message).toContain(`Skill: ${skill.filePath}`);
			expect(built.message).not.toContain("The user has invoked");
			expect(built.message).not.toContain("[Skill directory:");
			expect(built.details).toMatchObject({ name: "reviewer", path: skill.filePath, lineCount: 1 });
		} finally {
			await removeWithRetries(dir);
		}
	});
	test("strips CRLF frontmatter without leaking raw YAML", async () => {
		const { dir, skill } = await createSkillFromRaw(
			"---\r\nname: reviewer\r\ndescription: Review code\r\n---\r\n\r\nReview with CRLF line endings.\r\n",
		);
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" });

			expect(built.message).toContain("Review with CRLF line endings.");
			expect(built.message).not.toContain("name: reviewer");
			expect(built.message).not.toContain("description: Review code");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("preserves HTML comments in the skill body", async () => {
		const { dir, skill } = await createSkillFromRaw(
			"---\nname: reviewer\ndescription: Review code\n---\n\nBody with <!-- note --> inside.\n",
		);
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" });

			expect(built.message).toContain("Body with <!-- note --> inside.");
			expect(built.message).not.toContain("name: reviewer");
			expect(built.message).not.toContain("description: Review code");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("strips frontmatter whose closing delimiter is at EOF with no trailing newline", async () => {
		const { dir, skill } = await createSkillFromRaw("---\nname: reviewer\ndescription: Review code\n---");
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" });

			expect(built.message).not.toContain("name: reviewer");
			expect(built.message).not.toContain("description: Review code");
			expect(built.details.lineCount).toBe(0);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("leaves content without frontmatter unchanged", async () => {
		const { dir, skill } = await createSkillFromRaw("Just a plain body, no frontmatter.\n");
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" });

			expect(built.message).toContain("Just a plain body, no frontmatter.");
		} finally {
			await removeWithRetries(dir);
		}
	});

});
