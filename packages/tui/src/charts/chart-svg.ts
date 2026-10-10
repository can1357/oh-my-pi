/**
 * Draws a {@link ChartSpec} as a standalone SVG document colored only with
 * figure tokens — `var(--fg)`, `var(--muted)`, `var(--border)`,
 * `var(--accent)`, `var(--surface)`, `var(--c1)`…`var(--c6)` — on a
 * transparent background — the token vocabulary of assistant ```svg figures —
 * so the host resolves them against the live theme (`prepareSvg`) for both
 * the rasterized terminal image and the native TSP blob.
 *
 * Styled after Apple's charts and Tern's UI: a UI sans (Geist where Tern
 * provides it), muted labels, hairline gridlines that recede behind the
 * marks, bars and cells with rounded corners, smooth lines over a soft area
 * fill, dot legends. 13-unit labels land near the terminal's own glyph size
 * at 16 user units per row; bolded table cells draw at full strength while
 * their neighbours recede.
 */
import type { ChartPoint, ChartSeries, ChartSpec } from "./chart-plan";
import type { Dimension } from "./table-data";

const WIDTH = 720;
const PAD = 12;
const LABEL_SIZE = 13;
const TICK_SIZE = 11;
/** Mean advance per em of the UI sans, for character budgets; {@link measure} estimates real widths. */
const ADVANCE = 0.55;
const FONT =
	"Geist, -apple-system, system-ui, 'SF Pro Text', 'Helvetica Neue', Inter, 'Segoe UI', Roboto, 'Noto Sans', 'DejaVu Sans', Arial, sans-serif";
/** Series colors in draw order. */
const SERIES = ["c1", "c2", "c3", "c4", "c5", "c6"] as const;
/** Corner radius of bars, tracks and cells. */
const RADIUS = 3;
/** Opacity of gridlines over the border color: hairlines behind the marks. */
const GRID_OPACITY = 0.5;
/** Ratio between line series' peaks from which they stop sharing an axis. */
const SPLIT_SPREAD = 8;
/** Most categories whose every sample draws as a dot on its line. */
const MAX_DOTS = 16;
/** Spread (max/min of positive values) from which an axis turns logarithmic. */
const LOG_SPREAD = 100;
const MAX_LABEL_CHARS = 28;
/** Opacity of marks beside an emphasized one. */
const RECEDE = 0.45;
/** Most panels across one band of small multiples drawn as panels. */
const PANELS_ACROSS = 3;
/** Factors a change axis rounds its ends out to; past the last, whole powers of ten. */
const FACTOR_STOPS = [1.25, 1.5, 2, 3, 5, 10];

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
	const versus = spec.baseline ? ` vs ${spec.baseline}` : "";
	return `${kind} chart of ${names}${versus}${spec.axis ? ` by ${spec.axis}` : ""}`;
}

function drawChart(spec: ChartSpec): Layer {
	switch (spec.kind) {
		case "line":
			return drawLine(spec);
		case "heatmap":
			return drawGrid(spec, "heat");
		case "multiples":
			// Many panels of a few colorable categories wrap into bands; otherwise one column per panel.
			return spec.series.length > PANELS_ACROSS && spec.categories.length <= SERIES.length
				? drawPanels(spec)
				: drawGrid(spec, "bars");
		case "change":
			return drawChange(spec);
		case "share":
			return drawShare(spec);
		case "scatter":
			return drawScatter(spec);
		default:
			return drawBars(spec);
	}
}

// ── Horizontal bars: bar, grouped, paired, diverging, progress ───────────────

function drawBars(spec: ChartSpec): Layer {
	const { kind, categories, series } = spec;
	// Progress fills a 0–100% track per bar; grouped and multi-track progress stack thin bars per category.
	const tracks = kind === "progress";
	const grouped = kind === "grouped" || (tracks && series.length > 1);
	const values = tracks
		? [0, 100]
		: series.flatMap(entry =>
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
	const groupRow = grouped ? series.length * 11 + 8 : 22;
	const gridTop = top;
	const gridBottom = top + categories.length * groupRow;
	parts.push(drawValueAxis(scale, series[0]!, gridTop, gridBottom));

	const zero = scale.log ? left : scale.at(0);
	const emphasized = series.some(entry => entry.points.some(point => point?.emphasis));
	categories.forEach((name, at) => {
		const rowTop = top + at * groupRow;
		const middle = rowTop + groupRow / 2;
		parts.push(categoryLabel(name, middle));
		if (kind === "paired") {
			const [a, b] = [series[0]!.points[at], series[1]!.points[at]];
			if (a && b) parts.push(line(scale.at(a.value), middle, scale.at(b.value), middle, "border", 4, 0.6));
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
		const barHeight = grouped ? 9 : 14;
		series.forEach((entry, index) => {
			const point = entry.points[at];
			const y = grouped ? rowTop + 4 + index * 11 : middle - barHeight / 2;
			const fill = kind === "diverging" && point && point.value < 0 ? "c2" : seriesColor(kind, index);
			const opacity = emphasized && !point?.emphasis ? RECEDE : 1;
			if (tracks) parts.push(rect(left, y, scale.at(100) - left, barHeight, "border", 0.35));
			if (!point) {
				const note = entry.notes[at];
				if (note)
					parts.push(text(left + 4, y + barHeight / 2, clip(note, 16), { size: TICK_SIZE, fill: "warning" }));
				return;
			}
			const end = scale.at(point.value);
			if (scale.log) {
				parts.push(rule(left, y + barHeight / 2, end, y + barHeight / 2));
				parts.push(dot(end, y + barHeight / 2, barHeight / 2.8, fill, opacity));
			} else {
				parts.push(rect(Math.min(zero, end), y, Math.abs(end - zero), barHeight, fill, opacity));
			}
			if (point.upper !== undefined) parts.push(whisker(end, scale.at(point.upper), y + barHeight / 2, fill));
			if (grouped) {
				const labelX = tracks
					? scale.at(100) + 4
					: Math.max(end, point.upper === undefined ? end : scale.at(point.upper)) + 4;
				parts.push(text(labelX, y + barHeight / 2, clip(point.text, 12), { size: 10, fill: "muted" }));
			}
		});
		if (series.length === 1) {
			const point = series[0]!.points[at];
			const end = point
				? Math.max(scale.at(point.value), point.upper === undefined ? 0 : scale.at(point.upper))
				: left;
			// Clear the dot a log axis draws instead of a bar.
			const x = kind === "diverging" || tracks ? right + 8 : Math.max(end, zero) + (scale.log ? 11 : 6);
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

/** Series color: dumbbells pair a muted "before" with the lead series color "after". */
function seriesColor(kind: ChartSpec["kind"], index: number): string {
	if (kind === "paired") return index === 0 ? "muted" : SERIES[0];
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
		parts.push(categoryLabel(name, y + rowHeight / 2));
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
				parts.push(rect(x + 1, y + 1, cellWidth - 2, rowHeight - 2, SERIES[0], 0.08 + 0.57 * level));
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
			parts.push(rule(x, top, x, top + categories.length * rowHeight));
		}
	}
	return { height: top + categories.length * rowHeight + 4, body: parts.join("") };
}

/**
 * Small multiples as bands of panels, one per series, each scaling its own
 * bars; the few categories are told apart by color through a legend. Fits a
 * table whose rows are metrics: each metric gets a panel comparing the columns.
 */
function drawPanels(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const legend = drawLegend(
		categories.map((name, at) => [name, SERIES[at % SERIES.length]!]),
		PAD,
		WIDTH - PAD,
	);
	const parts = [legend.body];
	const bands = Math.ceil(series.length / PANELS_ACROSS);
	const across = Math.ceil(series.length / bands);
	const gap = 18;
	const panelWidth = (WIDTH - 2 * PAD - gap * (across - 1)) / across;
	const panelHeight = 20 + categories.length * 14 + 12;
	const top = legend.height + 10;
	const titleChars = Math.floor(panelWidth / (TICK_SIZE * ADVANCE));
	series.forEach((entry, index) => {
		const x = PAD + (index % across) * (panelWidth + gap);
		const y = top + Math.floor(index / across) * panelHeight;
		parts.push(text(x, y + 6, clip(entry.name, titleChars), { size: TICK_SIZE, fill: "fg", weight: 600 }));
		const scale = intensity(entry.points.flatMap(point => (point ? [point.value] : [])));
		const textWidth = Math.max(0, ...entry.points.map((_, at) => measure(pointText(entry, at), 10)));
		const barSpace = Math.max(0, panelWidth - textWidth - 6);
		const emphasized = entry.points.some(point => point?.emphasis);
		entry.points.forEach((point, at) => {
			const middle = y + 27 + at * 14;
			if (!point) {
				const note = entry.notes[at];
				if (note) parts.push(text(x, middle, clip(note, titleChars), { size: 10, fill: "warning" }));
				return;
			}
			const width = Math.max(1, scale(point.value) * barSpace);
			const color = SERIES[at % SERIES.length]!;
			parts.push(rect(x, middle - 5, width, 10, color, emphasized && !point.emphasis ? RECEDE : 1));
			parts.push(
				text(x + width + 4, middle, pointText(entry, at), {
					size: 10,
					fill: point.emphasis ? "fg" : "muted",
					weight: point.emphasis ? 600 : undefined,
				}),
			);
		});
	});
	return { height: top + bands * panelHeight - 8, body: parts.join("") };
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

// ── Change against a baseline ───────────────────────────────────────────────

/**
 * Factors on a log axis through 1× (the baseline): each metric's bar runs from
 * 1× to its factor, so halving and doubling draw equally long whatever the
 * metric's unit. One series prints the factor and both figures beside its bar.
 */
function drawChange(spec: ChartSpec): Layer {
	const { categories, series } = spec;
	const single = series.length === 1;
	const points = series.flatMap(entry => entry.points.filter(point => point !== null));
	const logs = points.flatMap(point => (point.value > 0 ? [Math.log10(point.value)] : []));
	let low = -roundFactor(-Math.min(0, ...logs));
	let high = roundFactor(Math.max(0, ...logs));
	// A drop to zero has no factor; its bar runs to the axis end.
	if (points.some(point => point.value === 0)) low = Math.min(low, -Math.log10(2));
	if (low === high) high = Math.log10(FACTOR_STOPS[0]!);

	const parts: string[] = [];
	let top = 0;
	if (!single) {
		const legend = drawLegend(
			[
				...series.map((entry, at): [string, string] => [entry.name, SERIES[at % SERIES.length]!]),
				[spec.baseline ?? "baseline", "muted"],
			],
			PAD,
			WIDTH - PAD,
		);
		parts.push(legend.body);
		top += legend.height + 6;
	}
	const factors = categories.map((_, at) => (single ? factorText(series[0]!.points[at]) : ""));
	const factorWidth = Math.max(0, ...factors.map(label => measure(label, TICK_SIZE)));
	const figures = categories.map((_, at) => (single ? (series[0]!.points[at]?.text ?? "") : ""));
	const figureWidth = Math.max(0, ...figures.map(label => measure(label, TICK_SIZE)));
	const valueWidth = single
		? Math.min(280, factorWidth + 10 + figureWidth) + 8
		: Math.max(0, ...points.map(point => measure(factorText(point), 10))) + 8;
	const left = PAD + labelColumnWidth(categories) + 10;
	const right = WIDTH - PAD - valueWidth;
	const x = (log: number) => left + ((log - low) / (high - low)) * (right - left);
	const rowHeight = single ? 22 : series.length * 11 + 8;
	const barHeight = single ? 14 : 9;
	const gridBottom = top + categories.length * rowHeight;

	// 1× always; the ends and whole decades between wherever their labels stay clear of the rest.
	const decade = (right - left) / (high - low);
	const ticks = [0];
	for (const end of [low, high]) if (Math.abs(end) * decade >= 40) ticks.push(end);
	for (let power = Math.ceil(low); power <= Math.floor(high); power++) {
		if (ticks.every(tick => Math.abs(power - tick) * decade >= 40)) ticks.push(power);
	}
	for (const tick of new Set(ticks)) {
		parts.push(rule(x(tick), top, x(tick), gridBottom));
		const label = tick === 0 ? "1×" : `${tick < 0 ? "÷" : "×"}${compactFactor(10 ** Math.abs(tick))}`;
		parts.push(text(x(tick), gridBottom + 12, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
	}

	const emphasized = points.some(point => point.emphasis);
	// The epsilon keeps a figure that exactly fits from clipping on float error.
	const figureChars = Math.floor((valueWidth - 18 - factorWidth) / (TICK_SIZE * ADVANCE) + 1e-6);
	categories.forEach((name, row) => {
		const rowTop = top + row * rowHeight;
		const middle = rowTop + rowHeight / 2;
		parts.push(categoryLabel(name, middle));
		series.forEach((entry, index) => {
			const point = entry.points[row];
			if (!point) return;
			const y = single ? middle - barHeight / 2 : rowTop + 4 + index * 11;
			const end = x(point.value > 0 ? Math.log10(point.value) : low);
			const color = SERIES[single ? 0 : index % SERIES.length]!;
			const opacity = emphasized && !point.emphasis ? RECEDE : 1;
			parts.push(rect(Math.min(x(0), end), y, Math.max(1, Math.abs(end - x(0))), barHeight, color, opacity));
			if (!single) parts.push(text(right + 8, y + barHeight / 2, factorText(point), { size: 10, fill: "muted" }));
		});
		if (single) {
			const strong = series[0]!.points[row]?.emphasis ? 600 : undefined;
			parts.push(text(right + 8, middle, factors[row]!, { size: TICK_SIZE, fill: "fg", weight: strong }));
			parts.push(
				text(right + 18 + factorWidth, middle, clip(figures[row]!, figureChars), {
					size: TICK_SIZE,
					fill: "muted",
				}),
			);
		}
	});
	parts.push(line(x(0), top - 2, x(0), gridBottom + 2, "muted", 1.5));
	return { height: gridBottom + 20, body: parts.join("") };
}

/** `log10` of the first {@link FACTOR_STOPS} entry (else power of ten) at or past `10^log`; 0 stays 0. */
function roundFactor(log: number): number {
	if (log <= 0) return 0;
	const stop = FACTOR_STOPS.find(factor => Math.log10(factor) >= log - 1e-9);
	return stop === undefined ? Math.ceil(log - 1e-9) : Math.log10(stop);
}

/** A factor as people say it: `48× less`, `2.1× more`, or a percent within 2× (`−12%`, `+27%`). */
function factorText(point: ChartPoint | null | undefined): string {
	if (!point) return "";
	const factor = point.value;
	if (factor === 0) return "−100%";
	if (factor >= 2) return `${compactFactor(factor)}× more`;
	if (factor <= 0.5) return `${compactFactor(1 / factor)}× less`;
	const percent = Math.round((factor - 1) * 100);
	return percent === 0 ? "same" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

/** `48`, `2.1`, `1.25`, `35k`: whole above 10, one decimal above 2, two below. */
function compactFactor(factor: number): string {
	if (factor >= 10) return compact(Math.round(factor));
	return Number(factor.toFixed(factor >= 2 ? 1 : 2)).toString();
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
		// Segments part with a sliver of the surface behind them.
		parts.push(rect(x, 1, Math.max(1, width - 2), 18, SERIES[at % SERIES.length]!, 1));
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
		parts.push(dot(lx + 5, ly, 4.5, SERIES[at % SERIES.length]!));
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

/** A line's value label at its end, nudged clear of its neighbours by {@link spreadLabels}. */
interface EndLabel {
	readonly x: number;
	y: number;
	readonly text: string;
	readonly color: string;
}

/**
 * Lines across the categories (or the numeric x), smoothed without
 * overshooting a sample. Series whose peaks differ {@link SPLIT_SPREAD}× or
 * more stack in panels on their own axes, so one large series never flattens
 * the rest; the panels share the x labels under the last. A lone line draws
 * over a soft area fill, and every line ends in its value.
 */
function drawLine(spec: ChartSpec): Layer {
	const { categories, series, x } = spec;
	const panels = magnitudePanels(series);
	const values = panels.map(panel =>
		panel.flatMap(index => series[index]!.points.flatMap(point => (point ? [point.value] : []))),
	);
	const tickWidth = Math.max(
		...values.flatMap(panelValues => {
			const scale = valueScale(panelValues, 0, 1, { zero: false });
			const format = tickFormat(scale, series[0]!);
			return scale.ticks.map(tick => measure(format(tick), TICK_SIZE));
		}),
	);
	const position = (at: number) => (x ? x.values[at]! : at);
	const order = categories.map((_, at) => at).sort((a, b) => position(a) - position(b));
	// The rightmost sample of each line carries its value label.
	const lasts = series.map(entry => order.findLast(at => entry.points[at]) ?? -1);
	const endWidth = Math.max(
		0,
		...lasts.map((last, index) => measure(series[index]!.points[last]?.text ?? "", TICK_SIZE)),
	);
	const left = PAD + tickWidth + 8;
	const right = WIDTH - PAD - Math.min(120, endWidth + 10);
	const xScale = x
		? valueScale(x.values, left, right, { zero: false })
		: {
				at: (index: number) =>
					left + (categories.length === 1 ? 0 : (index / (categories.length - 1)) * (right - left)),
			};
	const xAt = (at: number) => xScale.at(position(at));
	const plotHeight = panels.length === 1 ? 180 : Math.max(72, Math.round(200 / panels.length));
	const dotted = categories.length <= MAX_DOTS;

	const parts: string[] = [];
	let top = 0;
	let plotBottom = 0;
	panels.forEach((panel, panelIndex) => {
		// Several lines need names, and so does a panel of one beside others.
		if (series.length > 1) {
			const legend = drawLegend(
				panel.map(index => [series[index]!.name, SERIES[index % SERIES.length]!]),
				PAD,
				WIDTH - PAD,
			);
			parts.push(`<g transform="translate(0 ${num(top)})">${legend.body}</g>`);
			top += legend.height + 4;
		}
		const plotTop = top + 6;
		plotBottom = plotTop + plotHeight;
		const scale = valueScale(values[panelIndex]!, plotBottom, plotTop, { zero: false });
		const format = tickFormat(scale, series[0]!);
		// Short panels label every other gridline.
		const labelEvery = plotHeight / Math.max(1, scale.ticks.length - 1) < 20 ? 2 : 1;
		scale.ticks.forEach((tick, at) => {
			const y = scale.at(tick);
			parts.push(rule(left, y, right, y));
			if (at % labelEvery === 0)
				parts.push(text(left - 8, y, format(tick), { size: TICK_SIZE, fill: "muted", anchor: "end" }));
		});
		const ends: EndLabel[] = [];
		for (const index of panel) {
			const entry = series[index]!;
			const color = SERIES[index % SERIES.length]!;
			// Runs of consecutive samples; a gap in the table breaks the line.
			const runs: [number, number][][] = [[]];
			for (const at of order) {
				const point = entry.points[at];
				if (point) runs.at(-1)!.push([xAt(at), scale.at(point.value)]);
				else if (runs.at(-1)!.length > 0) runs.push([]);
			}
			if (panel.length === 1) {
				// The fade's id names its color, so two charts inlined in one page agree on it.
				parts.push(
					`<defs><linearGradient id="fade-${color}" x1="0" y1="0" x2="0" y2="1">`,
					`<stop offset="0" stop-color="${token(color)}" stop-opacity="0.26"/>`,
					`<stop offset="1" stop-color="${token(color)}" stop-opacity="0"/>`,
					"</linearGradient></defs>",
				);
				for (const run of runs) {
					if (run.length < 2) continue;
					const floor = `L${num(run.at(-1)![0])} ${num(plotBottom)}L${num(run[0]![0])} ${num(plotBottom)}Z`;
					parts.push(`<path d="${smoothPath(run)}${floor}" fill="url(#fade-${color})"/>`);
				}
			}
			for (const run of runs) {
				if (run.length < 2) continue;
				parts.push(
					`<path d="${smoothPath(run)}" fill="none" stroke="${token(color)}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>`,
				);
			}
			const last = lasts[index]!;
			entry.points.forEach((point, at) => {
				if (!point || !(dotted || point.emphasis || at === last)) return;
				parts.push(dot(xAt(at), scale.at(point.value), point.emphasis ? 4.5 : at === last ? 3.5 : 2.5, color));
			});
			const end = entry.points[last];
			if (end) ends.push({ x: xAt(last) + 8, y: scale.at(end.value), text: end.text, color });
		}
		parts.push(spreadLabels(ends, plotTop - 4, plotBottom + 4));
		top = plotBottom + 22;
	});

	// Category labels left to right, skipping any that would touch the last one drawn.
	const slot = (right - left) / Math.max(1, categories.length - 1);
	const labelChars = Math.max(3, Math.floor(Math.max(slot, 60) / (TICK_SIZE * ADVANCE)) - 1);
	let drawnEnd = Number.NEGATIVE_INFINITY;
	for (const at of order) {
		const label = clip(categories[at]!, labelChars);
		const width = measure(label, TICK_SIZE);
		const center = Math.min(Math.max(xAt(at), left + width / 2), WIDTH - PAD - width / 2);
		if (center - width / 2 < drawnEnd + 8) continue;
		parts.push(text(center, plotBottom + 14, label, { size: TICK_SIZE, fill: "muted", anchor: "middle" }));
		drawnEnd = center + width / 2;
	}
	return { height: plotBottom + 24, body: parts.join("") };
}

/**
 * Series indices grouped into panels whose peaks stay within
 * {@link SPLIT_SPREAD}× of the panel's largest, panels and their series in
 * table order. An all-zero series joins the smallest panel.
 */
function magnitudePanels(series: readonly ChartSeries[]): number[][] {
	const peaks = series.map(entry => Math.max(0, ...entry.points.map(point => (point ? Math.abs(point.value) : 0))));
	const panels: number[][] = [];
	let panelPeak = 0;
	for (const index of series.map((_, at) => at).sort((a, b) => peaks[b]! - peaks[a]!)) {
		const peak = peaks[index]!;
		if (panels.length > 0 && (peak === 0 || panelPeak < peak * SPLIT_SPREAD)) {
			panels.at(-1)!.push(index);
		} else {
			panels.push([index]);
			panelPeak = peak;
		}
	}
	for (const panel of panels) panel.sort((a, b) => a - b);
	return panels.sort((a, b) => a[0]! - b[0]!);
}

/**
 * A path through `points` (x ascending) as a monotone cubic (Steffen's
 * method): smooth, yet never overshooting a sample the way a Catmull-Rom
 * curve would between a peak and a flat stretch.
 */
function smoothPath(points: readonly (readonly [number, number])[]): string {
	const n = points.length;
	let path = `M${num(points[0]![0])} ${num(points[0]![1])}`;
	if (n < 3) return n === 2 ? `${path}L${num(points[1]![0])} ${num(points[1]![1])}` : path;
	const secants: number[] = [];
	for (let at = 0; at < n - 1; at++) {
		const h = points[at + 1]![0] - points[at]![0];
		secants.push(h === 0 ? 0 : (points[at + 1]![1] - points[at]![1]) / h);
	}
	const tangents: number[] = [0];
	for (let at = 1; at < n - 1; at++) {
		const h0 = points[at]![0] - points[at - 1]![0];
		const h1 = points[at + 1]![0] - points[at]![0];
		const [s0, s1] = [secants[at - 1]!, secants[at]!];
		const weighted = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
		tangents.push((Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(weighted)));
	}
	tangents[0] = (3 * secants[0]! - tangents[1]!) / 2;
	tangents.push((3 * secants[n - 2]! - tangents[n - 2]!) / 2);
	for (let at = 0; at < n - 1; at++) {
		const [x0, y0] = points[at]!;
		const [x1, y1] = points[at + 1]!;
		const third = (x1 - x0) / 3;
		path += `C${num(x0 + third)} ${num(y0 + third * tangents[at]!)} ${num(x1 - third)} ${num(y1 - third * tangents[at + 1]!)} ${num(x1)} ${num(y1)}`;
	}
	return path;
}

/** End labels in their lines' colors, nudged apart so none overlap, kept between `top` and `bottom` where they fit. */
function spreadLabels(labels: EndLabel[], top: number, bottom: number): string {
	const gap = TICK_SIZE + 2;
	labels.sort((a, b) => a.y - b.y);
	for (let at = 1; at < labels.length; at++) labels[at]!.y = Math.max(labels[at]!.y, labels[at - 1]!.y + gap);
	for (let at = labels.length - 1; at >= 0; at--) {
		const limit = at === labels.length - 1 ? bottom : labels[at + 1]!.y - gap;
		labels[at]!.y = Math.max(top, Math.min(labels[at]!.y, limit));
	}
	return labels
		.map(label => text(label.x, label.y, label.text, { size: TICK_SIZE, fill: label.color, weight: 600 }))
		.join("");
}

// ── Scatter ──────────────────────────────────────────────────────────────────

function drawScatter(spec: ChartSpec): Layer {
	const entry = spec.series[0]!;
	const xs = spec.x!;
	const ys = entry.points.map(point => point?.value ?? Number.NaN);
	const finite = (values: readonly number[]) => values.filter(Number.isFinite);
	const yAxis = valueScale(finite(ys), 0, 1, { zero: false });
	const yFormat = tickFormat(yAxis, entry);
	const left = PAD + Math.max(...yAxis.ticks.map(tick => measure(yFormat(tick), TICK_SIZE))) + 8;
	const right = WIDTH - PAD - 80;
	const top = 18;
	const bottom = top + 200;
	const xScale = valueScale(finite(xs.values), left, right, { zero: false });
	const yScale = valueScale(finite(ys), bottom, top, { zero: false });
	const parts: string[] = [text(left, 6, entry.name, { size: TICK_SIZE, fill: "muted" })];
	for (const tick of yScale.ticks) {
		parts.push(rule(left, yScale.at(tick), right, yScale.at(tick)));
		parts.push(
			text(left - 8, yScale.at(tick), yFormat(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "end",
			}),
		);
	}
	const xFormat = tickFormat(xScale, xs);
	for (const tick of xScale.ticks) {
		parts.push(
			text(xScale.at(tick), bottom + 14, xFormat(tick), {
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
		parts.push(dot(px, py, point.emphasis ? 5 : 3.5, SERIES[0], point.emphasis ? 1 : 0.85));
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
	const format = tickFormat(scale, series);
	for (const tick of scale.ticks) {
		const x = scale.at(tick);
		parts.push(rule(x, top, x, bottom));
		parts.push(
			text(x, bottom + 12, format(tick), {
				size: TICK_SIZE,
				fill: "muted",
				anchor: "middle",
			}),
		);
	}
	return parts.join("");
}

/** Dot-and-name legend wrapping across `left`…`right`. */
function drawLegend(items: readonly (readonly [string, string])[], left: number, right: number): Layer {
	const parts: string[] = [];
	let x = left;
	let y = 6;
	for (const [name, color] of items) {
		const label = clip(name, 32);
		const width = 12 + measure(label, TICK_SIZE) + 18;
		if (x + width > right && x > left) {
			x = left;
			y += 18;
		}
		parts.push(dot(x + 4, y, 4, color));
		parts.push(text(x + 12, y, label, { size: TICK_SIZE, fill: "muted" }));
		x += width;
	}
	return { height: y + 8, body: parts.join("") };
}

/**
 * A category's name at the start of the label column. Starting there, a name
 * set wider than {@link measure} estimates (another font, a larger size)
 * runs toward the plot instead of off the canvas's left edge.
 */
function categoryLabel(name: string, y: number): string {
	return text(PAD, y, clip(name, MAX_LABEL_CHARS), { fill: "fg" });
}

/** Width of the category label column. */
function labelColumnWidth(categories: readonly string[]): number {
	const widest = Math.max(...categories.map(name => measure(clip(name, MAX_LABEL_CHARS), LABEL_SIZE)));
	return Math.max(4 * LABEL_SIZE * ADVANCE, widest);
}

/**
 * Labels for a linear axis' ticks in one unit, so it reads `0, 5k, 10k`
 * rather than `0, 5000, 10k`; a log axis spans units, each tick in its own.
 */
function tickFormat(scale: Scale, axis: { readonly dim: Dimension; readonly unit: string }): (tick: number) => string {
	if (scale.log) return tick => formatValue(tick, axis.dim, axis.unit);
	const magnitude = Math.max(0, ...scale.ticks.map(Math.abs));
	return tick => formatValue(tick, axis.dim, axis.unit, magnitude);
}

/** A point's written figure, or its value formatted when the table wrote none. */
function pointText(series: ChartSeries, at: number): string {
	const point: ChartPoint | null | undefined = series.points[at];
	if (!point) return "";
	return point.text || formatValue(point.value, series.dim, series.unit);
}

/**
 * A value in base units as an axis label: durations and sizes in the unit,
 * counts compacted under the suffix (`12k`, `3.4M`), that `magnitude` reads
 * best in — the value's own size by default, an axis' largest tick to keep
 * its labels in one unit.
 */
export function formatValue(value: number, dim: Dimension, unit: string, magnitude = Math.abs(value)): string {
	switch (dim) {
		case "percent":
			return `${compact(value, magnitude)}%`;
		case "ratio":
			return `${compact(value, magnitude)}×`;
		case "currency":
			return `${value < 0 ? "-" : ""}${unit}${compact(Math.abs(value), magnitude)}`;
		case "duration": {
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
			let index = 0;
			while (magnitude >= 1000 ** (index + 1) && index < units.length - 1) index++;
			return `${compact(value / 1000 ** index)}${units[index]}`;
		}
		default:
			return compact(value, magnitude);
	}
}

/** `1234567` → `1.2M`, `0.0123` → `0.012`; the suffix follows `magnitude` (`5000` → `5k` beside `10k`). */
function compact(value: number, magnitude = Math.abs(value)): string {
	if (value === 0) return "0";
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

/** Narrow and wide glyphs of a UI sans (Geist, SF Pro, Helvetica Neue), for {@link measure}. */
const NARROW = "iljtfrI.,:;'!|()[] ";
const WIDE = "mwMW%@—";

/** Estimated width of `content` set in the chart's sans at `size`. */
function measure(content: string, size: number): number {
	let em = 0;
	for (const char of content) {
		if (NARROW.includes(char)) em += 0.3;
		else if (WIDE.includes(char)) em += 0.85;
		else if (char >= "0" && char <= "9") em += 0.58;
		else if (char >= "A" && char <= "Z") em += 0.66;
		else if (char.codePointAt(0)! >= 0x1100) em += 1;
		else em += 0.53;
	}
	return em * size;
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

/** A rectangle with corners rounded by {@link RADIUS}, less for one too small to hold it. */
function rect(x: number, y: number, width: number, height: number, fill: string, opacity: number): string {
	const w = Math.max(0, width);
	const radius = Math.min(RADIUS, w / 2, height / 2);
	const rounded = radius >= 0.5 ? ` rx="${num(radius)}"` : "";
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(height)}"${rounded} fill="${token(fill)}"${alpha}/>`;
}

/** A round-capped line. */
function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, opacity = 1): string {
	const alpha = opacity < 1 ? ` stroke-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${token(stroke)}" stroke-width="${width}" stroke-linecap="round"${alpha}/>`;
}

/** A gridline: a hairline that recedes behind the marks. */
function rule(x1: number, y1: number, x2: number, y2: number): string {
	return line(x1, y1, x2, y2, "border", 1, GRID_OPACITY);
}

function dot(x: number, y: number, radius: number, fill: string, opacity = 1): string {
	const alpha = opacity < 1 ? ` fill-opacity="${Number(opacity.toFixed(2))}"` : "";
	return `<circle cx="${num(x)}" cy="${num(y)}" r="${radius}" fill="${token(fill)}"${alpha}/>`;
}

/** Range whisker from a value to its upper bound, capped at both ends. */
function whisker(from: number, to: number, y: number, stroke: string): string {
	return `${line(from, y, to, y, stroke, 1.5)}${line(to, y - 4, to, y + 4, stroke, 1.5)}`;
}
