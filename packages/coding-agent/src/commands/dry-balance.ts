import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { dryBalanceHelp as commandHelp } from "../cli/command-help";
import { runDryBalanceCommand } from "../cli/dry-balance-cli";

export default class DryBalance extends Command {
	static description = commandHelp.description;
	static args = {
		model: Args.string({
			description: __ompTranslate(
				"Model selector (provider/model or fuzzy id). Defaults to the configured default model.",
			),
			required: false,
		}),
	};

	static flags = {
		model: Flags.string({ description: __ompTranslate("Model selector (same syntax as --model on omp)") }),
		count: Flags.integer({ description: __ompTranslate("Number of random session ids to try"), default: 100 }),
		concurrency: Flags.integer({
			description: __ompTranslate("Maximum concurrent credential resolutions"),
			default: 32,
		}),
		json: Flags.boolean({ description: __ompTranslate("Output JSON") }),
		bench: Flags.boolean({ description: __ompTranslate("Send one live benchmark request per OAuth account") }),
		config: Flags.string({
			description: __ompTranslate("Load an extra config.yml-style overlay for this run (repeatable)"),
			multiple: true,
		}),
	};

	static examples = [
		__ompTranslate("# Dry-run the configured default model with 100 random session ids\n  omp dry-balance"),
		__ompTranslate("# Dry-run a specific model\n  omp dry-balance anthropic/claude-sonnet-4-5"),
		__ompTranslate(
			"# Larger run with bounded concurrency\n  omp dry-balance --model openai-codex/gpt-5-codex --count 1000 --concurrency 64",
		),
		__ompTranslate("# Benchmark every OAuth account in parallel\n  omp dry-balance --bench"),
		__ompTranslate("# Machine-readable output\n  omp dry-balance --json"),
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(DryBalance);
		await runDryBalanceCommand({
			model: args.model,
			flags: {
				model: flags.model,
				count: flags.count,
				concurrency: flags.concurrency,
				json: flags.json,
				bench: flags.bench,
				config: flags.config,
			},
		});
	}
}
