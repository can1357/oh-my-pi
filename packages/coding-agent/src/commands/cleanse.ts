import { postmortem } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCleanseCommand } from "../cleanse";
import { cleanseHelp as commandHelp } from "../cli/command-help";
import { CliUsageError } from "../cli/usage-error";

export default class Cleanse extends Command {
	static description = commandHelp.description;
	static args = {
		request: Args.string({
			description: 'What to detect and fix (e.g. "ts errors"); a discovery agent works out the command',
			required: false,
		}),
	};
	static flags = {
		agents: Flags.integer({
			char: "n",
			description: "Maximum number of file-disjoint subagents",
			default: 32,
		}),
		model: Flags.string({
			char: "m",
			description: "Subagent model selector",
			default: "@smol",
		}),
		tests: Flags.boolean({
			char: "t",
			description: "Also run configured project test suites",
			default: false,
		}),
		all: Flags.boolean({
			char: "a",
			description: "Run every discovered checker without the interactive picker",
			default: false,
		}),
	};

	static examples = [
		"omp cleanse",
		"omp cleanse --all",
		'omp cleanse "ts errors"',
		"omp cleanse -n 8",
		"omp cleanse -m opus",
		"omp cleanse -t",
		"omp cleanse --agents 12 --model anthropic/claude-opus-4-6",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Cleanse);
		if (flags.agents <= 0) throw new CliUsageError("--agents must be a positive integer");
		const result = await runCleanseCommand({
			maxAgents: flags.agents,
			model: flags.model,
			includeTests: flags.tests,
			request: args.request,
			all: flags.all,
		});
		await postmortem.quit(result.exitCode);
	}
}
