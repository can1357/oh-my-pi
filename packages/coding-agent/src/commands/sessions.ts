import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionsHelp as commandHelp } from "../cli/command-help";
import { runSessionsCommand } from "../cli/sessions-cli";

export default class Sessions extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "List saved sessions",
			required: true,
			options: ["list"],
		}),
	};

	static flags = {
		all: Flags.boolean({ char: "a", description: "List sessions from every project" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
	};

	static examples = [
		"omp sessions list",
		"omp sessions list --all",
		"omp sessions list --json",
		"omp sessions list --all --json",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Sessions);
		await runSessionsCommand({ flags: { all: flags.all ?? false, json: flags.json ?? false } });
	}
}
