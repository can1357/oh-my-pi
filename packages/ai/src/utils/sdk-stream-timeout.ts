/**
 * Shared helpers for mapping `StreamOptions.streamFirstEventTimeoutMs` onto
 * underlying SDK request-timeout options.
 *
 * The hint is intentionally not a watchdog — it just narrows the SDK's
 * "transport timeout" window so a stuck pre-stream request fails fast
 * instead of hanging on the default (often multi-minute) SDK timeout. Once
 * the stream actually starts, silence is not failure; callers must abort
 * to interrupt a quiet stream.
 */

/**
 * Coerce a caller-supplied `streamFirstEventTimeoutMs` into a positive integer suitable
 * for the SDK's `timeout` option. Returns `undefined` when the caller passed nothing,
 * a non-finite value, or a non-positive value (preserving the SDK's default).
 */
export function resolveSdkTimeoutMs(streamFirstEventTimeoutMs: number | undefined): number | undefined {
	if (streamFirstEventTimeoutMs === undefined) return undefined;
	if (!Number.isFinite(streamFirstEventTimeoutMs)) return undefined;
	if (streamFirstEventTimeoutMs <= 0) return undefined;
	return Math.trunc(streamFirstEventTimeoutMs);
}

/**
 * Build per-request SDK options that combine an abort signal with the optional
 * `streamFirstEventTimeoutMs` request-timeout hint.
 *
 * The returned `{ signal, timeout?, maxRetries? }` shape is compatible with both
 * OpenAI's and Anthropic's `RequestOptions` (and any other SDK that follows the
 * Stainless conventions), so callers from any of those providers can spread the
 * result directly into `client.X.create(params, requestOptions)`.
 *
 * When the hint is set, retries are forced to zero so the SDK does not silently
 * extend the caller's explicit deadline by re-attempting after a timeout.
 */
export function createSdkStreamRequestOptions(
	signal: AbortSignal,
	streamFirstEventTimeoutMs: number | undefined,
): { signal: AbortSignal; timeout?: number; maxRetries?: number } {
	const timeout = resolveSdkTimeoutMs(streamFirstEventTimeoutMs);
	if (timeout === undefined) return { signal };
	return { signal, timeout, maxRetries: 0 };
}
