/**
 * Wraps a {@link StreamFn} so extensions can observe and edit provider request
 * headers per request, via the `before_provider_headers` event.
 *
 * Applied at the stream-fn boundary, so it carries the CALLER-SUPPLIED headers
 * (`options.headers`) — not the provider's assembled map. Providers merge this
 * object into the headers they build, so additions here reach the request as
 * caller headers. Provider auth is generated downstream and is never visible.
 * Removability of credential names is ENFORCED rather than assumed: providers
 * disagree about whether caller headers outrank generated auth, so edits to the
 * credential headers are reverted in `emitBeforeProviderHeaders` (see
 * `PROVIDER_AUTH_HEADERS`) instead of being left to each provider's precedence.
 * Other keys, including `Content-Type`, are forwarded and follow each provider's
 * existing merge — some spread caller headers last.
 *
 * That is the intended contract, not a limitation to route around: exposing the
 * assembled map would give every installed extension the provider credential.
 * `StreamFn` already permits a promise return, so awaiting the handlers needs no
 * signature change.
 *
 * ORDERING: this wrapper is composed INSIDE the per-provider concurrency limiter
 * (see `sdk.ts`), so handlers run once the request holds its slot rather than
 * when it joins the queue. A request aborted while queued therefore never runs
 * them. Blob-url fallback retries sit INSIDE this wrapper so a transport
 * fallback does not re-run the hook. The cross-process cap in `packages/ai`
 * (`maxInFlightRequests`) still sits below this boundary — closing that gap
 * would mean reaching the coding-agent's runner from the provider library,
 * which the layering forbids.
 *
 * ONCE PER REQUEST, not per HTTP attempt. `streamSimple` re-enters itself on an
 * auth-refresh retry, and transports retry below that, so several attempts can
 * go out carrying the headers from a single hook invocation. Per-request
 * attribution is the intended use and reuse is correct for it; a per-attempt
 * nonce or signature cannot be expressed here. Same layering reason as above:
 * the attempt boundary lives in the provider library.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ExtensionRunner } from "./runner";

/**
 * Build a {@link StreamFn} that emits `before_provider_headers` before
 * forwarding to `base`.
 *
 * Handlers receive a copy of `options.headers`, so a handler cannot mutate the
 * caller's object, and a caller reusing its options across requests is not
 * affected by a previous request's edits. Each handler additionally works on its
 * own copy (see `emitBeforeProviderHeaders`), so one that outruns its timeout
 * cannot write into the request after returning. When no extension subscribes,
 * `base` is called directly and no copy is made.
 *
 * The request signal is threaded through so an abort stops the handler chain.
 * Because this runs holding the provider concurrency slot, a hung handler would
 * otherwise keep that slot for the whole handler timeout past the abort.
 */
export function wrapStreamFnWithProviderHeaders(runner: ExtensionRunner, base: StreamFn): StreamFn {
	return async (model, context, options) => {
		if (!runner.hasHandlers("before_provider_headers")) return base(model, context, options);
		const headers = await runner.emitBeforeProviderHeaders({ ...options?.headers }, model, options?.signal);
		return base(model, context, { ...options, headers });
	};
}
