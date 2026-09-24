import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getToolDashboardStats } from "../api";
import { CHART_THEMES, MODEL_COLORS } from "../components/chart-shared";
import { formatRangeTick, rangeWindowLabel } from "../components/range-meta";
import {
	formatCompact,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
} from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import { buildToolRows, type ToolRowView } from "../data/view-models";
import type { TimeRange, ToolModelStats, ToolTimeSeriesPoint, ToolUsageStats } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface ToolsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function ToolsRoute({ active, range, refreshTrigger }: ToolsRouteProps) {
	const { i18n } = useStatsI18n();
	const {
		data: stats,
		error,
		loading,
	} = useResource(["tools", range, refreshTrigger], signal => getToolDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats} emptyText={i18n.t("stats.tools.noData")}>
				{stats && (
					<>
						<ToolsSummaryPanel byTool={stats.byTool} />
						<ToolCallsChart series={stats.series} timeRange={range} />
						<ToolsTable byTool={stats.byTool} />
						<ToolModelPanel byToolModel={stats.byToolModel} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

function ToolsSummaryPanel({ byTool }: { byTool: ToolUsageStats[] }) {
	const { i18n } = useStatsI18n();
	const totals = useMemo(() => {
		let calls = 0;
		let errors = 0;
		let tokens = 0;
		let output = 0;
		let cost = 0;
		let unpricedRequests = 0;
		let resultChars = 0;
		let argsChars = 0;
		for (const t of byTool) {
			calls += t.calls;
			errors += t.errors;
			tokens += t.totalTokensShare;
			output += t.outputTokensShare;
			cost += t.costShare;
			unpricedRequests += t.unpricedRequestsShare;
			resultChars += t.resultChars;
			argsChars += t.argsChars;
		}
		return { calls, errors, tokens, output, cost, unpricedRequests, resultChars, argsChars, tools: byTool.length };
	}, [byTool]);

	return (
		<Panel title={i18n.t("stats.tools.toolUsage")} subtitle={i18n.t("stats.tools.toolUsageSubtitle")}>
			<div className="stats-metric-cluster">
				<div className="stats-metric-primary-grid">
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">{i18n.t("stats.trace.toolCalls")}</div>
						<div className="stats-metric-value">{formatInteger(totals.calls)}</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">{i18n.t("stats.tools.toolsUsed")}</div>
						<div className="stats-metric-value">{formatInteger(totals.tools)}</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">{i18n.t("stats.metrics.errorRate")}</div>
						<div className="stats-metric-value">
							{formatPercent(totals.calls > 0 ? totals.errors / totals.calls : 0)}
						</div>
					</div>
					<div className="stats-metric-card primary">
						<div className="stats-metric-label">{i18n.t("stats.tools.attributedCost")}</div>
						<div className="stats-metric-value">{formatEstimatedCost(totals.cost, totals.unpricedRequests)}</div>
					</div>
				</div>

				<div className="stats-metric-secondary-grid">
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">{i18n.t("stats.tools.attributedTokens")}</div>
						<div className="stats-metric-value">{formatCompact(Math.round(totals.tokens))}</div>
					</div>
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">{i18n.t("stats.tools.attributedOutput")}</div>
						<div className="stats-metric-value">{formatCompact(Math.round(totals.output))}</div>
					</div>
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">{i18n.t("stats.tools.resultText")}</div>
						<div className="stats-metric-value">{formatCompact(totals.resultChars)} chars</div>
					</div>
					<div className="stats-metric-card secondary">
						<div className="stats-metric-label">{i18n.t("stats.tools.callArguments")}</div>
						<div className="stats-metric-value">{formatCompact(totals.argsChars)} chars</div>
					</div>
				</div>
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Calls over time (stacked by top tools)
// ---------------------------------------------------------------------------

const TOP_TOOLS = 6;

function buildToolCallSeries(points: ToolTimeSeriesPoint[]): {
	buckets: number[];
	tools: string[];
	data: Map<number, Record<string, number>>;
} {
	const totals = new Map<string, number>();
	for (const p of points) totals.set(p.tool, (totals.get(p.tool) ?? 0) + p.calls);
	const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
	const top = ranked.slice(0, TOP_TOOLS).map(([tool]) => tool);
	const topSet = new Set(top);
	const hasOther = ranked.length > top.length;
	const tools = hasOther ? [...top, "Other"] : top;

	const buckets = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);
	const data = new Map<number, Record<string, number>>();
	for (const bucket of buckets) data.set(bucket, {});
	for (const p of points) {
		const label = topSet.has(p.tool) ? p.tool : "Other";
		const row = data.get(p.timestamp);
		if (row) row[label] = (row[label] ?? 0) + p.calls;
	}
	return { buckets, tools, data };
}

function ToolCallsChart({ series, timeRange }: { series: ToolTimeSeriesPoint[]; timeRange: TimeRange }) {
	const { i18n } = useStatsI18n();
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const chartSeries = useMemo(() => buildToolCallSeries(series), [series]);

	const data = useMemo(
		() => ({
			labels: chartSeries.buckets.map(ts => formatRangeTick(ts, timeRange, i18n.locale)),
			datasets: chartSeries.tools.map((tool, index) => ({
				label: tool,
				data: chartSeries.buckets.map(bucket => chartSeries.data.get(bucket)?.[tool] ?? 0),
				borderColor: MODEL_COLORS[index % MODEL_COLORS.length],
				backgroundColor: `${MODEL_COLORS[index % MODEL_COLORS.length]}30`,
				fill: true,
				tension: 0.4,
				pointRadius: 0,
				pointHoverRadius: 4,
				borderWidth: 2,
			})),
		}),
		[chartSeries, timeRange, i18n.locale],
	);

	const options = useMemo(
		() => ({
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
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
						label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) =>
							`${context.dataset.label ?? ""}: ${formatInteger(context.parsed.y ?? 0)} calls`,
					},
				},
			},
			scales: {
				x: {
					stacked: true,
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 11 } },
				},
				y: {
					stacked: true,
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 11 }, precision: 0 },
					min: 0,
				},
			},
		}),
		[chartTheme],
	);

	return (
		<Panel
			title={i18n.t("stats.tools.callsOverTime")}
			subtitle={i18n.t("stats.tools.callsOverTimeSubtitle", { window: rangeWindowLabel(timeRange, i18n) })}
		>
			<div className="h-[280px]">
				{chartSeries.buckets.length === 0 ? (
					<div className="h-full flex items-center justify-center text-stats-muted text-sm">
						{i18n.t("stats.tools.noData")}
					</div>
				) : (
					<Line data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Per-tool table
// ---------------------------------------------------------------------------

function errorPillVariant(errorRate: number): "danger" | "warning" | "success" {
	return errorRate > 0.1 ? "danger" : errorRate > 0 ? "warning" : "success";
}

function ToolsTable({ byTool }: { byTool: ToolUsageStats[] }) {
	const { i18n } = useStatsI18n();
	const rows = useMemo(() => buildToolRows(byTool), [byTool]);

	const columns = useMemo(
		() => [
			{
				key: "tool",
				header: i18n.t("stats.trace.tool"),
				render: (item: ToolRowView) => (
					<div className="stats-font-medium stats-text-primary font-mono truncate max-w-[280px]" title={item.tool}>
						{item.tool}
					</div>
				),
			},
			{
				key: "calls",
				header: i18n.t("stats.trace.calls"),
				numeric: true,
				render: (item: ToolRowView) => (
					<div className="stats-text-right">
						<div className="font-mono">{formatInteger(item.calls)}</div>
						<div className="stats-progress-bar-track mt-1 ml-auto w-24 h-1">
							<div
								className="stats-progress-bar-fill"
								data-variant="link"
								style={{ width: `${item.callsPercentage}%` }}
							/>
						</div>
					</div>
				),
			},
			{
				key: "errorRate",
				header: i18n.t("stats.metrics.errorRate"),
				numeric: true,
				render: (item: ToolRowView) => (
					<StatusPill variant={errorPillVariant(item.errorRate)}>{formatPercent(item.errorRate)}</StatusPill>
				),
			},
			{
				key: "tokens",
				header: i18n.t("stats.tools.attributedTokens"),
				numeric: true,
				render: (item: ToolRowView) => (
					<span className="font-mono" title="Invoking turns' total tokens, split across each turn's calls">
						{formatCompact(Math.round(item.totalTokensShare))}
					</span>
				),
			},
			{
				key: "cost",
				header: i18n.t("stats.tools.attributedCost"),
				numeric: true,
				render: (item: ToolRowView) => (
					<span className="font-mono">{formatEstimatedCost(item.costShare, item.unpricedRequestsShare)}</span>
				),
			},
			{
				key: "resultChars",
				header: i18n.t("stats.tools.resultText"),
				numeric: true,
				render: (item: ToolRowView) => (
					<span className="font-mono" title={i18n.t("stats.tools.resultTextTitle")}>
						{formatCompact(item.resultChars)}
					</span>
				),
			},
			{
				key: "lastUsed",
				header: i18n.t("stats.tools.lastUsed"),
				numeric: true,
				render: (item: ToolRowView) => (
					<span className="stats-text-secondary">{formatRelativeTime(item.lastUsed, i18n.locale)}</span>
				),
			},
		],
		[i18n],
	);

	const renderMobileCard = (item: ToolRowView) => (
		<div className="stats-mobile-card">
			<div className="stats-mobile-card-header mb-2">
				<div className="stats-font-semibold stats-text-primary font-mono">{item.tool}</div>
				<StatusPill variant={errorPillVariant(item.errorRate)}>{formatPercent(item.errorRate)} Err</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.trace.calls")}</div>
					<div className="stats-mobile-card-value font-mono">{formatInteger(item.calls)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.tools.attributedTokens")}</div>
					<div className="stats-mobile-card-value font-mono">
						{formatCompact(Math.round(item.totalTokensShare))}
					</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.tools.attributedCost")}</div>
					<div className="stats-mobile-card-value font-mono">
						{formatEstimatedCost(item.costShare, item.unpricedRequestsShare)}
					</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.tools.resultText")}</div>
					<div className="stats-mobile-card-value font-mono">{formatCompact(item.resultChars)}</div>
				</div>
			</div>
		</div>
	);

	return (
		<Panel title={i18n.t("stats.tools.byTool")} subtitle={i18n.t("stats.tools.byToolSubtitle")}>
			<DataTable
				columns={columns}
				data={rows}
				keyExtractor={item => item.tool}
				renderMobileCard={renderMobileCard}
				emptyText={i18n.t("stats.tools.noData")}
			/>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Per-(tool, model) breakdown
// ---------------------------------------------------------------------------

function ToolModelPanel({ byToolModel }: { byToolModel: ToolModelStats[] }) {
	const { i18n } = useStatsI18n();
	const [tool, setTool] = useState<string | null>(null);

	const tools = useMemo(() => [...new Set(byToolModel.map(row => row.tool))].sort(), [byToolModel]);

	const rows = useMemo(() => {
		const filtered = tool ? byToolModel.filter(row => row.tool === tool) : byToolModel;
		return filtered.map(row => ({
			...row,
			errorRate: row.calls > 0 ? row.errors / row.calls : 0,
		}));
	}, [byToolModel, tool]);

	const columns = useMemo(
		() => [
			{
				key: "tool",
				header: i18n.t("stats.trace.tool"),
				render: (item: ToolModelStats & { errorRate: number }) => (
					<span className="stats-font-medium stats-text-primary font-mono">{item.tool}</span>
				),
			},
			{
				key: "model",
				header: i18n.t("stats.table.model"),
				render: (item: ToolModelStats & { errorRate: number }) => (
					<div>
						<div className="stats-text-primary">{item.model || "(unknown)"}</div>
						<div className="stats-text-secondary text-xs">{item.provider}</div>
					</div>
				),
			},
			{
				key: "calls",
				header: i18n.t("stats.trace.calls"),
				numeric: true,
				render: (item: ToolModelStats & { errorRate: number }) => (
					<span className="font-mono">{formatInteger(item.calls)}</span>
				),
			},
			{
				key: "errorRate",
				header: i18n.t("stats.metrics.errorRate"),
				numeric: true,
				render: (item: ToolModelStats & { errorRate: number }) => (
					<StatusPill variant={errorPillVariant(item.errorRate)}>{formatPercent(item.errorRate)}</StatusPill>
				),
			},
			{
				key: "tokens",
				header: i18n.t("stats.tools.attributedTokens"),
				numeric: true,
				render: (item: ToolModelStats & { errorRate: number }) => (
					<span className="font-mono">{formatCompact(Math.round(item.totalTokensShare))}</span>
				),
			},
			{
				key: "cost",
				header: i18n.t("stats.tools.attributedCost"),
				numeric: true,
				render: (item: ToolModelStats & { errorRate: number }) => (
					<span className="font-mono">{formatEstimatedCost(item.costShare, item.unpricedRequestsShare)}</span>
				),
			},
		],
		[i18n],
	);

	return (
		<Panel title={i18n.t("stats.tools.byModel")} subtitle={i18n.t("stats.tools.byModelSubtitle")}>
			<div className="mb-4" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
				<span className="stats-text-secondary" style={{ fontSize: "0.875rem", whiteSpace: "nowrap" }}>
					{i18n.t("stats.trace.tool")}
				</span>
				<select
					className="stats-select"
					value={tool ?? ""}
					onChange={e => setTool(e.target.value || null)}
					style={{ maxWidth: "320px", flex: 1 }}
				>
					<option value="">{i18n.t("stats.tools.allTools")}</option>
					{tools.map(name => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
			</div>
			<DataTable
				columns={columns}
				data={rows}
				keyExtractor={item => `${item.tool}::${item.model}::${item.provider}`}
				emptyText={i18n.t("stats.tools.noData")}
			/>
		</Panel>
	);
}
