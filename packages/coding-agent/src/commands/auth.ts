/**
 * List, pin, or unpin a provider's default stored OAuth account.
 *
 * Thin oclif wrapper — see `../cli/auth-cli.ts` for the actual behavior.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import type { AuthAction } from "../cli/auth-cli";
import { runAuthCommand } from "../cli/auth-cli";
import { authHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";

const ACTIONS: readonly AuthAction[] = ["accounts", "pin", "unpin"];

export default class Auth extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Action", required: true, options: [...ACTIONS] }),
		provider: Args.string({ description: "Provider ID (e.g. anthropic)", required: true }),
		selector: Args.string({
			description: "Account selector for `pin`: 1-based position, email, account id, org id, or org name",
			required: false,
		}),
	};

	static examples = [
		"# List stored Anthropic OAuth accounts and show which is pinned\n  omp auth accounts anthropic",
		"# Always start anthropic sessions on this account\n  omp auth pin anthropic jkirk@example.com",
		"# Same, by 1-based position\n  omp auth pin anthropic 1",
		"# Clear the pinned default (falls back to automatic ranking)\n  omp auth unpin anthropic",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Auth);
		await Settings.init({ cwd: getProjectDir() });
		await runAuthCommand({
			action: args.action as AuthAction,
			provider: args.provider ?? "",
			selector: args.selector,
		});
	}
}
