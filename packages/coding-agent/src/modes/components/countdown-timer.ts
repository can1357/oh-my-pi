/**
 * Reusable countdown timer for dialog components.
 */
import type { TUI } from "@oh-my-pi/pi-tui";

/** Largest delay a 32-bit signed timer accepts; longer values are clamped to 1ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export class CountdownTimer {
	#intervalId: NodeJS.Timeout | undefined;
	#expireTimeoutId: NodeJS.Timeout | undefined;
	#remainingSeconds: number;
	#deadlineMs = 0;
	readonly #initialMs: number;

	constructor(
		timeoutMs: number,
		private tui: TUI | undefined,
		private onTick: (seconds: number) => void,
		private onExpire: () => void,
	) {
		this.#initialMs = timeoutMs;
		this.#remainingSeconds = Math.ceil(timeoutMs / 1000);
		this.#start();
	}

	#calculateRemainingSeconds(now = Date.now()): number {
		const remainingMs = Math.max(0, this.#deadlineMs - now);
		return Math.ceil(remainingMs / 1000);
	}

	#start(): void {
		const now = Date.now();
		this.#deadlineMs = now + this.#initialMs;
		this.#remainingSeconds = this.#calculateRemainingSeconds(now);
		this.onTick(this.#remainingSeconds);
		this.tui?.requestRender();
		this.#scheduleExpiry();
		this.#startInterval();
	}

	/** Arm the expiry timer, re-arming across `MAX_TIMEOUT_MS` chunks when the
	 *  deadline is further out than a 32-bit timer can express. A raw
	 *  `setTimeout(ms)` above that limit is clamped to 1ms by the runtime, which
	 *  would fire a deliberately long window almost immediately. */
	#scheduleExpiry(): void {
		const remainingMs = Math.max(0, this.#deadlineMs - Date.now());
		if (remainingMs > MAX_TIMEOUT_MS) {
			this.#expireTimeoutId = setTimeout(() => this.#scheduleExpiry(), MAX_TIMEOUT_MS);
			return;
		}
		this.#expireTimeoutId = setTimeout(() => {
			this.dispose();
			this.onExpire();
		}, remainingMs);
	}

	#startInterval(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
		this.#intervalId = setInterval(() => {
			const remainingSeconds = this.#calculateRemainingSeconds();
			if (remainingSeconds !== this.#remainingSeconds) {
				this.#remainingSeconds = remainingSeconds;
				this.onTick(this.#remainingSeconds);
			}
			this.tui?.requestRender();
		}, 1000);
	}

	/** Reset the countdown to its initial value */
	reset(): void {
		this.dispose();
		this.#start();
	}

	dispose(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
		if (this.#expireTimeoutId) {
			clearTimeout(this.#expireTimeoutId);
			this.#expireTimeoutId = undefined;
		}
	}
}
