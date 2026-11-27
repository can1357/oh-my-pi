/**
 * `ansi`: raw terminal output (a command's stdout) as rows.
 *
 * The text is replayed on a small line screen first, so what a terminal
 * would show is what the rows show: `\r` returns to the line start and later
 * text overwrites it (progress bars), `\b` steps back, `CSI K` erases, cursor
 * moves (`CSI A/B/C/D/G/E/F`) address earlier lines. SGR and OSC 8 links are
 * kept per cell; other controls are dropped.
 *
 * Collapsed, `preview.lines` clamps the rows (the tail when `follow`), with a
 * dim count of the rows left out. Text: one line per output line (what a
 * clamp keeps of it); the count row is not.
 */
import type { TspAnsiProps } from "@oh-my-pi/pi-wire";
import { escapeLength, SgrState, sgrParams } from "../../text/ansi";
import { replaceTabs, visibleWidth, wrap } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type PaintContext } from "../paint";
import { lazyText, mapWrappedText, type RenderedText, sliceRenderedText } from "../text-layout";

interface ScreenCell {
	readonly ch: string;
	/** SGR re-establishing the cell's style ("" when plain). */
	readonly style: string;
	/** OSC 8 target ("" when none). */
	readonly link: string;
	/** Cells the character covers (0 for the trailing half of a wide character). */
	readonly width: number;
}

const BLANK: ScreenCell = { ch: " ", style: "", link: "", width: 1 };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Whether the text needs the line screen (anything beyond SGR, OSC 8 and newlines). */
function needsScreen(text: string): boolean {
	if (text.includes("\r") || text.includes("\b")) return true;
	for (let i = text.indexOf("\x1b"); i !== -1; i = text.indexOf("\x1b", i + 1)) {
		const length = escapeLength(text, i);
		if (length === 0) continue;
		const sequence = text.slice(i, i + length);
		if (sgrParams(sequence) !== undefined || sequence.startsWith("\x1b]8;")) continue;
		return true;
	}
	return false;
}

/** OSC 8 target of a hyperlink sequence ("" closes the link). */
function linkTarget(sequence: string): string {
	const body = sequence.slice(4).replace(/\x07$|\x1b\\$/, "");
	const semi = body.indexOf(";");
	return semi === -1 ? "" : body.slice(semi + 1);
}

/**
 * The lines `text` leaves on a terminal: overwrites, erases and cursor moves
 * applied, styles kept. Trailing blanks of each line are dropped.
 */
export function ansiLines(text: string): string[] {
	const source = replaceTabs(text.replace(/\r\n/g, "\n"));
	if (!needsScreen(source)) return source.split("\n");
	const lines: ScreenCell[][] = [[]];
	let row = 0;
	let col = 0;
	const sgr = new SgrState();
	let style = "";
	let link = "";
	const line = (): ScreenCell[] => {
		while (lines.length <= row) lines.push([]);
		return lines[row]!;
	};
	const put = (ch: string): void => {
		const cells = line();
		const width = Math.max(0, visibleWidth(ch));
		if (width === 0) {
			const prev = cells[col - 1];
			if (prev) cells[col - 1] = { ...prev, ch: prev.ch + ch };
			return;
		}
		while (cells.length < col) cells.push(BLANK);
		// Overwriting half of a wide character blanks its other half.
		if (cells[col]?.width === 0 && col > 0) cells[col - 1] = BLANK;
		if (cells[col + width - 1]?.width === 2 || cells[col + width]?.width === 0) {
			for (let i = col + width; cells[i]?.width === 0; i++) cells[i] = BLANK;
		}
		cells[col] = { ch, style, link, width };
		for (let i = 1; i < width; i++) cells[col + i] = { ch: "", style, link, width: 0 };
		col += width;
	};
	const csi = (sequence: string): void => {
		const final = sequence[sequence.length - 1]!;
		const params = sequence.slice(2, -1);
		const n = Number.parseInt(params, 10);
		const count = Number.isNaN(n) || n === 0 ? 1 : n;
		const cells = line();
		switch (final) {
			case "K": {
				const mode = Number.isNaN(n) ? 0 : n;
				if (mode === 0) cells.length = Math.min(cells.length, col);
				else if (mode === 1) for (let i = 0; i <= col && i < cells.length; i++) cells[i] = BLANK;
				else cells.length = 0;
				break;
			}
			case "J":
				if ((Number.isNaN(n) ? 0 : n) === 0) {
					cells.length = Math.min(cells.length, col);
					lines.length = row + 1;
				}
				break;
			case "A":
				row = Math.max(0, row - count);
				break;
			case "B":
				row += count;
				break;
			case "C":
				col += count;
				break;
			case "D":
				col = Math.max(0, col - count);
				break;
			case "G":
				col = count - 1;
				break;
			case "E":
				row += count;
				col = 0;
				break;
			case "F":
				row = Math.max(0, row - count);
				col = 0;
				break;
		}
	};
	let i = 0;
	while (i < source.length) {
		const code = source.charCodeAt(i);
		if (code === 0x1b) {
			const length = escapeLength(source, i);
			if (length > 0) {
				const sequence = source.slice(i, i + length);
				const params = sgrParams(sequence);
				if (params !== undefined) {
					sgr.apply(params);
					style = sgr.open();
				} else if (sequence.startsWith("\x1b]8;")) link = linkTarget(sequence);
				else if (sequence.startsWith("\x1b[")) csi(sequence);
				i += length;
				continue;
			}
		}
		if (source[i] === "\n") {
			row++;
			col = 0;
			line();
			i++;
			continue;
		}
		if (source[i] === "\r") {
			col = 0;
			i++;
			continue;
		}
		if (source[i] === "\b") {
			col = Math.max(0, col - 1);
			i++;
			continue;
		}
		if (code < 0x20 || code === 0x7f) {
			i++;
			continue;
		}
		let end = source.indexOf("\x1b", i);
		for (const stop of ["\n", "\r", "\b"]) {
			const at = source.indexOf(stop, i);
			if (at !== -1 && (end === -1 || at < end)) end = at;
		}
		const run = source.slice(i, end === -1 ? source.length : end);
		for (const { segment } of segmenter.segment(run)) {
			const c = segment.charCodeAt(0);
			if (c < 0x20 || c === 0x7f) continue;
			put(segment);
		}
		i += run.length;
	}
	return lines.map(serialize);
}

/** A screen line as styled text. */
function serialize(cells: readonly ScreenCell[]): string {
	let end = cells.length;
	while (end > 0 && cells[end - 1] === BLANK) end--;
	let out = "";
	let style = "";
	let link = "";
	for (let i = 0; i < end; i++) {
		const cell = cells[i]!;
		if (cell.width === 0) continue;
		if (cell.style !== style) {
			out += `\x1b[0m${cell.style}`;
			style = cell.style;
		}
		if (cell.link !== link) {
			out += `\x1b]8;;${cell.link}\x1b\\`;
			link = cell.link;
		}
		out += cell.ch;
	}
	if (link) out += "\x1b]8;;\x1b\\";
	if (style) out += "\x1b[0m";
	return out;
}

/** What a collapsed `ansi` node shows of `rows` (`text` their text), by its preview. */
function clamp(rows: string[], text: () => RenderedText, props: TspAnsiProps, cx: PaintContext): Block {
	const preview = props.preview;
	if (preview === undefined || preview === "auto" || rows.length <= preview.lines) return { rows, text };
	const hidden = rows.length - preview.lines;
	const note = cx.theme.fg("dim", `… ${hidden} more lines`);
	if (props.follow) {
		const kept = rows.slice(-preview.lines);
		const from = rows.length - kept.length;
		return {
			rows: [note, ...kept],
			text: lazyText(() => [undefined, ...sliceRenderedText(text(), from, rows.length)]),
		};
	}
	return {
		rows: [...rows.slice(0, preview.lines), note],
		text: lazyText(() => [...sliceRenderedText(text(), 0, preview.lines), undefined]),
	};
}

function paintAnsi(node: { props(): unknown }, cx: PaintContext): Block {
	const props = node.props() as TspAnsiProps;
	const text = props.text ?? "";
	if (text === "") return EMPTY_BLOCK;
	const lines = ansiLines(text.replace(/\n+$/, ""));
	const rows: string[] = [];
	for (const line of lines) rows.push(...(line === "" ? [""] : wrap(line, cx.width)));
	return clamp(
		rows,
		lazyText(() => mapWrappedText(lines.join("\n"), rows)),
		props,
		cx,
	);
}

definePainter("ansi", paintAnsi);
