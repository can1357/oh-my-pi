/**
 * List, search, and refresh available models.
 */
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import { Args, Command, Flags } from "@pk-nerdsaver-ai/pi-utils/cli";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

export default class Models extends Command {
	static description = "List, search, and refresh available models";

	static args = {
		action: Args.string({
			description: "ls (default) | find | refresh | canonical | <provider>",
			required: false,
		}),
		pattern: Args.string({
			description: "Filter/search substring, or provider name (required for find)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before listing (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	static examples = [
		`# List every available model, grouped by provider\n  ${APP_NAME} models`,
		`# List one provider's models (any provider name works)\n  ${APP_NAME} models openai-codex`,
		`# Find models by substring\n  ${APP_NAME} models find minimax`,
		`# Force a fresh catalog fetch (replaces rm -rf ~/.ompk/models.db)\n  ${APP_NAME} models refresh`,
		`# Show the coalesced canonical model view\n  ${APP_NAME} models canonical`,
		`# Machine-readable output\n  ${APP_NAME} models --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
			},
		});
	}
}
