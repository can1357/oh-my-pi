import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * Magic-keyword engine: standalone prose words the host registers via
 * {@link setMagicKeywords} glow with a per-word gradient in the editor and in
 * sent bubbles, and are exempt from spelling autocorrect. The host (coding-agent
 * `modes/magic-keywords.ts`) owns the word list and the notices each word
 * injects; this module only knows how to find and paint them.
 */

/** One registered magic keyword: the prose trigger and its editor gradient. */
export interface MagicKeywordSpec {
	/** Exact lowercase trigger, matched only as standalone prose. */
	readonly word: string;
	/** HSL hue sweep `[from, to]` in degrees painted across the word; `to` may exceed 360 to wrap through red. */
	readonly hue: readonly [number, number];
}

/** Characters that bind a magic keyword into an identifier or path segment. */
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;

/** Characters that cannot immediately follow a standalone magic keyword. */
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

/**
 * Build a case-sensitive matcher for `word` at prose punctuation boundaries.
 *
 * Sentence punctuation and quotes may touch the keyword, but letters, digits,
 * underscores, slashes, backslashes, hyphens, file-extension dots, symbol
 * references (`foo::keyword`), and immediate call parentheses (`keyword()`)
 * keep the occurrence embedded in code rather than prose.
 */
function magicKeywordRegex(word: string, flags = ""): RegExp {
	const escaped = word.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	return new RegExp(`${LEFT_BOUNDARY}${escaped}${RIGHT_BOUNDARY}`, `${flags}u`);
}

interface RegisteredKeyword {
	readonly word: string;
	readonly highlight: KeywordHighlighter;
}

let registry: readonly RegisteredKeyword[] = [];

/** Non-global standalone-prose matcher per word, shared by detection paths. */
const matchers = new Map<string, RegExp>();

function matcherFor(word: string): RegExp {
	let matcher = matchers.get(word);
	if (!matcher) {
		matcher = magicKeywordRegex(word);
		matchers.set(word, matcher);
	}
	return matcher;
}

/**
 * Replace the registered keyword set. The host calls this once at startup;
 * until then nothing glows and no word is exempt from autocorrect.
 */
export function setMagicKeywords(specs: readonly MagicKeywordSpec[]): void {
	registry = specs.map(({ word, hue: [from, to] }) => ({
		word,
		highlight: createGradientHighlighter({
			probe: word,
			highlight: magicKeywordRegex(word, "g"),
			stops: 14,
			hue: t => (from + t * (to - from)) % 360,
		}),
	}));
}

/** Whether `word` is exactly a registered magic keyword (used to shield it from spelling autocorrect). */
export function isMagicKeyword(word: string): boolean {
	for (const keyword of registry) if (keyword.word === word) return true;
	return false;
}

/**
 * Whether `text` contains `word` as standalone lowercase prose — never inside
 * a code block, inline code span, or XML/HTML section. Pure: does not require
 * `word` to be registered.
 */
export function containsMagicKeyword(text: string, word: string): boolean {
	return keywordInProse(text, matcherFor(word));
}

/**
 * Gradient-highlight every registered keyword that appears as standalone
 * prose, skipping any occurrence inside a code block, inline code span, or
 * XML/HTML section. Each pass paints one word with its own gradient, so order
 * is irrelevant — earlier passes only inject zero-width SGR escapes (no
 * backticks or angle brackets), which never confuse later passes' markdown
 * masking.
 *
 * `resetTo` is the SGR foreground sequence restored after each painted keyword;
 * pass the surrounding text color when decorating already-colored content (e.g.
 * a themed message bubble) so the gradient does not bleed into the rest of the
 * line. Defaults to a plain foreground reset for default-colored editor text.
 *
 * `phase` ∈ [0, 1) cyclically rotates each gradient — the editor passes a
 * `Date.now()`-derived value to animate a Claude-Code-style shimmer while a
 * keyword is on screen and the prompt is focused; sent message bubbles omit it
 * to keep the static gradient.
 */
export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	let out = text;
	for (const keyword of registry) out = keyword.highlight(out, resetTo, phase);
	return out;
}

/**
 * Cheap test for "does this text contain any registered keyword as standalone
 * prose?". Short-circuits on a substring probe before paying for the
 * markdown-aware prose check, so the common "no keyword in buffer" path is one
 * `String#includes` per word. Used by the live editor to gate the shimmer timer.
 */
export function hasMagicKeyword(text: string): boolean {
	for (const keyword of registry) {
		if (text.includes(keyword.word) && containsMagicKeyword(text, keyword.word)) return true;
	}
	return false;
}
