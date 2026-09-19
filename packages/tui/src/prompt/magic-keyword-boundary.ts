/** Characters that bind a magic keyword into an identifier or path segment. */
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;

/** Characters that cannot immediately follow a standalone magic keyword. */
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

/** Escape a literal string for safe insertion into a RegExp source. */
function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Build a case-sensitive magic-keyword matcher for prose punctuation boundaries.
 *
 * Sentence punctuation and quotes may touch the keyword, but letters, digits,
 * underscores, slashes, backslashes, hyphens, file-extension dots, symbol
 * references (`foo::keyword`), and immediate call parentheses (`keyword()`)
 * keep the occurrence embedded in code rather than prose.
 */
export function magicKeywordRegex(keyword: string, flags = ""): RegExp {
	const normalizedFlags = flags.includes("u") ? flags : `${flags}u`;
	return new RegExp(`${LEFT_BOUNDARY}${escapeRegExp(keyword)}${RIGHT_BOUNDARY}`, normalizedFlags);
}
