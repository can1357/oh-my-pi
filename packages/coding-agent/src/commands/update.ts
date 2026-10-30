/**
 * Check for and install updates.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: __ompTranslate("Force update"), default: false }),
		check: Flags.boolean({
			char: "c",
			description: __ompTranslate("Check for updates without installing"),
			default: false,
		}),
		plugins: Flags.boolean({ char: "l", description: __ompTranslate("Update installed plugins"), default: false }),
		canary: Flags.boolean({ description: __ompTranslate("Switch to the canary channel and update"), default: false }),
		stable: Flags.boolean({ description: __ompTranslate("Switch back to the stable channel"), default: false }),
	};

	static examples = ["omp update", "omp update --check", "omp update --canary"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable)
			throw new CliUsageError(__ompTranslate("--canary and --stable are mutually exclusive"));
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: flags.check ? { dryRun: true } : {} });
		} else {
			await updateCli.runUpdateCommand({
				force: flags.force,
				check: flags.check,
				channel: flags.canary ? "canary" : flags.stable ? "stable" : undefined,
			});
		}
	}
}
