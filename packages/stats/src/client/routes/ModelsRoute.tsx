import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getModelDashboardStats } from "../api";
import { buildModelColorLookup, CHART_THEMES, MODEL_COLORS } from "../components/chart-shared";
import {
	DetailChartEmpty,
	detailChartPlugins,
	detailChartScalesDualAxis,
	ExpandableModelRow,
	lineSeriesStyle,
	MiniSparkline,
	ModelNameCell,
	ModelTableBody,
	ModelTableHeader,
	ModelTableShell,
	TABLE_CHART_THEMES,
	type TableChartTheme,
	TrendEmpty,
} from "../components/models-table-shared";
import { formatRangeTick, rangeMeta } from "../components/range-meta";
import { formatEstimatedCost } from "../data/formatters";
import { useResource } from "../data/useResource";
import { buildModelPerformanceLookup } from "../data/view-models";
import type { ModelPerformancePoint, ModelStats, ModelTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary, Panel } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface ModelsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function ModelsRoute({ active, range, refreshTrigger }: ModelsRouteProps) {
	const {
		data: modelStats,
		error,
		loading,
	} = useResource(["models", range, refreshTrigger], signal => getModelDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});
	const modelColorLookup = useMemo(() => buildModelColorLookup(modelStats?.byModel ?? []), [modelStats?.byModel]);

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={modelStats}>
				{modelStats && (
					<>
						<ModelShareChart
							modelSeries={modelStats.modelSeries}
							timeRange={range}
							colorLookup={modelColorLookup}
						/>
						<ModelsTable
							models={modelStats.byModel}
							performanceSeries={modelStats.modelPerformanceSeries}
							timeRange={range}
							colorLookup={modelColorLookup}
						/>
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

function ModelShareChart({
	modelSeries,
	timeRange,
	colorLookup,
}: {
	modelSeries: ModelTimeSeriesPoint[];
	timeRange: TimeRange;
	colorLookup: ReadonlyMap<string, string>;
}) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const meta = rangeMeta(timeRange);

	const chartData = useMemo(() => buildModelPreferenceSeries(modelSeries), [modelSeries]);

	const data = useMemo(() => {
		return {
			labels: chartData.data.map(d => formatRangeTick(d.timestamp, timeRange)),
			datasets: chartData.series.map((series, index) => {
				const fallbackColor = MODEL_COLORS[index % MODEL_COLORS.length];
				const color = series.key ? (colorLookup.get(series.key) ?? fallbackColor) : fallbackColor;
				const dataKey = series.key ?? series.label;

				return {
					label: series.label,
					data: chartData.data.map(d => d[dataKey] ?? 0),
					borderColor: color,
					backgroundColor: `${color}20`,
					fill: true,
					tension: 0.4,
					pointRadius: 0,
					pointHoverRadius: 4,
					borderWidth: 2,
				};
			}),
		};
	}, [chartData, colorLookup, timeRange]);

	const options = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: {
				mode: "index" as const,
				intersect: false,
			},
			plugins: {
				legend: {
					position: "top" as const,
					align: "start" as const,
					labels: {
						color: chartTheme.legendLabel,
						usePointStyle: true,
						padding: 16,
						font: { size: 12 },
						boxWidth: 8,
					},
				},
				tooltip: {
					backgroundColor: chartTheme.tooltipBackground,
					titleColor: chartTheme.tooltipTitle,
					bodyColor: chartTheme.tooltipBody,
					borderColor: chartTheme.tooltipBorder,
					borderWidth: 1,
					padding: 12,
					cornerRadius: 8,
					callbacks: {
						label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => {
							const label = context.dataset.label ?? "";
							const value = context.parsed.y;
							return `${label}: ${(value ?? 0).toFixed(1)}%`;
						},
					},
				},
			},
			scales: {
				x: {
					grid: {
						color: chartTheme.grid,
						drawBorder: false,
					},
					ticks: {
						color: chartTheme.tick,
						font: { size: 11 },
					},
				},
				y: {
					grid: {
						color: chartTheme.grid,
						drawBorder: false,
					},
					ticks: {
						color: chartTheme.tick,
						font: { size: 11 },
						callback: (value: number | string) => `${value}%`,
					},
					min: 0,
					max: 100,
				},
			},
		};
	}, [chartTheme]);

	return (
		<Panel title="Model Preference" subtitle={`Share of requests over ${meta.windowLabel}`}>
			<div className="h-[280px]">
				{chartData.data.length === 0 ? (
					<div className="h-full flex items-center justify-center text-stats-muted text-sm">No data available</div>
				) : (
					<Line data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}

function buildModelPreferenceSeries(
	points: ModelTimeSeriesPoint[],
	topN = 5,
): {
	data: Array<Record<string, number>>;
	series: Array<{ key?: string; label: string }>;
} {
	if (points.length === 0) return { data: [], series: [] };

	const totals = new Map<string, { model: string; provider: string; total: number }>();
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		if (existing) {
			existing.total += point.requests;
		} else {
			totals.set(key, {
				model: point.model,
				provider: point.provider,
				total: point.requests,
			});
		}
	}

	const sorted = [...totals.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.total - a.total);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(entry => entry.key));

	const topModelCounts = new Map<string, number>();
	for (const entry of topEntries) {
		topModelCounts.set(entry.model, (topModelCounts.get(entry.model) ?? 0) + 1);
	}

	const labelByKey = new Map<string, string>();
	for (const entry of topEntries) {
		const showProvider = (topModelCounts.get(entry.model) ?? 0) > 1;
		labelByKey.set(entry.key, showProvider ? `${entry.model} (${entry.provider})` : entry.model);
	}

	const dataMap = new Map<number, Record<string, number>>();

	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const bucket = dataMap.get(point.timestamp) ?? {
			timestamp: point.timestamp,
			total: 0,
		};
		bucket.total += point.requests;
		const seriesKey = topKeys.has(key) ? key : "Other";
		bucket[seriesKey] = (bucket[seriesKey] ?? 0) + point.requests;
		dataMap.set(point.timestamp, bucket);
	}

	const series: Array<{ key?: string; label: string }> = topEntries.map(entry => ({
		key: entry.key,
		label: labelByKey.get(entry.key) ?? entry.model,
	}));
	if ([...dataMap.values()].some(row => (row.Other ?? 0) > 0)) {
		series.push({ label: "Other" });
	}

	const data = [...dataMap.values()]
		.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
		.map(row => {
			const total = row.total ?? 0;
			for (const seriesItem of series) {
				const seriesKey = seriesItem.key ?? seriesItem.label;
				row[seriesKey] = total > 0 ? ((row[seriesKey] ?? 0) / total) * 100 : 0;
			}
			return row;
		});

	return { data, series };
}

const GRID_TEMPLATE = "2fr 0.9fr 0.9fr 1fr 0.8fr 0.8fr 140px 40px";

function ModelsTable({
	models,
	performanceSeries,
	timeRange,
	colorLookup,
}: {
	models: ModelStats[];
	performanceSeries: ModelPerformancePoint[];
	timeRange: TimeRange;
	colorLookup: ReadonlyMap<string, string>;
}) {
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const meta = rangeMeta(timeRange);

	const performanceSeriesByKey = useMemo(
		() => buildModelPerformanceLookup(performanceSeries, timeRange),
		[performanceSeries, timeRange],
	);

	const theme = useSystemTheme();
	const chartTheme = TABLE_CHART_THEMES[theme];

	const sortedModels = useMemo(() => {
		return [...models].sort(
			(a, b) => b.totalInputTokens + b.totalOutputTokens - (a.totalInputTokens + a.totalOutputTokens),
		);
	}, [models]);

	return (
		<ModelTableShell title="Model Statistics">
			<ModelTableHeader
				gridTemplate={GRID_TEMPLATE}
				columns={[
					{ label: "Model" },
					{ label: "Requests", align: "right" },
					{ label: "API-equivalent estimate", align: "right" },
					{ label: "Tokens", align: "right" },
					{ label: "Tokens/s", align: "right" },
					{ label: "TTFT", align: "right" },
					{ label: meta.trendLabel, align: "center" },
				]}
			/>

			<ModelTableBody>
				{sortedModels.map((model, index) => {
					const key = `${model.model}::${model.provider}`;
					const performance = performanceSeriesByKey.get(key);
					const trendData = performance?.data ?? [];
					const trendColor = colorLookup.get(key) ?? MODEL_COLORS[index % MODEL_COLORS.length];
					const isExpanded = expandedKey === key;
					const errorRate = model.errorRate * 100;

					return (
						<ExpandableModelRow
							key={key}
							gridTemplate={GRID_TEMPLATE}
							isExpanded={isExpanded}
							onToggle={() => setExpandedKey(isExpanded ? null : key)}
							cells={[
								<ModelNameCell key="name" model={model.model} provider={model.provider} />,
								<div key="requests" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{model.totalRequests.toLocaleString()}
								</div>,
								<div key="cost" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatEstimatedCost(model.totalCost, model.unpricedRequests)}
								</div>,
								<div key="tokens" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{(model.totalInputTokens + model.totalOutputTokens).toLocaleString()}
								</div>,
								<div key="tps" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{model.avgTokensPerSecond?.toFixed(1) ?? "-"}
								</div>,
								<div key="ttft" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{model.avgTtft ? `${(model.avgTtft / 1000).toFixed(2)}s` : "-"}
								</div>,
							]}
							trendCell={
								trendData.length === 0 ? (
									<TrendEmpty />
								) : (
									<MiniSparkline
										timestamps={trendData.map(d => d.timestamp)}
										values={trendData.map(d => d.avgTokensPerSecond ?? 0)}
										color={trendColor}
									/>
								)
							}
							expandedContent={
								<div className="grid gap-4" style={{ gridTemplateColumns: "200px 1fr" }}>
									<div className="space-y-4 text-sm">
										<div>
											<div className="text-[var(--text-primary)] font-medium mb-2">Efficiency</div>
											<div className="space-y-1 text-[var(--text-secondary)]">
												<div className="flex items-center justify-between">
													<span>Error rate</span>
													<span
														className={
															errorRate > 5 ? "text-[var(--accent-red)]" : "text-[var(--accent-green)]"
														}
													>
														{errorRate.toFixed(1)}%
													</span>
												</div>
												<div className="flex items-center justify-between">
													<span>Cache rate</span>
													<span className="font-mono">{(model.cacheRate * 100).toFixed(1)}%</span>
												</div>
												<div className="flex items-center justify-between">
													<span>Cache savings</span>
													<span
														className={
															model.cacheSavings < 0
																? "text-[var(--accent-red)]"
																: "text-[var(--accent-green)]"
														}
													>
														{(model.cacheSavings * 100).toFixed(1)}%
													</span>
												</div>
											</div>
										</div>
										<div>
											<div className="text-[var(--text-primary)] font-medium mb-2">Latency</div>
											<div className="space-y-1 text-[var(--text-secondary)]">
												<div className="flex items-center justify-between">
													<span>Avg duration</span>
													<span className="font-mono">
														{model.avgDuration ? `${(model.avgDuration / 1000).toFixed(2)}s` : "-"}
													</span>
												</div>
												<div className="flex items-center justify-between">
													<span>Avg TTFT</span>
													<span className="font-mono">
														{model.avgTtft ? `${(model.avgTtft / 1000).toFixed(2)}s` : "-"}
													</span>
												</div>
											</div>
										</div>
									</div>
									<div className="h-[200px]">
										{trendData.length === 0 ? (
											<DetailChartEmpty />
										) : (
											<PerformanceChart
												data={trendData}
												color={trendColor}
												chartTheme={chartTheme}
												timeRange={timeRange}
											/>
										)}
									</div>
								</div>
							}
						/>
					);
				})}
			</ModelTableBody>
		</ModelTableShell>
	);
}

function PerformanceChart({
	data,
	color,
	chartTheme,
	timeRange,
}: {
	data: Array<{
		timestamp: number;
		avgTtftSeconds: number | null;
		avgTokensPerSecond: number | null;
	}>;
	color: string;
	chartTheme: TableChartTheme;
	timeRange: TimeRange;
}) {
	const chartData = useMemo(() => {
		return {
			labels: data.map(d => formatRangeTick(d.timestamp, timeRange)),
			datasets: [
				{
					label: "TTFT",
					data: data.map(d => d.avgTtftSeconds ?? null),
					...lineSeriesStyle("#5ad8e6"),
					yAxisID: "y" as const,
				},
				{
					label: "Tokens/s",
					data: data.map(d => d.avgTokensPerSecond ?? null),
					...lineSeriesStyle(color),
					yAxisID: "y1" as const,
				},
			],
		};
	}, [data, color, timeRange]);

	const options = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			plugins: detailChartPlugins(chartTheme),
			scales: detailChartScalesDualAxis(chartTheme),
		};
	}, [chartTheme]);

	return <Line data={chartData} options={options} />;
}
