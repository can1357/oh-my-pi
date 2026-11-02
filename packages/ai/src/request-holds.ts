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
	const parent = scopes.getStore();
	// Entering holds the context already has adds nothing, and must not shadow
	// the view a request in it carries (or an exemption).
	if (!exempt && !view && inChain(parent, holds)) return fn();
	return scopes.run({ holds, view, exempt, open: true, parent }, fn);
}

function inChain(scope: Scope | undefined, holds: RequestHolds): boolean {
	for (let next = scope; next; next = next.parent) if (next.holds === holds) return true;
	return false;
}

/**
 * Runs `fn` so that every model request it starts, now or later in its async
 * flow, waits for `holds` at its send, in addition to the holds of the
 * context it was called in. Holds the context already has are left as they
 * are: a request in it keeps the view it carries.
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
 * the holds themselves wait for, which would otherwise wait for itself. The
 * exemption covers everything `fn` starts, a later {@link runWithRequestHolds}
 * or carried view of the same holds inside it included; other holds of the
 * context still apply.
 */
export function runOutsideRequestHolds<T>(holds: RequestHolds, fn: () => T): T {
	return enter(holds, undefined, true, fn);
}

/**
 * The holds that apply in `scope`, each with the nearest scope that names it
 * (whose carried view, if any, the request uses). A holds any scope of the
 * chain is exempt from does not apply, however near a scope that names it.
 */
function applicableScopes(scope: Scope | undefined): { applicable: Scope[]; exempt: RequestHolds[] } {
	const exempt = new Set<RequestHolds>();
	for (let next = scope; next; next = next.parent) if (next.exempt) exempt.add(next.holds);
	const applicable: Scope[] = [];
	const seen = new Set<RequestHolds>(exempt);
	for (let next = scope; next; next = next.parent) {
		if (seen.has(next.holds)) continue;
		seen.add(next.holds);
		applicable.push(next);
	}
	return { applicable, exempt: [...exempt] };
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
	const { applicable, exempt } = applicableScopes(scopes.getStore());
	const holds = applicable.map(scope => scope.holds);
	return {
		holds,
		run<T>(fn: () => T): T {
			let run = fn;
			for (const entry of holds) {
				const inner = run;
				run = () => enter(entry, undefined, false, inner);
			}
			for (const entry of exempt) {
				const inner = run;
				run = () => enter(entry, undefined, true, inner);
			}
			return run();
		},
	};
}

/**
 * One request's view of every hold of the current context, as one
 * {@link RequestHoldView}: each check asks every applicable holds — through
 * the view the request carries for it, else a view this one opens at its
 * first check — and returns what to wait for, or `undefined` when none holds.
 * `release` releases the views it opened. For a caller that combines the
 * context's holds with checks of its own in one last synchronous check before
 * its effect (an agent loop's process pause); a plain send uses
 * {@link afterRequestHolds}.
 */
export function openRequestHolds(): RequestHoldView {
	const entries = applicableScopes(scopes.getStore()).applicable.map(scope => ({
		scope,
		view: undefined as RequestHoldView | undefined,
		carried: false,
	}));
	const opened: RequestHoldView[] = [];
	return {
		check() {
			for (const entry of entries) {
				// A carried view serves only while its request is under way; once the
				// request ends, a check still waiting opens a view of its own.
				if (entry.carried && !entry.scope.open) {
					entry.view = undefined;
					entry.carried = false;
				}
				let view = entry.view;
				if (!view) {
					const carried = entry.scope.open ? entry.scope.view : undefined;
					view = carried ?? entry.scope.holds.open();
					entry.carried = carried !== undefined;
					if (!carried) opened.push(view);
					entry.view = view;
				}
				const held = view.check();
				if (held) return held;
			}
			return undefined;
		},
		release() {
			const views = opened.splice(0);
			for (const view of views) view.release();
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
 * Rejects with an `AbortError` when `signal` aborts while the request is held,
 * and sends nothing once `signal` has aborted, however late before the send.
 */
export async function afterRequestHolds<T>(signal: AbortSignal | undefined, send: () => T): Promise<Awaited<T>> {
	if (!scopes.getStore()) return await send();
	const holds = openRequestHolds();
	try {
		for (let held = holds.check(); held; held = holds.check()) await untilAborted(signal, held);
		// An abort that landed between the wait's end and this turn stops the send too.
		signal?.throwIfAborted();
		const sent = send();
		// The request is on its way: it no longer waits on the views this send opened.
		holds.release();
		return await sent;
	} finally {
		holds.release();
	}
}
