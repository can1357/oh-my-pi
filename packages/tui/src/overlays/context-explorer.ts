import { type Component, matchesKey, ScrollView, Text, truncateToWidth } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel } from "../keybinding-matchers";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";

const FOOTER_HINT = "Diagnostics · ↑/↓ scroll · Esc close";
const PANEL_CHROME_ROWS = 4;

export interface ContextExplorerOverlayHost {
	readonly terminal: { readonly rows: number };
}

/** Fullscreen /context inspector with scrollable sections. */
export class ContextExplorerOverlay implements Component {
	readonly #host: ContextExplorerOverlayHost;
	readonly #onClose: () => void;
	readonly #panel: OverlayPanel;
	readonly #body: Text;
	readonly #scrollView: ScrollView;
	readonly #footer: PanelRows;
	#lastWidth: number | undefined;
	#lastLines: readonly string[] | undefined;
	#lastHeight: number | undefined;

	constructor(host: ContextExplorerOverlayHost, body: string, onClose: () => void) {
		this.#host = host;
		this.#onClose = onClose;
		this.#body = new Text(body, 0, 0);
		this.#scrollView = new ScrollView([], { height: 0, scrollbar: "auto" });
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel = new OverlayPanel("Context Explorer — debug");
		this.#panel.addChild(this.#scrollView);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	setBody(body: string): void {
		this.#body.setText(body);
		this.#lastWidth = undefined;
		this.#lastLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.#onClose();
			return;
		}
		this.#scrollView.handleScrollKey(data);
	}

	invalidate(): void {
		this.#body.invalidate();
		this.#lastWidth = undefined;
		this.#lastLines = undefined;
		this.#lastHeight = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#panel.dispose();
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		this.#footer.setLines([theme.fg("dim", truncateToWidth(FOOTER_HINT, innerWidth))]);
		const maxBodyHeight = Math.max(1, this.#host.terminal.rows - PANEL_CHROME_ROWS);
		const lines = this.#body.render(innerWidth);
		if (this.#lastWidth !== innerWidth || this.#lastLines !== lines) {
			this.#scrollView.setLines(lines);
			this.#lastWidth = innerWidth;
			this.#lastLines = lines;
		}
		const height = Math.max(1, Math.min(lines.length, maxBodyHeight));
		if (this.#lastHeight !== height) {
			this.#scrollView.setHeight(height);
			this.#lastHeight = height;
		}
		return this.#panel.render(width);
	}
}
