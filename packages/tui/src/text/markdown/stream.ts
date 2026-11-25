/**
 * Source transforms for Markdown that is still arriving: what a renderer
 * should draw for a prefix of a document so later text only adds to it.
 */
import { mathSpanAt } from "@oh-my-pi/pi-utils/math-delimiters";

const FENCE_LINE = /^((?:[ \t]*>)*)([ \t]*)(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^(?:[ \t]*>)*([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\S/;

function columns(whitespace: string): number {
	let cells = 0;
	for (const char of whitespace) cells += char === "\t" ? 4 - (cells % 4) : 1;
	return cells;
}

/**
 * Whether the end of `text` lies inside an open code fence. Fences may sit up
 * to three columns past the content column of the list item they are in;
 * anywhere else four columns in is indented code, not a fence.
 */
export function endsInsideOpenFence(text: string): boolean {
	// A streaming answer is scanned every frame as it grows: resume from its last complete line.
	let state: FenceState = { open: undefined, listColumn: 0 };
	let from = 0;
	for (const memo of fenceMemos) {
		if (memo.prefix.length > from && text.length >= memo.prefix.length && text.startsWith(memo.prefix)) {
			state = memo.state;
			from = memo.prefix.length;
		}
	}
	const lastBreak = text.lastIndexOf("\n");
	if (lastBreak >= from) {
		state = scanFenceLines(text.slice(from, lastBreak), state);
		from = lastBreak + 1;
		fenceMemos.unshift({ prefix: text.slice(0, from), state });
		if (fenceMemos.length > FENCE_MEMOS) fenceMemos.pop();
	}
	return scanFenceLines(text.slice(from), state).open !== undefined;
}

/** Fence scanning state after some lines: the open fence, and the content column of the list item they are in. */
interface FenceState {
	readonly open: { readonly char: string; readonly length: number } | undefined;
	readonly listColumn: number;
}

/** The states of the last texts {@link endsInsideOpenFence} scanned, at their last line break. */
const fenceMemos: { readonly prefix: string; readonly state: FenceState }[] = [];
/** Texts remembered at once (an answer and its thinking stream side by side). */
const FENCE_MEMOS = 4;

/** `state` advanced over the lines of `chunk` (split on `\n`; a chunk without one is one line). */
function scanFenceLines(chunk: string, state: FenceState): FenceState {
	let { open, listColumn } = state;
	for (const line of chunk.split("\n")) {
		if (open) {
			const match = FENCE_LINE.exec(line);
			if (
				match &&
				match[3]![0] === open.char &&
				match[3]!.length >= open.length &&
				match[4]!.trim() === "" &&
				columns(match[2]!) - listColumn <= 3
			)
				open = undefined;
			continue;
		}
		if (line.trim() === "") continue;
		const item = LIST_ITEM.exec(line);
		if (item) {
			listColumn = columns(item[1]!) + item[2]!.length + columns(item[3]!);
		} else {
			const indent = columns(/^[ \t]*/.exec(line)![0]);
			if (indent < listColumn) listColumn = 0;
		}
		const match = FENCE_LINE.exec(line);
		if (!match) continue;
		const indent = columns(match[2]!);
		if (indent - listColumn > 3 || indent < 0) continue;
		if (match[3]![0] === "`" && match[4]!.includes("`")) continue;
		open = { char: match[3]![0]!, length: match[3]!.length };
	}
	return { open, listColumn };
}

/** Whether `line` holds an unescaped `|` (a table line needs no outer pipes). */
function hasPipe(line: string): boolean {
	return /(?:^|[^\\])\|/.test(line);
}

const DELIMITER_ROW =
	/^[ \t>]*(?:\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?)[ \t]*$/;

/**
 * `text` without the table row still being written at its end: a native
 * terminal lays out every row it gets, so a row is held back until its line
 * ends. Pipe lines that are no table yet (no delimiter row) or sit inside an
 * open fence are kept.
 */
export function holdPartialTableRow(text: string): string {
	const lineStart = text.lastIndexOf("\n") + 1;
	if (lineStart === 0) return text;
	const tail = text.slice(lineStart);
	// A line holding only indentation or quote markers so far may still become the next row.
	if (tail === "" || (!hasPipe(tail) && !/^[ \t>]+$/.test(tail))) return text;
	// Walk the complete lines above the partial one from the end: a table needs a
	// delimiter row with a pipe line directly above it, and every line between must be
	// pipe lines. Finding the line starts by hand keeps a streaming source from being
	// split (and copied) whole on every frame.
	let delimiter = false;
	let lineEnd = lineStart - 1;
	let above = "";
	while (lineEnd > 0) {
		const start = text.lastIndexOf("\n", lineEnd - 1) + 1;
		const line = text.slice(start, lineEnd);
		if (line.replace(/^[ \t>]*/, "") === "" || !hasPipe(line)) break;
		if (DELIMITER_ROW.test(line) && hasPipe(above)) {
			delimiter = true;
			break;
		}
		above = line;
		lineEnd = start - 1;
	}
	if (!delimiter || endsInsideOpenFence(text.slice(0, lineStart))) return text;
	return text.slice(0, lineStart);
}

/** Where the last block starts: after the last blank line. */
function lastBlockStart(text: string): number {
	const blank = /\n[ \t>]*\n/g;
	let start = 0;
	for (let match = blank.exec(text); match; match = blank.exec(text)) start = match.index + match[0].length;
	return start;
}

/** One past the matching `]` of the `[` at `open`, or -1. */
function labelEnd(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const char = text[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if (char === "[") depth++;
		else if (char === "]" && --depth === 0) return i + 1;
	}
	return -1;
}

interface OpenLink {
	readonly kind: "link";
	/** Unclosed `(` inside the destination plus the destination's own. */
	readonly depth: number;
}

interface OpenMath {
	readonly kind: "math";
	readonly opener: "$" | "$$" | "\\(";
	/** Offset of the body. */
	readonly body: number;
}

/** A link destination starting at `start` (after `(`): its end, or how many parens are open at the end of text. */
function destination(text: string, start: number): { end: number } | { open: number } | undefined {
	let depth = 1;
	for (let i = start; i < text.length; i++) {
		const char = text[i]!;
		if (/\s/.test(char) && i === start) return undefined;
		if (char === "\\") {
			i++;
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return { end: i + 1 };
		else if (/\s/.test(char)) {
			// A title may follow; whatever it is, the destination is written.
			const close = text.indexOf(")", i);
			return close === -1 ? undefined : { end: close + 1 };
		}
	}
	return { open: depth };
}

/** The span left open at the end of `block`, or undefined (also for open code spans and images). */
function openSpan(block: string): OpenLink | OpenMath | undefined {
	for (let i = 0; i < block.length;) {
		const char = block[i]!;
		if (char === "\\") {
			if (block[i + 1] === "(") {
				const span = mathSpanAt(block, i);
				if (span) {
					i = span.end;
					continue;
				}
				return { kind: "math", opener: "\\(", body: i + 2 };
			}
			i += 2;
			continue;
		}
		if (char === "`") {
			const run = /^`+/.exec(block.slice(i))![0];
			const close = block.indexOf(run, i + run.length);
			if (close === -1) return undefined;
			i = close + run.length;
			continue;
		}
		if (char === "$") {
			const span = mathSpanAt(block, i);
			if (span) {
				i = span.end;
				continue;
			}
			if (block[i + 1] === "$") return { kind: "math", opener: "$$", body: i + 2 };
			const next = block[i + 1];
			if (next !== undefined && !/[\s\d$]/.test(next)) return { kind: "math", opener: "$", body: i + 1 };
			i++;
			continue;
		}
		if (char === "[") {
			const image = block[i - 1] === "!";
			const end = labelEnd(block, i);
			if (end === -1) {
				i++;
				continue;
			}
			if (block[end] !== "(") {
				i = end;
				continue;
			}
			const dest = destination(block, end + 1);
			if (dest === undefined) {
				i = end;
				continue;
			}
			if ("end" in dest) {
				i = dest.end;
				continue;
			}
			return image ? undefined : { kind: "link", depth: dest.open };
		}
		i++;
	}
	return undefined;
}

/**
 * `text` with an open link or math span in its last block closed the way it
 * is heading: a link destination gets its `)`, math loses a dangling partial
 * command or `^`/`_`, gets its braces balanced and its closer. Currency,
 * escapes, images, code spans and anything inside an open fence stay literal.
 */
export function speculativeStreamingSource(text: string): string {
	if (endsInsideOpenFence(text)) return text;
	const start = lastBlockStart(text);
	const block = text.slice(start);
	const open = openSpan(block);
	if (!open) return text;
	if (open.kind === "link") return text + ")".repeat(open.depth);
	let body = block.slice(open.body);
	if (open.opener === "$$" && body.endsWith("$")) return `${text}$`;
	body = body.replace(/\\[A-Za-z]*$/, "").replace(/[\^_]+$/, "");
	if (body.trim() === "") return text;
	let braces = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "\\") i++;
		else if (body[i] === "{") braces++;
		else if (body[i] === "}") braces = Math.max(0, braces - 1);
	}
	const closer = open.opener === "\\(" ? "\\)" : open.opener;
	return text.slice(0, start + open.body) + body + "}".repeat(braces) + closer;
}

/**
 * The open cell of a streaming table's last row: its index while the row's
 * line is unterminated and not closed by a `|`, else -1.
 */
export function growingTableCell(raw: string): number {
	const lineStart = raw.lastIndexOf("\n") + 1;
	const line = raw.slice(lineStart);
	if (lineStart === 0 || line.trim() === "" || /(?:^|[^\\])\|[ \t]*$/.test(line)) return -1;
	const body = line.replace(/^[ \t>]*\|?/, "");
	let cells = 1;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "\\") i++;
		else if (body[i] === "|") cells++;
	}
	return cells - 1;
}

const ORPHAN_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HEADING_LINE = /^ {0,3}#{1,6}[ \t]+\S/;
const FENCED_SOURCE_INTRO = /\b(?:code|example|markdown|output|snippet|source)\s*:?\s*$/i;

/** Whether `line` is a GFM table delimiter row under `headerLine` (same cell count, `---` cells). */
function isTableDelimiter(line: string, headerLine: string | undefined): boolean {
	if (!headerLine) return false;
	const delimiterCells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	const headerCells = headerLine.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
	return (
		delimiterCells.length >= 2 &&
		headerCells.length === delimiterCells.length &&
		delimiterCells.every(cell => /^:?-{3,}:?$/.test(cell.trim())) &&
		headerCells.every(cell => cell.trim().length > 0)
	);
}

/**
 * A finished document without the bare closing fence some models (Gemini) emit
 * with no opener before going on with headings and tables: CommonMark reads
 * that lone fence as an opener and turns the rest of the report into one raw
 * code block. Only the unambiguous rich-document shape is repaired — one
 * unmatched bare fence after prose (not after an intro like `Example:`),
 * followed by both an ATX heading and a GFM table delimiter; incomplete code
 * blocks, fenced Markdown examples and matched fences stay untouched.
 */
export function repairOrphanClosingFence(text: string): string {
	const lines = text.split("\n");
	let open: { index: number; marker: string; info: string } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const match = ORPHAN_FENCE_LINE.exec(lines[index]!);
		if (!match) continue;
		const marker = match[1]!;
		const info = match[2]!.trim();
		if (!open) {
			open = { index, marker, info };
			continue;
		}
		if (marker[0] === open.marker[0] && marker.length >= open.marker.length && info === "") open = undefined;
	}
	if (open?.info !== "") return text;

	let previous = "";
	for (let index = open.index - 1; index >= 0; index--) {
		previous = lines[index]!.trim();
		if (previous) break;
	}
	if (!previous || previous.endsWith(":") || FENCED_SOURCE_INTRO.test(previous)) return text;

	let hasHeading = false;
	let hasTableDelimiter = false;
	for (let index = open.index + 1; index < lines.length; index++) {
		hasHeading ||= HEADING_LINE.test(lines[index]!);
		hasTableDelimiter ||= isTableDelimiter(lines[index]!, lines[index - 1]);
		if (hasHeading && hasTableDelimiter) {
			lines.splice(open.index, 1);
			return lines.join("\n");
		}
	}
	return text;
}
