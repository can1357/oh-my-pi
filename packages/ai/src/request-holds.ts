/**
 * Holds on model requests, carried by async context.
 *
 * A host that must keep model requests from reaching the network for a while
 * — while a session is moved, paused or otherwise not ready — registers a
 * {@link RequestHolds} for the code that may start them, with
 * {@link runWithRequestHolds}. Every request started inside that async
 * context, by whatever code starts it, waits for those holds at its send:
 * each transport sends through {@link afterRequestHolds}, after its
 * `onPayload` hook and every other step that prepares the request, so the
 * last thing before the network I/O is a check of the holds.
 *
 * The context follows the async flow: promise continuations, timers,
 * `setImmediate`, `process.nextTick`, `queueMicrotask` and event emitters all
 * run in the context that scheduled them. A message from a `Worker` does not:
 * its handler runs outside any context, so code that starts requests for a
 * worker takes a {@link captureRequestHolds} snapshot where the worker is
 * started and runs its handler in it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { untilAborted } from "@oh-my-pi/pi-utils";

/** One request's view of a set of holds, opened once and kept for the rest of the request. */
export interface RequestHoldView {
	/**
	 * What the request must wait for now, or `undefined` when nothing holds
	 * it. Asked synchronously at each check; it only reports, and must not
	 * start or change anything.
	 */
	check(): Promise<void> | undefined;
	/** The request no longer waits on these holds. Called once per view opened by {@link afterRequestHolds}. */
	release(): void;
}

/** A set of holds a host registers for every request started in a context. */
export interface RequestHolds {
	/** Opens one request's view of these holds. */
	open(): RequestHoldView;
}

interface Scope {
	readonly holds: RequestHolds;
	/** The view the request running in this scope carries, while `open`. */
	readonly view: RequestHoldView | undefined;
	/** The holds do not apply in this scope (see {@link runOutsideRequestHolds}). */
	readonly exempt: boolean;
	open: boolean;
	readonly parent: Scope | undefined;
}

const scopes = new AsyncLocalStorage<Scope>();

function enter<T>(holds: RequestHolds, view: RequestHoldView | undefined, exempt: boolean, fn: () => T): T {
	const scope: Scope = { holds, view, exempt, open: true, parent: scopes.getStore() };
	return scopes.run(scope, fn);
}

/**
 * Runs `fn` so that every model request it starts, now or later in its async
 * flow, waits for `holds` at its send, in addition to the holds of the
 * context it was called in.
 */
export function runWithRequestHolds<T>(holds: RequestHolds, fn: () => T): T {
	return enter(holds, undefined, false, fn);
}

/**
 * Runs `fn` — one request, from its preparation to its send — carrying
 * `view`, its own view of `holds`: each check made inside it for `holds`,
 * the transport's included, asks `view` rather than opening another, so the
 * view's own state (a deadline, say) is shared by all of them. Once `fn`
 * settles, work it left behind opens views of its own. The caller releases
 * `view`.
 */
export async function runWithRequestHoldView<T>(
	holds: RequestHolds,
	view: RequestHoldView,
	fn: () => Promise<T>,
): Promise<T> {
	const scope: Scope = { holds, view, exempt: false, open: true, parent: scopes.getStore() };
	try {
		return await scopes.run(scope, fn);
	} finally {
		scope.open = false;
	}
}

/**
 * Runs `fn` so that `holds` does not hold the requests it starts: for work
 * the holds themselves wait for, which would otherwise wait for itself.
 * Other holds of the context still apply.
 */
export function runOutsideRequestHolds<T>(holds: RequestHolds, fn: () => T): T {
	return enter(holds, undefined, true, fn);
}

/** The holds of a context, taken with {@link captureRequestHolds}. */
export interface RequestHoldContext {
	/** The holds the context had, nearest first. A hold the context was exempt from is not listed. */
	readonly holds: readonly RequestHolds[];
	/**
	 * Runs `fn` with the captured holds and exemptions added to the context
	 * it is called in. Views carried by a request at capture are not: work
	 * run later opens views of its own.
	 */
	run<T>(fn: () => T): T;
}

/** A snapshot of the current context's holds, for work that leaves the async flow (a `Worker` message handler, a queue drained elsewhere). */
export function captureRequestHolds(): RequestHoldContext {
	const entries: Array<{ holds: RequestHolds; exempt: boolean }> = [];
	const seen = new Set<RequestHolds>();
	for (let scope = scopes.getStore(); scope; scope = scope.parent) {
		if (seen.has(scope.holds)) continue;
		seen.add(scope.holds);
		entries.push({ holds: scope.holds, exempt: scope.exempt });
	}
	return {
		holds: entries.filter(entry => !entry.exempt).map(entry => entry.holds),
		run<T>(fn: () => T): T {
			let run = fn;
			// Outermost first, so the nearest ends up nearest again.
			for (const entry of entries) {
				const inner = run;
				run = () => enter(entry.holds, undefined, entry.exempt, inner);
			}
			return run();
		},
	};
}

/**
 * Sends one model request — `send` starts its network I/O — once no hold of
 * the current context holds it. The last check and `send` run in the same
 * turn, with nothing awaited between them, so a hold registered at any point
 * before `send` is called holds the request. Every transport calls its I/O
 * through this after `onPayload` and every other preparation step; each
 * attempt of a retried request goes through it again.
 *
 * Rejects with an `AbortError` when `signal` aborts while the request is held.
 */
export async function afterRequestHolds<T>(signal: AbortSignal | undefined, send: () => T): Promise<Awaited<T>> {
	const scope = scopes.getStore();
	if (!scope) return await send();
	// Nearest scope per holds decides: a carried view, an exemption, or a view this send opens.
	const entries: Array<{ scope: Scope; view: RequestHoldView | undefined }> = [];
	const seen = new Set<RequestHolds>();
	for (let next: Scope | undefined = scope; next; next = next.parent) {
		if (seen.has(next.holds)) continue;
		seen.add(next.holds);
		if (!next.exempt) entries.push({ scope: next, view: undefined });
	}
	const opened: RequestHoldView[] = [];
	const releaseOpened = () => {
		const views = opened.splice(0);
		for (const view of views) view.release();
	};
	try {
		for (;;) {
			let held: Promise<void> | undefined;
			for (const entry of entries) {
				let view = entry.view;
				if (!view) {
					const carried = entry.scope.open ? entry.scope.view : undefined;
					view = carried ?? entry.scope.holds.open();
					if (!carried) opened.push(view);
					entry.view = view;
				}
				held = view.check();
				if (held) break;
			}
			if (!held) break;
			await untilAborted(signal, held);
		}
		const sent = send();
		// The request is on its way: it no longer waits on the views this send opened.
		releaseOpened();
		return await sent;
	} finally {
		releaseOpened();
	}
}
