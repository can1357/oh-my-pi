import type { RenderScheduler, RenderTimer } from "@oh-my-pi/pi-tui/tui";
import type { VirtualTerminal } from "./virtual-terminal";

/**
 * Longest delay a throttled frame can ask for: the 30 Hz cadence. Adaptive
 * backpressure adds nothing under a virtual clock (a frame costs 0 virtual ms),
 * and every deferred window the engine arms is longer — multiplexer resize
 * debounce 50 ms, resize viewport settle 120 ms, ConPTY post-paint settle
 * 150 ms — so this horizon separates "frames the pipeline owes us now" from
 * "windows a test must open deliberately".
 */
const FRAME_HORIZON_MS = 40;

/** Bound on drain rounds; a render loop that keeps re-arming is a bug, not a wait. */
const MAX_ROUNDS = 500;

interface PendingTimer {
	at: number;
	run: () => void;
}

/**
 * Deterministic {@link RenderScheduler} with a virtual clock.
 *
 * `TUI` reads every timestamp through `RenderScheduler.now()`, so owning the
 * clock removes wall-clock races from render assertions: a loaded machine can
 * neither lose a throttled frame (sleep too short) nor open a deferred settle
 * window early (sleep too long).
 *
 * ```ts
 * const scheduler = new VirtualRenderScheduler();
 * const tui = new TUI(term, undefined, { renderScheduler: scheduler });
 * tui.start();
 * await scheduler.settle(term); // every frame the engine owes, nothing more
 * await scheduler.advance(term, 160); // open the resize settle window
 * ```
 */
export class VirtualRenderScheduler implements RenderScheduler {
	#now = 0;
	#nextTimerId = 0;
	#immediates: (() => void)[] = [];
	#timers = new Map<number, PendingTimer>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const id = this.#nextTimerId;
		this.#nextTimerId += 1;
		this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), run: callback });
		return {
			cancel: () => {
				this.#timers.delete(id);
			},
		};
	}

	/** Drop every queued frame and rewind the clock, for reuse across tests. */
	reset(): void {
		this.#now = 0;
		this.#immediates = [];
		this.#timers.clear();
	}

	/**
	 * Run the frames the engine owes — immediates plus timers landing within
	 * `horizonMs` of the clock, including the ones those frames schedule — until
	 * the pipeline is quiescent. Deferred windows stay armed.
	 */
	async settle(term: VirtualTerminal, horizonMs = FRAME_HORIZON_MS): Promise<void> {
		await this.#drain(term, () => this.#now + horizonMs);
	}

	/**
	 * Open a deferred window: advance the clock by `ms`, running every frame that
	 * comes due on the way, then settle the frames that follow it.
	 */
	async advance(term: VirtualTerminal, ms: number): Promise<void> {
		const deadline = this.#now + ms;
		await this.#drain(term, () => deadline);
		this.#now = Math.max(this.#now, deadline);
		await this.settle(term);
	}

	async #drain(term: VirtualTerminal, deadline: () => number): Promise<void> {
		for (let round = 0; round < MAX_ROUNDS; round++) {
			if (!this.#runImmediates() && !this.#runDue(deadline())) return;
			// Terminal writes land synchronously; yielding lets promise
			// continuations queue their renders before the next round.
			await term.flush();
		}
		throw new Error(`VirtualRenderScheduler did not settle after ${MAX_ROUNDS} rounds`);
	}

	#runImmediates(): boolean {
		if (this.#immediates.length === 0) return false;
		const queued = this.#immediates;
		this.#immediates = [];
		for (const run of queued) run();
		return true;
	}

	/** Fire the earliest timer batch due at or before `deadline`, advancing the clock to it. */
	#runDue(deadline: number): boolean {
		let earliest: number | undefined;
		for (const timer of this.#timers.values()) {
			if (timer.at <= deadline && (earliest === undefined || timer.at < earliest)) earliest = timer.at;
		}
		if (earliest === undefined) return false;
		this.#now = Math.max(this.#now, earliest);
		const due: number[] = [];
		for (const [id, timer] of this.#timers) {
			if (timer.at === earliest) due.push(id);
		}
		for (const id of due) {
			const timer = this.#timers.get(id);
			if (!timer) continue;
			this.#timers.delete(id);
			timer.run();
		}
		return true;
	}
}
