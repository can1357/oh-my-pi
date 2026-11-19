/** Inspect and maintain image publication backends. */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { imagesHelp as commandHelp } from "../cli/command-help";
import { IMAGES_ACTIONS, type ImagesAction, type ImagesCommandArgs, runImagesCommand } from "../cli/images-cli";

export default class Images extends Command {
	static description = commandHelp.description;
	static aliases = ["img"];
	static args = {
		action: Args.string({
			description: "status (default), doctor, probe, or purge",
			required: false,
			options: [...IMAGES_ACTIONS],
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Output one JSON document" }),
		apply: Flags.boolean({ description: "Apply purge deletions (default is dry-run)" }),
		all: Flags.boolean({ description: "Purge all entries instead of expired entries only" }),
		dir: Flags.string({ description: "Project directory (default: current directory)" }),
		timeout: Flags.integer({ description: "External health probe timeout in seconds" }),
	};
	static examples = [
		"omp images",
		"omp images status --json",
		"omp images doctor",
		"omp images probe --timeout 15",
		"omp images purge",
		"omp images purge --all --apply",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Images);
		const command: ImagesCommandArgs = {
			action: (args.action ?? "status") as ImagesAction,
			flags: {
				json: flags.json,
				apply: flags.apply,
				all: flags.all,
				dir: flags.dir,
				timeout: flags.timeout,
			},
		};
		const result = await runImagesCommand(command);
		if (result.exitCode !== 0) process.exitCode = result.exitCode;
	}
}
