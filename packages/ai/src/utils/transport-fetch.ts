import { resolveExtraCa, withExtraCaInit } from "@oh-my-pi/pi-utils";
import { coworkFetch } from "../providers/cowork-fetch";
import { withInferenceUserAgent } from "../providers/inference-headers";
import type { Api, FetchImpl, Model } from "../types";
import { getProxyForProvider, withProxyInit } from "./proxy";
import { createFetchRequestDebugSession, isRequestDebugEnabled } from "./request-debug";
import { countWireAttempts, createWireAttempts, inheritWireAttempts, withUncountedSibling } from "./wire-attempts";

/** Stamped on a fetch already built by {@link transportFetch}. */
const TRANSPORT_FETCH = Symbol("omp.transportFetch");

type TransportFetch = FetchImpl & { [TRANSPORT_FETCH]?: true };

/**
 * The one fetch every inference request goes through. Per call it applies, in
 * order: the inference User-Agent default, `NODE_EXTRA_CA_CERTS`, the
 * per-provider proxy, and `PI_REQ_DEBUG` request/response recording — then
 * calls `fetchImpl` (or the model's default fetch) exactly once. Providers
 * never layer transport concerns themselves.
 *
 * That single call is where the request is issued, so it is where the
 * request is counted (`countWireAttempts`): every resend a provider or a
 * wrapper above makes passes through here, and the counter rides on the
 * returned fetch for the provider to read. A caller-supplied `fetchImpl` is
 * opaque to the count — it may resend inside itself. A request that is not an
 * attempt at the model request (the Vertex OAuth token) takes the uncounted
 * sibling (`uncountedFetchOf`), which applies the same transport concerns.
 *
 * Idempotent: the built fetch is stamped and returned as-is on later passes.
 * `streamSimple` re-enters `stream`, and `streamSimpleRequest` re-enters itself
 * on auth retries, so without the stamp each entry point would add another
 * layer (three PI_REQ_DEBUG dumps for one request) — and the request's counter
 * would restart on every re-entry.
 */
export function transportFetch(model: Model<Api>, fetchImpl: FetchImpl | undefined): FetchImpl {
	const given = fetchImpl as TransportFetch | undefined;
	if (given?.[TRANSPORT_FETCH]) return given;
	const base =
		given ?? (model.provider === "anthropic" && model.api === "anthropic-messages" ? coworkFetch : globalThis.fetch);
	const issue = countWireAttempts(createWireAttempts(), base, given !== undefined);
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
	const fetch: TransportFetch = through(issue);
	if (issue.preconnect) fetch.preconnect = issue.preconnect;
	fetch[TRANSPORT_FETCH] = true;
	return withUncountedSibling(inheritWireAttempts(fetch, issue), through(base));
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

/** Options-bag form of {@link transportFetch}; returns `options` untouched when its fetch is already built. */
export function withTransportFetch<T extends { fetch?: FetchImpl }>(model: Model<Api>, options: T): T {
	const fetch = transportFetch(model, options.fetch);
	return fetch === options.fetch ? options : { ...options, fetch };
}
