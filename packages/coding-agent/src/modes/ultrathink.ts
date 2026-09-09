import ultrathinkNotice from "../prompts/system/ultrathink-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "ultrathink" keyword support, mirroring Claude Code's affordance.
 *
 * Typing the standalone word in the input editor paints it with a rainbow
 * gradient ({@link highlightUltrathink}); submitting a message that mentions it
 * appends a hidden {@link ULTRATHINK_NOTICE} nudging the model toward careful
 * multi-step reasoning. Matching is prose-delimited and case-sensitive
 * (lowercase only), so "ultrathinking", "Ultrathink", or "ultrathink.ts" never
 * trigger either behavior.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const ULTRATHINK_WORD = magicKeywordRegex("ultrathink");

/** Hidden system notice appended after a user message that mentions "ultrathink". */
export const ULTRATHINK_NOTICE: string = ultrathinkNotice.trim();

/**
 * Whether `text` contains the standalone keyword "ultrathink" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltrathink(text: string): boolean {
	return keywordInProse(text, ULTRATHINK_WORD);
}

/**
 * Rainbow-highlight every standalone "ultrathink" in `text` for editor display.
 * Sweeps red→violet (hue 0..330), stopping short of the wrap back to red so the
 * gradient resolves smoothly regardless of casing or match length.
 */
export const highlightUltrathink: KeywordHighlighter = createGradientHighlighter({
	probe: /ultrathink/,
	highlight: magicKeywordRegex("ultrathink", "g"),
	stops: 14,
	hue: t => t * 330,
});
