/**
 * Join a shared collab session from the CLI: launches the interactive TUI and
 * immediately runs `/join <link>`.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { joinHelp as commandHelp, noMcpFlagDescription } from "../cli/command-help";
import { disableMCP } from "../mcp/policy";
import { runRootCommand } from "../main";

export default class Join extends Command {
	static description = commandHelp.description;
	static args = {
		link: Args.string({
			description: "Collab link shared by the host (/collab)",
			required: true,
		}),
	};

	static flags = {
		"no-mcp": Flags.boolean({ description: noMcpFlagDescription }),
	};

	static examples = [`${APP_NAME} join "relay.example.sh/abc123#key"`];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Join);
		if (flags["no-mcp"]) disableMCP();
		const link = args.link?.trim();
		if (!link) {
			process.stderr.write(`Usage: ${APP_NAME} join <link>\n`);
			process.exitCode = 1;
			return;
		}
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stderr.write(`${APP_NAME} join requires an interactive terminal\n`);
			process.exitCode = 1;
			return;
		}
		const parsed = parseArgs([]);
		parsed.join = link;
		await runRootCommand(parsed, []);
	}
}
