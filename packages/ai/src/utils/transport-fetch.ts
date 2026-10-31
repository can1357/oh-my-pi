import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";
import {
	countWireAttempts,
	createWireAttempts,
	inheritWireAttempts,
	uncountedFetchOf,
	wireAttemptsOf,
	withUncountedSibling,
} from "./wire-attempts";

/** Stamped on a fetch already built by {@link transportFetch}. */
const TRANSPORT_FETCH = Symbol("omp.transportFetch");
/** Stamped on a transport built over a caller-supplied `fetch`, which the request's count cannot see into. */
const CALLER_BASE = Symbol("omp.transportCallerBase");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: true; [CALLER_BASE]?: boolean };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the
 * per-provider proxy, and `PI_REQ_DEBUG` request/response recording — then
 * calls `fetchImpl` (or the model's default fetch) exactly once. Providers
 * never layer transport concerns themselves.
 *
 * It does not count requests. A built transport may be handed to many calls,
 * and a count kept on it would add one call's requests to the next; the count
 * belongs to the logical request ({@link withRequestTransport}). When
 * `fetchImpl` already carries a request's counter — a replay-safe wrapper
 * called the provider directly and counts through it — the transport keeps
 * that counter readable (`wireAttemptsOf`) and offers the uncounted path
 * beside it (`uncountedFetchOf`).
 *
 * Idempotent: the built fetch is stamped and returned as-is on later passes.
 * `streamSimple` re-enters `stream`, and `streamSimpleRequest` re-enters itself
 * on auth retries, so without the stamp each entry point would add another
 * layer (three PI_REQ_DEBUG dumps for one request).
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH]) return given;
	const base =
		given ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const proxyUrl = getProxyForProvider(model.provider);

	const through =
		(target: FetchImpl): FetchImpl =>
		async (input, init) => {
			if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") {
				recordDispatchOrigin(model, input);
			}
			init = withInferenceUserAgent(input, init);
			const extraCa = resolveExtraCa();
			if (extraCa) init = withExtraCaInit(init, extraCa);
			if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
			if (!isRequestDebugEnabled()) return target(input, init);
			const session = await createFetchRequestDebugSession(input, init);
			return session.wrapResponse(await target(input, init));
		};
	const fetch: TransportFetch = through(base);
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = true;
	const counted = given !== undefined && wireAttemptsOf(given) !== undefined;
	fetch[CALLER_BASE] = given !== undefined && !counted;
	if (counted) withUncountedSibling(inheritWireAttempts(fetch, base), through(uncountedFetchOf(base)));
	return fetch;
}

/**
 * `options` with the fetch one logical request is sent through: its transport
 * ({@link transportFetch}) under that request's own counter (`countWireAttempts`).
 * Applied at each inference entry, `stream()` and `streamSimple()`.
 *
 * A call whose fetch is already a counted transport is the same request coming
 * back — the authentication retry calls `streamSimple` again with the options
 * it was given — and keeps its counter. Every other call starts a new one, even
 * when the caller hands each call the same built transport, so no call reports
 * another call's requests. A transport over a caller-supplied `fetch` gets an
 * opaque counter, and reports no count.
 */
export function withRequestTransport<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const given = options.fetch as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH] && wireAttemptsOf(given)) return options;
	const transport = transportFetch(model, given) as TransportFetch;
	if (wireAttemptsOf(transport)) return { ...options, fetch: transport };
	const counted = countWireAttempts(
		createWireAttempts(),
		transport,
		transport[CALLER_BASE] === true,
	) as TransportFetch;
	counted[TRANSPORT_FETCH] = true;
	return { ...options, fetch: counted };
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
