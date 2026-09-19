/**
 * Compact fleet summary of operator cockpit seats.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { seatsHelp as commandHelp } from "../cli/command-help";
import { type SeatsCommandArgs, runSeatsCommand } from "../cli/seats-cli";

export default class Seats extends Command {
	static description = commandHelp.description;

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		host: Flags.string({ description: "Operator web host", default: "127.0.0.1" }),
		port: Flags.integer({ char: "p", description: "Operator web port", default: 4180 }),
	};

	static examples = [
		"omp seats",
		"omp seats --json",
		"omp seats --port 4181",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Seats);
		const cmd: SeatsCommandArgs = {
			flags: {
				json: flags.json ?? false,
				host: flags.host,
				port: flags.port,
			},
		};
		await runSeatsCommand(cmd);
	}
}
