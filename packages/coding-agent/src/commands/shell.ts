/**
 * Interactive shell console.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { shellHelp as commandHelp } from "../cli/command-help";
import { runShellCommand, type ShellCommandArgs } from "../cli/shell-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Shell extends Command {
	static description = commandHelp.description;
	static flags = {
		cwd: Flags.string({ char: "C", description: __ompTranslate("Set working directory for commands") }),
		timeout: Flags.integer({ char: "t", description: __ompTranslate("Timeout per command in milliseconds") }),
		"no-snapshot": Flags.boolean({ description: __ompTranslate("Skip sourcing snapshot from user shell") }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Shell);

		const cmd: ShellCommandArgs = {
			cwd: flags.cwd,
			timeoutMs: flags.timeout,
			noSnapshot: flags["no-snapshot"],
		};

		await initTheme();
		await runShellCommand(cmd);
	}
}
