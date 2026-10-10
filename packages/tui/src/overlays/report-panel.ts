import type { TspScrollBy, TspText } from "@oh-my-pi/pi-wire";
import { OverlayPanel } from "../chrome/overlay-box";
import { editorKey } from "../chrome/keybinding-hints";
import { Ellipsis } from "../index";
import { ScrollView } from "../components/scroll-view";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { actionBar, actionButton } from "../native/overlay";
import { col } from "../native/describe";
import type { NativeNode, NativeScroll, NativeUiEvent } from "../native/node";
import { theme } from "../theme/theme";
import type { Component } from "../tui";

/** Options of a {@link ReportPanel}. */
export interface ReportPanelOptions {
	/** Plain title: the text-mode border title, and the native sheet head unless {@link head} is given. */
	readonly title: string;
	/** Styled native sheet head. */
	readonly head?: TspText;
	/** The read-only report; it draws no frame or title of its own. */
	readonly body: Component;
	/**
	 * Display form of the key that dismisses the report while it sits above the
	 * editor (the editor's interrupt key, which routes to it). Once the panel
	 * holds focus ({@link ReportPanel.holdFocus}) the hint shows the key its own
	 * input closes on instead.
	 */
	readonly closeKey: string;
	/** The focused panel (native sheet, text-mode full-screen page) closes on Esc / its Close button: this runs. */
	readonly onClose: () => void;
	/**
	 * Most rows the text-mode panel may take, borders included (the screen rows
	 * left above the editor); a taller report scrolls inside it. `undefined`
	 * leaves it uncapped.
	 */
	readonly maxRows?: () => number | undefined;
}

/** Text-mode rows around the scrolled body: the borders, two spacers and the footer. */
const TEXT_CHROME_ROWS = 5;

/**
 * A read-only command report (`/changelog`, `/context`, `/tools`, …).
 *
 * Text mode draws a titled box with the body and an Esc hint: above the editor
 * like the `/btw` panel while it fits there (the editor keeps focus and its
 * Esc takes it away), or as a full-screen page on the alternate screen when it
 * is taller, whose body scrolls on the arrow/page/Home/End keys and the wheel.
 * Natively it is a sheet like `/usage`: a centred `lg` glass sheet titled by
 * the report whose body the terminal scrolls (wheel, and the same keys
 * forwarded as scroll requests), then a Close button; Esc closes it.
 */
export class ReportPanel extends OverlayPanel {
	readonly nativeOverlay: NonNullable<Component["nativeOverlay"]>;
	readonly #body: Component;
	readonly #onClose: () => void;
	readonly #maxRows: (() => number | undefined) | undefined;
	readonly #view: ScrollView;
	readonly #footer: Text;
	#closeHint: string;
	#bodyRows = 0;
	#scroll: NativeScroll | undefined;
	#native: { scroll: NativeScroll | undefined; node: NativeNode } | undefined;

	constructor(options: ReportPanelOptions) {
		super(options.title, "omp.overlay.report");
		this.nativeOverlay = {
			role: "omp.overlay.report",
			size: "lg",
			anchor: "center",
			head: options.head ?? options.title,
		};
		this.#body = options.body;
		this.#onClose = options.onClose;
		this.#maxRows = options.maxRows;
		this.#closeHint = `${options.closeKey} to close`;
		this.#view = new ScrollView(options.body, {
			height: 0,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
		});
		this.#footer = new Text(theme.fg("muted", this.#closeHint), 0, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.#view);
		this.addChild(new Spacer(1));
		this.addChild(this.#footer);
	}

	/**
	 * The panel is shown with focus (native sheet, text-mode full-screen page):
	 * its own {@link handleInput} closes it, so the hint names that key.
	 */
	holdFocus(): void {
		this.#closeHint = `${editorKey("tui.select.cancel")} to close`;
	}

	/**
	 * Text mode: cap the box to {@link ReportPanelOptions.maxRows}, scrolling a
	 * taller body. The cap is a hard limit: when a resize leaves fewer rows than
	 * the box's chrome needs, its bottom (the hint and closing border) is cut
	 * rather than spilling over the editor.
	 */
	override render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const rows = this.#body.render(innerWidth).length;
		const cap = this.#maxRows?.();
		const bodyMax = cap === undefined ? rows : Math.max(1, cap - TEXT_CHROME_ROWS);
		const overflows = rows > bodyMax;
		this.#bodyRows = Math.min(rows, bodyMax);
		this.#view.setHeight(this.#bodyRows);
		const scrollHint = `${editorKey("tui.select.pageUp")}/${editorKey("tui.select.pageDown")} scroll · `;
		this.#footer.setText(theme.fg("muted", overflows ? scrollHint + this.#closeHint : this.#closeHint));
		const lines = super.render(width);
		return cap !== undefined && lines.length > cap ? lines.slice(0, Math.max(0, cap)) : lines;
	}

	/** Text mode: rows the whole box takes at `width` when nothing caps it. */
	heightAt(width: number): number {
		return this.#body.render(Math.max(1, width - 4)).length + TEXT_CHROME_ROWS;
	}

	/** The sheet body (the overlay is the frame, and its body the scroller): the report, then Close (Esc). */
	override describe(): NativeNode {
		const scroll = this.#scroll;
		if (this.#native && this.#native.scroll === scroll) return this.#native.node;
		const body: NativeNode = { ...col([this.#body]), key: "body", scroll };
		const node = col([body, actionBar([null, actionButton("Close", "close", { keys: "escape" })])], { gap: "md" });
		this.#native = { scroll, node };
		return node;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	/**
	 * Focused (the native sheet, or the text-mode full-screen page): Esc closes;
	 * the arrow, page, Home and End keys and the wheel scroll the body.
	 */
	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel === null) return false;
				this.#view.scroll(event.wheel * 3);
				return true;
			})
		) {
			return;
		}
		if (matchesSelectCancel(data)) {
			this.#onClose();
			return;
		}
		const by: TspScrollBy | undefined = matchesSelectUp(data)
			? "line-up"
			: matchesSelectDown(data)
				? "line-down"
				: matchesSelectPageUp(data)
					? "page-up"
					: matchesSelectPageDown(data)
						? "page-down"
						: matchesKey(data, "home")
							? "start"
							: matchesKey(data, "end")
								? "end"
								: undefined;
		if (by === undefined) return;
		// Natively the terminal scrolls the sheet body; text mode scrolls the box.
		this.#scroll = { by, n: (this.#scroll?.n ?? 0) + 1 };
		const page = Math.max(1, this.#bodyRows - 1);
		if (by === "start") this.#view.scrollToTop();
		else if (by === "end") this.#view.scrollToBottom();
		else this.#view.scroll(by === "line-up" ? -1 : by === "line-down" ? 1 : by === "page-up" ? -page : page);
	}

	/** Close runs what Esc runs. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#onClose();
	}
}
