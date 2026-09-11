import type { OAuthAccountSummary } from "../../session/auth-storage";
import { formatActiveAccountLabel } from "./active-oauth-account";

/** Stored OAuth account rendered and matched by `/session pin`. */
export interface SessionPinAccount extends OAuthAccountSummary {
	label: string;
}

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

/**
 * Match an OAuth account selector by 1-based position, the literal `active`,
 * or an exact (case-insensitive) identity field. Shared by `/session pin`,
 * the `auth.startupOAuthAccount` session-bootstrap pin, and `omp auth pin` —
 * one selector syntax across all three surfaces. `label` (and the synthetic
 * `OAuth credential #<id>` fallback it enables) is optional so callers
 * working from a bare {@link OAuthAccountSummary} — no precomputed label —
 * still get position/email/account-id/org matching.
 */
export function matchOAuthAccountsBySelector<T extends OAuthAccountSummary & { label?: string }>(
	accounts: readonly T[],
	selector: string,
): T[] {
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
