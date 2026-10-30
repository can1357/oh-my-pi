/**
 * View usage statistics dashboard.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { statsHelp as commandHelp } from "../cli/command-help";
import type { StatsCommandArgs } from "../cli/stats-cli";
import * as statsCli from "../cli/stats-cli";
import * as theme from "@oh-my-pi/pi-tui/theme";

export default class Stats extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: __ompTranslate("Port for the dashboard server"), default: 3847 }),
		host: Flags.string({ description: __ompTranslate("Host to bind"), default: "127.0.0.1" }),
		json: Flags.boolean({ char: "j", description: __ompTranslate("Output stats as JSON"), default: false }),
		summary: Flags.boolean({ char: "s", description: __ompTranslate("Print summary to console"), default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Stats);

		const cmd: StatsCommandArgs = {
			port: flags.port,
			host: flags.host ?? "127.0.0.1",
			json: flags.json,
			summary: flags.summary,
		};

		await theme.initTheme();
		await statsCli.runStatsCommand(cmd);
	}
}
