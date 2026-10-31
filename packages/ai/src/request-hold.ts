/**
 * Provider-request holds: work that has to stay alive but must stop reaching the network.
 *
 * The case it exists for: a subagent whose owner has begun disposing. The owner's teardown still has
 * to decide whether the subagent is parked for revival, detached or ended, so the subagent is not
 * cancelled yet; but nothing it does in the meantime may reach a provider, or any other server. Such
 * work runs in a hold scope. Once the scope's `held` signal aborts, every request made in it (and in
 * scopes nested inside it) waits instead of being sent, until the request's own signal or the `ended`
 * signal of any scope around it aborts, when it is refused with an {@link AbortError}. A request
 * already sent before the hold runs to completion.
 *
 * The hold is enforced where a request is sent, so no await separates the check from the send:
 *
 * - `globalThis.fetch` is wrapped, process-wide ({@link runInRequestHoldScope} installs the wrapper,
 *   and wraps again whatever replaced it since). Every fetch made in a held scope waits there instead
 *   of reaching the fetch it wraps: each attempt and retry of a provider request, the per-provider
 *   stream functions called directly, raw adapters (search providers, Hindsight, MCP over HTTP, OAuth
 *   endpoints) and a tool's own requests alike.
 * - The Codex WebSocket transport checks before it opens a socket and before each frame it sends.
 *
 * {@link withAuth}, {@link withOAuthAccess} and the streaming driver ({@link stream}) also check
 * before each attempt, and a resolver key is checked again once it resolves, so an attempt that does
 * not use fetch is held too.
 *
 * Work one caller starts but every caller shares (a token refresh, a discovery lookup) is started
 * outside every hold with `runOutsideRequestHold` (`@oh-my-pi/pi-utils`), so a held caller never
 * holds it for the others. The scope store lives there, beside it, so packages pi-ai depends on can
 * use it too.
 *
 * Not covered: a fetch function captured before the wrapper was installed, `node:http`/`node:https`
 * and HTTP/2 clients, raw sockets, other WebSocket transports, and child processes.
 */
import { type RequestHoldScope, requestHoldScopes } from "@oh-my-pi/pi-utils/request-hold-scope";
import type { ApiKey, ApiKeyResolveContext } from "./auth-retry";
import { AbortError } from "./error/abort";

/** Marks the fetch wrapper {@link installFetchHold} installs, so it is installed once per fetch it wraps. */
const FETCH_HOLD = Symbol("request-hold fetch");

/**
 * Run `fn` in a hold scope. Requests made in it wait once `held` aborts; a waiting request is refused
 * when its own signal, `ended`, or the `ended` signal of a scope around this one aborts. A scope
 * nested in a held one is held too.
 */
export function runInRequestHoldScope<T>(held: AbortSignal, ended: AbortSignal, fn: () => T): T {
	installFetchHold();
	return requestHoldScopes.run({ held, ended, parent: requestHoldScopes.getStore() }, fn);
}

/** Whether `scope` or a scope around it is held. */
function isHeld(scope: RequestHoldScope | undefined): boolean {
	for (let current = scope; current; current = current.parent) {
		if (current.held.aborted) return true;
	}
	return false;
}

/** Whether the caller runs in any hold scope (held or not): only then can a request be held later. */
export function inRequestHoldScope(): boolean {
	return requestHoldScopes.getStore() !== undefined;
}

/** Whether a request made here would wait now: the caller runs in a held scope. */
export function isRequestHeld(): boolean {
	return isHeld(requestHoldScopes.getStore());
}

/**
 * Wait until `signal` or the end of `scope` or of any scope around it aborts, then throw
 * {@link AbortError}. Every end in the chain counts: a request waiting in an inner scope is refused
 * when an outer owner ends, and one held by an outer scope is refused when its own inner scope ends.
 */
function refuseHeld(scope: RequestHoldScope, signal: AbortSignal | undefined): Promise<never> {
	const stops: AbortSignal[] = signal ? [signal] : [];
	for (let current: RequestHoldScope | undefined = scope; current; current = current.parent) {
		stops.push(current.ended);
	}
	const stop = stops.length === 1 ? stops[0] : AbortSignal.any(stops);
	const { promise, reject } = Promise.withResolvers<never>();
	const refuse = (): void =>
		reject(new AbortError("Provider request held: its owner began disposing", { cause: stop.reason }));
	if (stop.aborted) refuse();
	else stop.addEventListener("abort", refuse, { once: true });
	return promise;
}

/**
 * Resolve when a request made here may be sent. Outside a held scope this returns at once; inside one
 * it waits until `signal` or the end of a scope around the caller aborts, then throws
 * {@link AbortError}. A caller that sends right after should check {@link isRequestHeld} itself and
 * await this only when held, so no await separates the check from its send.
 */
export async function admitProviderRequest(signal?: AbortSignal): Promise<void> {
	const scope = requestHoldScopes.getStore();
	if (!isHeld(scope)) return;
	await refuseHeld(scope!, signal);
}

/**
 * `key` with the hold checked after each resolution, so a request whose credential was still
 * resolving when its scope became held waits too. Keys outside any hold scope are returned unchanged.
 */
export function holdAfterKeyResolution(key: ApiKey | undefined, signal: AbortSignal | undefined): ApiKey | undefined {
	if (typeof key !== "function" || !inRequestHoldScope()) return key;
	const resolve = key;
	return async (context: ApiKeyResolveContext) => {
		const resolved = await resolve(context);
		await admitProviderRequest(signal);
		return resolved;
	};
}

/**
 * Wrap the current `globalThis.fetch` in the hold, unless it is already the wrapper. A fetch called
 * in a held scope never reaches the fetch it wraps: it waits (see {@link refuseHeld}). Any other call
 * goes straight through, in the same call, so a check and its send are never apart.
 */
function installFetchHold(): void {
	// model-request: none — the hold's wrapper around the global fetch; a request through it is declared where it is made.
	const wrapped = globalThis.fetch;
	if (typeof wrapped !== "function" || Object.hasOwn(wrapped, FETCH_HOLD)) return;
	const holding = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const scope = requestHoldScopes.getStore();
		if (isHeld(scope)) {
			// Refused on the request's own signal: `init.signal`, else that of a `Request` input.
			return refuseHeld(scope!, init?.signal ?? (input instanceof Request ? input.signal : undefined));
		}
		return wrapped(input, init);
	};
	// Keep what the wrapped fetch carries of its own (Bun's `fetch.preconnect`); `length` and `name`
	// are the wrapper's.
	for (const key of Reflect.ownKeys(wrapped)) {
		if (Object.hasOwn(holding, key) || key === "prototype") continue;
		Object.defineProperty(holding, key, Object.getOwnPropertyDescriptor(wrapped, key)!);
	}
	Object.defineProperty(holding, FETCH_HOLD, { value: true });
	globalThis.fetch = holding as typeof globalThis.fetch;
}
