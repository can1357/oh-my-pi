/**
 * Which chart a table becomes and the data it plots. {@link planChart} is the
 * local best guess over a {@link TableAnalysis}: the chart kind, the label
 * column and the measure columns to draw. A host may substitute its own
 * {@link ChartPlan} (a model's pick for a multi-series table); either way
 * {@link buildChart} turns it into the {@link ChartSpec} that
 * {@link renderChartSvg} draws, and {@link worthCharting} decides whether
 * the picture says more than the table already does.
 *
 * The heuristics were fitted on ~7k tables from real assistant answers: the
 * label is the first text column (index columns like `#`/`Rank` never are),
 * table order is kept (most tables are deliberately unsorted), total rows stay
 * out of the scale, and units never share an axis.
 */
import {
	type Cell,
	type Dimension,
	isMonotonic,
	isNumber,
	type NumberCell,
	type TableAnalysis,
	type TableColumn,
} from "./table-data";

/**
 * Chart kinds, by the table shapes they fit:
 * - `bar`: one measure across categories.
 * - `paired`: two same-unit measures per category (before/after, A vs B), or `a → b` cells.
 * - `grouped`: three or four same-unit measures per category.
 * - `line`: measures over an ordered axis (dates, runs, sizes).
 * - `heatmap`: a matrix of same-unit values.
 * - `multiples`: measures in different units, each scaled on its own; transposed when each row is its own metric.
 * - `share`: parts of a whole (percentages summing to 100).
 * - `diverging`: signed changes around zero.
 * - `scatter`: two continuous measures per item.
 * - `change`: metrics in different units against a baseline column (before/after), as factors.
 * - `progress`: scores out of a total (`12/12`), as filled tracks.
 */
export type ChartKind =
	| "bar"
	| "paired"
	| "grouped"
	| "line"
	| "heatmap"
	| "multiples"
	| "share"
	| "diverging"
	| "scatter"
	| "change"
	| "progress";

/** What to draw from a table: the kind, the column naming each category, and the columns plotted. */
export interface ChartPlan {
	readonly kind: ChartKind;
	/** Column naming each category (or holding the x values of a line); rows are numbered without one. */
	readonly label: number | undefined;
	/** Plotted columns, in order; a `change` measures the rest against the first (or its `a → b` cells). */
	readonly series: readonly number[];
	/** Each data row is its own series (a metric with its own unit) and the plotted columns are the categories. */
	readonly transpose: boolean;
}

/** One plotted value. */
export interface ChartPoint {
	/** Value in base units (seconds, bytes, …). */
	readonly value: number;
	/** The number as the table wrote it (`~$250`, `12.5 ms`), shown as the value label. */
	readonly text: string;
	/** The table bolded the cell. */
	readonly emphasis: boolean;
	/** Upper end of a range cell (`24–72 h`). */
	readonly upper?: number;
}

export interface ChartSeries {
	readonly name: string;
	readonly dim: Dimension;
	/** Currency symbol or rate unit the axis prints; empty for other dimensions. */
	readonly unit: string;
	/** One per category; `null` where the cell holds no number of this series' dimension. */
	readonly points: readonly (ChartPoint | null)[];
	/** Status words standing in for a value (`TIMEOUT`, `OOM`), one per category. */
	readonly notes: readonly (string | undefined)[];
}

/** The data a chart draws, independent of how it is drawn. */
export interface ChartSpec {
	readonly kind: ChartKind;
	readonly categories: readonly string[];
	readonly series: readonly ChartSeries[];
	/** Numeric x positions of a line or the x measure of a scatter, one per category. */
	readonly x?: {
		readonly name: string;
		readonly dim: Dimension;
		readonly unit: string;
		readonly values: readonly number[];
	};
	/** Total/summary rows, printed under the chart instead of skewing its scale. */
	readonly caption?: string;
	/** Name of the category axis (the label column's header). */
	readonly axis: string;
	/** What a `change` measures against (its baseline column); its points are factors of it. */
	readonly baseline?: string;
}

const BEFORE =
	/\b(?:before|old|baseline|base|main|master|prev|previous|original|orig|cold|was|from|v1|stock|default|unpatched|without)\b/i;
const AFTER = /\b(?:after|new|patched|optimi[sz]ed|fixed|warm|now|to|v2|with|proposed|branch|pr|ours)\b/i;
const DELTA = /(?:Δ|delta|change|diff|improvement|speedup|reduction|savings|saved|gain|regression|% chg)/i;
/** Aggregate columns that restate the others; dropped when enough same-unit series remain. */
const AGGREGATE = /^(?:total|sum|cumulative|cum\.?|running total|avg|average|mean)\b/i;
/** The arrow of an `a → b` header or cell, with the spaces around it. */
const ARROW = /\s*(?:→|->|⇒)\s*/;
/** Row labels that name an ordered step (`Run 3`, `Day 2`, `N=1000`, `Q3`). */
const SEQUENCE_LABEL =
	/^(?:run|day|week|month|iter(?:ation)?|round|step|phase|epoch|v|version|n\s*=|wave|attempt|pass|batch|q[1-4]|#)\s*\d/i;
const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
/** Most panels a small-multiples grid stays legible with. */
const MAX_PANELS = 6;
/** Most lines one line chart keeps apart. */
const MAX_LINES = 6;
/** Most series a `progress` pick draws as tracks per category; more read as bars or a heatmap. */
const MAX_TRACKS = 3;
/** Smallest factor (either way) that makes a `change` chart say more than its table. */
const NOTABLE_FACTOR = 1.5;

/** The local best guess at a chart for `table`, or `undefined` when no chart fits. */
export function planChart(table: TableAnalysis): ChartPlan | undefined {
	const { rows } = table;
	let label = table.label;
	const change = changeColumns(table);
	if (change)
		return { kind: "change", label: label?.index, series: change.map(column => column.index), transpose: false };
	let measures = dropAggregates(table.measures);
	if (measures.length === 0 || rows.length < 2) return undefined;

	let order = axisOrder(table, label);
	// Without a name column, a monotonic leading measure (`Workers | p50 | p99`) is the
	// x axis of the rest; beside one it is just a sorted measure (`% | Self | Function`).
	if (!order && label?.role !== "label" && measures.length >= 2 && measures[0]!.index === 0 && rows.length >= 4) {
		const xs = columnValues(measures[0]!, rows);
		if (xs.length === rows.length && isMonotonic(xs)) {
			label = measures[0];
			measures = measures.slice(1);
			order = "numeric";
		}
	}
	const plan = (kind: ChartKind, series: readonly TableColumn[], transpose = false): ChartPlan => ({
		kind,
		label: label?.index,
		series: series.map(column => column.index),
		transpose,
	});

	// `a → b` cells: one axis when the rows share a unit, factors of change when each row has its own.
	if (measures.length === 1 && measures[0]!.arrowShare >= 0.6)
		return plan(measures[0]!.mixed ? "change" : "paired", measures);
	const mixed = measures.filter(column => column.mixed);
	if (mixed.length > 0 && mixed.length * 2 >= measures.length) return plan("multiples", measures, true);

	const dims = new Set(measures.map(column => column.dim));
	if (dims.size === 1 && measures.length >= 2 && measures.length <= 4) {
		const before = measures.find(column => BEFORE.test(column.header));
		const after = measures.find(column => column !== before && AFTER.test(column.header));
		if (before && after) return plan("paired", [before, after]);
	}
	if (rows.length === 2 && measures.length === 1) return undefined;
	if (order && rows.length >= 4) {
		const lead = measures[0]!.dim;
		return plan("line", measures.filter(column => column.dim === lead).slice(0, MAX_LINES));
	}
	// Several score columns compare like any same-unit measures (as rates); a lone one fills tracks.
	if (measures.length === 1 && measures[0]!.scores) return plan("progress", measures);
	if (measures.length <= 2) {
		const delta = measures.find(
			column =>
				(column.signedShare >= 0.6 || DELTA.test(column.header)) &&
				columnValues(column, rows).some(value => value < 0),
		);
		if (delta) return plan("diverging", [delta]);
	}
	const share = measures.find(column => column.dim === "percent" && !column.scores);
	if (share && rows.length <= 10 && (measures.length === 1 || (measures.length === 2 && dims.size === 2))) {
		const values = columnValues(share, rows);
		const sum = values.reduce((total, value) => total + value, 0);
		if (values.every(value => value >= 0) && sum >= 97 && sum <= 103) return plan("share", [share]);
	}
	if (dims.size === 1 && measures.length >= 4 && rows.length >= 3) return plan("heatmap", measures);
	if (!label && measures.length === 2 && rows.length >= 6) return plan("scatter", measures);
	if (dims.size >= 2) return plan("multiples", measures.slice(0, MAX_PANELS));
	if (measures.length === 2) return plan("paired", measures);
	if (measures.length >= 3) return plan("grouped", measures);
	return plan("bar", measures);
}

/**
 * The data `plan` draws from `table`, or `undefined` when it leaves fewer than
 * two categories or no series with two values. The kind is fitted to the
 * series it ends up with ({@link fitKind}), so any plan — a model's pick
 * included — draws as something the renderer supports.
 */
export function buildChart(table: TableAnalysis, plan: ChartPlan): ChartSpec | undefined {
	const label = plan.label === undefined ? undefined : table.columns[plan.label];
	const columns = plan.series.map(index => table.columns[index]).filter(column => column !== undefined);
	if (columns.length === 0) return undefined;
	if (plan.kind === "change" && !plan.transpose) return changeChart(table, label, columns);
	const rowName = (row: number, at: number) => (label ? label.cells[row]!.text : "") || `#${at + 1}`;

	let categories: string[];
	let series: ChartSeries[];
	if (plan.transpose) {
		categories = columns.map(column => column.header);
		series = table.rows.map((row, at) => rowSeries(rowName(row, at), columns, row));
	} else if (plan.kind === "paired" && columns.length === 1) {
		// `a → b` cells: the column splits into its from and to values.
		const column = columns[0]!;
		const [from, to] = arrowNames(column.header);
		const before = columnSeries(column, table.rows, from);
		const after: ChartSeries = {
			...before,
			name: to,
			points: table.rows.map(row => {
				const cell = column.cells[row];
				return isNumber(cell) && cell.to !== undefined
					? { value: cell.to, text: cell.toFigure ?? "", emphasis: cell.emphasis }
					: null;
			}),
		};
		categories = table.rows.map(rowName);
		series = [before, after];
	} else {
		categories = table.rows.map(rowName);
		series = columns.map(column => columnSeries(column, table.rows, column.header));
	}

	let x: ChartSpec["x"];
	if (plan.kind === "scatter" && series.length >= 2) {
		const xs = series[0]!;
		x = { name: xs.name, dim: xs.dim, unit: xs.unit, values: xs.points.map(entry => entry?.value ?? Number.NaN) };
		series = [series[1]!];
	} else if (plan.kind === "line" && label && !plan.transpose) {
		const values = table.rows.map(row => label.cells[row]).map(cell => (isNumber(cell) ? cell.value : Number.NaN));
		if (values.every(Number.isFinite) && isMonotonic(values)) {
			const first = label.cells[table.rows[0]!];
			x = {
				name: label.header,
				dim: isNumber(first) ? first.dim : "count",
				unit: label.unit,
				values,
			};
		}
	}

	series = series.filter(entry => entry.points.filter(point => point !== null).length >= 2);
	if (categories.length < 2 || series.length === 0) return undefined;
	const kind = plan.transpose ? "multiples" : fitKind(plan.kind, series, x !== undefined);
	// A share or a delta reads one series; the rest would overdraw it.
	if (kind === "share" || kind === "diverging") series = series.slice(0, 1);
	return {
		kind,
		categories,
		series,
		x,
		caption: totalsCaption(table, label, columns, plan.transpose),
		axis: label?.header ?? "",
	};
}

/**
 * Whether a chart of `spec` reads faster than its table: at least four
 * categories (or small-multiple panels), and either nine plotted values or a
 * 3× spread within a series. On a model-judged sample of assistant tables this
 * gate kept 85% of the tables a chart clearly helped while rejecting most two-
 * and three-row ones. A `change` needs three metrics and one moving by
 * {@link NOTABLE_FACTOR} either way: its factors are what the table lacks.
 */
export function worthCharting(spec: ChartSpec): boolean {
	const { kind, categories, series } = spec;
	// Factors share no unit with the table's figures: three metrics are enough once one moves noticeably.
	if (kind === "change")
		return (
			categories.length >= 3 &&
			series.some(entry =>
				entry.points.some(point => point && Math.abs(Math.log(point.value)) >= Math.log(NOTABLE_FACTOR)),
			)
		);
	// Small multiples compare within each panel, so four metrics count like four categories.
	if ((kind === "multiples" ? Math.max(categories.length, series.length) : categories.length) < 4) return false;
	let points = 0;
	let spread = 1;
	for (const entry of series) {
		const positive: number[] = [];
		for (const point of entry.points) {
			if (!point) continue;
			points++;
			if (point.value > 0) positive.push(point.value);
		}
		if (positive.length >= 2) spread = Math.max(spread, Math.max(...positive) / Math.min(...positive));
	}
	return points >= 9 || spread >= 3;
}

/**
 * The nearest kind `kind` draws as for `series`: a shared axis needs one unit
 * (else small multiples), bars take one series, a dumbbell two, grouped bars
 * up to four (more become a heatmap), and a scatter needs its x measure.
 */
function fitKind(kind: ChartKind, series: readonly ChartSeries[], hasX: boolean): ChartKind {
	if (kind === "multiples") return kind;
	if (kind === "scatter" && hasX) return kind;
	if (new Set(series.map(entry => `${entry.dim}:${entry.unit}`)).size > 1) return "multiples";
	if (kind === "share" || kind === "diverging" || kind === "line" || kind === "heatmap") return kind;
	if (
		kind === "progress" &&
		series.length <= MAX_TRACKS &&
		series.every(
			entry =>
				entry.dim === "percent" && entry.points.every(point => !point || (point.value >= 0 && point.value <= 100)),
		)
	)
		return kind;
	const count = series.length;
	return count === 1 ? "bar" : count === 2 ? "paired" : count <= 4 ? "grouped" : "heatmap";
}

/**
 * Baseline and compared columns of a before/after table a shared axis cannot
 * hold: rows in different units, or prose cells (`none seen`) keeping its
 * columns from reading as measures. The baseline is the `before` column; the
 * compared ones are the `after` column and any measure beside it pairing with
 * the baseline in two or more rows. Deltas and columns holding their own
 * `a → b` transitions take no part.
 */
function changeColumns(table: TableAnalysis): TableColumn[] | undefined {
	const { label } = table;
	if (label?.role !== "label") return undefined;
	const values = table.columns.filter(
		column =>
			column !== label &&
			(column.role === "measure" || column.role === "label") &&
			!DELTA.test(column.header) &&
			!ARROW.test(column.header) &&
			column.arrowShare < 0.6,
	);
	const baseline = values.find(column => BEFORE.test(column.header));
	if (!baseline) return undefined;
	const rows = [...table.rows, ...table.totals];
	const compared = values.filter(
		column =>
			column !== baseline &&
			(column.role === "measure" || AFTER.test(column.header)) &&
			rows.filter(row => changePoint(baseline.cells[row], column.cells[row])).length >= 2,
	);
	if (!compared.some(column => AFTER.test(column.header))) return undefined;
	const columns = [baseline, ...compared];
	// One unit throughout: a shared axis holds the values themselves (`paired`, `grouped`).
	if (columns.every(column => column.role === "measure" && !column.mixed)) return undefined;
	return columns;
}

/**
 * A `change` over `columns`: per row, each compared column as a factor of the
 * baseline's value, or the `a → b` cells of a lone column as factors of their
 * start. Total rows stay (a factor never skews the scale); rows with no pair
 * are named in the caption instead.
 */
function changeChart(
	table: TableAnalysis,
	label: TableColumn | undefined,
	columns: readonly TableColumn[],
): ChartSpec | undefined {
	const [baseline, ...compared] = columns;
	if (!baseline) return undefined;
	const [from, to] = arrowNames(baseline.header);
	const pairs = compared.length
		? compared.map(column => ({
				name: column.header,
				at: (row: number) => changePoint(baseline.cells[row], column.cells[row]),
			}))
		: [{ name: to, at: (row: number) => arrowChange(baseline.cells[row]) }];
	const rows = [...table.rows, ...table.totals].sort((a, b) => a - b);
	const name = (row: number) => (label ? label.cells[row]!.text : "") || `#${row + 1}`;
	const kept = rows.filter(row => pairs.some(pair => pair.at(row)));
	if (kept.length < 2) return undefined;
	const skipped = rows.filter(row => !kept.includes(row)).map(name);
	return {
		kind: "change",
		categories: kept.map(name),
		series: pairs.map(pair => ({
			name: pair.name,
			dim: "ratio",
			unit: "",
			points: kept.map(row => pair.at(row) ?? null),
			notes: kept.map(() => undefined),
		})),
		caption: skipped.length ? `Not plotted: ${skipped.join(" · ")}` : undefined,
		axis: label?.header ?? "",
		baseline: compared.length ? baseline.header : from,
	};
}

/** `to` as a factor of `from` (`59.4 s → 1.23 s` is 0.0207), when both are numbers of one dimension. */
function changePoint(from: Cell | undefined, to: Cell | undefined): ChartPoint | undefined {
	if (!isNumber(from) || !isNumber(to) || from.dim !== to.dim || from.value <= 0 || to.value < 0) return undefined;
	return {
		value: to.value / from.value,
		text: `${from.figure} → ${to.figure}`,
		emphasis: from.emphasis || to.emphasis,
	};
}

/** An `a → b` cell as the factor `b ÷ a`. */
function arrowChange(cell: Cell | undefined): ChartPoint | undefined {
	if (!isNumber(cell) || cell.to === undefined || cell.value <= 0 || cell.to < 0) return undefined;
	return { value: cell.to / cell.value, text: `${cell.figure} → ${cell.toFigure ?? ""}`, emphasis: cell.emphasis };
}

/** The from and to names in an `a → b` header (`out tokens r5 → r6`), else `before` and `after`. */
function arrowNames(header: string): [string, string] {
	const [from, to] = header.split(ARROW);
	return from && to ? [from, to] : ["before", "after"];
}

/** Same-unit aggregate columns (`Total`, `avg`) restate the series beside them. */
function dropAggregates(measures: readonly TableColumn[]): readonly TableColumn[] {
	return measures.filter(
		column =>
			!AGGREGATE.test(column.header) ||
			measures.filter(other => other !== column && other.dim === column.dim).length < 2,
	);
}

/** How the label column orders the rows: by time, by step, by a numeric size — or not at all. */
function axisOrder(
	table: TableAnalysis,
	label: TableColumn | undefined,
): "temporal" | "sequence" | "numeric" | undefined {
	if (!label) return undefined;
	if (label.role === "temporal") return "temporal";
	if (label.role === "sequence") return "sequence";
	const names = table.rows.map(row => label.cells[row]!.text);
	const mostly = (pattern: RegExp) => names.filter(name => pattern.test(name)).length >= names.length * 0.8;
	if (mostly(SEQUENCE_LABEL)) return "sequence";
	if (mostly(MONTH)) return "temporal";
	const values = columnValues(label, table.rows);
	if (values.length === names.length && values.length >= 3 && isMonotonic(values)) return "numeric";
	return undefined;
}

function columnValues(column: TableColumn, rows: readonly number[]): number[] {
	const values: number[] = [];
	for (const row of rows) {
		const cell = column.cells[row];
		if (isNumber(cell)) values.push(cell.value);
	}
	return values;
}

/** A column as a series: its cells of the column's dimension, other cells as gaps (status words kept as notes). */
function columnSeries(column: TableColumn, rows: readonly number[], name: string): ChartSeries {
	const points: (ChartPoint | null)[] = [];
	const notes: (string | undefined)[] = [];
	for (const row of rows) {
		const cell = column.cells[row]!;
		const fits = isNumber(cell) && cell.dim === column.dim;
		points.push(fits ? point(cell) : null);
		notes.push(!fits && cell.kind !== "missing" && !isNumber(cell) ? cell.text : undefined);
	}
	return { name, dim: column.dim ?? "count", unit: column.unit, points, notes };
}

/** One row of a metric-per-row table as a series over the plotted columns, in the row's dominant dimension. */
function rowSeries(name: string, columns: readonly TableColumn[], row: number): ChartSeries {
	const cells = columns.map(column => column.cells[row]);
	const tally = new Map<Dimension, number>();
	for (const cell of cells) if (isNumber(cell)) tally.set(cell.dim, (tally.get(cell.dim) ?? 0) + 1);
	let dim: Dimension = "count";
	for (const [key, count] of tally) if (count > (tally.get(dim) ?? 0)) dim = key;
	const unitCell = cells.find(cell => isNumber(cell) && cell.dim === dim);
	return {
		name,
		dim,
		unit: isNumber(unitCell) && (dim === "currency" || dim === "rate") ? unitCell.unit : "",
		points: cells.map(cell => (isNumber(cell) && cell.dim === dim ? point(cell) : null)),
		notes: cells.map(cell => (cell && !isNumber(cell) && cell.kind !== "missing" ? cell.text : undefined)),
	};
}

/** A numeric cell as a plotted point labelled with its written figure. */
function point(cell: NumberCell): ChartPoint {
	return { value: cell.value, text: cell.figure, emphasis: cell.emphasis, upper: cell.upper };
}

/** `Total: 2,964 · 2,310` for each summary row, over the plotted columns. */
function totalsCaption(
	table: TableAnalysis,
	label: TableColumn | undefined,
	columns: readonly TableColumn[],
	transpose: boolean,
): string | undefined {
	if (transpose || !label || table.totals.length === 0) return undefined;
	const lines = table.totals.slice(0, 2).flatMap(row => {
		const values = columns.map(column => column.cells[row]?.text ?? "").filter(Boolean);
		return values.length ? [`${label.cells[row]!.text}: ${values.join(" · ")}`] : [];
	});
	return lines.length ? lines.join("   ") : undefined;
}
