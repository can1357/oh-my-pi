/**
 * The async-context store behind the provider-request hold, and the one way out of it.
 *
 * All hold logic (when a scope is held, what waits, what is refused) lives in `@oh-my-pi/pi-ai`'s
 * `request-hold.ts`. Only the store is here, so packages pi-ai itself depends on, such as the model
 * catalog, can run their shared work outside every hold.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** One hold scope: held once `held` aborts, over once `ended` aborts; nested in `parent`. */
export interface RequestHoldScope {
	readonly held: AbortSignal;
	readonly ended: AbortSignal;
	readonly parent: RequestHoldScope | undefined;
}

/** The hold scope around the caller, if any. Only `@oh-my-pi/pi-ai`'s `request-hold.ts` enters scopes. */
export const requestHoldScopes = new AsyncLocalStorage<RequestHoldScope>();

/**
 * Run `fn` outside every hold scope, for work that one caller starts but every caller shares: a token
 * or credential refresh, a discovery lookup. Started inside a held caller's scope, such work would be
 * held too, and every other caller awaiting it would wait for that caller's owner to end, then fail
 * with its refusal. Each caller still awaits the shared work with its own signal.
 */
export function runOutsideRequestHold<T>(fn: () => T): T {
	return requestHoldScopes.exit(fn);
}
