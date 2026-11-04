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
import { isPromise } from "node:util/types";
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

/** How long a request that carries views lasts. */
interface Lifetime {
	readonly open: boolean;
	/**
	 * Calls `listener` once when it ends, waking a check still waiting on what
	 * it carried; the returned function removes it first. A listener, not a
	 * promise: a wait that is over leaves nothing behind on a lifetime that
	 * outlasts it.
	 */
	onEnd(listener: () => void): () => void;
}

function startLifetime(): { lifetime: Lifetime; end(): void } {
	const listeners = new Set<() => void>();
	let open = true;
	const lifetime: Lifetime = {
		get open() {
			return open;
		},
		onEnd(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		lifetime,
		end() {
			if (!open) return;
			open = false;
			const ending = [...listeners];
			listeners.clear();
			for (const listener of ending) listener();
		},
	};
}

/** While an exemption lasts (see {@link runOutsideRequestHolds}). */
interface Exemption {
	/** Read at every check, so it is exact in whatever turn the check runs. */
	readonly open: boolean;
}

/** `Promise.prototype.then` as the runtime defines it: a real promise whose `then` is this follows its own settlement. */
const nativeThen = Promise.prototype.then;

function noop(): void {}

/**
 * Runs `fn` in the exemption's scope, which `scope` enters, and makes the
 * exemption last until `fn`'s result settles, as `await` would see it
 * settle. The end is not a reaction to the result, which would run after
 * any awaiter registered before it: the exemption asks the runtime, at each
 * check, whether the promise it follows is still pending, so work that
 * resumes once that promise settled is held again however its reaction was
 * ordered.
 *
 * What is followed is what `await` follows. A real promise (of any realm)
 * whose `constructor` is this realm's `Promise` is followed itself: its
 * `constructor` is read once and its `then` never. Anything else has its
 * `then` read once; a real promise whose `then` is the runtime's own (a
 * subclass that keeps it) is followed itself too. Any other `then` — a
 * subclass's own, another realm's, a library's, a callable thenable's, a
 * proxy's — is called once with a native promise's resolve and reject, as
 * `await` calls it, and that promise is followed, adopting pending work it is
 * resolved with. Such a `then` tells its own callers of the settlement in
 * its own order: one that tells a caller registered before the gate first
 * runs that caller's continuation while the exemption still lasts. A result
 * that is not thenable, a `constructor` or `then` that cannot be read, and a
 * throw end it at once; a `then` that throws ends it as a rejection would.
 */
function runExempt<T>(scope: (fn: () => T, exemption: Exemption) => T, fn: () => T): T {
	let follows: Promise<unknown> | undefined;
	let open = true;
	const exemption: Exemption = {
		get open() {
			return open && (follows === undefined || Bun.peek.status(follows) === "pending");
		},
	};
	return scope(() => {
		let result: T;
		try {
			result = fn();
		} catch (error) {
			open = false;
			throw error;
		}
		const real = isPromise(result);
		try {
			if (real && (result as Promise<unknown>).constructor === Promise) {
				follows = result as Promise<unknown>;
				return result;
			}
		} catch {
			// Its `constructor` cannot be read: `await` would reject, so the work counts as settled.
			open = false;
			return result;
		}
		let then: unknown;
		try {
			if (result !== null && (typeof result === "object" || typeof result === "function")) {
				then = (result as { then?: unknown }).then;
			}
		} catch {
			// The thenable cannot be read: the work counts as settled.
		}
		if (typeof then !== "function") {
			open = false;
			return result;
		}
		if (real && then === nativeThen) {
			follows = result as Promise<unknown>;
			return result;
		}
		const followed = then;
		const adopted = new Promise<unknown>((resolve, reject) => {
			followed.call(result, resolve, reject);
		});
		// The exemption only asks whether it settled; a rejection is the work's to report.
		adopted.catch(noop);
		follows = adopted;
		return result;
	}, exemption);
}

interface Scope {
	readonly holds: RequestHolds;
	/** The view the request running in this scope carries, while every lifetime in `lifetimes` is open. */
	readonly view: RequestHoldView | undefined;
	/** The lifetimes the carried view serves within: its request's, and those of any outer request it was borrowed from. */
	readonly lifetimes: readonly Lifetime[];
	/** While open, the holds do not apply in this scope (see {@link runOutsideRequestHolds}). */
	readonly exemption: Exemption | undefined;
	readonly parent: Scope | undefined;
}

const scopes = new AsyncLocalStorage<Scope>();

function live(lifetimes: readonly Lifetime[]): boolean {
	return lifetimes.every(lifetime => lifetime.open);
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
	const parent = scopes.getStore();
	return runExempt(
		(exempt, exemption) => scopes.run({ holds, view: undefined, lifetimes: [], exemption, parent }, exempt),
		fn,
	);
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
	readonly #listeners = new Set<() => void>();

	/** From now on, these holds stand for `context`'s. A send waiting on the holds this alias stood for asks again. */
	bind(context: RequestHoldContext): void {
		this.#target = context;
		const listeners = [...this.#listeners];
		this.#listeners.clear();
		for (const listener of listeners) listener();
	}

	/** Calls `listener` at the next {@link bind}; the returned function removes it first. */
	onRebind(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The holds bound with {@link bind}, or none. */
	get target(): readonly RequestHolds[] {
		return this.#target?.holds ?? [];
	}

	/** A view of every bound holds, an alias bound into itself asked once. The gate expands an alias instead, so it never calls this. */
	open(): RequestHoldView {
		const views: RequestHoldView[] = [];
		const seen = new Set<RequestHolds>([this]);
		const visit = (holds: readonly RequestHolds[]) => {
			for (const next of holds) {
				if (seen.has(next)) continue;
				seen.add(next);
				if (next instanceof RequestHoldsAlias) visit(next.target);
				else views.push(next.open());
			}
		};
		visit(this.target);
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
 * The holds that apply in `scope`, nearest first, aliases expanded to the
 * holds they are bound to, each with the scope whose view the request uses:
 * the nearest one carrying a live view, else the nearest that names it. A
 * holds any scope of the chain is exempt from, for as long as that exemption
 * lasts, does not apply however near a scope names it. Asked afresh at every
 * check: an exemption ends, an alias is bound, a carried view's request ends.
 * `aliases` are the aliases expanded, whose rebinding changes the answer.
 */
function applicableScopes(scope: Scope | undefined): {
	applicable: Scope[];
	exempt: RequestHolds[];
	aliases: RequestHoldsAlias[];
} {
	const exempt = new Set<RequestHolds>();
	for (let next = scope; next; next = next.parent) if (next.exemption?.open) exempt.add(next.holds);
	const chosen = new Map<RequestHolds, Scope>();
	const expanded = new Set<RequestHoldsAlias>();
	const carries = (candidate: Scope) => candidate.view !== undefined && live(candidate.lifetimes);
	const add = (candidate: Scope) => {
		if (exempt.has(candidate.holds)) return;
		if (candidate.holds instanceof RequestHoldsAlias) {
			if (expanded.has(candidate.holds)) return;
			expanded.add(candidate.holds);
			for (const holds of candidate.holds.target) {
				add({ holds, view: undefined, lifetimes: [], exemption: undefined, parent: candidate.parent });
			}
			return;
		}
		const current = chosen.get(candidate.holds);
		if (!current) chosen.set(candidate.holds, candidate);
		else if (!carries(current) && carries(candidate)) chosen.set(candidate.holds, candidate);
	};
	for (let next = scope; next; next = next.parent) {
		// A scope only names holds while its exemption, if it has one, lasts.
		if (next.exemption) continue;
		add(next);
	}
	return { applicable: [...chosen.values()], exempt: [...exempt], aliases: [...expanded] };
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
	const exemptions: Array<{ holds: RequestHolds; exemption: Exemption }> = [];
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

/** One holds of a request's context, and the view the request asks it through (see {@link openRequestHolds}). */
interface HoldEntry {
	scope: Scope;
	view: RequestHoldView | undefined;
	/** The view is the one `scope` carries, which serves only while the scope's lifetimes last. */
	carried: boolean;
}

/**
 * One request's views of every hold of the current context, as one
 * {@link RequestHoldView}: each check asks every applicable holds — through
 * `own.view` for `own.holds`, else the view the request carries for it, else a
 * view opened here — and returns what to wait for, or `undefined` when none
 * holds. `own.holds` counts whether or not the context has it, unless the
 * context is exempt from it. Which holds apply is asked again at each check
 * (an exemption ends, an alias is bound, a carried view's request ends); a
 * holds keeps the view it was given, so its state is spent once. Every view
 * is opened before any is checked: opening may run host code, checking only
 * reports. `release` releases the views opened here, not `own.view` or carried
 * ones. For a request that checks the holds at several points, with checks of
 * its own mixed in (an agent loop's process pause); a plain send uses
 * {@link afterRequestHolds}.
 */
export function openRequestHolds(own?: { holds: RequestHolds; view: RequestHoldView }): RequestHoldViews {
	const current = scopes.getStore();
	const entries = new Map<RequestHolds, HoldEntry>();
	const opened: RequestHoldView[] = [];
	const carriedBy = (scope: Scope) => (scope.view && live(scope.lifetimes) ? scope.view : undefined);
	/** The aliases the last refresh expanded: a rebinding of any of them changes which holds apply. */
	let aliases: RequestHoldsAlias[] = [];
	/**
	 * The entries that apply now, each with its view, every view opened before
	 * any is checked. Opening runs host code, which can change which holds apply
	 * (bind an alias, say), so it asks again after opening until the answer
	 * stops changing. Each pass opens at least one new view, so it ends once
	 * opening stops bringing in holds not yet opened; a host whose `open()` adds a
	 * fresh holds every time would keep it opening, and is a host bug.
	 */
	const refresh = (): HoldEntry[] => {
		for (;;) {
			const resolved = applicableScopes(current);
			const { applicable, exempt } = resolved;
			aliases = resolved.aliases;
			if (own && !exempt.includes(own.holds) && !applicable.some(scope => scope.holds === own.holds)) {
				applicable.unshift({
					holds: own.holds,
					view: undefined,
					lifetimes: [],
					exemption: undefined,
					parent: current,
				});
			}
			const active: HoldEntry[] = [];
			for (const scope of applicable) {
				let entry = entries.get(scope.holds);
				if (!entry) {
					entry = { scope, view: undefined, carried: false };
					entries.set(scope.holds, entry);
				}
				entry.scope = scope;
				active.push(entry);
			}
			let openedNow = false;
			for (const entry of active) {
				if (own && entry.scope.holds === own.holds) {
					entry.view = own.view;
					continue;
				}
				const carried = carriedBy(entry.scope);
				if (carried) {
					// The request's own view of these holds serves while its request lasts.
					entry.view = carried;
					entry.carried = true;
					continue;
				}
				// A carried view whose request ended no longer serves; a view of its own does.
				if (entry.carried) {
					entry.view = undefined;
					entry.carried = false;
				}
				if (entry.view) continue;
				const view = entry.scope.holds.open();
				opened.push(view);
				entry.view = view;
				openedNow = true;
			}
			if (!openedNow) return active;
		}
	};
	/**
	 * The wait the last check returned, until it ends or the next check or
	 * `release` supersedes it. Only it is woken: a wait that is over hears
	 * nothing more, from its hold, an alias or a lifetime.
	 */
	let currentWait: { held: Promise<void>; wake(): void; fail(error: unknown): void; stop(): void } | undefined;
	/**
	 * The holds' promises this request reacts to, one reaction each however
	 * many waits return them; each forwards to the current wait only if that
	 * wait is waiting on it. Held weakly: a promise no wait is on any more,
	 * which its hold dropped, is not kept alive by this request.
	 */
	const watchedHelds = new WeakSet<Promise<void>>();
	const watchHeld = (held: Promise<void>) => {
		if (watchedHelds.has(held)) return;
		watchedHelds.add(held);
		held.then(
			() => {
				watchedHelds.delete(held);
				if (currentWait?.held === held) currentWait.wake();
			},
			error => {
				watchedHelds.delete(held);
				// A hold that fails fails the wait on it, as an `await` of it would.
				if (currentWait?.held === held) currentWait.fail(error);
			},
		);
	};
	return {
		check() {
			// A check supersedes the wait the previous one returned, whether that wait
			// ended, was abandoned or aborted: its listeners go now.
			currentWait?.stop();
			for (const entry of refresh()) {
				const held = entry.view?.check();
				if (!held) continue;
				// The wait also ends when its answer may change: a carried view's
				// request ends, or an alias is rebound. The check then runs again.
				const lifetimes = entry.carried ? entry.scope.lifetimes : [];
				if (aliases.length === 0 && lifetimes.length === 0) return held;
				// A lifetime that ended while the views were asked: ask again.
				if (!live(lifetimes)) return Promise.resolve();
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				const removals: Array<() => void> = [];
				const wait = {
					held,
					wake() {
						wait.stop();
						resolve();
					},
					fail(error: unknown) {
						wait.stop();
						reject(error);
					},
					stop() {
						if (currentWait !== wait) return;
						currentWait = undefined;
						for (const remove of removals.splice(0)) remove();
					},
				};
				currentWait = wait;
				for (const alias of aliases) removals.push(alias.onRebind(wait.wake));
				for (const lifetime of lifetimes) removals.push(lifetime.onEnd(wait.wake));
				watchHeld(held);
				return promise;
			}
			return undefined;
		},
		async carry<T>(fn: () => Promise<T>): Promise<T> {
			const active = refresh();
			const { lifetime, end } = startLifetime();
			let run = fn;
			for (const entry of active) {
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
			currentWait?.stop();
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
	if (!scopes.getStore()) {
		signal?.throwIfAborted();
		return await send();
	}
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
