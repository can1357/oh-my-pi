/**
 * View usage statistics dashboard.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { statsHelp as commandHelp } from "../cli/command-help";
import type { StatsCommandArgs } from "../cli/stats-cli";
import * as statsCli from "../cli/stats-cli";
import { initTheme } from "../modes/theme/theme";

export default class Stats extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Stats action",
			required: false,
			options: ["create-site"] as const,
		}),
		name: Args.string({
			description: "Site name (for create-site)",
			required: false,
		}),
	};
	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the dashboard server", default: 3847 }),
		host: Flags.string({ description: "Host to bind", default: "127.0.0.1" }),
		json: Flags.boolean({ char: "j", description: "Output stats as JSON", default: false }),
		summary: Flags.boolean({ char: "s", description: "Print summary to console", default: false }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Stats);

		const cmd: StatsCommandArgs = {
			port: flags.port,
			host: flags.host ?? "127.0.0.1",
			json: flags.json,
			summary: flags.summary,
			action: args.action as StatsCommandArgs["action"],
			name: args.name,
		};

		await initTheme();
		await statsCli.runStatsCommand(cmd);
	}
}