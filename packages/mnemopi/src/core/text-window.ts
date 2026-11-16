/** Default character budget for a single embedding or fact-extraction input. */
export const DEFAULT_INPUT_CHARS = 8192;

/**
 * Conservative character-per-token ratio used to turn the configured
 * character budget into a token budget. 8192 chars therefore allow 2048
 * tokens, matching llama.cpp embedding servers whose physical batch is 2048
 * tokens and leaving ordinary 8k-token API contexts untouched.
 */
export const CHARS_PER_TOKEN = 4;

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

/**
 * Rough token count for BERT/XLM-R/OpenAI-style tokenizers without loading a
 * tokenizer. ASCII runs tokenize at ~2.5-4 chars/token; non-ASCII (CJK,
 * emoji, byte-fallback symbols) tokenize at one or more tokens per UTF-16
 * unit. Deliberately overestimates so a provider-side tokenizer stays below
 * the budget.
 */
export function estimateTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 0x80) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / 2.5 + nonAscii * 1.5);
}

/**
 * Clip an input to a token budget while preserving the opening context and the
 * newest turns, using {@link clipToWindow} for the head/tail split. Returns the
 * text unchanged when it already fits. The character budget is derived from
 * the text's own token density so heavily non-ASCII inputs shrink further than
 * English prose.
 */
export function clipToTokenWindow(text: string, maxTokens: number): string {
	if (maxTokens <= 0) return text;
	let clipped = text;
	for (let attempt = 0; attempt < 8; attempt++) {
		const tokens = estimateTokens(clipped);
		if (tokens <= maxTokens) return clipped;
		const floor = ELISION_MARKER.length + 16;
		const budget = Math.max(floor, Math.floor((clipped.length * maxTokens) / tokens));
		if (budget >= clipped.length) break;
		clipped = clipToWindow(clipped, budget);
		if (clipped.length <= floor) return clipped;
	}
	return clipped;
}
