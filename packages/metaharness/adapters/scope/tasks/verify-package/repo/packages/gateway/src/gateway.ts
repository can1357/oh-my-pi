/** Token bucket for outbound calls: `capacity` tokens, one refilled every `refillMs`. */
export class RateLimiter {
	#tokens: number;
	#capacity: number;
	#refillMs: number;
	#last = Date.now();

	constructor(capacity: number, refillMs: number) {
		this.#tokens = capacity;
		this.#capacity = capacity;
		this.#refillMs = refillMs;
	}

	#refill(): void {
		const earned = Math.floor((Date.now() - this.#last) / this.#refillMs);
		if (earned === 0) return;
		this.#tokens = Math.min(this.#capacity, this.#tokens + earned);
		this.#last += earned * this.#refillMs;
	}

	/** Resolves once a token is available, taking it. */
	async acquire(): Promise<void> {
		for (;;) {
			this.#refill();
			if (this.#tokens > 0) {
				this.#tokens--;
				return;
			}
			await Bun.sleep(this.#refillMs);
		}
	}
}
