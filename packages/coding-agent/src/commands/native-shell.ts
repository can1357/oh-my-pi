/**
 * `omp zsh|bash|sh [args...]` as registered commands. `cli.ts` runs them
 * before the command framework (raw argv passthrough); these classes give
 * them their `omp --help` and completion entries, and run the shell when a
 * leading launch flag routed the argv through the framework.
 */

import { Command, type CommandCtor } from "@oh-my-pi/pi-utils/cli";
import { nativeShellHelp } from "../cli/command-help";
import { runNativeShell } from "../cli/native-shell";

/** The command class for the native shell `name`. */
export function nativeShellCommand(name: "zsh" | "bash" | "sh"): CommandCtor {
	const help = nativeShellHelp(name);
	return class NativeShell extends Command {
		static description = help.description;
		static strict = false;
		static args = help.args;

		async run(): Promise<void> {
			await runNativeShell([name, ...this.argv]);
		}
	};
}

/** `omp zsh`. */
export const Zsh = nativeShellCommand("zsh");
/** `omp bash`. */
export const Bash = nativeShellCommand("bash");
/** `omp sh`. */
export const Sh = nativeShellCommand("sh");
