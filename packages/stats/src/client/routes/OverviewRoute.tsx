import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { getOverviewStats, getRecentRequests } from "../api";
import { AgentTokenShare } from "../components/AgentTokenShare";
import { CHART_THEMES } from "../components/chart-shared";
import { formatDurationMs, formatInteger, formatMessageCost, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, MetricCluster, Panel, Skeleton, StatusPill } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface OverviewRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function OverviewRoute({ active, range, refreshTrigger, onRequestClick }: OverviewRouteProps) {
	const { i18n } = useStatsI18n();
	const {
		data: overview,
		error: overviewError,
		loading: overviewLoading,
	} = useResource(["overview", range, refreshTrigger], signal => getOverviewStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const {
		data: recentRequests,
		error: requestsError,
		loading: requestsLoading,
	} = useResource(["recent-requests", refreshTrigger], signal => getRecentRequests(50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const chartData = useMemo(() => {
		if (!overview?.timeSeries) return { labels: [], datasets: [] };
		const labels = overview.timeSeries.map(pt =>
			range === "1h" || range === "24h"
				? i18n.date(pt.timestamp, { hour: "2-digit", minute: "2-digit" })
				: i18n.date(pt.timestamp, { month: "short", day: "numeric" }),
		);
		// Show point markers when the series is sparse (e.g. a quiet 1h window)
		// so a 1-2 point line is still visible instead of an empty plot.
		const pointRadius = overview.timeSeries.length <= 2 ? 3 : 0;
		return {
			labels,
			datasets: [
				{
					label: i18n.t("stats.trace.requests"),
					data: overview.timeSeries.map(pt => pt.requests),
					borderColor: "#5ad8e6",
					backgroundColor: "rgba(90, 216, 230, 0.12)",
					tension: 0.2,
					borderWidth: 2,
					pointRadius,
					pointHoverRadius: 4,
					fill: true,
				},
				{
					label: i18n.t("stats.trace.errors"),
					data: overview.timeSeries.map(pt => pt.errors),
					borderColor: "#ff6b7d",
					backgroundColor: "rgba(255, 107, 125, 0.12)",
					tension: 0.2,
					borderWidth: 2,
					pointRadius,
					pointHoverRadius: 4,
					fill: true,
				},
			],
		};
	}, [overview?.timeSeries, range, i18n]);

	const chartOptions = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: {
				mode: "index" as const,
				intersect: false,
			},
			plugins: {
				legend: {
					display: true,
					position: "top" as const,
					align: "end" as const,
					labels: {
						color: chartTheme.legendLabel,
						boxWidth: 8,
						usePointStyle: true,
						font: { size: 11 },
					},
				},
				tooltip: {
					backgroundColor: chartTheme.tooltipBackground,
					titleColor: chartTheme.tooltipTitle,
					bodyColor: chartTheme.tooltipBody,
					borderColor: chartTheme.tooltipBorder,
					borderWidth: 1,
					cornerRadius: 8,
					padding: 10,
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
						font: { size: 10 },
					},
				},
				y: {
					grid: {
						color: chartTheme.grid,
						drawBorder: false,
					},
					ticks: {
						color: chartTheme.tick,
						font: { size: 10 },
					},
					min: 0,
				},
			},
		};
	}, [chartTheme]);

	const columns = useMemo(
		() => [
			{
				key: "model",
				header: i18n.t("stats.table.model"),
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: i18n.t("stats.table.time"),
				render: (item: MessageStats) => formatRelativeTime(item.timestamp, i18n.locale),
			},
			{
				key: "tokens",
				header: i18n.t("stats.table.tokens"),
				numeric: true,
				render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
			},
			{
				key: "cost",
				header: i18n.t("stats.metrics.apiEstimate"),
				numeric: true,
				render: (item: MessageStats) => formatMessageCost(item, 4),
			},
			{
				key: "duration",
				header: i18n.t("stats.drawer.duration"),
				numeric: true,
				render: (item: MessageStats) => formatDurationMs(item.duration),
			},
			{
				key: "status",
				header: i18n.t("stats.table.status"),
				className: "stats-text-center",
				render: (item: MessageStats) => (
					<StatusPill variant={item.errorMessage ? "danger" : "success"}>
						{item.errorMessage ? i18n.t("stats.table.failed") : i18n.t("stats.table.success")}
					</StatusPill>
				),
			},
		],
		[i18n],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? i18n.t("stats.table.failed") : i18n.t("stats.table.success")}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.table.time")}</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp, i18n.locale)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.metrics.apiEstimate")}</div>
					<div className="stats-mobile-card-value">{formatMessageCost(item, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.table.tokens")}</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{i18n.t("stats.drawer.duration")}</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.duration)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error truncate mt-2">{item.errorMessage}</div>}
		</div>
	);

	const previewRequests = useMemo(() => {
		if (!recentRequests) return [];
		return recentRequests.slice(0, 10);
	}, [recentRequests]);

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={overviewLoading} error={overviewError} data={overview}>
				{overview && <MetricCluster stats={overview.overall} />}
			</AsyncBoundary>

			<Panel
				title={i18n.t("stats.overview.conversationTokensByAgent")}
				subtitle={i18n.t("stats.overview.conversationTokensSubtitle")}
			>
				<AsyncBoundary loading={overviewLoading} error={overviewError} data={overview}>
					{overview && <AgentTokenShare stats={overview.byAgentType} />}
				</AsyncBoundary>
			</Panel>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<div className="lg:col-span-2">
					<Panel
						title={i18n.t("stats.overview.systemThroughput")}
						subtitle={i18n.t("stats.overview.throughputSubtitle")}
					>
						<AsyncBoundary loading={overviewLoading} error={overviewError} data={overview}>
							<div className="h-[280px]">
								{overview?.timeSeries && overview.timeSeries.length > 0 ? (
									<Line data={chartData} options={chartOptions} />
								) : (
									<div className="h-full flex items-center justify-center text-stats-muted text-sm">
										{i18n.t("stats.overview.noTimeSeries")}
									</div>
								)}
							</div>
						</AsyncBoundary>
					</Panel>
				</div>

				<div>
					<Panel title={i18n.t("stats.overview.operationalFeed")} subtitle={i18n.t("stats.overview.realTimeLog")}>
						<AsyncBoundary
							loading={requestsLoading}
							error={requestsError}
							data={recentRequests}
							fallback={
								<div className="space-y-4">
									{Array.from({ length: 5 }).map((_, i) => (
										<div key={i} className="flex items-center gap-3">
											<Skeleton variant="circle" width={10} height={10} />
											<div className="flex-1">
												<Skeleton variant="text" width="60%" height={16} />
												<Skeleton variant="text" width="40%" height={12} />
											</div>
										</div>
									))}
								</div>
							}
						>
							<div className="stats-feed-ledger overflow-y-auto max-h-[280px] pr-2">
								{previewRequests.map(req => {
									const isError = !!req.errorMessage;
									return (
										<div
											key={req.id || `${req.sessionFile}-${req.entryId}`}
											className="stats-feed-item flex items-start gap-3 p-2 rounded hover:bg-stats-surface-2 cursor-pointer transition-colors"
											onClick={() => req.id && onRequestClick(req.id)}
										>
											<div
												className={`w-2 h-2 mt-1.5 rounded-full flex-shrink-0 ${
													isError ? "bg-stats-danger" : "bg-stats-success"
												}`}
											/>
											<div className="flex-1 min-w-0">
												<div className="flex justify-between items-baseline gap-2">
													<div className="stats-font-medium stats-text-primary text-sm truncate">
														{req.model}
													</div>
													<div className="stats-text-xs stats-text-muted whitespace-nowrap">
														{formatRelativeTime(req.timestamp, i18n.locale)}
													</div>
												</div>
												<div className="flex justify-between items-center text-xs stats-text-muted mt-0.5">
													<div>{req.provider}</div>
													<div>
														{req.duration ? formatDurationMs(req.duration) : ""}{" "}
														{req.usage.totalTokens > 0 ? `· ${formatMessageCost(req, 4)}` : ""}
													</div>
												</div>
												{isError && (
													<div className="text-xs text-stats-danger truncate mt-1">{req.errorMessage}</div>
												)}
											</div>
										</div>
									);
								})}
								{previewRequests.length === 0 && (
									<div className="py-8 text-center stats-text-muted text-sm">
										{i18n.t("stats.table.noRecentRequests")}
									</div>
								)}
							</div>
						</AsyncBoundary>
					</Panel>
				</div>
			</div>

			<Panel
				title={i18n.t("stats.overview.recentRequestsPreview")}
				subtitle={i18n.t("stats.overview.latestTransactions")}
				actions={
					<a href={`#/requests?range=${range}`} className="stats-button stats-button-secondary text-xs">
						{i18n.t("stats.overview.viewAllRequests")}
					</a>
				}
			>
				<AsyncBoundary loading={requestsLoading} error={requestsError} data={recentRequests}>
					<DataTable
						columns={columns}
						data={previewRequests}
						keyExtractor={item => item.id || `${item.sessionFile}-${item.entryId}`}
						onRowClick={item => item.id && onRequestClick(item.id)}
						renderMobileCard={renderMobileCard}
						emptyText={i18n.t("stats.table.noRecentRequests")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
