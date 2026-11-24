/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The frame of the fullscreen debug viewers (log viewer, raw SSE, protocol
 * probe): a rounded box titled with the viewer's name holding header rows, a
 * scrolling body and footer rows, sized to the screen height.
 *
 * The viewer supplies its content per frame (it may depend on the content
 * width and body height); the frame owns the body's scroll: it follows the
 * tail until scrolled, keeps a body anchor (the selected entry) in view when
 * the anchor or the body height changes, and draws a scrollbar beside the
 * body while it overflows. The frame is terminal chrome: a `canvas` node
 * (natively its rows in the active theme; the terminal paints it in its own
 * theme through the `omp.viewer.frame` look).
 */
import { type Accessor, type JSXNode, read, type Reactive, type Signal, signal, untrack } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { FRAME_ROLE, paintViewerFrame, type ViewerFrameLayout } from "../styles/apps/viewer/frame";

/** What the content callback may size itself by. */
export interface ViewerFrameContext {
	/** Cells per body row (one column is kept for the scrollbar). */
	readonly contentWidth: number;
	readonly bodyHeight: number;
}

/** A body range the frame keeps visible (rows `[start, end)` plus `margin` rows around them). */
export interface ViewerFrameAnchor {
	readonly id: string;
	readonly start: number;
	readonly end: number;
	readonly margin?: number;
}

/** One frame of content (rows are styled strings). */
export interface ViewerFrameContent {
	readonly header: readonly string[];
	readonly body: { readonly lines: readonly string[]; readonly anchor?: ViewerFrameAnchor };
	readonly footer: readonly string[];
}

/** Options of a {@link ViewerFrameModel}. */
export interface ViewerFrameOptions {
	readonly title: string;
	/** Screen rows the frame fills. */
	readonly height: Reactive<number>;
	/** Rows reserved for the header and footer (the body gets the rest). */
	readonly headerRows: number;
	readonly footerRows: number;
	readonly minimumBodyRows?: number;
	/** Start at the tail and stay there as the body grows. */
	readonly followTail?: boolean;
	readonly content: (context: ViewerFrameContext) => ViewerFrameContent;
}

/** Frame rows above the body: the top border plus the rule under the header. */
const ROWS_ABOVE_HEADER = 1;

/** The scroll state and layout of a viewer frame. */
export class ViewerFrameModel {
	readonly title: string;
	readonly #options: ViewerFrameOptions;
	readonly #following: Signal<boolean>;
	/** Bumped by every scroll request (the frame repaints). */
	readonly #version = signal(0);
	/** First body row shown (as last resolved by a paint). */
	#top = 0;
	#lineCount = 0;
	#anchorId: string | undefined;
	#anchorBody = -1;

	constructor(options: ViewerFrameOptions) {
		this.#options = options;
		this.title = options.title;
		this.#following = signal(options.followTail === true);
	}

	/** Body rows: what the height leaves after the header, footer and four frame rows. */
	readonly bodyHeight: Accessor<number> = () =>
		Math.max(
			this.#options.minimumBodyRows ?? 1,
			read(this.#options.height) - this.#options.headerRows - this.#options.footerRows - 4,
		);

	isFollowingTail(): boolean {
		return untrack(this.#following);
	}

	setFollowTail(follow: boolean): void {
		this.#following.set(follow);
		this.#version.update(v => v + 1);
	}

	/** Scroll the body by `delta` rows (stops following the tail). */
	scroll(delta: number): void {
		this.#top = this.#clamp(this.#top + delta);
		this.#following.set(false);
		this.#version.update(v => v + 1);
	}

	/** Show body row `offset` at the top (stops following the tail). */
	setScrollOffset(offset: number): void {
		this.#top = this.#clamp(offset);
		this.#following.set(false);
		this.#version.update(v => v + 1);
	}

	/** Whether frame row `row` shows a body row. */
	isBodyFrameRow(row: number): boolean {
		const first = ROWS_ABOVE_HEADER + this.#options.headerRows + 1;
		return row >= first && row < first + untrack(this.bodyHeight);
	}

	/** The body row shown at frame row `row`, if any. */
	toBodyRow(row: number): number | undefined {
		if (!this.isBodyFrameRow(row)) return undefined;
		const index = this.#top + row - (ROWS_ABOVE_HEADER + this.#options.headerRows + 1);
		return index < this.#lineCount ? index : undefined;
	}

	/** The header row shown at frame row `row`, if any. */
	toHeaderRow(row: number): number | undefined {
		const index = row - ROWS_ABOVE_HEADER;
		return index >= 0 && index < this.#options.headerRows ? index : undefined;
	}

	#clamp(top: number): number {
		return Math.max(0, Math.min(top, Math.max(0, this.#lineCount - untrack(this.bodyHeight))));
	}

	/** The layout of one frame at `width` (resolves the scroll against the content). */
	layout(width: number): ViewerFrameLayout {
		this.#version();
		const bodyHeight = this.bodyHeight();
		const content = this.#options.content({ contentWidth: Math.max(1, width - 5), bodyHeight });
		const lines = content.body.lines;
		this.#lineCount = lines.length;
		const anchor = content.body.anchor;
		let top = this.#following() ? lines.length - bodyHeight : this.#top;
		if (anchor && (anchor.id !== this.#anchorId || bodyHeight !== this.#anchorBody)) {
			const margin = anchor.margin ?? 0;
			// A window too short for the whole anchor keeps its start.
			top = Math.max(top, anchor.end + margin - bodyHeight);
			top = Math.min(top, anchor.start - margin);
		}
		this.#anchorId = anchor?.id;
		this.#anchorBody = bodyHeight;
		this.#top = this.#clamp(top);
		return {
			title: this.title,
			header: this.#fit(content.header, this.#options.headerRows),
			body: lines,
			top: this.#top,
			bodyHeight,
			footer: this.#fit(content.footer, this.#options.footerRows),
		};
	}

	#fit(rows: readonly string[], count: number): string[] {
		const out = rows.slice(0, count);
		while (out.length < count) out.push("");
		return out;
	}
}

/** A viewer frame (see the module docs). */
export function ViewerFrame(props: { readonly model: ViewerFrameModel }): JSXNode {
	const model = props.model;
	return (
		<canvas
			paint={width => paintViewerFrame(currentTheme(), model.layout(width), width)}
			term={{ role: FRAME_ROLE, frame: model }}
		/>
	);
}
