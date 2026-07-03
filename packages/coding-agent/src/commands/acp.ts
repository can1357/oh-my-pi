/**
 * Run oh-my-pk as an ACP (Agent Client Protocol) server over stdio.
 *
 * Thin wrapper around the launch flow that forces `mode: "acp"` unless the
 * ACP terminal-auth flag asks the same command to open the interactive TUI.
 */
import { Command } from "@pk-nerdsaver-ai/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export default class Acp extends Command {
	static description = "Run oh-my-pk as an ACP (Agent Client Protocol) server over stdio";
	static strict = false;

	async run(): Promise<void> {
		const { args, terminalAuth } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs(args);
		if (!terminalAuth) {
			parsed.mode = "acp";
		}
		await runRootCommand(parsed, args);
	}
}
