/**
 * Shared OAuth flow for Google-style providers (Gemini CLI, Antigravity).
 *
 * Both providers use the same authorization-code flow shape; only the client
 * credentials, scopes, endpoint constants, and project-discovery logic differ.
 */
import * as AIError from "../../error";

/**
 * Per-request timeout for the post-callback provisioning phase (token exchange,
 * user-info, project discovery/onboarding, LRO polling). These Cloud Code
 * Assist calls normally settle in well under this window; a longer stall means
 * a hung endpoint that must surface a login error instead of hanging forever.
 * The callback server's own 300s deadline covers only the browser-callback wait
 * ({@link OAuthCallbackFlow}) and does not gate this phase.
 */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

/** Options for {@link oauthFetch}. */
export interface OAuthFetchOptions {
	/** Provider id recorded on any {@link AIError.OAuthError} raised. */
	provider: string;
	/** Controller signal; when it aborts, the in-flight request is cancelled. */
	signal?: AbortSignal;
	/** Override the per-request timeout (defaults to {@link OAUTH_REQUEST_TIMEOUT_MS}). */
	timeoutMs?: number;
}

/**
 * Throw {@link AIError.LoginCancelledError} when the controller signal has
 * already aborted. Gates each provisioning round-trip, which the callback-wait
 * cancellation checks in {@link OAuthCallbackFlow} do not reach.
 */
export function throwIfLoginCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
	}
}

/**
 * `fetch` for the provisioning phase: composes the controller signal with a
 * per-request timeout so a stalled endpoint aborts instead of hanging login,
 * and user cancellation aborts the in-flight request. Cancellation surfaces as
 * {@link AIError.LoginCancelledError}; a timeout surfaces as an
 * {@link AIError.OAuthError} with `kind: "timeout"`.
 */
export async function oauthFetch(
	url: string,
	init: RequestInit,
	{ provider, signal, timeoutMs = OAUTH_REQUEST_TIMEOUT_MS }: OAuthFetchOptions,
): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		return await fetch(url, { ...init, signal: requestSignal });
	} catch (err) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth login cancelled: ${String(signal.reason)}`);
		}
		if (timeoutSignal.aborted) {
			throw new AIError.OAuthError(`Timed out after ${timeoutMs}ms waiting for ${url}`, {
				kind: "timeout",
				provider,
			});
		}
		throw err;
	}
}
