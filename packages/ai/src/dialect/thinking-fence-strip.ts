/**
 * Strip self-referential reasoning-fence delimiters that a provider leaks
 * *inside* a structured thinking part.
 *
 * The visible-channel healers ({@link ../utils/leaked-thinking-stream},
 * {@link ./fenced-thinking}) split leaked ` ```thinking ` fences out of the
 * *text* stream. They never run over parts a provider already flags as
 * thinking, so when a model (observed on Gemini thought summaries — issue
 * #8719) emits a bare ` ```thinking ` / ` ``````thinking ` opener line between
 * summaries, that delimiter reaches display and persistence verbatim as fence
 * spam inside the reasoning block.
 *
 * This stripper removes only a *standalone* reasoning-fence opener line — a line
 * that is nothing but a run of ≥3 backticks immediately followed by the info
 * string `thinking` or `reasoning`. Such a line is always redundant inside an
 * already-structured thinking block and never carries content. Inline mentions
 * (prose on the same line), language-tagged code fences (` ```rs `), and bare
 * closers (` ``` `) are left untouched so legitimate fenced code inside the
 * reasoning survives.
 *
 * Streaming-safe: deltas may split a line anywhere. A trailing partial line is
 * held only while it remains a viable opener prefix; the moment it cannot be an
 * opener it is flushed and the rest of the line passes through character-level.
 * Correctness never depends on the prefix heuristic — every held line is
 * classified strictly on its newline (or on {@link ThinkingFenceStripper.flush})
 * before it is dropped.
 */

/**
 * A complete standalone reasoning-fence opener: ≤3 lead spaces, ≥3 backticks,
 * `thinking`/`reasoning`, optional trailing spaces, tolerating a trailing CR
 * from a CRLF newline.
 */
const OPENER_LINE = /^ {0,3}`{3,}(?:thinking|reasoning)[ \t]*\r?$/i;

/** Could `line` (a partial, newline-not-yet-seen) still grow into {@link OPENER_LINE}? */
function couldBeOpenerPrefix(line: string): boolean {
	// Tolerate a pending CR from a split CRLF.
	const s = line.endsWith("\r") ? line.slice(0, -1) : line;
	const m = /^ {0,3}(`*)([\s\S]*)$/.exec(s);
	if (!m) return false;
	const ticks = m[1]!.length;
	const rest = m[2]!;
	if (rest === "") return true; // still consuming leading spaces / backticks
	if (ticks < 3) return false; // a non-backtick char appeared before 3 backticks: never a fence
	const word = rest.replace(/[ \t]+$/, "").toLowerCase();
	return "thinking".startsWith(word) || "reasoning".startsWith(word);
}

/**
 * Stateful, line-oriented stripper for leaked reasoning-fence openers in one
 * structured thinking block. One instance per thinking block; feed every
 * thinking delta through {@link push} and drain the tail with {@link flush}.
 */
export class ThinkingFenceStripper {
	/** Buffered content of the current line still being classified. */
	#carry = "";
	/** True once the current line is known not to be an opener; passes through until newline. */
	#passthrough = false;

	/** Consume one thinking delta; returns the sanitized text to emit (may be empty). */
	push(chunk: string): string {
		let out = "";
		for (const ch of chunk) {
			if (this.#passthrough) {
				out += ch;
				if (ch === "\n") this.#passthrough = false;
				continue;
			}
			if (ch === "\n") {
				if (!OPENER_LINE.test(this.#carry)) out += `${this.#carry}\n`;
				this.#carry = "";
				continue;
			}
			this.#carry += ch;
			if (!couldBeOpenerPrefix(this.#carry)) {
				out += this.#carry;
				this.#carry = "";
				this.#passthrough = true;
			}
		}
		return out;
	}

	/** Drain any held partial line at block end; returns text to emit (may be empty). */
	flush(): string {
		const carry = this.#carry;
		this.#carry = "";
		this.#passthrough = false;
		return OPENER_LINE.test(carry) ? "" : carry;
	}
}
