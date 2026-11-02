import { formatCompact, formatCost } from "../../data/formatters";
import { Chart } from "../../charts";
import type { ChartSeries } from "../../charts/types";
import type { ContextOverview } from "../../types";
import type { ContextActivityCell } from "./view-models";
import { chartCells, formatContextCost } from "./view-models";

function shortLabel(cell: ContextActivityCell, range: ContextOverview["range"]): string {
	const date = new Date(cell.start);
	if (range === "1h") return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (range === "24h") return date.toLocaleTimeString(undefined, { hour: "numeric" });
	if (range === "7d") return date.toLocaleDateString(undefined, { weekday: "short" });
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ContextUsageChart({
	overview,
	cells,
	onSelect,
}: {
	overview: ContextOverview;
	cells: readonly ContextActivityCell[];
	onSelect: (cell: ContextActivityCell) => void;
}) {
	const points = chartCells(cells, overview.range);
	const series: ChartSeries[] = [
		{
			key: "promptTokens",
			label: "Prompt",
			color: "var(--ctx-system-prompt)",
			values: points.map(point => point.promptTokens),
		},
		{
			key: "outputTokens",
			label: "Output",
			color: "var(--ctx-token-output)",
			values: points.map(point => point.outputTokens),
		},
		{
			key: "costTotal",
			label: "Cost",
			color: "var(--ctx-cost)",
			kind: "line",
			axis: "right",
			values: points.map(point => (point.costTotal === 0 && point.unpricedRequests > 0 ? null : point.costTotal)),
			tooltip: false,
		},
	];
	const totalCost = points.reduce((sum, point) => sum + point.costTotal, 0);
	const unpriced = points.reduce((sum, point) => sum + point.unpricedRequests, 0);
	return (
		<figure className="context-usage-chart" aria-label="Prompt, output and cost usage by bucket">
			<Chart
				slots={points.length}
				tickLabel={index => shortLabel(points[index]!, overview.range)}
				series={series}
				height={220}
				format={formatCompact}
				formatRight={formatCost}
				onSelect={index => onSelect(points[index]!)}
				tooltipExtra={index => {
					const point = points[index]!;
					return (
						<span>
							{point.label}
							{point.unpricedRequests > 0
								? ` · ${point.costTotal > 0 ? "~" : ""}${point.costTotal > 0 ? formatCost(point.costTotal) : "unpriced"}`
								: ""}
						</span>
					);
				}}
				emptyLabel="No usage in this range"
			/>
			<p className="context-chart-foot">
				<span>Prompt + output tokens</span>
				<span>{formatContextCost(totalCost, unpriced)}</span>
			</p>
			<details className="context-data-table">
				<summary>Data table</summary>
				<table>
					<thead>
						<tr>
							<th>Bucket</th>
							<th>Requests</th>
							<th>Prompt</th>
							<th>Output</th>
							<th>Total</th>
							<th>Cost</th>
						</tr>
					</thead>
					<tbody>
						{points.map(point => (
							<tr key={point.key}>
								<td>
									<button type="button" className="context-link-button" onClick={() => onSelect(point)}>
										{point.label}
									</button>
								</td>
								<td>{formatCompact(point.requests)}</td>
								<td>{formatCompact(point.promptTokens)}</td>
								<td>{formatCompact(point.outputTokens)}</td>
								<td>{formatCompact(point.totalTokens)}</td>
								<td>
									{point.costTotal === 0 && point.unpricedRequests > 0
										? "N/A"
										: `${point.unpricedRequests > 0 ? "~" : ""}${formatCost(point.costTotal)}`}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</figure>
	);
}
