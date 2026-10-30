/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@earendil-works/pi-tui` or `@mariozechner/pi-tui`.
 *
 * The historical root exported `decodeKittyPrintable`; the canonical TUI now
 * exposes the equivalent, broader `decodePrintableKey` helper. Keep the legacy
 * name available without reintroducing it into the canonical package surface.
 */
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "@oh-my-pi/pi-tui/utils";

export * from "@oh-my-pi/pi-tui";
export { decodePrintableKey as decodeKittyPrintable } from "@oh-my-pi/pi-tui";

/**
 * Legacy pi-tui `compositeTuiLine`, ported verbatim from upstream pi-tui
 * (identical in 1.0.2 and 1.1.0). NOT an alias of omp's `compositeLineAt`:
 * upstream's segment reset closes OSC 8 hyperlinks (`\x1b]8;;\x07`) so the
 * overlay and suffix cannot inherit an open link, and image-line bases pass
 * through untouched; omp's canonical version resets only SGR and replaces
 * full-width overlays over image lines. Extensions built against upstream
 * (e.g. `pi-optchat` overlaying status text on hyperlink-bearing lines)
 * depend on the upstream reset semantics.
 */
const TUI_SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (TERMINAL.isImageLine(baseLine)) {
		return baseLine;
	}
	// Single pass through baseLine extracts both before and after segments.
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	// Extract overlay with width tracking (strict=true to exclude wide chars at boundary).
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	// Pad segments to target widths.
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		TUI_SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		TUI_SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);
	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

/** Report canonical terminal capabilities through the legacy Pi TUI shape. */
export function getCapabilities(): {
	images: "kitty" | "iterm2" | null;
	trueColor: boolean;
	hyperlinks: boolean;
} {
	const images =
		TERMINAL.imageProtocol === ImageProtocol.Kitty
			? "kitty"
			: TERMINAL.imageProtocol === ImageProtocol.Iterm2
				? "iterm2"
				: null;
	return { images, trueColor: TERMINAL.trueColor, hyperlinks: TERMINAL.hyperlinks };
}

/**
 * Delete one Kitty graphics image by id, matching the legacy Pi TUI helper.
 *
 * Returns the bare control sequence exactly like upstream Pi: legacy callers
 * (e.g. pi-sprite) apply their own tmux passthrough wrapping, so wrapping here
 * would double-wrap under tmux and the outer terminal would drop the command.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/** Delete every Kitty graphics image using the legacy Pi TUI bare sequence. */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}
