/**
 * `chart`: series drawn with block glyphs.
 *
 * - `spark`: one row of eighth blocks (`▁`…`█`), one cell per value; a longer
 *   series is squeezed to the width by bucket means.
 * - `bars`: a column per value, `size` rows tall (`sm` 3, `md` 5, `lg` 8),
 *   filled in eighths; `marks` draw a dashed line where a bar leaves room.
 * - `heatmap`: one shaded cell per intensity (`░▒▓█`), row labels on the left
 *   and column labels above.
 *
 * Values run from `min` (default 0) to `max` (default the largest value or
 * mark); a value's `tone` colors its cell, else the chart's `token`. A
 * `summary` follows as a muted line.
 */
import type { TspChartProps, TspTone } from "@oh-my-pi/pi-wire";
import { padTo, truncate, visibleWidth } from "../../text/width";
import type { Theme } from "../../theme/contract";
import { type Block, definePainter, EMPTY_BLOCK } from "../paint";
import { styledText } from "./layout";

/** Eighth-block glyphs, lowest first. */
export const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** How {@link sparkline} draws values. */
export interface SparkOptions {
	/** Low end of the domain (default 0). */
	readonly min?: number;
	/** High end of the domain (default the largest value, at least `min`). */
	readonly max?: number;
	/** What a missing value draws (default a space). */
	readonly gap?: string;
	/** Style one glyph by its value and its share of the domain (0–1). */
	readonly style?: (glyph: string, value: number, fraction: number) => string;
}

/** A value that draws: finite. */
function present(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** The level glyph index of a share of the domain. */
function levelOf(fraction: number): number {
	return Math.min(SPARK_LEVELS.length - 1, Math.max(0, Math.floor(fraction * SPARK_LEVELS.length)));
}

/** The share of `[min, max]` `value` covers, clamped to 0–1 (0 when the domain is empty). */
function fractionOf(value: number, min: number, max: number): number {
	if (!(max > min)) return 0;
	return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** One row of eighth blocks, one per value; missing values (`undefined`, `null`, NaN) draw `gap`. */
export function sparkline(values: readonly (number | null | undefined)[], options: SparkOptions = {}): string {
	const min = options.min ?? 0;
	let max = options.max;
	if (max === undefined) {
		max = min;
		for (const value of values) if (present(value) && value > max) max = value;
	}
	const gap = options.gap ?? " ";
	let out = "";
	for (const value of values) {
		if (!present(value)) {
			out += gap;
			continue;
		}
		const fraction = fractionOf(value, min, max);
		const glyph = SPARK_LEVELS[levelOf(fraction)]!;
		out += options.style ? options.style(glyph, value, fraction) : glyph;
	}
	return out;
}

/** `values` squeezed into at most `width` cells: each cell the mean of its share of the values. */
export function fitSparkValues(values: readonly number[], width: number): number[] {
	const cells = Math.max(0, Math.floor(width));
	if (values.length <= cells) return [...values];
	const out: number[] = [];
	for (let cell = 0; cell < cells; cell++) {
		const start = Math.floor((cell * values.length) / cells);
		const end = Math.max(start + 1, Math.floor(((cell + 1) * values.length) / cells));
		let sum = 0;
		for (let i = start; i < end; i++) sum += values[i]!;
		out.push(sum / (end - start));
	}
	return out;
}

/** A timed sample. */
export interface SparkPoint {
	readonly at: number;
	readonly value: number;
}

/**
 * `points` between `since` and `now` (ms) as `width` buckets of equal time,
 * each the largest value that fell in it; empty buckets are `undefined`.
 */
export function peakBuckets(
	points: readonly SparkPoint[],
	since: number,
	now: number,
	width: number,
): (number | undefined)[] {
	const cells = Math.max(0, Math.floor(width));
	const out: (number | undefined)[] = Array.from({ length: cells }, () => undefined);
	const span = now - since;
	if (cells === 0 || !(span > 0)) return out;
	for (const point of points) {
		if (point.at < since || point.at > now) continue;
		const cell = Math.min(cells - 1, Math.floor(((point.at - since) / span) * cells));
		const held = out[cell];
		if (held === undefined || point.value > held) out[cell] = point.value;
	}
	return out;
}

type Series = NonNullable<TspChartProps["series"]>;

/** The series squeezed into `width` cells: each cell the largest of its share, with that value's tone. */
function fitSeries(series: Series, width: number): Series {
	if (series.length <= width) return series;
	const out: { value: number; tone?: TspTone }[] = [];
	for (let cell = 0; cell < width; cell++) {
		const start = Math.floor((cell * series.length) / width);
		const end = Math.max(start + 1, Math.floor(((cell + 1) * series.length) / width));
		let best = series[start]!;
		for (let i = start + 1; i < end; i++) if (series[i]!.value > best.value) best = series[i]!;
		out.push(best.tone === undefined ? { value: best.value } : { value: best.value, tone: best.tone });
	}
	return out;
}

/** The domain of a bars/spark chart. */
function domainOf(props: TspChartProps, series: Series): { min: number; max: number } {
	const min = props.min ?? 0;
	let max = props.max;
	if (max === undefined) {
		max = min;
		for (const item of series) if (present(item.value) && item.value > max) max = item.value;
		for (const mark of props.marks ?? []) if (mark.value > max) max = mark.value;
	}
	return { min, max };
}

function colorize(theme: Theme, props: TspChartProps, tone: TspTone | undefined, text: string): string {
	const style = tone ?? props.token;
	return style ? theme.style(style, text) : text;
}

const BAR_ROWS = { sm: 3, md: 5, lg: 8 } as const;

function paintSpark(props: TspChartProps, theme: Theme, width: number): string[] {
	const series = fitSeries(props.series ?? [], width);
	const { min, max } = domainOf(props, series);
	let row = "";
	for (const item of series) {
		const glyph = present(item.value) ? SPARK_LEVELS[levelOf(fractionOf(item.value, min, max))]! : " ";
		row += colorize(theme, props, item.tone, glyph);
	}
	return [row];
}

function paintBars(props: TspChartProps, theme: Theme, width: number): string[] {
	const series = fitSeries(props.series ?? [], width);
	if (series.length === 0) return [];
	const { min, max } = domainOf(props, series);
	const height = BAR_ROWS[props.size ?? "md"];
	const eighths = series.map(item =>
		present(item.value) ? Math.round(fractionOf(item.value, min, max) * height * 8) : 0,
	);
	const markRows = new Set(
		(props.marks ?? []).map(
			mark => height - 1 - Math.min(height - 1, Math.floor(fractionOf(mark.value, min, max) * height)),
		),
	);
	const rows: string[] = [];
	for (let row = 0; row < height; row++) {
		const floor = (height - 1 - row) * 8;
		let out = "";
		for (let i = 0; i < series.length; i++) {
			const fill = Math.min(8, Math.max(0, eighths[i]! - floor));
			if (fill === 0) out += markRows.has(row) ? theme.fg("muted", "┄") : " ";
			else out += colorize(theme, props, series[i]!.tone, SPARK_LEVELS[fill - 1]!);
		}
		rows.push(out);
	}
	return rows;
}

const SHADES = ["░", "▒", "▓", "█"] as const;

function paintHeatmap(props: TspChartProps, theme: Theme, width: number): string[] {
	const cells = props.cells ?? [];
	const labels = props.rows ?? [];
	const labelWidth = labels.reduce((widest, label) => Math.max(widest, visibleWidth(label)), 0);
	const lead = labelWidth > 0 ? labelWidth + 1 : 0;
	const columns = Math.max(0, width - lead);
	const rows: string[] = [];
	if (props.cols && props.cols.length > 0) {
		let head = "";
		for (const { at, label } of props.cols) {
			if (at < visibleWidth(head) || at >= columns) continue;
			head = padTo(head, at) + label;
		}
		rows.push(theme.fg("muted", " ".repeat(lead) + truncate(head, columns)));
	}
	cells.forEach((line, index) => {
		let out = labelWidth > 0 ? `${theme.fg("muted", padTo(labels[index] ?? "", labelWidth))} ` : "";
		for (const value of line.slice(0, columns)) {
			out += present(value)
				? colorize(
						theme,
						props,
						undefined,
						SHADES[Math.min(SHADES.length - 1, Math.floor(Math.min(1, Math.max(0, value)) * SHADES.length))]!,
					)
				: " ";
		}
		rows.push(out);
	});
	return rows;
}

definePainter("chart", (node, cx): Block => {
	const props = node.props() as TspChartProps;
	const width = Math.max(1, cx.width);
	const rows =
		props.kind === "spark"
			? paintSpark(props, cx.theme, width)
			: props.kind === "bars"
				? paintBars(props, cx.theme, width)
				: paintHeatmap(props, cx.theme, width);
	if (props.summary !== undefined)
		rows.push(truncate(cx.theme.fg("muted", styledText(cx.theme, props.summary)), width));
	return rows.length === 0 ? EMPTY_BLOCK : { rows };
});
