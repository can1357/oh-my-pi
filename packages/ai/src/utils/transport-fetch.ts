import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, DispatchHold, FetchImpl, Model, TransportWrapper } from "../types";
import { holdAllBeforeDispatch } from "./dispatch-hold";
import { preResponseGuard } from "./idle-iterator";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";

/** What {@link transportFetch} stamps on a fetch it built. */
interface TransportFetchStamp {
	/** The model it was built for, so {@link withoutDispatchHold} can rebuild it. */
	model: Model<Api>;
	/** The fetch it wraps, so a later hold rebuilds from it instead of layering onto it. */
	base: FetchImpl;
	/**
	 * Every hold the build awaits, in the order they were supplied. A live
	 * build's list grows in place, and every fetch layered over that build
	 * shares it, so a hold added through any of them gates them all.
	 */
	holds: DispatchHold[];
	/** Every caller wrapper baked in, innermost first. */
	wraps: readonly TransportWrapper[];
	/**
	 * Whether this is its request's live transport: a build that carries a
	 * caller's wrapper, whose state is that request's. A later hold joins a live
	 * build and a later wrapper is layered outside it; any other build is
	 * rebuilt instead.
	 */
	live: boolean;
	/** The same transport with no hold, built once on demand for cleanup traffic. */
	unheld?: FetchImpl;
}

const TRANSPORT_FETCH = Symbol("omp.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: TransportFetchStamp };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the caller's `wrap` (outermost), the inference User-Agent default,
 * `NODE_EXTRA_CA_CERTS`, the per-provider proxy, `PI_REQ_DEBUG` request
 * recording, then the caller's dispatch holds — and then calls `fetchImpl` (or
 * the model's default fetch) exactly once. Providers never layer transport
 * concerns themselves.
 *
 * `hold` is the caller's `beforeDispatch`. It belongs here because this is the
 * only place every HTTP attempt passes through: a provider's own retry loop
 * and its setup requests reach the wire through this fetch and nothing else.
 * It runs last, after the request-debug dump: a hold with nothing of ours
 * after it is the whole point, and the debug session awaits the body and the
 * filesystem. The request's own `signal` ends the wait, so cancelling a
 * request parked on a hold no longer leaves it parked forever. Several holds
 * are one barrier ({@link holdAllBeforeDispatch}): the request goes out only
 * when none of them is closed at the same moment.
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
 * dropped, and never costs a second transport layer. A build without a
 * caller's wrapper is rebuilt from the stamped base with it added. A build
 * that carries one is live for its request: its wrappers have counted that
 * request's attempts, and a rebuild would construct them again with none
 * counted. So a hold added later gates that build — the fetch passed in, and
 * every reference to it, waits on the hold from then on — and a wrapper added
 * later is layered outside it, sharing its holds.
 */
export function transportFetch(
	model: Model<Api>,
	fetchImpl: FetchImpl | undefined,
	hold?: DispatchHold,
	wrap?: TransportWrapper,
): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	const stamp = given?.[TRANSPORT_FETCH];
	const addHold = hold && stamp?.holds.includes(hold) !== true ? hold : undefined;
	const addWrap = wrap && stamp?.wraps.includes(wrap) !== true ? wrap : undefined;
	if (given && stamp) {
		if (!addHold && !addWrap) return given;
		if (stamp.live) {
			if (addHold) stamp.holds.push(addHold);
			return addWrap ? layerWrapper(given, stamp, addWrap) : given;
		}
	}
	const base =
		stamp?.base ??
		given ??
		(model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const holds = stamp ? [...stamp.holds] : [];
	if (addHold) holds.push(addHold);
	const wraps = addWrap ? [...(stamp?.wraps ?? []), addWrap] : (stamp?.wraps ?? []);
	return buildTransportFetch(model, base, holds, wraps, wraps.length > 0);
}

/**
 * The same transport without the caller's dispatch hold, for two kinds of
 * traffic. The first is traffic whose purpose is to *stop* paid work: a
 * workflow stop, a cancellation, a session teardown. Gating those behind a hold
 * a human releases is backwards — the remote work the request would end keeps
 * running, and spending, for the whole pause. The second is a request's own
 * credential and token prerequisites: an AWS credential lookup, a Google access
 * token, a provider's session-token exchange. They are not inference traffic:
 * they bill nothing, they go to an identity endpoint rather than the
 * provider's inference host, and the inference request they prepare still
 * holds at the wire right after them. Holding them as well only parks them
 * under their own absolute timeouts, which a pause outlasts. Everything else
 * the wrapper does (User-Agent, `NODE_EXTRA_CA_CERTS`, proxy, `PI_REQ_DEBUG`)
 * still applies. A fetch this layer did not build, or one with no hold that no
 * hold can join later, is returned unchanged.
 */
export function withoutDispatchHold(fetchImpl: FetchImpl): FetchImpl {
	const stamp = (fetchImpl as TransportFetch)[TRANSPORT_FETCH];
	// A live build never stands in for its own unheld transport, even while it
	// has no hold: a hold that joins it later would gate the unheld traffic too.
	if (!stamp || (stamp.holds.length === 0 && !stamp.live)) return fetchImpl;
	// Keeps the caller's wrappers: only the hold is wrong for this traffic.
	// Not live, so a hold given for it later builds another transport instead
	// of gating this one.
	stamp.unheld ??= buildTransportFetch(stamp.model, stamp.base, [], stamp.wraps, false);
	return stamp.unheld;
}

function buildTransportFetch(
	model: Model<Api>,
	base: FetchImpl,
	holds: DispatchHold[],
	wraps: readonly TransportWrapper[],
	live: boolean,
): TransportFetch {
	const proxyUrl = getProxyForProvider(model.provider);

	const inner: FetchImpl = async (input, init) => {
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		// A pre-response budget bounds the provider's latency, so its clock must
		// not run while we prepare the request or hold it: a hold a human
		// releases would otherwise fail the resumed request with `TimeoutError`
		// instead of sending it. It starts again below — with what is left of
		// it, not a fresh budget — when the request goes out.
		const deadline = preResponseGuard(signal);
		deadline?.suspend();
		init = withInferenceUserAgent(input, init);
		const extraCa = resolveExtraCa();
		if (extraCa) init = withExtraCaInit(init, extraCa);
		if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
		const debug = isRequestDebugEnabled() ? await createFetchRequestDebugSession(input, init) : undefined;
		await holdAllBeforeDispatch(holds, signal);
		// Recorded for the request that is now going out, not for one a hold
		// still gates or an abort cancelled.
		if (method === "POST") recordDispatchOrigin(model, input);
		deadline?.resume();
		const response = await base(input, init);
		return debug ? debug.wrapResponse(response) : response;
	};
	// Outermost: an attempt the caller's wrapper declines never reaches the
	// preparation, the hold or the wire above.
	const fetch = wraps.reduce<TransportFetch>((wrapped, wrap) => wrap(wrapped), inner);
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = { model, base, holds, wraps, live };
	return fetch;
}

/**
 * A wrapper added to a live build goes outside it, where a rebuild would have
 * put it, so the wrappers already inside keep the attempts they counted.
 */
function layerWrapper(live: TransportFetch, stamp: TransportFetchStamp, wrap: TransportWrapper): TransportFetch {
	const fetch: TransportFetch = wrap(live);
	if (stamp.base.preconnect) fetch.preconnect = stamp.base.preconnect;
	fetch[TRANSPORT_FETCH] = {
		model: stamp.model,
		base: stamp.base,
		holds: stamp.holds,
		wraps: [...stamp.wraps, wrap],
		live: true,
	};
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
