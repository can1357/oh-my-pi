import { maskNonProse } from "./markdown-prose";

/**
 * Client-side gates shared by the prose assistants (macOS typo/autocorrect and
 * word completion): only plain prose words in modest buffers are ever sent to
 * a spelling or prediction backend.
 */

const CODEISH_CHARACTERS = "\\/@_=:{}[]<>";
const CAMEL_CASE = /\p{Ll}\p{Lu}/u;
/** Buffers above this many UTF-16 units get no prose assistance at all. */
const MAX_PROSE_BUFFER_LENGTH = 20_000;
/** Lines above this many UTF-16 units get no prose assistance at all. */
const MAX_PROSE_LINE_LENGTH = 1_000;

/** Logical source location for one rendered editor segment. */
export interface SpellingDecorationContext {
	editorText: string;
	lines: readonly string[];
	line: number;
	startCol: number;
}

function tokenAt(text: string, start: number, end: number): string {
	let tokenStart = start;
	while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) tokenStart--;
	let tokenEnd = end;
	while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) tokenEnd++;
	return text.slice(tokenStart, tokenEnd);
}

/**
 * Whether `text[start, end)` is a prose word: unmasked by {@link maskNonProse},
 * not inside a path/identifier-like token, and not on a slash-command or
 * queue-shorthand line.
 */
export function isProseWord(text: string, masked: string, start: number, end: number): boolean {
	if (start < 0 || end <= start || end > text.length) return false;
	if (masked.slice(start, end).trim().length === 0) return false;
	const token = tokenAt(text, start, end);
	for (const char of token) {
		if (CODEISH_CHARACTERS.includes(char)) return false;
	}
	if (CAMEL_CASE.test(token) || /\d/.test(token)) return false;
	return !text.trimStart().startsWith("/") && !text.startsWith("->") && !text.startsWith("=>");
}

/** Whole-buffer context for `line`, starting at column 0. */
export function lineContext(lines: readonly string[], line: number): SpellingDecorationContext {
	return { editorText: lines.join("\n"), lines, line, startCol: 0 };
}

/**
 * Memoized whole-buffer prose mask: answers whether a line range is prose in
 * the context of the full editor text (fenced code spans lines).
 */
export class ProseSource {
	#text = "";
	#mask = "";
	#lineOffsets: number[] = [];

	/** True when `[startCol, endCol)` of `context.line` is prose and the buffer is within the caps. */
	isProse(context: SpellingDecorationContext, startCol: number, endCol: number): boolean {
		if (context.editorText.length > MAX_PROSE_BUFFER_LENGTH || startCol < 0 || endCol <= startCol) {
			return false;
		}
		const line = context.lines[context.line];
		if (line === undefined || line.length > MAX_PROSE_LINE_LENGTH || endCol > line.length) return false;
		this.#prepare(context);
		const lineOffset = this.#lineOffsets[context.line];
		if (lineOffset === undefined) return false;
		return this.#mask.slice(lineOffset + startCol, lineOffset + endCol).trim().length > 0;
	}

	#prepare(context: SpellingDecorationContext): void {
		if (this.#text === context.editorText) return;
		this.#text = context.editorText;
		this.#mask = maskNonProse(context.editorText);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		this.#lineOffsets = new Array<number>(context.lines.length);
		let offset = 0;
		for (let line = 0; line < context.lines.length; line++) {
			this.#lineOffsets[line] = offset;
			offset += (context.lines[line]?.length ?? 0) + 1;
		}
	}
}
