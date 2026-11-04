import type { Component } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";
import { fgOrPlain, theme } from "../theme/index";
import type { NativeNode } from "../native/node";
import { EMPTY_NODE } from "../native/describe";
/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: the module-level `theme` may be `undefined` — when loaded through jiti
 * (separate module cache) or from a second `src` module graph in npm-package
 * installs, where the host bundle assigns `theme` but this copy never sees it
 * (issue #5366). Both the default color and `render()` degrade to plain,
 * unstyled output instead of crashing the TUI.
 */
export class DynamicBorder implements Component {
	#color: (str: string) => string;
	#label: string | (() => string) | undefined;
	#cachedWidth = -1;
	#cachedLabel: string | undefined;
	#cachedLines: string[] | undefined;

	constructor(color: (str: string) => string = str => fgOrPlain("border", str)) {
		this.#color = color;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	/**
	 * Pre-styled text set into the rule after a short lead (`─── label ────`);
	 * undefined draws a plain rule. A function label is re-read every render,
	 * for live text such as a spinner.
	 */
	setLabel(label: string | (() => string) | undefined): void {
		if (label === this.#label) return;
		this.#label = label;
		this.invalidate();
	}

	/** Native terminals draw their own chrome; a border rule describes nothing. */
	describe(): NativeNode {
		return EMPTY_NODE;
	}

	render(width: number): readonly string[] {
		const label = typeof this.#label === "function" ? this.#label() : this.#label;
		if (this.#cachedLines && this.#cachedWidth === width && this.#cachedLabel === label) {
			return this.#cachedLines;
		}
		const horizontal = typeof theme === "undefined" ? "─" : theme.boxRound.horizontal;
		const lines = [this.#rule(horizontal, Math.max(1, width), label)];
		this.#cachedWidth = width;
		this.#cachedLabel = label;
		this.#cachedLines = lines;
		return lines;
	}

	#rule(horizontal: string, width: number, label: string | undefined): string {
		const lead = horizontal.repeat(3);
		// The label sits between single spaces and leaves at least one rule cell after it.
		const labelRoom = width - visibleWidth(lead) - 3;
		if (!label || labelRoom < 1) return this.#color(horizontal.repeat(width));
		const fitted = ` ${truncateToWidth(label, labelRoom)} `;
		const rest = width - visibleWidth(lead) - visibleWidth(fitted);
		return `${this.#color(lead)}${fitted}${this.#color(horizontal.repeat(rest))}`;
	}
}
