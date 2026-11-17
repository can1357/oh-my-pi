/** Default character budget for a single embedding or fact-extraction input. */
export const DEFAULT_INPUT_CHARS = 8192;

const ELISION_MARKER = "\n\n[...]\n\n";

/**
 * Preserve the opening context and newest turns of an oversized chronological input.
 *
 * Cut points never split a surrogate pair: a lone surrogate serializes as `\ud83d`
 * in JSON, which strict OpenAI-compatible servers reject with HTTP 400.
 */
export function clipToWindow(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= ELISION_MARKER.length + 16) return text.slice(tailStart(text, text.length - max));
	const budget = max - ELISION_MARKER.length;
	const headLen = budget >>> 1;
	const tailLen = budget - headLen;
	return text.slice(0, headEnd(text, headLen)) + ELISION_MARKER + text.slice(tailStart(text, text.length - tailLen));
}

/** Pulls a head cut back by one unit when it would end on a high surrogate. */
function headEnd(text: string, end: number): number {
	const unit = text.charCodeAt(end - 1);
	return unit >= 0xd800 && unit <= 0xdbff ? end - 1 : end;
}

/** Pushes a tail cut forward by one unit when it would start on a low surrogate. */
function tailStart(text: string, start: number): number {
	const unit = text.charCodeAt(start);
	return unit >= 0xdc00 && unit <= 0xdfff ? start + 1 : start;
}
