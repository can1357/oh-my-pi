/**
 * Managed timers for extensions.
 *
 * Extensions scheduling their own background work through raw `setInterval` /
 * `setTimeout` used to be able to take down the whole session: a throw inside
 * the callback runs on a fresh stack outside the handler-dispatch try/catch,
 * surfaces as a process-level `uncaughtException`, and the global postmortem
 * handler treats that as fatal (issue #5664).
 *
 * {@link ManagedTimers} backs the sanctioned `ctx.setInterval` /
 * `ctx.setTimeout` helpers. Each callback runs inside the same isolation the
 * runner already applies to handler dispatch — a synchronous throw or a
 * rejected promise is reported through `onError` and swallowed — and every
 * outstanding handle is `unref`'d (never keeps the process alive) and cleared
 * on session teardown via {@link clearAll}.
 */
import { logger } from "@oh-my-pi/pi-utils";

/** Callback invoked when a managed timer's callback throws or rejects. */
export type ManagedTimerErrorHandler = (event: string, error: string, stack?: string) => void;

export class ManagedTimers {
	readonly #timers = new Set<Timer>();

	/** @param onError reports a throw or rejection from a managed callback.
	 *  @param own wraps the callback with whoever owns extension-callback lifetimes: it refuses
	 *  once that owner has retired, and counts the call while it runs.
	 *  Clearing a handle stops future firings; it says nothing about a callback already running,
	 *  and `clearAll()` on teardown is exactly the moment one is most likely to be mid-flight. */
	constructor(
		private readonly onError: ManagedTimerErrorHandler,
		private readonly own: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R | undefined = fn => fn,
	) {}

	/** Schedule a repeating callback whose throws are contained. It is owned when it is scheduled,
	 *  so it belongs to the session whose code scheduled it, whichever the runtime serves when it
	 *  fires. */
	setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer {
		const owned = this.own(callback);
		const timer = setInterval(() => this.#run("interval", owned, args), ms, ...args);
		timer.unref?.();
		this.#timers.add(timer);
		return timer;
	}

	/** Schedule a one-shot callback whose throws are contained. Deregisters after it fires. Owned
	 *  when it is scheduled, as {@link setInterval}'s is. */
	setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer {
		const owned = this.own(callback);
		const timer = setTimeout(
			() => {
				this.#timers.delete(timer);
				this.#run("timeout", owned, args);
			},
			ms,
			...args,
		);
		timer.unref?.();
		this.#timers.add(timer);
		return timer;
	}

	/** Clear one managed timer. Accepts an interval or timeout handle. */
	clear(timer: Timer): void {
		if (!this.#timers.delete(timer)) return;
		clearInterval(timer);
		clearTimeout(timer);
	}

	/** Clear every outstanding managed timer. Called on session teardown. */
	clearAll(): void {
		for (const timer of this.#timers) {
			clearInterval(timer);
			clearTimeout(timer);
		}
		this.#timers.clear();
	}

	#run(kind: "interval" | "timeout", owned: (...args: unknown[]) => unknown, args: unknown[]): void {
		try {
			// The CALLBACK is owned, not its result: clearing a handle stops future firings, and a
			// result can only be reported after the call already happened. A retired session's
			// timer must not run at all — including one a suspended callback scheduled after
			// teardown — so the owner refuses it here.
			const result: unknown = owned(...args);
			// Thenable duck-typing, not `instanceof`: a callback from another realm or a hand-rolled
			// thenable rejects just as loudly, and an unreported rejection here is the
			// uncaughtException this class exists to prevent.
			if (result !== null && (typeof result === "object" || typeof result === "function")) {
				const then = (result as { then?: unknown }).then;
				if (typeof then === "function") {
					Promise.resolve(result as PromiseLike<unknown>).catch((err: unknown) => this.#report(kind, err));
				}
			}
		} catch (err) {
			this.#report(kind, err);
		}
	}

	#report(kind: "interval" | "timeout", err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? err.stack : undefined;
		logger.warn("Extension timer callback threw", { event: `${kind}_callback`, error: message });
		this.onError(`${kind}_callback`, message, stack);
	}
}
