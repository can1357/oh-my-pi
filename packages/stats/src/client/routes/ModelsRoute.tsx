import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getModelDashboardStats } from "../api";
import { CHART_THEMES } from "../components/chart-shared";
import { formatRangeTick } from "../components/range-meta";
import { formatCompact, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import { buildModelRows, type ModelSortKey, type SortDir, sortModelRows } from "../data/view-models";
import type { ModelStats, ModelTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface ModelsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

const SORT_STORAGE_KEY = "omp-stats:models-sort";
type StoredSort = { key: ModelSortKey; dir: SortDir };

function loadSort(): StoredSort {
	try {
		const raw = sessionStorage.getItem(SORT_STORAGE_KEY);
		if (raw) return JSON.parse(raw) as StoredSort;
	} catch {}
	return { key: "requests", dir: "desc" };
}

function saveSort(v: StoredSort) {
	try {
		sessionStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(v));
	} catch {}
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

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Models <span>{range} · ranked by share</span>
					</h2>
					<span className="omp-hero-range">
						{modelStats
							? `${modelStats.byModel.length} models · ${formatInteger(modelStats.byModel.reduce((s, m) => s + m.totalRequests, 0))} requests`
							: "loading"}
					</span>
				</div>
				{modelStats && modelStats.byModel.length > 0 && (
					<div className="omp-token-grid" style={{ marginTop: 4 }}>
						<div className="omp-token-item">
							<div className="omp-token-label">Top model share</div>
							<div className="omp-token-value">
								{formatPercent(
									modelStats.byModel[0].totalRequests /
										modelStats.byModel.reduce((s, m) => s + m.totalRequests, 0),
								)}
							</div>
							<div className="omp-token-bar">
								<div
									className="omp-token-bar-fill"
									style={{
										width: `${(modelStats.byModel[0].totalRequests / modelStats.byModel.reduce((s, m) => s + m.totalRequests, 0)) * 100}%`,
										background: "var(--text)",
									}}
								/>
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Total tokens</div>
							<div className="omp-token-value">
								{formatCompact(
									modelStats.byModel.reduce(
										(s, m) =>
											s +
											m.totalInputTokens +
											m.totalOutputTokens +
											m.totalCacheReadTokens +
											m.totalCacheWriteTokens,
										0,
									),
								)}
							</div>
							<div className="omp-token-label" style={{ textTransform: "none", letterSpacing: "0" }}>
								in {formatCompact(modelStats.byModel.reduce((s, m) => s + m.totalInputTokens, 0))} · out{" "}
								{formatCompact(modelStats.byModel.reduce((s, m) => s + m.totalOutputTokens, 0))}
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Est. cost</div>
							<div className="omp-token-value">
								{formatEstimatedCost(
									modelStats.byModel.reduce((s, m) => s + m.totalCost, 0),
									modelStats.byModel.reduce((s, m) => s + m.unpricedRequests, 0),
								)}
							</div>
							<div className="omp-token-label" style={{ textTransform: "none", letterSpacing: "0" }}>
								api-equivalent · excludes unpriced
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Avg cache hit</div>
							<div className="omp-token-value">
								{formatPercent(
									modelStats.byModel.reduce((s, m) => s + m.cacheRate * m.totalRequests, 0) /
										Math.max(
											1,
											modelStats.byModel.reduce((s, m) => s + m.totalRequests, 0),
										),
								)}
							</div>
							<div className="omp-token-label" style={{ textTransform: "none", letterSpacing: "0" }}>
								prompt cache · weighted
							</div>
						</div>
					</div>
				)}
			</div>

			<AsyncBoundary loading={loading} error={error} data={modelStats}>
				{modelStats && (
					<ModelsRanked byModel={modelStats.byModel} modelSeries={modelStats.modelSeries} timeRange={range} />
				)}
			</AsyncBoundary>
		</div>
	);
}

function ModelsRanked({
	byModel,
	modelSeries,
	timeRange,
}: {
	byModel: ModelStats[];
	modelSeries: ModelTimeSeriesPoint[];
	timeRange: TimeRange;
}) {
	const [sort, setSort] = useState<StoredSort>(() => loadSort());
	const [expanded, setExpanded] = useState<string | null>(null);
	useEffect(() => saveSort(sort), [sort]);

	const rows = useMemo(() => {
		const base = buildModelRows(byModel);
		return sortModelRows(base, sort.key, sort.dir);
	}, [byModel, sort]);

	const toggle = (key: ModelSortKey) => {
		setSort(prev => {
			if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
			return { key, dir: "desc" };
		});
	};

	const headerBtn = (label: string, key: ModelSortKey, alignRight = true) => {
		const active = sort.key === key;
		return (
			<button
				type="button"
				data-active={active ? "true" : "false"}
				onClick={() => toggle(key)}
				style={{ justifyContent: alignRight ? "flex-end" : "flex-start" }}
			>
				{label}
				<span aria-hidden style={{ fontSize: 10, opacity: active ? 1 : 0.35 }}>
					{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
				</span>
			</button>
		);
	};

	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Ranked models</div>
					<p className="omp-section-desc">
						Click a row for usage-over-time, cost and error detail — mono values, share bars encode dominance
						without extra cards.
					</p>
				</div>
				<div className="omp-error-controls" style={{ fontSize: 11 }}>
					<span style={{ fontFamily: "var(--font-mono)", color: "var(--dim)" }}>{rows.length} models</span>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div
					className="omp-ranked-head"
					style={{
						display: "grid",
						gridTemplateColumns: "22px minmax(0, 1.6fr) 84px repeat(4, 82px) minmax(0, 0.8fr) 28px",
						gap: 10,
					}}
					role="row"
				>
					<span style={{ textAlign: "right" }}>#</span>
					<span>{headerBtn("Model", "model", false)}</span>
					<span style={{ textAlign: "center" }}>Share</span>
					<span style={{ textAlign: "right" }}>{headerBtn("Requests", "requests")}</span>
					<span style={{ textAlign: "right" }}>{headerBtn("Tokens", "tokens")}</span>
					<span style={{ textAlign: "right" }}>{headerBtn("Est. cost", "cost")}</span>
					<span style={{ textAlign: "right" }}>{headerBtn("Cache", "cache")}</span>
					<span className="omp-ranked-hide-sm" style={{ textAlign: "right" }}>
						{headerBtn("Errors", "errorRate")}
					</span>
					<span />
				</div>

				<div className="omp-ranked-list">
					{rows.map((m, idx) => {
						const key = `${m.model}::${m.provider}`;
						const isExpanded = expanded === key;
						const totalTokens = m.totalTokens;
						return (
							<div
								key={key}
								className="omp-ranked-row"
								data-expanded={isExpanded ? "true" : "false"}
								role="button"
								tabIndex={0}
								onClick={() => setExpanded(isExpanded ? null : key)}
								onKeyDown={e => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setExpanded(isExpanded ? null : key);
									}
								}}
							>
								<span className="omp-ranked-row-rank">{idx + 1}</span>
								<span className="omp-ranked-row-main">
									<span className="omp-ranked-row-title" title={m.model}>
										{m.model}
									</span>
									<span className="omp-ranked-row-sub">{m.provider}</span>
								</span>
								<span className="omp-ranked-bar" aria-hidden>
									<span className="omp-ranked-bar-fill" style={{ width: `${m.share * 100}%` }} />
								</span>
								<span className="omp-ranked-metric">
									<strong>{formatInteger(m.totalRequests)}</strong>
									<small>{formatPercent(m.share, 1)} share</small>
								</span>
								<span className="omp-ranked-metric">
									<strong>{formatCompact(totalTokens)}</strong>
									<small>
										{formatCompact(m.totalInputTokens)}/{formatCompact(m.totalOutputTokens)}
									</small>
								</span>
								<span className="omp-ranked-metric">
									{formatEstimatedCost(m.totalCost, m.unpricedRequests, 2)}
								</span>
								<span className="omp-ranked-metric">{formatPercent(m.cacheRate)}</span>
								<span
									className="omp-ranked-metric omp-ranked-hide-sm"
									style={{
										color:
											m.errorRate > 0.05
												? "var(--danger)"
												: m.errorRate > 0
													? "var(--amber)"
													: "var(--muted)",
									}}
								>
									{formatPercent(m.errorRate, 1)}
								</span>
								<button
									type="button"
									className="omp-ranked-expand"
									aria-label={isExpanded ? "Collapse" : "Expand"}
									onClick={e => {
										e.stopPropagation();
										setExpanded(isExpanded ? null : key);
									}}
								>
									{isExpanded ? "−" : "+"}
								</button>

								{isExpanded && (
									<div className="omp-ranked-detail" onClick={e => e.stopPropagation()}>
										<div className="omp-ranked-detail-grid">
											<div>
												<div className="omp-ranked-detail-label">Requests</div>
												<div className="omp-ranked-detail-value">{formatInteger(m.totalRequests)}</div>
												<div style={{ fontSize: 11, color: "var(--muted)" }}>
													{formatInteger(m.successfulRequests)} ok · {formatInteger(m.failedRequests)} fail
													· {formatPercent(m.errorRate)} error
												</div>
											</div>
											<div>
												<div className="omp-ranked-detail-label">Tokens · in / out</div>
												<div className="omp-ranked-detail-value">{formatCompact(totalTokens)}</div>
												<div
													style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}
												>
													in {formatCompact(m.totalInputTokens)} · out {formatCompact(m.totalOutputTokens)}{" "}
													· cache {formatCompact(m.totalCacheReadTokens)}
												</div>
											</div>
											<div>
												<div className="omp-ranked-detail-label">Est. cost</div>
												<div className="omp-ranked-detail-value">
													{formatEstimatedCost(m.totalCost, m.unpricedRequests, 4)}
												</div>
												<div style={{ fontSize: 11, color: "var(--muted)" }}>
													{m.avgDuration ? `${(m.avgDuration / 1000).toFixed(2)}s avg` : "no latency"} ·{" "}
													{m.avgTokensPerSecond ? `${m.avgTokensPerSecond.toFixed(1)} tok/s` : ""}
												</div>
											</div>
											<div>
												<div className="omp-ranked-detail-label">Provider</div>
												<div className="omp-ranked-detail-value" style={{ fontSize: 12 }}>
													{m.provider}
												</div>
												<div style={{ fontSize: 11, color: "var(--muted)" }}>
													cache {formatPercent(m.cacheRate)} · savings {formatPercent(m.cacheSavings)}
												</div>
											</div>
										</div>
										<ModelSpark
											model={m.model}
											provider={m.provider}
											series={modelSeries}
											timeRange={timeRange}
										/>
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function ModelSpark({
	model,
	provider,
	series,
	timeRange,
}: {
	model: string;
	provider: string;
	series: ModelTimeSeriesPoint[];
	timeRange: TimeRange;
}) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	const filtered = useMemo(
		() => series.filter(s => s.model === model && s.provider === provider).sort((a, b) => a.timestamp - b.timestamp),
		[series, model, provider],
	);
	const data = useMemo(() => {
		const labels = filtered.map(p => formatRangeTick(p.timestamp, timeRange));
		return {
			labels,
			datasets: [
				{
					label: "Requests",
					data: filtered.map(p => p.requests),
					borderColor: theme === "dark" ? "oklch(0.85 0.02 307)" : "oklch(0.35 0.02 307)",
					backgroundColor: theme === "dark" ? "oklch(0.85 0.02 307 / 0.08)" : "oklch(0.35 0.02 307 / 0.06)",
					tension: 0.32,
					borderWidth: 1.6,
					pointRadius: filtered.length <= 8 ? 3 : 0,
					pointHoverRadius: 4,
					fill: true,
				},
			],
		};
	}, [filtered, timeRange, theme]);

	const options = useMemo(
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
					padding: 8,
				},
			},
			scales: {
				x: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: {
						color: chartTheme.tick,
						font: { size: 10, family: "var(--font-mono)" },
						maxTicksLimit: 6,
						maxRotation: 0,
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

	if (filtered.length === 0) {
		return (
			<div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", padding: "8px 0" }}>
				No time-series for this model in range.
			</div>
		);
	}
	return (
		<div>
			<div
				style={{
					fontFamily: "var(--font-sans)",
					fontSize: 11,
					fontWeight: 600,
					color: "var(--text)",
					marginBottom: 6,
				}}
			>
				Usage over time · {filtered.length} buckets
			</div>
			<div style={{ height: 140 }}>
				<Line data={data as never} options={options as never} />
			</div>
		</div>
	);
}
