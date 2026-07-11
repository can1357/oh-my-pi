import { format } from "date-fns";
import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { getOverviewStats, getRecentRequests } from "../api";
import { AgentTokenShare } from "../components/AgentTokenShare";
import { CHART_THEMES } from "../components/chart-shared";
import { formatCost, formatDurationMs, formatInteger, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
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
			format(new Date(pt.timestamp), range === "1h" || range === "24h" ? "HH:mm" : "MMM d"),
		);
		// Show point markers when the series is sparse (e.g. a quiet 1h window)
		// so a 1-2 point line is still visible instead of an empty plot.
		const pointRadius = overview.timeSeries.length <= 2 ? 3 : 0;
		return {
			labels,
			datasets: [
				{
					label: "Requests",
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
					label: "Errors",
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
	}, [overview?.timeSeries, range]);

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
				header: "Model",
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary">{item.model}</div>
						<div className="stats-text-xs stats-text-muted">{item.provider}</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: "Time",
				render: (item: MessageStats) => formatRelativeTime(item.timestamp),
			},
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
			},
			{
				key: "cost",
				header: "Cost",
				numeric: true,
				render: (item: MessageStats) => formatCost(item.usage.cost.total, 4),
			},
			{
				key: "duration",
				header: "Duration",
				numeric: true,
				render: (item: MessageStats) => formatDurationMs(item.duration),
			},
			{
				key: "status",
				header: "Status",
				className: "stats-text-center",
				render: (item: MessageStats) => (
					<StatusPill variant={item.errorMessage ? "danger" : "success"}>
						{item.errorMessage ? "Failed" : "Success"}
					</StatusPill>
				),
			},
		],
		[],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? "Failed" : "Success"}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Time</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Cost</div>
					<div className="stats-mobile-card-value">{formatCost(item.usage.cost.total, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Tokens</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Duration</div>
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
				title="Token Usage by Agent"
				subtitle="Share of tokens across the main agent, task subagents, and the advisor"
			>
				<AsyncBoundary loading={overviewLoading} error={overviewError} data={overview}>
					{overview && <AgentTokenShare stats={overview.byAgentType} />}
				</AsyncBoundary>
			</Panel>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<div className="lg:col-span-2">
					<Panel title="System Throughput" subtitle="Request volume and errors over time">
						<AsyncBoundary loading={overviewLoading} error={overviewError} data={overview}>
							<div className="h-[280px]">
								{overview?.timeSeries && overview.timeSeries.length > 0 ? (
									<Line data={chartData} options={chartOptions} />
								) : (
									<div className="h-full flex items-center justify-center text-stats-muted text-sm">
										No time-series data available
									</div>
								)}
							</div>
						</AsyncBoundary>
					</Panel>
				</div>

				<div>
					<Panel title="Operational Feed" subtitle="Real-time request log">
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
														{formatRelativeTime(req.timestamp)}
													</div>
												</div>
												<div className="flex justify-between items-center text-xs stats-text-muted mt-0.5">
													<div>{req.provider}</div>
													<div>
														{req.duration ? formatDurationMs(req.duration) : ""}{" "}
														{req.usage?.cost?.total ? `· ${formatCost(req.usage.cost.total, 4)}` : ""}
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
									<div className="py-8 text-center stats-text-muted text-sm">No recent requests found</div>
								)}
							</div>
						</AsyncBoundary>
					</Panel>
				</div>
			</div>

			<Panel
				title="Recent Requests Preview"
				subtitle="Latest transactions processed by the proxy"
				actions={
					<a href={`#/requests?range=${range}`} className="stats-button stats-button-secondary text-xs">
						View All Requests
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
						emptyText="No recent requests found"
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
