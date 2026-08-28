/**
 * List saved sessions across every project, grouped by their primary checkout.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sessionsHelp as commandHelp } from "../cli/command-help";
import { collectSessions, formatSessions } from "../cli/sessions-cli";

export default class Sessions extends Command {
	static description = commandHelp.description;

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		limit: Flags.integer({ char: "n", description: "Return at most this many sessions" }),
		project: Flags.string({
			char: "p",
			description: "Only sessions whose project root (or cwd) matches this path",
		}),
	};

	static examples = [
		"omp sessions",
		"omp sessions --json",
		"omp sessions --json --limit 50",
		"omp sessions --project .",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Sessions);
		const entries = await collectSessions({
			json: flags.json ?? false,
			limit: flags.limit,
			project: flags.project,
		});

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
			return;
		}

		process.stdout.write(`${formatSessions(entries)}\n`);
	}
}
