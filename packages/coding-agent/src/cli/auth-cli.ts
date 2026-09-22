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
import { credentialStoreFingerprint, matchOAuthAccountsBySelector } from "../slash-commands/helpers/session-pin";

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
 * The durable selector for a pinned account: always the `OAuth credential
 * #<id>` form (already an accepted selector, see
 * `matchOAuthAccountsBySelector`) — never the account's email/account id or
 * its 1-based position. Both alternatives can go stale from events that
 * happen strictly AFTER this selector is persisted, not just ones already
 * present at pin time: a position shifts when an earlier account is
 * removed via `/logout`, and an email/account id that is unique right now
 * stops being unique the moment a new account sharing it (e.g. the same
 * person joining a second org) is added later via `/login`. The durable
 * credential id is the only value invariant under both of those future
 * events, so it is used unconditionally rather than only as a fallback for
 * a collision that already exists today.
 *
 * The id alone is only unique WITHIN one physical credential store, though
 * — a broker toggled off (falls back to local SQLite) or pointed at a
 * different `OMP_AUTH_BROKER_URL` can autoincrement an unrelated
 * credential to the same numeric id. `storeFingerprint` (from
 * `credentialStoreFingerprint(authStorage.getSourceLabel())`) folds the
 * store's own identity into the persisted form when available, so
 * `matchOAuthAccountsBySelector` only accepts the id against the SAME
 * store it was pinned against.
 */
function uniqueStartupSelector(account: OAuthAccountSummary, storeFingerprint: string | undefined): string {
	return storeFingerprint
		? `OAuth credential #${storeFingerprint}:${account.credentialId}`
		: `OAuth credential #${account.credentialId}`;
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
			console.log(chalk.dim(`No startup account pinned for "${provider}" in the global config.`));
			// Nothing to clear globally, but a project/overlay layer can still pin
			// this provider — say so instead of implying sessions now start on
			// automatic ranking.
			warnIfShadowed(provider, undefined);
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
		// A short-lived CLI process only ever calls this once: under a broker,
		// `discoverAuthStorage()` deliberately serves a possibly-stale on-disk
		// snapshot cache while it refreshes in the background (see
		// `packages/ai/src/auth-broker/discover.ts`), and there is no time left
		// in this process for that background delivery to land. Force a live
		// fetch (a no-op for the local SQLite store) so a just-added or
		// just-removed account is visible to `accounts`/`pin` immediately
		// instead of only after the cache's TTL expires. Best-effort: a slow or
		// unreachable broker falls back to the cached view rather than failing
		// the whole command, matching how `RemoteAuthCredentialStore` itself
		// treats a post-write refresh as fire-and-forget.
		await authStorage.revalidateCredentials().catch(error => {
			console.error(chalk.dim(`Could not refresh accounts from the auth broker; showing the cached list: ${error}`));
		});
		const accounts = authStorage.listOAuthAccounts(provider);
		const storeFingerprint = credentialStoreFingerprint(authStorage.getSourceLabel());
		if (accounts.length === 0) {
			console.error(chalk.red(`No stored OAuth accounts for "${provider}". Use /login to add one.`));
			process.exitCode = 1;
			return;
		}

		if (cmd.action === "accounts") {
			// Same runtime guard as `AgentSession#applyStartupOAuthAccountPin`: the
			// schema is a generic record, so a hand-edited `anthropic: 1` or the
			// generic /settings editor can store a non-string here, and
			// `matchOAuthAccountsBySelector` would throw on `.trim()`.
			const configuredValue = (settings.get("auth.startupOAuthAccount") as Record<string, unknown> | undefined)?.[
				provider
			];
			const pinnedSelector = typeof configuredValue === "string" ? configuredValue.trim() : undefined;
			const pinnedMatches = pinnedSelector
				? matchOAuthAccountsBySelector(accounts, pinnedSelector, { storeFingerprint })
				: [];
			const pinnedId = pinnedMatches.length === 1 ? pinnedMatches[0].credentialId : undefined;
			for (const account of accounts) {
				const pinned = account.credentialId === pinnedId ? chalk.dim(" [pinned]") : "";
				console.log(`${account.position + 1}. ${accountLabel(account)}${pinned}`);
			}
			if (configuredValue !== undefined && pinnedSelector === undefined) {
				console.log(
					chalk.yellow(
						`Note: the configured value for "${provider}" (${JSON.stringify(configuredValue)}) is not a string selector — no account will be auto-pinned at session start until it's fixed (see \`omp auth pin\`).`,
					),
				);
			} else if (pinnedSelector && pinnedMatches.length !== 1) {
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
		const matches = matchOAuthAccountsBySelector(accounts, cmd.selector, { storeFingerprint });
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
		const selector = uniqueStartupSelector(account, storeFingerprint);
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
