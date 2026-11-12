import { SecretRegex, SecretText } from "@oh-my-pi/pi-natives";

/** A secret rule's match: the redacted span, shaped like the parts of `RegExpExecArray` the redactor reads. */
export interface SecretMatch {
	0: string;
	index: number;
}

/** The global-`RegExp` exec protocol shared by {@link SecretPattern} and `RegExp`. */
export interface SpanPattern {
	lastIndex: number;
	exec(text: string): SecretMatch | null;
}

/** A {@link SecretPattern} match. */
export interface SecretPatternMatch extends SecretMatch {
	/** Where the whole match begins: before {@link SecretMatch.index} when context precedes the `secret` group. */
	matchIndex: number;
}

/**
 * Texts converted for the native engine, most recent last. The redactor runs
 * every rule over the same few strings (a text, its placeholder-expanded scan
 * view, short probes), so a handful of slots convert each string once.
 */
const textCache = new Map<string, SecretText>();
const TEXT_CACHE_SIZE = 8;

function secretText(text: string): SecretText {
	let converted = textCache.get(text);
	if (converted !== undefined) {
		textCache.delete(text);
	} else {
		converted = new SecretText(text);
		if (textCache.size >= TEXT_CACHE_SIZE) textCache.delete(textCache.keys().next().value!);
	}
	textCache.set(text, converted);
	return converted;
}

/**
 * A secret regex rule: a Rust `regex` pattern run by the native engine, with
 * the global-`RegExp` `exec`/`test`/`lastIndex` protocol. A match is the
 * span the rule redacts: its `secret` named group when that participates,
 * else the whole match. The next search starts at the end of that span.
 */
export class SecretPattern {
	lastIndex = 0;
	readonly #native: SecretRegex;

	constructor(
		readonly source: string,
		readonly flags: string,
	) {
		this.#native = new SecretRegex(source, flags);
	}

	exec(text: string): SecretPatternMatch | null {
		const span = this.lastIndex > text.length ? null : this.#native.exec(secretText(text), this.lastIndex);
		if (span === null) {
			this.lastIndex = 0;
			return null;
		}
		const [start, end, matchIndex] = span as [number, number, number];
		this.lastIndex = end;
		return { 0: text.slice(start, end), index: start, matchIndex };
	}

	test(text: string): boolean {
		return this.exec(text) !== null;
	}
}

/**
 * Compile a secret regex rule. `pattern` is a Rust `regex` pattern, or
 * `/pattern/flags`; flags are `i`, `m` and `s` (`g` and `u` are accepted and
 * ignored). Throws when the pattern or a flag is invalid.
 */
export function compileSecretRegex(pattern: string, flags?: string): SecretPattern {
	let resolvedPattern = pattern;
	let resolvedFlags = flags ?? "";
	// Regex literal syntax: /pattern/flags
	const literalMatch = /^\/((?:[^\\/]|\\.)*)\/([ a-z]*)$/.exec(pattern);
	if (literalMatch) {
		resolvedPattern = literalMatch[1]!;
		resolvedFlags = [...new Set([...resolvedFlags, ...literalMatch[2]!.replaceAll(" ", "")])].join("");
	}
	return new SecretPattern(resolvedPattern, resolvedFlags);
}

/** `text` with every non-empty span `regex` redacts replaced by `replacement`. */
export function replaceSecretMatches(regex: SecretPattern, text: string, replacement: string): string {
	regex.lastIndex = 0;
	let out = "";
	let cursor = 0;
	let replaced = false;
	for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
		if (match[0].length === 0) {
			regex.lastIndex++;
			continue;
		}
		out += text.slice(cursor, match.index) + replacement;
		cursor = match.index + match[0].length;
		replaced = true;
	}
	regex.lastIndex = 0;
	return replaced ? out + text.slice(cursor) : text;
}
