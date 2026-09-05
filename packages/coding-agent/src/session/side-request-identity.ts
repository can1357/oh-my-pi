/**
 * Provider-facing identity for independent background/side model requests,
 * isolated from the foreground provider session so they cannot advance it and
 * reject a waiting foreground turn (issues #10619, #10865).
 *
 * The Anthropic Messages backend orders a conversation by
 * `metadata.user_id.session_id` (a JSON envelope built by
 * {@link buildSessionMetadata}) and by the `X-Claude-Code-Session-Id` request
 * header — both derived from the request's session id. A background request
 * that surfaces the foreground session id while a foreground request is in
 * flight advances the same provider session, and the foreground request then
 * fails with HTTP 400 (`This session advanced while the request was waiting`).
 *
 * Automatic title requests already isolate their identity this way (PR #10621);
 * this module generalizes that pattern for every other automatic side request
 * (memory extraction/consolidation, speech rewriting, sharpshooter, learn
 * capture, auto-thinking, unexpected-stop, branch summary, edit auto-repair).
 *
 * Each call to {@link sideRequestIdentity} mints a fresh id, so two side
 * requests of the same kind that run concurrently (e.g. several rollout-memory
 * jobs, overlapping speech rewrites) never advance one another. Derive the
 * identity when a logical request starts — passing the *current* foreground
 * session id — so a long-lived component does not keep authenticating a later
 * session against an earlier one's account after `newSession`/`switchSession`.
 */

import type { AuthStorage } from "./auth-storage";
import { buildSessionMetadata } from "./session-metadata";

/** A provider identity for one logical side request, isolated from the foreground. */
export interface SideRequestIdentity {
	/**
	 * Fresh provider session id for this request. Pass as the request's
	 * `sessionId` option and to the model registry's `resolver`/`getApiKey` so
	 * both the metadata envelope and the session header differ from the
	 * foreground turn (and from any concurrent side request). Stable across the
	 * request's own retries because it is captured once, before the retry loop.
	 */
	readonly sessionId: string;
	/** Seed the foreground account preference before resolving a provider credential. */
	prepare(provider: string): void;
	/**
	 * Isolated metadata for the request's target provider. Pass this method as
	 * `SimpleStreamOptions.metadataResolver`: the stream resolves it after each
	 * credential selection, so `account_uuid` follows the bearer selected for
	 * every auth-retry attempt. Direct callers MUST invoke it only after resolving
	 * that attempt's credential.
	 *
	 * The first call for a provider also seeds the foreground session's active
	 * OAuth account as this session's initial preference (a no-op once
	 * {@link prepare} or the factory seeded it); it never re-pins, so a credential
	 * rotation recorded on this session survives.
	 */
	metadata(provider: string): Record<string, unknown>;
	/** Release this request's ephemeral credential affinity and persistent sticky rows. */
	[Symbol.dispose](): void;
}

/**
 * Seed the foreground session's active OAuth account onto `isolatedSessionId` as
 * its initial credential preference, so a side request authenticates and
 * attributes to the same account while ordering under a distinct id. No-op when
 * there is nothing to isolate, no auth storage, or no active foreground OAuth
 * account (single-key/API-key setups resolve the same credential regardless of
 * session id). Does not overwrite an existing preference on the isolated
 * session, so a rotation already recorded there survives. The owning
 * {@link SideRequestIdentity} releases the resulting ephemeral affinity when
 * disposed.
 */
export function seedSideRequestCredential(
	authStorage: AuthStorage | undefined,
	provider: string,
	isolatedSessionId: string,
	foregroundSessionId: string,
): void {
	if (!authStorage || isolatedSessionId === foregroundSessionId) return;
	const active = authStorage.listOAuthAccounts(provider, foregroundSessionId).find(account => account.active);
	if (!active) return;
	const alreadyPinned = authStorage.listOAuthAccounts(provider, isolatedSessionId).some(account => account.active);
	if (alreadyPinned) return;
	authStorage.pinSessionOAuthAccount(provider, isolatedSessionId, active.credentialId);
}

/**
 * Mint an isolated {@link SideRequestIdentity} for one logical side request,
 * derived from the *current* foreground session id. Bind it with `using` once
 * per request (before any retry wrapper) so the id is stable for that request's
 * retries, unique across separate requests, and its credential affinity is
 * released at scope exit. Pass `authStorage` (from `modelRegistry.authStorage`)
 * so OAuth credential affinity is preserved while the request is active.
 *
 * Pass `provider` when it is known up front. If the model/provider is resolved
 * later, call {@link SideRequestIdentity.prepare} immediately before
 * `getApiKey`. Either path seeds the foreground account onto this session
 * before credential selection, so a healthy warm account is retained instead
 * of hash-ranking to another. Pass {@link SideRequestIdentity.metadata} as the
 * request metadata resolver so attribution follows whichever account selection
 * or auth retry actually uses.
 */
export function sideRequestIdentity(
	authStorage: AuthStorage | undefined,
	foregroundSessionId: string,
	provider?: string,
): SideRequestIdentity {
	const sessionId = Bun.randomUUIDv7();
	const seeded = new Set<string>();
	const seed = (target: string): void => {
		if (seeded.has(target)) return;
		seeded.add(target);
		seedSideRequestCredential(authStorage, target, sessionId, foregroundSessionId);
	};
	if (provider !== undefined) seed(provider);
	return {
		sessionId,
		prepare: seed,
		metadata(target: string): Record<string, unknown> {
			seed(target);
			return buildSessionMetadata(sessionId, target, authStorage);
		},
		[Symbol.dispose](): void {
			for (const target of seeded) {
				authStorage?.releaseSessionCredentialForReselection(target, sessionId);
			}
			seeded.clear();
		},
	};
}
