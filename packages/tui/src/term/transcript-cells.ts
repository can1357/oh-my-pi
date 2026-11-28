/** A painted transcript row as clipboard/search text; offsets are UTF-16, columns are terminal cells. */
import { holdsImage } from "../driver/images/anchor";
import { KITTY_PLACEHOLDER } from "../driver/images/kitty";
import { sgrParams, SgrState, stripEscapes, tokens } from "../text/ansi";
import { pieces, visibleWidth } from "../text/width";

interface TranscriptCell {
	readonly start: number;
	readonly end: number;
	readonly col: number;
	readonly width: number;
}

export interface TranscriptLine {
	readonly text: string;
	readonly cells: readonly TranscriptCell[];
}

/** Graphics contain no selectable text. OSC 66, unlike other graphics, carries visible glyphs. */
export function isTranscriptImage(row: string): boolean {
	return row.includes(KITTY_PLACEHOLDER) || (holdsImage(row) && !row.includes("\x1b]66;"));
}

/** Visible text only: most search indexing and multi-line copies never need a cell map. */
export function plainTranscriptText(row: string): string {
	if (isTranscriptImage(row)) return "";
	return row.includes("\x1b]66;") ? transcriptLine(row).text : stripEscapes(row);
}

/** Payload of an OSC 66 group; the whole group has one declared cell span. */
function sizedPayload(span: string): string {
	return span.slice(span.indexOf(";", 5) + 1, span.endsWith("\x07") ? -1 : -2);
}

export function transcriptLine(row: string): TranscriptLine {
	let text = "";
	let col = 0;
	const cells: TranscriptCell[] = [];
	const append = (run: string): void => {
		// Segment the visible text, not the SGR runs: a style boundary can even fall inside a grapheme.
		for (const piece of pieces(run)) {
			const start = text.length;
			text += piece.text;
			cells.push({ start, end: text.length, col, width: piece.width });
			col += piece.width;
		}
	};
	if (isTranscriptImage(row)) return { text, cells };
	if (!row.includes("\x1b]66;")) append(stripEscapes(row));
	else {
		let run = "";
		for (const token of tokens(row)) {
			if (!token.escape) run += token.text;
			else if (token.text.startsWith("\x1b]66;")) {
				append(run);
				run = "";
				const start = text.length;
				text += sizedPayload(token.text);
				const width = visibleWidth(token.text);
				cells.push({ start, end: text.length, col, width });
				col += width;
			}
		}
		append(run);
	}
	return { text, cells };
}

/** Style every grapheme intersecting [start,end), retaining the original control sequences and SGR state. */
export function styleTranscriptCells(row: string, start: number, end: number, style: (text: string) => string): string {
	if (end <= start) return row;
	const { cells } = transcriptLine(row);
	const left = cells.find(cell => cell.col + cell.width > start);
	const right = cells.findLast(cell => cell.col < end);
	if (!left || !right || left.start >= right.end) return row;
	const sgr = new SgrState();
	let out = "";
	let offset = 0;
	for (const token of tokens(row)) {
		const sized = token.escape && token.text.startsWith("\x1b]66;");
		if (token.escape && !sized) {
			out += token.text;
			const params = sgrParams(token.text);
			if (params !== undefined) sgr.apply(params);
			continue;
		}
		const length = sized ? sizedPayload(token.text).length : token.text.length;
		const from = Math.max(0, left.start - offset);
		const to = Math.min(length, right.end - offset);
		offset += length;
		if (from >= to) out += token.text;
		else if (sized) out += style(token.text) + sgr.open();
		else out += token.text.slice(0, from) + style(token.text.slice(from, to)) + sgr.open() + token.text.slice(to);
	}
	return out;
}
