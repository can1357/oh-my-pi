/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A Markdown table's chart: the table's numbers planned into a chart (the
 * local planner's guess), drawn as SVG and rastered like any figure. Tables
 * without a chart draw nothing; neither does a chart without room for
 * {@link CHART_MIN_ROWS} rows.
 *
 * Terminal look: `src/ui/styles/figures/figure.ts` (`omp.figure.chart`).
 */
import { computed, effect, type JSXNode, type Reactive, read, untrack } from "@oh-my-pi/pi-tui";
import { lexMarkdown, type Tokens } from "@oh-my-pi/pi-tui/text/markdown/lexer";
import { buildChart, planChart } from "../../../auto-graph/chart-plan";
import { analyzeTable } from "../../../auto-graph/table-data";
import { renderChartSvg } from "../../../auto-graph/chart-svg";
import { type FigureOptions, RasterImage, SvgRaster } from "./svg-figure";

/** Fewest rows a chart is drawn in. */
export const CHART_MIN_ROWS = 3;

/** Terminal facts of a chart raster. */
export type ChartTerm = {
	/** Inside a reply's Markdown: no blank row of its own, and nothing where images cannot be drawn. */
	readonly inline: boolean;
};

/** The chart SVG of the first table in `markdown`, or undefined when it has none worth drawing. */
export function tableChartSvg(markdown: string): string | undefined {
	const table = lexMarkdown(markdown).find((token): token is Tokens.Table => token.type === "table");
	if (!table) return undefined;
	const analysis = analyzeTable(
		table.header.map(cell => cell.text),
		table.rows.map(row => row.map(cell => cell.text)),
	);
	const plan = planChart(analysis);
	const spec = plan ? buildChart(analysis, plan) : undefined;
	return spec ? renderChartSvg(spec) : undefined;
}

/** See the module docs. */
export function TableChart(
	props: { readonly markdown: Reactive<string>; readonly inline?: boolean } & FigureOptions,
): JSXNode {
	const raster = new SvgRaster(props);
	const svg = computed(() => tableChartSvg(read(props.markdown)));
	effect(() => {
		const source = svg();
		if (source !== undefined) untrack(() => raster.update(source, true));
	});
	const term: ChartTerm = { inline: props.inline === true };
	return () => {
		const rows = read(props.maxRows);
		if (svg() === undefined || (rows !== undefined && rows < CHART_MIN_ROWS)) return undefined;
		const state = raster.state();
		if (state.status !== "ready") return undefined;
		return untrack(() => <RasterImage raster={state.raster} role="omp.figure.chart" term={term} />);
	};
}
