import { type Component, Ellipsis, Markdown, matchesKey, ScrollView, Text, truncateToWidth } from "../index";
import { getMarkdownTheme, theme } from "../theme/theme";
import { matchesSelectCancel } from "../keybinding-matchers";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";

const FOOTER_HINT = "↑/↓ scroll · Esc close";
const PANEL_CHROME_ROWS = 4;

/** Terminal surface needed to size the info panel viewport. */
export interface InfoPanelOverlayHost {
	readonly terminal: {
		readonly rows: number;
	};
}

/** Focused, dismissible transient information panel (shared by all info commands). */
export class InfoPanelOverlay implements Component {
	readonly #host: InfoPanelOverlayHost;
	readonly #onClose: () => void;
	readonly #panel: OverlayPanel;
	readonly #info: Text | Markdown;
	readonly #scrollView: ScrollView;
	readonly #footer: PanelRows;
	#lastInfoWidth: number | undefined;
	#lastInfoLines: readonly string[] | undefined;
	#lastHeight: number | undefined;

	constructor(
		host: InfoPanelOverlayHost,
		info: string,
		onClose: () => void,
		options: { title: string; markdown?: boolean },
	) {
		this.#host = host;
		this.#onClose = onClose;
		this.#info = options.markdown ? new Markdown(info, 0, 0, getMarkdownTheme()) : new Text(info, 0, 0);
		this.#scrollView = new ScrollView([], {
			height: 0,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: {
				track: text => theme.fg("dim", text),
				thumb: text => theme.fg("accent", text),
			},
		});
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel = new OverlayPanel(options.title);
		this.#panel.addChild(this.#scrollView);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#onClose();
			return;
		}
		this.#scrollView.handleScrollKey(data);
	}

	invalidate(): void {
		this.#info.invalidate();
		this.#lastInfoWidth = undefined;
		this.#lastInfoLines = undefined;
		this.#lastHeight = undefined;
		this.#panel.invalidate();
	}

	setIgnoreTight(ignore: boolean): this {
		this.#info.setIgnoreTight(ignore);
		this.#panel.setIgnoreTight(ignore);
		return this;
	}

	dispose(): void {
		this.#panel.dispose();
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		this.#footer.setLines([theme.fg("dim", truncateToWidth(FOOTER_HINT, innerWidth))]);

		const maxBodyHeight = Math.max(1, this.#host.terminal.rows - PANEL_CHROME_ROWS);
		const fullWidthInfoLines = this.#info.render(innerWidth);
		const infoWidth = fullWidthInfoLines.length > maxBodyHeight ? Math.max(1, innerWidth - 1) : innerWidth;
		const infoLines = infoWidth === innerWidth ? fullWidthInfoLines : this.#info.render(infoWidth);
		if (this.#lastInfoWidth !== infoWidth || this.#lastInfoLines !== infoLines) {
			this.#scrollView.setLines(infoLines);
			this.#lastInfoWidth = infoWidth;
			this.#lastInfoLines = infoLines;
		}

		const height = Math.max(1, Math.min(infoLines.length, maxBodyHeight));
		if (this.#lastHeight !== height) {
			this.#scrollView.setHeight(height);
			this.#lastHeight = height;
		}
		return this.#panel.render(width);
	}
}
