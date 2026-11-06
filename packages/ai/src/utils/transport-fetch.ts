import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { ReplayBudget, withReplayBudget } from "./replay-budget";
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

interface TransportSetup extends TransportHooks {
	readonly model: Model<Api>;
	readonly base: FetchImpl;
	readonly callerBase: boolean;
}

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: TransportSetup };

/**
 * The two hooks a built transport calls around a dispatch. They are named
 * rather than positional because they sit at different moments and a caller
 * passing one in the other's place would be silently wrong.
 */
export interface TransportHooks {
	/**
	 * The call's replay budget. Its `checkpoint` runs at the last moment before
	 * the bytes leave — after every preparation hook and the debug session — so
	 * a replay the budget has refused is never handed to the transport.
	 */
	replayBudget?: ReplayBudget;
	/**
	 * Runs before the dispatch is prepared at all, so an account a rate limit
	 * has blocked is switched before the headers and the dispatch origin are
	 * taken from it.
	 */
	beforeDispatch?: () => void;
}

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the
 * per-provider proxy, and `PI_REQ_DEBUG` request/response recording — then
 * calls `fetchImpl` (or the model's default fetch) exactly once.
 *
 * `beforeDispatch` runs for every HTTP attempt, including retries, before
 * dispatch bookkeeping; a thrown refusal prevents that attempt.
 *
 * With a `replayBudget`, its checkpoint runs immediately before that one
 * call — after the debug recording and every other step — so an armed replay
 * whose deadline passed while it was prepared is refused at the last moment
 * the library holds the request. The checkpoint never releases the replay:
 * a token fetch made through this fetch cannot stand in for the replay's own
 * request, which the provider's send gate releases.
 * It does not count requests. A built transport may be handed to many calls,
 * and a count kept on it would add one call's requests to the next; the count
 * belongs to the logical request ({@link withRequestTransport}). When
 * `fetchImpl` already carries a request's counter — a replay-safe wrapper
 * called the provider directly and counts through it — the transport keeps
 * that counter readable (`wireAttemptsOf`) and offers the uncounted path
 * beside it (`uncountedFetchOf`).
 *
 * Re-entry with the same model and hooks returns the built fetch unchanged.
 * New hooks rebuild over its underlying base, never over another transport,
 * so `streamSimple` and authentication retries retain one debug layer without
 * retaining a different call's budget or mutating its hooks.
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined, hooks?: TransportHooks): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	const previous = given?.[TRANSPORT_FETCH];
	const replayBudget = hooks && Object.hasOwn(hooks, "replayBudget") ? hooks.replayBudget : previous?.replayBudget;
	const beforeDispatch =
		hooks && Object.hasOwn(hooks, "beforeDispatch") ? hooks.beforeDispatch : previous?.beforeDispatch;
	if (
		previous?.model === model &&
		previous.replayBudget === replayBudget &&
		previous.beforeDispatch === beforeDispatch
	)
		return given!;
	const base =
		previous?.base ??
		given ??
		(model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const checkpoint = replayBudget?.checkpoint;
	const setup: TransportSetup = {
		model,
		base,
		replayBudget,
		beforeDispatch,
		callerBase: previous?.callerBase ?? (given !== undefined && wireAttemptsOf(given) === undefined),
	};
	const proxyUrl = getProxyForProvider(model.provider);

	const through =
		(target: FetchImpl): FetchImpl =>
		async (input, init) => {
			// Before anything is prepared: a blocked account is switched here, so the
			// headers and the dispatch origin below belong to the account that sends.
			beforeDispatch?.();
			if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST") {
				recordDispatchOrigin(model, input);
			}
			init = withInferenceUserAgent(input, init);
			const extraCa = resolveExtraCa();
			if (extraCa) init = withExtraCaInit(init, extraCa);
			if (proxyUrl) init = withProxyInit(input, init, proxyUrl);
			if (!isRequestDebugEnabled()) {
				checkpoint?.();
				return target(input, init);
			}
			const session = await createFetchRequestDebugSession(input, init);
			checkpoint?.();
			return session.wrapResponse(await target(input, init));
		};
	const fetch: TransportFetch = through(base);
	if (base.preconnect) fetch.preconnect = base.preconnect;
	fetch[TRANSPORT_FETCH] = setup;
	if (wireAttemptsOf(base)) {
		withUncountedSibling(inheritWireAttempts(fetch, base), through(uncountedFetchOf(base)));
	} else if (previous && given) {
		const attempts = wireAttemptsOf(given);
		if (attempts) {
			const counted = countWireAttempts(attempts, fetch, setup.callerBase) as TransportFetch;
			counted[TRANSPORT_FETCH] = setup;
			return counted;
		}
	}
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
 *
 * The options also come back carrying the call's replay budget
 * (`withReplayBudget`), and the transport checks it at its last step: a call
 * made without one starts its deadline here, before any header resolution or
 * token fetch.
 */
export function withRequestTransport<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const budgeted = withReplayBudget(options);
	const given = budgeted.fetch as TransportFetch | undefined;
	const transport = transportFetch(model, given, { replayBudget: ReplayBudget.forCall(budgeted) }) as TransportFetch;
	if (wireAttemptsOf(transport)) return transport === given ? budgeted : { ...budgeted, fetch: transport };
	const counted = countWireAttempts(
		createWireAttempts(),
		transport,
		transport[TRANSPORT_FETCH]?.callerBase === true,
	) as TransportFetch;
	counted[TRANSPORT_FETCH] = transport[TRANSPORT_FETCH];
	return { ...budgeted, fetch: counted };
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
