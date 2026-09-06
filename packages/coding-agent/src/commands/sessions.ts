import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionsHelp as commandHelp } from "../cli/command-help";
import { runSessionRootsCommand, runSessionsCommand } from "../cli/sessions-cli";
import { CliUsageError } from "../cli/usage-error";

export default class Sessions extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "List sessions or working directories",
			required: true,
			options: ["list", "roots"],
		}),
	};

	static flags = {
		all: Flags.boolean({ char: "a", description: "List sessions from every project (list)" }),
		cwd: Flags.string({ description: "List sessions from this working directory (list)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
	};

	static examples = [
		"omp sessions list",
		"omp sessions list --cwd ~/projects/app",
		"omp sessions list --all --json",
		"omp sessions roots",
		"omp sessions roots --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Sessions);
		if (args.action === "roots") {
			if (flags.all) throw new CliUsageError("--all only applies to sessions list");
			if (flags.cwd) throw new CliUsageError("--cwd only applies to sessions list");
			await runSessionRootsCommand(flags.json ?? false);
			return;
		}
		if (flags.all && flags.cwd) throw new CliUsageError("--all and --cwd are mutually exclusive");
		await runSessionsCommand({
			flags: { all: flags.all ?? false, cwd: flags.cwd, json: flags.json ?? false },
		});
	}
}
