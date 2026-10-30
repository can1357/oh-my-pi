/**
 * List, search, and refresh available models.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { MODEL_KINDS, type ModelKind } from "@oh-my-pi/pi-catalog/types";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { modelsHelp as commandHelp } from "../cli/command-help";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

const MODEL_KIND_OPTIONS: readonly (ModelKind | "all")[] = [...MODEL_KINDS, "all"];

export default class Models extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: __ompTranslate("ls (default) | find | refresh | <provider>"),
			required: false,
		}),
		pattern: Args.string({
			description: __ompTranslate("Filter/search substring, or provider name (required for find)"),
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: __ompTranslate("Output JSON") }),
		kind: Flags.string({
			description: __ompTranslate("Catalog kind to list"),
			options: MODEL_KIND_OPTIONS,
			default: "chat",
		}),
		extension: Flags.string({
			char: "e",
			description: __ompTranslate("Load an extension file before listing (repeatable)"),
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: __ompTranslate("Disable extension discovery (explicit -e paths still work)"),
		}),
		config: Flags.string({
			description: __ompTranslate("Load an extra config.yml-style overlay for this run (repeatable)"),
			multiple: true,
		}),
	};

	static examples = [
		__ompTranslate("# List available chat models, grouped by provider\n  {0} models", `${APP_NAME}`),
		__ompTranslate("# List models of every catalog kind\n  {0} models --kind all", `${APP_NAME}`),
		__ompTranslate(
			"# List one provider's models (any provider name works)\n  {0} models openai-codex",
			`${APP_NAME}`,
		),
		__ompTranslate("# Find models by substring\n  {0} models find minimax", `${APP_NAME}`),
		__ompTranslate(
			"# Force a fresh catalog fetch (replaces rm -rf ~/.omp/models.db)\n  {0} models refresh",
			`${APP_NAME}`,
		),
		__ompTranslate("# Machine-readable output\n  {0} models --json", `${APP_NAME}`),
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		const kind = MODEL_KIND_OPTIONS.find(option => option === flags.kind) ?? "chat";
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				kind,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
			},
		});
	}
}
