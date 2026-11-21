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

import type { AccountSwitchReason } from "@oh-my-pi/pi-ai";
import { formatActiveAccountLabel } from "../slash-commands/helpers/active-oauth-account";
import type { AuthStorage } from "./auth-storage";
import type { SessionManager } from "./session-manager";

/** A change of the OAuth account serving a session, between two recorded pins. */
export interface AccountSwitch {
	provider: string;
	/** The previous account's label; absent once that account is no longer stored. */
	from?: string;
	to: string;
	/** Absent when no routing rule of this process's auth store moved the session onto `to` since the last report (another process routed it, the branch's last pin predates an earlier switch, or a worker seam without `sessions.takeSwitchReason`). */
	reason?: AccountSwitchReason;
}

/**
 * A recorded {@link AccountSwitch} and the stored credential ids on each side,
 * which the log records in place of the account labels (emails).
 */
export interface RecordedAccountSwitch {
	event: AccountSwitch;
	fromCredentialId?: number;
	toCredentialId?: number;
}

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
 * (see `SessionManager.getCredentialPins`). Returns the switch when an earlier
 * pin named another account. Every call consumes the auth store's switch
 * reason, so a reason is reported with the turn its switch served or not at all.
 */
export function recordCredentialPin(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	provider: string,
): RecordedAccountSwitch | undefined {
	const reason = authStorage.sessions.takeSwitchReason?.(provider, sessionId);
	const identity = authStorage.oauth.identity(provider, sessionId);
	if (!identity) return undefined;
	const hash = credentialPinHash(provider, identity);
	const previousHash = sessionManager.getCredentialPins().get(provider)?.hash;
	if (!hash || previousHash === hash) return undefined;
	sessionManager.appendCredentialPin(provider, hash);
	const to = formatActiveAccountLabel(identity);
	if (previousHash === undefined || to === undefined) return undefined;
	const accounts = authStorage.oauth.accounts(provider, sessionId);
	const from = accounts.find(account => credentialPinHash(provider, account) === previousHash);
	return {
		event: { provider, from: formatActiveAccountLabel(from), to, reason },
		fromCredentialId: from?.credentialId,
		toCredentialId: accounts.find(account => account.active)?.credentialId,
	};
}

/**
 * Re-pin the accounts recorded in the session file onto the auth store's
 * session stickiness. No-op per provider when the account is gone (logged out)
 * or when a live sticky for another account exists (same-process
 * branch/session switches must not clobber fresher routing). A sticky for the
 * same account whose last use predates the pin is advanced to the pin's time:
 * the persisted sticky is written lazily, so the session file can be newer.
 * Seeds with the session's effective last-use time so stale resumes still fall
 * through to usage ranking.
 */
export function seedCredentialPins(authStorage: AuthStorage, sessionManager: SessionManager, sessionId: string): void {
	for (const [provider, pin] of sessionManager.getCredentialPins()) {
		const accounts = authStorage.oauth.accounts(provider, sessionId);
		if (accounts.length === 0) continue;
		const match = accounts.find(account => credentialPinHash(provider, account) === pin.hash);
		if (!match) continue;
		const active = accounts.find(account => account.active);
		if (active && (active !== match || (active.lastUsedAtMs ?? 0) >= pin.lastUsedAt)) continue;
		authStorage.sessions.pin(provider, sessionId, match.credentialId, {
			restoredAtMs: pin.lastUsedAt,
		});
	}
}
