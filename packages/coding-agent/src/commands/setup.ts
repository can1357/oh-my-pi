/**
 * Run onboarding setup or install dependencies for optional features.
 */

import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { setupHelp as commandHelp } from "../cli/command-help";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { runRootCommand } from "../main";
import { initTheme } from "../modes/theme/theme";

const COMPONENTS: SetupComponent[] = ["python", "speech"];

export interface OnboardingSetupDependencies {
	runRoot?: typeof runRootCommand;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	writeStderr?: (text: string) => void;
	exit?: (code: number) => never;
}

export async function runOnboardingSetup(deps: OnboardingSetupDependencies = {}): Promise<void> {
	const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
	const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
	if (!stdinIsTTY || !stdoutIsTTY) {
		(deps.writeStderr ?? (text => process.stderr.write(text)))("omp setup requires an interactive TTY.\n");
		(deps.exit ?? process.exit)(1);
		return;
	}
	await (deps.runRoot ?? runRootCommand)(parseArgs([]), [], { forceSetupWizard: true });
}

export default class Setup extends Command {
	static description = commandHelp.description;
	static args = {
		component: Args.string({
			description: "Optional component to install",
			required: false,
			options: COMPONENTS,
		}),
	};

	static flags = {
		check: Flags.boolean({ char: "c", description: "Check if dependencies are installed" }),
		json: Flags.boolean({ description: "Output status as JSON" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			if (flags.check || flags.json) {
				// A check/JSON request with no COMPONENT has nothing to probe. Emit a
				// usage error on stderr (exit 1) rather than printing help to stdout at
				// exit 0, which would mask failures in scripted `--json` health checks.
				throw new CliUsageError("setup --check/--json requires a COMPONENT (python|speech)");
			}
			await runOnboardingSetup();
			return;
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
