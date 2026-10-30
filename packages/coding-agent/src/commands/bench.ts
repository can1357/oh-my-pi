import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runBenchCommand } from "../cli/bench-cli";
import { benchHelp as commandHelp } from "../cli/command-help";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export default class Bench extends Command {
	static description = commandHelp.description;
	static args = {
		models: Args.string({
			description: __ompTranslate("Model selectors (provider/model or fuzzy id, e.g. opus)"),
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		runs: Flags.integer({
			description: __ompTranslate(
				"Requests per model (default: 10 chat, 5 prefill/generation, 9 mix); with --detailed, per phase (default: 4)",
			),
		}),
		"max-tokens": Flags.integer({
			description: __ompTranslate(
				"Max output tokens per request (default: chat 512, prefill 64, generation 2048, cache 64)",
			),
		}),
		prompt: Flags.string({ description: __ompTranslate("Custom prompt text (chat and generation profiles only)") }),
		profile: Flags.string({
			description: __ompTranslate(
				"Benchmark workload (default chat): chat (balanced, measures TTFT and tok/s), prefill (large cache-busted input, measures input processing), generation (long forced output, measures sustained decode), mix (rotates all three)",
			),
			options: ["chat", "prefill", "generation", "mix"],
		}),
		"prefill-bytes": Flags.integer({
			description: __ompTranslate(
				"Synthetic input size for prefill challenges (default: 32768, capped by the context window)",
			),
		}),
		detailed: Flags.boolean({
			description: __ompTranslate(
				"Run single-user (1 concurrent), parallel (--par concurrent, with aggregate tok/s and scaling), and prefill phases per model",
			),
		}),
		"service-tier": Flags.string({
			description: __ompTranslate(
				"Service tier applied per model family (default: configured `tier.*` settings; `none` omits it)",
			),
			options: SERVICE_TIER_OPENAI_VALUES,
		}),
		json: Flags.boolean({ description: __ompTranslate("Output JSON") }),
		par: Flags.integer({
			description: __ompTranslate(
				"Execute runs with N parallel queries/requests (default: 4); --detailed's parallel phase width",
			),
		}),
		cache: Flags.boolean({
			description: __ompTranslate(
				"Run independent cold/warm prompt-cache pairs (not supported for openai-codex-responses)",
			),
		}),
		"cache-prefix-file": Flags.string({ description: __ompTranslate("Stable prompt prefix file for --cache") }),
		"cache-prefix-bytes": Flags.integer({
			description: __ompTranslate("Stable prefix byte budget for --cache (default: 8192)"),
		}),
		"cache-pairs": Flags.integer({
			description: __ompTranslate("Cold/warm pairs per model for --cache (default: 1)"),
		}),
		"cache-concurrency": Flags.integer({
			description: __ompTranslate("Concurrent cache pairs for --cache; each pair remains sequential (default: 1)"),
		}),
	};

	static examples = [
		__ompTranslate("# Compare TTFT and tok/s of two models\n  omp bench anthropic/claude-opus-4-5 openai/gpt-5.2"),
		__ompTranslate("# Fuzzy selectors work\n  omp bench opus sonnet"),
		__ompTranslate("# Average over 3 runs each\n  omp bench opus gpt-5.2 --runs 3"),
		__ompTranslate(
			"# Rotate chat, prefill, and generation challenges in one run\n  omp bench opus sonnet --profile mix",
		),
		__ompTranslate(
			"# Isolate prompt-ingestion speed with a 64 KiB cache-busted input\n  omp bench opus sonnet --profile prefill --prefill-bytes 65536",
		),
		__ompTranslate("# Isolate sustained decode throughput\n  omp bench opus sonnet --profile generation"),
		__ompTranslate(
			"# Compare single-user vs 8 concurrent users, plus prefill speed\n  omp bench apple --detailed --par 8",
		),
		__ompTranslate(
			"# Force priority serving tier\n  omp bench openai-codex/gpt-5.5:low --runs 10 --service-tier priority",
		),
		__ompTranslate("# Measure one cold/warm prompt-cache pair\n  omp bench openai/gpt-5.6 --cache --json"),
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Bench);
		await runBenchCommand({
			models: args.models ?? [],
			flags: {
				runs: flags.runs,
				maxTokens: flags["max-tokens"],
				prompt: flags.prompt,
				profile: flags.profile,
				prefillBytes: flags["prefill-bytes"],
				detailed: flags.detailed,
				serviceTier: flags["service-tier"],
				json: flags.json,
				par: flags.par,
				cache: flags.cache,
				cachePrefixFile: flags["cache-prefix-file"],
				cachePrefixBytes: flags["cache-prefix-bytes"],
				cachePairs: flags["cache-pairs"],
				cacheConcurrency: flags["cache-concurrency"],
			},
		});
	}
}
