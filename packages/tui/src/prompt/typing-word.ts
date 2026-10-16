/**
 * The word being typed in the composer. Misspelling marks hold off on it until
 * the caret leaves it (a space or punctuation, a caret move, losing focus), the
 * way Slack and Chromium mark a typo only once its word is done; marks on other
 * words stay while typing.
 */

/** A word of one logical line, as UTF-16 columns `[start, end)`. */
export interface TypingWord {
	line: number;
	start: number;
	end: number;
}

/** Letters, marks and digits, with apostrophes joining contractions. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}'\u2019]/u;

/** The run of word characters around column `col` of `line` (`undefined` between non-word characters). */
function wordAround(line: string, col: number): { start: number; end: number } | undefined {
	let start = col;
	while (start > 0 && WORD_CHAR.test(line.charAt(start - 1))) start--;
	let end = col;
	while (end < line.length && WORD_CHAR.test(line.charAt(end))) end++;
	return start < end ? { start, end } : undefined;
}

/** Follows an editor's text revision and caret to know which word is being typed. */
export class TypingWordTracker {
	#revision: number | undefined;
	#word: TypingWord | undefined;

	/** The word being typed, if any. */
	get word(): TypingWord | undefined {
		return this.#word;
	}

	/**
	 * Catch up with the editor: an edit that leaves the caret in (or right after)
	 * a word starts typing it; a caret move out of that word, or losing focus,
	 * ends it. The first call only records the revision, so a restored draft is
	 * not held. Returns whether the held word changed.
	 */
	update(revision: number, lines: readonly string[], line: number, col: number, focused: boolean): boolean {
		const before = this.#word;
		const edited = this.#revision !== undefined && this.#revision !== revision;
		this.#revision = revision;
		if (!focused) {
			this.#word = undefined;
		} else if (edited) {
			const span = wordAround(lines[line] ?? "", col);
			this.#word = span && { line, start: span.start, end: span.end };
		} else if (before && (before.line !== line || col < before.start || col > before.end)) {
			this.#word = undefined;
		}
		return (
			before?.line !== this.#word?.line || before?.start !== this.#word?.start || before?.end !== this.#word?.end
		);
	}
}
