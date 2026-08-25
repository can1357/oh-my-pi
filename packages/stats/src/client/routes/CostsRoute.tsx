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
import { buildCostSummary } from "../data/view-models";
import type { CostTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";
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
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Costs <span>{range} · api-equivalent</span>
					</h2>
					<span className="omp-hero-range">
						{costStats ? `${costStats.costSeries.length} days · rate-card value` : "loading"}
					</span>
				</div>
				<p
					style={{
						fontFamily: "var(--font-sans)",
						fontSize: 12,
						color: "var(--muted)",
						margin: 0,
						maxWidth: 760,
						lineHeight: 1.5,
					}}
				>
					Public API rate-card estimate — not billed cost. Unpriced subscription requests (e.g. xai-oauth) are
					excluded and disclosed, not silently zeroed.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={costStats}>
				{costStats && (
					<>
						<CostSummaryPanel costSeries={costStats.costSeries} />
						<CostTrendPanel costSeries={costStats.costSeries} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

function CostSummaryPanel({ costSeries }: { costSeries: CostTimeSeriesPoint[] }) {
	const summary = useMemo(() => buildCostSummary(costSeries), [costSeries]);
	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Totals</div>
					<p className="omp-section-desc">Aggregated across daily buckets. Average is total / days with data.</p>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div className="omp-token-grid">
					<div className="omp-token-item">
						<div className="omp-token-label">API-equivalent estimate</div>
						<div className="omp-token-value">
							{formatEstimatedCost(summary.totalCost, summary.unpricedRequests)}
						</div>
						<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
							{summary.unpricedRequests > 0
								? `Excludes ${summary.unpricedRequests.toLocaleString()} unpriced`
								: "all priced"}
						</div>
					</div>
					<div className="omp-token-item">
						<div className="omp-token-label">Avg / day</div>
						<div className="omp-token-value">
							{formatEstimatedCost(summary.avgDailyCost, summary.unpricedRequests)}
						</div>
						<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
							{costSeries.length} buckets
						</div>
					</div>
					<div className="omp-token-item">
						<div className="omp-token-label">Top model</div>
						<div className="omp-token-value" style={{ fontSize: 14 }}>
							{summary.topModelName || "—"}
						</div>
						<div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)" }}>
							{summary.topModelName ? formatCost(summary.topModelCost) : ""}
						</div>
					</div>
					<div className="omp-token-item">
						<div className="omp-token-label">Days</div>
						<div className="omp-token-value">{costSeries.length}</div>
						<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>in window</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function CostTrendPanel({ costSeries }: { costSeries: CostTimeSeriesPoint[] }) {
	const [byModel, setByModel] = useState(false);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const unpricedRequests = useMemo(() => costSeries.reduce((sum, p) => sum + p.unpricedRequests, 0), [costSeries]);

	const chartData = useMemo(() => {
		if (byModel) {
			return buildTopNByModelSeries<CostTimeSeriesPoint, { total: number }>(costSeries, {
				rankWeight: p => p.cost,
				initBucket: () => ({ total: 0 }),
				accumulate: (bucket, point) => {
					bucket.total += point.cost;
				},
				bucketToValue: bucket => bucket.total,
			});
		}
		return buildAggregateTimeSeries<CostTimeSeriesPoint, { total: number }>(costSeries, "API-equivalent estimate", {
			initBucket: () => ({ total: 0 }),
			accumulate: (bucket, point) => {
				bucket.total += point.cost;
			},
			bucketToValue: bucket => bucket.total,
		});
	}, [costSeries, byModel]);

	const sharedPlugins = useMemo(
		() =>
			buildSharedPlugins({
				chartTheme,
				showLegend: byModel,
				defaultLabel: "API-equivalent estimate",
				formatValue: v => `$${v.toFixed(2)}`,
				footer: items => {
					if (!byModel || items.length < 2) return undefined;
					const total = items.reduce((s, item) => s + (item.parsed.y ?? 0), 0);
					return `Total: $${total.toFixed(2)}`;
				},
			}),
		[chartTheme, byModel],
	);

	const { sharedScaleBase, yScale } = useMemo(
		() => buildSharedScales({ chartTheme, formatY: v => `$${Math.round(v)}` }),
		[chartTheme],
	);

	const lineData = useMemo(() => {
		if (!byModel) return null;
		return {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => lineDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};
	}, [chartData, byModel]);
	const barData = useMemo(() => {
		if (byModel) return null;
		return {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => barDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};
	}, [chartData, byModel]);

	const lineOptions = useMemo(
		() => ({
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: sharedPlugins,
			scales: { x: sharedScaleBase, y: yScale },
		}),
		[sharedPlugins, sharedScaleBase, yScale],
	);
	const barOptions = useMemo(
		() => ({
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: { ...sharedPlugins },
			scales: { x: { ...sharedScaleBase, stacked: true }, y: { ...yScale, stacked: true } },
		}),
		[sharedPlugins, sharedScaleBase, yScale],
	);

	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Daily cost</div>
					<p className="omp-section-desc">
						{unpricedRequests > 0
							? `Excludes ${unpricedRequests.toLocaleString()} unpriced subscription requests`
							: "Rate-card value over time"}
					</p>
				</div>
				<div className="stats-segmented-control">
					<button
						type="button"
						className="stats-segmented-control-btn"
						data-active={!byModel ? "true" : "false"}
						onClick={() => setByModel(false)}
					>
						All
					</button>
					<button
						type="button"
						className="stats-segmented-control-btn"
						data-active={byModel ? "true" : "false"}
						onClick={() => setByModel(true)}
					>
						By model
					</button>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div style={{ height: 280 }}>
					{chartData.labels.length === 0 ? (
						<div className="stats-table-empty">No cost data in range</div>
					) : byModel && lineData ? (
						<Line data={lineData as never} options={lineOptions as never} />
					) : barData ? (
						<Bar data={barData as never} options={barOptions as never} />
					) : null}
				</div>
			</div>
		</div>
	);
}
