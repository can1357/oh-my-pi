/**
 * Watchdog for eval cell work.
 *
 * A cell's `timeout` bounds time while the Python kernel or JS VM is in control.
 * Host-side bridge calls can {@link pause} the watchdog so waits on
 * `agent()`/`completion()` handles are ignored completely, then {@link resume}
 * starts a fresh timeout window once the runtime gets control back.
 *
 * Pause is reference-counted because multiple handle waits can overlap.
 */
export class IdleTimeout {
	readonly #controller = new AbortController();
	readonly #idleMs: number;
	/** Absolute time (epoch ms) at which inactivity is considered to have expired. */
	#deadlineMs: number;
	#timer: NodeJS.Timeout | undefined;
	#settled = false;
	#pauseDepth = 0;

	constructor(idleMs: number) {
		this.#idleMs = Math.max(1, Math.floor(idleMs));
		this.#deadlineMs = Date.now() + this.#idleMs;
		this.#arm(this.#idleMs);
	}

	/** Aborts with a `TimeoutError` reason once the active timeout window is exhausted. */
	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Configured active timeout window in milliseconds. */
	get idleMs(): number {
		return this.#idleMs;
	}

	/** Suspend timeout accounting while control is delegated to host-side work. */
	pause(): void {
		if (this.#settled) return;
		this.#pauseDepth++;
		if (this.#pauseDepth !== 1) return;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	/** Resume timeout accounting with a fresh timeout window. */
	resume(): void {
		if (this.#settled || this.#pauseDepth === 0) return;
		this.#pauseDepth--;
		if (this.#pauseDepth > 0) return;
		this.#deadlineMs = Date.now() + this.#idleMs;
		this.#arm(this.#idleMs);
	}

	/** Stop the watchdog. Safe to call multiple times. */
	dispose(): void {
		if (this.#settled) return;
		this.#settled = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	#arm(delayMs: number): void {
		const timer = setTimeout(() => this.#onExpire(), Math.max(0, delayMs));
		// Never keep the event loop alive for the watchdog itself.
		timer.unref?.();
		this.#timer = timer;
	}

	#onExpire(): void {
		if (this.#settled || this.#pauseDepth > 0) return;
		const remainingMs = this.#deadlineMs - Date.now();
		if (remainingMs > 0) {
			// The deadline moved forward (resume re-arming) after this timer was
			// armed; wait out the remaining window instead of firing early.
			this.#arm(remainingMs);
			return;
		}
		this.#settled = true;
		this.#timer = undefined;
		this.#controller.abort(new DOMException(`Idle for ${Math.round(this.#idleMs / 1000)}s`, "TimeoutError"));
	}
}
