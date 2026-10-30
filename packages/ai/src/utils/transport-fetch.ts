import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, DispatchHold, FetchImpl, Model } from "../types";
import { holdBeforeDispatch } from "./dispatch-hold";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";

/** Stamped on a fetch already built by {@link transportFetch}. */
const TRANSPORT_FETCH = Symbol("omp.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: true };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the caller's dispatch hold, the inference User-Agent default,
 * `NODE_EXTRA_CA_CERTS`, the per-provider proxy, and `PI_REQ_DEBUG`
 * request/response recording — then calls `fetchImpl` (or the model's default
 * fetch) exactly once. Providers never layer transport concerns themselves.
 *
 * `hold` is the caller's `beforeDispatch`. It belongs here because this is the
 * only place every HTTP attempt passes through: a provider's own retry loop
 * and its setup requests reach the wire through this fetch and nothing else.
 * The request's own `signal` ends the wait, so cancelling a request parked on
 * a hold no longer leaves it parked forever.
 *
 * Idempotent: the built fetch is stamped and returned as-is on later passes,
 * hold and all — `streamSimple` re-enters `stream`, and `streamSimpleRequest`
 * re-enters itself on auth retries, so without the stamp each entry point
 * would add another layer (three PI_REQ_DEBUG dumps, and three holds, for one
 * request).
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined, hold?: DispatchHold): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH]) return given;
	const base =
		given ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const proxyUrl = getProxyForProvider(model.provider);

	const fetch: TransportFetch = async (input, init) => {
		await holdBeforeDispatch(hold, init?.signal ?? (input instanceof Request ? input.signal : undefined));
		if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") {
			recordDispatchOrigin(model, input);
		}
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		if (!isRequestDebugEnabled()) return base(input, init);
		const session = await createFetchRequestDebugSession(input, init);
		return session.wrapResponse(await base(input, init));
	};
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = true;
	return fetch;
}

const dispatchOrigins = new Map<string, string>();
const DISPATCH_ORIGIN_CACHE_MAX = 1024;

function dispatchKey(model: Model<Api>): string {
	return `${model.provider}\u0000${model.baseUrl}`;
}

function recordDispatchOrigin(model: Model<Api>, input: string | URL | Request): void {
	let origin: string;
	try {
		origin = new URL(input instanceof Request ? input.url : input).origin;
	} catch {
		return;
	}
	const key = dispatchKey(model);
	if (dispatchOrigins.get(key) === origin) return;
	if (dispatchOrigins.size >= DISPATCH_ORIGIN_CACHE_MAX) dispatchOrigins.clear();
	dispatchOrigins.set(key, origin);
}

/**
 * Origin of the last inference request {@link model} actually sent, after
 * every dispatch-time rewrite (credential endpoints, env overrides, regional
 * hosts); `undefined` before its first request.
 */
export function lastDispatchOrigin(model: Model<Api>): string | undefined {
	return dispatchOrigins.get(dispatchKey(model));
}

/** Test hook: forgets every recorded dispatch origin. */
export function resetDispatchOriginsForTesting(): void {
	dispatchOrigins.clear();
}

/**
 * Options-bag form of {@link transportFetch}; returns `options` untouched when
 * its fetch is already built and it gates nothing. A `beforeDispatch` travels
 * into the built fetch, so every HTTP attempt the transport makes waits on it.
 */
export function withTransportFetch<T extends { fetch?: FetchImpl; beforeDispatch?: DispatchHold }>(
	model: Model<Api>,
	options: T,
): T {
	const fetch = transportFetch(model, options.fetch, options.beforeDispatch);
	return fetch === options.fetch ? options : { ...options, fetch };
}
