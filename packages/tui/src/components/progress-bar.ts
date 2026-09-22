import type { Component } from "../tui";
import { Ellipsis, getWidthConfigEpoch, truncateToWidth, visibleWidth } from "../utils";

/** Explicit glyph and styling policy for a progress bar. */
export interface ProgressBarStyle {
	readonly filled: string;
	readonly empty: string;
	readonly indeterminate?: string;
	readonly styleFilled?: (text: string) => string;
	readonly styleEmpty?: (text: string) => string;
	readonly styleIndeterminate?: (text: string) => string;
	readonly styleBar?: (text: string) => string;
}

/** Layout and labeling policy for a progress bar. */
export interface ProgressBarOptions {
	readonly min?: number;
	readonly max?: number;
	readonly minWidth?: number;
	readonly maxWidth?: number;
	readonly prefix?: string;
	readonly suffix?: string;
	readonly showPercentage?: boolean;
	readonly percentageSeparator?: string;
	readonly formatPercentage?: (fraction: number) => string;
	readonly style: ProgressBarStyle;
}

function finiteWidth(width: number, fallback: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : fallback;
}

function boundedWidth(width: number, options: ProgressBarOptions): number {
	const minWidth = finiteWidth(options.minWidth ?? 0, 0);
	const maxWidth = Math.max(
		minWidth,
		finiteWidth(options.maxWidth ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
	);
	return Math.max(minWidth, Math.min(maxWidth, finiteWidth(width, 0)));
}

function fillCells(glyph: string, width: number): string {
	const cleanGlyph = glyph.replace(/[\t\r\n]/g, " ");
	const glyphWidth = visibleWidth(cleanGlyph);
	if (glyphWidth <= 0) return " ".repeat(width);
	const count = Math.floor(width / glyphWidth);
	return `${cleanGlyph.repeat(count)}${" ".repeat(width - count * glyphWidth)}`;
}

function singleLine(text: string): string {
	return text.replace(/[\t\r\n]/g, " ");
}

/** Normalize a progress value to a clamped fraction, preserving undefined as indeterminate. */
export function progressFraction(value: number | undefined, min = 0, max = 1): number | undefined {
	if (value === undefined) return undefined;
	if (max <= min) return value >= max ? 1 : 0;
	return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Render a single progress bar line; `width` is the inner bar width before frame and percentage chrome. */
export function renderProgressBar(value: number | undefined, width: number, options: ProgressBarOptions): string {
	const barWidth = boundedWidth(width, options);
	const fraction = progressFraction(value, options.min, options.max);
	let bar: string;
	if (fraction === undefined) {
		const glyph = options.style.indeterminate ?? options.style.empty;
		const raw = fillCells(glyph, barWidth);
		bar = options.style.styleIndeterminate?.(raw) ?? options.style.styleEmpty?.(raw) ?? raw;
	} else {
		const filledWidth = Math.round(fraction * barWidth);
		const filledRaw = fillCells(options.style.filled, filledWidth);
		const emptyRaw = fillCells(options.style.empty, Math.max(0, barWidth - filledWidth));
		const filled = options.style.styleFilled?.(filledRaw) ?? filledRaw;
		const empty = options.style.styleEmpty?.(emptyRaw) ?? emptyRaw;
		bar = `${filled}${empty}`;
	}
	bar = options.style.styleBar?.(bar) ?? bar;
	const framed = `${singleLine(options.prefix ?? "")}${bar}${singleLine(options.suffix ?? "")}`;
	if (fraction === undefined || options.showPercentage !== true) return framed;
	const percentage = singleLine(options.formatPercentage?.(fraction) ?? `${Math.round(fraction * 100)}%`);
	return `${framed}${singleLine(options.percentageSeparator ?? " ")}${percentage}`;
}

/** Mutable progress component whose `render(width)` bounds the complete framed and labeled line to `width`. */
export class ProgressBar implements Component {
	#value: number | undefined;
	readonly #options: ProgressBarOptions;
	#cache: { width: number; epoch: number; value: number | undefined; lines: readonly string[] } | undefined;

	constructor(value: number | undefined, options: ProgressBarOptions) {
		this.#value = value;
		this.#options = options;
	}

	setValue(value: number | undefined): boolean {
		if (Object.is(this.#value, value)) return false;
		this.#value = value;
		this.#cache = undefined;
		return true;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		const renderWidth = finiteWidth(width, 0);
		const epoch = getWidthConfigEpoch();
		if (
			this.#cache &&
			this.#cache.width === renderWidth &&
			this.#cache.epoch === epoch &&
			Object.is(this.#cache.value, this.#value)
		) {
			return this.#cache.lines;
		}

		const fraction = progressFraction(this.#value, this.#options.min, this.#options.max);
		const prefix = singleLine(this.#options.prefix ?? "");
		const suffix = singleLine(this.#options.suffix ?? "");
		const percentage =
			fraction !== undefined && this.#options.showPercentage === true
				? singleLine(this.#options.formatPercentage?.(fraction) ?? `${Math.round(fraction * 100)}%`)
				: "";
		const percentageSeparator = percentage ? singleLine(this.#options.percentageSeparator ?? " ") : "";
		const chromeWidth =
			visibleWidth(prefix) + visibleWidth(suffix) + visibleWidth(percentageSeparator) + visibleWidth(percentage);
		const barWidth = Math.max(0, renderWidth - chromeWidth);
		const line = renderProgressBar(this.#value, barWidth, {
			...this.#options,
			minWidth: 0,
			maxWidth: Math.min(barWidth, finiteWidth(this.#options.maxWidth ?? barWidth, barWidth)),
			formatPercentage: percentage ? () => percentage : this.#options.formatPercentage,
		});
		const lines = [truncateToWidth(singleLine(line), renderWidth, Ellipsis.Omit)];
		this.#cache = { width: renderWidth, epoch, value: this.#value, lines };
		return lines;
	}
}
