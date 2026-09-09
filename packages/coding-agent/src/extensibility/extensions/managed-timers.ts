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

	constructor(private readonly onError: ManagedTimerErrorHandler) {}

	/** Schedule a repeating callback whose throws are contained. */
	setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer {
		const timer = setInterval(() => this.#run("interval", callback, args), ms, ...args);
		timer.unref?.();
		this.#timers.add(timer);
		return timer;
	}

	/** Schedule a one-shot callback whose throws are contained. Deregisters after it fires. */
	setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer {
		const timer = setTimeout(
			() => {
				this.#timers.delete(timer);
				this.#run("timeout", callback, args);
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

	#run(kind: "interval" | "timeout", callback: (...args: unknown[]) => void, args: unknown[]): void {
		try {
			const result = callback(...args) as unknown;
			if (result instanceof Promise) {
				result.catch((err: unknown) => this.#report(kind, err));
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
