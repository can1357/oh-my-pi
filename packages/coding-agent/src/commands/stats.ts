/**
 * View usage statistics dashboard.
 */

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { statsHelp as commandHelp } from "../cli/command-help";
import type { StatsCommandArgs } from "../cli/stats-cli";
import * as statsCli from "../cli/stats-cli";
import * as theme from "@oh-my-pi/pi-tui/theme";

export default class Stats extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the dashboard server", default: 3847 }),
		host: Flags.string({ description: "Host to bind", default: "127.0.0.1" }),
		"allowed-host": Flags.string({
			description:
				"Extra Host name to serve, e.g. a Tailscale Serve name (repeatable; *.example.net for subdomains)",
			multiple: true,
		}),
		json: Flags.boolean({ char: "j", description: "Output stats as JSON", default: false }),
		summary: Flags.boolean({ char: "s", description: "Print summary to console", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Stats);

		const cmd: StatsCommandArgs = {
			port: flags.port,
			host: flags.host ?? "127.0.0.1",
			allowedHosts: flags["allowed-host"] ?? [],
			json: flags.json,
			summary: flags.summary,
		};

		await theme.initTheme();
		await statsCli.runStatsCommand(cmd);
	}
}
