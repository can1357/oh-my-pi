/**
 * Shared renderer for a horizontal row of colored "segments" styled after the
 * status line: each segment is colored by its track position from the theme's
 * own palette, the active one is filled as a powerline chip (its color as the
 * background, a luminance-matched label, flanked by triangle caps) and the
 * rest are plain colored labels joined by a thin separator.
 *
 * Used by the plan-mode model-tier slider ({@link HookSelectorComponent}) and
 * the ctrl+p role-cycle status so both surfaces read identically.
 */
import { type ThemeColor, theme } from "../theme/theme";

export interface TrackSegment {
	label: string;
}

const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

/** Vivid theme colors for position-based segment coloring, in preference
 *  order. Themes alias many of these to the same value (titanium maps most of
 *  the syntax set onto its accent), so {@link resolveSegmentPalette} dedupes
 *  by resolved escape and hands position i the i-th distinct color. */
const SEGMENT_COLOR_CANDIDATES: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"mdCode",
	"mdLink",
	"syntaxString",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxOperator",
	"syntaxVariable",
];

/**
 * Resolve up to `count` theme colors that render distinctly under the active
 * theme, in candidate preference order. May return fewer than `count` when the
 * theme has fewer distinct hues (e.g. monochrome themes) — callers wrap with
 * modulo. Never returns an empty array: `accent` always resolves.
 */
export function resolveSegmentPalette(count: number): ThemeColor[] {
	const palette: ThemeColor[] = [];
	const seen = new Set<string>();
	for (const color of SEGMENT_COLOR_CANDIDATES) {
		const ansi = theme.getFgAnsi(color);
		if (seen.has(ansi)) continue;
		seen.add(ansi);
		palette.push(color);
		if (palette.length >= count) break;
	}
	return palette;
}

/**
 * Render `segments` as a colored chip track with `activeIndex` filled. Returns
 * a single line of styled text with no surrounding caption or arrows — callers
 * frame it as they need.
 */
export function renderSegmentTrack(segments: TrackSegment[], activeIndex: number): string {
	// Powerline triangles point *into* the chip so the colored caps merge with
	// the filled body: left cap points left, right cap points right.
	const capLeft = theme.sep.powerlineRight;
	const capRight = theme.sep.powerlineLeft;
	const thinSep = theme.fg("statusLineSep", theme.sep.powerlineThin);
	const palette = resolveSegmentPalette(segments.length);

	let track = "";
	segments.forEach((segment, i) => {
		if (i > 0) {
			// A thin separator reads cleanly only between two plain labels; the chip
			// caps already delimit the active segment, so pad around it instead.
			track += i === activeIndex || i - 1 === activeIndex ? "  " : ` ${thinSep} `;
		}
		const color = palette[i % palette.length];
		const fg = theme.getFgAnsi(color);
		if (i !== activeIndex) {
			track += `${fg}${segment.label}${FG_RESET}`;
			return;
		}
		const bg = fg.replace("\x1b[38;", "\x1b[48;");
		const label = `${bg}${theme.getContrastFgAnsi(color)}\x1b[1m ${segment.label} \x1b[22m${BG_RESET}`;
		track += `${fg}${capLeft}${label}${fg}${capRight}${FG_RESET}`;
	});
	return track;
}
