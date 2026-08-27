import { type Component, matchesKey, routeSgrMouseInput, ScrollView } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";
import type { TranscriptContainer } from "./transcript-container";

export interface CurrentTranscriptViewerDeps {
	container: TranscriptContainer;
	anchor: Component;
	requestRender: () => void;
	onClose: () => void;
}

/** Fullscreen reader for the live transcript, initially aligned to the latest final answer. */
export class CurrentTranscriptViewer implements Component {
	readonly #scrollView = new ScrollView([], {
		height: 10,
		scrollbar: "auto",
		theme: { track: text => theme.fg("dim", text), thumb: text => theme.fg("accent", text) },
	});
	#followAnchor = true;
	#anchorRow: number | undefined;

	constructor(private readonly deps: CurrentTranscriptViewerDeps) {}

	dispose(): void {
		this.deps.container.releaseFullLedgerRenderCache();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.#followAnchor = false;
					this.deps.requestRender();
				}
				return true;
			});
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.deps.onClose();
			return;
		}
		if (data === "r") {
			this.#followAnchor = true;
			if (this.#anchorRow !== undefined) this.#scrollView.setScrollOffset(this.#anchorRow);
			this.deps.requestRender();
			return;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#followAnchor = false;
			this.deps.requestRender();
			return;
		}

		if (data === "j") this.#scrollView.scroll(1);
		else if (data === "k") this.#scrollView.scroll(-1);
		else if (data === "g") this.#scrollView.scrollToTop();
		else if (data === "G") this.#scrollView.scrollToBottom();
		else return;
		this.#followAnchor = false;
		this.deps.requestRender();
	}

	render(width: number): readonly string[] {
		const terminalHeight = process.stdout.rows || 40;
		const contentWidth = Math.max(1, width - 1);
		const { rows, anchorRow } = this.deps.container.renderWithAnchor(contentWidth, this.deps.anchor);
		this.#anchorRow = anchorRow;
		const notice = anchorRow === undefined ? "Answer start is no longer in the visible transcript" : undefined;
		const chromeHeight = notice ? 6 : 5;
		const bodyHeight = Math.max(3, terminalHeight - chromeHeight);
		const visibleRows =
			anchorRow !== undefined && rows.length < anchorRow + bodyHeight
				? [...rows, ...new Array(anchorRow + bodyHeight - rows.length).fill("")]
				: rows;
		this.#scrollView.setLines(visibleRows);
		this.#scrollView.setHeight(bodyHeight);
		if (this.#followAnchor && anchorRow !== undefined) this.#scrollView.setScrollOffset(anchorRow);

		const output: string[] = [];
		output.push(...new DynamicBorder().render(width));
		output.push(` ${theme.fg("accent", "Transcript")} ${theme.fg("dim", `${theme.sep.dot} latest answer`)}`);
		output.push(...new DynamicBorder().render(width));
		output.push(...this.#scrollView.render(width));
		if (notice) output.push(` ${theme.fg("muted", notice)}`);
		output.push(
			` ${theme.fg("dim", "Esc/Ctrl+C:close  ↑/↓ PgUp/PgDn Home/End  j/k:scroll  g/G:top/bottom  r:answer start")}`,
		);
		output.push(...new DynamicBorder().render(width));
		return output;
	}
}
