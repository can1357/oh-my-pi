import { prompt } from "@oh-my-pi/pi-utils";
import orchestrateNotice from "../prompts/system/orchestrate-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/**
 * "orchestrate" keyword support.
 *
 * Typing the standalone word in the input editor paints it with a cool
 * teal→violet gradient ({@link highlightOrchestrate}); submitting a message that
 * mentions it appends a hidden {@link renderOrchestrateNotice} notice that switches
 * the model into multi-agent orchestration mode. Matching is prose-delimited and
 * case-sensitive (lowercase only), so "orchestrated", "Orchestrate", or a path
 * like "orchestrate.ts" never trigger either behavior. Replaces the former
 * `/orchestrate` slash command.
 */

// Detection: lowercase keyword flanked by prose punctuation, whitespace, or a string edge.
const ORCHESTRATE_WORD = magicKeywordRegex("orchestrate");

/** Hidden system notice appended after a user message that mentions "orchestrate". */
export function renderOrchestrateNotice(options: { tools: readonly string[] }): string {
	return prompt.render(orchestrateNotice, { tools: options.tools }).trim();
}

/**
 * Whether `text` contains the standalone keyword "orchestrate" (lowercase,
 * prose-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsOrchestrate(text: string): boolean {
	return keywordInProse(text, ORCHESTRATE_WORD);
}

/**
 * Highlight every standalone "orchestrate" in `text` for editor display with a
 * cool teal→violet gradient (hue 150..280), visually distinct from ultrathink's
 * full-spectrum rainbow.
 */
export const highlightOrchestrate: KeywordHighlighter = createGradientHighlighter({
	probe: /orchestrate/,
	highlight: magicKeywordRegex("orchestrate", "g"),
	stops: 14,
	hue: t => 150 + t * 130,
});
