/** Time source for the input pipeline; injectable so decoder tests are deterministic. */
export interface Clock {
	now(): number;
	/** Run `fn` after `ms`; returns a canceller. */
	schedule(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
	now: () => performance.now(),
	schedule(ms, fn) {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
};
