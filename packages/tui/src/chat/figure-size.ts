/**
 * Sizes of figures drawn in terminal cells: the CSS lengths an `<img>` or
 * `<iframe>` states (`width="50%"`, `height="20em"`), and the cell box those
 * and a picture's natural size come to ({@link figureBox}).
 *
 * A CSS px is a fixed share of a row ({@link PX_PER_ROW}), not a device
 * pixel, so a figure takes the same cells on a HiDPI terminal as on a
 * standard one, and `font-size="14"` in a drawing lands near the terminal's
 * own glyph size.
 *
 * @example
 * const width = parseFigureLength("50%"); // { value: 50, unit: "%" }
 * figureBox({ width }, { room: figureRoom(120), cell }); // { columns: 59, rows: … }
 */
import { imageMaxColumns } from "../components/image";
import type { CellDimensions, ImageDimensions } from "../terminal-capabilities";

/** CSS px per terminal row; a 1000px-wide figure spans ~125 columns of 1:2 cells. */
export const PX_PER_ROW = 16;
/** Share of the terminal's rows one figure may fill, so it fits on screen whole. */
const MAX_VIEWPORT_SHARE = 0.8;

/** Units a {@link FigureLength} is stated in. */
export type FigureUnit = "px" | "%" | "vw" | "vh" | "ch" | "em";

/** One CSS length: `%` is of the figure's column (the viewport's rows, as a height); `vw`/`vh` of the terminal. */
export interface FigureLength {
	readonly value: number;
	readonly unit: FigureUnit;
}

/** A figure's stated size. A side left out follows the other by the picture's aspect ratio. */
export interface FigureSize {
	readonly width?: FigureLength;
	readonly height?: FigureLength;
}

/** Cells a figure may fill. */
export interface FigureBox {
	columns: number;
	rows: number;
}

/** What {@link figureBox} sizes against. */
export interface FigureFit {
	/** Cells available to the figure; see {@link figureRoom}. */
	room: FigureBox;
	cell: CellDimensions;
	/** The picture's size in CSS px, taken when `size` states neither side. */
	natural?: ImageDimensions;
	/** The terminal, for `vw`/`vh`; defaults to the process's stdout. */
	viewport?: FigureBox;
}

const LENGTH = /^(\d+(?:\.\d+)?|\.\d+)(px|%|vw|vh|ch|em)?$/i;
const UNITS: Readonly<Record<string, FigureUnit>> = { px: "px", "%": "%", vw: "vw", vh: "vh", ch: "ch", em: "em" };

/**
 * Read a `width`/`height` attribute: a positive number, bare (CSS px) or with
 * a `px`, `%`, `vw`, `vh`, `ch` or `em` unit. Anything else is `undefined`,
 * which leaves that side to the picture.
 */
export function parseFigureLength(text: string): FigureLength | undefined {
	const match = LENGTH.exec(text.trim());
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = UNITS[match[2]?.toLowerCase() ?? "px"];
	return value > 0 && unit ? { value, unit } : undefined;
}

/** Whether `size` states a side, so the figure is fitted to it rather than drawn at its natural size. */
export function isSized(size: FigureSize | undefined): boolean {
	return size?.width !== undefined || size?.height !== undefined;
}

/**
 * Cells a figure rendered at `width` may fill: an image's widest draw, and
 * the caller's row ceiling or, without one, a share of the terminal's rows.
 */
export function figureRoom(
	width: number,
	maxRows = Math.floor((process.stdout.rows || 24) * MAX_VIEWPORT_SHARE),
): FigureBox {
	return { columns: imageMaxColumns(width), rows: Math.max(1, maxRows) };
}

/**
 * The box a picture is fitted into, aspect ratio kept, never past `fit.room`:
 * the stated sides of `size`, each side left out as large as the room allows;
 * with no side stated, the picture's natural size, or the whole room when
 * that is unknown.
 */
export function figureBox(size: FigureSize, fit: FigureFit): FigureBox {
	const { room, cell, natural } = fit;
	const viewport = fit.viewport ?? { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
	const pxScale = cell.heightPx / PX_PER_ROW;
	const devicePx = (length: FigureLength, vertical: boolean): number => {
		const share = length.value / 100;
		switch (length.unit) {
			case "px":
				return length.value * pxScale;
			case "em":
				return length.value * cell.heightPx;
			case "ch":
				return length.value * cell.widthPx;
			case "vw":
				return share * viewport.columns * cell.widthPx;
			case "vh":
				return share * viewport.rows * cell.heightPx;
			case "%":
				return vertical ? share * viewport.rows * cell.heightPx : share * room.columns * cell.widthPx;
		}
	};
	const unsized = natural !== undefined && !isSized(size);
	const columns = size.width
		? devicePx(size.width, false) / cell.widthPx
		: unsized
			? (natural.widthPx * pxScale) / cell.widthPx
			: room.columns;
	const rows = size.height
		? devicePx(size.height, true) / cell.heightPx
		: unsized
			? natural.heightPx / PX_PER_ROW
			: room.rows;
	return {
		columns: Math.max(1, Math.min(Math.round(columns), room.columns)),
		rows: Math.max(1, Math.min(Math.round(rows), room.rows)),
	};
}
