import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
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
	const { dir, skill } = await createSkill("");
	await Bun.write(skill.filePath, raw);
	return { dir, skill };
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

	test("omits CRLF frontmatter but keeps body HTML comments in skill messages", async () => {
		const { dir, skill } = await createSkill("Review the supplied code carefully.");
		try {
			await Bun.write(
				skill.filePath,
				"---\r\nname: reviewer\r\ndescription: Review code\r\n---\r\n\r\nReview the supplied code carefully.\r\n<!-- Never skip tests. -->\r\n",
			);
			for (const invocation of ["user", "autoload"] as const) {
				const built = await buildSkillPromptMessage(skill, { args: "" }, invocation);
				expect(built.message).toContain("Review the supplied code carefully.\n<!-- Never skip tests. -->");
				expect(built.message).not.toContain("description: Review code");
				expect(built.message).not.toContain("name: reviewer");
			}
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("strips frontmatter whose closing delimiter ends the file", async () => {
		const { dir, skill } = await createSkillFromRaw("---\nname: reviewer\ndescription: Review code\n---");
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" }, "autoload");
			expect(built.message).not.toContain("name: reviewer");
			expect(built.details.lineCount).toBe(0);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("trims a skill body without frontmatter before the autoload separator", async () => {
		const { dir, skill } = await createSkillFromRaw("Plain skill body.\n");
		try {
			const built = await buildSkillPromptMessage(skill, { args: "" }, "autoload");
			expect(built.message.startsWith("Plain skill body.\n\n---\n")).toBe(true);
			expect(built.details.lineCount).toBe(1);
		} finally {
			await removeWithRetries(dir);
		}
	});

	describe("Claude Code tool-name note", () => {
		const NOTE = "This skill was written for Claude Code. In omp:";
		const sourceFor = (provider: string, dir: string): Skill["_source"] => ({
			provider,
			providerName: provider,
			path: dir,
			level: "user",
		});

		test("maps the tool names a Claude skill mentions", async () => {
			const { dir, skill } = await createSkill("Track work with TodoWrite, then delegate via the Task tool.");
			try {
				const built = await buildSkillPromptMessage({ ...skill, _source: sourceFor("claude", dir) }, { args: "" });
				expect(built.message).toContain(`${NOTE} TodoWrite → todo, Task → task.`);
			} finally {
				await removeWithRetries(dir);
			}
		});

		test("leaves a Claude skill that only uses plain words unchanged", async () => {
			const { dir, skill } = await createSkill("Finish the task, then `read` and edit the files.");
			try {
				const built = await buildSkillPromptMessage({ ...skill, _source: sourceFor("claude", dir) }, { args: "" });
				expect(built.message).toContain("Finish the task, then `read` and edit the files.");
				expect(built.message).not.toContain("written for Claude Code");
			} finally {
				await removeWithRetries(dir);
			}
		});

		test("annotates a whole read of a Claude skill through skill://", async () => {
			const { dir, skill } = await createSkill("Track work with TodoWrite.");
			try {
				const session: ToolSession = {
					cwd: dir,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated(),
					skills: [{ ...skill, _source: sourceFor("claude", dir) }],
				};
				const readText = async (target: string) => {
					const result = await new ReadTool(session).execute("read-claude-skill", { path: target });
					return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
				};
				expect(await readText("skill://reviewer")).toContain(`${NOTE} TodoWrite → todo.`);
				expect(await readText("skill://reviewer:raw")).not.toContain(NOTE);
			} finally {
				await removeWithRetries(dir);
			}
		});

		test("ignores Claude tool names that appear only in frontmatter across all delivery paths", async () => {
			const raw =
				"---\nname: reviewer\ndescription: Use TodoWrite\nallowed-tools: WebFetch\n---\n\nReview the files.\n";
			const { dir, skill } = await createSkillFromRaw(raw);
			const claudeSkill = { ...skill, _source: sourceFor("claude", dir) };
			try {
				const built = await buildSkillPromptMessage(claudeSkill, { args: "" });
				expect(built.message).not.toContain(NOTE);

				const session: ToolSession = {
					cwd: dir,
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated(),
					skills: [claudeSkill],
				};
				const readResult = await new ReadTool(session).execute("read-claude-frontmatter", {
					path: "skill://reviewer",
				});
				const readText = readResult.content
					.flatMap(block => (block.type === "text" ? [block.text] : []))
					.join("\n");
				expect(readText).not.toContain(NOTE);

				const resolved = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://reviewer"), {
					skills: [claudeSkill],
				});
				expect(resolved.content).toBe(raw);
			} finally {
				await removeWithRetries(dir);
			}
		});

		test("preserves raw formatting and trailing newlines when SkillProtocolHandler appends the note", async () => {
			const raw = "---\nname: reviewer\ndescription: Review code\n---\n\nFirst paragraph.\n\n\nUse TodoWrite.\n";
			const { dir, skill } = await createSkillFromRaw(raw);
			const claudeSkill = { ...skill, _source: sourceFor("claude", dir) };
			try {
				const resolved = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://reviewer"), {
					skills: [claudeSkill],
				});
				expect(resolved.content).toBe(`${raw}\n\n${NOTE} TodoWrite → todo.`);
			} finally {
				await removeWithRetries(dir);
			}
		});

		test("never annotates skills from other providers", async () => {
			const { dir, skill } = await createSkill("Track work with TodoWrite.");
			try {
				const built = await buildSkillPromptMessage({ ...skill, _source: sourceFor("native", dir) }, { args: "" });
				expect(built.message).toContain("Track work with TodoWrite.");
				expect(built.message).not.toContain("written for Claude Code");
			} finally {
				await removeWithRetries(dir);
			}
		});
	});
});
