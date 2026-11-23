/** Leading PCRE-style inline flag group of only flags `RegExp` also has, e.g. `(?i)` or `(?ims)`. */
const TRANSLATABLE_INLINE_FLAGS = /^\(\?([ims]+)\)/;

/**
 * Splits a leading PCRE-style inline flag group, which JavaScript `RegExp` rejects, off `pattern`
 * into the `RegExp` flags it names. Only a leading group of `i`, `m`, and `s` is translated;
 * anything else is returned verbatim with no flags, so `RegExp` still reports a genuinely invalid pattern.
 */
export function splitInlineFlags(pattern: string): { source: string; flags: string } {
	const match = TRANSLATABLE_INLINE_FLAGS.exec(pattern);
	if (!match) return { source: pattern, flags: "" };
	return { source: pattern.slice(match[0].length), flags: Array.from(new Set(match[1])).join("") };
}
