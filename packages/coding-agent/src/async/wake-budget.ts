import { PROGRESS_LIMITS } from "./progress-limits";

const PERMIT_EPSILON = 1e-9;

/**
 * Session-wide token bucket for model turns started by wake-mode progress.
 * Per-source rate limits bound each producer, but ten chatty producers would
 * still wake the model ten times as often; this bucket caps the total number
 * of idle wake-ups a session may start, regardless of how many jobs or
 * monitors feed it. Refill is continuous, so a burst spent in one go is
 * regained one permit per `refillMs`.
 */
export class WakeTurnBudget {
	readonly #burst: number;
	readonly #refillMs: number;
	#tokens: number;
	#lastRefillAt: number | undefined;

	constructor(
		burst: number = PROGRESS_LIMITS.WAKE_TURN_BURST,
		refillMs: number = PROGRESS_LIMITS.WAKE_TURN_REFILL_MS,
	) {
		this.#burst = Math.max(1, burst);
		this.#refillMs = Math.max(1, refillMs);
		this.#tokens = this.#burst;
	}

	/**
	 * Consume one permit when available and return `0`; otherwise leave the
	 * bucket untouched and return the milliseconds until the next permit.
	 */
	tryAcquire(now = Date.now()): number {
		this.#refill(now);
		if (this.#tokens >= 1 - PERMIT_EPSILON) {
			this.#tokens = Math.max(0, this.#tokens - 1);
			return 0;
		}
		return Math.max(1, Math.ceil((1 - this.#tokens) * this.#refillMs));
	}

	#refill(now: number): void {
		if (this.#lastRefillAt === undefined) {
			this.#lastRefillAt = now;
			return;
		}
		const elapsedMs = Math.max(0, now - this.#lastRefillAt);
		this.#lastRefillAt = now;
		this.#tokens = Math.min(this.#burst, this.#tokens + elapsedMs / this.#refillMs);
	}
}
