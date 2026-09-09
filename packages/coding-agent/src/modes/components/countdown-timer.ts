/**
 * Reusable countdown timer for dialog components.
 */
import type { TUI } from "@oh-my-pi/pi-tui";

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

		this.#expireTimeoutId = setTimeout(() => {
			this.dispose();
			this.onExpire();
		}, this.#initialMs);

		this.#startInterval();
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
