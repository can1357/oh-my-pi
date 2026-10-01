/**
 * Central auth-retry drivers: {@link withAuth}, {@link withOAuthAccess}, and
 * the streaming driver in `stream.ts`.
 *
 * No-resend invariant: a command-backed credential that an attempt dispatched,
 * and that the attempt's response rejected with 401, is never dispatched again,
 * neither by a refresh, a rotation, nor a later logical operation. Drivers learn
 * what they dispatched from provenance: an {@link ApiKeyResolver} reports its
 * command-backed bearer in {@link ResolvedApiKey.commandCredentials}, and every
 * model-header record carries its command provenance and the rejector that
 * retires it. Drivers therefore materialize model headers themselves, once per
 * attempt, and reject that record's command values on a 401 before resolving
 * the next attempt. A raw string key has no provenance; a caller needing the
 * guarantee for a command-backed key passes its resolver instead.
 */
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { LimitsApi, OAuthAccess, OAuthApi, OAuthRequestIdentity } from "./auth/types";
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
 * Current drivers give an ordinary 401/auth failure one step (b) before
 * repeating step (c) through distinct siblings. Account-scoped policy denials,
 * 403s, and usage-limit failures skip refresh. Rotation stops when the resolver
 * returns `undefined`, cycles, or hits {@link AUTH_RETRY_MAX_ATTEMPTS}.
 */
export interface ApiKeyResolveContext {
	/** True when the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Bearer used by the failed attempt, when the caller can expose it. */
	previousKey?: string;
	/** Exact command-backed credentials dispatched by the failed attempt. */
	previousSentCredentials?: SentCredentialSet;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
}

/** One command-backed credential that the transport actually dispatched. */
export interface SentCommandCredential {
	config: string;
	value: string;
}

/** Exact command-backed header credential with its dispatched header name. */
export interface SentHeaderCommandCredential extends SentCommandCredential {
	header: string;
}

/** Exact bearer and command-backed values dispatched by one request attempt. */
export interface SentCredentialSet {
	apiKey: string;
	commandCredentials: readonly SentCommandCredential[];
}

/** Retires one command-backed value after a response rejected it with 401. */
export type CommandCredentialRejector = (credential: SentCommandCredential) => void;

interface CommandHeaderProvenance {
	credentials: readonly SentHeaderCommandCredential[];
	reject: CommandCredentialRejector;
}

const commandHeaderProvenance = Symbol("commandHeaderProvenance");

type HeadersWithCommandProvenance = Record<string, string> & {
	[commandHeaderProvenance]?: CommandHeaderProvenance;
};

/** Attach command provenance, and the rejector that retires it, to a materialized header record. */
export function setCommandHeaderCredentials(
	headers: Record<string, string>,
	credentials: readonly SentHeaderCommandCredential[],
	reject: CommandCredentialRejector,
): Record<string, string> {
	if (credentials.length > 0) {
		Object.defineProperty(headers, commandHeaderProvenance, { value: { credentials, reject } });
	}
	return headers;
}

/** Copy materialized headers without exposing command provenance on the wire. */
export function copyHeadersWithCommandCredentials(
	headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const copy = { ...headers };
	const provenance = (headers as HeadersWithCommandProvenance)[commandHeaderProvenance];
	if (provenance) Object.defineProperty(copy, commandHeaderProvenance, { value: provenance });
	return copy;
}

/** Read command provenance recorded during this header record's materialization. */
export function getCommandHeaderCredentials(
	headers: Readonly<Record<string, string>> | undefined,
): readonly SentHeaderCommandCredential[] {
	return (headers as HeadersWithCommandProvenance | undefined)?.[commandHeaderProvenance]?.credentials ?? [];
}

/**
 * Retire the command-backed values a 401 attempt dispatched from this header
 * record. Lower-cased names in `maskedHeaderNames` were overridden by the
 * caller and never reached the wire, so they stay sendable.
 */
export function rejectCommandHeaderCredentials(
	headers: Readonly<Record<string, string>> | undefined,
	maskedHeaderNames?: ReadonlySet<string>,
): void {
	const provenance = (headers as HeadersWithCommandProvenance | undefined)?.[commandHeaderProvenance];
	if (!provenance) return;
	for (const credential of provenance.credentials) {
		if (!maskedHeaderNames?.has(credential.header.toLowerCase())) provenance.reject(credential);
	}
}

/**
 * Source for model headers dispatched by {@link withAuth} and
 * {@link withOAuthAccess}. A model's resolver is re-run for every request
 * attempt; a function is useful when the caller owns equivalent
 * registry-backed materialization.
 */
export type AuthHeaderResolver =
	| Model
	| ((signal?: AbortSignal) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined);

async function resolveAuthHeaders(
	headerResolver: AuthHeaderResolver | undefined,
	signal: AbortSignal | undefined,
): Promise<Record<string, string> | undefined> {
	if (!headerResolver) return undefined;
	const headers =
		typeof headerResolver === "function"
			? await headerResolver(signal)
			: headerResolver.resolveHeaders
				? await headerResolver.resolveHeaders(signal)
				: headerResolver.headers;
	return copyHeadersWithCommandCredentials(headers);
}

type AuthAttemptOutcome<T> = { ok: true; result: T } | { ok: false; error: unknown };

/**
 * Dispatch one auth attempt with model headers the driver materialized for it.
 * Materialization runs outside auth classification: nothing was sent, so its
 * failure propagates unchanged and never consumes a credential retry. A 401
 * retires the command-backed header values this attempt sent before the driver
 * resolves another attempt; other auth-classified failures return to the retry
 * policy, and everything else propagates.
 */
async function dispatchAuthAttempt<T>(
	headerResolver: AuthHeaderResolver | undefined,
	signal: AbortSignal | undefined,
	isAuthError: (error: unknown) => boolean,
	dispatch: (headers: Record<string, string> | undefined) => Promise<T>,
): Promise<AuthAttemptOutcome<T>> {
	const headers = await resolveAuthHeaders(headerResolver, signal);
	try {
		return { ok: true, result: await dispatch(headers) };
	} catch (error) {
		if (AIError.status(error) === 401) rejectCommandHeaderCredentials(headers);
		if (!isAuthError(error)) throw error;
		return { ok: false, error };
	}
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 */
export interface ResolvedApiKey {
	apiKey: string;
	/** Command-backed values the resolver materialized for this bearer. */
	commandCredentials?: readonly SentCommandCredential[];
	/** Durable row id of the credential that supplied this bearer, when known. */
	credentialId?: number;
	/**
	 * Resolved after `LimitsApi.rotate` slept out a sibling's short block
	 * (`afterSiblingWait`): the driver accepts this bearer even if the request
	 * already sent it before that block.
	 */
	afterSiblingWait?: boolean;
	/** Non-secret request scope belonging to this bearer, replaced on account rotation. */
	oauthIdentity?: OAuthRequestIdentity;
}

export type ApiKeyResolution = string | ResolvedApiKey | undefined;

export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<ApiKeyResolution> | ApiKeyResolution;

/** Extract the bearer while preserving optional credential provenance for streaming callers. */
export function resolvedApiKeyBearer(resolved: ApiKeyResolution): string | undefined {
	return (typeof resolved === "string" ? resolved : resolved?.apiKey) || undefined;
}

/**
 * Mark a post-rotation resolution as following a sibling-unblock wait so the
 * retry driver may resend a bearer it already tried. Used by the rotating
 * resolvers (`KeyCascade.resolver`, coding-agent `createApiKeyResolver`).
 */
export function markAfterSiblingWait(resolved: ApiKeyResolution): ApiKeyResolution {
	const apiKey = resolvedApiKeyBearer(resolved);
	if (apiKey === undefined) return resolved;
	return typeof resolved === "string"
		? { apiKey, afterSiblingWait: true }
		: { ...resolved, apiKey, afterSiblingWait: true };
}

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Keyless-provider credential marker; transports must not send it in authentication headers. */
export const NO_AUTH_SENTINEL = "N/A";

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(
	key: ApiKey | undefined,
	signal?: AbortSignal,
	onResolved?: (resolved: ApiKeyResolution) => void,
): Promise<ApiKeyResolution> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) {
		const resolved = await key({ lastChance: false, error: undefined, signal });
		onResolved?.(resolved);
		return resolved;
	}
	return key;
}

/**
 * Wraps a resolver with a credential already selected for this request.
 *
 * Callers that preflight credentials can pass the returned resolver to the
 * auth-retry driver without making the driver know about that preflight: the
 * first initial resolution reuses `seed` (including its credential identity),
 * and all later resolutions delegate to `resolver`.
 */
export function seedApiKeyResolver(seed: ApiKeyResolution, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = resolvedApiKeyBearer(seed) !== undefined;
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
 * Legacy a/b/c retry sequence retained for public compatibility:
 * `false` → refresh-same, `true` → rotate/switch. Current drivers may repeat
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
	onResolved?: (resolved: ApiKeyResolution) => void,
	previousSentCredentials?: SentCredentialSet,
): Promise<ApiKeyResolution> {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		const resolved = await resolver({
			lastChance: rotateSibling,
			error,
			signal,
			previousKey,
			previousSentCredentials,
		});
		onResolved?.(resolved);
		return resolved;
	} catch {
		return undefined;
	}
}

export interface AuthRetryKeyState {
	/** Bearer strings already sent during this logical operation. */
	attemptedKeys: Set<string>;
	/** Bearer used by the most recent failed attempt. */
	lastKey: string;
	/** Exact credential set dispatched by the most recent request attempt. */
	lastSentCredentials: SentCredentialSet;
	/** Whether the current credential already consumed its 401 refresh-same retry. */
	refreshedCurrent: boolean;
	/** Whether this operation already replayed once after an explicit token-refresh request. */
	tokenRefreshReplayUsed?: boolean;
	/** Total outbound attempts accepted for this logical operation, including the initial request. */
	attempts: number;
}

export function sentCredentialSet(resolved: ApiKeyResolution, apiKey: string): SentCredentialSet {
	return {
		apiKey,
		commandCredentials: typeof resolved === "string" ? [] : (resolved?.commandCredentials ?? []),
	};
}

export function createAuthRetryKeyState(initialKey: string, initialResolved: ApiKeyResolution): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		lastSentCredentials: sentCredentialSet(initialResolved, initialKey),
		refreshedCurrent: false,
		tokenRefreshReplayUsed: false,
		attempts: 1,
	};
}

function acceptRetryKey(
	state: AuthRetryKeyState,
	resolved: ApiKeyResolution,
	refreshedCurrent: boolean,
	afterSiblingWait = false,
): string | undefined {
	const key = resolvedApiKeyBearer(resolved);
	if (
		key === undefined ||
		(!afterSiblingWait && state.attemptedKeys.has(key)) ||
		state.attempts >= AUTH_RETRY_MAX_ATTEMPTS
	) {
		return undefined;
	}
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.lastSentCredentials = sentCredentialSet(resolved, key);
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
	onResolved?: (resolved: ApiKeyResolution) => void,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	if (error instanceof AIError.OAuthError && error.kind === "token-refresh") {
		if (state.tokenRefreshReplayUsed) return undefined;
		state.tokenRefreshReplayUsed = true;
		const refreshed = await resolveRetryKey(
			resolver,
			false,
			error,
			signal,
			state.lastKey,
			onResolved,
			state.lastSentCredentials,
		);
		state.refreshedCurrent = true;
		if (signal?.aborted || refreshed === undefined) return undefined;
		return acceptRetryKey(state, refreshed, true);
	}
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(
				resolver,
				false,
				error,
				signal,
				state.lastKey,
				onResolved,
				state.lastSentCredentials,
			);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	let afterSiblingWait = false;
	const rotated = await resolveRetryKey(
		resolver,
		true,
		error,
		signal,
		state.lastKey,
		resolved => {
			afterSiblingWait = typeof resolved === "object" && resolved.afterSiblingWait === true;
			onResolved?.(resolved);
		},
		state.lastSentCredentials,
	);
	if (signal?.aborted || rotated === undefined) return undefined;
	return acceptRetryKey(state, rotated, !directRotation, afterSiblingWait);
}

function oauthCredentialIdentity(access: OAuthAccess): string {
	return access.credentialId !== undefined ? `credential:${access.credentialId}` : `bearer:${access.accessToken}`;
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
 *   enters sibling rotation. Ordinary 401/auth failures get one refresh-same,
 *   then rotate through distinct siblings; 403/usage-limit failures skip the
 *   refresh and rotate directly.
 *
 * Used by non-streaming consumers (image generation, web search, completion
 * helpers). The streaming driver in `stream.ts` implements the same policy with
 * its replay-safe buffering machinery.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string, headers: Record<string, string> | undefined) => Promise<T>,
	opts?: {
		isAuthError?: (error: unknown) => boolean;
		signal?: AbortSignal;
		missingKeyMessage?: string;
		headerResolver?: AuthHeaderResolver;
	},
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const signal = opts?.signal;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		const outcome = await dispatchAuthAttempt(opts?.headerResolver, signal, isAuthError, headers =>
			attempt(key, headers),
		);
		if (outcome.ok) return outcome.result;
		throw outcome.error;
	}

	const resolver = key;
	let initialResolved: ApiKeyResolution;
	try {
		initialResolved = await resolver({ lastChance: false, error: undefined, signal, previousKey: undefined });
	} catch (error) {
		if (error instanceof AIError.CommandConfigResolutionError) throw error;
		initialResolved = undefined;
	}
	const initialKey = resolvedApiKeyBearer(initialResolved);
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey, initialResolved);
	const runAttempt = (apiKey: string): Promise<AuthAttemptOutcome<T>> =>
		dispatchAuthAttempt(opts?.headerResolver, signal, isAuthError, headers => {
			state.lastSentCredentials = {
				apiKey,
				commandCredentials: [
					...state.lastSentCredentials.commandCredentials,
					...getCommandHeaderCredentials(headers),
				],
			};
			return attempt(apiKey, headers);
		});
	let outcome = await runAttempt(initialKey);
	if (outcome.ok) return outcome.result;
	let lastError = outcome.error;

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		if (nextKey === undefined) break;
		outcome = await runAttempt(nextKey);
		if (outcome.ok) return outcome.result;
		lastError = outcome.error;
	}

	throw lastError;
}

/**
 * Minimal structural slice of `AuthStorage` consumed by {@link withOAuthAccess}.
 * Typed structurally (type-only imports) so this module never takes a runtime
 * dependency on `./auth-storage`.
 */
export interface OAuthAccessSource {
	readonly oauth: Pick<OAuthApi, "access">;
	readonly limits: Pick<LimitsApi, "rotate">;
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
	/** Model headers materialized for, and retired by a 401 on, each attempt. */
	headerResolver?: AuthHeaderResolver;
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
 *   current account, then sibling rotation through distinct credentials.
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
	attempt: (access: OAuthAccess, headers: Record<string, string> | undefined) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};
	const runAttempt = (access: OAuthAccess): Promise<AuthAttemptOutcome<T>> =>
		dispatchAuthAttempt(opts?.headerResolver, signal, isAuthError, headers => attempt(access, headers));

	let lastAccess = opts?.seed ?? (await storage.oauth.access(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const attemptedBearers = new Set([lastAccess.accessToken]);
	const attemptedCredentialIdentities = new Set([oauthCredentialIdentity(lastAccess)]);
	let attemptCount = 1;
	let refreshedCurrent = false;
	let tokenRefreshReplayUsed = false;
	let attemptResult = await runAttempt(lastAccess);
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
				next = await storage.oauth.access(provider, sessionId, { forceRefresh: true, signal });
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
			attemptResult = await runAttempt(next);
			if (attemptResult.ok) return attemptResult.result;
			lastError = attemptResult.error;
			continue;
		}

		const directRotation = isDirectCredentialRotationError(lastError);
		if (!directRotation) {
			if (!refreshedCurrent) {
				refreshedCurrent = true;
				try {
					next = await storage.oauth.access(provider, sessionId, {
						forceRefresh: true,
						refreshReason: AIError.status(lastError) === 401 ? "auth-recovery" : undefined,
						signal,
					});
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
						attemptResult = await runAttempt(next);
						if (attemptResult.ok) return attemptResult.result;
						lastError = attemptResult.error;
						continue;
					}
				}
			}
		}

		if (signal?.aborted || attemptCount >= AUTH_RETRY_MAX_ATTEMPTS) break;
		let afterSiblingWait = false;
		try {
			const rotation = await storage.limits.rotate(provider, sessionId, {
				error: lastError,
				signal,
				apiKey: lastAccess.accessToken,
				credentialId: lastAccess.credentialId,
			});
			if (!rotation.switched) break;
			afterSiblingWait = rotation.afterSiblingWait === true;
			next = await storage.oauth.access(provider, sessionId, { signal });
		} catch {
			next = undefined;
		}
		if (signal?.aborted || !next) break;
		const credentialIdentity = oauthCredentialIdentity(next);
		if (
			(!afterSiblingWait &&
				(attemptedCredentialIdentities.has(credentialIdentity) || attemptedBearers.has(next.accessToken))) ||
			attemptCount >= AUTH_RETRY_MAX_ATTEMPTS
		) {
			break;
		}
		attemptedCredentialIdentities.add(credentialIdentity);
		attemptedBearers.add(next.accessToken);
		attemptCount += 1;
		lastAccess = next;
		refreshedCurrent = !directRotation;
		attemptResult = await runAttempt(next);
		if (attemptResult.ok) return attemptResult.result;
		lastError = attemptResult.error;
	}

	throw lastError;
}
