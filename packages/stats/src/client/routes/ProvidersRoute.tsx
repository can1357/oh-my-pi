import { useMemo, useState } from "react";
import { Bar } from "react-chartjs-2";
import { getProviderDashboardStats } from "../api";
import {
	barDatasetStyle,
	buildSharedPlugins,
	buildSharedScales,
	buildTopNByModelSeries,
	CHART_THEMES,
	MODEL_COLORS,
	styleDatasets,
} from "../components/chart-shared";
import {
	formatCompact,
	formatCost,
	formatEstimatedCost,
	formatInteger,
	formatPercent,
	formatRelativeTime,
	formatTokensPerSecond,
} from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import type {
	ProviderAggregate,
	ProviderDashboardStats,
	ProviderHourlyPoint,
	ProviderWindowInsight,
	TimeRange,
	UsageWindowSeries,
} from "../types";
import { AsyncBoundary, DataTable, type DataTableColumn, EmptyState, Panel, SegmentedControl } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface ProvidersRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function ProvidersRoute({ active, range, refreshTrigger }: ProvidersRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["providers", range, refreshTrigger], signal => getProviderDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<ProviderTotalsPanel providers={stats.providers} />
						<ProviderTrendPanel stats={stats} />
						<PeakHoursPanel hourly={stats.hourly} providers={stats.providers} />
						<WindowInsightsPanel insights={stats.windowInsights} />
						<WindowUtilizationPanel usageSeries={stats.usageSeries} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Provider totals
// ---------------------------------------------------------------------------

function ProviderTotalsPanel({ providers }: { providers: ProviderAggregate[] }) {
	const { i18n } = useStatsI18n();
	const grandTotal = useMemo(() => providers.reduce((sum, p) => sum + p.totalTokens, 0), [providers]);
	const unpricedRequests = useMemo(
		() => providers.reduce((sum, provider) => sum + provider.unpricedRequests, 0),
		[providers],
	);

	const columns: DataTableColumn<ProviderAggregate>[] = [
		{
			key: "provider",
			header: i18n.t("stats.providers.provider"),
			render: p => <span className="font-medium">{p.provider}</span>,
		},
		{
			key: "requests",
			header: i18n.t("stats.providers.requests"),
			numeric: true,
			render: p => formatInteger(p.totalRequests),
		},
		{
			key: "errors",
			header: i18n.t("stats.metrics.errorRate"),
			numeric: true,
			render: p => formatPercent(p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0),
		},
		{ key: "models", header: i18n.t("stats.nav.models"), numeric: true, render: p => formatInteger(p.models) },
		{
			key: "tokens",
			header: i18n.t("stats.providers.tokens"),
			numeric: true,
			render: p => (
				<span
					title={`Input ${formatCompact(p.totalInputTokens)} · Output ${formatCompact(p.totalOutputTokens)} · Cache read ${formatCompact(p.totalCacheReadTokens)} · Cache write ${formatCompact(p.totalCacheWriteTokens)}`}
				>
					{formatCompact(p.totalTokens)}
				</span>
			),
		},
		{
			key: "share",
			header: i18n.t("stats.providers.share"),
			numeric: true,
			render: p => formatPercent(grandTotal > 0 ? p.totalTokens / grandTotal : 0),
		},
		{
			key: "cost",
			header: i18n.t("stats.providers.apiEstimate"),
			numeric: true,
			render: provider => formatEstimatedCost(provider.totalCost, provider.unpricedRequests),
		},
		{
			key: "tps",
			header: i18n.t("stats.metrics.tokensPerSecond"),
			numeric: true,
			render: p => formatTokensPerSecond(p.avgTokensPerSecond),
		},
	];

	return (
		<Panel
			title={i18n.t("stats.providers.provider")}
			subtitle={
				unpricedRequests > 0
					? `Token, request, and API-equivalent estimates; excludes ${unpricedRequests.toLocaleString()} unpriced subscription request${unpricedRequests === 1 ? "" : "s"}`
					: `${i18n.t("stats.providers.tokens")}, ${i18n.t("stats.providers.requests")} ${i18n.t("stats.providers.apiEstimate")} over the active range`
			}
		>
			<DataTable
				columns={columns}
				data={providers}
				keyExtractor={p => p.provider}
				emptyText={i18n.t("stats.providers.noActivity")}
			/>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Token / cost trend by provider
// ---------------------------------------------------------------------------

function ProviderTrendPanel({ stats }: { stats: ProviderDashboardStats }) {
	const { i18n } = useStatsI18n();
	const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const unpricedRequests = useMemo(
		() => stats.providers.reduce((sum, provider) => sum + provider.unpricedRequests, 0),
		[stats.providers],
	);

	// buildTopNByModelSeries keys on `model`; feed it the provider name so we
	// get the same top-N + "Other" rollup without a parallel implementation.
	const chartData = useMemo(() => {
		const points = stats.series.map(p => ({ ...p, model: p.provider }));
		return buildTopNByModelSeries<(typeof points)[number], { total: number }>(points, {
			topN: 6,
			rankWeight: p => (metric === "tokens" ? p.totalTokens : p.cost),
			initBucket: () => ({ total: 0 }),
			accumulate: (bucket, p) => {
				bucket.total += metric === "tokens" ? p.totalTokens : p.cost;
			},
			bucketToValue: bucket => bucket.total,
		});
	}, [stats.series, metric]);

	const formatValue = metric === "tokens" ? formatCompact : (v: number) => formatCost(v);
	const options = useMemo(() => {
		const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: formatValue });
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: buildSharedPlugins({
				chartTheme,
				showLegend: true,
				defaultLabel:
					metric === "tokens" ? i18n.t("stats.providers.tokens") : i18n.t("stats.providers.apiEstimate"),
				formatValue,
				footer: items => {
					if (items.length < 2) return undefined;
					const total = items.reduce((sum, item) => sum + (item.parsed.y ?? 0), 0);
					return `Total: ${formatValue(total)}`;
				},
			}),
			scales: {
				x: { ...sharedScaleBase, stacked: true },
				y: { ...yScale, stacked: true },
			},
		};
	}, [chartTheme, metric, formatValue, i18n]);

	const data = useMemo(
		() => ({
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => barDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		}),
		[chartData],
	);

	return (
		<Panel
			title={i18n.t("stats.providers.burnByProvider")}
			subtitle={
				metric === "cost" && unpricedRequests > 0
					? `API-equivalent estimates over time; excludes ${unpricedRequests.toLocaleString()} unpriced subscription request${unpricedRequests === 1 ? "" : "s"}`
					: `${i18n.t("stats.providers.tokens")} / ${i18n.t("stats.providers.apiEstimate")} burn over time`
			}
			actions={
				<SegmentedControl
					options={[
						{ value: "tokens" as const, label: i18n.t("stats.providers.tokens") },
						{ value: "cost" as const, label: i18n.t("stats.providers.apiEstimate") },
					]}
					value={metric}
					onChange={setMetric}
				/>
			}
		>
			<div className="h-[300px]">
				{chartData.labels.length === 0 ? (
					<EmptyState message={i18n.t("stats.providers.noActivity")} />
				) : (
					<Bar data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Peak burn hours
// ---------------------------------------------------------------------------

const ALL_PROVIDERS = "__all__";

function PeakHoursPanel({ hourly, providers }: { hourly: ProviderHourlyPoint[]; providers: ProviderAggregate[] }) {
	const { i18n } = useStatsI18n();
	const [provider, setProvider] = useState(ALL_PROVIDERS);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const { tokensByHour, peakHour } = useMemo(() => {
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const tokens = new Array<number>(24).fill(0);
		for (const point of hourly) {
			if (provider !== ALL_PROVIDERS && point.provider !== provider) continue;
			tokens[point.hour] += point.totalTokens;
		}
		let peak = 0;
		for (let hour = 1; hour < 24; hour++) {
			if (tokens[hour] > tokens[peak]) peak = hour;
		}
		return { tokensByHour: tokens, peakHour: peak };
	}, [hourly, provider]);

	const hasData = tokensByHour.some(v => v > 0);

	const data = useMemo(
		() => ({
			labels: Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
			datasets: [
				{
					label: i18n.t("stats.providers.tokens"),
					data: tokensByHour,
					...barDatasetStyle(MODEL_COLORS[2]),
					// Highlight the peak hour in the brand accent color.
					backgroundColor: tokensByHour.map((_, hour) => (hour === peakHour ? MODEL_COLORS[0] : MODEL_COLORS[2])),
				},
			],
		}),
		[tokensByHour, peakHour],
	);

	const options = useMemo(() => {
		const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: formatCompact });
		return {
			responsive: true,
			maintainAspectRatio: false,
			plugins: buildSharedPlugins({
				chartTheme,
				showLegend: false,
				defaultLabel: i18n.t("stats.providers.tokens"),
				formatValue: formatCompact,
			}),
			scales: { x: sharedScaleBase, y: yScale },
		};
	}, [chartTheme, i18n]);

	return (
		<Panel
			title={i18n.t("stats.providers.peakHours")}
			subtitle={
				hasData
					? `Token burn by local hour of day — peak at ${String(peakHour).padStart(2, "0")}:00`
					: i18n.t("stats.providers.tokens")
			}
			actions={
				<select
					className="stats-select"
					value={provider}
					onChange={e => setProvider(e.target.value)}
					aria-label={i18n.t("stats.providers.provider")}
				>
					<option value={ALL_PROVIDERS}>{i18n.t("stats.providers.allProviders")}</option>
					{providers.map(p => (
						<option key={p.provider} value={p.provider}>
							{p.provider}
						</option>
					))}
				</select>
			}
		>
			<div className="h-[260px]">
				{hasData ? (
					<Bar data={data} options={options} />
				) : (
					<EmptyState message={i18n.t("stats.providers.noActivity")} />
				)}
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Subscription window insights
// ---------------------------------------------------------------------------

function WindowInsightsPanel({ insights }: { insights: ProviderWindowInsight[] }) {
	const { i18n } = useStatsI18n();
	const columns: DataTableColumn<ProviderWindowInsight>[] = [
		{
			key: "provider",
			header: i18n.t("stats.providers.provider"),
			render: i => <span className="font-medium">{i.provider}</span>,
		},
		{ key: "window", header: i18n.t("stats.providers.window"), render: i => i.windowLabel },
		{
			key: "accounts",
			header: i18n.t("stats.providers.accounts"),
			numeric: true,
			render: i => formatInteger(i.accounts),
		},
		{
			key: "consumed",
			header: i18n.t("stats.providers.windowsBurned"),
			numeric: true,
			render: i => (
				<span title={i18n.t("stats.providers.tokensBurnedWindowTitle")}>{i.fractionConsumed.toFixed(2)}</span>
			),
		},
		{
			key: "capacity",
			header: i18n.t("stats.providers.tokensPerWindow"),
			numeric: true,
			render: i => (
				<span title={i18n.t("stats.providers.providerTokensWindowTitle")}>
					{i.estTokensPerWindow !== null ? formatCompact(i.estTokensPerWindow) : "—"}
				</span>
			),
		},
		{
			key: "peak",
			header: i18n.t("stats.providers.peakUtilization"),
			numeric: true,
			render: i => (
				<span title={i18n.t("stats.providers.peakUtilization")}>{formatPercent(i.peakConcurrentFraction)}</span>
			),
		},
		{
			key: "ideal",
			header: i18n.t("stats.providers.idealAccounts"),
			numeric: true,
			render: i => (
				<span
					title={i18n.t("stats.providers.idealAccounts")}
					className={i.idealAccounts > i.accounts ? "stats-text-warning font-semibold" : undefined}
				>
					{formatInteger(i.idealAccounts)}
					{i.idealAccounts > i.accounts ? ` (have ${i.accounts})` : ""}
				</span>
			),
		},
		{
			key: "exhausted",
			header: i18n.t("stats.providers.exhaustions"),
			numeric: true,
			render: i => (
				<span className={i.exhaustedEvents > 0 ? "stats-text-warning" : undefined}>
					{formatInteger(i.exhaustedEvents)}
				</span>
			),
		},
	];

	return (
		<Panel
			title={i18n.t("stats.providers.subscriptionWindows")}
			subtitle={i18n.t("stats.providers.subscriptionWindowsSubtitle")}
		>
			<DataTable
				columns={columns}
				data={insights}
				keyExtractor={i => `${i.provider}::${i.windowKey}`}
				emptyText={i18n.t("stats.providers.noSnapshotDetails")}
			/>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Window utilization
// ---------------------------------------------------------------------------

const UTILIZATION_COLORS = {
	ok: "#62d394",
	warning: "#f5c14b",
	exhausted: "#ff6b7d",
} as const;

function WindowUtilizationPanel({ usageSeries }: { usageSeries: UsageWindowSeries[] }) {
	const { i18n } = useStatsI18n();
	const providers = useMemo(() => [...new Set(usageSeries.map(s => s.provider))], [usageSeries]);
	const [selected, setSelected] = useState<string | null>(null);
	const provider = selected !== null && providers.includes(selected) ? selected : (providers[0] ?? null);
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	// One row per (window, account): the latest recorded fraction. Snapshot
	// history is bursty (rows appear whenever usage is fetched), so a "how full
	// is each window right now" bar reads far better than a time axis.
	const rows = useMemo(() => {
		return usageSeries
			.filter(s => s.provider === provider)
			.map(s => {
				const latest = [...s.points].reverse().find(p => p.usedFraction !== null);
				return latest
					? {
							label: `${s.windowLabel} · ${s.accountLabel}`,
							fraction: latest.usedFraction ?? 0,
							exhausted: latest.exhausted,
							recordedAt: latest.timestamp,
						}
					: null;
			})
			.filter(row => row !== null)
			.sort((a, b) => b.fraction - a.fraction);
	}, [usageSeries, provider]);

	const data = useMemo(
		() => ({
			labels: rows.map(r => r.label),
			datasets: [
				{
					label: i18n.t("stats.providers.used"),
					data: rows.map(r => r.fraction * 100),
					backgroundColor: rows.map(r =>
						r.exhausted
							? UTILIZATION_COLORS.exhausted
							: r.fraction >= 0.8
								? UTILIZATION_COLORS.warning
								: UTILIZATION_COLORS.ok,
					),
					borderWidth: 0,
					borderRadius: 4,
					barThickness: 18,
				},
			],
		}),
		[rows],
	);

	const options = useMemo(() => {
		const { sharedScaleBase, yScale } = buildSharedScales({ chartTheme, formatY: v => `${Math.round(v)}%` });
		const xMax = Math.max(100, ...rows.map(r => r.fraction * 100));
		const shared = buildSharedPlugins({
			chartTheme,
			showLegend: false,
			defaultLabel: i18n.t("stats.providers.used"),
			formatValue: v => `${v.toFixed(1)}%`,
		});
		return {
			indexAxis: "y" as const,
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				...shared,
				tooltip: {
					...shared.tooltip,
					callbacks: {
						label: (ctx: { dataIndex: number; parsed: { x: number | null } }) => {
							const row = rows[ctx.dataIndex];
							const used = `${(ctx.parsed.x ?? 0).toFixed(1)}% ${i18n.t("stats.providers.used")}`;
							return row
								? `${used} · ${i18n.t("stats.providers.recorded", { time: formatRelativeTime(row.recordedAt, i18n.locale) })}`
								: used;
						},
					},
				},
			},
			scales: {
				x: { ...yScale, max: xMax },
				y: { ...sharedScaleBase, grid: { display: false } },
			},
		};
	}, [chartTheme, rows, i18n]);

	return (
		<Panel
			title={i18n.t("stats.providers.windowUtilization")}
			subtitle={i18n.t("stats.providers.windowUtilizationSubtitle")}
			actions={
				providers.length > 1 ? (
					<select
						className="stats-select"
						value={provider ?? ""}
						onChange={e => setSelected(e.target.value)}
						aria-label={i18n.t("stats.providers.provider")}
					>
						{providers.map(p => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				) : undefined
			}
		>
			<div style={{ height: Math.max(160, rows.length * 34 + 60) }}>
				{rows.length === 0 ? (
					<EmptyState message={i18n.t("stats.providers.noSnapshots")} />
				) : (
					<Bar data={data} options={options} />
				)}
			</div>
		</Panel>
	);
}
