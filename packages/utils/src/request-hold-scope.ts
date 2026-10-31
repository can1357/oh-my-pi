/**
 * The async-context store behind the provider-request hold, the one way out of it, and the checks
 * that packages below `@oh-my-pi/pi-ai` need.
 *
 * Scopes are entered only by `@oh-my-pi/pi-ai`'s `request-hold.ts` (`runInRequestHoldScope`), which
 * also owns the transport gate (`admitSend`, `gatedFetch`). What lives here is what packages pi-ai
 * itself depends on, such as the model catalog, must reach without importing pi-ai: the store, shared
 * work ({@link runOutsideRequestHold}), and the admission a shared flight asks before it starts
 * ({@link admitSharedStart}).
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** One hold scope: held once `held` aborts, over once `ended` aborts; nested in `parent`. */
export interface RequestHoldScope {
	readonly held: AbortSignal;
	readonly ended: AbortSignal;
	readonly parent: RequestHoldScope | undefined;
}

/**
 * Marks work run with {@link runOutsideRequestHold}. Such work is shared by every caller, so it is
 * owned by none: no hold applies to it, and pi-ai refuses a model request made in it.
 */
export const SHARED_WORK = Symbol("request-hold shared work");

/**
 * What the caller runs in: a hold scope, shared work ({@link SHARED_WORK}), or neither (`undefined`).
 * Only `@oh-my-pi/pi-ai`'s `request-hold.ts` enters scopes.
 */
export const requestHoldScopes = new AsyncLocalStorage<RequestHoldScope | typeof SHARED_WORK>();

/** The hold scope around the caller; `undefined` outside every scope and in shared work. */
export function currentRequestHoldScope(): RequestHoldScope | undefined {
	const store = requestHoldScopes.getStore();
	return store === SHARED_WORK ? undefined : store;
}

/** Whether the caller runs in shared work ({@link runOutsideRequestHold}). */
export function inSharedWork(): boolean {
	return requestHoldScopes.getStore() === SHARED_WORK;
}

/** Whether `scope` or a scope around it is held. */
export function isRequestHoldScopeHeld(scope: RequestHoldScope | undefined): boolean {
	for (let current = scope; current; current = current.parent) {
		if (current.held.aborted) return true;
	}
	return false;
}

/**
 * Wait until `signal` or the end of `scope` or of any scope around it aborts, then reject with
 * `refusal(<the reason it ended>)`. Every end in the chain counts: a request waiting in an inner scope
 * is refused when an outer owner ends, and one held by an outer scope is refused when its own inner
 * scope ends.
 */
export function refuseWhileHeld(
	scope: RequestHoldScope,
	signal: AbortSignal | undefined,
	refusal: (cause: unknown) => Error,
): Promise<never> {
	const stops: AbortSignal[] = signal ? [signal] : [];
	for (let current: RequestHoldScope | undefined = scope; current; current = current.parent) {
		stops.push(current.ended);
	}
	const stop = stops.length === 1 ? stops[0] : AbortSignal.any(stops);
	const { promise, reject } = Promise.withResolvers<never>();
	const refuse = (): void => reject(refusal(stop.reason));
	if (stop.aborted) refuse();
	else stop.addEventListener("abort", refuse, { once: true });
	return promise;
}

/** Marks an error as a refusal of the provider-request hold; see {@link isRequestRefusal}. */
const REQUEST_REFUSAL = Symbol.for("omp.request-hold.refusal");

/**
 * Mark `error` as a refusal of the provider-request hold: the request was held and its owner ended, or
 * it was made where no owner exists. A retry is refused the same way, so no retry loop replays it.
 */
export function markRequestRefusal<E extends Error>(error: E): E {
	Object.defineProperty(error, REQUEST_REFUSAL, { value: true });
	return error;
}

/** Whether `error`, or an error in its `cause` chain, is a refusal of the provider-request hold. */
export function isRequestRefusal(error: unknown): boolean {
	for (let current = error, depth = 0; current instanceof Error && depth < 8; current = current.cause, depth++) {
		if (Object.hasOwn(current, REQUEST_REFUSAL)) return true;
	}
	return false;
}

/** The refusal of shared work a held caller tried to start. */
export class SharedStartHeldError extends Error {
	constructor(cause: unknown) {
		super("Shared work not started: its caller is held, its owner began disposing", { cause });
		// Named like every other cancellation, so callers that tell an abort from a failure treat it as one.
		this.name = "AbortError";
		markRequestRefusal(this);
	}
}

/**
 * Asked synchronously right before shared work starts a new flight (a credential refresh, a usage
 * poll, a discovery lookup). Returns `undefined` when the caller may start it now; the caller must
 * then start it in the same turn, with no await between. A held caller gets a promise that never
 * resolves and rejects once `signal` or any scope around the caller ends, so a caller whose owner
 * began disposing never starts work on the network. Joining a flight already in flight needs no
 * admission, and shared work may start shared work of its own.
 *
 * The only call-site pattern: `const refusal = admitSharedStart(signal); if (refusal) await refusal;`
 */
export function admitSharedStart(signal?: AbortSignal): Promise<never> | undefined {
	const scope = currentRequestHoldScope();
	if (!isRequestHoldScopeHeld(scope)) return undefined;
	return refuseWhileHeld(scope!, signal, cause => new SharedStartHeldError(cause));
}

/** The refusal of a network send (not a model request) made from a held scope. */
export class NetworkSendHeldError extends Error {
	constructor(cause: unknown) {
		super("Network request held: its owner began disposing", { cause });
		this.name = "AbortError";
		markRequestRefusal(this);
	}
}

/**
 * Asked synchronously right before code outside the transport packages opens a connection that is
 * not a `fetch` (an HTTP/2 session, a raw socket): the hold's backstop wraps only the global fetch,
 * so any other transport asks itself. Returns `undefined` when the caller may connect now; it must
 * then connect in the same turn, with nothing between the answer and the connection. A held caller
 * gets a promise that never resolves and rejects (with a refusal, see {@link isRequestRefusal}) once
 * `signal` or any scope around the caller ends. Shared work may connect: its requests belong to no
 * caller (a model request made in it is refused by pi-ai's own gate).
 *
 * The only call-site pattern: `const refusal = admitNetworkSend(signal); if (refusal) await refusal;`
 * immediately followed by the connection, then {@link cutIfHeldBefore} until its response begins.
 */
export function admitNetworkSend(signal?: AbortSignal): Promise<never> | undefined {
	const scope = currentRequestHoldScope();
	if (!isRequestHoldScopeHeld(scope)) return undefined;
	return refuseWhileHeld(scope!, signal, cause => new NetworkSendHeldError(cause));
}

/**
 * Call `cut` if the hold of the caller's scope (or of a scope around it) begins before the returned
 * release is called. A connection admitted now sends its bytes later (after a TCP or TLS handshake, a
 * WebSocket upgrade, a proxy tunnel); the caller registers this right after the admission and releases
 * once the response has begun, so a request still waiting for its response when the hold begins is cut
 * instead of landing. A hold that already began when this is called cuts on the next microtask, once
 * the caller has finished setting the request up. Outside every scope no hold can begin later.
 */
export function cutIfHeldBefore(cut: () => void): () => void {
	const scope = currentRequestHoldScope();
	if (!scope) return () => {};
	const holds: AbortSignal[] = [];
	for (let current: RequestHoldScope | undefined = scope; current; current = current.parent) holds.push(current.held);
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		for (const held of holds) held.removeEventListener("abort", onHold);
	};
	const onHold = (): void => {
		if (released) return;
		release();
		cut();
	};
	if (holds.some(held => held.aborted)) {
		queueMicrotask(onHold);
		return release;
	}
	for (const held of holds) held.addEventListener("abort", onHold, { once: true });
	return release;
}

/**
 * Run `fn` outside every hold scope, for work that one caller starts but every caller shares: a token
 * or credential refresh, a discovery lookup. Started inside a held caller's scope, such work would be
 * held too, and every other caller awaiting it would wait for that caller's owner to end, then fail
 * with its refusal. Each caller still awaits the shared work with its own signal.
 *
 * The work belongs to no caller, so it may not make a model request: pi-ai refuses one made in it
 * as having no owner. Its own requests (the credential, usage or discovery request it exists for) go
 * out.
 */
export function runOutsideRequestHold<T>(fn: () => T): T {
	return requestHoldScopes.run(SHARED_WORK, fn);
}
