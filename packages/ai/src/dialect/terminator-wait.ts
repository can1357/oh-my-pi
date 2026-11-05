/**
 * Fast path for in-band scanners that sit inside a body waiting for one fixed
 * terminator (a tool-call close tag) and emit nothing until it arrives.
 *
 * Appending each delta to the scanner's string buffer and calling `indexOf` on
 * it flattens the growing rope on every delta, so a long in-band tool call cost
 * O(n²) copying and scanning. While armed, deltas are set aside and only the new
 * text plus the terminator-length overlap with what came before is searched;
 * the buffer is rebuilt once, when the terminator shows up or the stream ends.
 */
export class TerminatorWait {
	#terminator = "";
	#tail = "";
	#parts: string[] = [];

	/** Start deferring; `buffered` is the scanner's pending body, known not to contain `terminator`. */
	arm(terminator: string, buffered: string): void {
		this.#terminator = terminator;
		this.#tail = buffered.slice(Math.max(0, buffered.length - (terminator.length - 1)));
		this.#parts.length = 0;
	}

	/** Take `text` while the terminator is still absent; false means the caller must {@link release} and scan. */
	absorb(text: string): boolean {
		if (this.#terminator.length === 0) return false;
		const window = this.#tail + text;
		if (window.includes(this.#terminator)) return false;
		this.#parts.push(text);
		this.#tail = window.slice(Math.max(0, window.length - (this.#terminator.length - 1)));
		return true;
	}

	/** Stop deferring and return `buffered` with every absorbed delta appended. */
	release(buffered: string): string {
		this.#terminator = "";
		this.#tail = "";
		if (this.#parts.length === 0) return buffered;
		const joined = buffered + this.#parts.join("");
		this.#parts.length = 0;
		return joined;
	}
}
