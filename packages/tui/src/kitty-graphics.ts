/**
 * Kitty graphics: Unicode placeholder placement (`U=1` + U+10EEEE), with
 * runtime feature state and env overrides.
 *
 * Unicode placeholders let a transmitted image be displayed by writing ordinary
 * text cells — the placeholder char U+10EEEE plus row/column combining
 * diacritics — instead of a cursor-positioned `a=p` direct placement. The image
 * then participates in the normal text grid, so it survives horizontal slicing,
 * reflow and overlapping draws (each cell names its own row+column, so a sliced
 * row still maps to the correct sub-region). See kitty
 * `docs/graphics-protocol.rst` "Unicode placeholders for relative placements".
 *
 * This module is intentionally free of `./terminal-capabilities` imports so the
 * dependency stays one-way (capabilities → kitty-graphics) and no import cycle
 * forms. Protocol gating (`imageProtocol === Kitty`) lives in the caller.
 */

import { isInsideHerdr, isInsideTerminalMultiplexer } from "./terminal-multiplexer";
import { wrapTmuxPassthroughIfNeeded } from "./tmux";

/** Kitty Unicode placeholder base character (U+10EEEE, Plane 16 PUA). */
export const KITTY_PLACEHOLDER = "\u{10eeee}";

/**
 * Row/column diacritics (Unicode combining class 230, no decomposition) used to
 * name a placeholder cell's row and column. Index `i` → codepoint. Derived from
 * kitty `gen/rowcolumn-diacritics.txt` (Unicode 6.0.0 NSM set). 297 entries, so
 * a single image can address up to 297 rows/columns without ID-high-byte tricks.
 */
const ROWCOLUMN_DIACRITICS: readonly number[] = [
	0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d, 0x33e, 0x33f, 0x346, 0x34a, 0x34b, 0x34c, 0x350, 0x351, 0x352, 0x357,
	0x35b, 0x363, 0x364, 0x365, 0x366, 0x367, 0x368, 0x369, 0x36a, 0x36b, 0x36c, 0x36d, 0x36e, 0x36f, 0x483, 0x484,
	0x485, 0x486, 0x487, 0x592, 0x593, 0x594, 0x595, 0x597, 0x598, 0x599, 0x59c, 0x59d, 0x59e, 0x59f, 0x5a0, 0x5a1,
	0x5a8, 0x5a9, 0x5ab, 0x5ac, 0x5af, 0x5c4, 0x610, 0x611, 0x612, 0x613, 0x614, 0x615, 0x616, 0x617, 0x657, 0x658,
	0x659, 0x65a, 0x65b, 0x65d, 0x65e, 0x6d6, 0x6d7, 0x6d8, 0x6d9, 0x6da, 0x6db, 0x6dc, 0x6df, 0x6e0, 0x6e1, 0x6e2,
	0x6e4, 0x6e7, 0x6e8, 0x6eb, 0x6ec, 0x730, 0x732, 0x733, 0x735, 0x736, 0x73a, 0x73d, 0x73f, 0x740, 0x741, 0x743,
	0x745, 0x747, 0x749, 0x74a, 0x7eb, 0x7ec, 0x7ed, 0x7ee, 0x7ef, 0x7f0, 0x7f1, 0x7f3, 0x816, 0x817, 0x818, 0x819,
	0x81b, 0x81c, 0x81d, 0x81e, 0x81f, 0x820, 0x821, 0x822, 0x823, 0x825, 0x826, 0x827, 0x829, 0x82a, 0x82b, 0x82c,
	0x82d, 0x951, 0x953, 0x954, 0xf82, 0xf83, 0xf86, 0xf87, 0x135d, 0x135e, 0x135f, 0x17dd, 0x193a, 0x1a17, 0x1a75,
	0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72,
	0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6, 0x1dc7,
	0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda,
	0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0,
	0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0, 0x2cef, 0x2cf0, 0x2cf1,
	0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded,
	0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa, 0x2dfb,
	0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4,
	0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0,
	0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23, 0xfe24, 0xfe25, 0xfe26,
	0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243,
	0x1d244,
];

/** Largest row/column index expressible with the diacritic table (one cell each). */
export const KITTY_PLACEHOLDER_MAX_CELLS = ROWCOLUMN_DIACRITICS.length;

export interface KittyGraphicsFeatures {
	/** Display images via Unicode placeholders instead of direct `a=p` placement. */
	unicodePlaceholders: boolean;
}

/**
 * Whether the detected terminal renders Kitty Unicode placeholders (`U=1` +
 * U+10EEEE with row/column diacritics).
 *
 * Kitty and Ghostty advertise placeholder support directly. A multiplexer
 * cannot use cursor-positioned placements because the outer terminal does not
 * know pane scroll/reflow state. An explicit `PI_FORCE_IMAGE_PROTOCOL=kitty`
 * opts into placeholders under any multiplexer — matching `timg -pk`.
 * Automatic Herdr fallback stays off because its pane marker does not prove
 * that the experimental Kitty renderer is enabled.
 *
 * `PI_NO_KITTY_PLACEHOLDERS=1` and `PI_KITTY_PLACEHOLDERS=0` remain hard
 * opt-outs; `PI_KITTY_PLACEHOLDERS=1` explicitly opts in anywhere else.
 */
export function detectKittyUnicodePlaceholdersSupport(terminalId: string, env: NodeJS.ProcessEnv = Bun.env): boolean {
	const offRaw = env.PI_NO_KITTY_PLACEHOLDERS?.trim().toLowerCase();
	if (offRaw === "1" || offRaw === "true" || offRaw === "on" || offRaw === "yes" || offRaw === "y") return false;
	const force = env.PI_KITTY_PLACEHOLDERS?.trim().toLowerCase();
	if (force === "1" || force === "true" || force === "on" || force === "yes" || force === "y") return true;
	if (force === "0" || force === "false" || force === "off" || force === "no" || force === "n") return false;
	const insideMultiplexer = isInsideTerminalMultiplexer(env);
	if (insideMultiplexer && env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase() === "kitty") return true;
	if (isInsideHerdr(env)) return false;
	return terminalId === "kitty" || terminalId === "ghostty";
}

let features: KittyGraphicsFeatures = {
	// Off until `terminal-capabilities` seeds it from the detected terminal id —
	// the default-on path corrupts wezterm and tmux-passthrough sessions.
	unicodePlaceholders: false,
};

export function getKittyGraphics(): Readonly<KittyGraphicsFeatures> {
	return features;
}

export function setKittyGraphics(partial: Partial<KittyGraphicsFeatures>): void {
	features = { ...features, ...partial };
}

/** Whether a `columns`×`rows` placeholder grid fits within the diacritic table. */
export function kittyPlaceholdersFit(columns: number, rows: number): boolean {
	return columns >= 1 && rows >= 1 && columns <= KITTY_PLACEHOLDER_MAX_CELLS && rows <= KITTY_PLACEHOLDER_MAX_CELLS;
}

function diacritic(index: number): string {
	const cp = ROWCOLUMN_DIACRITICS[index];
	return cp === undefined ? "" : String.fromCodePoint(cp);
}

/**
 * Virtual placement APC (`a=p,U=1`): tells the terminal that placeholder cells
 * carrying image id `i` should display the transmitted image, scaled to fit the
 * `c`×`r` cell box. Re-emitting with a stable `placementId` replaces in place.
 */
export function encodeKittyVirtualPlacement(opts: {
	imageId: number;
	placementId?: number;
	columns: number;
	rows: number;
}): string {
	const params = ["a=p", "U=1", "q=2", `i=${opts.imageId}`];
	if (opts.placementId) params.push(`p=${opts.placementId}`);
	params.push(`c=${opts.columns}`, `r=${opts.rows}`);
	return wrapTmuxPassthroughIfNeeded(`\x1b_G${params.join(",")}\x1b\\`);
}

/**
 * Build the placeholder cell grid as one string per row. The image id is carried
 * in each row's foreground color and the placement id (if any) in its underline
 * color; every cell names its explicit row+column diacritic (robust to slicing,
 * unlike left-inheritance). Returns exactly `rows` strings.
 */
export function encodeKittyPlaceholderGrid(opts: {
	imageId: number;
	placementId?: number;
	columns: number;
	rows: number;
}): string[] {
	const fg = `\x1b[38;2;${(opts.imageId >> 16) & 0xff};${(opts.imageId >> 8) & 0xff};${opts.imageId & 0xff}m`;
	const underline = opts.placementId
		? `\x1b[58:2::${(opts.placementId >> 16) & 0xff}:${(opts.placementId >> 8) & 0xff}:${opts.placementId & 0xff}m`
		: "";
	const reset = "\x1b[39;59m";
	const lead = fg + underline;
	const out: string[] = [];
	for (let r = 0; r < opts.rows; r++) {
		const rowDiacritic = diacritic(r);
		let row = lead;
		for (let c = 0; c < opts.columns; c++) {
			row += KITTY_PLACEHOLDER + rowDiacritic + diacritic(c);
		}
		out.push(row + reset);
	}
	return out;
}

/**
 * Full placeholder render: the virtual-placement APC prefixes line 0, and every
 * line carries placeholder cells. Returns exactly `rows` lines (no cursor moves).
 */
export function renderKittyPlaceholderLines(opts: {
	imageId: number;
	placementId?: number;
	columns: number;
	rows: number;
}): string[] {
	const grid = encodeKittyPlaceholderGrid(opts);
	if (grid.length > 0) {
		grid[0] = encodeKittyVirtualPlacement(opts) + grid[0];
	}
	return grid;
}
