/**
 * Draws a {@link ChartSpec} as a standalone SVG document colored only with
 * figure tokens — `var(--fg)`, `var(--muted)`, `var(--border)`,
 * `var(--accent)`, `var(--surface)`, `var(--c1)`…`var(--c6)` — on a
 * transparent background — the token vocabulary of assistant ```svg figures —
 * so the host resolves them against the live theme (`prepareSvg`) for both
 * the rasterized terminal image and the native TSP blob.
 *
 * Geometry follows the terminal: 16 user units per row and a monospace face,
 * so 13-unit labels land near the terminal's own glyph size. Marks are flat
 * and square (no rounding, gradients or shadows); bolded table cells draw at
 * full strength while their neighbours recede.
 */
import type { ChartPoint, ChartSeries, ChartSpec } from "./chart-plan";
import type { Dimension } from "./table-data";

const WIDTH = 720;
const PAD = 12;
const LABEL_SIZE = 13;
const TICK_SIZE = 11;
/** Monospace advance per em. */
const ADVANCE = 0.6;
const FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
/** Series colors in draw order. */
const SERIES = ["accent", "c2", "c3", "c4", "c5", "c6", "c1"] as const;
/** Spread (max/min of positive values) from which an axis turns logarithmic. */
const LOG_SPREAD = 100;
const MAX_LABEL_CHARS = 28;
/** Opacity of marks beside an emphasized one. */
const RECEDE = 0.45;

/** A drawn layer: its SVG elements and the height they span from `top`. */
interface Layer {
	readonly height: number;
	readonly body: string;
}

/** Map a value to a coordinate, with tick values for the axis. */
interface Scale {
	at(value: number): number;
	readonly ticks: readonly number[];
	readonly log: boolean;
}

/** A drawn chart: the SVG document and its size in user units. */
export interface ChartSvg {
	readonly svg: string;
	readonly width: number;
	readonly height: number;
}

/** The SVG document for `spec`. */
export function renderChartSvg(spec: ChartSpec): ChartSvg {
	const layer = drawChart(spec);
	let height = PAD + layer.height;
	let caption = "";
	if (spec.caption) {
		caption = text(PAD, height + 14, clip(spec.caption, Math.floor((WIDTH - 2 * PAD) / (TICK_SIZE * ADVANCE))), {
			size: TICK_SIZE,
			fill: "muted",
		});
		height += 20;
	}
	height = Math.ceil(height + PAD);
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}" font-size="${LABEL_SIZE}">`,
		`<g transform="translate(0 ${PAD})">${layer.body}</g>`,
		caption,
		"</svg>",
	].join("");
	return { svg, width: WIDTH, height };
}

/** One-line description of the chart, for screen readers and terminals that show the alt text. */
export function chartAlt(spec: ChartSpec): string {
	const names = spec.series.map(entry => entry.name).join(", ");
	const kind = spec.kind === "multiples" ? "small multiples" : spec.kind;
	return `${kind} chart of ${names}${spec.axis ? ` by ${spec.axis}` : ""}`;
}

function drawChart(spec: ChartSpec): Layer {
	switch (spec.kind) {
		case "line":
			return drawLine(spec);
		case "heatmap":
			return drawGrid(spec, "heat");
		case "multiples":
			return drawGrid(spec, "bars");
		case "share":
			return drawShare(spec);
		case "scatter":
			return drawScatter(spec);
		default:
			return drawBars(spec);
	}
}

// ── Horizontal bars: bar, grouped, paired, diverging ─────────────────────────

function drawBars(spec: ChartSpec): Layer {
	const { kind, categories, series } = spec;
	const values = series.flatMap(entry =>
		entry.points.flatMap(point => (point ? [point.value, point.upper ?? point.value] : [])),
	);
	const labelWidth = labelColumnWidth(categories);
	const valueText = (at: number) =>
		kind === "paired"
			? [pointText(series[0]!, at), pointText(series[1]!, at)].filter(Boolean).join(" → ")
			: series.length === 1
				? pointText(series[0]!, at) || (series[0]!.notes[at] ?? "")
				: "";
	const valueWidth = Math.min(
		180,
		Math.max(0, ...categories.map((_, at) => measure(valueText(at), TICK_SIZE))) +
			(series.length === 1 || kind === "paired" ? 8 : 0),
	);
	const left = PAD + labelWidth + 10;
	const right = WIDTH - PAD - Math.max(valueWidth, series.length > 1 && kind !== "paired" ? 64 : 0);
	const scale = valueScale(values, left, right, { zero: true });

	const parts: string[] = [];
	let top = 0;
	if (series.length > 1) {
		const legend = drawLegend(
			series.map((entry, at) => [entry.name, seriesColor(kind, at)]),
			PAD,
			WIDTH - PAD,
		);
		parts.push(legend.body);
		top += legend.height + 6;
	}
	const groupRow = kind === "grouped" ? series.length * 11 + 8 : 22;
	const gridTop = top;
	const gridBottom = top + categories.length * groupRow;
	parts.push(drawValueAxis(scale, series[0]!, gridTop, gridBottom));

	const zero = scale.log ? left : scale.at(0);
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	categories.forEach((name, at) => {
		const rowTop = top + at * groupRow;
		const middle = rowTop + groupRow / 2;
		parts.push(text(left - 10, middle, clip(name, MAX_LABEL_CHARS), { anchor: "end", fill: "fg" }));
		if (kind === "paired") {
			const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
			if (a && b) parts.push(line(scale.at(a.value), middle, scale.at(b.value), middle, "border", 2));
			if (a) parts.push(dot(scale.at(a.value), middle, 4.5, seriesColor(kind, 0)));
			if (b)
				parts.push(dot(scale.at(b.value), middle, 4.5, seriesColor(kind, 1), a?.emphasis || b.emphasis ? 1 : 0.9));
			parts.push(
				text(right + 8, middle, valueText(at), {
					size: TICK_SIZE,
					fill: a?.emphasis || b?.emphasis ? "fg" : "muted",
				}),
			);
			return;
		}
		const barHeight = kind === "grouped" ? 9 : 14;
		series.forEach((entry, index) => {
			const point = entry.points[at];
			const y = kind === "grouped" ? rowTop + 4 + index * 11 : middle - barHeight / 2;
			const fill = kind === "diverging" && point && point.value < 0 ? "c2" : seriesColor(kind, index);
			const opacity = emphasized && !point?.emphasis ? RECEDE : 1;
			if (!point) {
				const note = entry.notes[at];
				if (note)
					parts.push(text(left + 4, y + barHeight / 2, clip(note, 16), { size: TICK_SIZE, fill: "warning" }));
				return;
			}
			const end = scale.at(point.value);
			if (scale.log) {
				parts.push(line(left, y + barHeight / 2, end, y + barHeight / 2, "border", 1));
				parts.push(dot(end, y + barHeight / 2, barHeight / 2.8, fill, opacity));
			} else {
				parts.push(rect(Math.min(zero, end), y, Math.abs(end - zero), barHeight, fill, opacity));
			}
			if (point.upper !== undefined) parts.push(whisker(end, scale.at(point.upper), y + barHeight / 2, fill));
			if (kind === "grouped") {
				const labelX = Math.max(end, point.upper === undefined ? end : scale.at(point.upper)) + 4;
				parts.push(text(labelX, y + barHeight / 2, clip(point.text, 12), { size: 10, fill: "muted" }));
			}
		});
		if (series.length === 1) {
			const point = series[0]!.points[at];
			const end = point
				? Math.max(scale.at(point.value), point.upper === undefined ? 0 : scale.at(point.upper))
				: left;
			// Clear the dot a log axis draws instead of a bar.
			const x = kind === "diverging" ? right + 8 : Math.max(end, zero) + (scale.log ? 11 : 6);
			parts.push(
				text(x, middle, valueText(at), {
					size: TICK_SIZE,
					fill: point?.emphasis ? "fg" : "muted",
					weight: point?.emphasis ? 600 : undefined,
				}),
			);
		}
	});
	if (kind === "diverging" && !scale.log) parts.push(line(zero, gridTop - 2, zero, gridBottom + 2, "muted", 1));
	return { height: gridBottom + 20, body: parts.join("") };
}

/** Series color: dumbbells pair a muted "before" with the accent "after". */
function seriesColor(kind: ChartSpec["kind"], index: number): string {
	if (kind === "paired") return index === 0 ? "muted" : "accent";
	return SERIES[index % SERIES.length]!;
}

// ── Grids: heatmap and small multiples ──────────────────────────────────────

function drawGrid(spec: ChartSpec, style: "heat" | "bars"): Layer {
	const { categories, series } = spec;
	const labelWidth = labelColumnWidth(categories);
	const left = PAD + labelWidth + 10;
	const cellWidth = (WIDTH - PAD - left) / series.length;
	const rowHeight = 22;
	const headerChars = Math.max(4, Math.floor((cellWidth - 6) / (TICK_SIZE * ADVANCE)));
	const parts: string[] = [];
	series.forEach((entry, index) => {
		const x = left + index * cellWidth;
		const anchor = style === "heat" ? "middle" : "start";
		const tx = style === "heat" ? x + cellWidth / 2 : x + 2;
		parts.push(text(tx, 8, clip(entry.name, headerChars), { size: TICK_SIZE, fill: "muted", anchor }));
	});
	const top = 22;
	// Heatmaps share one scale; small multiples scale each series on its own.
	const all = series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])));
	const shared = intensity(all);
	categories.forEach((name, row) => {
		const y = top + row * rowHeight;
		parts.push(text(left - 10, y + rowHeight / 2, clip(name, MAX_LABEL_CHARS), { anchor: "end", fill: "fg" }));
	});
	series.forEach((entry, index) => {
		const x = left + index * cellWidth;
		const values = entry.points.flatMap(point => (point ? [point.value] : []));
		const own = intensity(values);
		const textWidth = Math.max(0, ...entry.points.map(point => measure(point?.text ?? "", TICK_SIZE)));
		const barSpace = Math.max(0, cellWidth - textWidth - 14);
		const emphasized = entry.points.some(point => point?.emphasis);
		const color = SERIES[index % SERIES.length]!;
		entry.points.forEach((point, row) => {
			const y = top + row * rowHeight;
			const middle = y + rowHeight / 2;
			if (!point) {
				const note = entry.notes[row];
				if (note) parts.push(text(x + 4, middle, clip(note, headerChars), { size: TICK_SIZE, fill: "warning" }));
				return;
			}
			if (style === "heat") {
				// Capped so the foreground-colored value stays legible on the strongest cell.
				const level = shared(point.value);
				parts.push(rect(x + 1, y + 1, cellWidth - 2, rowHeight - 2, "accent", 0.08 + 0.57 * level));
				parts.push(
					text(x + cellWidth / 2, middle, clip(point.text, headerChars), {
						size: TICK_SIZE,
						fill: "fg",
						anchor: "middle",
						weight: point.emphasis ? 600 : undefined,
					}),
				);
				return;
			}
			const width = Math.max(1, own(point.value) * barSpace);
			parts.push(rect(x + 2, middle - 6, width, 12, color, emphasized && !point.emphasis ? RECEDE : 1));
			parts.push(
				text(x + 2 + width + 4, middle, point.text, {
					size: TICK_SIZE,
					fill: point.emphasis ? "fg" : "muted",
					weight: point.emphasis ? 600 : undefined,
				}),
			);
		});
	});
	if (style === "bars") {
		for (let index = 1; index < series.length; index++) {
			const x = left + index * cellWidth - 3;
			parts.push(line(x, top, x, top + categories.length * rowHeight, "border", 1));
		}
	}
	return { height: top + categories.length * rowHeight + 4, body: parts.join("") };
}

/**
 * Map values onto 0–1 for bar length or fill strength: from zero for
 * non-negative values (log beyond {@link LOG_SPREAD}), min–max otherwise.
 */
function intensity(values: readonly number[]): (value: number) => number {
	const max = Math.max(...values);
	const min = Math.min(...values);
	if (!Number.isFinite(max) || max === min) return () => 1;
	if (min > 0 && max / min >= LOG_SPREAD) {
		const low = Math.log10(min);
		const span = Math.log10(max) - low;
		return value => (value > 0 ? 0.04 + (0.96 * (Math.log10(value) - low)) / span : 0);
	}
	if (min >= 0) return value => value / max;
	return value => (value - min) / (max - min);
}

// ── Share of a whole ─────────────────────────────────────────────────────────

function drawShare(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const total = entry.points.reduce((sum, point) => sum + Math.max(0, point?.value ?? 0), 0) || 1;
	const parts: string[] = [];
	const barWidth = WIDTH - 2 * PAD;
	let x = PAD;
	entry.points.forEach((point, at) => {
		if (!point || point.value <= 0) return;
		const width = (point.value / total) * barWidth;
		parts.push(rect(x, 0, width, 20, SERIES[at % SERIES.length]!, 1));
		if (at > 0) parts.push(line(x, 0, x, 20, "surface", 1.5));
		x += width;
	});
	const columns = spec.categories.length > 5 ? 2 : 1;
	const columnWidth = barWidth / columns;
	const perColumn = Math.ceil(spec.categories.length / columns);
	const chars = Math.floor((columnWidth - 90) / (LABEL_SIZE * ADVANCE));
	spec.categories.forEach((name, at) => {
		const column = Math.floor(at / perColumn);
		const lx = PAD + column * columnWidth;
		const ly = 34 + (at % perColumn) * 20;
		const point = entry.points[at];
		parts.push(rect(lx, ly - 5, 10, 10, SERIES[at % SERIES.length]!, 1));
		parts.push(text(lx + 16, ly, clip(name, chars), { fill: "fg" }));
		parts.push(
			text(lx + columnWidth - 12, ly, point?.text ?? "", {
				size: TICK_SIZE,
				fill: point?.emphasis ? "fg" : "muted",
				anchor: "end",
				weight: point?.emphasis ? 600 : undefined,
			}),
		);
	});
	return { height: 34 + perColumn * 20, body: parts.join("") };
}

// ── Line over an ordered axis ────────────────────────────────────────────────

function drawLine(spec: ChartSpec): Layer {
	const { categories, series, x } = spec;
	const parts: string[] = [];
	let top = 0;
	if (series.length > 1) {
		const legend = drawLegend(
			series.map((entry, at) => [entry.name, SERIES[at % SERIES.length]!]),
			PAD,
			WIDTH - PAD,
		);
		parts.push(legend.body);
		top += legend.height + 6;
	}
	const values = series.flatMap(entry => entry.points.flatMap(point => (point ? [point.value] : [])));
	const lastLabels = series.flatMap(entry => entry.points.map(point => point?.text ?? ""));
	const tickWidth = Math.max(
		...valueScale(values, 0, 1, { zero: false }).ticks.map(tick =>
			measure(formatValue(tick, series[0]!.dim, series[0]!.unit), TICK_SIZE),
		),
	);
	const left = PAD + tickWidth + 8;
	const right = WIDTH - PAD - Math.min(120, Math.max(...lastLabels.map(label => measure(label, TICK_SIZE))) + 10);
	const plotTop = top + 6;
	const plotBottom = plotTop + 180;
	const yScale = valueScale(values, plotBottom, plotTop, { zero: false });
	const xScale = x
		? valueScale(x.values, left, right, { zero: false })
		: {
				at: (index: number) =>
					left + (categories.length === 1 ? 0 : (index / (categories.length - 1)) * (right - left)),
				ticks: [],
				log: false,
			};
	const xAt = (index: number) => xScale.at(x ? x.values[index]! : index);

	for (const tick of yScale.ticks) {
		const y = yScale.at(tick);
		parts.push(line(left, y, right, y, "border", 1));
		parts.push(
			text(left - 6, y, formatValue(tick, series[0]!.dim, series[0]!.unit), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "end",
			}),
		);
	}
	// Category labels left to right, skipping any that would touch the last one drawn.
	const slot = (right - left) / Math.max(1, categories.length - 1);
	const labelChars = Math.max(3, Math.floor(Math.max(slot, 60) / (TICK_SIZE * ADVANCE)) - 1);
	const order = categories.map((_, at) => at).sort((a, b) => xAt(a) - xAt(b));
	let drawnEnd = Number.NEGATIVE_INFINITY;
	for (const at of order) {
		const label = clip(categories[at]!, labelChars);
		const width = measure(label, TICK_SIZE);
		const center = Math.min(Math.max(xAt(at), left + width / 2), WIDTH - PAD - width / 2);
		if (center - width / 2 < drawnEnd + 8) continue;
		parts.push(text(center, plotBottom + 14, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
		drawnEnd = center + width / 2;
	}
	series.forEach((entry, index) => {
		const color = SERIES[index % SERIES.length]!;
		let path = "";
		let pen = false;
		entry.points.forEach((point, at) => {
			if (!point) {
				pen = false;
				return;
			}
			path += `${pen ? "L" : "M"}${num(xAt(at))} ${num(yScale.at(point.value))}`;
			pen = true;
		});
		parts.push(`<path d="${path}" fill="none" stroke="${token(color)}" stroke-width="2" stroke-linejoin="round"/>`);
		entry.points.forEach((point, at) => {
			if (point) parts.push(dot(xAt(at), yScale.at(point.value), point.emphasis ? 4.5 : 3, color));
		});
		// The rightmost point carries the series' value label.
		let lastIndex = -1;
		entry.points.forEach((point, at) => {
			if (point && (lastIndex < 0 || xAt(at) > xAt(lastIndex))) lastIndex = at;
		});
		const last = entry.points[lastIndex];
		if (last) parts.push(text(xAt(lastIndex) + 8, yScale.at(last.value), last.text, { size: TICK_SIZE, fill: "fg" }));
	});
	return { height: plotBottom + 24, body: parts.join("") };
}

// ── Scatter ──────────────────────────────────────────────────────────────────

function drawScatter(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const xs = spec.x!;
	const ys = entry.points.map(point => point?.value ?? Number.NaN);
	const finite = (values: readonly number[]) => values.filter(Number.isFinite);
	const yTicks = valueScale(finite(ys), 0, 1, { zero: false }).ticks;
	const left = PAD + Math.max(...yTicks.map(tick => measure(formatValue(tick, entry.dim, entry.unit), TICK_SIZE))) + 8;
	const right = WIDTH - PAD - 80;
	const top = 18;
	const bottom = top + 200;
	const xScale = valueScale(finite(xs.values), left, right, { zero: false });
	const yScale = valueScale(finite(ys), bottom, top, { zero: false });
	const parts: string[] = [text(left, 6, entry.name, { size: TICK_SIZE, fill: "muted" })];
	for (const tick of yScale.ticks) {
		parts.push(line(left, yScale.at(tick), right, yScale.at(tick), "border", 1));
		parts.push(
			text(left - 6, yScale.at(tick), formatValue(tick, entry.dim, entry.unit), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "end",
			}),
		);
	}
	for (const tick of xScale.ticks) {
		parts.push(
			text(xScale.at(tick), bottom + 14, formatValue(tick, xs.dim, xs.unit), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	parts.push(text(right, bottom + 30, xs.name, { size: TICK_SIZE, fill: "muted", anchor: "end" }));
	const labelled = spec.categories.length <= 15;
	entry.points.forEach((point, at) => {
		const xv = xs.values[at]!;
		if (!point || !Number.isFinite(xv)) return;
		const px = xScale.at(xv);
		const py = yScale.at(point.value);
		parts.push(dot(px, py, point.emphasis ? 5 : 3.5, "accent"));
		if (labelled) parts.push(text(px + 7, py, clip(spec.categories[at]!, 14), { size: 10, fill: "muted" }));
	});
	return { height: bottom + 36, body: parts.join("") };
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/**
 * A value axis over `values` from `from` to `to`: logarithmic when every
 * value is positive and they span {@link LOG_SPREAD}× or more, else linear on
 * nice ticks, including zero when `zero` asks for a baseline.
 */
function valueScale(values: readonly number[], from: number, to: number, options: { zero: boolean }): Scale {
	let min = Math.min(...values);
	let max = Math.max(...values);
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		min = 0;
		max = 1;
	}
	if (min > 0 && max / min >= LOG_SPREAD) {
		const low = Math.floor(Math.log10(min));
		const high = Math.ceil(Math.log10(max));
		const ticks: number[] = [];
		const stride = Math.max(1, Math.ceil((high - low) / 6));
		for (let power = low; power <= high; power += stride) ticks.push(10 ** power);
		const span = high - low || 1;
		return {
			at: value => from + ((Math.log10(Math.max(value, 10 ** low)) - low) / span) * (to - from),
			ticks,
			log: true,
		};
	}
	if (options.zero) {
		min = Math.min(0, min);
		max = Math.max(0, max);
	} else if (min > 0 && min < max * 0.35) {
		min = 0;
	}
	if (min === max) {
		max = min === 0 ? 1 : min + Math.abs(min) * 0.5;
		if (!options.zero) min -= Math.abs(min) * 0.5;
	}
	const step = niceStep((max - min) / 4);
	const low = Math.floor(min / step) * step;
	const high = Math.ceil(max / step) * step;
	const ticks: number[] = [];
	for (let tick = low; tick <= high + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
	return { at: value => from + ((value - low) / (high - low || 1)) * (to - from), ticks, log: false };
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
	const power = 10 ** Math.floor(Math.log10(raw || 1));
	const fraction = raw / power;
	return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/** Gridlines and tick labels under a horizontal value axis. */
function drawValueAxis(scale: Scale, series: ChartSeries, top: number, bottom: number): string {
	const parts: string[] = [];
	for (const tick of scale.ticks) {
		const x = scale.at(tick);
		parts.push(line(x, top, x, bottom, "border", 1));
		parts.push(
			text(x, bottom + 12, formatValue(tick, series.dim, series.unit), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	return parts.join("");
}

/** Swatch-and-name legend wrapping across `left`…`right`. */
function drawLegend(items: readonly (readonly [string, string])[], left: number, right: number): Layer {
	const parts: string[] = [];
	let x = left;
	let y = 6;
	for (const [name, color] of items) {
		const label = clip(name, 24);
		const width = 16 + measure(label, TICK_SIZE) + 16;
		if (x + width > right && x > left) {
			x = left;
			y += 18;
		}
		parts.push(rect(x, y - 5, 10, 10, color, 1));
		parts.push(text(x + 15, y, label, { size: TICK_SIZE, fill: "fg" }));
		x += width;
	}
	return { height: y + 8, body: parts.join("") };
}

/** Width of the category label column. */
function labelColumnWidth(categories: readonly string[]): number {
	const chars = Math.min(MAX_LABEL_CHARS, Math.max(4, ...categories.map(name => name.length)));
	return chars * LABEL_SIZE * ADVANCE;
}

/** A point's written figure, or its value formatted when the table wrote none. */
function pointText(series: ChartSeries, at: number): string {
	const point: ChartPoint | null | undefined = series.points[at];
	if (!point) return "";
	return point.text || formatValue(point.value, series.dim, series.unit);
}

/**
 * A value in base units as an axis label: durations and sizes in the unit
 * their magnitude reads best in, counts compacted (`12k`, `3.4M`).
 */
export function formatValue(value: number, dim: Dimension, unit: string): string {
	switch (dim) {
		case "percent":
			return `${compact(value)}%`;
		case "ratio":
			return `${compact(value)}×`;
		case "currency":
			return `${value < 0 ? "-" : ""}${unit}${compact(Math.abs(value))}`;
		case "duration": {
			const magnitude = Math.abs(value);
			const [divisor, suffix] =
				magnitude === 0
					? [1, "s"]
					: magnitude < 1e-6
						? [1e-9, "ns"]
						: magnitude < 1e-3
							? [1e-6, "µs"]
							: magnitude < 1
								? [1e-3, "ms"]
								: magnitude < 120
									? [1, "s"]
									: magnitude < 7200
										? [60, "m"]
										: magnitude < 172_800
											? [3600, "h"]
											: [86_400, "d"];
			return `${compact(value / divisor)}${suffix}`;
		}
		case "bytes": {
			const units = ["B", "KB", "MB", "GB", "TB"];
			let scaled = value;
			let index = 0;
			while (Math.abs(scaled) >= 1000 && index < units.length - 1) {
				scaled /= 1000;
				index++;
			}
			return `${compact(scaled)}${units[index]}`;
		}
		default:
			return compact(value);
	}
}

/** `1234567` → `1.2M`, `0.0123` → `0.012`. */
function compact(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude >= 1e9) return `${trim(value / 1e9)}B`;
	if (magnitude >= 1e6) return `${trim(value / 1e6)}M`;
	if (magnitude >= 1e4) return `${trim(value / 1e3)}k`;
	return trim(value);
}

function trim(value: number): string {
	const magnitude = Math.abs(value);
	const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
	return Number(value.toFixed(digits)).toString();
}

function measure(content: string, size: number): number {
	return content.length * size * ADVANCE;
}

function clip(content: string, chars: number): string {
	return content.length <= chars ? content : `${content.slice(0, Math.max(1, chars - 1))}…`;
}

function token(name: string): string {
	return `var(--${name})`;
}

function num(value: number): string {
	return Number(value.toFixed(1)).toString();
}

interface TextStyle {
	size?: number;
	fill: string;
	anchor?: "start" | "middle" | "end";
	weight?: number;
}

/** Text vertically centred on `y`. */
function text(x: number, y: number, content: string, style: TextStyle): string {
	if (!content) return "";
	const size = style.size ?? LABEL_SIZE;
	const attrs = [
		`x="${num(x)}"`,
		`y="${num(y + size * 0.35)}"`,
		`fill="${token(style.fill)}"`,
		size === LABEL_SIZE ? "" : `font-size="${size}"`,
		style.anchor && style.anchor !== "start" ? `text-anchor="${style.anchor}"` : "",
		style.weight ? `font-weight="${style.weight}"` : "",
	].filter(Boolean);
	const escaped = content.replace(/[&<>"]/g, char =>
		char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&quot;",
	);
	return `<text ${attrs.join(" ")}>${escaped}</text>`;
}

function rect(x: number, y: number, width: number, height: number, fill: string, opacity: number): string {
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<rect x="${num(x)}" y="${num(y)}" width="${num(Math.max(0, width))}" height="${num(height)}" fill="${token(fill)}"${alpha}/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number): string {
	return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${token(stroke)}" stroke-width="${width}"/>`;
}

function dot(x: number, y: number, radius: number, fill: string, opacity = 1): string {
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="${token(fill)}"${alpha}/>`;
}

/** Range whisker from a value to its upper bound, capped at both ends. */
function whisker(from: number, to: number, y: number, stroke: string): string {
	return `${line(from, y, to, y, stroke, 1.5)}${line(to, y - 4, to, y + 4, stroke, 1.5)}`;
}
