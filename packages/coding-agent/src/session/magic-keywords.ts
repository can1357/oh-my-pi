import { MAGIC_KEYWORDS } from "../modes/magic-keywords";
import { keywordInProse, maskNonProse } from "../modes/view-model/prompt/markdown-prose";

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
 * Whether `text` contains `word` as standalone lowercase prose — never inside
 * a code block, inline code span, or XML/HTML section. Pure: does not require
 * `word` to be registered.
 */
export function containsMagicKeyword(text: string, word: string): boolean {
	return keywordInProse(text, matcherFor(word));
}

/** Global standalone-prose matcher per word, walked over masked text. */
const globalMatchers = new Map<string, RegExp>();

/** Whether `word` is exactly a magic keyword (spelling autocorrect and typo marks leave those alone). */
export function isMagicKeyword(word: string): boolean {
	return MAGIC_KEYWORDS.some(keyword => keyword.word === word);
}

/**
 * UTF-16 ranges where any of `words` stands as prose in `text` (never inside a code block, an
 * inline code span or an XML/HTML section), in text order.
 */
export function magicKeywordRanges(
	text: string,
	words: readonly string[],
): { readonly from: number; readonly to: number; readonly word: string }[] {
	const ranges: { from: number; to: number; word: string }[] = [];
	let masked: string | undefined;
	for (const word of words) {
		if (!text.includes(word)) continue;
		masked ??= maskNonProse(text);
		let pattern = globalMatchers.get(word);
		if (!pattern) {
			pattern = magicKeywordRegex(word, "g");
			globalMatchers.set(word, pattern);
		}
		for (const match of masked.matchAll(pattern))
			ranges.push({ from: match.index, to: match.index + match[0].length, word });
	}
	return ranges.sort((a, b) => a.from - b.from);
}
