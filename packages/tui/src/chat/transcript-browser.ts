import type { Component } from "../tui";
import { type ScrollRangeAnchor, ScrollView } from "../components/scroll-view";
import { DynamicBorder } from "../chrome/dynamic-border";
import { truncateToWidth } from "../utils";
import { theme } from "../theme/theme";
import {
	composeOutlineColumn,
	type ComposedColumn,
	OutlineRowCache,
	type OutlineStyle,
	type OutlineTarget,
	outlineVisibility,
} from "./transcript-outline";

/** Logical body rows and optional selection supplied by a transcript browser controller. */
export interface TranscriptBrowserBody {
	lines: readonly string[];
	anchor?: ScrollRangeAnchor;
}

/** One complete browser frame. Header and footer rows are inset by one column. */
export interface TranscriptBrowserFrame {
	header: readonly string[];
	body: TranscriptBrowserBody;
	footer: readonly string[];
}

/** Widths available while composing a transcript browser frame. */
export interface TranscriptBrowserRenderContext {
	/** Width passed to {@link TranscriptBrowser.render}. */
	frameWidth: number;
	/** Stable transcript width, reserving the final column for an automatic scrollbar. */
	contentWidth: number;
	/** Width for inset header/footer children such as an editor. */
	chromeWidth: number;
}

/** Construction options for the shared transcript browser viewport and frame. */
export interface TranscriptBrowserOptions {
	/** Explicit height budget supplied by the fullscreen host. */
	getHeight: () => number;
	/** Domain controller which supplies header, body, footer, and optional selection. */
	frame: (context: TranscriptBrowserRenderContext) => TranscriptBrowserFrame;
	/** Preserve the historical three-row minimum used by transcript overlays. */
	minimumBodyRows?: number;
	/** Start in append-follow mode; manual scrolling updates the mode automatically. */
	followBottom?: boolean;
}

/** Prepared transcript rows, visibility, and nearest valid selection. */
export interface PreparedTranscriptOutline {
	childRows: Array<readonly string[]>;
	visible: boolean[];
	selected: number;
}

/** Options for composing the standard single-column dotted transcript outline. */
export interface TranscriptOutlineComposition {
	children: readonly Component[];
	targets: readonly OutlineTarget[];
	selected: number;
	columnWidth: number;
	/** Reuse rows already prepared for custom branch/block composition in the same frame. */
	prepared?: PreparedTranscriptOutline;
	from?: number;
	to?: number;
	header?: string[];
	style?: OutlineStyle;
}

interface BrowserLayout {
	bodyTop: number;
	bodyHeight: number;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/** Nearest visible target, preferring the preceding item just like the legacy selectors. */
export function nearestVisibleOutlineTarget(visible: readonly boolean[], selected: number): number {
	if (selected < 0 || selected >= visible.length) return visible.findIndex(Boolean);
	if (visible[selected] !== false) return selected;
	for (let above = selected - 1; above >= 0; above--) {
		if (visible[above] !== false) return above;
	}
	for (let below = selected + 1; below < visible.length; below++) {
		if (visible[below] !== false) return below;
	}
	return selected;
}

/**
 * Shared framed viewport for transcript browsers.
 *
 * Domain controllers retain loading, actions, and branch/block presentation;
 * this component owns outline row caching, frame sizing, scroll state,
 * selection anchoring, append-follow behavior, and frame-to-body coordinates.
 */
export class TranscriptBrowser implements Component {
	readonly debugChildren: readonly Component[];

	readonly #options: TranscriptBrowserOptions;
	readonly #scrollView: ScrollView;
	readonly #border = new DynamicBorder();
	readonly #rowCache = new OutlineRowCache();
	#followBottom: boolean;
	#layout: BrowserLayout | undefined;
	#cachedLines: readonly string[] | undefined;

	constructor(options: TranscriptBrowserOptions) {
		this.#options = options;
		this.#followBottom = options.followBottom ?? false;
		this.#scrollView = new ScrollView([], {
			height: 0,
			scrollbar: "auto",
			followTail: this.#followBottom,
			theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
		});
		this.debugChildren = [this.#scrollView, this.#border];
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#border.invalidate();
		this.#scrollView.invalidate();
	}

	/** Prompt-zone-safe rendered rows for outline composition at `columnWidth`. */
	renderOutlineRows(children: readonly Component[], columnWidth: number): Array<readonly string[]> {
		return this.#rowCache.rows(children, Math.max(10, columnWidth - 4));
	}

	/** Compute target visibility and snap a collapsed selection to the nearest rendered item. */
	prepareOutline(
		children: readonly Component[],
		targets: readonly OutlineTarget[],
		selected: number,
		columnWidth: number,
	): PreparedTranscriptOutline {
		const childRows = this.renderOutlineRows(children, columnWidth);
		const visible = outlineVisibility(childRows, targets);
		return {
			childRows,
			visible,
			selected: nearestVisibleOutlineTarget(visible, selected),
		};
	}

	/** Compose the standard single-column outline using the browser-owned row cache. */
	composeOutline(options: TranscriptOutlineComposition): PreparedTranscriptOutline & { column: ComposedColumn } {
		const prepared =
			options.prepared ??
			this.prepareOutline(options.children, options.targets, options.selected, options.columnWidth);
		return {
			...prepared,
			column: composeOutlineColumn(
				prepared.childRows,
				options.from ?? 0,
				options.to ?? options.children.length,
				options.targets,
				prepared.selected,
				options.columnWidth,
				options.header,
				options.style,
			),
		};
	}

	/** Scroll logical body rows. Returns whether the offset changed. */
	scroll(delta: number): boolean {
		const before = this.#scrollView.getScrollOffset();
		this.#scrollView.scroll(delta);
		this.#syncFollowBottom();
		return this.#scrollView.getScrollOffset() !== before;
	}

	/** Apply the ScrollView navigation key set. */
	handleScrollKey(data: string): boolean {
		if (!this.#scrollView.handleScrollKey(data)) return false;
		this.#syncFollowBottom();
		return true;
	}

	scrollToTop(): void {
		this.#scrollView.scrollToTop();
		this.#syncFollowBottom();
	}

	scrollToBottom(): void {
		this.#scrollView.scrollToBottom();
		this.#syncFollowBottom();
	}

	/** Whether an anchor identity has successfully been applied to the viewport. */
	hasAnchored(id: string): boolean {
		return this.#scrollView.hasRevealedRange(id);
	}

	/**
	 * Translate a 0-based frame mouse point into the logical, scrolled body.
	 * Returns undefined for borders, header/footer rows, and unpainted body rows.
	 */
	toContentPoint(frameRow: number, frameCol: number): { row: number; col: number } | undefined {
		const layout = this.#layout;
		if (!layout) return undefined;
		const localRow = Math.trunc(frameRow) - layout.bodyTop;
		if (localRow < 0 || localRow >= layout.bodyHeight) return undefined;
		const row = this.#scrollView.logicalRowAt(localRow);
		if (row === undefined) return undefined;
		return {
			row,
			col: Math.max(0, Math.trunc(frameCol)),
		};
	}

	render(width: number): readonly string[] {
		const frameWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const context: TranscriptBrowserRenderContext = {
			frameWidth,
			contentWidth: Math.max(1, frameWidth - 1),
			chromeWidth: Math.max(1, frameWidth - 2),
		};
		const frame = this.#options.frame(context);
		const heightValue = this.#options.getHeight();
		const height = Number.isFinite(heightValue) ? Math.max(0, Math.trunc(heightValue)) : 0;
		const borderRows = frameWidth > 0 ? 3 : 0;
		const chromeRows = frame.header.length + frame.footer.length + borderRows;
		const minimumBodyRows = Math.max(0, Math.trunc(this.#options.minimumBodyRows ?? 3));
		const bodyHeight = Math.max(minimumBodyRows, height - chromeRows);
		this.#layout = { bodyTop: frame.header.length + (frameWidth > 0 ? 2 : 0), bodyHeight };

		this.#scrollView.setLines(frame.body.lines);
		this.#scrollView.setHeight(bodyHeight);
		if (frame.body.anchor && this.#scrollView.revealRange(frame.body.anchor, context.contentWidth)) {
			this.#followBottom = false;
			this.#scrollView.setFollowTail(false);
		}

		const border = frameWidth > 0 ? this.#border.render(frameWidth) : [];
		const output: string[] = [];
		output.push(...border);
		for (const line of frame.header) output.push(this.#chromeLine(line, frameWidth));
		output.push(...border);
		output.push(...this.#scrollView.render(frameWidth));
		for (const line of frame.footer) output.push(this.#chromeLine(line, frameWidth));
		output.push(...border);
		const cached = this.#cachedLines;
		if (cached && sameLines(cached, output)) return cached;
		this.#cachedLines = output;
		return output;
	}

	#syncFollowBottom(): void {
		if (!this.#options.followBottom) return;
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
		this.#scrollView.setFollowTail(this.#followBottom);
	}

	#chromeLine(line: string, width: number): string {
		if (width <= 0) return "";
		return ` ${truncateToWidth(line, Math.max(0, width - 1))}`;
	}
}
