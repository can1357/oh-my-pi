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
 * a pass wrote.
 *
 * Both halves run on the *parsed* value — the string the connection really
 * carries — never on the config file's text, and that is what makes the last
 * sentence true. A file can spell one U+0000 as `\u0000`, as `\x00` or as
 * the character itself; an escaper working on the text sees three different
 * things where the parser sees one, and misses two of them. On the parsed
 * value there is nothing left to spell: a literal can never hash as the
 * substitution it spells, whatever escape the config file used to write it.
 * A provider whose substitution grammar exists only over the text —
 * OpenCode's — recognises its references there and hands the spans it
 * replaced to this encoding afterwards; see `discovery/opencode.ts`.
 *
 * These values exist only to be hashed. Nothing reads them back and nothing
 * reaches a transport from them.
 */

import * as path from "node:path";

const MARK = "\u0000";
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

/** The index just past the `\0)` that closes the marker opening at `start`. */
function markerEnd(text: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < text.length) {
		if (text[index] === MARK) {
			const next = text[index + 1];
			if (next === MARK) {
				index += 2;
				continue;
			}
			if (next === "(" || next === ")") {
				depth += next === "(" ? 1 : -1;
				index += 2;
				if (depth === 0) return index;
				continue;
			}
		}
		index++;
	}
	return index;
}

/**
 * `written` resolved against `base` as a filesystem path, with every
 * recorded substitution held out of the resolution.
 *
 * A provider that rooted a relative `command`/`cwd` roots the written form
 * against the same base (`withMcpAsWritten` in `discovery/helpers.ts`), and
 * `path.resolve` is what rooting means — but it
 * is also path *normalisation*, and a declaration is not a path. A `..`
 * inside `${TAG:-a/../../b}` contributes nothing to the value the connection
 * uses, because that default is unused; normalising the record anyway ate
 * the directories above it and left two projects' records identical. So each
 * marked span, and each literal U+0000, is held out behind a placeholder
 * that is a single ordinary path component — no separator, no `.` — and put
 * back after the resolve. Literal `..` *outside* a declaration still acts
 * there, exactly as it acts in the effective value.
 */
export function resolveAsWrittenPath(base: string, written: string): string {
	if (!written.includes(MARK)) return path.resolve(base, written);
	const held: string[] = [];
	let masked = "";
	let index = 0;
	while (index < written.length) {
		if (written[index] !== MARK) {
			masked += written[index];
			index++;
			continue;
		}
		const next = written[index + 1];
		const end = next === "(" ? markerEnd(written, index) : index + (next === MARK ? 2 : 1);
		masked += `${MARK}${held.length}${MARK}`;
		held.push(written.slice(index, end));
		index = end;
	}
	return path
		.resolve(base, masked)
		.replaceAll(/\u0000(\d+)\u0000/g, (whole, slot: string) => held[Number(slot)] ?? whole);
}
