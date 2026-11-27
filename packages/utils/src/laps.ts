/**
 * Wall-clock laps of a multi-step async path, reported as one structured log record: each
 * {@link Laps.lap} charges the time since the previous lap (or the start) to its phase. Use it
 * where a path's total wait is user-visible and the slow step must show in the log.
 *
 * @example
 * const laps = new Laps();
 * await settleHooks();
 * laps.lap("hooksMs");
 * await prepareRequest();
 * laps.lap("prepareMs");
 * logger.debug("Request prepared", laps.record()); // { hooksMs, prepareMs, totalMs }
 */
export class Laps {
	readonly #start = performance.now();
	#last = this.#start;
	readonly #phases: Record<string, number> = {};

	/** Charges the time since the previous lap to `phase`, added to any time it already holds. */
	lap(phase: string): void {
		const now = performance.now();
		this.#phases[phase] = (this.#phases[phase] ?? 0) + Math.round(now - this.#last);
		this.#last = now;
	}

	/** Each phase's milliseconds, plus `totalMs` since the start. */
	record(): Record<string, number> {
		return { ...this.#phases, totalMs: Math.round(performance.now() - this.#start) };
	}
}
