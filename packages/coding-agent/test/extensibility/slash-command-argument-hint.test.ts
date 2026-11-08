import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";

describe("loadSlashCommands argument-hint", () => {
	test("parses argument-hint frontmatter into FileSlashCommand.argumentHint", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-arg-hint-"));
		try {
			const commandsDir = path.join(cwd, ".agent", "commands");
			await fs.mkdir(commandsDir, { recursive: true });
			await Bun.write(
				path.join(commandsDir, "git-sync-branch.md"),
				[
					"---",
					"description: Rebase current branch",
					'argument-hint: "[base-branch]"',
					"---",
					"Rebase onto $ARGUMENTS",
					"",
				].join("\n"),
			);
			await Bun.write(
				path.join(commandsDir, "plain.md"),
				["---", "description: No hint here", "---", "Body", ""].join("\n"),
			);

			const commands = await loadSlashCommands({ cwd });
			const withHint = commands.find(command => command.name === "git-sync-branch");
			const withoutHint = commands.find(command => command.name === "plain");

			expect(withHint?.argumentHint).toBe("[base-branch]");
			expect(withoutHint?.argumentHint).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	test("parses side: true frontmatter, leaving other commands as main-session prompts", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-side-cmd-"));
		try {
			const commandsDir = path.join(cwd, ".agent", "commands");
			await fs.mkdir(commandsDir, { recursive: true });
			await Bun.write(
				path.join(commandsDir, "sitrep.md"),
				["---", "description: Situation report", "side: true", "---", "Report status", ""].join("\n"),
			);
			await Bun.write(
				path.join(commandsDir, "quoted.md"),
				["---", "description: Quoted flag", 'side: "true"', "---", "Body", ""].join("\n"),
			);

			const commands = await loadSlashCommands({ cwd });

			expect(commands.find(command => command.name === "sitrep")?.side).toBe(true);
			expect(commands.find(command => command.name === "quoted")?.side).toBeUndefined();
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
