import type { Component } from "@oh-my-pi/pi-tui";
import { fgOrPlain, theme } from "../../modes/theme/theme";

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
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(color: (str: string) => string = str => fgOrPlain("border", str)) {
		this.#color = color;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}
		const horizontal = typeof theme === "undefined" ? "─" : theme.boxRound.horizontal;
		const lines = [this.#color(horizontal.repeat(Math.max(1, width)))];
		this.#cachedWidth = width;
		this.#cachedLines = lines;
		return lines;
	}
}
