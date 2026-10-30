/**
 * Shared helpers for `/usage reset` (TUI selector + ACP) and `omp usage reset`:
 * turn the live per-account reset-credit status into rows, resolve a typed
 * `<provider>/<credential id>` target, and map a redeem outcome code to a
 * human message.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";
import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";

const CODEX_PROVIDER_ID = "openai-codex";
const CLAUDE_PROVIDER_ID = "anthropic";

/** Provider name shown beside each exact saved-reset account option. */
export function formatResetProviderName(provider: string): string {
	if (provider === CODEX_PROVIDER_ID) return "Codex";
	if (provider === CLAUDE_PROVIDER_ID) return "Claude";
	return provider;
}

/** Strip control characters and fold line breaks so stored or provider text stays on one line. */
export function oneLine(value: string): string {
	return sanitizeText(value.replace(/[\r\n\t]+/g, " "));
}

/** Provider id a saved-reset target names; `claude` and `codex` are aliases. */
export function normalizeResetProvider(value: string): string | undefined {
	switch (value.trim().toLowerCase()) {
		case "anthropic":
		case "claude":
			return CLAUDE_PROVIDER_ID;
		case "openai-codex":
		case "codex":
			return CODEX_PROVIDER_ID;
		default:
			return undefined;
	}
}

/** A typed `<provider>/<credential id>` or `<provider>/active` saved-reset target. */
export interface ResetUsageTarget {
	provider: string;
	/** Lowercased account part: a credential id, or `active`. */
	account: string;
}

/** Parse a saved-reset target; errors point at `command`, which lists the choices. */
export function parseResetUsageTarget(arg: string, command: string): ResetUsageTarget | { error: string } {
	const text = arg.trim();
	const slash = text.indexOf("/");
	if (slash <= 0)
		return { error: __ompTranslate("Choose an account with `{0} <provider>/<credential id>`.", `${command}`) };
	const provider = normalizeResetProvider(text.slice(0, slash));
	if (!provider) {
		return {
			error: __ompTranslate(
				'Unknown reset provider "{0}". Use anthropic or openai-codex.',
				`${oneLine(text.slice(0, slash))}`,
			),
		};
	}
	return {
		provider,
		account: text
			.slice(slash + 1)
			.trim()
			.toLowerCase(),
	};
}

/**
 * The listed account a saved-reset target names, when it has a reset to spend
 * now; otherwise the message saying why nothing will be spent.
 */
export function resolveResetUsageTarget(
	accounts: readonly ResetUsageAccount[],
	arg: string,
	command: string,
): { account: ResetUsageAccount } | { error: string } {
	const target = parseResetUsageTarget(arg, command);
	if ("error" in target) return target;
	const credentialId = /^\d+$/.test(target.account) ? Number(target.account) : undefined;
	const account = accounts.find(candidate => {
		if (candidate.provider !== target.provider) return false;
		if (target.account === "active") return candidate.active;
		return credentialId !== undefined && candidate.target.credentialId === credentialId;
	});
	if (!account) {
		return {
			error: __ompTranslate(
				'No stored account matches "{0}". List choices with `{1}`.',
				`${oneLine(arg.trim())}`,
				`${command}`,
			),
		};
	}
	if (account.error) {
		return {
			error: __ompTranslate(
				"{0} [{1}]: saved resets unavailable ({2}), so nothing was spent.",
				`${oneLine(account.label)}`,
				`${oneLine(account.providerLabel)}`,
				`${oneLine(account.error)}`,
			),
		};
	}
	if (account.redeemableCount <= 0) {
		const reason = account.unavailableReason ? ` (${oneLine(account.unavailableReason)})` : "";
		return {
			error: __ompTranslate(
				"{0} [{1}]: no saved resets usable right now{2}.",
				`${oneLine(account.label)}`,
				`${oneLine(account.providerLabel)}`,
				`${reason}`,
			),
		};
	}
	return { account };
}

/** One listing row: identity, provider, the account's `<provider>/<credential id>` target, and its resets. */
export function formatResetUsageAccountLine(account: ResetUsageAccount): string {
	let detail: string;
	if (account.error) {
		detail = `unavailable (${oneLine(account.error)})`;
	} else {
		detail = __ompTranslate("{0} saved, {1} usable now", `${account.availableCount}`, `${account.redeemableCount}`);
		if (account.expiresAt) detail += __ompTranslate(", expires {0}", `${oneLine(account.expiresAt)}`);
		if (account.redeemableCount === 0 && account.unavailableReason) {
			detail += ` (${oneLine(account.unavailableReason)})`;
		}
	}
	return `- ${oneLine(account.label)} [${oneLine(account.providerLabel)} · ${account.provider}/${account.target.credentialId}]: ${detail}${account.active ? " (active)" : ""}`;
}

/** Map one account's live reset status to a selector row. */
export function toResetUsageAccount(status: ResetCreditAccountStatus): ResetUsageAccount {
	const provider = status.provider;
	const providerLabel = formatResetProviderName(provider);
	const credit = status.nextCreditId
		? status.credits.find(candidate => candidate.id === status.nextCreditId)
		: (status.credits.find(candidate => candidate.usable !== false) ?? status.credits[0]);
	const advertisedRedeemable = status.redeemableCount ?? status.availableCount;
	const summary = summarizeUsageResetCredits(status);
	// Claude's listing endpoint chooses the one grant that may be spent.
	// Never degrade a missing pin into "spend whichever grant is current".
	const redeemableCount = provider === CLAUDE_PROVIDER_ID && !status.nextCreditId ? 0 : advertisedRedeemable;
	const identity = status.email ?? status.accountId ?? "account";
	const organization = status.orgName ?? status.orgId;
	const label = organization ? `${identity} · ${organization}` : identity;
	const unavailableReason =
		summary?.unavailableReason ??
		(provider === CLAUDE_PROVIDER_ID && advertisedRedeemable > 0 && !status.nextCreditId
			? __ompTranslate("the provider did not identify a grant that can be safely spent")
			: undefined) ??
		(status.availableCount > 0 && redeemableCount === 0 ? __ompTranslate("not usable right now") : undefined);
	return {
		label,
		provider,
		providerLabel,
		availableCount: status.availableCount,
		redeemableCount,
		target: {
			credentialId: status.credentialId,
			provider,
			...(status.accountId ? { accountId: status.accountId } : {}),
			...(status.email ? { email: status.email } : {}),
			...(status.orgId ? { orgId: status.orgId } : {}),
			...(status.nextCreditId ? { creditId: status.nextCreditId } : {}),
		} satisfies ResetCreditTarget,
		active: status.active,
		error: status.error,
		unavailableReason,
		expiresAt: summary?.soonestExpiry,
		credit,
	};
}

/**
 * Map live per-account reset status to selector rows. Sorted with the active
 * account first, then most-credits, then label.
 */
export function toResetUsageAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return statuses.map(toResetUsageAccount).sort((a, b) => {
		if (a.active !== b.active) return a.active ? -1 : 1;
		if (a.redeemableCount !== b.redeemableCount) return b.redeemableCount - a.redeemableCount;
		if (a.availableCount !== b.availableCount) return b.availableCount - a.availableCount;
		if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
		return a.label.localeCompare(b.label);
	});
}

/** Human-facing summary of a redeem outcome for status lines and ACP output. */
export function describeRedeemOutcome(outcome: ResetCreditRedeemOutcome, label: string): string {
	const provider = outcome.provider ? ` (${formatResetProviderName(outcome.provider)})` : "";
	const reason = outcome.reason ? ` — ${outcome.reason}` : "";
	switch (outcome.code) {
		case "reset": {
			const cleared = outcome.cleared ?? [];
			const scope =
				cleared.length === 1 && cleared[0] === "anthropic:5h"
					? "Claude's 5h session limit has been refreshed; weekly limits are unchanged"
					: cleared.length > 0
						? `the covered rate-limit window${cleared.length === 1 ? " has" : "s have"} been refreshed`
						: "your rate-limit window has been refreshed";
			return __ompTranslate("Reset applied for {0}{1} — {2}.", `${label}`, `${provider}`, `${scope}`);
		}
		case "already_redeemed":
			return __ompTranslate("{0}{1}: that reset was already redeemed.", `${label}`, `${provider}`);
		case "no_credit":
			return __ompTranslate(
				"{0}{1}: no saved resets available to spend{2}.",
				`${label}`,
				`${provider}`,
				`${reason}`,
			);
		case "credit_list_failed":
			return __ompTranslate(
				"{0}{1}: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.",
				`${label}`,
				`${provider}`,
			);
		case "nothing_to_reset":
			return __ompTranslate(
				"{0}{1}: nothing to reset right now — your covered limits aren't constrained, so no credit was spent.",
				`${label}`,
				`${provider}`,
			);
		case "no_account":
			return __ompTranslate("Could not find the stored account {0}{1}.", `${label}`, `${provider}`);
		case "account_unavailable":
			return __ompTranslate("{0}{1}: could not authenticate this account — try /login.", `${label}`, `${provider}`);
		case "offer_changed":
			return __ompTranslate(
				"{0}{1}: the reset offer changed — nothing was spent; reopen /usage reset.",
				`${label}`,
				`${provider}`,
			);
		case "reset_in_progress":
			return __ompTranslate("{0}{1}: a reset is already in progress.", `${label}`, `${provider}`);
		case "reset_unconfirmed":
		case "network_error":
		case "malformed_response":
			return __ompTranslate(
				"{0}{1}: couldn't confirm whether the reset applied — check /usage before trying again{2}.",
				`${label}`,
				`${provider}`,
				`${reason}`,
			);
		default:
			return __ompTranslate(
				"{0}{1}: reset was not confirmed ({2}){3}.",
				`${label}`,
				`${provider}`,
				`${outcome.code}`,
				`${reason}`,
			);
	}
}
