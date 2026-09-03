/**
 * Print the cumulative token and cost totals of a persisted session as JSON.
 */

import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { sessionStatsHelp as commandHelp } from "../cli/command-help";
import { runSessionStatsCommand } from "../cli/session-stats-cli";

export default class SessionStats extends Command {
	static description = commandHelp.description;
	static args = {
		ref: Args.string({
			description: "Session id, 'previous' (most recently modified), or a path to a session .jsonl file",
			required: true,
		}),
	};

	static examples = [
		"omp session-stats previous",
		"omp session-stats 01a05e60-7c60-7000-956e-5144423012fc",
		"omp session-stats ~/.omp/agent/sessions/my-project/2026-09-02T10-47-07Z_01a061ba.jsonl",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(SessionStats);
		await runSessionStatsCommand({ ref: args.ref ?? "" });
	}
}
