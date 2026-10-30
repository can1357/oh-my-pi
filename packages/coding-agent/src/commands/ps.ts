/**
 * Inspect and control daemon-broker supervised processes from outside the harness.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { psHelp as commandHelp } from "../cli/command-help";
import { type PsAction, type PsCommandArgs, runPsCommand } from "../cli/ps-cli";

const ACTIONS: PsAction[] = ["list", "info", "logs", "stop", "kill", "restart"];

export default class Ps extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: __ompTranslate("list (default), info, logs, stop, kill, or restart"),
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: __ompTranslate("Process name (required for every action except list)"),
			required: false,
		}),
	};

	static flags = {
		all: Flags.boolean({
			char: "a",
			description: __ompTranslate("Also list other projects and exited global services (list)"),
		}),
		json: Flags.boolean({ char: "j", description: __ompTranslate("Emit machine-readable JSON") }),
		plain: Flags.boolean({ description: __ompTranslate("Static listing instead of the interactive monitor (list)") }),
		dir: Flags.string({ description: __ompTranslate("Target another project directory instead of the current one") }),
		global: Flags.string({
			description: __ompTranslate("Target a machine-global service scope (e.g. browser-relay)"),
		}),
		follow: Flags.boolean({ char: "f", description: __ompTranslate("Keep streaming new output (logs)") }),
		head: Flags.boolean({ description: __ompTranslate("Read from the beginning instead of the tail (logs)") }),
		lines: Flags.integer({ char: "n", description: __ompTranslate("Number of log lines, max 1000 (logs)") }),
		grep: Flags.string({ description: __ompTranslate("Regex filter applied to log lines (logs)") }),
		timeout: Flags.integer({ description: __ompTranslate("Grace period in seconds before hard kill (stop)") }),
	};

	static examples = [
		"omp ps",
		"omp ps --all",
		"omp ps logs web --follow",
		"omp ps stop web",
		"omp ps kill web",
		"omp ps info relay --global browser-relay",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ps);
		const cmd: PsCommandArgs = {
			action: (args.action ?? "list") as PsAction,
			name: args.name,
			flags: {
				all: flags.all ?? false,
				json: flags.json ?? false,
				plain: flags.plain ?? false,
				dir: flags.dir,
				global: flags.global,
				follow: flags.follow ?? false,
				head: flags.head ?? false,
				lines: flags.lines,
				grep: flags.grep,
				timeout: flags.timeout,
			},
		};
		await runPsCommand(cmd);
	}
}
