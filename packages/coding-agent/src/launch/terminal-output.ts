import { logger } from "@oh-my-pi/pi-utils";
import xterm, { type Terminal as XtermTerminal } from "@oh-my-pi/pi-utils/vterm";
import { DAEMON_PTY_COLUMNS, DAEMON_PTY_ROWS } from "../daemon/protocol";

const VIRTUAL_SCROLLBACK_ROWS = 4_096;

/** Controls which virtual terminal rows a launch log exposes. */
export interface TerminalOutputOptions {
	head: boolean;
	maxRows: number;
}

type XtermCell = NonNullable<ReturnType<XtermTerminal["buffer"]["active"]["getNullCell"]>>;

/** SGR of a cell's foreground or background: 24-bit, palette, or none (the default color). */
function colorCodes(cell: XtermCell, foreground: boolean): number[] {
	const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
	const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
	if (!rgb && !palette) return [];
	const color = foreground ? cell.getFgColor() : cell.getBgColor();
	const base = foreground ? 38 : 48;
	return rgb ? [base, 2, (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff] : [base, 5, color];
}

/** The SGR sequence that draws `cell`'s attributes and colors ("" for a plain cell). */
function cellStyle(cell: XtermCell): string {
	const codes: number[] = [];
	if (cell.isBold()) codes.push(1);
	if (cell.isDim()) codes.push(2);
	if (cell.isItalic()) codes.push(3);
	if (cell.isUnderline()) codes.push(4);
	if (cell.isInverse()) codes.push(7);
	if (cell.isStrikethrough()) codes.push(9);
	if (cell.isOverline()) codes.push(53);
	codes.push(...colorCodes(cell, true), ...colorCodes(cell, false));
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/** The screen and scrollback rows as styled text, trailing blank cells dropped. */
function readTerminalRows(terminal: XtermTerminal): string[] {
	const buffer = terminal.buffer.active;
	const cell = buffer.getNullCell();
	const rows: string[] = [];
	for (let row = 0; row < buffer.length; row++) {
		const line = buffer.getLine(row);
		let rendered = "";
		let pending = "";
		let style: string | undefined;
		for (let column = 0; line && column < line.length;) {
			if (!line.getCell(column, cell)) break;
			const chars = cell.getChars() || " ";
			const next = cellStyle(cell);
			if (next !== style) {
				pending += `\x1b[0m${next}`;
				style = next;
			}
			pending += chars;
			if (chars !== " ") {
				rendered += pending;
				pending = "";
			}
			column += Math.max(1, cell.getWidth());
		}
		rows.push(rendered);
	}
	return rows;
}

function writeTerminal(terminal: XtermTerminal, output: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write(output, resolve);
	return promise;
}

/** Replays daemon bytes with the same xterm screen renderer used by PTY mode. */
export async function renderTerminalOutput(
	output: string,
	options: TerminalOutputOptions,
): Promise<string[] | undefined> {
	if (!output) return [];
	const maxRows = Math.max(1, Math.floor(options.maxRows));
	const terminal = new xterm.Terminal({
		cols: DAEMON_PTY_COLUMNS,
		rows: DAEMON_PTY_ROWS,
		scrollback: Math.max(VIRTUAL_SCROLLBACK_ROWS, maxRows),
		allowProposedApi: true,
	});
	try {
		await writeTerminal(terminal, output);
		const rows = readTerminalRows(terminal);
		while (rows.at(-1) === "") rows.pop();
		return options.head ? rows.slice(0, maxRows) : rows.slice(-maxRows);
	} catch (error) {
		logger.debug("Failed to render launch terminal output", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	} finally {
		terminal.dispose();
	}
}
