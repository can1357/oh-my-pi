/**
 * Join a shared collab session from the CLI: launches the interactive TUI and
 * immediately runs `/join <link>`.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { joinHelp as commandHelp } from "../cli/command-help";
import { runRootCommand } from "../main";

export default class Join extends Command {
	static description = commandHelp.description;
	static args = {
		link: Args.string({
			description: __ompTranslate("Collab link shared by the host (/collab)"),
			required: true,
		}),
	};

	static examples = [`${APP_NAME} join "relay.example.sh/abc123#key"`];

	async run(): Promise<void> {
		const { args } = await this.parse(Join);
		const link = args.link?.trim();
		if (!link) {
			process.stderr.write(__ompTranslate("Usage: {0} join <link>\n", `${APP_NAME}`));
			process.exitCode = 1;
			return;
		}
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stderr.write(__ompTranslate("{0} join requires an interactive terminal\n", `${APP_NAME}`));
			process.exitCode = 1;
			return;
		}
		const parsed = parseArgs([]);
		parsed.join = link;
		await runRootCommand(parsed, []);
	}
}
