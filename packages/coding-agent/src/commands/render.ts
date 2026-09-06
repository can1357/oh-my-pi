/**
 * Draw a session's entire thread through the production transcript pipeline.
 */

import { postmortem } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { renderHelp as commandHelp } from "../cli/command-help";
import { runRenderCommand } from "../cli/render-cli";
import { CliUsageError } from "../cli/usage-error";

export default class Render extends Command {
	static description = commandHelp.description;
	static args = {
		session: Args.string({ description: "Session file path or id prefix (default: most recent for cwd)" }),
	};
	static flags = {
		width: Flags.integer({ char: "w", description: "Render width in columns (default: terminal width)" }),
		height: Flags.integer({ description: "Viewport height in rows (default: terminal height)" }),
		timing: Flags.boolean({ char: "t", description: "Print phase timings and emitted byte counts to stderr" }),
		repaint: Flags.integer({
			description: "Benchmark N extra full clear-scrollback repaints (the /tree navigation frame)",
		}),
		plain: Flags.boolean({ description: "Strip ANSI styling from the output", default: false }),
		quiet: Flags.boolean({ char: "q", description: "Suppress transcript output (benchmark runs)", default: false }),
	};

	static examples = [
		"omp render",
		"omp render 01a0285c --plain",
		"omp render ~/.omp/agent/sessions/--work-pi--/big.jsonl -q -t --repaint 5",
		"omp render -w 200 > thread.ansi",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Render);
		if (flags.repaint !== undefined && flags.repaint <= 0) {
			throw new CliUsageError("--repaint must be a positive integer");
		}
		const exitCode = await runRenderCommand({
			session: args.session,
			width: flags.width,
			height: flags.height,
			timing: flags.timing,
			repaint: flags.repaint,
			plain: flags.plain,
			quiet: flags.quiet,
		});
		await postmortem.quit(exitCode);
	}
}
