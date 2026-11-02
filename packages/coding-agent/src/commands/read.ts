/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { readHelp as commandHelp, noMcpFlagDescription } from "../cli/command-help";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { disableMCP } from "../mcp/policy";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Read extends Command {
	static description = commandHelp.description;
	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static flags = {
		"no-mcp": Flags.boolean({ description: noMcpFlagDescription }),
	};

	static examples = [
		"omp read src/foo.ts",
		"omp read src/foo.ts:50-100",
		"omp read src/foo.ts:raw",
		"omp read https://example.com",
		"omp read omp://",
		"omp read issue://123",
		"omp read path/to/archive.zip:dir/file.ts",
		"omp read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Read);
		if (flags["no-mcp"]) disableMCP();
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
