/** Add global flag while preserving user-provided flags. */
function enforceGlobalFlag(flags: string): string {
	return flags.includes("g") ? flags : `${flags}g`;
}

/** Compile a secret regex entry with global scanning enabled by default. */
export function compileSecretRegex(pattern: string, flags?: string): RegExp {
	let resolvedPattern = pattern;
	let resolvedFlags = flags ?? "";

	// Detect regex literal syntax: /pattern/flags
	const literalMatch = /^\/((?:[^\\/]|\\.)*)\/([ gimsuy]*)$/.exec(pattern);
	if (literalMatch) {
		resolvedPattern = literalMatch[1];
		// Merge flags from literal with explicit flags param (deduplicate)
		const combined = new Set([...resolvedFlags, ...literalMatch[2]]);
		resolvedFlags = [...combined].join("");
	}

	return new RegExp(resolvedPattern, enforceGlobalFlag(resolvedFlags));
}

/** Advance after an empty global match without splitting a Unicode code point or repeating a match at end. */
export function advanceRegexAfterEmptyMatch(regex: RegExp, text: string): void {
	const codePoint = regex.unicode || regex.unicodeSets ? text.codePointAt(regex.lastIndex) : undefined;
	regex.lastIndex += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

/** Shortest derived literal worth a gate; a shorter one occurs in too much text to skip anything. */
const MIN_REQUIRED_LITERAL = 3;

/** Characters an identity escape (`\.`) turns into a literal. */
const ESCAPED_LITERALS = new Set("^$\\.*+?()[]{}|/-");

/** Characters that end a literal run: syntax, or literal only in some contexts. */
const SYNTAX = new Set("^$\\.*+?()[]{}|");

/**
 * A literal every match of `regex` contains, read from the pattern's leading
 * literal run (after zero-width `^`, `\b`, `\B` and lookarounds), so the
 * obfuscator can skip text without it. Conservative: undefined when the
 * pattern has a top-level alternation, uses the `v` flag, or starts with
 * anything but ASCII literals; a quantified last character is left out.
 *
 * Example: `api_?key=\w+` → `"api"`; `(?<=x)tok_[0-9]+` → `"tok_"`.
 */
export function requiredLiteral(regex: RegExp): string | undefined {
	const source = regex.source;
	if (regex.unicodeSets || hasTopLevelAlternation(source)) return undefined;
	let at = 0;
	for (;;) {
		if (source[at] === "^") at++;
		else if (source.startsWith("\\b", at) || source.startsWith("\\B", at)) at += 2;
		else if (/^\(\?<?[=!]/.test(source.slice(at, at + 4))) at = groupEnd(source, at);
		else break;
	}
	let literal = "";
	while (at < source.length) {
		let char = source[at]!;
		let next = at + 1;
		if (char === "\\") {
			char = source[at + 1] ?? "";
			if (!ESCAPED_LITERALS.has(char)) break;
			next = at + 2;
		} else if (SYNTAX.has(char) || char.charCodeAt(0) > 0x7f) {
			break;
		}
		const quantifier = source[next];
		// `?`, `*` and `{0,…}` let the character be absent; `+` keeps one copy.
		if (quantifier === "?" || quantifier === "*" || quantifier === "{") break;
		literal += char;
		at = next;
		if (quantifier === "+") break;
	}
	return literal.length >= MIN_REQUIRED_LITERAL ? literal : undefined;
}

/** Index just past the group opened at `start`, skipping escapes and classes. */
function groupEnd(source: string, start: number): number {
	let depth = 0;
	let inClass = false;
	for (let at = start; at < source.length; at++) {
		const char = source[at];
		if (char === "\\") at++;
		else if (inClass) inClass = char !== "]";
		else if (char === "[") inClass = true;
		else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return at + 1;
	}
	return source.length;
}

/** Whether `|` splits the whole pattern, outside every group and class. */
function hasTopLevelAlternation(source: string): boolean {
	let depth = 0;
	let inClass = false;
	for (let at = 0; at < source.length; at++) {
		const char = source[at];
		if (char === "\\") at++;
		else if (inClass) inClass = char !== "]";
		else if (char === "[") inClass = true;
		else if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === "|" && depth === 0) return true;
	}
	return false;
}
