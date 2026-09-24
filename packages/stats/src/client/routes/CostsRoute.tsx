import type { Plugin } from "chart.js";
import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import { getCostDashboardStats } from "../api";
import {
	barDatasetStyle,
	buildAggregateTimeSeries,
	buildSharedPlugins,
	buildSharedScales,
	buildTopNByModelSeries,
	CHART_THEMES,
	lineDatasetStyle,
	MODEL_COLORS,
	styleDatasets,
} from "../components/chart-shared";
import { formatCost, formatEstimatedCost } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import { buildCostSummary } from "../data/view-models";
import type { CostTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary, Panel, SegmentedControl } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface CostsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function CostsRoute({ active, range, refreshTrigger }: CostsRouteProps) {
	const {
		data: costStats,
		error,
		loading,
	} = useResource(["costs", range, refreshTrigger], signal => getCostDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={costStats}>
				{costStats && (
					<>
						<CostOverviewPanel costSeries={costStats.costSeries} />
						<CostTrendPanel costSeries={costStats.costSeries} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

function CostOverviewPanel({ costSeries }: { costSeries: CostTimeSeriesPoint[] }) {
	const { i18n } = useStatsI18n();
	const summary = useMemo(() => buildCostSummary(costSeries), [costSeries]);

	const cards = [
		{
			label: i18n.t("stats.metrics.apiEstimate"),
			value: formatEstimatedCost(summary.totalCost, summary.unpricedRequests),
			sub:
				summary.unpricedRequests > 0
					? i18n.t("stats.costs.excludesUnpriced", { count: summary.unpricedRequests })
					: undefined,
		},
		{
			label: i18n.t("stats.costs.averageEstimateDay"),
			value: formatEstimatedCost(summary.avgDailyCost, summary.unpricedRequests),
		},
		{
			label: i18n.t("stats.drawer.model"),
			value: summary.topModelName || "—",
			sub: summary.topModelName
				? `${i18n.t("stats.metrics.apiEstimate")}: ${formatCost(summary.topModelCost)}`
				: undefined,
		},
	];

	return (
		<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
			{cards.map(card => (
				<Panel key={card.label} className="stats-cost-overview-card py-4 px-5">
					<p className="text-xs stats-text-muted mb-1 font-medium uppercase tracking-wider">{card.label}</p>
					<p className="text-2xl font-bold stats-text-primary truncate" title={card.value}>
						{card.value}
					</p>
					{card.sub && <p className="text-xs stats-text-muted mt-1 font-medium">{card.sub}</p>}
				</Panel>
			))}
		</div>
	);
}

const BAR_LABEL_COLORS = {
	dark: "rgba(248, 250, 252, 0.7)",
	light: "rgba(15, 23, 42, 0.6)",
} as const;

// Inline Chart.js plugin to draw cost value above bars
function makeBarLabelPlugin(color: string): Plugin<"bar"> {
	return {
		id: "costBarLabels",
		afterDatasetsDraw(chart) {
			const { ctx } = chart;
			const dataset = chart.data.datasets[0];
			if (!dataset) return;
			const meta = chart.getDatasetMeta(0);
			ctx.save();
			ctx.font = "11px system-ui, sans-serif";
			ctx.fillStyle = color;
			ctx.textAlign = "center";
			ctx.textBaseline = "bottom";
			for (const bar of meta.data) {
				// Accessing Chart.js internal parsed coordinates via unknown cast
				const value = (bar as unknown as { $context: { parsed: { y: number } } }).$context.parsed.y;
				if (!value) continue;
				const label = `$${Math.round(value)}`;
				// Accessing internal getProps for positioning via unknown cast
				const { x, y } = bar.getProps(["x", "y"], true) as {
					x: number;
					y: number;
				};
				ctx.fillText(label, x, y - 3);
			}
			ctx.restore();
		},
	};
}

function CostTrendPanel({ costSeries }: { costSeries: CostTimeSeriesPoint[] }) {
	const { i18n } = useStatsI18n();
	const [byModel, setByModel] = useState(false);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const unpricedRequests = useMemo(
		() => costSeries.reduce((sum, point) => sum + point.unpricedRequests, 0),
		[costSeries],
	);

	const chartData = useMemo(() => {
		if (byModel) {
			return buildTopNByModelSeries<CostTimeSeriesPoint, { total: number }>(costSeries, {
				rankWeight: point => point.cost,
				initBucket: () => ({ total: 0 }),
				accumulate: (bucket, point) => {
					bucket.total += point.cost;
				},
				bucketToValue: bucket => bucket.total,
			});
		}
		return buildAggregateTimeSeries<CostTimeSeriesPoint, { total: number }>(
			costSeries,
			i18n.t("stats.metrics.apiEstimate"),
			{
				initBucket: () => ({ total: 0 }),
				accumulate: (bucket, point) => {
					bucket.total += point.cost;
				},
				bucketToValue: bucket => bucket.total,
			},
		);
	}, [costSeries, byModel, i18n]);

	const sharedPlugins = useMemo(() => {
		return buildSharedPlugins({
			chartTheme,
			showLegend: byModel,
			defaultLabel: i18n.t("stats.metrics.apiEstimate"),
			formatValue: v => `$${v.toFixed(2)}`,
			footer: items => {
				if (!byModel || items.length < 2) return undefined;
				const total = items.reduce((sum, item) => sum + (item.parsed.y ?? 0), 0);
				return i18n.t("stats.costs.total", { value: `$${total.toFixed(2)}` });
			},
		});
	}, [chartTheme, byModel, i18n]);

	const { sharedScaleBase, yScale } = useMemo(() => {
		return buildSharedScales({
			chartTheme,
			formatY: v => `$${Math.round(v)}`,
		});
	}, [chartTheme]);

	const barLabelPlugin = useMemo(() => {
		return makeBarLabelPlugin(BAR_LABEL_COLORS[theme]);
	}, [theme]);

	const lineData = useMemo(() => {
		if (!byModel) return null;
		return {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => lineDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};
	}, [chartData, byModel]);

	const lineOptions = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: sharedPlugins,
			scales: { x: sharedScaleBase, y: yScale },
		};
	}, [sharedPlugins, sharedScaleBase, yScale]);

	const barData = useMemo(() => {
		if (byModel) return null;
		return {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => barDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};
	}, [chartData, byModel]);

	const barOptions = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: {
				...sharedPlugins,
				costBarLabels: {},
			},
			scales: {
				x: { ...sharedScaleBase, stacked: true },
				y: { ...yScale, stacked: true },
			},
			layout: { padding: { top: 24 } },
		};
	}, [sharedPlugins, sharedScaleBase, yScale]);

	const toggleOptions = [
		{ value: false, label: i18n.t("stats.costs.allModels") },
		{ value: true, label: i18n.t("stats.costs.byModel") },
	];

	return (
		<Panel
			title={i18n.t("stats.costs.dailyEstimate")}
			subtitle={
				unpricedRequests > 0
					? i18n.t("stats.costs.publicRateCardExcludes", { count: unpricedRequests })
					: i18n.t("stats.costs.publicRateCard")
			}
			actions={<SegmentedControl options={toggleOptions} value={byModel} onChange={setByModel} />}
		>
			<div className="h-[300px]">
				{chartData.labels.length === 0 ? (
					<div className="h-full flex items-center justify-center text-stats-muted text-sm">
						{i18n.t("stats.costs.noData")}
					</div>
				) : byModel && lineData ? (
					<Line data={lineData} options={lineOptions} />
				) : barData ? (
					<Bar data={barData} options={barOptions} plugins={[barLabelPlugin]} />
				) : null}
			</div>
		</Panel>
	);
}
