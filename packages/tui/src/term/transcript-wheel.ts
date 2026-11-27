/** pi's wheel velocity curve: terminals report notches, except high-resolution bursts and locally accelerated macOS input. */
export class TranscriptWheel {
	#last = -Infinity;
	#direction = 0;
	#average = 0;
	#fraction = 0;

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
	}

	lines(direction: number, now: number, fixed: number): number {
		if (fixed > 0 && Number.isFinite(fixed)) {
			this.reset();
			return Math.max(1, Math.trunc(fixed));
		}
		if (!this.accelerate) return 1;
		const gap = now - this.#last;
		if (direction !== this.#direction || gap > 200 || gap < 0) this.reset();
		this.#direction = direction;
		const first = this.#last === -Infinity;
		this.#last = now;
		if (first || gap < 5) return 1;
		this.#average = this.#average ? (this.#average + gap) / 2 : gap;
		const total = Math.max(1, Math.min(6, 100 / this.#average)) + this.#fraction;
		const lines = Math.floor(total);
		this.#fraction = total - lines;
		return lines;
	}
}
