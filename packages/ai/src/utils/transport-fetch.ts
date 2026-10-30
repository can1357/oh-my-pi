import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, DispatchHold, FetchImpl, Model, TransportWrapper } from "../types";
import { holdBeforeDispatch } from "./dispatch-hold";
import { preResponseGuard } from "./idle-iterator";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";

/** What {@link transportFetch} stamps on a fetch it built. */
interface TransportFetchStamp {
	/** The model it was built for, so {@link withoutDispatchHold} can rebuild it. */
	model: Model<Api>;
	/** The fetch it wraps, so a later hold rebuilds from it instead of layering onto it. */
	base: FetchImpl;
	/** Every hold baked in, in the order they were supplied. */
	holds: readonly DispatchHold[];
	/** Every caller wrapper baked in, in the order they were supplied. */
	wraps: readonly TransportWrapper[];
	/** The same transport with no hold, built once on demand for cleanup traffic. */
	unheld?: FetchImpl;
}

const TRANSPORT_FETCH = Symbol("omp.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: TransportFetchStamp };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the caller's `wrap` (outermost), the inference User-Agent default,
 * `NODE_EXTRA_CA_CERTS`, the per-provider proxy, `PI_REQ_DEBUG` request
 * recording, then the caller's dispatch hold — and then calls `fetchImpl` (or
 * the model's default fetch) exactly once. Providers never layer transport
 * concerns themselves.
 *
 * `hold` is the caller's `beforeDispatch`. It belongs here because this is the
 * only place every HTTP attempt passes through: a provider's own retry loop
 * and its setup requests reach the wire through this fetch and nothing else.
 * It runs last, after the request-debug dump: a hold with nothing of ours
 * after it is the whole point, and the debug session awaits the body and the
 * filesystem. The request's own `signal` ends the wait, so cancelling a
 * request parked on a hold no longer leaves it parked forever.
 *
 * `wrap` is the caller's `wrapTransport`: a wrapper around the built fetch,
 * for a caller that must *see* each attempt and its response — the only way
 * to answer a provider SDK's own HTTP retry loop, whose budget is a
 * constructor literal. It sits outside everything above, so an attempt it
 * declines costs no hold, no debug dump and no wire traffic, and the hold
 * stays the last step before a request that does go out. It is per-request
 * state (an attempt counter, the caller's report-back): build one per request
 * and never share it between requests, or one request's decision leaks into
 * another's.
 *
 * Idempotent: the built fetch is stamped and returned as-is on later passes,
 * hold and all — `streamSimple` re-enters `stream`, and `streamSimpleRequest`
 * re-enters itself on auth retries, so without the stamp each entry point
 * would add another layer (three PI_REQ_DEBUG dumps, and three holds, for one
 * request). A hold or a wrapper the stamp does not already carry is not
 * dropped: the fetch is rebuilt from the stamped base with it added, which
 * gates or observes the request without a second transport layer.
 */
export function transportFetch(
	model: Model<Api>,
	fetchImpl: FetchImpl | undefined,
	hold?: DispatchHold,
	wrap?: TransportWrapper,
): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	const stamp = given?.[TRANSPORT_FETCH];
	const hasHold = hold === undefined || stamp?.holds.includes(hold) === true;
	const hasWrap = wrap === undefined || stamp?.wraps.includes(wrap) === true;
	if (given && stamp && hasHold && hasWrap) return given;
	const base =
		stamp?.base ??
		given ??
		(model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	return buildTransportFetch(
		model,
		base,
		hasHold || !hold ? (stamp?.holds ?? []) : [...(stamp?.holds ?? []), hold],
		hasWrap || !wrap ? (stamp?.wraps ?? []) : [...(stamp?.wraps ?? []), wrap],
	);
}

/**
 * The same transport without the caller's dispatch hold, for the traffic whose
 * purpose is to *stop* paid work: a workflow stop, a cancellation, a session
 * teardown. Gating those behind a hold a human releases is backwards — the
 * remote work the request would end keeps running, and spending, for the whole
 * pause. Everything else the wrapper does (User-Agent, `NODE_EXTRA_CA_CERTS`,
 * proxy, `PI_REQ_DEBUG`) still applies. A fetch this layer did not build, or
 * one with no hold, is returned unchanged.
 */
export function withoutDispatchHold(fetchImpl: FetchImpl): FetchImpl {
	const stamp = (fetchImpl as TransportFetch)[TRANSPORT_FETCH];
	if (!stamp || stamp.holds.length === 0) return fetchImpl;
	// Keeps the caller's wrappers: only the hold is wrong for cleanup traffic.
	stamp.unheld ??= buildTransportFetch(stamp.model, stamp.base, [], stamp.wraps);
	return stamp.unheld;
}

function buildTransportFetch(
	model: Model<Api>,
	base: FetchImpl,
	holds: readonly DispatchHold[],
	wraps: readonly TransportWrapper[],
): TransportFetch {
	const proxyUrl = getProxyForProvider(model.provider);

	const inner: FetchImpl = async (input, init) => {
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		// A pre-response deadline bounds the provider's latency, so it must not
		// run while we prepare the request or hold it: a hold a human releases
		// would otherwise fail the resumed request with `TimeoutError` instead
		// of sending it. It starts again below, when the request goes out.
		const deadline = preResponseGuard(signal);
		deadline?.suspend();
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		const debug = isRequestDebugEnabled() ? await createFetchRequestDebugSession(input, init) : undefined;
		for (const pending of holds) await holdBeforeDispatch(pending, signal);
		// Recorded for the request that is now going out, not for one a hold
		// still gates or an abort cancelled.
		if (method === "POST") recordDispatchOrigin(model, input);
		deadline?.restart();
		const response = await base(input, init);
		return debug ? debug.wrapResponse(response) : response;
	};
	// Outermost: an attempt the caller's wrapper declines never reaches the
	// preparation, the hold or the wire above.
	const fetch = wraps.reduce<TransportFetch>((wrapped, wrap) => wrap(wrapped), inner);
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = { model, base, holds, wraps };
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
 * its fetch is already built and it neither gates nor observes anything. A
 * `beforeDispatch` and a `wrapTransport` travel into the built fetch, so every
 * HTTP attempt the transport makes waits on the one and passes through the
 * other.
 */
export function withTransportFetch<
	T extends { fetch?: FetchImpl; beforeDispatch?: DispatchHold; wrapTransport?: TransportWrapper },
>(model: Model<Api>, options: T): T {
	const fetch = transportFetch(model, options.fetch, options.beforeDispatch, options.wrapTransport);
	return fetch === options.fetch ? options : { ...options, fetch };
}
