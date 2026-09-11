/**
 * List, pin, or unpin a provider's default stored OAuth account.
 *
 * `auth.startupOAuthAccount` (see settings-schema.ts) is consumed by
 * `AgentSession#applyStartupOAuthAccountPin` at session bootstrap. Before this
 * command existed, the only way to set it was hand-editing config.yml; this
 * gives it a CLI surface with the same selector syntax as `/session pin`.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { authHelp as commandHelp } from "../cli/command-help";
import { Settings, settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { matchOAuthAccountsBySelector } from "../slash-commands/helpers/session-pin";

const ACTIONS = ["accounts", "pin", "unpin"] as const;
type AuthAction = (typeof ACTIONS)[number];

function accountLabel(account: {
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgName?: string;
	orgId?: string;
	credentialId: number;
}): string {
	const base =
		account.email ??
		account.accountId ??
		account.projectId ??
		account.enterpriseUrl ??
		`credential #${account.credentialId}`;
	const org = account.orgName ?? account.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

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
		const action = args.action as AuthAction;
		const provider = (args.provider ?? "").toLowerCase();

		if (action === "unpin") {
			const configured = { ...((settings.get("auth.startupOAuthAccount") ?? {}) as Record<string, string>) };
			if (!(provider in configured)) {
				console.log(chalk.dim(`No startup account pinned for "${provider}".`));
				return;
			}
			delete configured[provider];
			settings.set("auth.startupOAuthAccount", configured);
			await settings.flush();
			console.log(chalk.green(`Cleared the pinned startup account for "${provider}".`));
			return;
		}

		const authStorage = await discoverAuthStorage();
		try {
			const accounts = authStorage.listOAuthAccounts(provider);
			if (accounts.length === 0) {
				console.error(chalk.red(`No stored OAuth accounts for "${provider}". Use /login to add one.`));
				process.exitCode = 1;
				return;
			}

			if (action === "accounts") {
				const configured = (settings.get("auth.startupOAuthAccount") ?? {}) as Record<string, string>;
				const pinnedSelector = configured[provider];
				const pinnedId = pinnedSelector
					? matchOAuthAccountsBySelector(accounts, pinnedSelector)[0]?.credentialId
					: undefined;
				for (const account of accounts) {
					const pinned = account.credentialId === pinnedId ? chalk.dim(" [pinned]") : "";
					console.log(`${account.position + 1}. ${accountLabel(account)}${pinned}`);
				}
				return;
			}

			// action === "pin"
			if (!args.selector) {
				console.error(chalk.red("Usage: omp auth pin <provider> <selector>"));
				process.exitCode = 1;
				return;
			}
			const matches = matchOAuthAccountsBySelector(accounts, args.selector);
			if (matches.length === 0) {
				console.error(chalk.red(`No "${provider}" account matches "${args.selector}".`));
				process.exitCode = 1;
				return;
			}
			if (matches.length > 1) {
				console.error(
					chalk.red(
						`"${args.selector}" matches multiple "${provider}" accounts: ${matches
							.map(match => `${match.position + 1}. ${accountLabel(match)}`)
							.join(", ")}. Use the account number.`,
					),
				);
				process.exitCode = 1;
				return;
			}

			const account = matches[0];
			const configured = { ...((settings.get("auth.startupOAuthAccount") ?? {}) as Record<string, string>) };
			configured[provider] = account.email ?? account.accountId ?? String(account.position + 1);
			settings.set("auth.startupOAuthAccount", configured);
			await settings.flush();
			console.log(chalk.green(`Pinned "${provider}" sessions to start on ${accountLabel(account)}.`));
		} finally {
			authStorage.close();
		}
	}
}
