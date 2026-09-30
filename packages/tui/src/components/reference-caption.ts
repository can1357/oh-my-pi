import type { Component } from "../tui";
import { replaceTabs, visibleWidth, wrapTextWithAnsi } from "../utils";

/** Blank cells between the card frame and the title, matching the options row. */
const INSET = 2;

/**
 * Title of the selected PR or issue, drawn wrapped under a `>` marker beneath the options of the contextual
 * `#N` card. The text is fetched from elsewhere, so escape sequences and control characters are removed before
 * it is measured or drawn.
 */
export class ReferenceCaption implements Component {
	#title: string | undefined;
	#cache: { width: number; title: string | undefined; rows: readonly string[] } | undefined;

	/** Set the title to show; `undefined` draws nothing. Returns whether anything changed. */
	set(title: string | undefined): boolean {
		const clean = title === undefined ? undefined : sanitizeTitle(title);
		const next = clean === "" ? undefined : clean;
		if (this.#title === next) return false;
		this.#title = next;
		this.#cache = undefined;
		return true;
	}

	render(width: number): readonly string[] {
		const cached = this.#cache;
		if (cached && cached.width === width && cached.title === this.#title) return cached.rows;
		const rows =
			this.#title === undefined || width <= INSET + 2
				? []
				: wrap(`>${this.#title}`, width - INSET).map(row => " ".repeat(INSET) + row);
		this.#cache = { width, title: this.#title, rows };
		return rows;
	}
}

/** Wrap under the marker: continuation rows are indented two cells so they align with the title text. */
function wrap(text: string, width: number): readonly string[] {
	// One cell stays free at the right so text never touches the frame.
	const usable = Math.max(1, width - 1);
	const [first = "", ...rest] = wrapTextWithAnsi(text, usable);
	const continuation = wrapTextWithAnsi(rest.join(" "), Math.max(1, usable - 2)).map(row => `  ${row}`);
	return (rest.length === 0 ? [first] : [first, ...continuation]).map(row => pad(row, width));
}

function sanitizeTitle(text: string): string {
	return replaceTabs(Bun.stripANSI(text))
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function pad(row: string, width: number): string {
	const used = visibleWidth(row);
	return used >= width ? row : row + " ".repeat(width - used);
}
