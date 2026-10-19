import type { JobTextChunk, JobTextSource } from "./types";

/** Characters a {@link TextTap} keeps by default: its newest 256 Ki. */
const DEFAULT_CAPACITY = 256 * 1024;

/**
 * Text appended over time and kept as its newest `capacity` UTF-16 units,
 * readable from any retained offset: a bash job's own output, or a
 * subagent's finished tool results.
 */
export class TextTap implements JobTextSource {
	#text = "";
	/** Offset of `#text[0]`. */
	#start = 0;
	#open = true;
	readonly #capacity: number;

	constructor(
		readonly id: string,
		readonly label: string,
		capacity = DEFAULT_CAPACITY,
	) {
		this.#capacity = Math.max(1, capacity);
	}

	append(text: string): void {
		if (!this.#open || text.length === 0) return;
		this.#text += text;
		// Trim in batches so a stream of small appends does not copy the
		// retained text on every chunk.
		const excess = this.#text.length - this.#capacity;
		if (excess > this.#capacity / 4) {
			this.#text = this.#text.slice(excess);
			this.#start += excess;
		}
	}

	/** No more text will arrive. */
	close(): void {
		this.#open = false;
	}

	read(from: number): JobTextChunk {
		const end = this.#start + this.#text.length;
		const kept = Math.max(this.#start, end - this.#capacity);
		const start = Math.min(Math.max(from, kept), end);
		return { start, end, text: this.#text.slice(start - this.#start), open: this.#open };
	}
}
