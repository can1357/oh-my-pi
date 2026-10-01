/**
 * Start a tutorial lesson from the CLI: launches the interactive TUI and
 * immediately runs `/tutorial <id>` (bare `omp tutorial` lists the lessons).
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { tutorialHelp as commandHelp } from "../cli/command-help";
import { runRootCommand } from "../main";

export default class Tutorial extends Command {
	static description = commandHelp.description;
	static args = {
		lesson: Args.string({ description: "Lesson id (omit to list lessons)", required: false }),
	};

	static examples = [`${APP_NAME} tutorial`, `${APP_NAME} tutorial basics`];

	async run(): Promise<void> {
		const { args } = await this.parse(Tutorial);
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stderr.write(`${APP_NAME} tutorial requires an interactive terminal\n`);
			process.exitCode = 1;
			return;
		}
		const parsed = parseArgs([]);
		parsed.tutorial = args.lesson?.trim() ?? "";
		await runRootCommand(parsed, []);
	}
}
