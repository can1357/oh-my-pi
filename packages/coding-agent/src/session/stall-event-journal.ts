/** Bounded, receipt-committed diagnostic events. Eviction never silently erases an interval. */
export class StallEventJournal<T> {
	readonly #capacity: number;
	readonly #events: { sequence: number; value: T }[] = [];
	#sequence = 0;
	#committed = 0;

	constructor(capacity = 512) {
		if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Journal capacity must be positive");
		this.#capacity = capacity;
	}

	append(value: T): void {
		this.#events.push({ sequence: ++this.#sequence, value });
		if (this.#events.length > this.#capacity) this.#events.shift();
	}

	snapshot(): { events: readonly T[]; omitted: number; commit: () => void } {
		const watermark = this.#sequence;
		const retained = this.#events.filter(event => event.sequence > this.#committed);
		const first = retained[0]?.sequence ?? watermark + 1;
		return {
			events: retained.map(event => event.value),
			omitted: Math.max(0, first - this.#committed - 1),
			commit: () => {
				if (watermark <= this.#committed) return;
				this.#committed = watermark;
				while (this.#events[0] && this.#events[0].sequence <= watermark) this.#events.shift();
			},
		};
	}
}
