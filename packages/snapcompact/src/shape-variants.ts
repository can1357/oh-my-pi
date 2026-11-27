/**
 * Eval-validated snapcompact frame variant geometries and names.
 *
 * Kept in a zero-dependency leaf module so settings/schema modules can validate
 * variant names without importing the native renderer or catalog dependencies.
 */

/** Geometry half of a snapcompact frame shape: everything except provider billing. */
export interface ShapeGeometry {
	/** Bundled font in the native renderer. */
	font: "5x8" | "8x8" | "6x12" | "8x13" | "silver";
	/** Target cell advance in pixels; differing from the font's natural cell
	 *  renders via Lanczos stretch (anti-aliased RGB frame). */
	cellWidth: number;
	/** Target cell pitch in pixels. */
	cellHeight: number;
	/** `false` → glyphs drawn at natural size on the cell pitch (8on16);
	 *  `true`/`undefined` → legacy auto Lanczos stretch when cell ≠ natural. */
	stretch?: boolean;
	/** Ink: `sent` cycles six hues at sentence boundaries; `bw` is black. */
	variant: "sent" | "bw";
	/** Print stopwords in dim ink (research `dim`/`sent-dim` variants). */
	stopwordDim?: boolean;
	/** 1/undefined = row-major grid; 2 = two word-wrapped newspaper columns
	 *  (research `doc`). */
	columns?: number;
	/** Each text line is printed this many times; copies after the first sit
	 *  on a pale highlight band (redundancy coding). */
	lineRepeat: number;
	/** Frame edge in pixels. */
	frameSize: number;
}

/**
 * Frame variants exercised by the SQuAD evals in `research/` that the native
 * renderer reproduces faithfully, keyed by their research names. Font codes:
 * `8x8u` unscii square cell, `8x8r` unscii with every line printed twice
 * (redundancy coding), `6x6u` unscii Lanczos-squeezed to 6x6 (densest
 * readable cell), `5x8` the X.org legacy font on its 2576px frame, `6x12`
 * and `8x13` the X.org misc fonts, `8on16` 8x13 glyphs on an 8x16 cell pitch
 * (no stretch, extra leading), `8on22` the same glyphs on a 22px pitch (more
 * leading), `11on16` the same glyphs on an 11px advance (more tracking),
 * `silver16` the embedded Silver TrueType font on a 16px grid for CJK and
 * other non-Latin text, and `doc-` prefixed shapes a two-column word-wrapped
 * newspaper layout. Ink: `sent` cycles six hues at sentence boundaries, `bw`
 * is plain black, `-dim` suffix prints stopwords in gray.
 */
export const SHAPE_VARIANTS = {
	"8x8r-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 2, frameSize: 1568 },
	"8x8r-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 2, frameSize: 1568 },
	"8x8u-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8x8u-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 1568 },
	"6x6u-bw": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"6x6u-sent": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "sent", lineRepeat: 1, frameSize: 1568 },
	"5x8-bw": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 2576 },
	"5x8-sent": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 2576 },
	"6x12-dim": {
		font: "6x12",
		cellWidth: 6,
		cellHeight: 12,
		variant: "bw",
		stopwordDim: true,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"8x13-bw": { font: "8x13", cellWidth: 8, cellHeight: 13, variant: "bw", lineRepeat: 1, frameSize: 1568 },
	"8on16-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"8on22-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 22,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"11on16-bw": {
		font: "8x13",
		cellWidth: 11,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"silver16-bw": {
		font: "silver",
		cellWidth: 16,
		cellHeight: 16,
		variant: "bw",
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-bw": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "bw",
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-sent": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "sent",
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
	"doc-8on16-sent-dim": {
		font: "8x13",
		cellWidth: 8,
		cellHeight: 16,
		stretch: false,
		variant: "sent",
		stopwordDim: true,
		columns: 2,
		lineRepeat: 1,
		frameSize: 1568,
	},
} as const satisfies Record<string, ShapeGeometry>;

/** Research name of one renderable frame variant. */
export type ShapeVariantName = keyof typeof SHAPE_VARIANTS;

/** All variant names, in declaration order (for settings enums). */
export const SHAPE_VARIANT_NAMES = Object.keys(SHAPE_VARIANTS) as readonly ShapeVariantName[];

/** Runtime guard for variant names loaded from config. */
export function isShapeVariantName(value: unknown): value is ShapeVariantName {
	return typeof value === "string" && value in SHAPE_VARIANTS;
}

/** Smallest configurable frame edge: the renderer's 64px floor, which still
 *  fits at least one row and column of every variant's cell. */
export const MIN_CONFIGURED_FRAME_SIZE = 64;
/** Largest configurable frame edge: the largest any variant renders at. */
export const MAX_CONFIGURED_FRAME_SIZE = 2576;

/** Whether `value` is a frame edge a configured shape may set: an integer in
 *  [{@link MIN_CONFIGURED_FRAME_SIZE}, {@link MAX_CONFIGURED_FRAME_SIZE}]. */
export function isConfigurableFrameSize(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_CONFIGURED_FRAME_SIZE &&
		value <= MAX_CONFIGURED_FRAME_SIZE
	);
}
