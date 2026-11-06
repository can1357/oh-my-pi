/**
 * How a discovery provider records what its own substitution pass replaced.
 *
 * The tool cache keys a server's catalog on its config *as written*, so that
 * rotating a credential keeps the catalog and editing a literal drops it
 * (`attachConfigAsWritten` in `tool-cache.ts`). That only works if "this span
 * was substituted" is a fact the expander reports, not a guess about the
 * value it produced: every provider's grammar is its own, a provider that
 * expands config *text* can substitute what the parsed value cannot show, and
 * a value may spell a reference it never was.
 *
 * So a provider runs its substitution pass twice — once for the effective
 * value, once for this record — and the second pass wraps each span it really
 * replaced in {@link asWrittenSubstitution} while passing everything else
 * through {@link asWrittenLiteral}. The encoding is injective: U+0000 opens
 * every marker and is doubled wherever it occurs literally, so scanning left
 * to right, `\0\0` is one literal U+0000 and `\0(`/`\0)` can only be a marker
 * a pass wrote. A literal can therefore never hash as the substitution it
 * spells, whatever escape the config file used to write it.
 *
 * These values exist only to be hashed. Nothing reads them back and nothing
 * reaches a transport from them.
 */

/**
 * The character every marker opens with. A pass that rewrites text something
 * else still has to parse needs it spelled the way that syntax spells a
 * control character, which is what this is exported for.
 */
export const SUBSTITUTION_MARK = "\u0000";
const MARK = SUBSTITUTION_MARK;
const OPEN = `${MARK}(`;
const CLOSE = `${MARK})`;

/** Literal text, encoded so it can never spell a recorded substitution. */
export function asWrittenLiteral(text: string): string {
	return text.includes(MARK) ? text.replaceAll(MARK, MARK + MARK) : text;
}

/** One span a provider's expander really replaced, recorded as the substitution it is. */
export function asWrittenSubstitution(token: string): string {
	return `${OPEN}${asWrittenLiteral(token)}${CLOSE}`;
}

/**
 * `text` as written: every `pattern` match the expander replaced — the ones
 * `substituted` accepts — recorded as a substitution, and everything else,
 * matches included, as literal text. `pattern` must be global.
 */
export function asWrittenText(
	text: string,
	pattern: RegExp,
	substituted: (match: RegExpMatchArray) => boolean,
): string {
	const escaped = asWrittenLiteral(text);
	let out = "";
	let cursor = 0;
	for (const match of escaped.matchAll(pattern)) {
		const token = match[0];
		out += escaped.slice(cursor, match.index);
		cursor = match.index + token.length;
		out += substituted(match) ? `${OPEN}${token}${CLOSE}` : token;
	}
	return out + escaped.slice(cursor);
}

/**
 * Split a space-delimited list written in this encoding, keeping each
 * recorded substitution whole: the whitespace inside a `${VAR:-two words}`
 * default belongs to the declaration, not to the list.
 */
export function splitOutsideSubstitutions(text: string): string[] {
	const parts: string[] = [];
	let current = "";
	let depth = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (char === MARK && index + 1 < text.length) {
			const next = text[index + 1]!;
			if (next === "(" || next === ")" || next === MARK) {
				if (next === "(") depth++;
				else if (next === ")" && depth > 0) depth--;
				current += char + next;
				index++;
				continue;
			}
		}
		if (depth === 0 && /\s/.test(char)) {
			if (current.length > 0) parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current.length > 0) parts.push(current);
	return parts;
}
