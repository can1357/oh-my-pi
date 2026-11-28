/**
 * Charts drawn under numeric tables in assistant answers (`tui.autoGraph`).
 * {@link splitTableCharts} cuts a Markdown block after each top-level table
 * that gets a chart; {@link lookupTableChart} plans, builds and draws that
 * chart — locally under `always`, through the host's model-backed
 * {@link TableChartPlanner} under `smart` for the tables {@link shouldJudge}
 * picks — and caches it per table source. {@link chartFence} hands Tern the
 * SVG as an ```svg fence, which it draws in the palette it shows, so a chart
 * follows theme switches like the prose around it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { lexMarkdown, linkDefinitions, type Token, type Tokens } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import { buildChart, type ChartPlan, planChart, shouldJudge, worthCharting } from "../../auto-graph/chart-plan";
import { renderChartSvg } from "../../auto-graph/chart-svg";
import { analyzeTable, type TableAnalysis } from "../../auto-graph/table-data";

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
 * Picks the chart for a table under `smart`: a plan, or `null` for no chart.
 * A rejection falls back to the local guess; `undefined` (no judge to ask
 * right now) keeps the guess at once, exactly as `always` would draw it.
 */
export type TableChartPlanner = (request: TableChartRequest) => Promise<ChartPlan | null> | undefined;

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
 * Once finished, every prose run carries the block's reference-link definitions,
 * so a reference on one side of a chart resolves against a definition on the other.
 */
export function splitTableCharts(markdown: string, streaming: boolean): ChartSegment[] {
	if (chartMode === "off") return [{ kind: "markdown", text: markdown }];
	if (!streaming) {
		const tokens = lexMarkdown(markdown);
		const whole = walk(tokens, false, [], "");
		const segments = whole.segments.slice();
		if (whole.prose.trim() || segments.length === 0) segments.push({ kind: "markdown", text: whole.prose });
		const definitions = segments.length > 1 ? linkDefinitions(tokens) : "";
		if (!definitions) return segments;
		return segments.map(segment =>
			segment.kind === "markdown" ? { kind: "markdown", text: `${definitions}\n\n${segment.text}` } : segment,
		);
	}
	// Token `raw`s hold the source as the lexer reads it (line ends unified, tabs expanded): compare in that form.
	const source = markdown.replace(/\r\n|\r/g, "\n").replaceAll("\t", "    ");
	const kept = settled && settled.mode === chartMode && source.startsWith(settled.source) ? settled : undefined;
	const tail = lexMarkdown(kept ? source.slice(kept.source.length) : source);
	// The last table followed by another block is final: everything up to it never changes again.
	let end = -1;
	let blockAfter = false;
	for (let i = tail.length - 1; i >= 0 && end < 0; i--) {
		const token = tail[i]!;
		if (isTable(token) && blockAfter) end = i;
		else if (token.type !== "space") blockAfter = true;
	}
	let head = kept ? { segments: kept.segments, prose: kept.prose } : { segments: [] as ChartSegment[], prose: "" };
	if (end >= 0) {
		const done = tail.slice(0, end + 1);
		head = walk(done, false, head.segments, head.prose);
		settled = {
			mode: chartMode,
			source: (kept?.source ?? "") + done.map(token => token.raw).join(""),
			segments: head.segments,
			prose: head.prose,
		};
	}
	const rest = end >= 0 ? tail.slice(end + 1) : tail;
	const open = walk(rest, true, head.segments, head.prose);
	const segments = open.segments.slice();
	if (open.prose.trim() || segments.length === 0) segments.push({ kind: "markdown", text: open.prose });
	return segments;
}

/** The finished part of the streaming reply split last: its source, whole segments, and the prose after the last of them. */
let settled:
	| {
			readonly mode: TableChartMode;
			readonly source: string;
			readonly segments: readonly ChartSegment[];
			readonly prose: string;
	  }
	| undefined;

/** `tokens` appended to `segments` and the pending `prose`; a table at the streaming tail stays prose. */
function walk(
	tokens: readonly Token[],
	streaming: boolean,
	segments: readonly ChartSegment[],
	prose: string,
): { segments: readonly ChartSegment[]; prose: string } {
	let out: ChartSegment[] | undefined;
	// Whether a block follows each token, found in one backward pass.
	let followed = false;
	const closedAt: boolean[] = new Array(tokens.length);
	for (let i = tokens.length - 1; i >= 0; i--) {
		closedAt[i] = followed;
		if (tokens[i]!.type !== "space") followed = true;
	}
	for (const [index, token] of tokens.entries()) {
		prose += token.raw;
		if (!isTable(token)) continue;
		const entry = !streaming || closedAt[index] ? chartEntry(token) : undefined;
		if (!entry?.guess || entry.chart === null) continue;
		(out ??= segments.slice()).push({ kind: "markdown", text: prose }, { kind: "chart", table: token });
		prose = "";
	}
	return { segments: out ?? segments, prose };
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
	const pick = chartPlanner!({ markdown: table.raw, table: analysis, guess: guess! });
	if (!pick) {
		entry.chart = drawChart(analysis, guess!, true);
		return entry.chart;
	}
	entry.pending = pick.then(
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
 * Chart `svg` as a Markdown ```svg fence, for Tern's `md` node. Its
 * figure tokens stay unresolved: the terminal draws the fence as a figure in
 * the palette it shows the prose in, so the chart cannot fall out of step with
 * the page when omp's own idea of the appearance does, and a theme switch
 * recolors it without a resend.
 */
export function chartFence(svg: string): string {
	return `\`\`\`svg\n${svg}\n\`\`\``;
}
