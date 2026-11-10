/**
 * Truncate `text` to its first `maxCodePoints` Unicode code points.
 *
 * The cap unit is a code point (a Unicode scalar value), not a UTF-16 code
 * unit and not a grapheme cluster: an astral code point (emoji, CJK
 * extensions) is one unit and is never split into an unpaired surrogate
 * half. A combining sequence may still span the limit — only whole code
 * points are preserved, not whole graphemes. Text within the cap is
 * returned as-is (the same string, no copy), and no ellipsis is added.
 *
 * Implemented as an index scan and one final slice: it walks the string
 * until `maxCodePoints` scalars have been counted (or the string ends) and
 * slices at that boundary, never materializing an array of code points.
 */
export function truncateCodePoints(text: string, maxCodePoints: number): string {
	let end = 0;
	let counted = 0;
	while (end < text.length && counted < maxCodePoints) {
		const codePoint = text.codePointAt(end)!;
		end += codePoint > 0xffff ? 2 : 1;
		counted++;
	}
	return end === text.length ? text : text.slice(0, end);
}
