/** Lexical checks shared by the composer and its completion sources. No provider or filesystem access. */
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/**
 * Locate the slash that opens a slash command on the line, allowing leading
 * whitespace. Returns the index of the `/` or `null` when the line is not a
 * slash command. Aligns with `trimStart` semantics so the editor and provider
 * agree on which prefixes count.
 */
export function findLeadingSlashCommandStart(text: string): number | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/")) return null;
	return text.length - trimmed.length;
}

export function findTrailingSlashCommandStart(text: string): number | null {
	const match = /(?:^|\s)\/([^\s/]*)$/.exec(text);
	if (!match || match.index === undefined) return null;
	const slashOffset = match[0].indexOf("/");
	return match.index + slashOffset;
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

/** Extract the live whitespace-delimited or double-quoted `@` file token ending at the cursor. */
export function extractAtFilePrefix(text: string): string | null {
	const quotedPrefix = extractQuotedPrefix(text);
	if (quotedPrefix?.startsWith('@"')) {
		return quotedPrefix;
	}

	const lastDelimiterIndex = findLastDelimiter(text);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	return text[tokenStart] === "@" ? text.slice(tokenStart) : null;
}

/** Explicit Unix or Windows path syntax (a bare relative word is not an automatic trigger). */
export function isExplicitFilePath(token: string): boolean {
	return (
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.startsWith("~/") ||
		/^[A-Za-z]:[\\/]/.test(token)
	);
}

/** Extract a path-like prefix, including a quoted path; explicit Tab can also expand a plain word. */
export function extractPathPrefix(text: string, forceExtract = false): string | null {
	const quotedPrefix = extractQuotedPrefix(text);
	if (quotedPrefix) {
		return quotedPrefix;
	}

	const lastDelimiterIndex = findLastDelimiter(text);
	const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

	// For forced extraction (Tab key), always return something
	if (forceExtract) {
		return pathPrefix;
	}

	return isExplicitFilePath(pathPrefix) ? pathPrefix : null;
}

export function hasPromptTextBeforeSlash(
	lines: readonly string[],
	cursorLine: number,
	textBeforeCursor: string,
	slashStart: number,
): boolean {
	for (let i = 0; i < cursorLine; i += 1) {
		if ((lines[i] || "").trim() !== "") return true;
	}
	return textBeforeCursor.slice(0, slashStart).trim() !== "";
}

export const MODEL_MENTION_CONTEXT_RE = /(?:^|\s)(\^[^\s]*)$/;

/**
 * A URL token ending at the cursor: a known internal scheme followed by one or
 * two slashes and the partially typed host/path.
 */
export const URL_TOKEN_RE = /(?:^|[\s"'`(<=])([a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*)$/i;

export function getPromptActionPrefix(textBeforeCursor: string): string | null {
	const hashIndex = textBeforeCursor.lastIndexOf("#");
	if (hashIndex === -1) return null;

	const query = textBeforeCursor.slice(hashIndex + 1);
	if (/[\s]/.test(query)) {
		return null;
	}

	return textBeforeCursor.slice(hashIndex);
}

// Shortcode-name characters mirror the GitHub/gemoji grammar: `a-z`, `A-Z`,
// `0-9`, `_`, `+`, `-`.
function isNameCharCode(c: number): boolean {
	return (
		(c >= 0x61 && c <= 0x7a) ||
		(c >= 0x41 && c <= 0x5a) ||
		(c >= 0x30 && c <= 0x39) ||
		c === 0x5f ||
		c === 0x2b ||
		c === 0x2d
	);
}

// Token boundary to the left of an opening `:`: start-of-string or one of
// the punctuation characters we treat as a "fresh token" marker (whitespace,
// opening brackets, `>` for quoted blocks).
export function hasEmojiLeftBoundary(text: string, colonIdx: number): boolean {
	if (colonIdx === 0) return true;
	const c = text.charCodeAt(colonIdx - 1);
	return (
		c === 0x20 || // space
		c === 0x09 || // tab
		c === 0x0a || // \n
		c === 0x0d || // \r
		c === 0x28 || // (
		c === 0x5b || // [
		c === 0x7b || // {
		c === 0x3e // >
	);
}

/** Name offset after a boundary-anchored opening colon, or -1 when the token is not a shortcode. */
export function findEmojiNameStart(text: string, end = text.length): number {
	let i = end;
	while (i > 0 && isNameCharCode(text.charCodeAt(i - 1))) i--;
	return i > 0 && text.charCodeAt(i - 1) === 0x3a && hasEmojiLeftBoundary(text, i - 1) ? i : -1;
}

export const SKILL_NAMESPACE = "skill:";

/**
 * Whether an autocomplete value represents a directory: trailing slash or
 * backslash, optionally followed by a closing quote for quoted paths.
 * Shared by the provider suffix logic and the editor chain-on-accept
 * behavior so Tab and Enter acceptance stay in sync.
 */
export function isDirectoryCompletionValue(value: string): boolean {
	return /[\\/]["']?$/.test(value);
}

/** Ranked-tier subsequence match ("wig" ~ "skill:wig"); distinct from fuzzy.ts's word-local engine. */
export function subsequenceMatch(query: string, target: string): boolean {
	if (query.length === 0) return true;
	if (query.length > target.length) return false;

	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (query[qi] === target[ti]) qi++;
	}
	return qi === query.length;
}
