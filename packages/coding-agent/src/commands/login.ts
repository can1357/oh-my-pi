/**
 * Log in to a model provider from the terminal.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: __ompTranslate("OAuth provider id (e.g. anthropic, openai-codex); omit to pick interactively"),
			required: false,
		}),
	};

	static examples = [
		__ompTranslate("# Pick a provider interactively\n  {0} login", `${APP_NAME}`),
		__ompTranslate("# Log in to a specific provider\n  {0} login anthropic", `${APP_NAME}`),
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Login);
		await runLoginCommand(args.provider);
	}
}
