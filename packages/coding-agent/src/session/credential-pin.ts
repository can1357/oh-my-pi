/**
 * Session-file persistence of the OAuth account that served a session.
 *
 * Provider prompt caches are account-scoped (Anthropic bills a full cache
 * re-write after an account flip), and the auth store's session-sticky routing
 * is process-local when a remote auth broker is configured — the broker
 * store's KV cache is in-memory, so sticky rows die with the CLI process.
 * Resuming a session in a fresh process then re-ranks accounts by usage
 * headroom, which is biased *away* from the account that just served the
 * session (it has the highest recent burn), cold-missing the entire prefix.
 *
 * These helpers close the loop through the session file itself: after each
 * assistant turn the serving account is recorded as a `credential_pin` entry,
 * and on session adoption the pin is matched against the stored accounts and
 * seeded back into the auth store with the session's effective last-use
 * timestamp, so the provider's warm-window semantics still decide whether to
 * stick or re-rank.
 */

import type { AuthStorage } from "./auth-storage";
import type { SessionManager } from "./session-manager";

/** Account fields shared by `OAuthAccountIdentity` and `OAuthAccountSummary`. */
interface CredentialPinIdentity {
	accountId?: string;
	email?: string;
	projectId?: string;
	orgId?: string;
}

/**
 * Stable identifier for a provider account within its billing scope. The
 * digest covers the full scope tuple — the same account in two orgs (Anthropic
 * multi-subscription) or projects (Gemini) is two distinct cache domains and
 * must produce two distinct pins. The digest input is the persisted contract
 * for `CredentialPinEntry.hash` — changing it orphans every recorded pin.
 *
 * Hashing avoids embedding raw emails/uuids in session files, but an unsalted
 * digest of a guessable email is still linkable — treat exported sessions
 * accordingly.
 *
 * Returns `undefined` when the identity carries no account key at all.
 */
export function credentialPinHash(provider: string, identity: CredentialPinIdentity): string | undefined {
	if (!identity.accountId && !identity.email) return undefined;
	const key = [
		provider,
		identity.accountId ?? "",
		identity.email ?? "",
		identity.orgId ?? "",
		identity.projectId ?? "",
	].join("\0");
	return new Bun.CryptoHasher("sha256").update(key).digest("hex");
}

/**
 * Record the account that served the latest assistant turn for `provider`.
 * Appends a `credential_pin` entry only when the account differs from the
 * branch's latest pin, so steady-state sessions add a single entry; the
 * effective last-use time is derived from later assistant turns on read
 * (see `SessionManager.getCredentialPins`).
 */
export function recordCredentialPin(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	provider: string,
): void {
	const identity = authStorage.getOAuthAccountIdentity(provider, sessionId);
	if (!identity) return;
	const hash = credentialPinHash(provider, identity);
	if (!hash || sessionManager.getCredentialPins().get(provider)?.hash === hash) return;
	sessionManager.appendCredentialPin(provider, hash);
}

/**
 * Re-pin the accounts recorded in the session file onto the auth store's
 * session stickiness. No-op per provider when the account is gone (logged out)
 * or when a live sticky already exists (same-process branch/session switches
 * must not clobber fresher routing). Seeds with the session's effective
 * last-use time so stale resumes still fall through to usage ranking.
 */
export function seedCredentialPins(authStorage: AuthStorage, sessionManager: SessionManager, sessionId: string): void {
	for (const [provider, pin] of sessionManager.getCredentialPins()) {
		const accounts = authStorage.listOAuthAccounts(provider, sessionId);
		if (accounts.length === 0 || accounts.some(account => account.active)) continue;
		const match = accounts.find(account => credentialPinHash(provider, account) === pin.hash);
		if (!match) continue;
		authStorage.pinSessionOAuthAccount(provider, sessionId, match.credentialId, {
			lastUsedAtMs: pin.lastUsedAt,
		});
	}
}
