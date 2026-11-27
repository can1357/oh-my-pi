/**
 * Shared helpers for `/usage reset` (TUI selector + ACP) and `omp usage reset`:
 * turn the live per-account reset-credit status into rows, resolve a typed
 * `<provider>/<credential id>` target, and map a redeem outcome code to a
 * human message.
 */
import { groupResetCreditsByClears, type UsageResetCredit } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome, ResetCreditTarget } from "../../session/auth-storage";
import type { ResetUsageAccount } from "../../modes/view-model/overlays/reset-usage-selector";
import { formatUsageResetWindow, summarizeUsageResetCredits } from "../../session/usage-display";

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

/** A typed `<provider>/<credential id>[:<credit id>]` or `<provider>/active[:<credit id>]` saved-reset target. */
export interface ResetUsageTarget {
	provider: string;
	/** Lowercased account part: a credential id, or `active`. */
	account: string;
	/** The exact saved reset to spend, as the listing names it. */
	creditId?: string;
}

/** Parse a saved-reset target; errors point at `command`, which lists the choices. */
export function parseResetUsageTarget(arg: string, command: string): ResetUsageTarget | { error: string } {
	const text = arg.trim();
	const slash = text.indexOf("/");
	if (slash <= 0) return { error: `Choose an account with \`${command} <provider>/<credential id>\`.` };
	const provider = normalizeResetProvider(text.slice(0, slash));
	if (!provider) {
		return { error: `Unknown reset provider "${oneLine(text.slice(0, slash))}". Use anthropic or openai-codex.` };
	}
	const rest = text.slice(slash + 1);
	const colon = rest.indexOf(":");
	const account = (colon < 0 ? rest : rest.slice(0, colon)).trim().toLowerCase();
	if (colon < 0) return { provider, account };
	const creditId = rest.slice(colon + 1).trim();
	if (!creditId) {
		return { error: `Name the saved reset after the colon, as \`${command}\` lists it, or leave the colon out.` };
	}
	return { provider, account, creditId };
}

/** The limits a credit clears, in words; undefined when the provider does not report them (Codex). */
function describeClears(credit: UsageResetCredit): string | undefined {
	const clears = credit.clears ?? [];
	return clears.length > 0 ? `clears ${clears.map(formatUsageResetWindow).join(" + ")}` : undefined;
}

/** `<id> “title”` for one credit. */
function nameCredit(credit: UsageResetCredit): string {
	return credit.title ? `${oneLine(credit.id)} “${oneLine(credit.title)}”` : oneLine(credit.id);
}

/** `<id> “title” (clears …)`, leaving out coverage the provider does not report. */
function nameCreditWithClears(credit: UsageResetCredit): string {
	const clears = describeClears(credit);
	return clears ? `${nameCredit(credit)} (${clears})` : nameCredit(credit);
}

/** One credit's id, title, what it clears, whether it can be spent now, and expiry. */
export function formatResetCreditLine(account: ResetUsageAccount, credit: UsageResetCredit): string {
	const next = account.target.creditId;
	let usable: string;
	if (credit.usable === false || (credit.status !== undefined && credit.status !== "available")) {
		const offeredFirst =
			account.provider === CLAUDE_PROVIDER_ID &&
			next &&
			next !== credit.id &&
			credit.status !== "redeemed" &&
			credit.status !== "expired"
				? `, ${oneLine(next)} is offered first`
				: "";
		usable = `not usable now (${oneLine(credit.status ?? "unavailable")}${offeredFirst})`;
	} else {
		usable = "usable now";
	}
	if (account.provider === CLAUDE_PROVIDER_ID && next === credit.id) usable += ", offered next";
	const count =
		credit.remainingCount !== undefined && credit.remainingCount !== 1 ? ` · ${credit.remainingCount} left` : "";
	const expires = credit.expiresAt ? ` · expires ${oneLine(credit.expiresAt)}` : "";
	const clears = describeClears(credit);
	return `${nameCredit(credit)}${clears ? ` · ${clears}` : ""} · ${usable}${count}${expires}`;
}

/** `<command> <provider>/<credential id>:<credit id>`, the exact spend of one credit. */
function creditCommand(command: string, account: ResetUsageAccount, credit: UsageResetCredit): string {
	return `${command} ${account.provider}/${account.target.credentialId}:${credit.id}`;
}

/**
 * The account's spendable credits when they clear different limits, so spending without
 * naming one would pick a reset type for the user; otherwise undefined. The one decision
 * behind both the typed refusal and the selector's per-reset rows.
 */
export function resetCreditChoice(account: ResetUsageAccount): UsageResetCredit[] | undefined {
	const credits = account.credits ?? [];
	const unspent = groupResetCreditsByClears(credits);
	if (unspent.length <= 1) return undefined;
	return credits.filter(credit => unspent.some(group => group.includes(credit)));
}

/**
 * The listed account a saved-reset target names, when it has a reset to spend
 * now; otherwise the message saying why nothing will be spent. A credit id
 * spends exactly that credit. Without one, an account holding credits that
 * clear different limits is refused, so a reset type is never picked for the user.
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
		return { error: `No stored account matches "${oneLine(arg.trim())}". List choices with \`${command}\`.` };
	}
	const who = `${oneLine(account.label)} [${oneLine(account.providerLabel)}]`;
	if (account.error) {
		return {
			error: `${who}: saved resets unavailable (${oneLine(account.error)}), so nothing was spent.`,
		};
	}
	const credits = account.credits ?? [];
	if (target.creditId !== undefined) {
		const chosen = credits.find(credit => credit.id === target.creditId);
		if (!chosen) {
			const known = credits.map(credit => oneLine(credit.id)).join(", ");
			return {
				error: `${who}: no saved reset "${oneLine(target.creditId)}" on this account${known ? ` (it has ${known})` : ""}, so nothing was spent. List them with \`${command}\`.`,
			};
		}
		const next = account.target.creditId;
		if (account.provider === CLAUDE_PROVIDER_ID && chosen.id !== next) {
			const offered = next ? credits.find(credit => credit.id === next) : undefined;
			const offer = offered
				? `Claude offers ${nameCreditWithClears(offered)} next, not ${nameCreditWithClears(chosen)}. Spend the offered one with \`${creditCommand(command, account, offered)}\`, or wait until it is used or expires.`
				: `Claude offers no saved reset to spend right now, so ${nameCreditWithClears(chosen)} can't be spent${account.unavailableReason ? ` (${oneLine(account.unavailableReason)})` : ""}.`;
			return { error: `${who}: ${offer} Nothing was spent.` };
		}
		if (
			account.redeemableCount <= 0 ||
			chosen.usable === false ||
			(chosen.status !== undefined && chosen.status !== "available")
		) {
			const reason = account.unavailableReason ?? chosen.status;
			return {
				error: `${who}: ${nameCredit(chosen)} is not usable right now${reason ? ` (${oneLine(reason)})` : ""}, so nothing was spent.`,
			};
		}
		return { account: { ...account, credit: chosen, target: { ...account.target, creditId: chosen.id } } };
	}
	const choice = resetCreditChoice(account);
	if (choice) {
		const lines = [
			`${who}: this account holds saved resets that clear different limits, so name the one to spend. Nothing was spent.`,
		];
		for (const credit of choice) {
			lines.push(`  - ${formatResetCreditLine(account, credit)}`, `    ${creditCommand(command, account, credit)}`);
		}
		return { error: lines.join("\n") };
	}
	if (account.redeemableCount <= 0) {
		const reason = account.unavailableReason ? ` (${oneLine(account.unavailableReason)})` : "";
		return {
			error: `${who}: no saved resets usable right now${reason}.`,
		};
	}
	return { account };
}

/**
 * One listing entry: identity, provider, the account's `<provider>/<credential id>`
 * target and its resets, then one line per credit with its id, title and what it clears.
 */
export function formatResetUsageAccountLine(account: ResetUsageAccount): string {
	let detail: string;
	if (account.error) {
		detail = `unavailable (${oneLine(account.error)})`;
	} else {
		detail = `${account.availableCount} saved, ${account.redeemableCount} usable now`;
		if (account.expiresAt) detail += `, expires ${oneLine(account.expiresAt)}`;
		if (account.redeemableCount === 0 && account.unavailableReason) {
			detail += ` (${oneLine(account.unavailableReason)})`;
		}
	}
	const lines = [
		`- ${oneLine(account.label)} [${oneLine(account.providerLabel)} · ${account.provider}/${account.target.credentialId}]: ${detail}${account.active ? " (active)" : ""}`,
	];
	for (const credit of account.error ? [] : (account.credits ?? [])) {
		lines.push(`    ${formatResetCreditLine(account, credit)}`);
	}
	return lines.join("\n");
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
			? "the provider did not identify a grant that can be safely spent"
			: undefined) ??
		(status.availableCount > 0 && redeemableCount === 0 ? "not usable right now" : undefined);
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
		credits: status.credits,
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

/** Why the selector cannot spend `credit` now; undefined for the offered, usable grant. */
function selectorCreditUnavailable(account: ResetUsageAccount, credit: UsageResetCredit): string | undefined {
	if (credit.status === "redeemed" || credit.status === "expired") return credit.status;
	const next = account.target.creditId;
	if (account.provider === CLAUDE_PROVIDER_ID && credit.id !== next) {
		return next ? `not offered next; Claude offers ${oneLine(next)} first` : "Claude offers no saved reset now";
	}
	if (
		account.redeemableCount <= 0 ||
		credit.usable === false ||
		(credit.status !== undefined && credit.status !== "available")
	) {
		return account.unavailableReason ?? credit.status ?? "not usable now";
	}
	return undefined;
}

/**
 * Rows for the `/usage reset` selector. An account whose resets clear different limits
 * gets one row per reset, so the user picks the reset type: only the offered, usable one
 * can be confirmed, and its row carries its id. Any other account keeps one row, with
 * a line per credit for its details.
 */
export function toResetSelectorAccounts(statuses: ResetCreditAccountStatus[]): ResetUsageAccount[] {
	return toResetUsageAccounts(statuses).flatMap(account => {
		if (account.error) return [account];
		const credits = account.credits ?? [];
		if (!resetCreditChoice(account)) {
			return [{ ...account, creditLines: credits.map(credit => formatResetCreditLine(account, credit)) }];
		}
		const unpinned = { ...account.target };
		delete unpinned.creditId;
		return credits.map(credit => {
			const unavailable = selectorCreditUnavailable(account, credit);
			return {
				...account,
				availableCount: credit.remainingCount ?? 1,
				redeemableCount: unavailable ? 0 : 1,
				unavailableReason: unavailable,
				expiresAt: credit.expiresAt,
				credit,
				creditLine: formatResetCreditLine(account, credit),
				target: unavailable ? unpinned : { ...unpinned, creditId: credit.id },
			};
		});
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
			return `Reset applied for ${label}${provider} — ${scope}.`;
		}
		case "already_redeemed":
			return `${label}${provider}: that reset was already redeemed.`;
		case "no_credit":
			return `${label}${provider}: no saved resets available to spend${reason}.`;
		case "credit_list_failed":
			return `${label}${provider}: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.`;
		case "nothing_to_reset":
			return `${label}${provider}: nothing to reset right now — your covered limits aren't constrained, so no credit was spent.`;
		case "no_account":
			return `Could not find the stored account ${label}${provider}.`;
		case "account_unavailable":
			return `${label}${provider}: could not authenticate this account — try /login.`;
		case "offer_changed":
			return `${label}${provider}: the saved reset offer changed${outcome.creditId ? ` (${outcome.creditId} is not the one offered next)` : ""}, so nothing was spent. List it again with \`/usage reset\` or \`omp usage reset\`.`;
		case "credit_choice_required":
			return `${label}${provider}: this account holds saved resets that clear different limits, so nothing was spent. Name the one to spend with \`<provider>/<credential id>:<credit id>\`.`;
		case "reset_in_progress":
			return `${label}${provider}: a reset is already in progress.`;
		case "reset_unconfirmed":
		case "network_error":
		case "malformed_response":
			return `${label}${provider}: couldn't confirm whether the reset applied — check /usage before trying again${reason}.`;
		default:
			return `${label}${provider}: reset was not confirmed (${outcome.code})${reason}.`;
	}
}
