/**
 * `omp telegram` — run the Telegram bridge in the foreground — and
 * `omp telegram status`, a config-sanity report that never prints the token.
 *
 * The run form is built like `omp acp`: parse the launch flags, force
 * `mode: "telegram"`, and hand the args to the shared root bootstrap so the
 * bridge gets the same settings, auth, model registry, and session options as
 * any other mode.
 */
import { Command } from "@oh-my-pi/pi-utils/cli";
import { type Args as ParsedArgs, parseArgs, reportCliUsageError } from "../cli/args";
import { telegramHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { telegramStatusReport } from "../telegram/headless";

export default class Telegram extends Command {
	static description = commandHelp.description;
	static strict = false;

	static examples = ["omp telegram", "omp telegram status", "omp telegram --model anthropic/claude-sonnet-4-5"];

	async run(): Promise<void> {
		const raw = this.argv;
		if (raw[0] === "status") {
			if (raw.length > 1) {
				process.stderr.write("error: telegram status takes no arguments (usage: omp telegram status)\n");
				process.exitCode = 2;
				return;
			}
			const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
			const report = await telegramStatusReport({ settings, cwd: process.cwd() });
			for (const line of report.lines) process.stdout.write(`${line}\n`);
			process.exitCode = report.code;
			return;
		}
		// `omp telegram start` is the explicit spelling of the default run form.
		const args = raw[0] === "start" ? raw.slice(1) : raw;
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
		parsed.mode = "telegram";
		// Branch-only runner: `omp telegram status` and `--help` must stay light and
		// must not import the full agent bootstrap.
		const { runRootCommand } = await import("../main");
		await runRootCommand(parsed, args);
	}
}
