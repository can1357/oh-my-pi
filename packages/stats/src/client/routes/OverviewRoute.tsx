import { format } from "@oh-my-pi/pi-utils/dates";
import { useEffect, useMemo, useState } from "react";
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
	loadPrefs,
	nextPrefsOnToggle,
	type OverviewSectionKey,
	PRESET_DEFS,
	type PrefsState,
	type PresetId,
	prefsForPreset,
	SECTION_LABELS,
	SECTION_ORDER,
	STORAGE_KEY,
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
import { AsyncBoundary, DataTable, Panel, Skeleton, StatusPill } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

function useOverviewPrefs() {
	const [prefs, setPrefs] = useState<PrefsState>(() => loadPrefs());
	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
		} catch {
			// ignore quota
		}
	}, [prefs]);
	const setPreset = (id: PresetId) => setPrefs(prefsForPreset(id));
	const toggle = (key: OverviewSectionKey) => setPrefs(prev => nextPrefsOnToggle(prev, key));
	return { prefs, setPreset, toggle };
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
	const { prefs, setPreset, toggle } = useOverviewPrefs();

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
		const req = style?.getPropertyValue("--chart-req").trim() || "oklch(0.817 0.112 205)";
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
				borderWidth: 1.5,
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
						font: { size: 10, family: "ui-monospace" },
						maxRotation: 0,
						autoSkip: true,
						maxTicksLimit: 8,
					},
					border: { display: false },
				},
				y: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: { color: chartTheme.tick, font: { size: 10 } },
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

	const v = prefs.visible;

	return (
		<div className="stats-route-container space-y-4">
			{/* Range-aware subtitle + preset bar */}
			<div className="stats-overview-toolbar">
				<div className="flex items-center gap-2 flex-wrap">
					<span className="stats-panel-eyebrow" style={{ margin: 0 }}>
						Overview
					</span>
					<span
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: 11,
							color: "var(--muted)",
							background: "var(--surface)",
							border: "1px solid var(--border)",
							borderRadius: 2,
							padding: "3px 8px",
						}}
					>
						{range === "today" ? "today · since 00:00" : range}
					</span>
					{overview?.overall && (
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>
							· {formatInteger(overview.overall.totalRequests)} req
							{activeDays > 0 ? ` · ${activeDays} active day${activeDays === 1 ? "" : "s"}` : ""}
						</span>
					)}
				</div>

				<div className="flex items-center gap-2 flex-wrap">
					<div className="stats-preset-group" role="group" aria-label="Overview preset">
						{(Object.keys(PRESET_DEFS) as PresetId[]).map(pid => (
							<button
								key={pid}
								type="button"
								className="stats-preset-btn"
								data-active={prefs.preset === pid ? "true" : "false"}
								onClick={() => setPreset(pid)}
							>
								{PRESET_DEFS[pid].label}
							</button>
						))}
					</div>
					<details className="group" style={{ position: "relative" }}>
						<summary
							className="stats-button stats-button-ghost"
							style={{
								listStyle: "none",
								cursor: "pointer",
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								padding: "5px 10px",
							}}
						>
							Customize ▾
						</summary>
						<div
							className="stats-panel"
							style={{
								position: "absolute",
								right: 0,
								top: "calc(100% + 8px)",
								width: 260,
								zIndex: 5,
								boxShadow: "0 12px 32px rgba(0,0,0,0.28)",
							}}
						>
							<div className="stats-panel-header" style={{ padding: "10px 12px" }}>
								<span
									className="stats-panel-title"
									style={{
										fontSize: 11,
										fontFamily: "var(--font-mono)",
										letterSpacing: "0.06em",
										textTransform: "uppercase",
									}}
								>
									Visible sections
								</span>
							</div>
							<div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
								{SECTION_ORDER.map(key => (
									<label
										key={key}
										className="stats-customize-chip"
										data-on={v[key] ? "true" : "false"}
										style={{ justifyContent: "space-between", cursor: "pointer" }}
									>
										<span>{SECTION_LABELS[key]}</span>
										<input
											type="checkbox"
											checked={v[key]}
											onChange={() => toggle(key)}
											style={{ width: 14, height: 14 }}
										/>
									</label>
								))}
								<div
									style={{ fontSize: 11, color: "var(--dim)", fontFamily: "var(--font-mono)", marginTop: 4 }}
								>
									Persisted in localStorage · {STORAGE_KEY}
								</div>
							</div>
						</div>
					</details>
				</div>
			</div>

			{/* KPI Tape */}
			{v.tape && (
				<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
					{overview && (
						<div className="stats-overview-tape" role="region" aria-label="Key metrics">
							<div className="stats-tape-cell" style={{ ["--tape-accent" as string]: "var(--accent)" }}>
								<div className="stats-tape-label">Requests</div>
								<div className="stats-tape-value">{formatInteger(overview.overall.totalRequests)}</div>
								<div className="stats-tape-sub">
									{formatInteger(overview.overall.successfulRequests)} ok ·{" "}
									{formatInteger(overview.overall.failedRequests)} fail
								</div>
							</div>
							<div className="stats-tape-cell" style={{ ["--tape-accent" as string]: "var(--link)" }}>
								<div className="stats-tape-label">Conversation tokens</div>
								<div className="stats-tape-value">
									{formatCompact(
										overview.overall.totalInputTokens +
											overview.overall.totalOutputTokens +
											overview.overall.totalCacheReadTokens +
											overview.overall.totalCacheWriteTokens,
									)}
								</div>
								<div className="stats-tape-sub">
									in {formatCompact(overview.overall.totalInputTokens)} · out{" "}
									{formatCompact(overview.overall.totalOutputTokens)}
								</div>
							</div>
							<div className="stats-tape-cell" style={{ ["--tape-accent" as string]: "var(--amber)" }}>
								<div className="stats-tape-label">Est. cost</div>
								<div className="stats-tape-value" style={{ color: "var(--amber)" }}>
									{formatEstimatedCost(
										overview.overall.totalCost,
										overview.overall.unpricedRequests,
										overview.overall.totalCost > 0 && overview.overall.totalCost < 0.01 ? 4 : 2,
									)}
								</div>
								<div className="stats-tape-sub">
									{overview.overall.unpricedRequests > 0
										? `${overview.overall.unpricedRequests} unpriced`
										: "API-equivalent"}
								</div>
							</div>
							<div
								className="stats-tape-cell"
								style={{
									["--tape-accent" as string]:
										overview.overall.errorRate > 0.05 ? "var(--danger)" : "var(--success)",
								}}
							>
								<div className="stats-tape-label">Error rate</div>
								<div className="stats-tape-value">{formatPercent(overview.overall.errorRate)}</div>
								<div className="stats-tape-sub">
									<span
										className="stats-tape-badge"
										data-tone={overview.overall.errorRate > 0.05 ? "danger" : "success"}
									>
										{overview.overall.failedRequests} errors
									</span>
								</div>
							</div>
							<div className="stats-tape-cell" style={{ ["--tape-accent" as string]: "var(--success)" }}>
								<div className="stats-tape-label">Cache rate</div>
								<div className="stats-tape-value">{formatPercent(overview.overall.cacheRate)}</div>
								<div className="stats-tape-sub">savings {formatPercent(overview.overall.cacheSavings)}</div>
							</div>
							<div className="stats-tape-cell" style={{ ["--tape-accent" as string]: "var(--dim)" }}>
								<div className="stats-tape-label">Active days</div>
								<div className="stats-tape-value">{activeDays}</div>
								<div className="stats-tape-sub">
									{overview.timeSeries.length} buckets · {range === "today" ? "since midnight" : range}
								</div>
							</div>
						</div>
					)}
				</AsyncBoundary>
			)}

			{/* Scope row: oscilloscope chart + errors/feed */}
			<div className="stats-overview-grid">
				{v.scope && (
					<div className="stats-scope-wrap">
						<div className="stats-scope-grid" aria-hidden />
						<div className="stats-scope-header">
							<div className="stats-scope-title">
								<span className="stats-scope-dot" aria-hidden />
								Usage over time
								<span
									style={{
										fontFamily: "var(--font-mono)",
										fontSize: 11,
										color: "var(--muted)",
										fontWeight: 500,
									}}
								>
									{range === "today" ? "today" : range} · {timeSeries?.length ?? 0} buckets
								</span>
							</div>
							<div className="stats-scope-legend" aria-hidden>
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
						<div
							className="stats-scope-body"
							style={{
								flex: 1,
								minHeight: 272,
								maxHeight: 480,
								display: "flex",
								flexDirection: "column",
							}}
						>
							<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
								{timeSeries && timeSeries.length > 0 ? (
									<Line data={chartData as never} options={chartOptions as never} />
								) : (
									<div
										className="h-full flex items-center justify-center"
										style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}
									>
										No usage in selected period.
									</div>
								)}
							</AsyncBoundary>
						</div>
					</div>
				)}

				<div className="stats-overview-stack">
					{v.errors && (
						<Panel
							title="Recent errors"
							subtitle="Latest failures in this window"
							actions={
								<a
									href={`#/errors?range=${range}`}
									className="stats-button stats-button-secondary"
									style={{ fontSize: 11, padding: "5px 9px" }}
								>
									View all →
								</a>
							}
						>
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
													padding: "9px 10px",
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
									<div className="stats-empty-state-message">No usage in selected period.</div>
								)}
							</AsyncBoundary>
						</Panel>
					)}

					{/* Operational feed compact */}
					<Panel title="Live feed" subtitle="Newest requests">
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
					</Panel>
				</div>
			</div>

			{/* Token breakdown (4-way) */}
			{v.tokens && (
				<Panel
					title="Token breakdown"
					subtitle="Input · output · cache read · cache write — the conversation total"
					actions={
						<a
							href={`#/costs?range=${range}`}
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11 }}
						>
							Costs →
						</a>
					}
				>
					<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
						{overview ? (
							<TokenBreakdownPanel stats={overview.overall} />
						) : (
							<div className="stats-empty-state-message">No usage in selected period.</div>
						)}
					</AsyncBoundary>
				</Panel>
			)}

			{/* Agents */}
			{v.agents && (
				<Panel
					title="Token usage by agent"
					subtitle="Main · subagents · advisor — share of the displayed conversation total"
					actions={
						<a
							href={`#/models?range=${range}`}
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11 }}
						>
							Models →
						</a>
					}
				>
					<AsyncBoundary loading={overviewRes.loading} error={overviewRes.error} data={overview}>
						{overview && <AgentTokenShare stats={overview.byAgentType} />}
					</AsyncBoundary>
				</Panel>
			)}

			{/* Models — share bars + input/output splits */}
			{v.models && (
				<Panel
					title="Models"
					subtitle="Share of requests + token mix per model · click through for detail"
					actions={
						<a
							href={`#/models?range=${range}`}
							className="stats-button stats-button-secondary"
							style={{ fontSize: 11, padding: "5px 9px" }}
						>
							Open Models →
						</a>
					}
				>
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
				</Panel>
			)}

			{/* Providers + Tools side-by-side */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{v.providers && (
					<Panel
						title="Providers"
						subtitle="Cost and token share by provider"
						actions={
							<a
								href={`#/providers?range=${range}`}
								className="stats-button stats-button-ghost"
								style={{ fontSize: 11 }}
							>
								Providers →
							</a>
						}
					>
						<AsyncBoundary loading={providerRes.loading} error={providerRes.error} data={providerRes.data}>
							{providerRes.data && providerRes.data.providers.length > 0 ? (
								<ProvidersMini providers={providerRes.data.providers.slice(0, 4)} />
							) : (
								<div className="stats-empty-state-message">No usage in selected period.</div>
							)}
						</AsyncBoundary>
					</Panel>
				)}
				{v.tools && (
					<Panel
						title="Tools"
						subtitle="Calls and error share · subagent + advisor attributed to caller"
						actions={
							<a
								href={`#/tools?range=${range}`}
								className="stats-button stats-button-ghost"
								style={{ fontSize: 11 }}
							>
								Tools →
							</a>
						}
					>
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
					</Panel>
				)}
			</div>

			{/* Projects */}
			{v.projects && (
				<Panel
					title="Projects"
					subtitle="Requests per folder — where the agent spent its time"
					actions={
						<a
							href={`#/projects?range=${range}`}
							className="stats-button stats-button-ghost"
							style={{ fontSize: 11 }}
						>
							Projects →
						</a>
					}
				>
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
				</Panel>
			)}

			{/* Recent requests preview — tabular drilldown */}
			<Panel
				title="Recent requests"
				subtitle="Latest transactions · tap a row for detail"
				actions={
					<a
						href={`#/requests?range=${range}`}
						className="stats-button stats-button-secondary"
						style={{ fontSize: 11, padding: "5px 9px" }}
					>
						View all
					</a>
				}
			>
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
			</Panel>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-panels (pure, per-widget)
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
		<div className="stats-token-grid">
			{items.map(it => (
				<div key={it.label} className="stats-token-card">
					<div className="stats-token-card-label">{it.label}</div>
					<div className="stats-token-card-value">{formatCompact(it.value)}</div>
					<div className="stats-token-card-share">
						<div className="stats-token-bar">
							<div
								className="stats-token-bar-fill"
								style={{ width: `${it.share * 100}%`, background: it.color }}
							/>
						</div>
						<span className="stats-token-share-label">{formatPercent(it.share)}</span>
					</div>
				</div>
			))}
		</div>
	);
}

function ModelsMini({ models, totalRequests }: { models: ModelStats[]; totalRequests: number }) {
	return (
		<div style={{ display: "flex", flexDirection: "column" }}>
			{models.map((m, idx) => {
				const share = totalRequests > 0 ? m.totalRequests / totalRequests : 0;
				const tokens = m.totalInputTokens + m.totalOutputTokens + m.totalCacheReadTokens + m.totalCacheWriteTokens;
				return (
					<div key={`${m.model}-${m.provider}`} className="stats-model-row">
						<span className="stats-model-rank">{String(idx + 1).padStart(2, "0")}</span>
						<div className="stats-model-name">
							<div className="stats-model-title">{m.model}</div>
							<div className="stats-model-sub">{m.provider}</div>
						</div>
						<div className="stats-model-bar" title={`${formatPercent(share)} of requests`}>
							<div className="stats-model-bar-fill" style={{ width: `${share * 100}%` }} />
						</div>
						<span className="stats-model-metric">{formatPercent(share)}</span>
						<span className="stats-model-metric" title="Input · Output + cache">
							<span style={{ color: "var(--dim)" }}>{formatCompact(m.totalInputTokens)}</span>
							<span style={{ color: "var(--text)", marginLeft: 6 }}>{formatCompact(m.totalOutputTokens)}</span>
						</span>
						<span className="stats-model-metric" style={{ color: "var(--amber)", minWidth: 72 }}>
							{formatEstimatedCost(m.totalCost, m.unpricedRequests, 2)}
						</span>
						<span
							className="stats-model-metric"
							style={{ color: "var(--dim)", minWidth: 48 }}
							title="Conversation tokens"
						>
							{formatCompact(tokens)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function ProvidersMini({ providers }: { providers: ProviderAggregate[] }) {
	return (
		<div className="stats-provider-grid">
			{providers.map(p => {
				const tokens = p.totalTokens;
				const errorRate = p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0;
				return (
					<div key={p.provider} className="stats-provider-card">
						<div className="stats-provider-head">
							<span className="stats-provider-name">{p.provider}</span>
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
							<span>{formatCompact(tokens)} tok</span>
						</div>
						<div style={{ height: 4, borderRadius: 999, background: "var(--surface-3)", overflow: "hidden" }}>
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
		<div style={{ display: "flex", flexDirection: "column" }}>
			{tools.map(t => {
				const share = totalCalls > 0 ? t.calls / totalCalls : 0;
				const errorRate = t.calls > 0 ? t.errors / t.calls : 0;
				return (
					<div
						key={t.tool}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "9px 0",
							borderBottom: "1px solid var(--border)",
						}}
					>
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
								height: 4,
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
		<div style={{ display: "flex", flexDirection: "column" }}>
			{folders.map(f => {
				const share = totalRequests > 0 ? f.totalRequests / totalRequests : 0;
				const short = f.folder.split("/").pop() || f.folder;
				return (
					<div
						key={f.folder}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "8px 0",
							borderBottom: "1px solid var(--border)",
						}}
					>
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
								height: 4,
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
