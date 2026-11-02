import type { Component } from "../../tui";
import { OverlayPanel, PanelDivider, PanelRows } from "../../chrome/overlay-box";
import { type ScrollRangeAnchor, ScrollView } from "../../components/scroll-view";
import { theme } from "../../theme/theme";

const EMPTY_LINES: readonly string[] = [];
const EMPTY_COMPONENTS: readonly Component[] = [];

/** One complete debug-viewer frame. */
export interface DebugViewerFrameContent {
	readonly header: readonly string[];
	readonly body: {
		readonly lines: readonly string[];
		readonly anchor?: ScrollRangeAnchor;
	};
	readonly footer: readonly string[];
}

/** Dimensions supplied while a debug viewer prepares its domain rows. */
export interface DebugViewerFrameContext {
	/** Panel content width with one column reserved for an overflowing viewport's scrollbar. */
	readonly contentWidth: number;
	readonly bodyHeight: number;
}

export interface DebugViewerFrameOptions {
	readonly title: string;
	readonly getHeight: () => number;
	readonly headerRows: number;
	readonly footerRows: number;
	readonly frame: (context: DebugViewerFrameContext) => DebugViewerFrameContent;
	readonly minimumBodyRows?: number;
	readonly followTail?: boolean;
}

/**
 * Debug-local adapter for the fullscreen viewers' common rounded panel and viewport.
 * Domain controllers retain filtering, selection, formatting, copy, and live data;
 * this component owns chrome sizing, persistent scroll state, selection reveal, and
 * frame-row to logical-body translation.
 */
export class DebugViewerFrame implements Component {
	readonly #options: DebugViewerFrameOptions;
	readonly #header = new PanelRows();
	readonly #viewport: ScrollView;
	readonly #footer = new PanelRows();
	readonly #panel: OverlayPanel;
	readonly #headerRows: number;
	readonly #footerRows: number;
	readonly #minimumBodyRows: number;
	readonly #supportsFollowTail: boolean;
	#followTail: boolean;
	#bodyLines: readonly string[] = EMPTY_LINES;
	#renderedBodyHeight = 0;
	#disposed = false;

	constructor(options: DebugViewerFrameOptions) {
		this.#options = options;
		this.#headerRows = Math.max(0, Math.trunc(options.headerRows));
		this.#footerRows = Math.max(0, Math.trunc(options.footerRows));
		this.#minimumBodyRows = Math.max(0, Math.trunc(options.minimumBodyRows ?? 3));
		this.#supportsFollowTail = options.followTail ?? false;
		this.#followTail = this.#supportsFollowTail;
		this.#header.setHeight(this.#headerRows);
		this.#footer.setHeight(this.#footerRows);
		this.#viewport = new ScrollView([], {
			height: this.getBodyHeight(),
			scrollbar: "auto",
			followTail: this.#followTail,
			theme: { track: text => theme.fg("muted", text), thumb: text => theme.fg("accent", text) },
		});
		this.#panel = new OverlayPanel(options.title);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#viewport);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	get debugChildren(): readonly Component[] {
		return this.#disposed ? EMPTY_COMPONENTS : [this.#panel];
	}

	getBodyHeight(): number {
		const heightValue = this.#options.getHeight();
		const height = Number.isFinite(heightValue) ? Math.max(0, Math.trunc(heightValue)) : 0;
		return Math.max(this.#minimumBodyRows, height - this.#headerRows - this.#footerRows - 4);
	}

	isFollowingTail(): boolean {
		return !this.#disposed && this.#followTail;
	}

	setFollowTail(follow: boolean): void {
		if (this.#disposed || !this.#supportsFollowTail) return;
		this.#followTail = follow;
		this.#viewport.setFollowTail(follow);
		if (follow) this.#viewport.scrollToBottom();
	}

	/** Manual viewport movement suspends append-follow, including at the current tail. */
	scroll(delta: number): void {
		if (this.#disposed) return;
		this.setFollowTail(false);
		this.#viewport.scroll(delta);
	}

	setScrollOffset(offset: number): void {
		if (this.#disposed) return;
		this.setFollowTail(false);
		this.#viewport.setScrollOffset(offset);
	}

	/** Whether a 0-based rendered frame row lies inside the last rendered body region. */
	isBodyFrameRow(frameRow: number): boolean {
		const localRow = Math.trunc(frameRow) - (this.#headerRows + 2);
		return localRow >= 0 && localRow < this.#renderedBodyHeight;
	}

	/** Map a 0-based rendered frame row into the complete logical body buffer. */
	toBodyRow(frameRow: number): number | undefined {
		if (!this.isBodyFrameRow(frameRow)) return undefined;
		return this.#viewport.logicalRowAt(Math.trunc(frameRow) - (this.#headerRows + 2));
	}

	/** Map a 0-based rendered frame row into the fixed header region. */
	toHeaderRow(frameRow: number): number | undefined {
		if (this.#disposed) return undefined;
		const localRow = Math.trunc(frameRow) - 1;
		return localRow >= 0 && localRow < this.#headerRows ? localRow : undefined;
	}

	invalidate(): void {
		if (this.#disposed) return;
		this.#panel.invalidate();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#bodyLines = EMPTY_LINES;
		this.#renderedBodyHeight = 0;
		this.#panel.dispose();
	}

	render(width: number): readonly string[] {
		if (this.#disposed) return EMPTY_LINES;
		const frameWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const bodyHeight = this.getBodyHeight();
		const context: DebugViewerFrameContext = {
			contentWidth: Math.max(1, frameWidth - 5),
			bodyHeight,
		};
		const frame = this.#options.frame(context);
		this.#header.setLines(frame.header);
		this.#footer.setLines(frame.footer);
		this.#viewport.setHeight(bodyHeight);
		this.#setBodyLines(frame.body.lines);
		this.#renderedBodyHeight = bodyHeight;
		const anchor: ScrollRangeAnchor | undefined = frame.body.anchor
			? { ...frame.body.anchor, oversized: "start" }
			: undefined;
		if (this.#viewport.revealRange(anchor, context.contentWidth)) this.setFollowTail(false);
		return this.#panel.render(frameWidth);
	}

	#setBodyLines(lines: readonly string[]): void {
		if (lines.length === this.#bodyLines.length && lines.every((line, index) => line === this.#bodyLines[index])) {
			return;
		}
		this.#bodyLines = lines.slice();
		this.#viewport.setLines(this.#bodyLines);
	}
}
