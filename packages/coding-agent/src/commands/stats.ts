/**
 * View usage statistics dashboard.
 */

import chalk from "@oh-my-pi/pi-utils/chalk";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { statsHelp as commandHelp } from "../cli/command-help";
import { installSessionStorageForCommand } from "../cli/session-arg";
import type { StatsCommandArgs } from "../cli/stats-cli";
import * as statsCli from "../cli/stats-cli";
import { SessionStorageUnsupportedError } from "../session/session-storage-config";
import * as theme from "@oh-my-pi/pi-tui/theme";

export default class Stats extends Command {
	static description = commandHelp.description;
	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the dashboard server", default: 3847 }),
		host: Flags.string({ description: "Host to bind", default: "127.0.0.1" }),
		json: Flags.boolean({ char: "j", description: "Output stats as JSON", default: false }),
		summary: Flags.boolean({ char: "s", description: "Print summary to console", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Stats);
		// The stats store ingests session files: read the configured storage so
		// `session.storage: sql` refuses instead of reporting no sessions.
		if (!(await installSessionStorageForCommand())) return;

		const cmd: StatsCommandArgs = {
			port: flags.port,
			host: flags.host ?? "127.0.0.1",
			json: flags.json,
			summary: flags.summary,
		};

		await theme.initTheme();
		try {
			await statsCli.runStatsCommand(cmd);
		} catch (error) {
			if (!(error instanceof SessionStorageUnsupportedError)) throw error;
			process.stderr.write(`${chalk.red(`error: ${error.message}`)}\n`);
			process.exitCode = 1;
		}
	}
}
