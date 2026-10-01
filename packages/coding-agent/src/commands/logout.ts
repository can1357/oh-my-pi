/** Remove one stored model-provider credential from the terminal. */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { logoutHelp as commandHelp } from "../cli/command-help";
import { runLogoutCommand } from "../cli/logout-cli";

export default class Logout extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider id (e.g. openai-codex); omit to pick from stored credentials",
			required: false,
		}),
		account: Args.string({
			description: "Exact email, account/project ID, or credential row ID; omit to pick an account",
			required: false,
		}),
	};

	static examples = [
		`# Pick a provider and stored account interactively\n  ${APP_NAME} logout`,
		`# Pick a stored OpenAI Codex account\n  ${APP_NAME} logout openai-codex`,
		`# Confirm removal of one exact account\n  ${APP_NAME} logout openai-codex user@example.com`,
		`# Select an exact stored credential row\n  ${APP_NAME} logout openai-codex 5`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Logout);
		await runLogoutCommand(args.provider, args.account);
	}
}
