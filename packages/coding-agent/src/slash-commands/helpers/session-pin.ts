import type { OAuthAccountSummary, PausedOAuthAccountSummary } from "../../session/auth-storage";
import { formatActiveAccountLabel } from "./active-oauth-account";

import type { SessionPinAccount } from "../../modes/view-model/overlays/session-account-selector";

/** Add stable user-facing labels to provider account summaries. */
export function toSessionPinAccounts(accounts: readonly OAuthAccountSummary[]): SessionPinAccount[] {
	return accounts.map(account => {
		const enterpriseUrl = account.enterpriseUrl?.trim();
		return {
			...account,
			label: (formatActiveAccountLabel(account) ?? enterpriseUrl) || `OAuth credential #${account.credentialId}`,
		};
	});
}

/** Label paused accounts like visible ones, numbered after the `offset` visible accounts. */
export function toPausedSessionPinAccounts(
	paused: readonly PausedOAuthAccountSummary[],
	offset: number,
): SessionPinAccount[] {
	return toSessionPinAccounts(
		paused.map((account, index) => ({
			position: offset + index,
			credentialId: account.credentialId,
			accountId: account.accountId,
			email: account.email,
			projectId: account.projectId,
			enterpriseUrl: account.enterpriseUrl,
			orgId: account.orgId,
			orgName: account.orgName,
			active: false,
		})),
	);
}

/**
 * Shortest selector `/usage resume` resolves to `account` alone among `accounts`
 * (every stored account of its provider): email, account id, project id, or label,
 * else the always-unique `OAuth credential #<id>`.
 */
export function resumeSelector(account: SessionPinAccount, accounts: readonly SessionPinAccount[]): string {
	for (const candidate of [account.email, account.accountId, account.projectId, account.label]) {
		if (!candidate) continue;
		const matches = matchSessionPinAccounts(accounts, candidate);
		if (matches.length === 1 && matches[0]!.credentialId === account.credentialId) return candidate;
	}
	return `OAuth credential #${account.credentialId}`;
}

/** Status text when every stored OAuth account of a provider is paused. */
export function describeAllAccountsPaused(providerName: string, paused: readonly SessionPinAccount[]): string {
	return `All ${providerName} accounts are paused: ${paused.map(account => account.label).join(", ")}. Resume one with /usage resume <account>.`;
}

/** Match a `/session pin` selector by 1-based position or exact account identity. */
export function matchSessionPinAccounts(accounts: readonly SessionPinAccount[], selector: string): SessionPinAccount[] {
	const wanted = selector.trim().toLowerCase();
	if (!wanted) return [];
	if (wanted === "active") return accounts.filter(account => account.active);

	if (/^\d+$/.test(wanted)) {
		const position = Number(wanted) - 1;
		const positioned = accounts.find(account => account.position === position);
		if (positioned) return [positioned];
	}

	return accounts.filter(account =>
		[
			account.label,
			account.email,
			account.accountId,
			account.projectId,
			account.enterpriseUrl,
			account.orgId,
			account.orgName,
			`OAuth credential #${account.credentialId}`,
		].some(value => value?.trim().toLowerCase() === wanted),
	);
}
