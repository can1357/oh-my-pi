/**
 * Cell geometry of inline images: how many columns and rows an image of a
 * given pixel size takes under optional cell caps.
 */

/** Cell size in pixels. */
export interface CellSize {
	readonly w: number;
	readonly h: number;
}

/** The cell size assumed until the terminal reports one. */
export const DEFAULT_CELL: CellSize = Object.freeze({ w: 9, h: 18 });

/** Caps on the cell box an image may take; absent caps leave that axis at the image's natural size. */
export interface ImageBounds {
	readonly maxColumns?: number;
	readonly maxRows?: number;
}

/** The cell box an image is drawn into, plus the pixel size it is scaled to inside that box. */
export interface ImageBox {
	readonly columns: number;
	readonly rows: number;
	/** Scaled pixel size (aspect ratio kept), never larger than the box. */
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Fit an image into cells. Without caps the image keeps its pixel size
 * (rounded up to whole cells); with caps it scales (up or down) to the
 * largest size that fits both, keeping its aspect ratio. Columns round down
 * (a row never overflows its cap), rows round up (no pixel row is lost).
 */
export function fitImage(widthPx: number, heightPx: number, bounds: ImageBounds, cell: CellSize): ImageBox {
	const w = Math.max(1, widthPx);
	const h = Math.max(1, heightPx);
	const maxColumns = bounds.maxColumns === undefined ? undefined : Math.max(1, Math.floor(bounds.maxColumns));
	const maxRows = bounds.maxRows === undefined ? undefined : Math.max(1, Math.floor(bounds.maxRows));
	if (maxColumns === undefined && maxRows === undefined) {
		return {
			columns: Math.max(1, Math.ceil(w / cell.w)),
			rows: Math.max(1, Math.ceil(h / cell.h)),
			widthPx: w,
			heightPx: h,
		};
	}
	const scale = Math.min(
		maxColumns === undefined ? Number.POSITIVE_INFINITY : (maxColumns * cell.w) / w,
		maxRows === undefined ? Number.POSITIVE_INFINITY : (maxRows * cell.h) / h,
	);
	const fittedW = w * scale;
	const fittedH = h * scale;
	let columns = Math.max(1, Math.floor(fittedW / cell.w));
	let rows = Math.max(1, Math.ceil(fittedH / cell.h));
	if (maxColumns !== undefined) columns = Math.min(columns, maxColumns);
	if (maxRows !== undefined) rows = Math.min(rows, maxRows);
	return {
		columns,
		rows,
		widthPx: Math.max(1, Math.min(Math.round(fittedW), columns * cell.w)),
		heightPx: Math.max(1, Math.min(Math.round(fittedH), rows * cell.h)),
	};
}
