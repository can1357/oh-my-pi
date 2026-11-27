/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The terminal's transcript browser: a framed, scrollable view of rows the
 * caller lays out for the frame's width, at a height the caller sets.
 * Terminal-only: Tern browses its own transcript, so the node is an empty
 * `col` the terminal look (`src/ui/styles/figures/browser.ts`) draws.
 *
 * Frame, top to bottom: a border rule, the header lines (one cell in, cut to
 * the width), a border rule, the body, the footer lines, a border rule.
 * Without a width there are no rules. The body takes the height the chrome
 * leaves, at least `minimumBodyRows` (default 3); when its lines overflow
 * it draws a scrollbar in its last column (accent thumb on a dim track) and
 * cuts lines one cell shorter.
 *
 * Scrolling: arrows move a line (Shift: 5), Page Up/Down a body height less
 * one, Home/End jump. `followBottom` keeps the view at the end while it is
 * there (growing bodies stay followed). A body `anchor` (a row range, by id)
 * is revealed once per range and layout (width, body height, row count):
 * with a row of margin, scrolled to its top when it starts above the view,
 * else to its end when it ends below.
 */
import { type JSXNode, type Reactive, read, type Signal, signal, untrack } from "@oh-my-pi/pi-tui";
import type { KeyEvent } from "@oh-my-pi/pi-tui/events";
import { padTo, replaceTabs, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

/** Widths the caller lays the frame out at. */
export interface BrowserFrameContext {
	readonly frameWidth: number;
	/** The body's width beside a scrollbar. */
	readonly contentWidth: number;
	/** Header and footer lines' width (one cell in, one cell short). */
	readonly chromeWidth: number;
}

/** A row range of the body to reveal. */
export interface BrowserAnchor {
	readonly id: string;
	/** First row (0-based). */
	readonly start: number;
	/** Row past the last. */
	readonly end: number;
}

/** What the browser shows at a width (styled lines). */
export interface BrowserFrame {
	readonly header: readonly string[];
	readonly body: { readonly lines: readonly string[]; readonly anchor?: BrowserAnchor };
	readonly footer: readonly string[];
}

export interface TranscriptBrowserOptions {
	/** Rows the frame may fill. */
	readonly height: Reactive<number>;
	/** The frame at a width; reactive reads repaint. */
	readonly frame: (cx: BrowserFrameContext) => BrowserFrame;
	readonly followBottom?: boolean;
	/** Body rows kept however little room the frame has (default 3). */
	readonly minimumBodyRows?: number;
}

/** Rows Shift+arrows move. */
const FAST_LINES = 5;

/** Scroll state of a browser; drives the {@link TranscriptBrowser} node. */
export class TranscriptBrowserModel {
	readonly #options: TranscriptBrowserOptions;
	/** Bumped by every scroll: the paint reads it. */
	readonly #moved: Signal<number> = signal(0);
	#offset = 0;
	#follow: boolean;
	/** The last painted body geometry (what scroll steps are measured by). */
	#body = { height: 0, total: 0 };
	/** The anchor range last revealed. */
	#revealed: string | undefined;

	constructor(options: TranscriptBrowserOptions) {
		this.#options = options;
		this.#follow = options.followBottom === true;
	}

	/** Move by `delta` rows. */
	scroll(delta: number): void {
		const max = Math.max(0, this.#body.total - this.#body.height);
		this.#offset = Math.max(0, Math.min(max, this.#current() + Math.trunc(delta)));
		if (this.#options.followBottom) this.#follow = this.#offset >= max;
		this.#moved.set(this.#moved.peek() + 1);
	}

	/** Move by `pages` body heights less one row. */
	page(pages: number): void {
		this.scroll(Math.max(1, this.#body.height - 1) * Math.trunc(pages));
	}

	scrollToTop(): void {
		this.scroll(-this.#body.total);
	}

	scrollToBottom(): void {
		this.scroll(this.#body.total);
	}

	/** Scroll for a key; false when the key is not a scroll key. */
	handleKey(key: KeyEvent): boolean {
		switch (key.id) {
			case "up":
				this.scroll(-1);
				return true;
			case "down":
				this.scroll(1);
				return true;
			case "shift+up":
				this.scroll(-FAST_LINES);
				return true;
			case "shift+down":
				this.scroll(FAST_LINES);
				return true;
			case "pageUp":
				this.page(-1);
				return true;
			case "pageDown":
				this.page(1);
				return true;
			case "home":
				this.scrollToTop();
				return true;
			case "end":
				this.scrollToBottom();
				return true;
			default:
				return false;
		}
	}

	#current(): number {
		const max = Math.max(0, this.#body.total - this.#body.height);
		return this.#follow ? max : Math.min(this.#offset, max);
	}

	/** The frame's rows at `width` (reactive: a painter calls it). */
	paint(width: number, theme: Theme): string[] {
		this.#moved();
		const frameWidth = Math.max(0, Math.trunc(width));
		const frame = this.#options.frame({
			frameWidth,
			contentWidth: Math.max(1, frameWidth - 1),
			chromeWidth: Math.max(1, frameWidth - 2),
		});
		const height = Math.max(0, Math.trunc(read(this.#options.height)));
		const chrome = frame.header.length + frame.footer.length + (frameWidth > 0 ? 3 : 0);
		const bodyHeight = Math.max(Math.max(0, Math.trunc(this.#options.minimumBodyRows ?? 3)), height - chrome);
		const lines = frame.body.lines;
		untrack(() => this.#layout(frameWidth, bodyHeight, lines.length, frame.body.anchor));
		const offset = this.#current();

		const border = frameWidth > 0 ? [theme.fg("border", "─".repeat(frameWidth))] : [];
		const chromeLine = (line: string): string => ` ${truncate(line, Math.max(0, frameWidth - 1))}`;
		const rows = [...border, ...frame.header.map(chromeLine), ...border];
		const scrollbar = lines.length > bodyHeight && frameWidth > 0;
		const contentWidth = Math.max(0, frameWidth - (scrollbar ? 1 : 0));
		const thumb = scrollbar ? thumbRange(bodyHeight, lines.length, offset) : undefined;
		for (let row = 0; row < bodyHeight; row++) {
			const text = truncate(replaceTabs(lines[offset + row] ?? ""), contentWidth);
			if (!thumb) {
				rows.push(text);
				continue;
			}
			const bar = row >= thumb.start && row < thumb.end ? theme.fg("accent", "█") : theme.fg("dim", "│");
			rows.push(`${visibleWidth(text) < contentWidth ? padTo(text, contentWidth) : text}${bar}`);
		}
		rows.push(...frame.footer.map(chromeLine), ...border);
		return rows;
	}

	/** Record the body's geometry and reveal a new anchor. */
	#layout(width: number, height: number, total: number, anchor: BrowserAnchor | undefined): void {
		this.#body = { height, total };
		if (!anchor) {
			this.#revealed = undefined;
			return;
		}
		// Revealed again whenever the layout it was revealed in changes.
		const id = `${anchor.id}:${anchor.start}:${anchor.end}:${width}:${height}:${total}`;
		if (anchor.end <= anchor.start || anchor.start < 0 || this.#revealed === id) return;
		this.#revealed = id;
		const top = Math.max(0, anchor.start - 1);
		const bottom = Math.min(total, anchor.end + 1);
		const offset = this.#current();
		if (top < offset) this.#offset = top;
		else if (bottom > offset + height) this.#offset = Math.max(top, bottom - 1) - height + 1;
		else this.#offset = offset;
		this.#offset = Math.max(0, Math.min(this.#offset, Math.max(0, total - height)));
		this.#follow = false;
	}
}

/** The scrollbar thumb: proportional (at least a row), placed by the scroll fraction. */
function thumbRange(height: number, total: number, offset: number): { start: number; end: number } {
	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const max = Math.max(0, total - height);
	const start = max === 0 ? 0 : Math.round((Math.min(offset, max) / max) * (height - size));
	return { start, end: start + size };
}

/** Terminal facts of the browser node. */
export type BrowserTerm = {
	readonly browser: TranscriptBrowserModel;
};

/** The browser node: its frame drawn by the model, scroll keys routed to it. */
export function TranscriptBrowser(props: { readonly model: TranscriptBrowserModel }): JSXNode {
	const term: BrowserTerm = { browser: props.model };
	return <col role="omp.transcript.browser" term={term} onKey={key => props.model.handleKey(key)} />;
}
