/**
 * Close-matcher for a ` ```thinking ` block that respects nested Markdown code
 * fences. A naive `indexOf("```")` closes the thinking section at the FIRST
 * backtick fence inside the reasoning, so an inner ` ```rs … ``` ` code block
 * leaks its body (and everything after) into the visible channel. This scanner
 * tracks inner-fence nesting so only the real thinking closer ends the block.
 *
 * Distinguishing an inner opener from the closer: a fenced code block opener is
 * ` ``` ` immediately followed by a language token (`rs`, `tool_code`, `c++` …)
 * and a newline. The thinking closer is a bare ` ``` `, or ` ``` ` glued to the
 * visible reply — its remainder is prose (contains whitespace/punctuation), not
 * a language token. So a top-level fence whose info is a single language-token
 * word opens a nested block; anything else closes the thinking, and the text
 * after the fence run is the visible reply. This preserves the long-standing
 * inline-close behavior (` ```Visible reply ` ends the block) while skipping
 * language-tagged inner fences.
 *
 * Used by both the owned Gemini scanner (live ` ```thinking ` stream) and the
 * generic `ThinkingInbandScanner` (leaked-idiom healing).
 *
 * Limitation: an *info-less* nested fence (a bare ` ``` ` opening a code block
 * inside the reasoning) is indistinguishable from the thinking closer and ends
 * the block. Models tag their fences with a language in practice, so this is
 * strictly better than the previous first-` ``` ` behavior.
 */

/** A complete fence line: ≤3 lead spaces, a run of ≥3 backticks/tildes, then an info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** ≤3 lead spaces then a (possibly partial) backtick run and whatever follows it. */
const BACKTICK_LEAD = /^ {0,3}(`*)([\s\S]*)$/;
/** A language-tag info string: one token, no whitespace (markers an inner fence opener carries). */
const LANG_TOKEN = /^[A-Za-z0-9_+#-]+$/;

/** Result of feeding bytes to {@link FencedThinkingScanner}. */
export interface FencedThinkingResult {
	/** Thinking text to emit for this feed (may be empty). */
	readonly thinking: string;
	/** True once the thinking closer has been consumed. */
	readonly closed: boolean;
	/** Bytes after the closing fence (visible reply); only meaningful when {@link closed}. */
	readonly rest: string;
}

/**
 * Stateful, line-oriented close-matcher for one ` ```thinking ` block. Owns the
 * partial-line buffer so an ambiguous trailing fence is held until it resolves.
 *
 * Streaming stays character-level for ordinary content: a line is emitted as its
 * bytes arrive, yet retained in the buffer until its newline so the complete
 * line can be classified ({@link #emitted} tracks how many leading bytes are
 * already emitted). A top-level fence candidate is held until its info
 * disambiguates opener (language token) from closer (prose / bare).
 */
export class FencedThinkingScanner {
	#buffer = "";
	/** The fence run that opened the current nested code block, or "" at top level. */
	#inner = "";
	/** Bytes of the leading (incomplete) line already returned as thinking. */
	#emitted = 0;

	/**
	 * Feed bytes and return thinking deltas plus close state. When `final`, the
	 * held tail resolves: a bare ` ``` ` or a ` ```<reply> ` fence closes the
	 * block (remainder becomes `rest`), otherwise it is unterminated thinking.
	 */
	feed(text: string, final: boolean): FencedThinkingResult {
		this.#buffer += text;
		let thinking = "";
		for (;;) {
			const nl = this.#buffer.indexOf("\n");
			if (nl === -1) break;
			const line = this.#buffer.slice(0, nl);
			if (!this.#inner) {
				const close = this.#closeRest(line);
				if (close !== undefined) {
					// Closer bytes are always held, so #emitted is 0 and nothing leaked.
					const rest = close + this.#buffer.slice(nl); // keep the newline with the reply
					this.#reset();
					return { thinking, closed: true, rest };
				}
			}
			// Content line (including an inner-fence open/close).
			thinking += this.#buffer.slice(this.#emitted, nl + 1);
			this.#updateInner(line);
			this.#buffer = this.#buffer.slice(nl + 1);
			this.#emitted = 0;
		}

		const tail = this.#buffer;
		if (this.#inner) {
			// Inside a nested block every byte is thinking content: emit eagerly,
			// keeping it buffered until the newline classifies the line.
			thinking += tail.slice(this.#emitted);
			this.#emitted = tail.length;
			return { thinking, closed: false, rest: "" };
		}

		if (final) {
			const close = this.#closeRestFinal(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
		} else {
			const close = this.#closeRestStreamingTail(tail);
			if (close !== undefined) {
				this.#reset();
				return { thinking, closed: true, rest: close };
			}
			if (this.#mustHold(tail)) return { thinking, closed: false, rest: "" };
		}
		// Either final (flush the remainder) or a line that can no longer be a fence.
		thinking += tail.slice(this.#emitted);
		if (final) this.#reset();
		else this.#emitted = tail.length;
		return { thinking, closed: false, rest: "" };
	}

	/**
	 * Complete line close test. A bare backtick fence closes thinking; a
	 * language-token fence line opens an inner block; prose-like remainder is the
	 * inline visible reply.
	 */
	#closeRest(line: string): string | undefined {
		const m = BACKTICK_LEAD.exec(line);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "") return ""; // bare close (only whitespace)
		if (LANG_TOKEN.test(rest)) return undefined; // language-tagged inner opener
		return rest;
	}

	/** Final tail close test: EOF disambiguates any top-level backtick run as the closer. */
	#closeRestFinal(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		return rest.trim() === "" ? "" : rest;
	}

	/** Streaming tail close test: only a prose-like inline reply resolves the close. */
	#closeRestStreamingTail(tail: string): string | undefined {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m || m[1]!.length < 3) return undefined;
		const rest = m[2]!;
		if (rest === "" || rest.trim() === "" || LANG_TOKEN.test(rest)) return undefined;
		return rest;
	}

	/** Whether a top-level trailing partial is still undecided and must be held. */
	#mustHold(tail: string): boolean {
		const m = BACKTICK_LEAD.exec(tail);
		if (!m) return false;
		const ticks = m[1]!.length;
		const rest = m[2]!;
		// A growing backtick run could still reach a fence. A complete run plus
		// a language-token prefix is also undecided until a newline confirms an
		// inner opener or a non-token character confirms an inline close.
		if (rest === "" || rest.trim() === "") return ticks >= 1 || /^ {0,3}$/.test(tail);
		return ticks >= 3 && LANG_TOKEN.test(rest);
	}

	#reset(): void {
		this.#buffer = "";
		this.#inner = "";
		this.#emitted = 0;
	}

	/** Toggle nested-fence state for a completed content line. */
	#updateInner(line: string): void {
		const fence = FENCE_LINE.exec(line);
		if (!fence) return;
		const run = fence[1]!;
		const info = fence[2]!.trim();
		if (!this.#inner) {
			// A top-level closer was already handled by #closeRest, so this opens a
			// nested code block (tilde fence, or backtick fence with a language token).
			this.#inner = run;
		} else if (run[0] === this.#inner[0] && run.length >= this.#inner.length && info === "") {
			// Closing fence: same char, at least as long, no info string.
			this.#inner = "";
		}
	}
}
