import type { Component } from "../tui";
import { type ThemeColor, theme } from "../theme";
import { truncateToWidth } from "../utils";

/** Presentation policy for a compact message divider. */
export interface MessageDividerOptions {
	/** Theme-aware label, recomputed after invalidation. */
	readonly label: () => string;
	readonly labelColor: ThemeColor;
	readonly ruleColor?: ThemeColor;
	readonly ruleWidth?: number;
	/** Preserve an intentionally untruncated legacy label at very narrow widths. */
	readonly truncateWhenNarrow?: boolean;
}

/**
 * A short left-aligned rule and label surrounded by blank transcript rows.
 * Rendered rows are cached by width and stay reference-stable until invalidated.
 */
export class MessageDividerComponent implements Component {
	readonly #options: MessageDividerOptions;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(options: MessageDividerOptions) {
		this.#options = options;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = Object.freeze(["", this.#renderDivider(width), ""]);
		this.#cache = { width, lines };
		return lines;
	}

	#renderDivider(width: number): string {
		const label = this.#options.label();
		const labelWidth = Bun.stringWidth(label, { countAnsiEscapeCodes: false });
		const ruleWidth = Math.min(this.#options.ruleWidth ?? 10, width - labelWidth - 1);
		const paintedLabel = theme.fg(this.#options.labelColor, label);
		if (ruleWidth < 1) {
			return this.#options.truncateWhenNarrow === false ? paintedLabel : truncateToWidth(paintedLabel, width);
		}
		const rule = theme.fg(this.#options.ruleColor ?? "dim", theme.tree.horizontal.repeat(ruleWidth));
		return `${rule} ${paintedLabel}`;
	}
}
