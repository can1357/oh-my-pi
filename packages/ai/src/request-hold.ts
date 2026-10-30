/**
 * Provider-request holds: work that has to stay alive but must stop calling providers.
 *
 * The case it exists for: a subagent whose owner has begun disposing. The owner's teardown still has
 * to decide whether the subagent is parked for revival, detached or ended, so the subagent is not
 * cancelled yet; but nothing it does in the meantime may reach a provider. Such work runs in a hold
 * scope. Once the scope's `held` signal aborts, every provider request made in it (and in scopes
 * nested inside it) waits instead of being sent, until the request's own signal or the scope's
 * `ended` signal aborts, when it is refused with an {@link AbortError}. A request already sent before
 * the hold runs to completion.
 *
 * The streaming driver ({@link stream}) and {@link withAuth}, which every non-streaming credentialed
 * request uses, check the hold before each attempt and again after its credential resolves, so a
 * request waiting for its credential when the hold begins is held too.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiKey, ApiKeyResolveContext } from "./auth-retry";
import { AbortError } from "./error/abort";

interface HoldScope {
	readonly held: AbortSignal;
	readonly ended: AbortSignal;
	readonly parent: HoldScope | undefined;
}

const holdScopes = new AsyncLocalStorage<HoldScope>();

/**
 * Run `fn` in a hold scope. Provider requests made in it wait once `held` aborts; a waiting request is
 * refused when its own signal or `ended` aborts. A scope nested in a held one is held too.
 */
export function runInRequestHoldScope<T>(held: AbortSignal, ended: AbortSignal, fn: () => T): T {
	return holdScopes.run({ held, ended, parent: holdScopes.getStore() }, fn);
}

/** The innermost held scope around the caller, if any. */
function heldScope(): HoldScope | undefined {
	for (let scope = holdScopes.getStore(); scope; scope = scope.parent) {
		if (scope.held.aborted) return scope;
	}
	return undefined;
}

/** Whether the caller runs in any hold scope (held or not): only then can a request be held later. */
export function inRequestHoldScope(): boolean {
	return holdScopes.getStore() !== undefined;
}

/** Whether a provider request made here would wait now: the caller runs in a held scope. */
export function isRequestHeld(): boolean {
	return heldScope() !== undefined;
}

/**
 * Resolve when a provider request made here may be sent. Outside a held scope this returns at once;
 * inside one it waits until `signal` or the scope's end aborts, then throws {@link AbortError}.
 */
export async function admitProviderRequest(signal?: AbortSignal): Promise<void> {
	const scope = heldScope();
	if (!scope) return;
	const stop = signal ? AbortSignal.any([signal, scope.ended]) : scope.ended;
	const { promise, reject } = Promise.withResolvers<never>();
	const refuse = (): void =>
		reject(
			new AbortError("Provider request held: its owner began disposing", {
				cause: stop.reason,
			}),
		);
	if (stop.aborted) refuse();
	else stop.addEventListener("abort", refuse, { once: true });
	await promise;
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
