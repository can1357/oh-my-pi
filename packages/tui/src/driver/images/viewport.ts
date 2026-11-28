/** Graphics which are not text cells need explicit clipping/damage in an alternate-screen viewport. */
import { escapeLength, stripEscapes } from "../../text/ansi";
import { padTo, visibleWidth } from "../../text/width";
import { wrapTmuxPassthrough } from "../mux/tmux";
import { column } from "../output/ansi";
import { kittyDeletePlacement } from "./kitty";
import { type SixelBands, sixelBands, sliceSixel } from "./sixel-window";

const ANCHOR = /\x1b7\x1b\[(\d+)A/;
const TMUX = "\x1bPtmux;";
const ST = "\x1b\\";
const DIRECT_KITTY = /\x1b_Ga=p,q=2,C=1,i=(\d+),p=(\d+),/;
const DRAW = /\x1b(?:_Ga=[pT],|\]1337;File=|P(?:[\d;]*q|tmux;|\x1b(?:_G|\]1337;)))/;

interface Anchored {
	readonly row: number;
	readonly first: number;
	readonly prefix: string;
	readonly suffix: string;
	readonly sequence: string;
	/** The native encoder's band index is built lazily, the first time a viewport cuts this image. */
	bands?: SixelBands | null;
	crop?: { top: number; room: number; sequence: string };
}

// Row arrays belong to immutable paint blocks. An anchored tail of a huge, cached block is indexed
// only on its first partial paint; scrolling the same block doesn't scan the offscreen text again.
const kAnchors = Symbol("pi-tui.viewport-image-anchors");
interface ImageRows extends ReadonlyArray<string> {
	[kAnchors]?: Anchored[];
}
function anchors(rows: ImageRows): readonly Anchored[] {
	if (rows[kAnchors]) return rows[kAnchors];
	const result: Anchored[] = [];
	for (let i = 0; i < rows.length; ++i) {
		const row = rows[i]!;
		const anchor = ANCHOR.exec(row);
		if (!anchor) continue;
		const end = row.indexOf("\x1b8", anchor.index + anchor[0].length);
		if (end < 0) continue;
		result.push({
			row: i,
			first: i - Number(anchor[1]),
			prefix: row.slice(0, anchor.index),
			sequence: row.slice(anchor.index + anchor[0].length, end),
			suffix: row.slice(end + 2),
		});
	}
	if (Object.isExtensible(rows)) rows[kAnchors] = result;
	return result;
}

function crop(anchor: Anchored, top: number, room: number): string {
	const hit = anchor.crop;
	if (hit && hit.top === top && hit.room === room) return hit.sequence;
	const wrapped = anchor.sequence.startsWith(TMUX);
	if (anchor.bands === undefined) {
		const raw = wrapped
			? anchor.sequence.slice(TMUX.length, -ST.length).replaceAll("\x1b\x1b", "\x1b")
			: anchor.sequence;
		anchor.bands = sixelBands(raw) ?? null;
	}
	if (!anchor.bands) return "";
	let sequence = sliceSixel(anchor.bands, top, room);
	if (sequence && wrapped) sequence = wrapTmuxPassthrough(sequence);
	anchor.crop = { top, room, sequence };
	return sequence;
}

/** Repair the portion of an immutable block at [from,to) already copied to `frame`, starting at `dest`. */
export function clipViewportImages(
	frame: string[],
	dest: number,
	rows: readonly string[],
	from: number,
	to: number,
	cellHeight: number,
): void {
	if (to <= from || (from === 0 && to === rows.length)) return;
	for (const a of anchors(rows)) {
		if (a.first >= to) break;
		if (a.row < from || (a.first >= from && a.row < to)) continue;
		const start = Math.max(a.first, from);
		const last = Math.min(a.row, to - 1);
		const blank = a.prefix + a.suffix;
		if (a.row < to) frame[dest + a.row - from] = blank;
		const height = last - start + 1;
		const sequence = crop(a, (start - a.first) * cellHeight, height * cellHeight);
		if (!sequence) continue; // iTerm's inline File has no source rectangle. Keep its reserved rows.
		const target = dest + last - from;
		if (stripEscapes(frame[target]!) !== stripEscapes(blank)) continue; // Never replace another row's chrome.
		frame[target] = a.prefix + (height === 1 ? sequence : `\x1b7\x1b[${height - 1}A${sequence}\x1b8`) + a.suffix;
	}
}

/** Assign an alternate-screen position to a direct Kitty band and encode how to remove just that placement. */
export function alternatePlacement(row: string, y: number): { row: string; deletion: string } | undefined {
	if (!row.includes("\x1b_Ga=p,")) return undefined;
	const match = DIRECT_KITTY.exec(row);
	if (!match) return undefined;
	// Direct placement IDs are per image. The same blob can appear twice at the same fitted size
	// (an attachment reused in two turns). Address its alternate placements by screen row, outside
	// the 24-bit range reserved for virtual placements, so showing one copy never moves the other.
	const id = Number(match[1]);
	const placement = 0x100_0000 + y;
	const at = match.index + match[0].length - match[2]!.length - 1;
	const multiplexer = row.includes(TMUX) ? "tmux" : row.includes("\x1bP\x1b_G") ? "screen" : null;
	return {
		row: row.slice(0, at) + placement + row.slice(at + match[2]!.length),
		deletion: kittyDeletePlacement(id, placement, multiplexer),
	};
}

/** Dirty cells which row-string equality misses: an iTerm/SIXEL anchor draws into the rows above it. */
export function rasterDamage(previous: readonly string[], next: readonly string[]): Uint8Array | undefined {
	let damage: Uint8Array | undefined;
	for (let y = 0; y < next.length; y++) {
		const old = previous[y];
		if (!old || old === next[y]) continue;
		const match = ANCHOR.exec(old);
		if (match) (damage ??= new Uint8Array(next.length)).fill(1, Math.max(0, y - Number(match[1])), y + 1);
	}
	for (let y = 0; y < next.length; y++) {
		if (previous[y] !== next[y]) continue; // Already repainting this anchor.
		const match = ANCHOR.exec(next[y]!);
		if (!match) continue;
		for (let r = Math.max(0, y - Number(match[1])); r < y; r++) {
			if (previous[r] === next[r] && !damage?.[r]) continue;
			(damage ??= new Uint8Array(next.length))[y] = 1;
			break;
		}
	}
	return damage;
}

interface Drawing {
	readonly bytes: string;
	readonly without: string;
	readonly x: number;
	readonly above: number;
}

/** Isolate the one non-cell image drawing on a row, leaving its surrounding chrome in place. */
function drawing(row: string): Drawing | undefined {
	if (!row.includes("\x1b")) return undefined;
	const draw = DRAW.exec(row);
	if (!draw) return undefined;
	const anchor = ANCHOR.exec(row);
	const start = anchor?.index ?? draw.index;
	const prefix = row.slice(0, start);
	const cha = /\x1b\[(\d+)G$/.exec(prefix);
	let end = anchor ? row.indexOf("\x1b8", draw.index) + 2 : draw.index + escapeLength(row, draw.index);
	// GNU screen splits its DCS passthrough into chunks, including inner STs. The whole image is indivisible.
	if (!anchor && row.startsWith("\x1bP\x1b", draw.index)) end = row.lastIndexOf(ST) + ST.length;
	if (end <= draw.index) return undefined;
	return {
		bytes: row.slice(start, end),
		without: (cha ? prefix.slice(0, cha.index) : prefix) + row.slice(end),
		x: cha ? Number(cha[1]) - 1 : visibleWidth(prefix),
		above: Number(anchor?.[1] ?? 0),
	};
}

/** Add the scrollbar to a row without padding over the picture's pixels after drawing it. */
export function withImageGutter(row: string, width: number, mark: string): string {
	const image = drawing(row);
	if (!image) return padTo(row, width) + mark;
	return padTo(image.without, width) + mark + column(image.x) + image.bytes;
}

/**
 * Remove graphics under a sheet before text composition: slicing a control string as text can leak
 * its payload, or leave a last-row anchor drawing upward through the sheet. A placement next to (not
 * under) it is drawn after the text at its original column so trailing padding cannot erase it.
 */
export function maskOverlayImages(
	rows: string[],
	top: number,
	height: number,
	left: number,
	width: number,
	cellWidth: number,
): (() => void) | undefined {
	let kept: { row: number; bytes: string }[] | undefined;
	for (let y = top; y < rows.length; ++y) {
		const image = drawing(rows[y]!);
		if (!image || y - image.above >= top + height) continue;
		const cells = /(?:,c=|;width=)(\d+)/.exec(image.bytes);
		const raster = cells ? null : /q"1;1;(\d+);/.exec(image.bytes);
		const w = cells ? Number(cells[1]) : raster ? Math.ceil(Number(raster[1]) / cellWidth) : Infinity;
		const covered = left < image.x + w && image.x < left + width;
		if (!covered && y >= top + height) continue;
		rows[y] = image.without;
		if (!covered) (kept ??= []).push({ row: y, bytes: column(image.x) + image.bytes });
	}
	if (kept)
		return () => {
			for (const image of kept) rows[image.row] += image.bytes;
		};
	return undefined;
}
