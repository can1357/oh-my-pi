/**
 * Shared scaffolding for the TUI selector/list/dashboard components: viewport
 * windowing, scrollbar-aware row widths, ScrollView rendering, selection
 * clamping, search-character classification, tab-cycling keys, and full-screen
 * padding. Behaviour is identical to the per-component copies these helpers
 * replace.
 */
import { extractPrintableText, matchesKey, ScrollView } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/**
 * Render `rows` through a {@link ScrollView} with the shared list theme (muted
 * track / accent thumb) and an "auto" scrollbar, positioned at `scrollOffset`.
 * Returns the rendered lines for the caller to append to its output.
 */
export function renderScrollableList(
	rows: readonly string[],
	options: { width: number; totalRows: number; scrollOffset: number },
): readonly string[] {
	const sv = new ScrollView(rows, {
		height: rows.length,
		scrollbar: "auto",
		totalRows: options.totalRows,
		theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
	});
	sv.setScrollOffset(options.scrollOffset);
	return sv.render(options.width);
}

/**
 * Center a viewport window of `maxVisible` rows on `selectedIndex` within a
 * list of `total` rows, clamped to valid bounds. Used by the selection-centered
 * list panes (history search, tree selector).
 */
export function centeredWindow(
	selectedIndex: number,
	total: number,
	maxVisible: number,
): { startIndex: number; endIndex: number } {
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), total - maxVisible));
	const endIndex = Math.min(startIndex + maxVisible, total);
	return { startIndex, endIndex };
}

/**
 * Width available for row content, reserving the rightmost column for the
 * scrollbar when the list overflows its visible window.
 */
export function contentRowWidth(width: number, total: number, maxVisible: number): number {
	const overflow = total > maxVisible;
	return Math.max(0, width - (overflow ? 1 : 0));
}

/**
 * Clamp `selectedIndex` into `[0, total)` and nudge `scrollOffset` so the
 * selection stays within the visible window of `maxVisible` rows. Returns the
 * adjusted pair; on an empty list both reset to 0.
 */
export function clampSelection(
	selectedIndex: number,
	scrollOffset: number,
	total: number,
	maxVisible: number,
): { selectedIndex: number; scrollOffset: number } {
	if (total === 0) {
		return { selectedIndex: 0, scrollOffset: 0 };
	}

	const selected = Math.max(0, Math.min(selectedIndex, total - 1));

	let scroll = scrollOffset;
	if (selected < scroll) {
		scroll = selected;
	} else if (selected >= scroll + maxVisible) {
		scroll = selected - maxVisible + 1;
	}

	return { selectedIndex: selected, scrollOffset: scroll };
}

/**
 * Classify a key event for search-query text entry. Returns the single
 * printable character to append to the query, or `null` when the key is not a
 * searchable character: non-printable, multi-byte, or a reserved `j`/`k`
 * navigation key.
 */
export function searchableChar(data: string): string | null {
	const printableText = extractPrintableText(data);
	if (printableText && printableText.length === 1) {
		const printableCharCode = printableText.charCodeAt(0);
		if (printableCharCode > 32 && printableCharCode < 127) {
			if (printableText === "j" || printableText === "k") {
				return null;
			}
			return printableText;
		}
	}
	return null;
}

/**
 * Handle the shared tab-cycling keys: Tab/Right advance to the next tab,
 * Shift+Tab/Left to the previous. Invokes `switchTab` with the direction and
 * returns true when the key was consumed.
 */
export function handleTabSwitchKey(data: string, switchTab: (direction: 1 | -1) => void): boolean {
	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		switchTab(1);
		return true;
	}
	if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
		switchTab(-1);
		return true;
	}
	return false;
}

/**
 * Pad `lines` with blank rows up to `rows` so a full-screen overlay covers the
 * viewport instead of letting the transcript peek through below it. Copies
 * before padding — the source array may be component-owned and must not be
 * mutated.
 */
export function padLinesToHeight(lines: readonly string[], rows: number): readonly string[] {
	if (lines.length >= rows) return lines;
	const padded = lines.slice();
	while (padded.length < rows) padded.push("");
	return padded;
}
