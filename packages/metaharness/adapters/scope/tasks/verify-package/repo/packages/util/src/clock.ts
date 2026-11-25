/** A source of the current time in epoch milliseconds. */
export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to; for tests. */
export class ManualClock implements Clock {
	#ms: number;

	constructor(startMs = 0) {
		this.#ms = startMs;
	}

	now(): number {
		return this.#ms;
	}

	advance(ms: number): void {
		this.#ms += ms;
	}
}
