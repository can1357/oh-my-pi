/**
 * List, search, and refresh available models.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { modelsHelp as commandHelp } from "../cli/command-help";
import { resolveModelsArgs, runModelsCommand } from "../cli/models-cli";

export default class Models extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "ls (default) | find | refresh | add | <provider>",
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
		provider: Flags.string({
			description: "Provider identifier (e.g. my-vllm, deepseek-custom)",
		}),
		"base-url": Flags.string({
			description: "Endpoint base URL (e.g. http://localhost:8000/v1)",
		}),
		"api-key": Flags.string({
			description: "API key or token for provider authentication",
		}),
		auth: Flags.string({
			description: "Authentication mode (apiKey | none)",
		}),
		api: Flags.string({
			description: "API protocol format (openai-completions | openai-responses)",
		}),
		model: Flags.string({
			description: "Model identifier (for manual model definition)",
		}),
		"model-name": Flags.string({
			description: "Display name for the manual model",
		}),
		"context-window": Flags.integer({
			description: "Context window size in tokens (e.g. 128000)",
		}),
		discovery: Flags.boolean({
			description: "Enable automatic model discovery via GET /models (openai-models-list)",
		}),
		"disable-strict-tools": Flags.boolean({
			description: "Disable strict tool schema enforcement for third-party servers",
		}),
		test: Flags.boolean({
			description: "Test endpoint connectivity before saving configuration",
		}),
	};

	static examples = [
		`# List every available model, grouped by provider\n  ${APP_NAME} models`,
		`# List one provider's models (any provider name works)\n  ${APP_NAME} models openai-codex`,
		`# Find models by substring\n  ${APP_NAME} models find minimax`,
		`# Force a fresh catalog fetch (replaces rm -rf ~/.omp/models.db)\n  ${APP_NAME} models refresh`,
		`# Machine-readable output\n  ${APP_NAME} models --json`,
		`# Add a custom local vLLM or Ollama endpoint\n  ${APP_NAME} models add --provider my-vllm --base-url http://localhost:8000/v1 --auth none --model llama-3-8b`,
		`# Add a custom proxy with automatic model discovery\n  ${APP_NAME} models add --provider proxy --base-url https://api.proxy.com/v1 --api-key sk-test --discovery`,
		`# Add custom provider interactively\n  ${APP_NAME} models add`,
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
				provider: flags.provider,
				baseUrl: flags["base-url"],
				apiKey: flags["api-key"],
				auth: flags.auth,
				api: flags.api,
				model: flags.model,
				modelName: flags["model-name"],
				contextWindow: flags["context-window"],
				discovery: flags.discovery,
				disableStrictTools: flags["disable-strict-tools"],
				test: flags.test,
			},
		});
	}
}
