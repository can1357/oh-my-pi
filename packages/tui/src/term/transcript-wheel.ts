/** Gap that ends a gesture on OS-accelerated input; Claude Code's native wheel window. */
const RAMP_GAP_MS = 40;
/** Line-count growth per event inside one OS-accelerated gesture. */
const RAMP_STEP = 0.3;
/** Most lines one wheel report moves under automatic speed. */
const MAX_LINES = 6;

/**
 * Converts fullscreen wheel reports into transcript rows.
 *
 * Notch-reporting terminals follow pi's velocity curve: one row per isolated notch, up to six per
 * report on a fast spin. Local macOS terminals already apply the OS acceleration but still report
 * one event per row, so a sustained gesture ramps like Claude Code's native window: each report
 * within 40 ms of the last adds 0.3 rows, up to six, and a pause or reversal starts again at one.
 */
export class TranscriptWheel {
	#last = -Infinity;
	#direction = 0;
	#average = 0;
	#fraction = 0;
	#ramp = 1;

	constructor(
		readonly accelerate = !(
			process.platform === "darwin" &&
			!Bun.env.SSH_CONNECTION &&
			!Bun.env.SSH_CLIENT &&
			!Bun.env.SSH_TTY
		),
	) {}

	reset(): void {
		this.#last = -Infinity;
		this.#average = this.#fraction = 0;
		this.#ramp = 1;
	}

	lines(direction: number, now: number, fixed: number): number {
		if (fixed > 0 && Number.isFinite(fixed)) {
			this.reset();
			return Math.max(1, Math.trunc(fixed));
		}
		const gap = now - this.#last;
		const sameGesture = direction === this.#direction && gap >= 0;
		this.#direction = direction;
		this.#last = now;
		if (!this.accelerate) {
			this.#ramp = sameGesture && gap <= RAMP_GAP_MS ? Math.min(MAX_LINES, this.#ramp + RAMP_STEP) : 1;
			return Math.floor(this.#ramp);
		}
		if (!sameGesture || gap > 200) {
			this.#average = this.#fraction = 0;
			return 1;
		}
		if (gap < 5) return 1;
		this.#average = this.#average ? (this.#average + gap) / 2 : gap;
		const total = Math.max(1, Math.min(MAX_LINES, 100 / this.#average)) + this.#fraction;
		const lines = Math.floor(total);
		this.#fraction = total - lines;
		return lines;
	}
}
