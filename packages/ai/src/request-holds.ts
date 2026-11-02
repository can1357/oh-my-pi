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
	/** The request no longer waits on these holds. Called once per view, by whoever opened it. */
	release(): void;
}

/** A set of holds a host registers for every request started in a context. */
export interface RequestHolds {
	/**
	 * Opens one request's view of these holds. It may run host code: the gate
	 * opens every view a send needs before its last checks, never between them.
	 */
	open(): RequestHoldView;
}

/** How long something lasts: a request that carries views, or an exemption. */
interface Lifetime {
	open: boolean;
	/** Settles when it ends, waking a check still waiting on what it carried. */
	readonly ended: Promise<void>;
}

function startLifetime(): { lifetime: Lifetime; end(): void } {
	const ended = Promise.withResolvers<void>();
	const lifetime: Lifetime = { open: true, ended: ended.promise };
	return {
		lifetime,
		end() {
			lifetime.open = false;
			ended.resolve();
		},
	};
}

/** Ends `end` once `fn`'s result settles: when it returns, or when the promise it returns settles. */
function endWhenSettled<T>(fn: () => T, end: () => void): T {
	let result: T;
	try {
		result = fn();
	} catch (error) {
		end();
		throw error;
	}
	if (result instanceof Promise) {
		void result.then(end, end);
	} else {
		end();
	}
	return result;
}

interface Scope {
	readonly holds: RequestHolds;
	/** The view the request running in this scope carries, while every lifetime in `lifetimes` is open. */
	readonly view: RequestHoldView | undefined;
	/** The lifetimes the carried view serves within: its request's, and those of any outer request it was borrowed from. */
	readonly lifetimes: readonly Lifetime[];
	/** While open, the holds do not apply in this scope (see {@link runOutsideRequestHolds}). */
	readonly exemption: Lifetime | undefined;
	readonly parent: Scope | undefined;
}

const scopes = new AsyncLocalStorage<Scope>();

function live(lifetimes: readonly Lifetime[]): boolean {
	return lifetimes.every(lifetime => lifetime.open);
}

function firstEnd(lifetimes: readonly Lifetime[]): Promise<void> | undefined {
	return lifetimes.length === 0 ? undefined : Promise.race(lifetimes.map(lifetime => lifetime.ended));
}

/** Whether a scope of the chain names `holds`. An exemption does not: once it ends, its holds must still be named to apply. */
function inChain(scope: Scope | undefined, holds: RequestHolds): boolean {
	for (let next = scope; next; next = next.parent) if (next.holds === holds && !next.exemption) return true;
	return false;
}

/**
 * Runs `fn` so that every model request it starts, now or later in its async
 * flow, waits for `holds` at its send, in addition to the holds of the
 * context it was called in. Holds the context already has are left as they
 * are: a request in it keeps the view it carries.
 */
export function runWithRequestHolds<T>(holds: RequestHolds, fn: () => T): T {
	const parent = scopes.getStore();
	if (inChain(parent, holds)) return fn();
	return scopes.run({ holds, view: undefined, lifetimes: [], exemption: undefined, parent }, fn);
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
	const { lifetime, end } = startLifetime();
	const scope: Scope = { holds, view, lifetimes: [lifetime], exemption: undefined, parent: scopes.getStore() };
	try {
		return await scopes.run(scope, fn);
	} finally {
		end();
	}
}

/**
 * Runs `fn` so that `holds` does not hold the requests it starts until `fn`
 * settles: for work the holds themselves wait for, which would otherwise wait
 * for itself. While it lasts the exemption covers everything `fn` starts, a
 * later {@link runWithRequestHolds} or carried view of the same holds inside
 * it included; once `fn` settles, work it left behind (a timer, a child agent)
 * is held again. Other holds of the context still apply.
 */
export function runOutsideRequestHolds<T>(holds: RequestHolds, fn: () => T): T {
	const { lifetime, end } = startLifetime();
	const scope: Scope = { holds, view: undefined, lifetimes: [], exemption: lifetime, parent: scopes.getStore() };
	return scopes.run(scope, () => endWhenSettled(fn, end));
}

/**
 * Holds that stand for the holds of a context bound later: for work that
 * starts before the context that owns it exists (a session's start-up, run
 * before its agent is built). Until {@link bind} it holds nothing; from then
 * on, each check of the work's requests asks the bound context's holds, as if
 * the work had run in that context, and a holds both reach is asked once.
 */
export class RequestHoldsAlias implements RequestHolds {
	#target: RequestHoldContext | undefined;

	/** From now on, these holds stand for `context`'s. */
	bind(context: RequestHoldContext): void {
		this.#target = context;
	}

	/** The holds bound with {@link bind}, or none. */
	get target(): readonly RequestHolds[] {
		return this.#target?.holds ?? [];
	}

	/** A view of every bound holds. The gate expands an alias instead, so it never calls this. */
	open(): RequestHoldView {
		const views = this.target.map(holds => holds.open());
		return {
			check: () => {
				for (const view of views) {
					const held = view.check();
					if (held) return held;
				}
				return undefined;
			},
			release: () => {
				for (const view of views) view.release();
			},
		};
	}
}

/**
 * The holds that apply in `scope`, each with the nearest scope that names it
 * (whose carried view, if any, the request uses), aliases expanded to the
 * holds they are bound to. A holds any scope of the chain is exempt from, for
 * as long as that exemption lasts, does not apply however near a scope names it.
 */
function applicableScopes(scope: Scope | undefined): { applicable: Scope[]; exempt: RequestHolds[] } {
	const exempt = new Set<RequestHolds>();
	for (let next = scope; next; next = next.parent) if (next.exemption?.open) exempt.add(next.holds);
	const applicable: Scope[] = [];
	const seen = new Set<RequestHolds>(exempt);
	const add = (candidate: Scope) => {
		if (seen.has(candidate.holds)) return;
		seen.add(candidate.holds);
		if (!(candidate.holds instanceof RequestHoldsAlias)) {
			applicable.push(candidate);
			return;
		}
		for (const holds of candidate.holds.target) {
			add({ holds, view: undefined, lifetimes: [], exemption: undefined, parent: candidate.parent });
		}
	};
	for (let next = scope; next; next = next.parent) {
		// A scope only names holds while its exemption, if it has one, lasts.
		if (next.exemption) continue;
		add(next);
	}
	return { applicable, exempt: [...exempt] };
}

/** The holds of a context, taken with {@link captureRequestHolds}. */
export interface RequestHoldContext {
	/** The holds the context had, nearest first. A hold the context was exempt from is not listed. */
	readonly holds: readonly RequestHolds[];
	/**
	 * Runs `fn` with the captured holds and exemptions added to the context
	 * it is called in. An exemption still ends when the work it was made for
	 * settles. Views carried by a request at capture are not added: work run
	 * later opens views of its own.
	 */
	run<T>(fn: () => T): T;
}

/** A snapshot of the current context's holds, for work that leaves the async flow (a `Worker` message handler, a queue drained elsewhere). */
export function captureRequestHolds(): RequestHoldContext {
	const exemptions: Array<{ holds: RequestHolds; exemption: Lifetime }> = [];
	const holds: RequestHolds[] = [];
	const seen = new Set<RequestHolds>();
	for (let next = scopes.getStore(); next; next = next.parent) {
		if (next.exemption) {
			if (next.exemption.open) exemptions.push({ holds: next.holds, exemption: next.exemption });
			continue;
		}
		if (seen.has(next.holds)) continue;
		seen.add(next.holds);
		holds.push(next.holds);
	}
	const listed = holds.filter(entry => !exemptions.some(exempt => exempt.holds === entry));
	return {
		holds: listed,
		run<T>(fn: () => T): T {
			let run = fn;
			// Nearest first, so it is wrapped innermost and stays nearest.
			for (const entry of holds) {
				const inner = run;
				run = () => runWithRequestHolds(entry, inner);
			}
			for (const { holds: exemptHolds, exemption } of exemptions) {
				const inner = run;
				run = () =>
					scopes.run(
						{ holds: exemptHolds, view: undefined, lifetimes: [], exemption, parent: scopes.getStore() },
						inner,
					);
			}
			return run();
		},
	};
}

/** Whether the current context is exempt from `holds` (see {@link runOutsideRequestHolds}): requests started in it do not wait for them. */
export function exemptFromRequestHolds(holds: RequestHolds): boolean {
	return applicableScopes(scopes.getStore()).exempt.includes(holds);
}

/** One request's views of every hold of its context (see {@link openRequestHolds}). */
export interface RequestHoldViews extends RequestHoldView {
	/**
	 * Runs `fn` — the request, or a step of it — carrying these views: every
	 * check made inside it, a request it starts and the transport's send
	 * included, uses them rather than opening views of its own, so each hold's
	 * state (a deadline, say) is spent once per request. A view borrowed from
	 * an outer request serves only while that request lasts too. Once `fn`
	 * settles, work it left behind opens views of its own. The caller still
	 * releases.
	 */
	carry<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * One request's views of every hold of the current context, as one
 * {@link RequestHoldView}: each check asks every applicable holds — through
 * `own.view` for `own.holds`, else the view the request carries for it, else a
 * view opened here — and returns what to wait for, or `undefined` when none
 * holds. `own.holds` counts whether or not the context has it, unless the
 * context is exempt from it. Every view is opened before any is checked:
 * opening may run host code, checking only reports. `release` releases the
 * views opened here, not `own.view` or carried ones. For a request that
 * checks the holds at several points, with checks of its own mixed in (an
 * agent loop's process pause); a plain send uses {@link afterRequestHolds}.
 */
export function openRequestHolds(own?: { holds: RequestHolds; view: RequestHoldView }): RequestHoldViews {
	const current = scopes.getStore();
	const { applicable, exempt } = applicableScopes(current);
	if (own && !exempt.includes(own.holds) && !applicable.some(scope => scope.holds === own.holds)) {
		applicable.unshift({ holds: own.holds, view: undefined, lifetimes: [], exemption: undefined, parent: current });
	}
	const entries = applicable.map(scope => ({
		scope,
		view: undefined as RequestHoldView | undefined,
		/** The view is the one the scope carries, which serves only while the scope's lifetimes last. */
		carried: false,
	}));
	const opened: RequestHoldView[] = [];
	const openAll = () => {
		for (const entry of entries) {
			// A carried view serves only while its request is under way; once the
			// request ends, the check opens a view of its own.
			if (entry.carried && !live(entry.scope.lifetimes)) {
				entry.view = undefined;
				entry.carried = false;
			}
			if (entry.view) continue;
			if (own && entry.scope.holds === own.holds) {
				entry.view = own.view;
				continue;
			}
			const carried = entry.scope.view && live(entry.scope.lifetimes) ? entry.scope.view : undefined;
			const view = carried ?? entry.scope.holds.open();
			entry.carried = carried !== undefined;
			if (!carried) opened.push(view);
			entry.view = view;
		}
	};
	return {
		check() {
			openAll();
			for (const entry of entries) {
				const held = entry.view?.check();
				if (!held) continue;
				// A wait on a carried view also ends when its request does, so the
				// check runs again with a view of its own.
				const ended = entry.carried ? firstEnd(entry.scope.lifetimes) : undefined;
				return ended ? Promise.race([held, ended]) : held;
			}
			return undefined;
		},
		async carry<T>(fn: () => Promise<T>): Promise<T> {
			openAll();
			const { lifetime, end } = startLifetime();
			let run = fn;
			for (const entry of entries) {
				const view = entry.view;
				if (!view) continue;
				// A view borrowed from an outer request lasts no longer than that request.
				const lifetimes = entry.carried ? [...entry.scope.lifetimes, lifetime] : [lifetime];
				const inner = run;
				run = () =>
					scopes.run(
						{ holds: entry.scope.holds, view, lifetimes, exemption: undefined, parent: scopes.getStore() },
						inner,
					);
			}
			try {
				return await run();
			} finally {
				end();
			}
		},
		release() {
			const views = opened.splice(0);
			for (const view of views) view.release();
		},
	};
}

/**
 * Sends one model request — `send` starts its network I/O — once no hold of
 * the current context holds it. The last check and the call to `send` run in
 * the same turn, with nothing awaited and no host code run between them, so a
 * hold registered at any point before `send` is called holds the request.
 * What runs inside `send` is the send itself: a hold registered by code that
 * runs during it — the transport's I/O call and whatever the runtime calls
 * back synchronously within it (a log sink, a diagnostics-channel subscriber)
 * — comes after the request started, and holds the next request, not this
 * one. Every transport calls its I/O through this after `onPayload` and every
 * other preparation step; each attempt of a retried request goes through it
 * again.
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
