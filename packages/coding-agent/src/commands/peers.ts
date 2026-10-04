/** Discover and message other omp processes on this machine. */
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { peersHelp as commandHelp } from "../cli/command-help";
import { runPeersCommand } from "../cli/peers-cli";

export default class Peers extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: "list (default) or send", required: false, options: ["list", "send"] }),
		to: Args.string({ description: "Peer address or alias (send only)", required: false }),
		message: Args.string({ description: "Message text (send only)", required: false, multiple: true }),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit peer metadata as JSON (list only)", default: false }),
	};

	static examples = ["omp peers list", "omp peers list --json", "omp peers send <address|alias> <message...>"];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Peers);
		if ((args.action ?? "list") === "list") {
			if (argv.length > 1) {
				throw new CliUsageError("peers list accepts no arguments (usage: peers list [--json])");
			}
			process.exitCode = await runPeersCommand({ action: "list", json: flags.json });
			return;
		}

		const body = Array.isArray(args.message) ? args.message.join(" ") : (args.message ?? "");
		if (!args.to || !body.trim() || flags.json) {
			throw new CliUsageError(
				"peers send requires an address or alias and a message, without --json (usage: peers send <address|alias> <message...>)",
			);
		}
		process.exitCode = await runPeersCommand({ action: "send", to: args.to, body });
	}
}
