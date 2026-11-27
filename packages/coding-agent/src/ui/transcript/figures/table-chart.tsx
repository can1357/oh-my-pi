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
import { holdSettle } from "../../shell/transcript";
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
	const source = computed(() => tableChartSvg(read(props.markdown)));
	return (
		<ChartFigure
			source={source}
			inline={props.inline}
			cell={props.cell}
			maxRows={props.maxRows}
			theme={props.theme}
		/>
	);
}

/** Rasterize a planned chart; an inline chart keeps later prose live until it can draw. */
export function ChartFigure(
	props: {
		readonly source: Reactive<string | Promise<void> | undefined>;
		readonly inline?: boolean;
		readonly nodeKey?: string;
	} & FigureOptions,
): JSXNode {
	const raster = new SvgRaster(props);
	const source = computed(() => {
		const rows = read(props.maxRows);
		return rows === undefined || rows >= CHART_MIN_ROWS ? read(props.source) : undefined;
	});
	const pending = computed(() => {
		const svg = source();
		return svg instanceof Promise || (svg !== undefined && raster.state().status === "pending");
	});
	holdSettle(pending);
	effect(() => {
		const svg = source();
		if (typeof svg === "string") untrack(() => raster.update(svg, true));
	});
	const term: ChartTerm = { inline: props.inline === true };
	return () => {
		const svg = source();
		if (svg === undefined) return undefined;
		if (pending()) return props.inline ? <text key={props.nodeKey} role="omp.figure.chart.pending" /> : undefined;
		const state = raster.state();
		if (typeof svg !== "string" || state.status !== "ready") return undefined;
		return untrack(() => (
			<RasterImage raster={state.raster} role="omp.figure.chart" nodeKey={props.nodeKey} term={term} />
		));
	};
}
