export interface Counts {
	lines: number;
	words: number;
	chars: number;
}

/** `wc`-style counts: newlines, whitespace-separated words, and UTF-16 code units. */
export function countWords(text: string): Counts {
	return {
		lines: text.split("\n").length - 1,
		words: text.split(/\s+/).filter(Boolean).length,
		chars: text.length,
	};
}
