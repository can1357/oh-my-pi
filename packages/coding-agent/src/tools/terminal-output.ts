import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";

const RESET = "\x1b[0m";
const SGR = /\x1b\[([0-9;]*)m/g;

interface TerminalCell {
	getChars(): string;
	getWidth(): number;
	getFgColor(): number;
	getBgColor(): number;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isInverse(): number;
	isStrikethrough(): number;
	isOverline(): number;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
}

function addColor(codes: number[], cell: TerminalCell, foreground: boolean): void {
	const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
	const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
	if (!rgb && !palette) return;

	const color = foreground ? cell.getFgColor() : cell.getBgColor();
	codes.push(foreground ? 38 : 48);
	if (rgb) {
		codes.push(2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
	} else {
		codes.push(5, color);
	}
}

function cellStyle(cell: TerminalCell): string {
	const codes: number[] = [];
	if (cell.isBold() !== 0) codes.push(1);
	if (cell.isDim() !== 0) codes.push(2);
	if (cell.isItalic() !== 0) codes.push(3);
	if (cell.isUnderline() !== 0) codes.push(4);
	if (cell.isInverse() !== 0) codes.push(7);
	if (cell.isStrikethrough() !== 0) codes.push(9);
	if (cell.isOverline() !== 0) codes.push(53);
	addColor(codes, cell, true);
	addColor(codes, cell, false);
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

function isSafeStyle(codes: readonly number[]): boolean {
	let index = 0;
	while (index < codes.length) {
		const code = codes[index++];
		if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7 || code === 9 || code === 53) continue;
		if (code !== 38 && code !== 48) return false;
		const mode = codes[index++];
		if (mode === 5) {
			const color = codes[index++];
			if (color === undefined || color < 0 || color > 255) return false;
			continue;
		}
		if (mode !== 2) return false;
		for (let channel = 0; channel < 3; channel++) {
			const color = codes[index++];
			if (color === undefined || color < 0 || color > 255) return false;
		}
	}
	return true;
}

/** Applies the active tool-output color while preserving safe styles from a virtual terminal row. */
export function styleTerminalRow(row: string, baseForeground: string): string {
	let output = baseForeground;
	let offset = 0;
	let hasText = false;
	for (const match of row.matchAll(SGR)) {
		const index = match.index ?? 0;
		const text = sanitizeText(row.slice(offset, index));
		output += text;
		hasText ||= text.length > 0;

		const codes = match[1].split(";").map(Number);
		if (match[1] === "0") output += `${RESET}${baseForeground}`;
		else if (codes.length > 0 && codes.every(Number.isInteger) && isSafeStyle(codes)) output += match[0];
		offset = index + match[0].length;
	}
	const text = sanitizeText(row.slice(offset));
	output += text;
	hasText ||= text.length > 0;
	return hasText ? `${output}${RESET}` : "";
}

/** Reads terminal screen rows as sanitized text plus only the styles the TUI may replay. */
export function readTerminalRows(terminal: XtermTerminal, startRow: number, rowCount: number): string[] {
	const buffer = terminal.buffer.active;
	const reusableCell = buffer.getNullCell();
	const rows: string[] = [];
	const endRow = Math.min(buffer.length, Math.max(0, startRow) + Math.max(0, rowCount));

	for (let row = Math.max(0, startRow); row < endRow; row++) {
		const line = buffer.getLine(row);
		if (!line) {
			rows.push("");
			continue;
		}

		const cells: Array<{ chars: string; style: string }> = [];
		let lastContent = -1;
		for (let column = 0; column < line.length;) {
			const cell = line.getCell(column, reusableCell);
			if (!cell) break;
			const chars = cell.getChars();
			const width = Math.max(1, cell.getWidth());
			cells.push({ chars: chars || " ", style: cellStyle(cell) });
			if (chars && chars !== " ") lastContent = cells.length - 1;
			column += width;
		}

		if (lastContent < 0) {
			rows.push("");
			continue;
		}

		let rendered = "";
		let previousStyle: string | undefined;
		for (let index = 0; index <= lastContent; index++) {
			const cell = cells[index]!;
			if (cell.style !== previousStyle) {
				rendered += `${RESET}${cell.style}`;
				previousStyle = cell.style;
			}
			rendered += cell.chars;
		}
		rows.push(rendered);
	}

	return rows;
}
