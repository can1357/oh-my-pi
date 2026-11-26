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
