/**
 * Logical text of the rows a look builds (`Block.text`, see pi-tui
 * `term/text-layout.ts`): which source line each row shows, so a transcript
 * selection copies content without the look's chrome.
 *
 * {@link RowText} collects rows run by run, each run with how its rows read:
 * decoration (borders, rules, padding, hints), literal (plain labels), a
 * wrapped source string, or a child block's own text moved some cells in.
 * Nothing is computed until the block's `text` is first read.
 */
import type { Block } from "@oh-my-pi/pi-tui/term/paint";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import {
	blockText,
	lazyText,
	literalRenderedText,
	mapWrappedText,
	offsetRenderedText,
	type RenderedText,
	type RenderedTextLine,
	type RenderedTextRow,
	sliceRenderedText,
} from "@oh-my-pi/pi-tui/term/text-layout";

/** Rows and, when known, the logical text of each (absent: they read literally). */
export interface TextRows {
	readonly rows: readonly string[];
	readonly text?: () => RenderedText;
}

/** One run of rows: how many, and their text (computed on demand). */
interface Run {
	readonly count: number;
	readonly read: () => RenderedText;
}

/** Rows built run by run with the logical text of each run. */
export class RowText {
	readonly rows: string[] = [];
	#runs: Run[] = [];

	get length(): number {
		return this.rows.length;
	}

	/** Rows with nothing to copy: borders, rules, padding, hints. */
	deco(...rows: readonly string[]): this {
		if (rows.length === 0) return this;
		this.rows.push(...rows);
		const count = rows.length;
		this.#runs.push({ count, read: () => Array.from({ length: count }, () => undefined) });
		return this;
	}

	/** Rows that copy as they read (plain labels). */
	literal(...rows: readonly string[]): this {
		if (rows.length === 0) return this;
		this.rows.push(...rows);
		this.#runs.push({ count: rows.length, read: () => rows.map(literalRenderedText) });
		return this;
	}

	/**
	 * Rows a wrapper made from `source` (`\n`-separated logical lines), each
	 * mapped to the run of `source` it shows, `column` cells further right.
	 * `shown` are the rows drawn in their place (the same rows inside chrome);
	 * without it the wrapped rows are drawn.
	 */
	wrapped(source: string, rows: readonly string[], column = 0, shown: readonly string[] = rows): this {
		if (shown.length === 0) return this;
		this.rows.push(...shown);
		this.#runs.push({ count: shown.length, read: () => shiftAll(mapWrappedText(source, rows), column) });
		return this;
	}

	/**
	 * A child block's rows `column` cells further right; `shown` are the rows
	 * drawn in their place (the child's rows inside chrome), else its own.
	 */
	block(block: TextRows, column = 0, shown: readonly string[] = block.rows): this {
		if (shown.length === 0) return this;
		this.rows.push(...shown);
		this.#runs.push({ count: shown.length, read: () => shiftAll(textOf(block), column) });
		return this;
	}

	/**
	 * Rows a wrapper made from `source` behind chrome of their own: the first
	 * row starts with `first`, later rows with `rest` (plain text: a bullet,
	 * a glyph, a hanging indent). Each maps past its chrome; see {@link wrapped}.
	 */
	prefixed(
		source: string,
		rows: readonly string[],
		first: string,
		rest = first,
		column = 0,
		shown: readonly string[] = rows,
	): this {
		if (shown.length === 0) return this;
		this.rows.push(...shown);
		this.#runs.push({ count: shown.length, read: () => shiftAll(mapPrefixed(source, rows, first, rest), column) });
		return this;
	}

	/** The text of every row so far, computed on the first call. */
	text(): () => RenderedText {
		const runs = this.#runs;
		const total = this.rows.length;
		return lazyText(() => {
			const out: (RenderedTextRow | undefined)[] = [];
			for (const run of runs) {
				const text = run.read();
				for (let i = 0; i < run.count; i++) out.push(text[i]);
			}
			// A run whose text came up short reads as decoration; never longer than the rows.
			out.length = total;
			return out;
		});
	}

	/** The rows and their text. */
	done(): { rows: string[]; text: () => RenderedText } {
		return { rows: this.rows, text: this.text() };
	}
}

/** The logical text of `block`'s rows (literal when it reports none). */
export function textOf(block: TextRows): RenderedText {
	return blockText(block as Block);
}

/** `text` with every row `column` cells further right. */
function shiftAll(text: RenderedText, column: number): RenderedText {
	return column === 0 ? text : text.map(row => offsetRenderedText(row, column));
}

/**
 * `rows` mapped to `source` past their chrome: `first` on the first row,
 * `rest` on later ones (plain text). A row without its chrome maps whole;
 * a row cut short with `…` maps the run before it.
 */
export function mapPrefixed(source: string, rows: readonly string[], first: string, rest = first): RenderedText {
	const leads: number[] = [];
	const bodies = rows.map((row, index) => {
		const plain = Bun.stripANSI(row).trimEnd();
		const prefix = index === 0 ? first : rest;
		const has = prefix !== "" && plain.startsWith(prefix);
		leads.push(has ? visibleWidth(prefix) : 0);
		return has ? plain.slice(prefix.length) : plain;
	});
	const mapped = mapWrappedText(source, bodies).map((row, index) => offsetRenderedText(row, leads[index]!));
	// A prefixed label can be clipped on any logical line, not just the last line of the block.
	let start = 0;
	while (start < mapped.length) {
		const row = mapped[start];
		if (!row) {
			start++;
			continue;
		}
		let end = start + 1;
		while (mapped[end]?.line === row.line) end++;
		const shown = mapped[end - 1]!.end;
		if (shown < row.line.text.length) {
			const line = { text: row.line.text.slice(0, shown) };
			for (let i = start; i < end; i++) mapped[i] = { ...mapped[i]!, line };
		}
		start = end;
	}
	return mapped;
}

/** Rows `start`..`end` of `block` with their text. */
export function sliceText(block: TextRows, start: number, end = block.rows.length): TextRows {
	const rows = block.rows.slice(start, end);
	if (!block.text) return { rows };
	const parent = block.text;
	return { rows, text: lazyText(() => sliceRenderedText(parent(), start, end)) };
}

/**
 * `block` placed in exactly `height` rows: `lead` blank rows above it, cut
 * at the bottom, blank rows filling the rest (blank rows are decoration).
 */
export function fitHeight(block: TextRows, height: number, lead = 0): { rows: string[]; text: () => RenderedText } {
	const top = Math.max(0, Math.min(lead, height));
	const shown = Math.min(block.rows.length, height - top);
	const out = new RowText().deco(...Array.from({ length: top }, () => ""));
	if (shown > 0) out.block(shown === block.rows.length ? block : sliceText(block, 0, shown));
	return out.deco(...Array.from({ length: Math.max(0, height - out.length) }, () => "")).done();
}

/** `block`'s text thunk mapped: rows `start`.. of its text, `column` cells further right (for a container's `Block.text`). */
export function shiftText(block: TextRows, column: number, start = 0, end = block.rows.length): () => RenderedText {
	return lazyText(() => shiftAll(textOf(block).slice(start, end), column));
}

/**
 * `text` with leading characters of each line replaced (same UTF-16 length):
 * a look that draws indentation as glyphs (`·`, `→`) copies spaces.
 */
export function relineText(text: RenderedText, transform: (line: string) => string): RenderedText {
	const lines = new Map<RenderedTextLine, RenderedTextLine>();
	return text.map(row => {
		if (!row) return row;
		let line = lines.get(row.line);
		if (!line) {
			line = { text: transform(row.line.text) };
			lines.set(row.line, line);
		}
		return { ...row, line };
	});
}
