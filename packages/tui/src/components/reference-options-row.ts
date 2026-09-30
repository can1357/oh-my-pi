import type { Component } from "../tui";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";

/** One option of the row: the text shown and whether the list currently has it selected. */
export interface ReferenceOption {
	label: string;
	selected: boolean;
}

/** Blank cells between the card frame and the options, matching the caption's inset. */
const INSET = 2;

/**
 * The options of the contextual `#N` card on a single row: `❯ PR #12  |  Issue #12`.
 *
 * It only draws. Which option is selected, and moving the selection, stay with the list the options came from,
 * so the keyboard behaves exactly as with the stacked layout. The row is not a pointer target: a click cannot
 * be told apart per option here, so it does not pretend to be one.
 */
export class ReferenceOptionsRow implements Component {
	#options: readonly ReferenceOption[] = [];
	#cursor = ">";
	#style: { selected: (text: string) => string; plain: (text: string) => string } = {
		selected: t => t,
		plain: t => t,
	};

	set(
		options: readonly ReferenceOption[],
		cursor: string,
		style: { selected: (text: string) => string; plain: (text: string) => string },
	): void {
		this.#options = options;
		this.#cursor = cursor;
		this.#style = style;
	}

	render(width: number): readonly string[] {
		const inner = width - INSET;
		if (this.#options.length === 0 || inner < 1) return [];
		const cells = this.#options.map(option =>
			option.selected
				? this.#style.selected(`${this.#cursor} ${option.label}`)
				: this.#style.plain(`  ${option.label}`),
		);
		// Each cell starts with a two-cell prefix (cursor or blanks); the divider adds the gap before the bar.
		const row = cells.join(" | ");
		const used = visibleWidth(row);
		const body = used > inner ? truncateToWidth(row, inner, Ellipsis.Unicode) : row + " ".repeat(inner - used);
		return [" ".repeat(INSET) + body];
	}
}
