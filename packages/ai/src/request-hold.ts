/**
 * Provider-request holds: work that has to stay alive but must stop reaching the network.
 *
 * The case it exists for: a subagent whose owner has begun disposing. The owner's teardown still has
 * to decide whether the subagent is parked for revival, detached or ended, so the subagent is not
 * cancelled yet; but nothing it does in the meantime may reach a provider, or any other server. Such
 * work runs in a hold scope. Once the scope's `held` signal aborts, every request made in it (and in
 * scopes nested inside it) waits instead of being sent, until the request's own signal or the `ended`
 * signal of any scope around it aborts, when it is refused with a {@link RequestHeldError}. A refusal
 * is terminal: retry loops do not replay one. A request whose response has begun runs to completion;
 * one still waiting for its response when the hold begins is aborted, and a retry of it waits held.
 *
 * The guarantee lives where the library hands a request to a transport. Every transport site in
 * pi-ai and pi-agent-core asks {@link admitSend} immediately before it sends, with nothing between
 * the answer and the send (no await, and no caller code such as an outbound observer, which could
 * begin the owner's disposal), whatever `globalThis.fetch` is at the time: a fetch through
 * {@link gatedFetch} (each provider's requests, its retries included, and the fetch handed to an SDK
 * client), `coworkFetch`'s `node:https` request, Cursor's HTTP/2 connection and every frame on its
 * run stream, the proxy tunnel's connection, and the Codex and GitLab Duo WebSockets' opens and
 * frames. A frame on a connection already open asks the hold of the request that opened it as well
 * as the writer's own ({@link bindSendAdmission}). A request admitted before the hold whose bytes
 * land later (after a TLS handshake, a WebSocket upgrade, a proxy tunnel) is cut if the hold begins
 * first ({@link cutIfHeldBeforeResponse}). {@link withAuth}, {@link withOAuthAccess} and the
 * streaming driver ({@link stream}) also check before they resolve a credential, so a held caller
 * never starts a credential refresh. Code outside pi-ai that opens such a connection asks
 * `admitNetworkSend` (`@oh-my-pi/pi-utils`), as Cursor's model discovery does.
 *
 * Work one caller starts but every caller shares (a token refresh, a discovery lookup) runs as shared
 * work, `runOutsideRequestHold` (`@oh-my-pi/pi-utils`), so a held caller never holds it for the
 * others. Shared work has no owner, so it may not send a model request: {@link admitSend} refuses one
 * made in it, as do {@link stream} and {@link streamSimple}. Its own fetches go out.
 *
 * Code that never asks is covered by a backstop: `globalThis.fetch` is wrapped process-wide
 * ({@link runInRequestHoldScope} installs the wrapper, and {@link ensureRequestHoldFetch} wraps again
 * whatever replaced it, which the job manager calls when a hold engages). A fetch made through it in
 * a held scope waits; one admitted before the hold but deferred by a fetch beneath it is aborted.
 *
 * The backstop does not cover:
 * - a fetch function captured before the wrapper was installed, or a global fetch put back after the
 *   hold engaged (restoring the global fetch from inside a held scope ends the backstop for every
 *   later caller in the process, until something re-arms it);
 * - `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls` and other WebSocket clients
 *   called directly, outside the library's transports;
 * - worker threads and child processes: they run outside this process's async context, so a held
 *   job's worker sends as if nothing were held.
 */
import {
	currentRequestHoldScope,
	cutIfHeldBefore,
	isRequestHoldScopeHeld,
	type RequestHoldScope,
	refuseWhileHeld,
	requestHoldScopes,
	SHARED_WORK,
} from "@oh-my-pi/pi-utils/request-hold-scope";
import type { ApiKey, ApiKeyResolveContext } from "./auth-retry";
import { AbortError, OwnerlessRequestError, RequestHeldError } from "./error/abort";
import type { FetchImpl } from "./types";

/** Marks the fetch wrapper {@link ensureRequestHoldFetch} installs, so it is installed once per fetch it wraps. */
const FETCH_HOLD = Symbol("request-hold fetch");
/** Marks a fetch {@link gatedFetch} built, so gating it again returns it as is. */
const GATED_FETCH = Symbol("request-hold gated fetch");

/**
 * Run `fn` in a hold scope. Requests made in it wait once `held` aborts; a waiting request is refused
 * when its own signal, `ended`, or the `ended` signal of a scope around this one aborts. A scope
 * nested in a held one is held too. A scope entered from shared work is owned again: by this scope.
 */
export function runInRequestHoldScope<T>(held: AbortSignal, ended: AbortSignal, fn: () => T): T {
	ensureRequestHoldFetch();
	return requestHoldScopes.run({ held, ended, parent: currentRequestHoldScope() }, fn);
}

/** Whether the caller runs in any hold scope (held or not): only then can a request be held later. */
export function inRequestHoldScope(): boolean {
	return currentRequestHoldScope() !== undefined;
}

/** Whether a request made here would wait now: the caller runs in a held scope. */
export function isRequestHeld(): boolean {
	return isRequestHoldScopeHeld(currentRequestHoldScope());
}

/** The refusal of a held request: wait for the end of `scope`'s chain or of `signal`. */
function refuseHeld(scope: RequestHoldScope, signal: AbortSignal | undefined): Promise<never> {
	return refuseWhileHeld(
		scope,
		signal,
		cause => new RequestHeldError("Provider request held: its owner began disposing", { cause }),
	);
}

/**
 * Asked synchronously right before a transport sends. Returns `undefined` when the caller may send
 * now; it must then send in the same turn, with nothing between the answer and the send: no await,
 * and no call into code the library does not own (an observer, a hook, a callback), since that code
 * can begin the owner's disposal. In a held scope it returns a promise that never resolves and rejects
 * once `signal` or any scope around the caller ends; in shared work, a promise that rejects at once
 * with {@link OwnerlessRequestError}.
 *
 * The only call-site pattern: `const refusal = admitSend(signal); if (refusal) await refusal;`
 * immediately followed by the send.
 */
export function admitSend(signal?: AbortSignal): Promise<never> | undefined {
	return admitIn(requestHoldScopes.getStore(), signal);
}

function admitIn(
	store: RequestHoldScope | typeof SHARED_WORK | undefined,
	signal: AbortSignal | undefined,
): Promise<never> | undefined {
	if (store === undefined) return undefined;
	if (store === SHARED_WORK) return Promise.reject(new OwnerlessRequestError());
	if (!isRequestHoldScopeHeld(store)) return undefined;
	return refuseHeld(store, signal);
}

/**
 * Admission for the later sends on a connection opened here: a frame on an open stream or socket (a
 * tool result, a heartbeat, a steer) belongs to the request that opened it, whatever async context
 * writes it. Bind when the connection opens; each call of the returned function answers like
 * {@link admitSend}, refusing when either the opening scope or the writer's own is held, and must be
 * followed by its send in the same way.
 */
export function bindSendAdmission(): (signal?: AbortSignal) => Promise<never> | undefined {
	const opened = requestHoldScopes.getStore();
	return signal => admitIn(opened, signal) ?? admitSend(signal);
}

/**
 * Resolve when work that is not itself a send (a credential resolution, an auth attempt that may not
 * reach a transport of the library) may start. Outside a held scope this returns at once, shared work
 * included; inside one it waits until `signal` or the end of a scope around the caller aborts, then
 * throws {@link AbortError}. A caller that starts right after should check {@link isRequestHeld}
 * itself and await this only when held, so no await separates the check from what it starts.
 */
export async function admitProviderRequest(signal?: AbortSignal): Promise<void> {
	const scope = currentRequestHoldScope();
	if (!isRequestHoldScopeHeld(scope)) return;
	await refuseHeld(scope!, signal);
}

/**
 * `key` with the hold checked before and after each resolution, so a held request starts no
 * credential refresh, and one whose credential was still resolving when its scope became held waits
 * too. Keys outside any hold scope are returned unchanged.
 */
export function holdAroundKeyResolution(key: ApiKey | undefined, signal: AbortSignal | undefined): ApiKey | undefined {
	if (typeof key !== "function" || !inRequestHoldScope()) return key;
	const resolve = key;
	return async (context: ApiKeyResolveContext) => {
		if (isRequestHeld()) await admitProviderRequest(signal);
		const resolved = await resolve(context);
		if (isRequestHeld()) await admitProviderRequest(signal);
		return resolved;
	};
}

/** The signal a fetch call carries: `init.signal`, else that of a `Request` input. */
function requestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

/**
 * Call `cut` with an {@link AbortError} if the hold of the caller's scope (or of a scope around it)
 * begins before the returned release is called (`cutIfHeldBefore` in `@oh-my-pi/pi-utils`). A
 * transport admitted by {@link admitSend} writes its bytes later than the admission (after a TCP or
 * TLS handshake, a WebSocket upgrade, a proxy tunnel): it calls this right after the admission and
 * releases once its response has begun, so a request still waiting for its response when the hold
 * begins is cut instead of landing. A hold that already began when this is called (caller code ran
 * between the admission and here, a socket factory say) cuts on the next microtask. The cut is no
 * refusal: a retry asks the hold again and waits like any other held request, so the job it belongs
 * to stays alive, held, until its owner decides.
 */
export function cutIfHeldBeforeResponse(cut: (reason: AbortError) => void): () => void {
	return cutIfHeldBefore(() =>
		cut(new AbortError("Provider request held: its owner began disposing before its response arrived")),
	);
}

/**
 * Call `send` now, with a signal that also aborts if the hold engages before its response arrives
 * ({@link cutIfHeldBeforeResponse}). A fetch beneath that defers its own send past the hold's start
 * then sends nothing; a response that has begun is not cut, since the link is dropped once the
 * response promise settles.
 */
function sendUntilHeld(
	send: FetchImpl,
	input: string | URL | Request,
	init: RequestInit | undefined,
	signal: AbortSignal | undefined,
): Promise<Response> {
	// Outside every scope no hold can engage later: the scope is fixed by the caller's async context.
	if (!currentRequestHoldScope()) return send(input, init);
	const cut = new AbortController();
	const release = cutIfHeldBeforeResponse(reason => cut.abort(reason));
	let response: Promise<Response>;
	try {
		response = send(input, { ...init, signal: signal ? AbortSignal.any([signal, cut.signal]) : cut.signal });
	} catch (error) {
		release();
		throw error;
	}
	return Promise.resolve(response).finally(release);
}

/** Give `wrapper` what `source` carries of its own (Bun's `fetch.preconnect`); `length` and `name` are the wrapper's. */
function copyFetchProperties(source: FetchImpl, wrapper: FetchImpl): void {
	for (const key of Reflect.ownKeys(source)) {
		if (Object.hasOwn(wrapper, key) || key === "prototype" || key === FETCH_HOLD || key === GATED_FETCH) continue;
		Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(source, key)!);
	}
}

/**
 * A fetch that asks {@link admitSend} before every call and, when admitted, calls `fetchImpl` (or the
 * global fetch, read at call time) in the same turn, linked to the hold as {@link sendUntilHeld}
 * describes. Gating a gated fetch returns it unchanged.
 *
 * Never hand one to shared work (a credential or discovery lookup): there it refuses every request.
 */
export function gatedFetch(fetchImpl?: FetchImpl): FetchImpl {
	if (fetchImpl && Object.hasOwn(fetchImpl, GATED_FETCH)) return fetchImpl;
	const gated: FetchImpl = (input, init) => {
		const signal = requestSignal(input, init);
		const refusal = admitSend(signal);
		if (refusal) return refusal;
		// model-request: none — the gate's own send; the request is declared where `gatedFetch` is called.
		const send: FetchImpl = fetchImpl ?? globalThis.fetch;
		// The backstop checks the hold and links the request itself, in this same call.
		if (Object.hasOwn(send, FETCH_HOLD)) return send(input, init);
		return sendUntilHeld(send, input, init, signal);
	};
	// model-request: none — copies the fetch's own properties (Bun's `preconnect`); sends nothing.
	copyFetchProperties(fetchImpl ?? globalThis.fetch, gated);
	Object.defineProperty(gated, GATED_FETCH, { value: true });
	return gated;
}

/**
 * Wrap the current `globalThis.fetch` in the hold's backstop, unless it already is the wrapper. A
 * fetch called through it in a held scope never reaches the fetch it wraps: it waits (see
 * {@link refuseHeld}). Any other call goes straight through, in the same call, linked to the hold as
 * {@link sendUntilHeld} describes. Called when a scope is entered, and by the job manager when a
 * hold engages, so a global replaced since the scope began is wrapped again.
 */
export function ensureRequestHoldFetch(): void {
	// model-request: none — the hold's wrapper around the global fetch; a request through it is declared where it is made.
	const wrapped = globalThis.fetch;
	if (typeof wrapped !== "function" || Object.hasOwn(wrapped, FETCH_HOLD)) return;
	const holding = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const scope = currentRequestHoldScope();
		const signal = requestSignal(input, init);
		if (isRequestHoldScopeHeld(scope)) return refuseHeld(scope!, signal);
		return sendUntilHeld(wrapped, input, init, signal);
	};
	copyFetchProperties(wrapped, holding);
	Object.defineProperty(holding, FETCH_HOLD, { value: true });
	globalThis.fetch = holding as typeof globalThis.fetch;
}
