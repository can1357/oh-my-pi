/**
 * List active local Collab host sessions.
 */
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCollabListCommand } from "../cli/collab-cli";
import { collabHelp as commandHelp } from "../cli/command-help";

export default class Collab extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default)",
			required: false,
			options: ["list"],
			default: "list",
		}),
	};

	static flags = {
		view: Flags.boolean({
			description: "Print view-only URLs instead of write-capable URLs (same hosts, weaker capability)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit deterministic machine-readable JSON", default: false }),
	};

	static examples = ["omp collab list", "omp collab list --view", "omp collab list --json"];

	async run(): Promise<void> {
		const { argv, flags } = await this.parse(Collab);
		// parse() validates argv[0] against the `action` arg but leaves any
		// further positionals untouched. Honor the `/collab list view` spelling
		// and reject everything else — trailing junk must never silently
		// degrade into write-capable output.
		let view = flags.view ?? false;
		const extras: string[] = [];
		for (const token of argv.slice(1)) {
			if (token === "view") view = true;
			else extras.push(token);
		}
		if (extras.length > 0) {
			throw new CliUsageError(
				`Unknown argument${extras.length === 1 ? "" : "s"}: ${extras.join(" ")} (usage: collab list [view] [--view] [--json])`,
			);
		}
		await runCollabListCommand({ view, json: flags.json ?? false });
	}
}
