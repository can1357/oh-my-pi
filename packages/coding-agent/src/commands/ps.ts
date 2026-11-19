/**
 * Inspect and control the omp daemon's units from outside the harness.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { psHelp as commandHelp } from "../cli/command-help";
import { type PsAction, type PsCommandArgs, runPsCommand } from "../cli/ps-cli";

const ACTIONS: PsAction[] = ["list", "info", "logs", "stop", "kill", "restart", "send", "mode"];

export default class Ps extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), info, logs, stop, kill, restart, send, or mode",
			required: false,
			options: ACTIONS,
		}),
		name: Args.string({
			description: "Unit id, key, or label (required for every action except list)",
			required: false,
		}),
		value: Args.string({
			description: "send: input for the unit's stdin; mode: persist, session, or detached",
			required: false,
		}),
	};

	static flags = {
		all: Flags.boolean({ char: "a", description: "List every scope, including other projects and sessions (list)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		plain: Flags.boolean({ description: "Static listing instead of the interactive monitor (list)" }),
		dir: Flags.string({ description: "Target another project directory instead of the current one" }),
		follow: Flags.boolean({ char: "f", description: "Keep streaming new output (logs)" }),
		head: Flags.boolean({ description: "Read from the beginning instead of the tail (logs)" }),
		lines: Flags.integer({ char: "n", description: "Number of log lines, max 1000 (logs)" }),
		grep: Flags.string({ description: "Regex filter applied to log lines (logs)" }),
		timeout: Flags.integer({ description: "Grace period in seconds before hard kill (stop)" }),
		signal: Flags.string({ description: "Signal to deliver: SIGINT, SIGTERM, SIGHUP, SIGQUIT, or SIGKILL (send)" }),
	};

	static examples = [
		"omp ps",
		"omp ps --all",
		"omp ps logs web --follow",
		"omp ps stop web",
		"omp ps kill web",
		"omp ps send web 'rs\\n'",
		"omp ps send web --signal SIGINT",
		"omp ps mode web persist",
		"omp ps info web",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Ps);
		const cmd: PsCommandArgs = {
			action: (args.action ?? "list") as PsAction,
			name: args.name,
			value: args.value,
			flags: {
				all: flags.all ?? false,
				json: flags.json ?? false,
				plain: flags.plain ?? false,
				dir: flags.dir,
				follow: flags.follow ?? false,
				head: flags.head ?? false,
				lines: flags.lines,
				grep: flags.grep,
				timeout: flags.timeout,
				signal: flags.signal,
			},
		};
		await runPsCommand(cmd);
	}
}
