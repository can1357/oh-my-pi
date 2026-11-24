/**
 * PTY output replayed on a headless terminal, read back as rows that keep
 * only the styles a transcript may show again (attributes and colors), so
 * cursor movement, `\r` progress lines and colors come out as a terminal
 * drew them.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { BufferCell, Terminal } from "@oh-my-pi/pi-utils/vterm";

const RESET = "\x1b[0m";
const SGR = /\x1b\[([0-9;]*)m/g;
/** Scrollback the replay keeps: bounds memory and the expanded view. */
const SCROLLBACK_ROWS = 4096;
/** Rows a streaming run reads back (its tail window). */
const STREAMING_ROWS = 100;

let vterm: Promise<typeof Terminal> | undefined;

/** The headless terminal, loaded on the first replay so startup never evaluates it. */
function loadTerminal(): Promise<typeof Terminal> {
	vterm ??= import("@oh-my-pi/pi-utils/vterm").then(module => module.Terminal);
	return vterm;
}

function colorCodes(codes: number[], cell: BufferCell, foreground: boolean): void {
	const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
	const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
	if (!rgb && !palette) return;
	const color = foreground ? cell.getFgColor() : cell.getBgColor();
	codes.push(foreground ? 38 : 48);
	if (rgb) codes.push(2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
	else codes.push(5, color);
}

/** The SGR re-establishing a cell's style ("" when plain). */
function cellSgr(cell: BufferCell): string {
	const codes: number[] = [];
	if (cell.isBold() !== 0) codes.push(1);
	if (cell.isDim() !== 0) codes.push(2);
	if (cell.isItalic() !== 0) codes.push(3);
	if (cell.isUnderline() !== 0) codes.push(4);
	if (cell.isInverse() !== 0) codes.push(7);
	if (cell.isStrikethrough() !== 0) codes.push(9);
	if (cell.isOverline() !== 0) codes.push(53);
	colorCodes(codes, cell, true);
	colorCodes(codes, cell, false);
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/** Whether SGR parameters only set attributes and colors (nothing a row could misuse). */
function safeSgr(codes: readonly number[]): boolean {
	let i = 0;
	while (i < codes.length) {
		const code = codes[i++];
		if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7 || code === 9 || code === 53) continue;
		if (code !== 38 && code !== 48) return false;
		const mode = codes[i++];
		if (mode === 5) {
			const color = codes[i++];
			if (color === undefined || color < 0 || color > 255) return false;
			continue;
		}
		if (mode !== 2) return false;
		for (let channel = 0; channel < 3; channel++) {
			const color = codes[i++];
			if (color === undefined || color < 0 || color > 255) return false;
		}
	}
	return true;
}

/** A replayed row on `base` (the output color): resets fall back to it, unsafe styles drop. */
export function styleReplayedRow(row: string, base: string): string {
	let out = base;
	let offset = 0;
	let hasText = false;
	for (const match of row.matchAll(SGR)) {
		const at = match.index ?? 0;
		const text = sanitizeText(row.slice(offset, at));
		out += text;
		hasText ||= text.length > 0;
		const codes = match[1]!.split(";").map(Number);
		if (match[1] === "0") out += `${RESET}${base}`;
		else if (codes.length > 0 && codes.every(Number.isInteger) && safeSgr(codes)) out += match[0];
		offset = at + match[0].length;
	}
	const text = sanitizeText(row.slice(offset));
	out += text;
	hasText ||= text.length > 0;
	return hasText ? `${out}${RESET}` : "";
}

/** `terminal`'s rows `[start, end)` as styled text, trailing blanks dropped per row. */
function readRows(terminal: Terminal, start: number, end: number): string[] {
	const buffer = terminal.buffer.active;
	const cell = buffer.getNullCell();
	const rows: string[] = [];
	for (let index = start; index < end; index++) {
		const line = buffer.getLine(index);
		if (!line) {
			rows.push("");
			continue;
		}
		const cells: { chars: string; sgr: string }[] = [];
		let last = -1;
		for (let column = 0; column < line.length;) {
			const at = line.getCell(column, cell);
			if (!at) break;
			const chars = at.getChars();
			cells.push({ chars: chars || " ", sgr: cellSgr(at) });
			if (chars && chars !== " ") last = cells.length - 1;
			column += Math.max(1, at.getWidth());
		}
		let rendered = "";
		let style: string | undefined;
		for (let i = 0; i <= last; i++) {
			const entry = cells[i]!;
			if (entry.sgr !== style) {
				rendered += `${RESET}${entry.sgr}`;
				style = entry.sgr;
			}
			rendered += entry.chars;
		}
		rows.push(rendered);
	}
	return rows;
}

/**
 * A PTY's bytes on a headless terminal. The terminal loads with the first
 * write; until then the replay reads as a blank screen.
 */
export class PtyReplay {
	#terminal: Terminal | undefined;
	readonly #ready: Promise<Terminal | undefined>;
	#cols: number;
	#rows: number;
	#disposed = false;

	constructor(viewport: { readonly cols: number; readonly rows: number }) {
		this.#cols = viewport.cols;
		this.#rows = viewport.rows;
		this.#ready = loadTerminal().then(Terminal => {
			if (this.#disposed) return undefined;
			this.#terminal = new Terminal({
				cols: this.#cols,
				rows: this.#rows,
				disableStdin: true,
				allowProposedApi: true,
				scrollback: SCROLLBACK_ROWS,
			});
			return this.#terminal;
		});
	}

	/** Feed bytes; resolves once they are applied (writes apply in call order). */
	async write(chunk: string): Promise<void> {
		const terminal = await this.#ready;
		if (!terminal || this.#disposed) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		terminal.write(chunk, resolve);
		return promise;
	}

	/** The screen and scrollback as rows (`full`), or the streaming tail, trailing blank rows dropped. */
	rows(full: boolean): string[] {
		const terminal = this.#terminal;
		if (!terminal) return [];
		const buffer = terminal.buffer.active;
		const rows = readRows(terminal, full ? 0 : Math.max(0, buffer.length - STREAMING_ROWS), buffer.length);
		while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
		return rows;
	}

	/** The visible screen (the viewport's rows, top to bottom; blank rows kept). */
	screen(): string[] {
		const terminal = this.#terminal;
		if (!terminal) return Array.from({ length: this.#rows }, () => "");
		const buffer = terminal.buffer.active;
		return readRows(terminal, buffer.viewportY, buffer.viewportY + terminal.rows);
	}

	/** Resize the screen (a live console follows its pane). */
	resize(cols: number, rows: number): void {
		if (cols === this.#cols && rows === this.#rows) return;
		this.#cols = cols;
		this.#rows = rows;
		this.#terminal?.resize(cols, rows);
	}

	/** Whether the cursor sits after text on its row, where a line prompt leaves it. */
	cursorAfterText(): boolean {
		return (this.#terminal?.buffer.active.cursorX ?? 0) > 0;
	}

	/** Whether the program switched the cursor keys to application mode (`DECCKM`). */
	applicationCursorKeys(): boolean {
		return this.#terminal?.modes.applicationCursorKeysMode ?? false;
	}

	dispose(): void {
		this.#disposed = true;
		this.#terminal?.dispose();
		this.#terminal = undefined;
	}
}
