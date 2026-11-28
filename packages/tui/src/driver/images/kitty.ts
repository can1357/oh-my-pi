/**
 * Kitty graphics protocol encoders.
 *
 * Images are transmitted once under an id (`a=t`) and placed any number of
 * times by id (`a=p`); `a=d,d=I` frees them. Two placement styles exist:
 *
 * - Direct placement: an `a=p` written at the cursor. Each image row carries
 *   its own placement of the matching source band, so every row is
 *   self-contained (a viewport diff may rewrite any subset of them, and a
 *   row clipped off the top of the screen costs nothing).
 * - Unicode placeholders (`U=1`): a virtual placement plus cells of
 *   U+10EEEE whose foreground color names the image, underline color the
 *   placement and diacritics the row/column. The image then lives in the
 *   text itself and follows reflow, scrolling and multiplexer panes. Only
 *   some terminals implement it, see {@link kittyPlaceholdersSupported}.
 *
 * Every command is quiet (`q=2`) and passes through tmux when it must.
 */
import type { TerminalCapabilities } from "../contract";
import { PLACEHOLDER_DIACRITICS } from "./diacritics";
import { wrapPassthrough } from "../mux/tmux";

type Multiplexer = TerminalCapabilities["multiplexer"];

/** Base64 bytes per transmission chunk (the protocol's limit). */
export const KITTY_CHUNK_SIZE = 4096;

/** The placeholder base character. */
export const KITTY_PLACEHOLDER = "\u{10EEEE}";

/** Most rows or columns a placeholder grid can number. */
export const KITTY_PLACEHOLDER_MAX_CELLS = PLACEHOLDER_DIACRITICS.length;

/** Largest image or placement id a placeholder cell can name (24-bit color). */
export const KITTY_MAX_ID = 0xff_ffff;

function apc(control: string, payload?: string): string {
	return payload === undefined ? `\x1b_G${control}\x1b\\` : `\x1b_G${control};${payload}\x1b\\`;
}

/** Split base64 data into protocol chunks, each wrapped separately; `first` holds the leading command's keys. */
function chunked(first: string, data: string, multiplexer: Multiplexer): string {
	if (data.length <= KITTY_CHUNK_SIZE) return wrapPassthrough(apc(first, data), multiplexer);
	let out = "";
	for (let offset = 0; offset < data.length; offset += KITTY_CHUNK_SIZE) {
		const more = offset + KITTY_CHUNK_SIZE < data.length ? 1 : 0;
		const control = offset === 0 ? `${first},m=${more}` : `q=2,m=${more}`;
		out += wrapPassthrough(apc(control, data.slice(offset, offset + KITTY_CHUNK_SIZE)), multiplexer);
	}
	return out;
}

/** Transmit PNG data (base64) under `id` without displaying it. */
export function kittyTransmit(data: string, id: number, multiplexer: Multiplexer = null): string {
	return chunked(`a=t,f=100,q=2,i=${id}`, data, multiplexer);
}

/**
 * Transmit and display PNG data at the cursor in one command, without an id
 * (the terminal keeps one anonymous copy per call). The cursor does not move.
 */
export function kittyTransmitAndDisplay(
	data: string,
	columns: number,
	rows: number,
	multiplexer: Multiplexer = null,
): string {
	return chunked(`a=T,f=100,q=2,C=1,c=${columns},r=${rows}`, data, multiplexer);
}

/** A source rectangle in image pixels. */
export interface KittySourceRect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** A placement of a transmitted image. */
export interface KittyPlacement {
	readonly id: number;
	/** Placement id: placing again under the same id moves the placement instead of adding one. */
	readonly placement?: number;
	readonly columns: number;
	readonly rows: number;
	/** The part of the image shown; the whole image when absent. */
	readonly source?: KittySourceRect;
}

/** Place a transmitted image at the cursor, scaled into `columns`×`rows` cells; the cursor does not move. */
export function kittyPlace(place: KittyPlacement, multiplexer: Multiplexer = null): string {
	let control = `a=p,q=2,C=1,i=${place.id}`;
	if (place.placement !== undefined) control += `,p=${place.placement}`;
	const src = place.source;
	if (src) control += `,x=${src.x},y=${src.y},w=${src.w},h=${src.h}`;
	control += `,c=${place.columns},r=${place.rows}`;
	return wrapPassthrough(apc(control), multiplexer);
}

/** Create the virtual placement Unicode placeholder cells of `place.placement` refer to. */
export function kittyVirtualPlace(place: KittyPlacement, multiplexer: Multiplexer = null): string {
	let control = `a=p,U=1,q=2,i=${place.id}`;
	if (place.placement !== undefined) control += `,p=${place.placement}`;
	control += `,c=${place.columns},r=${place.rows}`;
	return wrapPassthrough(apc(control), multiplexer);
}

/** Free image `id`: its data and every placement (scrollback included). */
export function kittyDelete(id: number, multiplexer: Multiplexer = null): string {
	return wrapPassthrough(apc(`a=d,d=I,i=${id},q=2`), multiplexer);
}

/** Remove one placement of image `id`, keeping its data. */
export function kittyDeletePlacement(id: number, placement: number, multiplexer: Multiplexer = null): string {
	return wrapPassthrough(apc(`a=d,d=i,i=${id},p=${placement},q=2`), multiplexer);
}

/**
 * Rows of direct placements: row `i` places the `i`-th horizontal band of
 * the image (its share of `heightPx`) into `columns`×1 cells, under
 * placement id `firstPlacement + i`. The rows carry no text and measure 0
 * cells; the cursor never moves.
 */
export function kittyPlacementRows(
	image: { readonly id: number; readonly widthPx: number; readonly heightPx: number },
	columns: number,
	rows: number,
	firstPlacement: number,
	multiplexer: Multiplexer = null,
): string[] {
	const out: string[] = [];
	const w = Math.max(1, Math.round(image.widthPx));
	const h = Math.max(1, Math.round(image.heightPx));
	for (let row = 0; row < rows; row++) {
		const top = Math.floor((h * row) / rows);
		const bottom = Math.floor((h * (row + 1)) / rows);
		// More rows than pixel rows: repeat the nearest pixel row rather than placing an empty band.
		const y = bottom > top ? top : Math.min(top, h - 1);
		const band = Math.max(1, bottom - top);
		out.push(
			kittyPlace(
				{
					id: image.id,
					placement: firstPlacement + row,
					columns,
					rows: 1,
					source: { x: 0, y, w, h: band },
				},
				multiplexer,
			),
		);
	}
	return out;
}

/** Whether a `columns`×`rows` grid can be numbered with placeholder diacritics. */
export function kittyPlaceholdersFit(columns: number, rows: number): boolean {
	return columns >= 1 && rows >= 1 && columns <= KITTY_PLACEHOLDER_MAX_CELLS && rows <= KITTY_PLACEHOLDER_MAX_CELLS;
}

function rgb(value: number): [number, number, number] {
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * The placeholder grid of a virtual placement: one row per image row, each
 * exactly `columns` cells wide. Image id in the foreground color, placement
 * id in the underline color, both reset at the end of the row; every cell
 * carries its row and column diacritics so any slice of a row still
 * resolves. Ids must be at most {@link KITTY_MAX_ID}; the grid must fit
 * ({@link kittyPlaceholdersFit}).
 */
export function kittyPlaceholderRows(place: KittyPlacement): string[] {
	const [ir, ig, ib] = rgb(place.id);
	let style = `\x1b[38;2;${ir};${ig};${ib}m`;
	if (place.placement !== undefined) {
		const [pr, pg, pb] = rgb(place.placement);
		style += `\x1b[58:2::${pr}:${pg}:${pb}m`;
	}
	const out: string[] = [];
	for (let row = 0; row < place.rows; row++) {
		const rowMark = String.fromCodePoint(PLACEHOLDER_DIACRITICS[row]!);
		let cells = "";
		for (let col = 0; col < place.columns; col++) {
			cells += KITTY_PLACEHOLDER + rowMark + String.fromCodePoint(PLACEHOLDER_DIACRITICS[col]!);
		}
		out.push(`${style}${cells}\x1b[39;59m`);
	}
	return out;
}

/** Terminals whose kitty implementation renders U+10EEEE virtual placements. */
const PLACEHOLDER_TERMINALS: Record<string, true> = {
	kitty: true,
	ghostty: true,
	rio: true,
	otty: true,
	tern: true,
	monstar: true,
	rex: true,
};

const FLAG_WORDS: Record<string, boolean> = {
	"1": true,
	true: true,
	yes: true,
	on: true,
	"0": false,
	false: false,
	no: false,
	off: false,
};

function flag(value: string | undefined): boolean | undefined {
	const word = value?.trim().toLowerCase();
	return word !== undefined && Object.hasOwn(FLAG_WORDS, word) ? FLAG_WORDS[word] : undefined;
}

/**
 * Whether kitty Unicode placeholders should be used, for a detected
 * terminal (`kitty`, `ghostty`, `wezterm`, …, or `base` when unknown) and
 * the process environment.
 *
 * `PI_NO_KITTY_PLACEHOLDERS` turns them off; `PI_KITTY_PLACEHOLDERS` forces
 * them on or off. Inside Herdr panes the leaked identity of the outer
 * terminal is not trusted. Kitty graphics forced through a multiplexer
 * (`PI_FORCE_IMAGE_PROTOCOL=kitty`) use placeholders, since direct
 * placements cannot follow pane reflow; otherwise the terminal must be one
 * known to render them (others draw the placeholder as a literal glyph).
 */
export function kittyPlaceholdersSupported(
	terminal: string,
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	if (flag(env.PI_NO_KITTY_PLACEHOLDERS) === true) return false;
	const forced = flag(env.PI_KITTY_PLACEHOLDERS);
	if (forced !== undefined) return forced;
	const herdr = Boolean(env.HERDR_ENV || env.HERDR_PANE_ID || env.HERDR_TAB_ID || env.HERDR_WORKSPACE_ID);
	const forcedKitty = env.PI_FORCE_IMAGE_PROTOCOL?.trim().toLowerCase() === "kitty";
	if (forcedKitty && (herdr || Boolean(env.TMUX))) return true;
	if (herdr) return false;
	return PLACEHOLDER_TERMINALS[terminal.toLowerCase()] === true;
}

/** Free every image and placement the terminal holds (virtual placements excepted). */
export function kittyDeleteAll(multiplexer: Multiplexer = null): string {
	return wrapPassthrough(apc("a=d,d=A,q=2"), multiplexer);
}
