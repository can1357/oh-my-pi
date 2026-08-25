import { format } from "@oh-my-pi/pi-utils/dates";
import { useEffect, useMemo, useRef, useState } from "react";
import { Line } from "react-chartjs-2";
import {
	getFolderStats,
	getModelDashboardStats,
	getOverviewStats,
	getProviderDashboardStats,
	getRecentErrors,
	getRecentRequests,
	getToolDashboardStats,
} from "../api";
import { AgentTokenShare } from "../components/AgentTokenShare";
import { CHART_THEMES } from "../components/chart-shared";
import { formatRangeTick } from "../components/range-meta";
import { formatCompact, formatDurationMs, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import {
	activeDaysFromSeries,
	createDashboard,
	DASHBOARD_STORAGE_KEY,
	type Dashboard,
	type DashboardState,
	deleteDashboard,
	duplicateDashboard,
	loadDashboardState,
	type OverviewSectionKey,
	renameDashboard,
	resetAllDashboards,
	resetDashboard,
	SECTION_LABELS,
	SECTION_ORDER,
	saveDashboardState,
	setActiveDashboard,
	updateDashboardVisible,
} from "../data/overview-prefs";
import { useResource } from "../data/useResource";
import type {
	AggregatedStats,
	FolderStats,
	MessageStats,
	ModelStats,
	ProviderAggregate,
	TimeRange,
	ToolUsageStats,
} from "../types";
import { AsyncBoundary, DataTable, Skeleton, StatusPill } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

function useDashboardPrefs() {
	const [state, setState] = useState(() => loadDashboardState());
	useEffect(() => {
		try {
			localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(state));
		} catch {}
		saveDashboardState(state);
	}, [state]);
	return { state, setState } as const;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface OverviewRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function OverviewRoute({ active, range, refreshTrigger, onRequestClick }: OverviewRouteProps) {
	const { state: dashState, setState: setDashState } = useDashboardPrefs();
	const activeDash = useMemo(
		() => dashState.dashboards.find(d => d.id === dashState.activeId) ?? dashState.dashboards[0],
		[dashState],
	);
	const v = activeDash.visible;
	const [newName, setNewName] = useState("");
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState("");

	const overviewRes = useResource(["overview", range, refreshTrigger], s => getOverviewStats(range, s), {
		enabled: active,
		pollMs: 30000,
	});
	const modelRes = useResource(["overview-models", range, refreshTrigger], s => getModelDashboardStats(range, s), {
		enabled: active,
		pollMs: 30000,
	});
	const providerRes = useResource(
		["overview-providers", range, refreshTrigger],
		s => getProviderDashboardStats(range, s),
		{ enabled: active, pollMs: 30000 },
	);
	const toolRes = useResource(["overview-tools", range, refreshTrigger], s => getToolDashboardStats(range, s), {
		enabled: active,
		pollMs: 30000,
	});
	const folderRes = useResource(["overview-folders", range, refreshTrigger], s => getFolderStats(range, s), {
		enabled: active,
		pollMs: 30000,
	});
	const errorsRes = useResource(["overview-errors", range, refreshTrigger], s => getRecentErrors(range, 8, s), {
		enabled: active,
		pollMs: 30000,
	});
	const recentRes = useResource(["recent-requests", refreshTrigger], s => getRecentRequests(12, s), {
		enabled: active,
		pollMs: 30000,
	});

	const overview = overviewRes.data;
	const timeSeries = overview?.timeSeries;
	const activeDays = useMemo(() => activeDaysFromSeries(timeSeries), [timeSeries]);
	const hasChartErrors = useMemo(() => !!timeSeries?.some(pt => pt.errors > 0), [timeSeries]);

	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const chartColors = useMemo(() => {
		const style =
			typeof document !== "undefined" ? getComputedStyle(document.body) : (null as unknown as CSSStyleDeclaration);
		const req = style?.getPropertyValue("--chart-req").trim() || "oklch(0.68 0.015 307)";
		const err = style?.getPropertyValue("--chart-err").trim() || "oklch(0.66 0.19 25)";
		return { req, err };
	}, [theme]);

	const chartData = useMemo(() => {
		if (!timeSeries) return { labels: [], datasets: [] as unknown[] };
		const labels = timeSeries.map(pt => formatRangeTick(pt.timestamp, range));
		const pointRadius = timeSeries.length <= 2 ? 3 : 0;
		const datasets: unknown[] = [
			{
				label: "Requests",
				data: timeSeries.map(pt => pt.requests),
				borderColor: chartColors.req,
				backgroundColor: `color-mix(in oklab, ${chartColors.req} 8%, transparent)`,
				tension: 0.32,
				borderWidth: 1.6,
				pointRadius,
				pointHoverRadius: 4,
				fill: true,
			},
		];
		if (hasChartErrors) {
			datasets.push({
				label: "Errors",
				data: timeSeries.map(pt => pt.errors),
				borderColor: chartColors.err,
				backgroundColor: `color-mix(in oklab, ${chartColors.err} 6%, transparent)`,
				tension: 0.32,
				borderWidth: 1,
				pointRadius,
				pointHoverRadius: 4,
				fill: false,
			});
		}
		return { labels, datasets };
	}, [timeSeries, range, chartColors, hasChartErrors]);

	const chartOptions = useMemo(
		() => ({
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: {
				legend: { display: false },
				tooltip: {
					backgroundColor: chartTheme.tooltipBackground,
					titleColor: chartTheme.tooltipTitle,
					bodyColor: chartTheme.tooltipBody,
					borderColor: chartTheme.tooltipBorder,
					borderWidth: 1,
					cornerRadius: 8,
					padding: 10,
					displayColors: true,
					callbacks: {
						title: (items: { label: string }[]) => items[0]?.label ?? "",
					},
				},
			},
			scales: {
				x: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: {
						color: chartTheme.tick,
						font: { size: 10, family: "var(--font-mono)" },
						maxRotation: 0,
						autoSkip: true,
						maxTicksLimit: 8,
					},
					border: { display: false },
				},
				y: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 10, family: "var(--font-mono)" } },
					min: 0,
					border: { display: false },
				},
			},
		}),
		[chartTheme],
	);

	const columns = useMemo(
		() => [
			{
				key: "model",
				header: "Model",
				render: (item: MessageStats) => (
					<div>
						<div className="stats-font-medium stats-text-primary" style={{ fontSize: 12.5 }}>
							{item.model}
						</div>
						<div
							className="stats-text-xs stats-text-muted"
							style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
						>
							{item.provider}
						</div>
					</div>
				),
			},
			{
				key: "timestamp",
				header: "Time",
				render: (item: MessageStats) => (
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
						{format(new Date(item.timestamp), "HH:mm:ss")}
					</span>
				),
			},
			{
				key: "tokens",
				header: "Tokens",
				numeric: true,
				render: (item: MessageStats) => (
					<span style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
						{formatInteger(item.usage.totalTokens)}
					</span>
				),
			},
			{
				key: "cost",
				header: "Est. cost",
				numeric: true,
				render: (item: MessageStats) => (
					<span
						style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--amber)" }}
					>
						{formatEstimatedCost(
							item.usage.cost.total,
							item.usage.cost.total === 0 && item.usage.totalTokens > 0 && item.provider === "xai-oauth" ? 1 : 0,
							4,
						)}
					</span>
				),
			},
			{
				key: "duration",
				header: "Latency",
				numeric: true,
				render: (item: MessageStats) => (
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatDurationMs(item.duration)}</span>
				),
			},
			{
				key: "status",
				header: "Status",
				className: "stats-text-center",
				render: (item: MessageStats) => (
					<StatusPill variant={item.errorMessage ? "danger" : "success"}>
						{item.errorMessage ? "Failed" : "OK"}
					</StatusPill>
				),
			},
		],
		[],
	);

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick} style={{ cursor: onClick ? "pointer" : undefined }}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary" style={{ fontSize: 13 }}>
						{item.model}
					</div>
					<div className="stats-text-xs stats-text-muted" style={{ fontFamily: "var(--font-mono)" }}>
						{item.provider}
					</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? "Failed" : "OK"}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">Time</div>
					<div className="stats-mobile-card-value">{format(new Date(item.timestamp), "MMM d, HH:mm")}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Cost</div>
					<div className="stats-mobile-card-value" style={{ color: "var(--amber)" }}>
						{formatEstimatedCost(item.usage.cost.total, 0, 4)}
					</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Tokens</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Latency</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.duration)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error truncate mt-2">{item.errorMessage}</div>}
		</div>
	);

	const previewRequests = useMemo(() => recentRes.data?.slice(0, 8) ?? [], [recentRes.data]);
	const showHealthBanner = (overview?.overall.errorRate ?? 0) > 0.05;
	const toggle = (key: OverviewSectionKey) => setDashState(s => updateDashboardVisible(s, activeDash.id, key));

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Overview <span>{range === "today" ? "today · since midnight" : range}</span>
					</h2>
					<span className="omp-hero-range">
						{overview?.overall
							? `${formatInteger(overview.overall.totalRequests)} req · ${activeDays} active day${activeDays === 1 ? "" : "s"} · ${overview.timeSeries.length} buckets`
							: `${range} · loading`}
					</span>
				</div>

				<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
					{overview && (
						<div className="omp-metrics-herd" role="region" aria-label="Key metrics">
							<div className="omp-kpi">
								<div className="omp-kpi-label">Requests</div>
								<div className="omp-kpi-value">{formatInteger(overview.overall.totalRequests)}</div>
								<div className="omp-kpi-sub">
									{formatInteger(overview.overall.successfulRequests)} ok ·{" "}
									{formatInteger(overview.overall.failedRequests)} fail
								</div>
								<div className="omp-kpi-accent" />
							</div>
							<div className="omp-kpi">
								<div className="omp-kpi-label">Conversation tokens</div>
								<div className="omp-kpi-value" data-mono="true">
									{formatCompact(
										overview.overall.totalInputTokens +
											overview.overall.totalOutputTokens +
											overview.overall.totalCacheReadTokens +
											overview.overall.totalCacheWriteTokens,
									)}
								</div>
								<div className="omp-kpi-sub">
									in {formatCompact(overview.overall.totalInputTokens)} · out{" "}
									{formatCompact(overview.overall.totalOutputTokens)}
								</div>
								<div className="omp-kpi-accent" />
							</div>
							<div className="omp-kpi">
								<div className="omp-kpi-label">Est. cost</div>
								<div className="omp-kpi-value" data-mono="true" style={{ color: "var(--amber)" }}>
									{formatEstimatedCost(
										overview.overall.totalCost,
										overview.overall.unpricedRequests,
										overview.overall.totalCost > 0 && overview.overall.totalCost < 0.01 ? 4 : 2,
									)}
								</div>
								<div className="omp-kpi-sub">
									{overview.overall.unpricedRequests > 0
										? `${overview.overall.unpricedRequests} unpriced`
										: "API-equivalent"}
								</div>
								<div className="omp-kpi-accent" />
							</div>
							<div className="omp-kpi" data-tone={overview.overall.errorRate > 0.05 ? "danger" : "success"}>
								<div className="omp-kpi-label">Error rate</div>
								<div className="omp-kpi-value" data-mono="true">
									{formatPercent(overview.overall.errorRate)}
								</div>
								<div className="omp-kpi-sub">
									{formatInteger(overview.overall.failedRequests)} errors ·{" "}
									{formatPercent(1 - overview.overall.errorRate)} ok
								</div>
								<div className="omp-kpi-accent" />
							</div>
							<div className="omp-kpi" data-tone="success">
								<div className="omp-kpi-label">Cache efficiency</div>
								<div className="omp-kpi-value" data-mono="true">
									{formatPercent(overview.overall.cacheRate)}
								</div>
								<div className="omp-kpi-sub">savings {formatPercent(overview.overall.cacheSavings)}</div>
								<div className="omp-kpi-accent" />
							</div>
						</div>
					)}
				</AsyncBoundary>

				{showHealthBanner && (
					<div
						style={{
							display: "flex",
							gap: 10,
							alignItems: "center",
							padding: "9px 12px",
							background: "color-mix(in oklch, var(--danger) 10%, var(--surface))",
							border: "1px solid color-mix(in oklch, var(--danger) 18%, transparent)",
							borderRadius: "var(--radius-md)",
							fontFamily: "var(--font-sans)",
							fontSize: 12,
							color: "var(--danger)",
						}}
					>
						<span
							style={{
								width: 7,
								height: 7,
								borderRadius: 999,
								background: "var(--danger)",
								display: "inline-block",
							}}
						/>
						Elevated error rate — {formatPercent(overview!.overall.errorRate)} ·{" "}
						{formatInteger(overview!.overall.failedRequests)} failures in this window.{" "}
						<a href="#/errors?range=today" style={{ color: "var(--danger)", textDecoration: "underline" }}>
							Inspect errors
						</a>
					</div>
				)}
			</div>

			<div className="omp-dashboard-bar" style={{ position: "relative" }}>
				<div className="omp-dashboard-tabs" role="tablist" aria-label="Dashboards">
					{dashState.dashboards.map(d => (
						<button
							key={d.id}
							type="button"
							role="tab"
							aria-selected={d.id === activeDash.id}
							className="omp-dashboard-tab"
							data-active={d.id === activeDash.id ? "true" : "false"}
							onClick={() => setDashState(s => setActiveDashboard(s, d.id))}
						>
							{d.name}
						</button>
					))}
				</div>
				<ManageDisclosure
					newName={newName}
					setNewName={setNewName}
					renaming={renaming}
					renameValue={renameValue}
					setRenameValue={setRenameValue}
					setRenaming={setRenaming}
					activeDash={activeDash}
					dashState={dashState}
					setDashState={setDashState}
					v={v}
					toggle={toggle}
				/>
			</div>

			{v.scope && (
				<div className="omp-scope-wrap">
					<div className="omp-scope-main">
						<div className="omp-scope-header">
							<div className="omp-scope-title">
								<span className="omp-scope-dot" aria-hidden />
								Usage over time{" "}
								<span
									style={{
										fontFamily: "var(--font-mono)",
										fontSize: 11,
										color: "var(--muted)",
										fontWeight: 400,
									}}
								>
									{range === "today" ? "today" : range} · {timeSeries?.length ?? 0} buckets
								</span>
							</div>
							<div className="omp-scope-legend" aria-hidden>
								<span>
									<i style={{ background: "var(--chart-req)" }} /> req
								</span>
								{hasChartErrors && (
									<span>
										<i style={{ background: "var(--chart-err)" }} /> err
									</span>
								)}
							</div>
						</div>
						<div className="omp-scope-body">
							<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
								{timeSeries && timeSeries.length > 0 ? (
									<Line data={chartData as never} options={chartOptions as never} />
								) : (
									<div
										style={{
											height: 220,
											display: "grid",
											placeItems: "center",
											color: "var(--muted)",
											fontFamily: "var(--font-mono)",
											fontSize: 12,
											border: "1px dashed var(--border)",
											borderRadius: "var(--radius-md)",
											background: "var(--surface-2)",
										}}
									>
										<div style={{ textAlign: "center" }}>
											<div
												style={{
													fontFamily: "var(--font-sans)",
													fontSize: 12,
													fontWeight: 600,
													color: "var(--text)",
												}}
											>
												No usage in this window
											</div>
											<div style={{ fontSize: 11, marginTop: 4 }}>
												Try a broader range or sync — this chart answers “when was OMP most active?”
											</div>
										</div>
									</div>
								)}
							</AsyncBoundary>
						</div>
					</div>
					<div className="omp-scope-side">
						{v.errors && (
							<div
								className="omp-section"
								style={{
									background: "var(--surface)",
									border: "1px solid var(--border)",
									borderRadius: "var(--radius-lg)",
									padding: 12,
								}}
							>
								<div className="omp-section-head">
									<div>
										<div className="omp-section-title">Health · Recent errors</div>
										<p className="omp-section-desc">Latest failures — only prominent when unhealthy</p>
									</div>
									<a
										href={`#/errors?range=${range}`}
										className="stats-button stats-button-secondary"
										style={{ fontSize: 11, padding: "5px 9px" }}
									>
										View all →
									</a>
								</div>
								<div className="omp-section-rule" />
								<div className="omp-section-body">
									<AsyncBoundary
										loading={errorsRes.loading}
										error={errorsRes.error}
										data={errorsRes.data}
										emptyText="No usage in selected period."
									>
										{errorsRes.data && errorsRes.data.length > 0 ? (
											<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
												{errorsRes.data.slice(0, 5).map(err => (
													<div
														key={err.id ?? `${err.sessionFile}-${err.entryId}`}
														onClick={() => err.id && onRequestClick(err.id)}
														style={{
															display: "flex",
															gap: 10,
															padding: "8px 10px",
															border: "1px solid var(--border)",
															borderRadius: "var(--radius-md)",
															background: "var(--surface-2)",
															cursor: err.id ? "pointer" : undefined,
														}}
													>
														<span
															style={{
																width: 7,
																height: 7,
																borderRadius: 999,
																background: "var(--danger)",
																marginTop: 6,
																flexShrink: 0,
															}}
														/>
														<div style={{ minWidth: 0, flex: 1 }}>
															<div
																style={{
																	fontSize: 12,
																	fontWeight: 600,
																	color: "var(--text)",
																	whiteSpace: "nowrap",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																}}
															>
																{err.model}
																<span
																	style={{
																		fontWeight: 400,
																		color: "var(--dim)",
																		fontFamily: "var(--font-mono)",
																		fontSize: 11,
																		marginLeft: 6,
																	}}
																>
																	{err.provider}
																</span>
															</div>
															<div
																style={{
																	fontSize: 11,
																	color: "var(--danger)",
																	fontFamily: "var(--font-mono)",
																	whiteSpace: "nowrap",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																	marginTop: 2,
																}}
																title={err.errorMessage ?? ""}
															>
																{err.errorMessage ?? "Unknown error"}
															</div>
															<div
																style={{
																	fontSize: 11,
																	color: "var(--dim)",
																	fontFamily: "var(--font-mono)",
																	marginTop: 2,
																}}
															>
																{format(new Date(err.timestamp), "MMM d, HH:mm")} ·{" "}
																{formatDurationMs(err.duration)}
															</div>
														</div>
													</div>
												))}
											</div>
										) : (
											<div className="stats-empty-state-message">
												No failures — system healthy in this window.
											</div>
										)}
									</AsyncBoundary>
								</div>
							</div>
						)}
						<div
							className="omp-section"
							style={{
								background: "var(--surface)",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-lg)",
								padding: 12,
							}}
						>
							<div className="omp-section-head">
								<div>
									<div className="omp-section-title">Live feed</div>
									<p className="omp-section-desc">Newest requests</p>
								</div>
							</div>
							<div className="omp-section-rule" />
							<div className="omp-section-body">
								<AsyncBoundary
									loading={recentRes.loading}
									error={recentRes.error}
									data={recentRes.data}
									fallback={
										<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
											{Array.from({ length: 4 }).map((_, i) => (
												<div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
													<Skeleton variant="circle" width={8} height={8} />
													<div style={{ flex: 1 }}>
														<Skeleton variant="text" width="60%" height={14} />
														<Skeleton variant="text" width="40%" height={10} />
													</div>
												</div>
											))}
										</div>
									}
								>
									<div style={{ display: "flex", flexDirection: "column" }}>
										{previewRequests.map(req => {
											const isError = !!req.errorMessage;
											return (
												<div
													key={req.id ?? `${req.sessionFile}-${req.entryId}`}
													onClick={() => req.id && onRequestClick(req.id)}
													style={{
														display: "flex",
														gap: 10,
														padding: "8px 2px",
														borderBottom: "1px solid var(--border)",
														cursor: req.id ? "pointer" : undefined,
													}}
												>
													<span
														style={{
															width: 6,
															height: 6,
															borderRadius: 999,
															background: isError ? "var(--danger)" : "var(--success)",
															marginTop: 7,
															flexShrink: 0,
														}}
													/>
													<div style={{ minWidth: 0, flex: 1 }}>
														<div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
															<span
																style={{
																	fontSize: 12,
																	fontWeight: 600,
																	color: "var(--text)",
																	whiteSpace: "nowrap",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																}}
															>
																{req.model}
															</span>
															<span
																style={{
																	fontFamily: "var(--font-mono)",
																	fontSize: 11,
																	color: "var(--dim)",
																	flexShrink: 0,
																}}
															>
																{format(new Date(req.timestamp), "HH:mm:ss")}
															</span>
														</div>
														<div
															style={{
																display: "flex",
																justifyContent: "space-between",
																gap: 8,
																fontSize: 11,
																color: "var(--muted)",
															}}
														>
															<span
																style={{
																	fontFamily: "var(--font-mono)",
																	whiteSpace: "nowrap",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																}}
															>
																{req.provider}
															</span>
															<span
																style={{
																	fontFamily: "var(--font-mono)",
																	fontVariantNumeric: "tabular-nums",
																	whiteSpace: "nowrap",
																}}
															>
																{req.usage.totalTokens > 0
																	? `${formatCompact(req.usage.totalTokens)} tok`
																	: ""}{" "}
																{req.usage.cost.total > 0
																	? `· ${formatEstimatedCost(req.usage.cost.total, 0, 2)}`
																	: ""}
															</span>
														</div>
													</div>
												</div>
											);
										})}
										{previewRequests.length === 0 && (
											<div className="stats-empty-state-message">No recent requests.</div>
										)}
									</div>
								</AsyncBoundary>
							</div>
						</div>
					</div>
				</div>
			)}

			{v.tokens && (
				<div className="omp-section">
					<div className="omp-section-head">
						<div>
							<div className="omp-section-title">Token breakdown</div>
							<p className="omp-section-desc">
								Input · output · cache read · cache write — the conversation total
							</p>
						</div>
						<a
							href={`#/costs?range=${range}`}
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11 }}
						>
							Costs →
						</a>
					</div>
					<div className="omp-section-rule" />
					<div className="omp-section-body">
						<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
							{overview ? (
								<TokenBreakdownPanel stats={overview.overall} />
							) : (
								<div className="stats-empty-state-message">No usage in selected period.</div>
							)}
						</AsyncBoundary>
					</div>
				</div>
			)}

			{v.agents && (
				<div className="omp-section">
					<div className="omp-section-head">
						<div>
							<div className="omp-section-title">Token usage by agent</div>
							<p className="omp-section-desc">
								Main · subagents · advisor — share of the displayed conversation total
							</p>
						</div>
						<a
							href={`#/models?range=${range}`}
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11 }}
						>
							Models →
						</a>
					</div>
					<div className="omp-section-rule" />
					<div className="omp-section-body">
						<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
							{overview && <AgentTokenShare stats={overview.byAgentType} />}
						</AsyncBoundary>
					</div>
				</div>
			)}

			{v.models && (
				<div className="omp-section">
					<div className="omp-section-head">
						<div>
							<div className="omp-section-title">Models — share of requests</div>
							<p className="omp-section-desc">
								Ranked by volume · input/output split · click through for detail
							</p>
						</div>
						<a
							href={`#/models?range=${range}`}
							className="stats-button stats-button-secondary"
							style={{ fontSize: 11, padding: "5px 9px" }}
						>
							Open Models →
						</a>
					</div>
					<div className="omp-section-rule" />
					<div className="omp-section-body">
						<AsyncBoundary loading={modelRes.loading} error={modelRes.error} data={modelRes.data}>
							{modelRes.data && modelRes.data.byModel.length > 0 ? (
								<ModelsMini
									models={modelRes.data.byModel.slice(0, 6)}
									totalRequests={overview?.overall.totalRequests ?? 0}
								/>
							) : (
								<div className="stats-empty-state-message">No usage in selected period.</div>
							)}
						</AsyncBoundary>
					</div>
				</div>
			)}

			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
				{v.providers && (
					<div
						className="omp-section"
						style={{
							background: "var(--surface)",
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-lg)",
							padding: 14,
						}}
					>
						<div className="omp-section-head">
							<div>
								<div className="omp-section-title">Providers</div>
								<p className="omp-section-desc">Cost and token share</p>
							</div>
							<a
								href={`#/providers?range=${range}`}
								className="stats-button stats-button-ghost"
								style={{ fontSize: 11 }}
							>
								Providers →
							</a>
						</div>
						<div className="omp-section-rule" />
						<div className="omp-section-body">
							<AsyncBoundary loading={providerRes.loading} error={providerRes.error} data={providerRes.data}>
								{providerRes.data && providerRes.data.providers.length > 0 ? (
									<ProvidersMini providers={providerRes.data.providers.slice(0, 4)} />
								) : (
									<div className="stats-empty-state-message">No usage in selected period.</div>
								)}
							</AsyncBoundary>
						</div>
					</div>
				)}
				{v.tools && (
					<div
						className="omp-section"
						style={{
							background: "var(--surface)",
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-lg)",
							padding: 14,
						}}
					>
						<div className="omp-section-head">
							<div>
								<div className="omp-section-title">Tools</div>
								<p className="omp-section-desc">Calls and error share</p>
							</div>
							<a
								href={`#/tools?range=${range}`}
								className="stats-button stats-button-ghost"
								style={{ fontSize: 11 }}
							>
								Tools →
							</a>
						</div>
						<div className="omp-section-rule" />
						<div className="omp-section-body">
							<AsyncBoundary loading={toolRes.loading} error={toolRes.error} data={toolRes.data}>
								{toolRes.data && toolRes.data.byTool.length > 0 ? (
									<ToolsMini
										tools={toolRes.data.byTool.slice(0, 5)}
										totalCalls={toolRes.data.byTool.reduce((s, t) => s + t.calls, 0)}
									/>
								) : (
									<div className="stats-empty-state-message">No usage in selected period.</div>
								)}
							</AsyncBoundary>
						</div>
					</div>
				)}
			</div>

			{v.projects && (
				<div className="omp-section">
					<div className="omp-section-head">
						<div>
							<div className="omp-section-title">Projects</div>
							<p className="omp-section-desc">Requests per folder — where the agent spent its time</p>
						</div>
						<a
							href={`#/projects?range=${range}`}
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11 }}
						>
							Projects →
						</a>
					</div>
					<div className="omp-section-rule" />
					<div className="omp-section-body">
						<AsyncBoundary loading={folderRes.loading} error={folderRes.error} data={folderRes.data}>
							{folderRes.data && folderRes.data.length > 0 ? (
								<ProjectsMini
									folders={folderRes.data.slice(0, 6)}
									totalRequests={overview?.overall.totalRequests ?? 0}
								/>
							) : (
								<div className="stats-empty-state-message">No usage in selected period.</div>
							)}
						</AsyncBoundary>
					</div>
				</div>
			)}

			<div
				className="omp-section"
				style={{
					background: "var(--surface)",
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-lg)",
					padding: 14,
				}}
			>
				<div className="omp-section-head">
					<div>
						<div className="omp-section-title">Recent requests</div>
						<p className="omp-section-desc">Latest transactions · tap a row for detail</p>
					</div>
					<a
						href={`#/requests?range=${range}`}
						className="stats-button stats-button-secondary"
						style={{ fontSize: 11, padding: "5px 9px" }}
					>
						View all
					</a>
				</div>
				<div className="omp-section-rule" />
				<div className="omp-section-body">
					<AsyncBoundary loading={recentRes.loading} error={recentRes.error} data={recentRes.data}>
						<DataTable
							columns={columns as never}
							data={previewRequests}
							keyExtractor={item => String(item.id ?? `${item.sessionFile}-${item.entryId}`)}
							onRowClick={item => item.id && onRequestClick(item.id)}
							renderMobileCard={renderMobileCard as never}
							emptyText="No usage in selected period."
						/>
					</AsyncBoundary>
				</div>
			</div>
		</div>
	);
}

function ManageDisclosure({
	newName,
	setNewName,
	renaming,
	renameValue,
	setRenameValue,
	setRenaming,
	activeDash,
	dashState,
	setDashState,
	v,
	toggle,
}: {
	newName: string;
	setNewName: (v: string) => void;
	renaming: boolean;
	renameValue: string;
	setRenameValue: (v: string) => void;
	setRenaming: (v: boolean) => void;
	activeDash: Dashboard;
	dashState: DashboardState;
	setDashState: React.Dispatch<React.SetStateAction<DashboardState>>;
	v: Record<OverviewSectionKey, boolean>;
	toggle: (k: OverviewSectionKey) => void;
}) {
	const [open, setOpen] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		const onClick = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mousedown", onClick);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onClick);
		};
	}, [open]);
	return (
		<div style={{ position: "relative" }} ref={panelRef}>
			<button
				type="button"
				className="stats-button stats-button-ghost"
				style={{ fontSize: 11, padding: "5px 9px", fontFamily: "var(--font-sans)" }}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen(o => !o)}
			>
				Manage ▾
			</button>
			{open && (
				<div
					role="dialog"
					aria-label="Manage dashboards"
					style={{
						position: "absolute",
						right: 0,
						top: "calc(100% + 8px)",
						width: 300,
						background: "var(--surface)",
						border: "1px solid var(--border-strong)",
						borderRadius: "var(--radius-md)",
						boxShadow: "0 16px 36px rgba(0,0,0,0.18)",
						zIndex: 10,
						padding: 10,
						display: "flex",
						flexDirection: "column",
						gap: 10,
					}}
				>
					<div style={{ display: "flex", gap: 6 }}>
						<input
							className="omp-dashboard-input"
							placeholder="New dashboard name"
							value={newName}
							onChange={e => setNewName(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter" && newName.trim()) {
									setDashState(s => createDashboard(s, newName.trim()));
									setNewName("");
								}
							}}
							style={{ flex: 1 }}
						/>
						<button
							type="button"
							className="stats-button stats-button-secondary"
							style={{ fontSize: 11, padding: "5px 8px" }}
							disabled={!newName.trim()}
							onClick={() => {
								if (newName.trim()) {
									setDashState(s => createDashboard(s, newName.trim()));
									setNewName("");
								}
							}}
						>
							Create
						</button>
					</div>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						<button
							type="button"
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11, padding: "5px 8px" }}
							onClick={() => setDashState(s => duplicateDashboard(s, activeDash.id))}
						>
							Duplicate
						</button>
						{renaming ? (
							<>
								<input
									className="omp-dashboard-input"
									value={renameValue}
									onChange={e => setRenameValue(e.target.value)}
									style={{ minWidth: 0, flex: 1 }}
								/>
								<button
									type="button"
									className="stats-button stats-button-secondary"
									style={{ fontSize: 11, padding: "5px 8px" }}
									onClick={() => {
										if (renameValue.trim())
											setDashState(s => renameDashboard(s, activeDash.id, renameValue.trim()));
										setRenaming(false);
									}}
								>
									Save
								</button>
								<button
									type="button"
									className="stats-button stats-button-ghost"
									style={{ fontSize: 11, padding: "5px 8px" }}
									onClick={() => setRenaming(false)}
								>
									Cancel
								</button>
							</>
						) : (
							<button
								type="button"
								className="stats-button stats-button-ghost"
								style={{ fontSize: 11, padding: "5px 8px" }}
								onClick={() => {
									setRenameValue(activeDash.name);
									setRenaming(true);
								}}
							>
								Rename
							</button>
						)}
						<button
							type="button"
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11, padding: "5px 8px" }}
							onClick={() => setDashState(s => resetDashboard(s, activeDash.id, "default"))}
						>
							Reset
						</button>
						<button
							type="button"
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11, padding: "5px 8px" }}
							onClick={() => setDashState(() => resetAllDashboards())}
						>
							Reset all
						</button>
						{dashState.dashboards.length > 1 && (
							<button
								type="button"
								className="stats-button stats-button-ghost"
								style={{ fontSize: 11, padding: "5px 8px", color: "var(--danger)" }}
								onClick={() => setDashState(s => deleteDashboard(s, activeDash.id))}
							>
								Delete
							</button>
						)}
					</div>
					<div style={{ height: 1, background: "var(--border)" }} />
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<div
							style={{
								fontFamily: "var(--font-sans)",
								fontSize: 11,
								fontWeight: 600,
								color: "var(--dim)",
								letterSpacing: "0.04em",
								textTransform: "uppercase",
							}}
						>
							Visible sections
						</div>
						{SECTION_ORDER.map(key => (
							<label
								key={key}
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "space-between",
									gap: 8,
									fontFamily: "var(--font-sans)",
									fontSize: 12,
									color: "var(--text)",
									cursor: "pointer",
								}}
							>
								<span>{SECTION_LABELS[key]}</span>
								<input
									type="checkbox"
									checked={!!v[key]}
									onChange={() => toggle(key as OverviewSectionKey)}
									style={{ accentColor: "var(--text)" }}
								/>
							</label>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function TokenBreakdownPanel({ stats }: { stats: AggregatedStats }) {
	const total =
		stats.totalInputTokens + stats.totalOutputTokens + stats.totalCacheReadTokens + stats.totalCacheWriteTokens;
	const items = [
		{
			label: "Input",
			value: stats.totalInputTokens,
			color: "var(--tok-input)",
			share: total ? stats.totalInputTokens / total : 0,
		},
		{
			label: "Output",
			value: stats.totalOutputTokens,
			color: "var(--tok-output)",
			share: total ? stats.totalOutputTokens / total : 0,
		},
		{
			label: "Cache read",
			value: stats.totalCacheReadTokens,
			color: "var(--tok-read)",
			share: total ? stats.totalCacheReadTokens / total : 0,
		},
		{
			label: "Cache write",
			value: stats.totalCacheWriteTokens,
			color: "var(--tok-write)",
			share: total ? stats.totalCacheWriteTokens / total : 0,
		},
	];
	return (
		<div className="omp-token-grid">
			{items.map(it => (
				<div key={it.label} className="omp-token-item">
					<div className="omp-token-label">{it.label}</div>
					<div className="omp-token-value">{formatCompact(it.value)}</div>
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<div className="omp-token-bar" style={{ flex: 1 }}>
							<div
								className="omp-token-bar-fill"
								style={{ width: `${it.share * 100}%`, background: it.color }}
							/>
						</div>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--muted)",
								fontVariantNumeric: "tabular-nums",
							}}
						>
							{formatPercent(it.share)}
						</span>
					</div>
				</div>
			))}
		</div>
	);
}

function ModelsMini({ models, totalRequests }: { models: ModelStats[]; totalRequests: number }) {
	return (
		<div className="omp-list">
			{models.map((m, idx) => {
				const share = totalRequests > 0 ? m.totalRequests / totalRequests : 0;
				return (
					<div key={`${m.model}-${m.provider}`} className="omp-row">
						<span className="omp-row-rank">{String(idx + 1).padStart(2, "0")}</span>
						<div className="omp-row-main">
							<div className="omp-row-title">{m.model}</div>
							<div className="omp-row-sub">{m.provider}</div>
						</div>
						<div className="omp-row-bar" title={`${formatPercent(share)} of requests`}>
							<div className="omp-row-bar-fill" style={{ width: `${share * 100}%` }} />
						</div>
						<span className="omp-row-metric">{formatPercent(share)}</span>
						<span className="omp-row-metric" title="Input · Output">
							<span style={{ color: "var(--dim)" }}>{formatCompact(m.totalInputTokens)}</span>
							<span style={{ color: "var(--text)", marginLeft: 6 }}>{formatCompact(m.totalOutputTokens)}</span>
						</span>
						<span className="omp-row-metric" style={{ color: "var(--amber)", minWidth: 72 }}>
							{formatEstimatedCost(m.totalCost, m.unpricedRequests, 2)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function ProvidersMini({ providers }: { providers: ProviderAggregate[] }) {
	return (
		<div className="omp-provider-grid">
			{providers.map(p => {
				const errorRate = p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0;
				return (
					<div key={p.provider} className="omp-provider-item">
						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
							<span className="omp-provider-name">{p.provider}</span>
							<span
								className="stats-status-pill"
								data-variant={errorRate > 0.05 ? "danger" : "success"}
								style={{ fontSize: 10 }}
							>
								{formatPercent(errorRate)} err
							</span>
						</div>
						<div
							style={{
								display: "flex",
								gap: 10,
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--muted)",
								fontVariantNumeric: "tabular-nums",
							}}
						>
							<span>{formatInteger(p.totalRequests)} req</span>
							<span>{formatCompact(p.totalTokens)} tok</span>
						</div>
						<div style={{ height: 3, borderRadius: 999, background: "var(--surface-3)", overflow: "hidden" }}>
							<div style={{ width: "100%", height: "100%", background: "var(--link)", opacity: 0.9 }} />
						</div>
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								alignItems: "center",
								fontFamily: "var(--font-mono)",
								fontSize: 11,
							}}
						>
							<span style={{ color: "var(--amber)", fontWeight: 700 }}>
								{formatEstimatedCost(p.totalCost, p.unpricedRequests, 2)}
							</span>
							<span style={{ color: "var(--dim)" }}>
								{formatCompact(p.totalInputTokens)} in · {formatCompact(p.totalOutputTokens)} out
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function ToolsMini({ tools, totalCalls }: { tools: ToolUsageStats[]; totalCalls: number }) {
	return (
		<div className="omp-list">
			{tools.map(t => {
				const share = totalCalls > 0 ? t.calls / totalCalls : 0;
				const errorRate = t.calls > 0 ? t.errors / t.calls : 0;
				return (
					<div key={t.tool} className="omp-row">
						<span
							style={{
								fontSize: 12,
								fontWeight: 600,
								color: "var(--text)",
								minWidth: 0,
								flex: 1,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							{t.tool}
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--muted)",
								minWidth: 52,
								textAlign: "right",
							}}
						>
							{formatInteger(t.calls)} calls
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: errorRate > 0 ? "var(--danger)" : "var(--dim)",
								minWidth: 44,
								textAlign: "right",
							}}
						>
							{formatPercent(errorRate)}
						</span>
						<div
							style={{
								width: 64,
								height: 3,
								borderRadius: 999,
								background: "var(--surface-3)",
								overflow: "hidden",
								flexShrink: 0,
							}}
						>
							<div
								style={{
									width: `${share * 100}%`,
									height: "100%",
									background: "var(--accent)",
									borderRadius: 999,
								}}
							/>
						</div>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--amber)",
								minWidth: 56,
								textAlign: "right",
								fontVariantNumeric: "tabular-nums",
							}}
						>
							{formatEstimatedCost(t.costShare, 0, 2)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function ProjectsMini({ folders, totalRequests }: { folders: FolderStats[]; totalRequests: number }) {
	return (
		<div className="omp-list">
			{folders.map(f => {
				const share = totalRequests > 0 ? f.totalRequests / totalRequests : 0;
				const short = f.folder.split("/").pop() || f.folder;
				return (
					<div key={f.folder} className="omp-row">
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 10,
								color: "var(--dim)",
								width: 22,
								textAlign: "right",
							}}
						>
							{formatPercent(share, 0)}
						</span>
						<div
							style={{
								width: 72,
								height: 3,
								borderRadius: 999,
								background: "var(--surface-3)",
								overflow: "hidden",
								flexShrink: 0,
							}}
						>
							<div
								style={{
									width: `${share * 100}%`,
									height: "100%",
									background: "var(--link)",
									borderRadius: 999,
								}}
							/>
						</div>
						<span
							title={f.folder}
							style={{
								fontSize: 12,
								fontWeight: 500,
								color: "var(--text)",
								flex: 1,
								minWidth: 0,
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
							}}
						>
							{short}
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--muted)",
								minWidth: 48,
								textAlign: "right",
							}}
						>
							{formatInteger(f.totalRequests)} req
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--amber)",
								minWidth: 56,
								textAlign: "right",
							}}
						>
							{formatEstimatedCost(f.totalCost, f.unpricedRequests, 2)}
						</span>
					</div>
				);
			})}
		</div>
	);
}
