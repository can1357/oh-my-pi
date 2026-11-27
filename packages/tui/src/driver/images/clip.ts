/**
 * A window of a block's rows that may cut an image: the fullscreen
 * transcript shows any slice of a block, not only its tail.
 *
 * Kitty direct placements carry a source band on every row and need nothing.
 * Sequences anchored on an image's last row (SIXEL, iTerm2, kitty without
 * ids; see anchor.ts) draw the whole picture upward from that row, so a
 * window that cuts one would let it spill out of its rows (cut at the top) or
 * drop it (cut at the bottom). A SIXEL raster is cropped to the rows in view
 * and anchored on the last of them; any other anchored image keeps reserved
 * rows until it is wholly in view.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { wrapTmuxPassthrough } from "../mux/tmux";
import { cropSixelTop } from "./sixel-crop";

/** An anchored image's last row: save the cursor, move up `n` rows, draw, restore. */
const ANCHORED = /\x1b7\x1b\[(\d+)A([\s\S]*?)\x1b8/;
const ANCHOR_START = "\x1b7\x1b[";
const SIXEL = /^\x1bP[0-9;]*q/;
const TMUX_OPEN = "\x1bPtmux;";
const ST = "\x1b\\";

/** Crops of the anchored rows seen lately, by row (a row string is stable while its block is cached). */
const crops = new Map<string, Map<string, string | null>>();
const MAX_CROPPED_ROWS = 4;

// A paint produces immutable rows. Discover image anchors once, including the common case of none.
const anchorsByRows = new WeakMap<readonly string[], readonly number[]>();

function anchorOffsets(rows: readonly string[]): readonly number[] {
	const cached = anchorsByRows.get(rows);
	if (cached) return cached;
	const offsets: number[] = [];
	for (let i = 0; i < rows.length; i++) {
		if (rows[i]!.includes(ANCHOR_START)) offsets.push(i);
	}
	anchorsByRows.set(rows, offsets);
	return offsets;
}

/**
 * Rows `from` (inclusive) to `to` (exclusive) of a block's `rows`, with every
 * anchored image the window cuts redrawn for the rows in view (SIXEL) or held
 * back (anything else). `cellHeight` is the pixel height of a cell, as the
 * image was fitted with.
 */
export function windowImageRows(rows: readonly string[], from: number, to: number, cellHeight: number): string[] {
	const start = Math.max(0, from);
	const end = Math.min(rows.length, to);
	const window = rows.slice(start, end);
	if (end <= start || (start === 0 && end === rows.length)) return window;
	const offsets = anchorOffsets(rows);
	let low = 0;
	let high = offsets.length;
	while (low < high) {
		const mid = low + Math.floor((high - low) / 2);
		if (offsets[mid]! < start) low = mid + 1;
		else high = mid;
	}
	for (let i = low; i < offsets.length; i++) {
		const last = offsets[i]!;
		const row = rows[last]!;
		const match = ANCHORED.exec(row);
		if (!match) continue;
		const first = last - Number(match[1]);
		// Anchored rows come in order: one starting below the window ends the search.
		if (first >= end) break;
		if (first >= start && last < end) continue;
		const top = Math.max(first, start);
		const bottom = Math.min(last, end - 1);
		const shown = bottom - top + 1;
		const without = row.replace(match[0], "");
		if (last < end) window[last - start] = without;
		const cropped = cropAnchored(row, match[2]!, (top - first) * cellHeight, shown * cellHeight);
		if (!cropped) continue;
		// The image rows of a container share its chrome: the row the crop lands on must look like the
		// anchored row without its drawing, or the crop would not land on the image's own columns.
		const host = window[bottom - start]!;
		if (Bun.stripANSI(host) !== Bun.stripANSI(without)) continue;
		window[bottom - start] = row.replace(match[0], shown === 1 ? cropped : `\x1b7\x1b[${shown - 1}A${cropped}\x1b8`);
	}
	return window;
}

/** `sequence` (the drawing of anchored `row`) cropped to `height` pixels from `pixels` down; null when it cannot be. */
function cropAnchored(row: string, sequence: string, pixels: number, height: number): string | null {
	const key = `${pixels}:${height}`;
	let known = crops.get(row);
	const hit = known?.get(key);
	if (hit !== undefined) return hit;
	let result: string | null = null;
	try {
		if (SIXEL.test(sequence)) {
			result = cropSixelTop(sequence, pixels, height) || null;
		} else if (sequence.startsWith(TMUX_OPEN) && sequence.endsWith(ST)) {
			const inner = sequence.slice(TMUX_OPEN.length, -ST.length).replaceAll("\x1b\x1b", "\x1b");
			if (SIXEL.test(inner)) {
				const cropped = cropSixelTop(inner, pixels, height);
				result = cropped ? wrapTmuxPassthrough(cropped) : null;
			}
		}
	} catch (error) {
		logger.debug("pi-tui: holding back a SIXEL image the window cuts", { error: String(error) });
		result = null;
	}
	if (!known) {
		if (crops.size >= MAX_CROPPED_ROWS) {
			const oldest = crops.keys().next().value;
			if (oldest !== undefined) crops.delete(oldest);
		}
		known = new Map();
		crops.set(row, known);
	}
	if (known.size >= MAX_CROPPED_ROWS) {
		const oldest = known.keys().next().value;
		if (oldest !== undefined) known.delete(oldest);
	}
	known.set(key, result);
	return result;
}
