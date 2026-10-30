/**
 * Test grep tool.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { GrepOutputMode } from "@oh-my-pi/pi-natives";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { grepHelp as commandHelp } from "../cli/command-help";
import { type GrepCommandArgs, runGrepCommand } from "../cli/grep-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Grep extends Command {
	static description = commandHelp.description;
	static args = {
		pattern: Args.string({ description: __ompTranslate("Regex pattern to search for"), required: false }),
		path: Args.string({ description: __ompTranslate("Directory or file to search"), required: false }),
	};

	static flags = {
		glob: Flags.string({ char: "g", description: __ompTranslate("Filter files by glob pattern") }),
		limit: Flags.integer({ char: "l", description: __ompTranslate("Max matches"), default: 20 }),
		context: Flags.integer({ char: "C", description: __ompTranslate("Context lines"), default: 2 }),
		files: Flags.boolean({ char: "f", description: __ompTranslate("Output file names only") }),
		count: Flags.boolean({ char: "c", description: __ompTranslate("Output match counts per file") }),
		"no-gitignore": Flags.boolean({ description: __ompTranslate("Include files excluded by .gitignore") }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Grep);

		const mode: GrepCommandArgs["mode"] = flags.count
			? GrepOutputMode.Count
			: flags.files
				? GrepOutputMode.FilesWithMatches
				: GrepOutputMode.Content;

		const cmd: GrepCommandArgs = {
			pattern: args.pattern ?? "",
			path: args.path ?? ".",
			glob: flags.glob,
			limit: flags.limit,
			context: flags.context,
			mode,
			gitignore: !flags["no-gitignore"],
		};

		await initTheme();
		await runGrepCommand(cmd);
	}
}
