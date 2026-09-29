/**
 * Root command for the coding agent CLI.
 */

import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";
import { launchHelp } from "./launch-help";

/** Load the session/runtime graph only after the launch command has accepted its argv. */
async function loadRunRootCommand() {
	// Startup boundary: a static import makes command construction evaluate the
	// provider, browser-prelude, codec, and interactive-mode graphs.
	return (await import("../main")).runRootCommand;
}

export default class Index extends Command {
	static description = launchHelp.description;
	static hidden = launchHelp.hidden;
	static args = launchHelp.args;
	static flags = launchHelp.flags;
	static examples = launchHelp.examples;

	static strict = false;

	async run(): Promise<void> {
		const { args } = prepareAcpTerminalAuthArgs(this.argv);
		let parsed: ParsedArgs;
		try {
			parsed = parseArgs(args);
		} catch (error) {
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		const runRootCommand = await loadRunRootCommand();
		try {
			await runRootCommand(parsed, args);
		} catch (error) {
			// Usage errors found after startup (e.g. `--tools` checked against the
			// discovered registry) may leave live handles; exit instead of draining.
			if (reportCliUsageError(error)) {
				process.exit(2);
			}
			throw error;
		}
	}
}
