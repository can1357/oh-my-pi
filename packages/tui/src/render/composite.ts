import { TERMINAL } from "../terminal-capabilities";
import { extractSegments, sliceByColumn, sliceWithWidth, visibleWidth } from "../utils";

const SEGMENT_RESET = "\x1b[0m";

/** Splice overlay content into a base line at a specific column. Single-pass optimized. */
export function compositeLineAt(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (TERMINAL.isImageLine(baseLine)) {
		// Full-width overlays such as /switch are opaque: replace the
		// Unicode placeholder cells so the image cannot cover the modal.
		// Partial overlays cannot safely splice placement control sequences.
		if (startCol !== 0 || overlayWidth < totalWidth) return baseLine;
		const overlay = sliceWithWidth(overlayLine, 0, totalWidth, true);
		return SEGMENT_RESET + overlay.text + " ".repeat(Math.max(0, totalWidth - overlay.width));
	}

	// Single pass through baseLine extracts both before and after segments
	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);

	// Extract overlay with width tracking (strict=true to exclude wide chars at boundary)
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);

	// Pad segments to target widths
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);

	// Compose result
	const r = SEGMENT_RESET;
	const result =
		base.before +
		" ".repeat(beforePad) +
		r +
		overlay.text +
		" ".repeat(overlayPad) +
		r +
		base.after +
		" ".repeat(afterPad);

	// CRITICAL: Always verify and truncate to terminal width.
	// This is the final safeguard against width overflow which would crash the TUI.
	// Width tracking can drift from actual visible width due to:
	// - Complex ANSI/OSC sequences (hyperlinks, colors)
	// - Wide characters at segment boundaries
	// - Edge cases in segment extraction
	const resultWidth = visibleWidth(result);
	if (resultWidth <= totalWidth) {
		return result;
	}
	// Truncate with strict=true to ensure we don't exceed totalWidth
	return sliceByColumn(result, 0, totalWidth, true);
}
