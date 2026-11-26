/**
 * The live thinking-speed gauge (tok/s) the streaming assistant block shows
 * beside its thinking indicator.
 *
 * Only one thinking indicator animates at a time, so one session-wide
 * {@link ThinkingSpeedTracker} averages instantaneous readings over a short
 * window, smoothing the jumpy per-delta numbers. Each streaming block measures
 * its own provider token deltas with a {@link ThinkingRateMeter}; its first live
 * sample resets the shared gauge, so a block never shows a previous turn's
 * trailing rate. Deltas (not cumulative totals) feed the gauge, so a turn
 * restarting its token count at zero never produces a spike.
 */

/** Rolling window (ms) over which readings are averaged. */
export const THINKING_SPEED_WINDOW_MS = 3000;
/** Ceiling (tok/s): one oversized delta (a buffered reflow tick) cannot poison the average. */
export const THINKING_SPEED_MAX = 200;

/** Windowed average of instantaneous tok/s readings. */
export class ThinkingSpeedTracker {
	#readings: { time: number; rate: number }[] = [];

	#prune(now: number): void {
		const threshold = now - THINKING_SPEED_WINDOW_MS;
		while (this.#readings.length > 0 && this.#readings[0]!.time < threshold) this.#readings.shift();
	}

	/** Record one reading, clamped to {@link THINKING_SPEED_MAX}; non-finite or negative rates are ignored. */
	observe(rate: number, now = performance.now()): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#readings.push({ time: now, rate: Math.min(rate, THINKING_SPEED_MAX) });
		this.#prune(now);
	}

	/** The windowed average; 0 once every reading aged out. */
	speed(now = performance.now()): number {
		this.#prune(now);
		if (this.#readings.length === 0) return 0;
		let sum = 0;
		for (const reading of this.#readings) sum += reading.rate;
		return sum / this.#readings.length;
	}

	reset(): void {
		this.#readings = [];
	}
}

/** The session's gauge. */
export const thinkingSpeed = new ThinkingSpeedTracker();

/**
 * One streaming block's rate: feed it the provider's cumulative token count
 * (reasoning tokens when reported, else output tokens) on every transient
 * update while thinking streams; it answers the rate the block shows.
 */
export class ThinkingRateMeter {
	readonly #tracker: ThinkingSpeedTracker;
	#lastTokens: number | undefined;
	#lastTime = 0;
	/** The block observed a positive token delta of its own. */
	#live = false;

	constructor(tracker: ThinkingSpeedTracker = thinkingSpeed) {
		this.#tracker = tracker;
	}

	/**
	 * A live thinking update carrying `tokens`. Answers the tok/s to show: 0 until
	 * this block streams tokens itself (a provider reporting usage only at turn end
	 * keeps it 0), and 0 again once the readings age out in a lull.
	 */
	sample(tokens: number, now = performance.now()): number {
		if (this.#lastTokens !== undefined) {
			const delta = tokens - this.#lastTokens;
			const elapsed = now - this.#lastTime;
			if (delta > 0 && elapsed > 0) {
				// First live sample of this block: the gauge forgets the previous block's readings.
				if (!this.#live) this.#tracker.reset();
				this.#tracker.observe((delta / elapsed) * 1000, now);
				this.#live = true;
			}
		}
		this.#lastTokens = tokens;
		this.#lastTime = now;
		return this.#live ? Math.min(THINKING_SPEED_MAX, this.#tracker.speed(now)) : 0;
	}

	/** Thinking stopped streaming (text, a tool call, or the final update): the next sample starts over. */
	stop(): void {
		this.#lastTokens = undefined;
		this.#live = false;
	}
}
