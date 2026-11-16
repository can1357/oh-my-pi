import type { RenderScheduler, RenderTimer } from "@oh-my-pi/pi-tui/tui";

/** Bound on callbacks one `advance` may run; a timer that keeps re-arming is a bug, not a wait. */
const MAX_CALLBACKS = 10_000;

interface Pending {
	at: number;
	run: () => void;
}

/**
 * Synchronous {@link RenderScheduler} on a virtual clock, for a terminal
 * bound with `terminal.bind(host, scheduler)` or a `TUI` given it as its
 * `renderScheduler`: probe timeouts, render pacing, drain idles, and the stall
 * watchdog's polls run only when the test advances the clock.
 */
export class ManualScheduler implements RenderScheduler {
	#now = 0;
	#nextId = 0;
	readonly #pending = new Map<number, Pending>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#pending.set(this.#nextId++, { at: this.#now, run: callback });
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const id = this.#nextId++;
		this.#pending.set(id, { at: this.#now + Math.max(0, delayMs), run: callback });
		return {
			cancel: () => {
				this.#pending.delete(id);
			},
		};
	}

	/** Callbacks queued and not cancelled. */
	get pending(): number {
		return this.#pending.size;
	}

	/** Remove every queued callback and hand it back uncalled. */
	take(): Array<() => void> {
		const callbacks = [...this.#pending.values()].map(entry => entry.run);
		this.#pending.clear();
		return callbacks;
	}

	/**
	 * Move the clock forward by `ms`, running every callback that comes due on
	 * the way in deadline order (ties in scheduling order), including callbacks
	 * those schedule within the window. A callback that throws propagates; the
	 * clock stays at its deadline.
	 */
	advance(ms = 0): void {
		const end = this.#now + ms;
		for (let ran = 0; ran < MAX_CALLBACKS; ran++) {
			let nextId: number | undefined;
			let next: Pending | undefined;
			for (const [id, entry] of this.#pending) {
				if (entry.at <= end && (next === undefined || entry.at < next.at)) {
					nextId = id;
					next = entry;
				}
			}
			if (nextId === undefined || next === undefined) {
				this.#now = end;
				return;
			}
			this.#pending.delete(nextId);
			this.#now = Math.max(this.#now, next.at);
			next.run();
		}
		throw new Error(`ManualScheduler ran ${MAX_CALLBACKS} callbacks without settling`);
	}
}
