/**
 * Inline-image state the native encoder (`InlineImage`) renders against:
 * the terminal's cell size, and the per-pass request built from it and the
 * {@link TERMINAL} snapshot. Protocol encoding, header sniffing and SIXEL
 * encodes live in the native `InlineImage`; this module only gathers what a
 * render depends on.
 */
import type { ImageDimensions, ImageRenderRequest } from "@oh-my-pi/pi-natives";
import { engineImageProtocol, getTerminalBackgroundColor, TERMINAL } from "./terminal-capabilities";

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

// Default cell dimensions - updated when the terminal answers the cell-size query.
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/** Text an image renders as when it is not drawn as a graphic. */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions | null, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}

/** How an {@link inlineImageRequest} render is bound. */
export interface InlineImagePass {
	/** Rows bound for native scrollback: a SIXEL encode cannot wait. */
	scrollback?: boolean;
	/** An out-of-order measuring render that claims no budget slot. */
	measuring?: boolean;
	/** The caller still holds the rows the previous render returned. */
	cached?: boolean;
}

/** One `InlineImage.render` request for a `maxColumns`×`maxRows` box under the current terminal. */
export function inlineImageRequest(
	maxColumns: number,
	maxRows: number | undefined,
	pass: InlineImagePass = {},
): ImageRenderRequest {
	const protocol = engineImageProtocol(TERMINAL.imageProtocol);
	return {
		protocol,
		maxColumns,
		maxRows,
		cellWidthPx: cellDimensions.widthPx,
		cellHeightPx: cellDimensions.heightPx,
		kittyPlaceholders: TERMINAL.kittyUnicodePlaceholders,
		tmux: TERMINAL.tmux,
		backgroundRgb: protocol === "sixel" ? getTerminalBackgroundColor() : 0,
		scrollback: pass.scrollback === true,
		measuring: pass.measuring === true,
		cached: pass.cached === true,
	};
}
