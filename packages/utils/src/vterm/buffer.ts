/** Cell rendition tracked by the virtual terminal. */
export interface CellAttributes {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strikethrough: boolean;
	overline: boolean;
	fgMode: 0 | 1 | 2;
	fg: number;
	bgMode: 0 | 1 | 2;
	bg: number;
}

/** A mutable terminal grid cell. */
export interface CellData {
	chars: string;
	width: number;
	attrs: CellAttributes;
}

/** Creates the default rendition. */
export function defaultAttributes(): CellAttributes {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		inverse: false,
		strikethrough: false,
		overline: false,
		fgMode: 0,
		fg: 0,
		bgMode: 0,
		bg: 0,
	};
}

function cloneAttributes(attrs: CellAttributes): CellAttributes {
	return { ...attrs };
}

/** Creates an empty cell with the supplied rendition. */
export function blankCell(attrs: CellAttributes = defaultAttributes()): CellData {
	return { chars: "", width: 1, attrs: cloneAttributes(attrs) };
}

/** Proposed xterm-compatible cell readback object. */
export class BufferCell {
	#cell: CellData = blankCell();

	/** Reuses this object for another grid cell. */
	setFrom(cell: CellData): this {
		this.#cell = cell;
		return this;
	}

	/** Returns the grapheme stored in this cell. */
	getChars(): string {
		return this.#cell.chars;
	}

	/** Returns the cell width, with zero denoting a wide-cell continuation. */
	getWidth(): number {
		return this.#cell.width;
	}

	/** Returns the packed foreground palette index or RGB value. */
	getFgColor(): number {
		return this.#cell.attrs.fg;
	}

	/** Returns the packed background palette index or RGB value. */
	getBgColor(): number {
		return this.#cell.attrs.bg;
	}

	/** Reports bold rendition. */
	isBold(): number {
		return Number(this.#cell.attrs.bold);
	}

	/** Reports dim rendition. */
	isDim(): number {
		return Number(this.#cell.attrs.dim);
	}

	/** Reports italic rendition. */
	isItalic(): number {
		return Number(this.#cell.attrs.italic);
	}

	/** Reports underline rendition. */
	isUnderline(): number {
		return Number(this.#cell.attrs.underline);
	}

	/** Reports inverse rendition. */
	isInverse(): number {
		return Number(this.#cell.attrs.inverse);
	}

	/** Reports strikethrough rendition. */
	isStrikethrough(): number {
		return Number(this.#cell.attrs.strikethrough);
	}

	/** Reports overline rendition. */
	isOverline(): number {
		return Number(this.#cell.attrs.overline);
	}

	/** Reports a true-color foreground. */
	isFgRGB(): boolean {
		return this.#cell.attrs.fgMode === 2;
	}

	/** Reports a true-color background. */
	isBgRGB(): boolean {
		return this.#cell.attrs.bgMode === 2;
	}

	/** Reports a palette foreground. */
	isFgPalette(): boolean {
		return this.#cell.attrs.fgMode === 1;
	}

	/** Reports a palette background. */
	isBgPalette(): boolean {
		return this.#cell.attrs.bgMode === 1;
	}
}

/** One physical row in a terminal buffer. */
export class BufferLine {
	cells: CellData[];
	isWrapped = false;

	constructor(columns: number, attrs: CellAttributes = defaultAttributes()) {
		this.cells = Array.from({ length: columns }, () => blankCell(attrs));
	}

	/** Number of grid columns in the line. */
	get length(): number {
		return this.cells.length;
	}

	/** Reads a cell, optionally reusing the caller's object. */
	getCell(column: number, cell = new BufferCell()): BufferCell | undefined {
		const value = this.cells[column];
		return value ? cell.setFrom(value) : undefined;
	}

	/** Converts a column range to text. */
	translateToString(trimRight = false, startColumn = 0, endColumn = this.cells.length): string {
		const start = Math.max(0, startColumn);
		let end = Math.min(endColumn, this.cells.length);
		if (trimRight) {
			while (end > start && !this.cells[end - 1]!.chars) end--;
		}
		let text = "";
		for (let column = start; column < end; column++) {
			const cell = this.cells[column]!;
			if (cell.width !== 0) text += cell.chars || " ";
		}
		return text;
	}
}

/** Storage backing one terminal screen and its history. */
export interface BufferState {
	lines: BufferLine[];
	baseY: number;
	viewportY: number;
	cursorX: number;
	cursorY: number;
}

/** Public xterm-compatible view over a buffer state. */
export class BufferView {
	constructor(private readonly state: () => BufferState) {}

	/** Number of physical lines, including scrollback. */
	get length(): number {
		return this.state().lines.length;
	}

	/** First row of the live screen in the full buffer. */
	get baseY(): number {
		return this.state().baseY;
	}

	/** First row currently exposed by the viewport. */
	get viewportY(): number {
		return this.state().viewportY;
	}

	/** Cursor column in the live screen. */
	get cursorX(): number {
		return this.state().cursorX;
	}

	/** Cursor row in the live screen. */
	get cursorY(): number {
		return this.state().cursorY;
	}

	/** Reads a physical buffer line. */
	getLine(row: number): BufferLine | undefined {
		return this.state().lines[row];
	}

	/** Creates a reusable empty cell readback object. */
	getNullCell(): BufferCell {
		return new BufferCell();
	}
}
