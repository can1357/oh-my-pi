/**
 * List-continuation grammar of `@oh-my-pi/pi-utils/marked`, for streaming
 * renderers that freeze a lexed prefix at blank-line boundaries (TUI and
 * collab web).
 *
 * marked's list tokenizer (Tokenizer.list, marked v18) continues a list across
 * blank lines only when the remaining source matches
 * `listItemRegex(marker)` = `^( {0,3}${marker})((?:[\t ][^\n]*)?(?:\n|$))`,
 * where `marker` is the exact bullet char for unordered lists (`\${char}`) or
 * 1-9 digits plus the exact delimiter for ordered lists (`\d{1,9}\${delim}`).
 * The marker is derived from the list's FIRST item (`n = t[1].trim()`), which
 * sits at the start of a top-level list token's raw.
 */

/** A list's marker, read from the start of its raw: bullet in group 1, ordered delimiter in group 2. */
const LIST_MARKER_RE = /^ {0,3}(?:([*+-])|\d{1,9}([.)]))/;

/**
 * Whether a same-marker item could still continue the list `listRaw` at
 * `tailStart` (directly after the blank line ending the list), now or after
 * any append to `text`.
 *
 * Streaming-freeze equivalence invariant: lex(prefix) ++ lex(tail) must equal
 * lex(full text) for the current text and every append-only extension of it,
 * because a frozen prefix is sticky. At a blank-line cut directly after a
 * top-level `list` token, the only construct that can straddle the cut is a
 * continuation item of that list: marked consumed the blank line into the last
 * item's raw and re-ran `listItemRegex` at exactly `tailStart`, merging a
 * same-marker item into one renumbered loose list. The cut is safe only when
 * that regex can NEVER match at `tailStart`, no matter what is appended later.
 *
 * Append-only growth means "closed" may only be concluded from a present
 * character that contradicts every possible continuation (tail "1x" can never
 * grow into an ordered item, but tail "1" can become "1. c"). Running out of
 * text mid-marker therefore answers "may continue".
 *
 * Returns true when the tail could still continue the list (or the list's
 * marker is unrecognizable) — the conservative "don't freeze" answer. marked
 * may break the list anyway when the matching line is also an hr (`- - -`);
 * treating that as "may continue" merely skips a freeze, never corrupts one.
 */
export function listMayContinueAt(text: string, tailStart: number, listRaw: string): boolean {
	const marker = LIST_MARKER_RE.exec(listRaw);
	if (marker === null) return true; // unrecognized list shape — stay conservative
	const n = text.length;
	let i = tailStart;
	// `listItemRegex` allows up to 3 leading spaces.
	while (i < n && i - tailStart < 3 && text.charCodeAt(i) === 0x20 /* space */) i++;
	if (i >= n) return true;
	const bullet = marker[1];
	if (bullet !== undefined) {
		if (text[i] !== bullet) return false; // wrong marker char — closed forever
		i++;
	} else {
		// Ordered: 1-9 digits, then the same `.`/`)` delimiter.
		let digits = 0;
		while (i < n && digits < 10) {
			const c = text.charCodeAt(i);
			if (c < 0x30 /* 0 */ || c > 0x39 /* 9 */) break;
			digits++;
			i++;
		}
		if (digits === 0 || digits > 9) return false; // no digit run / too long — closed forever
		if (i >= n) return true; // delimiter (or more digits) may still arrive
		if (text[i] !== marker[2]) return false; // wrong delimiter — closed forever
		i++;
	}
	// After the marker: `(?:[\t ][^\n]*)?(?:\n|$)` — tab/space + anything, a
	// bare newline, or end-of-input (which appends can still extend).
	if (i >= n) return true;
	const after = text.charCodeAt(i);
	return after === 0x20 /* space */ || after === 0x09 /* tab */ || after === 0x0a; /* \n */
}
