import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { OAuthAccess } from "./auth-storage";
import * as AIError from "./error";
import { isAuthRetryableError, isInvalidatedOAuthTokenError } from "./error/auth-classify";
import { isAccountPolicyError, isUsageLimit } from "./error/flags";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * The `error`/`lastChance` pair preserves the legacy a/b/c resolver contract
 * shared by streaming ({@link streamSimple}) and non-streaming ({@link withAuth})
 * drivers:
 * - `error === undefined` → **initial resolve** (no force-refresh; cheap, may
 *   return a locally-cached not-yet-expired token).
 * - `error !== undefined && !lastChance` → **step (b): refresh the SAME
 *   account** (force a token re-mint / await an in-flight broker refresh).
 * - `error !== undefined && lastChance` → **step (c): switch account**
 *   (invalidate/usage-limit the current credential and rotate to a sibling).
 *
 * Current drivers preserve that bounded a/b/c sequence for ordinary 401/auth
 * failures. Account-scoped policy denials, 403s, and usage-limit failures skip
 * refresh and may repeat step (c) until the resolver returns `undefined`,
 * cycles, or hits {@link AUTH_RETRY_MAX_ATTEMPTS}.
 */
export interface ApiKeyResolveContext {
	/** True when the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Bearer used by the failed attempt, when the caller can expose it. */
	previousKey?: string;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 */
export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) return (await key({ lastChance: false, error: undefined, signal })) || undefined;
	return key;
}

/**
 * Wraps a resolver with a bearer that was already selected for this request.
 *
 * Callers that preflight credentials can pass the returned resolver to the
 * auth-retry driver without making the driver know about that preflight: the
 * first initial resolution reuses `seed`, and all later resolutions delegate to
 * `resolver`.
 */
export function seedApiKeyResolver(seed: string | undefined, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = seed !== undefined;
	return ctx => {
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
}

// Re-exported from the error module (its new home); see error/auth-classify.ts.
export { isAuthRetryableError };

/**
 * Legacy bounded a/b/c retry sequence retained for public compatibility:
 * `false` → refresh-same, `true` → rotate/switch. Current drivers consume it
 * once for ordinary 401/auth failures; usage/account-limit failures may repeat
 * sibling rotation until a termination guard fires.
 */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

export const AUTH_RETRY_MAX_ATTEMPTS = 64;

function isDirectCredentialRotationError(error: unknown): boolean {
	if (isAccountPolicyError(error)) return true;
	if (isUsageLimit(error) || isInvalidatedOAuthTokenError(error)) return true;
	const status = AIError.status(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	// A 403 normally means a valid token lacks access, so rotate through
	// siblings. A concurrency-cap 403 is transient instead; do not burn a
	// sibling before the caller's backoff layer can retry it.
	const isForbidden =
		status === 403 ||
		(status === undefined && message !== undefined && extractHttpStatusFromError({ message }) === 403);
	if (isForbidden && !isConcurrencyCapExclusion(status, message)) return true;
	return isUsageLimitOutcome(status, message);
}

/** Resolve a single retry step, swallowing resolver failures into `undefined`. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
): Promise<string | undefined> {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		return (await resolver({ lastChance: rotateSibling, error, signal, previousKey })) || undefined;
	} catch {
		return undefined;
	}
}

export interface AuthRetryKeyState {
	/** Bearer strings already sent during this logical operation. */
	attemptedKeys: Set<string>;
	/** Bearer used by the most recent failed attempt. */
	lastKey: string;
	/** Whether the current credential already consumed its 401 refresh-same retry. */
	refreshedCurrent: boolean;
	/** Whether the legacy non-usage auth path already switched to one sibling. */
	legacyAuthSwitchUsed: boolean;
	/** Whether this operation already replayed once after an explicit token-refresh request. */
	tokenRefreshReplayUsed?: boolean;
	/** Total outbound attempts accepted for this logical operation, including the initial request. */
	attempts: number;
}

export function createAuthRetryKeyState(initialKey: string): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		refreshedCurrent: false,
		legacyAuthSwitchUsed: false,
		tokenRefreshReplayUsed: false,
		attempts: 1,
	};
}

function acceptRetryKey(state: AuthRetryKeyState, key: string, refreshedCurrent: boolean): string | undefined {
	if (state.attemptedKeys.has(key) || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	if (error instanceof AIError.OAuthError && error.kind === "token-refresh") {
		if (state.tokenRefreshReplayUsed) return undefined;
		state.tokenRefreshReplayUsed = true;
		const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
		state.refreshedCurrent = true;
		if (signal?.aborted || refreshed === undefined) return undefined;
		return acceptRetryKey(state, refreshed, true);
	}
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (state.legacyAuthSwitchUsed) return undefined;
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	const rotated = await resolveRetryKey(resolver, true, error, signal, state.lastKey);
	if (signal?.aborted || rotated === undefined) return undefined;
	const accepted = acceptRetryKey(state, rotated, !directRotation);
	if (accepted !== undefined && !directRotation) state.legacyAuthSwitchUsed = true;
	return accepted;
}

function oauthCredentialIdentity(access: OAuthAccess): string {
	return access.credentialId !== undefined ? `credential:${access.credentialId}` : `bearer:${access.accessToken}`;
}

async function runOAuthAttempt<T>(
	access: OAuthAccess,
	attempt: (access: OAuthAccess) => Promise<T>,
	isAuthError: (error: unknown) => boolean,
): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, result: await attempt(access) };
	} catch (error) {
		if (!isAuthError(error)) throw error;
		return { ok: false, error };
	}
}

/**
 * Runs an auth-protected operation through the central a/b/c retry policy.
 *
 * - A static string key (or any non-resolver) → a single `attempt` with no
 *   retry (identical to the legacy static-key path).
 * - A resolver → initial `attempt`, then resolver-driven retries until the
 *   applicable policy is exhausted, the resolver declines or cycles, or the
 *   operation reaches {@link AUTH_RETRY_MAX_ATTEMPTS}. An explicit typed
 *   token-refresh request gets exactly one refresh-current replay and never
 *   enters sibling rotation. Ordinary 401/auth failures retain one
 *   refresh-same plus one sibling switch; 403/usage-limit failures rotate
 *   directly through distinct siblings.
 *
 * Used by non-streaming consumers (image generation, web search, completion
 * helpers). The streaming driver in `stream.ts` implements the same policy with
 * its replay-safe buffering machinery.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const signal = opts?.signal;
	const initialKey = await resolveRetryKey(resolver, false, undefined, signal);
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey);
	let lastError: unknown;
	try {
		return await attempt(initialKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		if (nextKey === undefined) break;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}

/**
 * Minimal structural slice of `AuthStorage` consumed by {@link withOAuthAccess}.
 * Typed structurally (and importing only the `OAuthAccess` type) so this module
 * never takes a runtime dependency on `./auth-storage`.
 */
export interface OAuthAccessSource {
	getOAuthAccess(
		provider: string,
		sessionId?: string,
		options?: { forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<OAuthAccess | undefined>;
	rotateSessionCredential(
		provider: string,
		sessionId: string | undefined,
		options?: { error?: unknown; signal?: AbortSignal; apiKey?: string; credentialId?: number },
	): Promise<boolean>;
}

export interface WithOAuthAccessOptions {
	/** Session id for credential stickiness, threaded into every resolve. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Override the retryable-error classifier (default {@link isAuthRetryableError}). */
	isAuthError?: (error: unknown) => boolean;
	/**
	 * Pre-resolved access used for the initial attempt. Callers that already
	 * resolved access for an availability gate pass it here so the helper
	 * doesn't double-resolve (mirrors the gateway resolver's `initialKey`).
	 */
	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

/**
 * {@link withAuth} for OAuth-access consumers: runs an auth-protected
 * operation through the central a/b/c retry policy, handing the attempt the
 * full {@link OAuthAccess} (bearer + identity metadata: `accountId`,
 * `projectId`, `enterpriseUrl`) instead of bare API-key bytes.
 *
 * - initial → `getOAuthAccess` (or `opts.seed`).
 * - typed token-refresh request → one forced refresh-current replay, then stop.
 * - 401/auth failure → one `getOAuthAccess` with `forceRefresh: true` for the
 *   current account, then sibling rotation.
 * - 403/usage-limit failure → `rotateSessionCredential` directly, without a
 *   force-refresh detour.
 *
 * A refresh-same step may retry a new bearer for the same credential identity;
 * sibling rotation stops when it yields a credential identity
 * (`credentialId ?? accessToken`) or bearer already attempted in this turn.
 * All OAuth attempts share the {@link AUTH_RETRY_MAX_ATTEMPTS} ceiling.
 * Non-auth errors propagate immediately. Use this instead of hand-rolled
 * `getOAuthAccess` + fetch flows so 401s and usage-limits rotate credentials
 * instead of failing the call.
 */
export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};

	let lastAccess = opts?.seed ?? (await storage.getOAuthAccess(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const attemptedBearers = new Set([lastAccess.accessToken]);
	const attemptedCredentialIdentities = new Set([oauthCredentialIdentity(lastAccess)]);
	let attemptCount = 1;
	let legacyAuthSwitchUsed = false;
	let refreshedCurrent = false;
	let tokenRefreshReplayUsed = false;
	let attemptResult = await runOAuthAttempt(lastAccess, attempt, isAuthError);
	if (attemptResult.ok) return attemptResult.result;

	let lastError = attemptResult.error;
	while (true) {
		let next: OAuthAccess | undefined;
		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		const tokenRefreshReplay = lastError instanceof AIError.OAuthError && lastError.kind === "token-refresh";
		if (tokenRefreshReplay) {
			if (tokenRefreshReplayUsed) break;
			tokenRefreshReplayUsed = true;
			refreshedCurrent = true;
			try {
				next = await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
			} catch {
				next = undefined;
			}
			if (signal?.aborted || !next) break;
			const bearer = next.accessToken;
			if (attemptedBearers.has(bearer) || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
			attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
			attemptedBearers.add(bearer);
			attemptCount += 1;
			lastAccess = next;
			attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
			if (attemptResult.ok) return attemptResult.result;
			lastError = attemptResult.error;
			continue;
		}

		const directRotation = isDirectCredentialRotationError(lastError);
		if (!directRotation) {
			if (legacyAuthSwitchUsed) break;
			if (!refreshedCurrent) {
				refreshedCurrent = true;
				try {
					next = await storage.getOAuthAccess(provider, sessionId, { forceRefresh: true, signal });
				} catch {
					next = undefined;
				}
				if (signal?.aborted) break;
				if (next) {
					const bearer = next.accessToken;
					if (!attemptedBearers.has(bearer) && attemptCount < AUTH_RETRY_MAX_ATTEMPTS) {
						attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
						attemptedBearers.add(bearer);
						attemptCount += 1;
						lastAccess = next;
						attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
						if (attemptResult.ok) return attemptResult.result;
						lastError = attemptResult.error;
						continue;
					}
				}
			}
		}

		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		try {
			const rotated = await storage.rotateSessionCredential(provider, sessionId, {
				error: lastError,
				signal,
				apiKey: lastAccess.accessToken,
				credentialId: lastAccess.credentialId,
			});
			if (!rotated) break;
			next = await storage.getOAuthAccess(provider, sessionId, { signal });
		} catch {
			next = undefined;
		}
		if (signal?.aborted || !next) break;
		const credentialIdentity = oauthCredentialIdentity(next);
		if (
			attemptedCredentialIdentities.has(credentialIdentity) ||
			attemptedBearers.has(next.accessToken) ||
			attemptCount >= AUTH_RETRY_MAX_ATTEMPTS
		) {
			break;
		}
		attemptedCredentialIdentities.add(credentialIdentity);
		attemptedBearers.add(next.accessToken);
		attemptCount += 1;
		lastAccess = next;
		refreshedCurrent = !directRotation;
		if (!directRotation) legacyAuthSwitchUsed = true;
		attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
		if (attemptResult.ok) return attemptResult.result;
		lastError = attemptResult.error;
	}

	throw lastError;
}
