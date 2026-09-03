import {
	BufferLine,
	type BufferState,
	BufferView,
	blankCell,
	type CellAttributes,
	type CellData,
	defaultAttributes,
} from "./buffer";

const segmenter = new Intl.Segmenter();

/** Construction options supported by the headless virtual terminal. */
export interface TerminalOptions {
	cols?: number;
	rows?: number;
	scrollback?: number;
	allowProposedApi?: boolean;
	disableStdin?: boolean;
}

/** Disposable event subscription. */
export interface Disposable {
	dispose(): void;
}

/** Observable terminal modes used by interactive input normalization. */
export interface TerminalModes {
	applicationCursorKeysMode: boolean;
}

/** Buffer collection exposed by the virtual terminal. */
export interface TerminalBuffers {
	readonly active: BufferView;
	readonly normal: BufferView;
	readonly alternate: BufferView;
}

interface SavedCursor {
	x: number;
	y: number;
	attrs: CellAttributes;
}

function createState(columns: number, rows: number): BufferState {
	return {
		lines: Array.from({ length: rows }, () => new BufferLine(columns)),
		baseY: 0,
		viewportY: 0,
		cursorX: 0,
		cursorY: 0,
	};
}

function cloneCell(cell: CellData): CellData {
	return { chars: cell.chars, width: cell.width, attrs: { ...cell.attrs } };
}

/** Behavior-compatible reimplementation of @xterm/headless's used surface. */
export class Terminal {
	/** Current terminal column count. */
	cols: number;
	/** Current terminal row count. */
	rows: number;
	/** Normal, alternate, and active buffer views. */
	readonly buffer: TerminalBuffers;
	/** Currently active input modes. */
	readonly modes: TerminalModes = { applicationCursorKeysMode: false };

	#scrollback: number;
	#normal: BufferState;
	#alternate: BufferState;
	#active: BufferState;
	#usingAlternate = false;
	#attrs = defaultAttributes();
	#scrollTop = 0;
	#scrollBottom: number;
	#originMode = false;
	#autowrap = true;
	#insertMode = false;
	#pendingWrap = false;
	#saved: SavedCursor | undefined;
	#alternateSaved: SavedCursor | undefined;
	#state: "ground" | "escape" | "csi" | "string" = "ground";
	#sequence = "";
	#stringEscape = false;
	#decoder = new TextDecoder();
	#dataListeners = new Set<(data: string) => void>();
	#disposed = false;

	constructor(options: TerminalOptions = {}) {
		this.cols = Math.max(2, Math.floor(options.cols ?? 80));
		this.rows = Math.max(1, Math.floor(options.rows ?? 24));
		this.#scrollback = Math.max(0, Math.floor(options.scrollback ?? 1_000));
		this.#scrollBottom = this.rows - 1;
		this.#normal = createState(this.cols, this.rows);
		this.#alternate = createState(this.cols, this.rows);
		this.#active = this.#normal;
		const normal = new BufferView(() => this.#normal);
		const alternate = new BufferView(() => this.#alternate);
		const thisTerminal = this;
		this.buffer = {
			get active() {
				return thisTerminal.#usingAlternate ? alternate : normal;
			},
			normal,
			alternate,
		};
	}

	/** Parses terminal output and invokes the callback after the write is committed. */
	write(data: string | Uint8Array, callback?: () => void): void {
		if (this.#disposed) return;
		const text = typeof data === "string" ? data : this.#decoder.decode(data, { stream: true });
		this.#parse(text);
		if (callback) queueMicrotask(callback);
	}

	/** Changes the terminal grid and reflows wrapped normal-buffer lines. */
	resize(columns: number, rows: number): void {
		if (this.#disposed) return;
		const nextColumns = Math.max(2, Math.floor(columns));
		const nextRows = Math.max(1, Math.floor(rows));
		if (nextColumns === this.cols && nextRows === this.rows) return;
		this.#normal = this.#reflow(this.#normal, nextColumns, nextRows, true);
		this.#alternate = this.#reflow(this.#alternate, nextColumns, nextRows, false);
		this.cols = nextColumns;
		this.rows = nextRows;
		this.#scrollTop = 0;
		this.#scrollBottom = nextRows - 1;
		this.#active = this.#usingAlternate ? this.#alternate : this.#normal;
		this.#pendingWrap = this.#active.cursorX >= this.cols;
	}

	/** Subscribes to terminal-generated input replies. */
	onData(listener: (data: string) => void): Disposable {
		this.#dataListeners.add(listener);
		return { dispose: () => this.#dataListeners.delete(listener) };
	}

	/** Releases parser state and event listeners. */
	dispose(): void {
		this.#disposed = true;
		this.#dataListeners.clear();
	}

	#emitData(data: string): void {
		for (const listener of this.#dataListeners) listener(data);
	}

	#parse(text: string): void {
		let printable = "";
		const flush = () => {
			if (!printable) return;
			for (const part of segmenter.segment(printable)) this.#print(part.segment);
			printable = "";
		};
		for (const char of text) {
			if (this.#state === "string") {
				if (this.#stringEscape && char === "\\") {
					this.#state = "ground";
					this.#stringEscape = false;
				} else if (char === "\x07") {
					this.#state = "ground";
					this.#stringEscape = false;
				} else {
					this.#stringEscape = char === "\x1b";
				}
				continue;
			}
			if (this.#state === "escape") {
				this.#handleEscape(char);
				continue;
			}
			if (this.#state === "csi") {
				if (char >= "@" && char <= "~") {
					this.#handleCsi(this.#sequence, char);
					this.#sequence = "";
					this.#state = "ground";
				} else if (char === "\x1b") {
					this.#state = "escape";
					this.#sequence = "";
				} else {
					this.#sequence += char;
				}
				continue;
			}
			if (char === "\x1b") {
				flush();
				this.#state = "escape";
			} else if (char < " " || char === "\x7f") {
				flush();
				this.#handleControl(char);
			} else {
				printable += char;
			}
		}
		flush();
	}

	#handleControl(char: string): void {
		switch (char) {
			case "\b":
				this.#active.cursorX = Math.max(0, this.#active.cursorX - 1);
				this.#pendingWrap = false;
				break;
			case "\t": {
				const stop = Math.min(this.cols - 1, (Math.floor(this.#active.cursorX / 8) + 1) * 8);
				this.#active.cursorX = stop;
				this.#pendingWrap = false;
				break;
			}
			case "\n":
			case "\v":
			case "\f":
				this.#lineFeed(false);
				break;
			case "\r":
				this.#active.cursorX = 0;
				this.#pendingWrap = false;
				break;
		}
	}

	#handleEscape(char: string): void {
		this.#state = "ground";
		switch (char) {
			case "[":
				this.#state = "csi";
				this.#sequence = "";
				break;
			case "]":
			case "P":
			case "_":
			case "^":
				this.#state = "string";
				this.#stringEscape = false;
				break;
			case "7":
				this.#saveCursor();
				break;
			case "8":
				this.#restoreCursor();
				break;
			case "D":
				this.#lineFeed(false);
				break;
			case "E":
				this.#active.cursorX = 0;
				this.#lineFeed(false);
				break;
			case "M":
				this.#reverseIndex();
				break;
			case "c":
				this.#reset();
				break;
		}
	}

	#handleCsi(raw: string, final: string): void {
		const privateMode = raw.startsWith("?");
		const greater = raw.startsWith(">");
		const body = privateMode || greater ? raw.slice(1) : raw;
		const params = body
			.replaceAll(":", ";")
			.split(";")
			.map(value => (value === "" ? 0 : Number(value)));
		const first = params[0] ?? 0;
		const amount = Math.max(1, first);
		switch (final) {
			case "A":
				this.#moveVertical(-amount);
				break;
			case "B":
			case "e":
				this.#moveVertical(amount);
				break;
			case "C":
			case "a":
				this.#active.cursorX = Math.min(this.cols - 1, this.#active.cursorX + amount);
				this.#pendingWrap = false;
				break;
			case "D":
				this.#active.cursorX = Math.max(0, this.#active.cursorX - amount);
				this.#pendingWrap = false;
				break;
			case "E":
				this.#moveVertical(amount);
				this.#active.cursorX = 0;
				break;
			case "F":
				this.#moveVertical(-amount);
				this.#active.cursorX = 0;
				break;
			case "G":
			case "`":
				this.#active.cursorX = Math.min(this.cols - 1, Math.max(0, amount - 1));
				this.#pendingWrap = false;
				break;
			case "H":
			case "f":
				this.#setCursor((params[0] || 1) - 1, (params[1] || 1) - 1);
				break;
			case "d":
				this.#setCursor((first || 1) - 1, this.#active.cursorX);
				break;
			case "J":
				this.#eraseDisplay(first);
				break;
			case "K":
				this.#eraseLine(first);
				break;
			case "L":
				this.#insertLines(amount);
				break;
			case "M":
				this.#deleteLines(amount);
				break;
			case "@":
				this.#insertCells(amount);
				break;
			case "P":
				this.#deleteCells(amount);
				break;
			case "X":
				this.#eraseCells(amount);
				break;
			case "S":
				for (let index = 0; index < amount; index++) this.#scrollUp();
				break;
			case "T":
				for (let index = 0; index < amount; index++) this.#scrollDown();
				break;
			case "m":
				this.#setRendition(params);
				break;
			case "r":
				if (!privateMode) this.#setScrollRegion(params);
				break;
			case "s":
				this.#saveCursor();
				break;
			case "u":
				this.#restoreCursor();
				break;
			case "h":
			case "l":
				this.#setModes(params, privateMode, final === "h");
				break;
			case "n":
				if (!privateMode && first === 6)
					this.#emitData(`\x1b[${this.#active.cursorY + 1};${this.#active.cursorX + 1}R`);
				break;
			case "c":
				if (!greater) this.#emitData("\x1b[?1;2c");
				break;
		}
	}

	#print(grapheme: string): void {
		let width = Bun.stringWidth(grapheme);
		if (width === 0) {
			this.#appendCombining(grapheme);
			return;
		}
		width = Math.min(2, width);
		if (this.#pendingWrap || (width === 2 && this.#active.cursorX === this.cols - 1)) {
			if (!this.#autowrap) {
				this.#active.cursorX = this.cols - width;
			} else {
				this.#lineFeed(true);
				this.#active.cursorX = 0;
			}
		}
		const line = this.#currentLine();
		const column = Math.min(this.#active.cursorX, this.cols - 1);
		if (this.#insertMode) this.#shiftCells(line, column, width);
		this.#clearWideAt(line, column);
		line.cells[column] = { chars: grapheme, width, attrs: { ...this.#attrs } };
		if (width === 2 && column + 1 < this.cols) {
			line.cells[column + 1] = { chars: "", width: 0, attrs: { ...this.#attrs } };
		}
		this.#active.cursorX = column + width;
		this.#pendingWrap = this.#active.cursorX >= this.cols;
	}

	#appendCombining(mark: string): void {
		let column = this.#active.cursorX - 1;
		let row = this.#active.baseY + this.#active.cursorY;
		if (column < 0 && row > 0) {
			row -= 1;
			column = this.cols - 1;
		}
		const line = this.#active.lines[row];
		if (!line) return;
		while (column >= 0 && line.cells[column]?.width === 0) column--;
		const cell = line.cells[column];
		if (cell?.chars) cell.chars += mark;
	}

	#lineFeed(wrapped: boolean): void {
		this.#pendingWrap = false;
		if (this.#active.cursorY === this.#scrollBottom) {
			this.#scrollUp();
		} else if (this.#active.cursorY < this.rows - 1) {
			this.#active.cursorY += 1;
		}
		if (wrapped) this.#currentLine().isWrapped = true;
	}

	#scrollUp(): void {
		const top = this.#active.baseY + this.#scrollTop;
		const bottom = this.#active.baseY + this.#scrollBottom;
		if (this.#scrollTop === 0 && this.#scrollBottom === this.rows - 1 && !this.#usingAlternate) {
			const followedBottom = this.#active.viewportY === this.#active.baseY;
			this.#active.lines.push(new BufferLine(this.cols, this.#attrs));
			const capacity = this.rows + this.#scrollback;
			if (this.#active.lines.length > capacity) this.#active.lines.splice(0, this.#active.lines.length - capacity);
			this.#active.baseY = Math.max(0, this.#active.lines.length - this.rows);
			if (followedBottom) this.#active.viewportY = this.#active.baseY;
			else this.#active.viewportY = Math.min(this.#active.viewportY, this.#active.baseY);
			return;
		}
		this.#active.lines.splice(top, 1);
		this.#active.lines.splice(bottom, 0, new BufferLine(this.cols, this.#attrs));
	}

	#scrollDown(): void {
		const top = this.#active.baseY + this.#scrollTop;
		const bottom = this.#active.baseY + this.#scrollBottom;
		this.#active.lines.splice(bottom, 1);
		this.#active.lines.splice(top, 0, new BufferLine(this.cols, this.#attrs));
	}

	#reverseIndex(): void {
		if (this.#active.cursorY === this.#scrollTop) this.#scrollDown();
		else this.#active.cursorY = Math.max(this.#scrollTop, this.#active.cursorY - 1);
		this.#pendingWrap = false;
	}

	#currentLine(): BufferLine {
		return this.#active.lines[this.#active.baseY + this.#active.cursorY]!;
	}

	#moveVertical(delta: number): void {
		const top = this.#originMode ? this.#scrollTop : 0;
		const bottom = this.#originMode ? this.#scrollBottom : this.rows - 1;
		this.#active.cursorY = Math.min(bottom, Math.max(top, this.#active.cursorY + delta));
		this.#pendingWrap = false;
	}

	#setCursor(row: number, column: number): void {
		const top = this.#originMode ? this.#scrollTop : 0;
		const bottom = this.#originMode ? this.#scrollBottom : this.rows - 1;
		this.#active.cursorY = Math.min(bottom, Math.max(top, row + top));
		this.#active.cursorX = Math.min(this.cols - 1, Math.max(0, column));
		this.#pendingWrap = false;
	}

	#eraseDisplay(mode: number): void {
		if (mode === 3 && !this.#usingAlternate) {
			this.#active.lines = this.#active.lines.slice(this.#active.baseY);
			this.#active.baseY = 0;
			this.#active.viewportY = 0;
			return;
		}
		if (mode === 2) {
			for (let row = 0; row < this.rows; row++)
				this.#active.lines[this.#active.baseY + row] = new BufferLine(this.cols, this.#attrs);
			return;
		}
		if (mode === 0) {
			this.#eraseRange(this.#currentLine(), this.#active.cursorX, this.cols);
			for (let row = this.#active.cursorY + 1; row < this.rows; row++)
				this.#active.lines[this.#active.baseY + row] = new BufferLine(this.cols, this.#attrs);
		} else if (mode === 1) {
			for (let row = 0; row < this.#active.cursorY; row++)
				this.#active.lines[this.#active.baseY + row] = new BufferLine(this.cols, this.#attrs);
			this.#eraseRange(this.#currentLine(), 0, this.#active.cursorX + 1);
		}
	}

	#eraseLine(mode: number): void {
		const line = this.#currentLine();
		if (mode === 0) this.#eraseRange(line, this.#active.cursorX, this.cols);
		else if (mode === 1) this.#eraseRange(line, 0, this.#active.cursorX + 1);
		else if (mode === 2) this.#eraseRange(line, 0, this.cols);
	}

	#eraseRange(line: BufferLine, start: number, end: number): void {
		for (let column = Math.max(0, start); column < Math.min(this.cols, end); column++)
			line.cells[column] = blankCell(this.#attrs);
		this.#repairWideCells(line);
	}

	#insertLines(count: number): void {
		if (this.#active.cursorY < this.#scrollTop || this.#active.cursorY > this.#scrollBottom) return;
		const start = this.#active.baseY + this.#active.cursorY;
		const bottom = this.#active.baseY + this.#scrollBottom;
		for (let index = 0; index < Math.min(count, bottom - start + 1); index++) {
			this.#active.lines.splice(bottom, 1);
			this.#active.lines.splice(start, 0, new BufferLine(this.cols, this.#attrs));
		}
	}

	#deleteLines(count: number): void {
		if (this.#active.cursorY < this.#scrollTop || this.#active.cursorY > this.#scrollBottom) return;
		const start = this.#active.baseY + this.#active.cursorY;
		const bottom = this.#active.baseY + this.#scrollBottom;
		for (let index = 0; index < Math.min(count, bottom - start + 1); index++) {
			this.#active.lines.splice(start, 1);
			this.#active.lines.splice(bottom, 0, new BufferLine(this.cols, this.#attrs));
		}
	}

	#insertCells(count: number): void {
		const line = this.#currentLine();
		this.#shiftCells(line, this.#active.cursorX, count);
		this.#repairWideCells(line);
	}

	#shiftCells(line: BufferLine, column: number, count: number): void {
		line.cells.splice(column, 0, ...Array.from({ length: count }, () => blankCell(this.#attrs)));
		line.cells.length = this.cols;
	}

	#deleteCells(count: number): void {
		const line = this.#currentLine();
		line.cells.splice(this.#active.cursorX, count);
		while (line.cells.length < this.cols) line.cells.push(blankCell(this.#attrs));
		this.#repairWideCells(line);
	}

	#eraseCells(count: number): void {
		this.#eraseRange(this.#currentLine(), this.#active.cursorX, this.#active.cursorX + count);
	}

	#clearWideAt(line: BufferLine, column: number): void {
		if (line.cells[column]?.width === 0 && column > 0) line.cells[column - 1] = blankCell(this.#attrs);
		if (line.cells[column]?.width === 2 && column + 1 < this.cols) line.cells[column + 1] = blankCell(this.#attrs);
	}

	#repairWideCells(line: BufferLine): void {
		for (let column = 0; column < this.cols; column++) {
			const cell = line.cells[column]!;
			if (cell.width === 0 && (column === 0 || line.cells[column - 1]?.width !== 2))
				line.cells[column] = blankCell(this.#attrs);
			if (cell.width === 2 && (column === this.cols - 1 || line.cells[column + 1]?.width !== 0))
				line.cells[column] = blankCell(this.#attrs);
		}
	}

	#setRendition(values: number[]): void {
		const params = values.length === 0 ? [0] : values;
		for (let index = 0; index < params.length; index++) {
			const code = params[index] ?? 0;
			if (code === 0) this.#attrs = defaultAttributes();
			else if (code === 1) this.#attrs.bold = true;
			else if (code === 2) this.#attrs.dim = true;
			else if (code === 3) this.#attrs.italic = true;
			else if (code === 4 || code === 21) this.#attrs.underline = true;
			else if (code === 7) this.#attrs.inverse = true;
			else if (code === 9) this.#attrs.strikethrough = true;
			else if (code === 22) {
				this.#attrs.bold = false;
				this.#attrs.dim = false;
			} else if (code === 23) this.#attrs.italic = false;
			else if (code === 24) this.#attrs.underline = false;
			else if (code === 27) this.#attrs.inverse = false;
			else if (code === 29) this.#attrs.strikethrough = false;
			else if (code === 53) this.#attrs.overline = true;
			else if (code === 55) this.#attrs.overline = false;
			else if (code >= 30 && code <= 37) {
				this.#attrs.fgMode = 1;
				this.#attrs.fg = code - 30;
			} else if (code >= 40 && code <= 47) {
				this.#attrs.bgMode = 1;
				this.#attrs.bg = code - 40;
			} else if (code >= 90 && code <= 97) {
				this.#attrs.fgMode = 1;
				this.#attrs.fg = code - 82;
			} else if (code >= 100 && code <= 107) {
				this.#attrs.bgMode = 1;
				this.#attrs.bg = code - 92;
			} else if (code === 39) this.#attrs.fgMode = 0;
			else if (code === 49) this.#attrs.bgMode = 0;
			else if (code === 38 || code === 48) {
				const foreground = code === 38;
				const mode = params[index + 1];
				if (mode === 5 && params[index + 2] !== undefined) {
					if (foreground) {
						this.#attrs.fgMode = 1;
						this.#attrs.fg = params[index + 2]! & 0xff;
					} else {
						this.#attrs.bgMode = 1;
						this.#attrs.bg = params[index + 2]! & 0xff;
					}
					index += 2;
				} else if (mode === 2 && params[index + 4] !== undefined) {
					const color =
						((params[index + 2]! & 0xff) << 16) |
						((params[index + 3]! & 0xff) << 8) |
						(params[index + 4]! & 0xff);
					if (foreground) {
						this.#attrs.fgMode = 2;
						this.#attrs.fg = color;
					} else {
						this.#attrs.bgMode = 2;
						this.#attrs.bg = color;
					}
					index += 4;
				}
			}
		}
	}

	#setScrollRegion(params: number[]): void {
		const top = Math.max(0, (params[0] || 1) - 1);
		const bottom = Math.min(this.rows - 1, (params[1] || this.rows) - 1);
		if (top >= bottom) return;
		this.#scrollTop = top;
		this.#scrollBottom = bottom;
		this.#setCursor(0, 0);
	}

	#setModes(params: number[], privateMode: boolean, enabled: boolean): void {
		for (const mode of params) {
			if (!privateMode && mode === 4) this.#insertMode = enabled;
			else if (privateMode && mode === 1) this.modes.applicationCursorKeysMode = enabled;
			else if (privateMode && mode === 6) {
				this.#originMode = enabled;
				this.#setCursor(0, 0);
			} else if (privateMode && mode === 7) this.#autowrap = enabled;
			else if (privateMode && (mode === 47 || mode === 1047 || mode === 1049)) {
				if (enabled) this.#enterAlternate(mode === 1049);
				else this.#leaveAlternate(mode === 1049);
			} else if (privateMode && mode === 1048) {
				if (enabled) this.#saveCursor();
				else this.#restoreCursor();
			}
		}
	}

	#saveCursor(): void {
		this.#saved = { x: this.#active.cursorX, y: this.#active.cursorY, attrs: { ...this.#attrs } };
	}

	#restoreCursor(): void {
		if (!this.#saved) return;
		this.#active.cursorX = Math.min(this.cols - 1, this.#saved.x);
		this.#active.cursorY = Math.min(this.rows - 1, this.#saved.y);
		this.#attrs = { ...this.#saved.attrs };
		this.#pendingWrap = false;
	}

	#enterAlternate(saveCursor: boolean): void {
		if (this.#usingAlternate) return;
		if (saveCursor)
			this.#alternateSaved = { x: this.#normal.cursorX, y: this.#normal.cursorY, attrs: { ...this.#attrs } };
		this.#alternate = createState(this.cols, this.rows);
		this.#active = this.#alternate;
		this.#usingAlternate = true;
		this.#scrollTop = 0;
		this.#scrollBottom = this.rows - 1;
		this.#pendingWrap = false;
	}

	#leaveAlternate(restoreCursor: boolean): void {
		if (!this.#usingAlternate) return;
		this.#active = this.#normal;
		this.#usingAlternate = false;
		if (restoreCursor && this.#alternateSaved) {
			this.#normal.cursorX = this.#alternateSaved.x;
			this.#normal.cursorY = this.#alternateSaved.y;
			this.#attrs = { ...this.#alternateSaved.attrs };
		}
		this.#scrollTop = 0;
		this.#scrollBottom = this.rows - 1;
		this.#pendingWrap = false;
	}

	#reset(): void {
		this.#attrs = defaultAttributes();
		this.#normal = createState(this.cols, this.rows);
		this.#alternate = createState(this.cols, this.rows);
		this.#usingAlternate = false;
		this.#active = this.#normal;
		this.#scrollTop = 0;
		this.#scrollBottom = this.rows - 1;
		this.#originMode = false;
		this.#autowrap = true;
		this.#insertMode = false;
		this.#pendingWrap = false;
		this.modes.applicationCursorKeysMode = false;
	}

	#reflow(state: BufferState, columns: number, rows: number, retainHistory: boolean): BufferState {
		const absoluteCursor = state.baseY + state.cursorY;
		const groups: Array<{ cells: CellData[]; cursorOffset?: number }> = [];
		for (let row = 0; row < state.lines.length; row++) {
			const line = state.lines[row]!;
			if (!line.isWrapped || groups.length === 0) groups.push({ cells: [] });
			const group = groups.at(-1)!;
			const used = line.isWrapped || state.lines[row + 1]?.isWrapped ? line.cells.length : this.#usedColumns(line);
			if (row === absoluteCursor) group.cursorOffset = group.cells.length + state.cursorX;
			for (let column = 0; column < used; column++) group.cells.push(cloneCell(line.cells[column]!));
		}
		const lines: BufferLine[] = [];
		let cursorAbsolute = 0;
		let cursorX = 0;
		for (const group of groups) {
			const start = lines.length;
			if (group.cells.length === 0) lines.push(new BufferLine(columns));
			else {
				let source = 0;
				while (source < group.cells.length) {
					const line = new BufferLine(columns);
					line.isWrapped = source > 0;
					let target = 0;
					while (source < group.cells.length && target < columns) {
						const cell = group.cells[source]!;
						if (cell.width === 0) {
							source++;
							continue;
						}
						if (cell.width === 2 && target === columns - 1) break;
						line.cells[target] = cloneCell(cell);
						if (cell.width === 2) line.cells[target + 1] = { chars: "", width: 0, attrs: { ...cell.attrs } };
						target += cell.width;
						source += cell.width;
					}
					lines.push(line);
				}
			}
			if (group.cursorOffset !== undefined) {
				const offset = group.cursorOffset;
				const onBoundary = offset > 0 && offset % columns === 0;
				cursorAbsolute = start + Math.floor(offset / columns) - Number(onBoundary);
				cursorX = onBoundary ? columns - 1 : offset % columns;
			}
		}
		while (
			lines.length > rows &&
			cursorAbsolute < lines.length - 1 &&
			!lines.at(-1)!.isWrapped &&
			this.#usedColumns(lines.at(-1)!) === 0
		) {
			lines.pop();
		}
		while (lines.length < rows) lines.push(new BufferLine(columns));
		const capacity = rows + (retainHistory ? this.#scrollback : 0);
		const removed = Math.max(0, lines.length - capacity);
		if (removed > 0) lines.splice(0, removed);
		cursorAbsolute = Math.max(0, cursorAbsolute - removed);
		const baseY = Math.max(0, lines.length - rows);
		return {
			lines,
			baseY,
			viewportY: baseY,
			cursorX,
			cursorY: Math.min(rows - 1, Math.max(0, cursorAbsolute - baseY)),
		};
	}

	#usedColumns(line: BufferLine): number {
		for (let column = line.cells.length - 1; column >= 0; column--) {
			const cell = line.cells[column]!;
			if (cell.chars || cell.width === 0) return column + 1;
		}
		return 0;
	}
}
