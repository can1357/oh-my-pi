/**
 * Charts drawn under numeric tables in assistant answers (the host's
 * `tui.autoGraph`). {@link splitTableCharts} cuts a Markdown block after each
 * top-level table that gets a chart; {@link lookupTableChart} plans, builds
 * and draws that chart — locally under `always`, through the host's
 * model-backed {@link TableChartPlanner} under `smart` for the tables
 * {@link shouldJudge} picks — and caches it per table source. {@link TableChartFigure} shows it
 * as a terminal image rasterized in omp's theme; {@link chartFence} hands a
 * TSP terminal the SVG as an ```svg fence, which it draws in the palette it
 * shows. Either way a chart follows theme switches like the prose around it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Token, Tokens } from "@oh-my-pi/pi-utils/marked";
import { type ChartPlan, buildChart, planChart, shouldJudge, worthCharting } from "../charts/chart-plan";
import { renderChartSvg } from "../charts/chart-svg";
import { analyzeTable, type TableAnalysis } from "../charts/table-data";
import type { ImageBudget } from "../components/image";
import { lexDocument } from "../components/markdown";
import type { Component } from "../tui";
import { SvgFigure } from "./svg-figure";

/**
 * `smart`: a model refines the local guess where meaning decides (kind,
 * columns, row names, ordering, polarity, focus, title; see {@link shouldJudge});
 * `always`: the local best guess charts every table it reads as numeric;
 * `off`: tables stay tables.
 */
export type TableChartMode = "smart" | "always" | "off";

/** A table the host's planner picks a chart for ({@link shouldJudge}). */
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

/**
 * The chart under a table: its SVG, colored with figure tokens (`var(--accent)`, …)
 * still to resolve; none; or a smart pick on its way (the promise settles once the cache holds it).
 */
export type ChartLookup = string | null | Promise<void>;

/** One run of a Markdown block: prose (ending at a charted table), or the chart drawn after that table. */
export type ChartSegment =
	| { readonly kind: "markdown"; readonly text: string }
	| { readonly kind: "chart"; readonly table: Tokens.Table };

/** Tables cached per source; a long session keeps its recent charts without growing without bound. */
const CACHE_LIMIT = 256;
/** A GFM delimiter row (`|---|:--:|`), the cheap test before lexing a block. */
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*\|/m;

/** A table read once per source: its local guess and, once known, its chart. */
interface ChartEntry {
	readonly analysis: TableAnalysis;
	readonly guess: ChartPlan | undefined;
	/** The host's planner picks this table's chart. */
	readonly smart: boolean;
	/** The chart's SVG; `undefined` until drawn (or judged chartless). */
	chart?: string | null;
	pending?: Promise<void>;
}

let chartMode: TableChartMode = "off";
let chartPlanner: TableChartPlanner | undefined;
const charts = new Map<string, ChartEntry>();

/** Set how tables become charts (the host's `tui.autoGraph`) and its `smart` planner; the host rebuilds the transcript after. */
export function setTableCharts(mode: TableChartMode, planner?: TableChartPlanner): void {
	chartMode = mode;
	chartPlanner = planner;
	charts.clear();
}

/** How assistant tables currently become charts. */
export function tableChartMode(): TableChartMode {
	return chartMode;
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
		const closed = !streaming || tokens.slice(index + 1).some(next => next.type !== "space");
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
	const smart = chartMode === "smart" && chartPlanner !== undefined && shouldJudge(analysis, guess);
	const entry: ChartEntry = { analysis, guess, smart };
	if (!smart) entry.chart = guess ? drawChart(analysis, guess, true) : null;
	charts.set(key, entry);
	return entry;
}

/**
 * Draw `plan`. A guess must also pass {@link worthCharting}; a model's pick
 * already judged the chart worth drawing.
 */
function drawChart(analysis: TableAnalysis, plan: ChartPlan, guessed = false): string | null {
	const spec = buildChart(analysis, plan);
	if (!spec || (guessed && !worthCharting(spec))) return null;
	return renderChartSvg(spec);
}

/**
 * Chart `svg` as a Markdown ```svg fence, for a TSP terminal's `md` node. Its
 * figure tokens stay unresolved: the terminal draws the fence as a figure in
 * the palette it shows the prose in, so the chart cannot fall out of step with
 * the page when omp's own idea of the appearance does, and a theme switch
 * recolors it without a resend.
 */
export function chartFence(svg: string): string {
	return `\`\`\`svg\n${svg}\n\`\`\``;
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
	/** The chart's SVG; `undefined` while not looked up or waiting for a pick. */
	#chart: string | null | undefined;
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
		if (found) this.#figure.update(found, true);
	}
}
