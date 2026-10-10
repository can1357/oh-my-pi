/** Default character budget for a single embedding or fact-extraction input. */
export const DEFAULT_INPUT_CHARS = 8192;

const ELISION_MARKER = "\n\n[...]\n\n";

/** Preserve the opening context and newest turns of an oversized chronological input. */
export function clipToWindow(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= ELISION_MARKER.length + 16) return text.slice(text.length - max);
	const budget = max - ELISION_MARKER.length;
	const headLen = budget >>> 1;
	const tailLen = budget - headLen;
	return text.slice(0, headLen) + ELISION_MARKER + text.slice(text.length - tailLen);
}
