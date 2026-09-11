/**
 * `omp auth <action>` command handlers.
 *
 * `auth.startupOAuthAccount` (see settings-schema.ts) is consumed by
 * `AgentSession#applyStartupOAuthAccountPin` at session bootstrap. Before this
 * command existed, the only way to set it was hand-editing config.yml; this
 * gives it a CLI surface with the same selector syntax as `/session pin`.
 *
 * Split from `commands/auth.ts` (the oclif wrapper) so tests can drive the
 * actual behavior directly, the same way `config-cli.ts` backs `commands/config.ts`.
 */

import chalk from "@oh-my-pi/pi-utils/chalk";
import { settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import type { OAuthAccountSummary } from "../session/auth-storage";
import { matchOAuthAccountsBySelector } from "../slash-commands/helpers/session-pin";

export type AuthAction = "accounts" | "pin" | "unpin";

export interface AuthCommandArgs {
	action: AuthAction;
	provider: string;
	selector?: string;
}

function accountLabel(account: OAuthAccountSummary): string {
	const base =
		account.email ??
		account.accountId ??
		account.projectId ??
		account.enterpriseUrl ??
		`credential #${account.credentialId}`;
	const org = account.orgName ?? account.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

/**
 * A selector that resolves back to exactly `account` and only `account` among
 * `accounts` — so persisting it can't go ambiguous later if a sibling shares
 * the same email or account id under a different org (Anthropic/ChatGPT
 * multi-subscription: same email, two orgs). Falls back to the durable
 * `OAuth credential #<id>` form (already an accepted selector, see
 * `matchOAuthAccountsBySelector`) rather than the 1-based position: a stored
 * position shifts when an earlier account is removed via `/logout`, which
 * would silently repoint the pin at a different account instead of just
 * going stale.
 */
function uniqueStartupSelector(account: OAuthAccountSummary, accounts: readonly OAuthAccountSummary[]): string {
	for (const candidate of [account.email, account.accountId]) {
		if (candidate === undefined) continue;
		const matches = matchOAuthAccountsBySelector(accounts, candidate);
		if (matches.length === 1 && matches[0].credentialId === account.credentialId) return candidate;
	}
	return `OAuth credential #${account.credentialId}`;
}

/**
 * The global config layer's own (unmerged) `auth.startupOAuthAccount` record.
 * `settings.get()` returns the effective global → project → overlay → runtime
 * merge; patching that merged view and writing it back through `settings.set()`
 * (which only ever writes the global layer) would promote another provider's
 * project-only pin into global config. Reading the global layer directly
 * avoids that leak.
 */
function globalStartupOAuthAccounts(): Record<string, string> {
	const raw = settings.getGlobalSettings().auth as { startupOAuthAccount?: Record<string, string> } | undefined;
	return raw?.startupOAuthAccount ? { ...raw.startupOAuthAccount } : {};
}

/**
 * A global-layer write can still be shadowed by a higher-precedence project
 * or `--config`/`PI_CONFIG_FILES` overlay for the same provider key. Compare
 * the effective (merged) value against what this command just intended and
 * warn instead of reporting a silent success that doesn't actually apply.
 */
function warnIfShadowed(provider: string, intendedSelector: string | undefined): void {
	const effective = (settings.get("auth.startupOAuthAccount") as Record<string, string> | undefined)?.[provider];
	if (effective === intendedSelector) return;
	console.log(
		chalk.yellow(
			`Warning: a higher-precedence project or overlay config still sets "${provider}" to ${
				effective ? `"${effective}"` : "nothing"
			} — this global change has no effect until that layer changes too.`,
		),
	);
}

export async function runAuthCommand(cmd: AuthCommandArgs): Promise<void> {
	const provider = cmd.provider.toLowerCase();

	if (cmd.action === "unpin") {
		const configured = globalStartupOAuthAccounts();
		if (!(provider in configured)) {
			console.log(chalk.dim(`No startup account pinned for "${provider}".`));
			return;
		}
		delete configured[provider];
		settings.set("auth.startupOAuthAccount", configured);
		await settings.flush();
		console.log(chalk.green(`Cleared the pinned startup account for "${provider}".`));
		warnIfShadowed(provider, undefined);
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

		if (cmd.action === "accounts") {
			const pinnedSelector = (settings.get("auth.startupOAuthAccount") as Record<string, string> | undefined)?.[
				provider
			];
			const pinnedMatches = pinnedSelector ? matchOAuthAccountsBySelector(accounts, pinnedSelector) : [];
			const pinnedId = pinnedMatches.length === 1 ? pinnedMatches[0].credentialId : undefined;
			for (const account of accounts) {
				const pinned = account.credentialId === pinnedId ? chalk.dim(" [pinned]") : "";
				console.log(`${account.position + 1}. ${accountLabel(account)}${pinned}`);
			}
			if (pinnedSelector && pinnedMatches.length !== 1) {
				console.log(
					chalk.yellow(
						`Note: the configured selector "${pinnedSelector}" for "${provider}" is ${
							pinnedMatches.length === 0 ? "no longer valid" : "ambiguous"
						} — no account will be auto-pinned at session start until it's fixed (see \`omp auth pin\`).`,
					),
				);
			}
			return;
		}

		// cmd.action === "pin"
		if (!cmd.selector) {
			console.error(chalk.red("Usage: omp auth pin <provider> <selector>"));
			process.exitCode = 1;
			return;
		}
		const matches = matchOAuthAccountsBySelector(accounts, cmd.selector);
		if (matches.length === 0) {
			console.error(chalk.red(`No "${provider}" account matches "${cmd.selector}".`));
			process.exitCode = 1;
			return;
		}
		if (matches.length > 1) {
			console.error(
				chalk.red(
					`"${cmd.selector}" matches multiple "${provider}" accounts: ${matches
						.map(match => `${match.position + 1}. ${accountLabel(match)}`)
						.join(", ")}. Use the account number.`,
				),
			);
			process.exitCode = 1;
			return;
		}

		const account = matches[0];
		const selector = uniqueStartupSelector(account, accounts);
		const configured = globalStartupOAuthAccounts();
		configured[provider] = selector;
		settings.set("auth.startupOAuthAccount", configured);
		await settings.flush();
		console.log(chalk.green(`Pinned "${provider}" sessions to start on ${accountLabel(account)}.`));
		warnIfShadowed(provider, selector);
	} finally {
		authStorage.close();
	}
}
