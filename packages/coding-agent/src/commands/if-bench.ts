import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ifBenchHelp as commandHelp } from "../cli/command-help";
import { runIfBenchCommand } from "../if-bench";

export default class IfBench extends Command {
	static description = commandHelp.description;
	static args = {
		models: Args.string({
			description: "Model selectors (provider/model or fuzzy id, e.g. opus)",
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		turns: Flags.integer({ description: "Maximum turns per model; turn N issues N actions (default: 24)" }),
		length: Flags.integer({ description: "Character-array length, even, 8-26 (default: 24)" }),
		"max-tokens": Flags.integer({ description: "Max output tokens per turn (default: 32768)" }),
		"nya-max": Flags.integer({ description: "Longest accepted cat sound in nya{1,N} (default: 8)" }),
		par: Flags.integer({ description: "Models benchmarked concurrently (default: 4)" }),
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		"# Compare three models on the incremental array machine\n  omp if-bench opus sonnet gpt-5.2",
		"# Go deeper, one model at a time\n  omp if-bench opus --turns 40 --par 1",
		"# Shorter array, tighter cat sound\n  omp if-bench sonnet --length 12 --nya-max 2",
		"# Machine-readable per-turn transcript\n  omp if-bench opus --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(IfBench);
		await runIfBenchCommand({
			models: args.models ?? [],
			flags: {
				turns: flags.turns,
				length: flags.length,
				maxTokens: flags["max-tokens"],
				nyaMax: flags["nya-max"],
				par: flags.par,
				json: flags.json,
			},
		});
	}
}
