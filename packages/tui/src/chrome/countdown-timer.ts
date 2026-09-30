/**
 * Reusable countdown timer for dialog components.
 */
import { node } from "../native/describe";
import type { NativeNode } from "../native/node";
import { isNativeRendering } from "../native/state";
import type { TUI } from "../tui";
export class CountdownTimer {
	#intervalId: NodeJS.Timeout | undefined;
	#expireTimeoutId: NodeJS.Timeout | undefined;
	#remainingSeconds: number;
	#deadlineMs = 0;
	#node: NativeNode | undefined;
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
		this.#node = undefined;
		this.#remainingSeconds = this.#calculateRemainingSeconds(now);
		this.onTick(this.#remainingSeconds);
		this.tui?.requestRender();

		this.#expireTimeoutId = setTimeout(() => {
			this.dispose();
			this.onExpire();
		}, this.#initialMs);

		// The per-second tick only repaints the remaining time; a TSP terminal
		// counts down the described `elapsed` node itself.
		if (!isNativeRendering()) this.#startInterval();
	}

	/**
	 * The remaining time as a terminal-clocked `elapsed` node: its age is the
	 * negative remaining time (the start lies in the future), so it counts up
	 * toward zero and freezes there at expiry. The age is taken on the first
	 * call after a (re)start, when the node is first written, and the node is
	 * reused until {@link reset}.
	 */
	describe(): NativeNode {
		this.#node ??= node("elapsed", {
			age: Math.min(0, Date.now() - this.#deadlineMs),
			stopped: 0,
			format: "short",
		});
		return this.#node;
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
