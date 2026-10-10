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
	const current = sessionManager.getCredentialPins().get(provider);
	const liveMode = authStorage.sessions.mode(provider, sessionId);
	if (current?.mode === "automatic" && liveMode !== "strict" && liveMode !== "pinned") return;
	const identity = authStorage.oauth.identity(provider, sessionId);
	if (!identity) return;
	const hash = credentialPinHash(provider, identity);
	const mode = liveMode === "strict" ? "strict" : undefined;
	if (!hash || (current?.hash === hash && current.mode === mode)) return;
	// Preserve explicit inheritance even when the account hash has not changed.
	sessionManager.appendCredentialPin(provider, hash, mode);
}

/**
 * Re-pin the accounts recorded in the session file onto the auth store's
 * session stickiness. Missing warm-affinity accounts and fresher live choices
 * are left alone; an unavailable strict journal account fails adoption before
 * configured defaults or sibling credentials can route a request. A warm sticky
 * for the same account is advanced to the pin's effective last-use time.
 * `restoreMode: "strict"` carries only explicit locks onto a fresh provider id.
 */
export function seedCredentialPins(
	authStorage: AuthStorage,
	sessionManager: SessionManager,
	sessionId: string,
	restoreMode?: "strict",
): void {
	for (const [provider, pin] of sessionManager.getCredentialPins()) {
		if (restoreMode && pin.mode !== restoreMode) continue;
		// The spawning parent's explicit choice wins over a revived child's journal,
		// including an automatic-routing opt-out or an older pin for the same account.
		const liveMode = authStorage.sessions.mode(provider, sessionId);
		if (liveMode === "strict" || liveMode === "pinned") continue;
		if (pin.mode === "automatic") {
			authStorage.sessions.automatic(provider, sessionId);
			continue;
		}
		const accounts = authStorage.oauth.accounts(provider, sessionId);
		const match = accounts.find(account => credentialPinHash(provider, account) === pin.hash);
		let restored = false;
		if (match) {
			const active = accounts.find(account => account.active);
			if (pin.mode !== "strict" && active && (active !== match || (active.lastUsedAtMs ?? 0) >= pin.lastUsedAt))
				continue;
			restored = authStorage.sessions.pin(provider, sessionId, match.credentialId, {
				restoredAtMs: pin.lastUsedAt,
				strict: pin.mode === "strict",
			});
		}
		if (!restored && pin.mode === "strict") {
			throw new Error(
				`Cannot restore strict account routing for ${provider}. Re-add the locked account before resuming.`,
			);
		}
	}
}
