import type { Component } from "../tui";
import { Ellipsis, getWidthConfigEpoch, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

/** One label/value entry in a {@link KeyValueList}. */
export interface KeyValueRow {
	readonly label: string;
	readonly value: string;
	readonly labelStyle?: (text: string) => string;
	readonly valueStyle?: (text: string) => string;
}

/** Explicit sizing and wrapping policy for a key/value list. */
export interface KeyValueListOptions {
	readonly indent?: string;
	readonly labelWidth: number;
	readonly gap?: string;
	readonly minValueWidth?: number;
	readonly labelOverflow?: "allow" | "truncate";
}

function finiteWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
}

function singleLine(text: string): string {
	return replaceTabs(text).replace(/[\r\n]+/g, " ");
}

/** A bounded ANSI-aware label/value list with replaceable rows and aligned wrapped continuations. */
export class KeyValueList implements Component {
	#rows: readonly KeyValueRow[];
	readonly #options: KeyValueListOptions;
	#cache: { width: number; epoch: number; lines: readonly string[] } | undefined;

	constructor(rows: readonly KeyValueRow[], options: KeyValueListOptions) {
		this.#rows = rows;
		this.#options = options;
	}

	setRows(rows: readonly KeyValueRow[]): boolean {
		if (this.#rows === rows) return false;
		this.#rows = rows;
		this.#cache = undefined;
		return true;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		const renderWidth = finiteWidth(width);
		const epoch = getWidthConfigEpoch();
		if (this.#cache?.width === renderWidth && this.#cache.epoch === epoch) return this.#cache.lines;
		const indent = singleLine(this.#options.indent ?? "");
		const gap = singleLine(this.#options.gap ?? " ");
		const labelWidth = finiteWidth(this.#options.labelWidth);
		const minimumValueWidth = Math.max(1, finiteWidth(this.#options.minValueWidth ?? 1));
		const lines: string[] = [];
		for (const row of this.#rows) {
			let label = singleLine(row.label);
			const indentAndGapWidth = visibleWidth(indent) + visibleWidth(gap);
			const constrainedLabelWidth = Math.max(0, renderWidth - indentAndGapWidth - minimumValueWidth);
			const renderedLabelWidth = Math.min(labelWidth, constrainedLabelWidth);
			if (
				visibleWidth(label) > renderedLabelWidth &&
				(this.#options.labelOverflow === "truncate" || renderedLabelWidth < labelWidth)
			) {
				label = truncateToWidth(label, renderedLabelWidth);
			}
			const labelPadding = " ".repeat(Math.max(0, renderedLabelWidth - visibleWidth(label)));
			const rawLabelCell = `${label}${labelPadding}`;
			const labelCell = row.labelStyle?.(rawLabelCell) ?? rawLabelCell;
			const prefixWidth = visibleWidth(indent) + visibleWidth(rawLabelCell) + visibleWidth(gap);
			const valueWidth = Math.max(1, renderWidth - prefixWidth);
			const rawValue = singleLine(row.value);
			const value = row.valueStyle?.(rawValue) ?? rawValue;
			const wrapped = wrapTextWithAnsi(value, valueWidth);
			const continuation = " ".repeat(prefixWidth);
			lines.push(truncateToWidth(`${indent}${labelCell}${gap}${wrapped[0] ?? ""}`, renderWidth, Ellipsis.Omit));
			for (const extra of wrapped.slice(1)) {
				lines.push(truncateToWidth(`${continuation}${extra}`, renderWidth, Ellipsis.Omit));
			}
		}
		this.#cache = { width: renderWidth, epoch, lines };
		return lines;
	}
}
