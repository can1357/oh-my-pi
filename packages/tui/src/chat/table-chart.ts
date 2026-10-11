/**
 * Charts drawn under numeric tables in assistant answers (the host's
 * `tui.autoGraph`). {@link splitTableCharts} cuts a Markdown block after each
 * top-level table that gets a chart; {@link lookupTableChart} plans, builds
 * and draws that chart — locally under `always`, through the host's
 * model-backed {@link TableChartPlanner} for multi-series tables under
 * `smart` — and caches it per table source. {@link TableChartFigure} shows it
 * as a rasterized terminal image; {@link describeTableChart} hands a TSP
 * terminal the SVG itself. Both resolve the figure tokens against the live
 * theme, so a chart follows theme switches like the prose around it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Token, Tokens } from "@oh-my-pi/pi-utils/marked";
import { type ChartPlan, buildChart, planChart, worthCharting } from "../charts/chart-plan";
import { chartAlt, renderChartSvg } from "../charts/chart-svg";
import { analyzeTable, type TableAnalysis } from "../charts/table-data";
import type { ImageBudget } from "../components/image";
import { lexDocument } from "../components/markdown";
import { keyed } from "../native/describe";
import { nativeImageNode } from "../native/blobs";
import type { NativeNode } from "../native/node";
import { getThemeEpoch } from "../theme";
import type { Component } from "../tui";
import { SvgFigure, svgFigurePalette } from "./svg-figure";
import { prepareSvg } from "./svg-source";

/**
 * `smart`: a model picks the kind and columns of multi-series tables;
 * `always`: the local best guess charts every table it reads as numeric;
 * `off`: tables stay tables.
 */
export type TableChartMode = "smart" | "always" | "off";

/** A multi-series table the host's planner picks a chart for. */
export interface TableChartRequest {
	/** The table's Markdown source. */
	readonly markdown: string;
	readonly table: TableAnalysis;
	/** The local best guess; the planner may keep it. */
	readonly guess: ChartPlan;
}

/**
 * Picks the chart for a multi-series table under `smart`: a plan, or `null`
 * for no chart. A rejection falls back to the local guess.
 */
export type TableChartPlanner = (request: TableChartRequest) => Promise<ChartPlan | null>;

/** A drawn chart, ready to resolve against the theme. */
export interface TableChart {
	/** SVG colored with figure tokens (`var(--accent)`, …). */
	readonly svg: string;
	readonly alt: string;
	/** Size in SVG user units. */
	readonly width: number;
	readonly height: number;
}

/** The chart under a table: drawn, none, or a smart pick on its way (the promise settles once the cache holds it). */
export type ChartLookup = TableChart | null | Promise<void>;

/** One run of a Markdown block: prose (ending at a charted table), or the chart drawn after that table. */
export type ChartSegment =
	| { readonly kind: "markdown"; readonly text: string }
	| { readonly kind: "chart"; readonly table: Tokens.Table };

/** Tables cached per source; a long session keeps its recent charts without growing without bound. */
const CACHE_LIMIT = 256;
/** SVG user units per terminal column (16 per row on 1:2 cells), sizing native images. */
const UNITS_PER_COLUMN = 8;
/** A GFM delimiter row (`|---|:--:|`), the cheap test before lexing a block. */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*\|/m;

/** A table read once per source: its local guess and, once known, its chart. */
interface ChartEntry {
	readonly analysis: TableAnalysis;
	readonly guess: ChartPlan | undefined;
	/** The host's planner picks this table's chart. */
	readonly smart: boolean;
	/** `undefined` until drawn (or judged chartless). */
	chart?: TableChart | null;
	pending?: Promise<void>;
}

let chartMode: TableChartMode = "off";
let chartPlanner: TableChartPlanner | undefined;
const charts = new Map<string, ChartEntry>();
/** The theme-resolved image node owning a chart's native bytes. */
const kNativeImage = Symbol("tableChart.nativeImage");

interface NativeTagged extends TableChart {
	[kNativeImage]?: { epoch: number; image: NativeNode };
}

/** Set how tables become charts (the host's `tui.autoGraph`) and its `smart` planner; the host rebuilds the transcript after. */
export function setTableCharts(mode: TableChartMode, planner?: TableChartPlanner): void {
	chartMode = mode;
	chartPlanner = planner;
	charts.clear();
}

/** Whether `markdown` may hold a table {@link splitTableCharts} would chart. */
export function hasChartTable(markdown: string): boolean {
	return chartMode !== "off" && markdown.includes("|") && DELIMITER_ROW.test(markdown);
}

/**
 * Split `markdown` after each top-level table that has (or may get) a chart.
 * A table still streaming at the block's tail is left whole: rows may follow.
 */
export function splitTableCharts(markdown: string, streaming: boolean): ChartSegment[] {
	if (chartMode === "off") return [{ kind: "markdown", text: markdown }];
	const tokens = lexDocument(markdown);
	const segments: ChartSegment[] = [];
	let prose = "";
	tokens.forEach((token, index) => {
		prose += token.raw;
		if (!isTable(token)) return;
		// A later non-space token means the table has closed; rows may still stream otherwise.
		let closed = !streaming;
		for (let j = index + 1; !closed && j < tokens.length; j++) {
			closed = tokens[j]!.type !== "space";
		}
		const entry = closed ? chartEntry(token) : undefined;
		if (!entry?.guess || entry.chart === null) return;
		segments.push({ kind: "markdown", text: prose }, { kind: "chart", table: token });
		prose = "";
	});
	if (prose.trim() || segments.length === 0) segments.push({ kind: "markdown", text: prose });
	return segments;
}

function isTable(token: Token): token is Tokens.Table {
	return token.type === "table";
}

/**
 * The chart for `table` under the current mode, read once per table source.
 * Under `smart` the first lookup of a multi-series table asks the planner.
 */
export function lookupTableChart(table: Tokens.Table): ChartLookup {
	if (chartMode === "off") return null;
	const entry = chartEntry(table);
	if (entry.chart !== undefined) return entry.chart;
	if (entry.pending) return entry.pending;
	const { analysis, guess } = entry;
	entry.pending = chartPlanner!({ markdown: table.raw, table: analysis, guess: guess! }).then(
		plan => {
			entry.chart = plan ? drawChart(analysis, plan) : null;
		},
		(error: unknown) => {
			logger.debug("Smart table chart failed; drawing the local guess", { error: String(error) });
			entry.chart = drawChart(analysis, guess!, true);
		},
	);
	return entry.pending;
}

/**
 * `table` read under the current mode, cached per source. A table the local
 * guess decides is drawn at once; a smart pick waits for its first lookup.
 */
function chartEntry(table: Tokens.Table): ChartEntry {
	const key = table.raw;
	const cached = charts.get(key);
	if (cached) {
		// Re-insert so eviction drops the least recently read table.
		charts.delete(key);
		charts.set(key, cached);
		return cached;
	}
	if (charts.size >= CACHE_LIMIT) charts.delete(charts.keys().next().value!);
	const analysis = analyzeTable(
		table.header.map(cell => cell.text),
		table.rows.map(row => row.map(cell => cell.text)),
	);
	const guess = planChart(analysis);
	const smart =
		guess !== undefined &&
		chartMode === "smart" &&
		chartPlanner !== undefined &&
		analysis.measures.length >= 2 &&
		analysis.rows.length >= 3;
	const entry: ChartEntry = { analysis, guess, smart };
	if (!smart) entry.chart = guess ? drawChart(analysis, guess, true) : null;
	charts.set(key, entry);
	return entry;
}

/**
 * Draw `plan`. A guess must also pass {@link worthCharting}; a model's pick
 * already judged the chart worth drawing.
 */
function drawChart(analysis: TableAnalysis, plan: ChartPlan, guessed = false): TableChart | null {
	const spec = buildChart(analysis, plan);
	if (!spec || (guessed && !worthCharting(spec))) return null;
	return { ...renderChartSvg(spec), alt: chartAlt(spec) };
}

/**
 * A native `image` node drawing `chart` from its SVG — no raster — resolved
 * against the active theme; rebuilt when the theme changes.
 */
export function describeTableChart(chart: TableChart, key: string): NativeNode {
	const epoch = getThemeEpoch();
	const tagged: NativeTagged = chart;
	let entry = tagged[kNativeImage];
	if (entry?.epoch !== epoch) {
		const svg = prepareSvg(chart.svg, svgFigurePalette());
		entry = {
			epoch,
			image: nativeImageNode(new TextEncoder().encode(svg), "image/svg+xml", {
				alt: chart.alt,
				w: chart.width,
				h: chart.height,
				max: { w: `${Math.round(chart.width / UNITS_PER_COLUMN)}ch` },
			}),
		};
		tagged[kNativeImage] = entry;
	}
	return keyed(entry.image, key);
}

export interface TableChartFigureOptions {
	/** Shared inline-image budget. */
	budget?: ImageBudget;
	/** The chart's rows changed outside a text update: its pick or raster landed. */
	onChange: () => void;
}

/**
 * The chart under one table, as a terminal image a blank row below it. Looks
 * the chart up on first render — a block rebuilt mid-stream never asks for a
 * pick it drops — and renders nothing until it is drawn, or when the table
 * gets no chart.
 */
export class TableChartFigure implements Component {
	readonly #options: TableChartFigureOptions;
	readonly #figure: SvgFigure;
	#table: Tokens.Table | undefined;
	/** `undefined` while not looked up or waiting for a pick. */
	#chart: TableChart | null | undefined;
	#waiting = false;
	#disposed = false;

	constructor(options: TableChartFigureOptions) {
		this.#options = options;
		this.#figure = new SvgFigure({ budget: options.budget, onChange: options.onChange });
	}

	/** Point the figure at `table`. */
	update(table: Tokens.Table): void {
		if (table.raw === this.#table?.raw) return;
		this.#table = table;
		this.#chart = undefined;
		this.#waiting = false;
	}

	/** Whether the chart is still being looked up, picked or drawn. */
	get pending(): boolean {
		return this.#table !== undefined && (this.#chart === undefined || (this.#chart !== null && this.#figure.pending));
	}

	render(width: number): readonly string[] {
		if (this.#chart === undefined && !this.#waiting) this.#resolve();
		if (!this.#chart) return [];
		const rows = this.#figure.render(width);
		return rows.length ? ["", ...rows] : rows;
	}

	invalidate(): void {
		this.#figure.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#figure.dispose();
	}

	#resolve(): void {
		const table = this.#table;
		if (!table) return;
		const found = lookupTableChart(table);
		if (found instanceof Promise) {
			this.#waiting = true;
			void found.then(() => {
				if (this.#disposed || this.#table !== table) return;
				this.#waiting = false;
				this.#resolve();
				this.#options.onChange();
			});
			return;
		}
		this.#chart = found;
		if (found) this.#figure.update(found.svg, true);
	}
}
