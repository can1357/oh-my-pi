import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tryRunRpcSkillCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("tryRunRpcSkillCommand", () => {
	test("dispatches registered /skill commands as skill prompt messages", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let message: Pick<CustomMessage, "attribution" | "content" | "customType" | "details" | "display"> | undefined;
		let options: { streamingBehavior?: "steer" | "followUp" } | undefined;

		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage(nextMessage: typeof message, nextOptions?: typeof options) {
					message = nextMessage;
					options = nextOptions;
				},
			},
			"/skill:reviewer focus on risks",
		);

		expect(handled).toEqual({ agentInvoked: true });
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.content).toContain("Review the supplied code carefully.");
		expect(message?.content).toContain(`[Skill directory: ${dir}]`);
		expect(message?.content).toContain("focus on risks");
		expect(message?.display).toBe(true);
		expect(message?.attribution).toBe("user");
		expect(options).toEqual({ streamingBehavior: "steer" });

		await removeWithRetries(dir);
	});

	test("honors the RPC prompt streaming behavior for registered /skill commands", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let options: { streamingBehavior?: "steer" | "followUp" } | undefined;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage(nextMessage, nextOptions) {
						expect(nextMessage.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
						options = nextOptions;
					},
				},
				"/skill:reviewer wait for the current turn",
				"followUp",
			);

			expect(handled).toEqual({ agentInvoked: true });
			expect(options?.streamingBehavior).toBe("followUp");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("ignores unknown skill commands so normal prompt handling can continue", async () => {
		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					throw new Error("should not dispatch unknown skills");
				},
			},
			"/skill:missing",
		);

		expect(handled).toBe(false);
	});

	test("does not steal builtin slash-command arguments that mention registered skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let dispatched = false;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage() {
						dispatched = true;
					},
				},
				"/compact /skill:reviewer",
			);

			expect(handled).toBe(false);
			expect(dispatched).toBe(false);
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("refuses dispatch for user-invocable: false skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: internal\ndescription: Internal skill\n---\n\nInternal content.\n");

		let message: Pick<CustomMessage, "customType"> | undefined;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "internal",
							description: "Internal skill",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
							userInvocable: false,
						},
					],
					async promptCustomMessage(nextMessage) {
						message = nextMessage;
					},
				},
				"/skill:internal do it",
			);

			expect(handled).toBe(false);
			expect(message).toBeUndefined();
		} finally {
			await removeWithRetries(dir);
		}
	});
});
