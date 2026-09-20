import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

const JEVIFY_WORD = magicKeywordRegex("jevify");

/**
 * Whether `text` contains the standalone keyword "jevify" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsJevify(text: string): boolean {
	return keywordInProse(text, JEVIFY_WORD);
}

/**
 * Highlight every standalone "jevify" in `text` for editor display with a
 * magenta→gold gradient (hue 300..420, wrapping through red), visually distinct
 * from ultrathink's rainbow, orchestrate's teal→violet, and workflowz's amber→green.
 */
export const highlightJevify: KeywordHighlighter = createGradientHighlighter({
	probe: /jevify/,
	highlight: magicKeywordRegex("jevify", "g"),
	stops: 14,
	hue: t => (300 + t * 120) % 360,
});
