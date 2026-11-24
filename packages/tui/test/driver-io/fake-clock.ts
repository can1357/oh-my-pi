import type { Clock } from "../../src/driver/input/clock";

/** A manual clock: timers fire only through `advance`. */
export class FakeClock implements Clock {
	#now = 0;
	#timers: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
	#seq = 0;

	now(): number {
		return this.#now;
	}

	schedule(ms: number, fn: () => void): () => void {
		const timer = { at: this.#now + ms, seq: this.#seq++, fn, live: true };
		this.#timers.push(timer);
		return () => {
			timer.live = false;
		};
	}

	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			const due = this.#timers
				.filter(timer => timer.live && timer.at <= target)
				.sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
			if (!due) break;
			due.live = false;
			this.#now = due.at;
			due.fn();
		}
		this.#timers = this.#timers.filter(timer => timer.live);
		this.#now = target;
	}
}
