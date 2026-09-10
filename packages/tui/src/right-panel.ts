/**
 * Right-side info panel compositing: floats panel blocks into the trailing
 * whitespace ("negative space") of rendered rows. Never overwrites visible
 * text — a block only lands on a run of rows whose content stays left of the
 * panel column — and hides entirely when there is no room.
 *
 * The TUI engine consumes the range form at the window stage of a frame
 * (after the window/commit math), where the visible viewport is known
 * exactly. Compositing there cannot touch rows committed to native
 * scrollback and does not interfere with the live-region / stable-prefix
 * protocol, because the composed frame itself is never mutated.
 */
import { RESERVED_IMAGE_ROW } from "./components/image";
import { isOsc66Line, osc66MaxScale, padding, replaceTabs, truncateToWidth, visibleWidth } from "./utils";

const TRAILING_PADDING_RE = /[ \t]+((?:\x1b\[[0-9;]*m)*)$/u;

/** Strip trailing whitespace padding from a line, keeping trailing SGR sequences. */
export function trimRightPadding(line: string): string {
	// Hot path: a trailing-padding match always ends in a space, tab, or the
	// `m` that terminates an SGR sequence, so bail cheaply otherwise.
	const last = line.charCodeAt(line.length - 1);
	if (last !== 0x20 && last !== 0x09 && last !== 0x6d) return line;
	return line.replace(TRAILING_PADDING_RE, "$1");
}

/** Fewer eligible rows than this hides the panel: too cramped to be useful. */
export const RIGHT_PANEL_MIN_ROWS = 6;
/** A panel column left of this hides the block: the terminal is too narrow. */
export const RIGHT_PANEL_MIN_COL = 30;
export type RightPanelAlignment = "top" | "bottom";
export interface RightPanelBlock {
	readonly lines: readonly string[];
	readonly alignment?: RightPanelAlignment;
}
export type RightPanelBlockInput = readonly string[] | RightPanelBlock;
function isRightPanelBlock(input: RightPanelBlockInput): input is RightPanelBlock {
	return !Array.isArray(input);
}

/**
 * Composite a single right-side panel into the trailing whitespace of
 * `baseLines`. Pure: returns the merged lines, or `baseLines` unchanged
 * (same reference) when the panel does not fit within the bottom
 * `viewportHeight` rows.
 */
export function compositeRightPanel(
	baseLines: string[],
	widget: readonly string[],
	width: number,
	viewportHeight: number,
	isOccupiedLine: (line: string, index: number) => boolean = () => false,
	isBackfilledOccupiedLine: (line: string, index: number) => boolean = () => false,
): string[] {
	return compositeRightPanels(
		baseLines,
		widget.length > 0 ? [widget] : [],
		width,
		viewportHeight,
		isOccupiedLine,
		isBackfilledOccupiedLine,
	);
}

/**
 * Composite multiple right-side panel blocks into the trailing whitespace of
 * `baseLines`, each one independently, searching the bottom `viewportHeight`
 * rows. Blocks are placed in the given order (the caller pre-sorts by
 * priority): each block claims the first free run of negative space tall
 * enough for it, those rows are then marked occupied, and a block that finds
 * no run is dropped on its own — the others still render. Pure: returns
 * merged lines, or `baseLines` unchanged (same reference) when nothing fits.
 * Never overwrites visible text or a visually occupied row.
 */
export function compositeRightPanels(
	baseLines: string[],
	blocks: readonly RightPanelBlockInput[],
	width: number,
	viewportHeight: number,
	isOccupiedLine: (line: string, index: number) => boolean = () => false,
	isBackfilledOccupiedLine: (line: string, index: number) => boolean = () => false,
): string[] {
	return compositeRightPanelsInRange(
		baseLines,
		blocks,
		width,
		Math.max(0, baseLines.length - viewportHeight),
		baseLines.length,
		isOccupiedLine,
		isBackfilledOccupiedLine,
	);
}

/**
 * Layout result reported by the compositor after deciding which blocks fit.
 * Passed to the optional `onLayout` callback of {@link compositeRightPanelsInRange}.
 */
export interface PanelLayoutResult {
	/** Indices of blocks that were placed on screen. */
	placedBlockIndices: readonly number[];
	/** Indices of blocks that were hidden (too narrow or no eligible run). */
	hiddenBlockIndices: readonly number[];
	/** Maximum panel content width that can fit (terminal width minus min col gap). */
	availableWidth: number;
	/** Number of rows in the search range. */
	searchRows: number;
}

/**
 * Range form: composite blocks only into rows of `[searchStart, searchEnd)`.
 *
 * When `onLayout` is provided, it is called once after compositing with the
 * placement result — which blocks were placed vs hidden, and the dimensions.
 * The compositor stays pure: the callback is the caller's responsibility.
 */
export function compositeRightPanelsInRange(
	baseLines: string[],
	blocks: readonly RightPanelBlockInput[],
	width: number,
	searchStart: number,
	searchEnd: number,
	isOccupiedLine: (line: string, index: number) => boolean = () => false,
	isBackfilledOccupiedLine: (line: string, index: number) => boolean = () => false,
	onLayout?: (result: PanelLayoutResult) => void,
): string[] {
	if (blocks.length === 0 || baseLines.length === 0) {
		onLayout?.({
			placedBlockIndices: [],
			hiddenBlockIndices: [],
			availableWidth: Math.max(0, width - RIGHT_PANEL_MIN_COL - 1),
			searchRows: Math.max(0, searchEnd - searchStart),
		});
		return baseLines;
	}
	searchStart = Math.max(0, searchStart);
	searchEnd = Math.min(baseLines.length, searchEnd);
	if (searchEnd - searchStart < RIGHT_PANEL_MIN_ROWS) {
		onLayout?.({
			placedBlockIndices: [],
			hiddenBlockIndices: blocks.map((_, i) => i),
			availableWidth: Math.max(0, width - RIGHT_PANEL_MIN_COL - 1),
			searchRows: searchEnd - searchStart,
		});
		return baseLines;
	}

	// Visually occupied rows (image protocol escapes, OSC 66 sized headings,
	// etc.) must not receive panel text. A raw image escape additionally backfills
	// the renderer's own reserved rows printed above it — but ONLY those: the image
	// component emits `RESERVED_IMAGE_ROW` (a non-plain zero-width sentinel) for the
	// cells it reserves, whereas ordinary Markdown spacing is a plain "" row. Walking
	// every zero-width row would wrongly mark an unrelated blank spacer above the
	// image as occupied and hide a `rightEditor` block that fits there.
	const occupied = new Array<boolean>(baseLines.length).fill(false);
	for (let i = 0; i < baseLines.length; i++) {
		const line = baseLines[i] ?? "";
		if (isOccupiedLine(line, i)) occupied[i] = true;
		if (isBackfilledOccupiedLine(line, i)) {
			occupied[i] = true;
			for (let j = i - 1; j >= 0 && baseLines[j] === RESERVED_IMAGE_ROW; j--) occupied[j] = true;
		}
	}

	// Content width with trailing padding ignored, computed lazily per row.
	const freeWidthCache: (number | undefined)[] = new Array(baseLines.length);
	const contentWidth = (row: number): number => {
		let w = freeWidthCache[row];
		if (w === undefined) {
			w = visibleWidth(trimRightPadding(baseLines[row] ?? ""));
			freeWidthCache[row] = w;
		}
		return w;
	};

	const placements: { start: number; block: readonly string[]; col: number; originalIndex: number }[] = [];
	for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
		const input = blocks[blockIdx];
		const block = isRightPanelBlock(input) ? input.lines : input;
		if (block.length === 0) continue;
		const normalizedBlock = normalizePanelBlock(block);
		if (normalizedBlock.some((line, index) => isBackfilledOccupiedLine(line, index))) continue;
		let panelWidth = 0;
		for (const line of normalizedBlock) panelWidth = Math.max(panelWidth, visibleWidth(line));
		const col = width - panelWidth - 1; // 1-col gap from the panel
		if (col < RIGHT_PANEL_MIN_COL) continue; // too narrow for this block — hide just this one
		const alignment = isRightPanelBlock(input) ? (input.alignment ?? "top") : "top";
		let placed = -1;
		const firstStart = alignment === "bottom" ? searchEnd - normalizedBlock.length : searchStart;
		const lastStart = alignment === "bottom" ? searchStart : searchEnd - normalizedBlock.length;
		const step = alignment === "bottom" ? -1 : 1;
		for (let start = firstStart; alignment === "bottom" ? start >= lastStart : start <= lastStart; start += step) {
			let ok = true;
			for (let k = 0; k < normalizedBlock.length; k++) {
				if (occupied[start + k] || contentWidth(start + k) > col) {
					ok = false;
					break;
				}
			}
			if (ok) {
				placed = start;
				break;
			}
		}
		if (placed < 0) continue; // no run tall enough — drop this block alone
		for (let k = 0; k < normalizedBlock.length; k++) occupied[placed + k] = true;
		placements.push({ start: placed, block: normalizedBlock, col, originalIndex: blockIdx });
	}

	if (placements.length === 0) {
		onLayout?.({
			placedBlockIndices: [],
			hiddenBlockIndices: blocks.map((_, i) => i),
			availableWidth: Math.max(0, width - RIGHT_PANEL_MIN_COL - 1),
			searchRows: searchEnd - searchStart,
		});
		return baseLines;
	}

	const out = baseLines.slice();
	for (const { start, block, col } of placements) {
		for (let k = 0; k < block.length; k++) {
			const base = trimRightPadding(out[start + k] ?? "");
			const truncatedBase = truncateToWidth(base, col);
			// If the base row carries color state or an in-flight OSC 8 hyperlink,
			// terminate it so the gap padding and the panel do not inherit them.
			const reset = truncatedBase.includes("\x1b[") ? "\x1b[0m" : "";
			const osc8Close = base.includes("\x1b]8;") ? "\x1b]8;;\x07" : "";
			out[start + k] = truncatedBase + reset + osc8Close + padding(Math.max(0, col - visibleWidth(base))) + block[k];
		}
	}

	const placedSet = new Set(placements.map(p => p.originalIndex));
	onLayout?.({
		placedBlockIndices: [...placedSet],
		hiddenBlockIndices: blocks.map((_, i) => i).filter(i => !placedSet.has(i)),
		availableWidth: Math.max(0, width - RIGHT_PANEL_MIN_COL - 1),
		searchRows: searchEnd - searchStart,
	});
	return out;
}

function normalizePanelBlock(block: readonly string[]): readonly string[] {
	const normalized = block.some(line => line.includes("\t"))
		? block.map(panelLine => replaceTabs(panelLine))
		: [...block];
	for (let row = 0; row < normalized.length; row++) {
		const heading = normalized[row] ?? "";
		if (!isOsc66Line(heading)) continue;
		const reservedRows = Math.max(0, osc66MaxScale(heading) - 1);
		for (let offset = 1; offset <= reservedRows && row + offset < normalized.length; offset++) {
			const index = row + offset;
			if (visibleWidth(normalized[index] ?? "") === 0) normalized[index] = RESERVED_IMAGE_ROW;
		}
	}
	return normalized;
}
