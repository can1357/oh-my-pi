import type { OAuthAccountSummary } from "../../session/auth-storage";
import { formatActiveAccountLabel } from "./active-oauth-account";

/**
 * Short fingerprint of the physical credential store `sourceLabel` names
 * (e.g. `local <dbPath>` / `broker <url>`) -- hashed rather than embedded
 * raw so a persisted selector never leaks a filesystem path or broker URL
 * into plaintext config. `undefined` when the store didn't report one
 * (e.g. a bare `new AuthStorage(store)` construction in tests).
 */
export function credentialStoreFingerprint(sourceLabel: string | undefined): string | undefined {
	if (!sourceLabel) return undefined;
	return new Bun.CryptoHasher("sha256").update(sourceLabel).digest("hex").slice(0, 12);
}

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
 * still get position/email/account-id/org matching. `options.storeFingerprint`
 * additionally matches the store-scoped `OAuth credential #<fingerprint>:<id>`
 * form `omp auth pin` persists — required so a selector saved against one
 * physical store (a broker, a specific `agent.db`) cannot coincidentally
 * resolve to an unrelated credential sharing the same autoincremented id
 * after the store changes (broker toggled off, URL changed). The unscoped
 * bare form still matches regardless, for backward compatibility and for
 * live/interactive selection where there is no cross-restart store risk.
 */
export function matchOAuthAccountsBySelector<T extends OAuthAccountSummary & { label?: string }>(
	accounts: readonly T[],
	selector: string,
	options?: { storeFingerprint?: string },
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
			options?.storeFingerprint ? `OAuth credential #${options.storeFingerprint}:${account.credentialId}` : undefined,
		].some(value => value?.trim().toLowerCase() === wanted),
	);
}
