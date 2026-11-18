/**
 * Reclaims the extension's `chrome.debugger` attachments after the relay goes away.
 *
 * The extension owns every attachment it makes: a dead relay cannot send `detach`, and the
 * attachment (with Chrome's "started debugging this browser" infobar) then stays on the user's
 * tabs for the life of the service worker. A service-worker restart, however, must not detach
 * tabs a live relay still drives — the relay reconciles them from the next hello's
 * `attachedTabIds` and re-attaches every tab a downstream session holds. So the sweep waits out
 * a short grace period that a reconnect cancels, and runs at once when the worker is torn down.
 */

/** Injected timers, so the guard is testable without a browser. */
export interface OrphanSweepTimers {
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: OrphanSweepTimers = {
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: handle => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** How long the relay may stay away before its attachments are reclaimed. */
export const ORPHAN_SWEEP_GRACE_MS = 15_000;

export class OrphanSweep {
	readonly #sweep: () => Promise<void>;
	readonly #timers: OrphanSweepTimers;
	readonly #graceMs: number;
	#timer: unknown = null;
	/** Bumped on every reconnect and suspend, so a timer armed before one cannot fire after it. */
	#generation = 0;

	constructor(sweep: () => Promise<void>, graceMs = ORPHAN_SWEEP_GRACE_MS, timers = DEFAULT_TIMERS) {
		this.#sweep = sweep;
		this.#graceMs = graceMs;
		this.#timers = timers;
	}

	/** The relay connected: cancel any pending reclaim. */
	connected(): void {
		this.#generation++;
		this.#clear();
	}

	/** The relay disconnected: reclaim its attachments if it does not come back in time. */
	disconnected(): void {
		if (this.#timer !== null) return;
		const generation = this.#generation;
		this.#timer = this.#timers.setTimeout(() => {
			this.#timer = null;
			if (generation !== this.#generation) return;
			void this.#sweep();
		}, this.#graceMs);
	}

	/** The worker is being torn down: the relay cannot come back first, so reclaim now. */
	async suspend(): Promise<void> {
		this.#generation++;
		this.#clear();
		await this.#sweep();
	}

	#clear(): void {
		if (this.#timer === null) return;
		this.#timers.clearTimeout(this.#timer);
		this.#timer = null;
	}
}
