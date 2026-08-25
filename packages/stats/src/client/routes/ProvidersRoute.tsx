import { useEffect, useMemo, useState } from "react";
import { getProviderDashboardStats } from "../api";
import { CHART_THEMES } from "../components/chart-shared";
import { formatCompact, formatEstimatedCost, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import { type ProviderSortKey, providerFailureTone, type SortDir, sortProviderRows } from "../data/view-models";
import type { ProviderAggregate, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface ProvidersRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

const SORT_KEY = "omp-stats:providers-sort";
type Stored = { key: ProviderSortKey; dir: SortDir };
function load(): Stored {
	try {
		const raw = sessionStorage.getItem(SORT_KEY);
		if (raw) return JSON.parse(raw) as Stored;
	} catch {}
	return { key: "requests", dir: "desc" };
}
function save(v: Stored) {
	try {
		sessionStorage.setItem(SORT_KEY, JSON.stringify(v));
	} catch {}
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
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Providers <span>{range} · operational</span>
					</h2>
					<span className="omp-hero-range">
						{stats
							? `${stats.providers.length} providers · ${formatInteger(stats.providers.reduce((s, p) => s + p.totalRequests, 0))} req`
							: "loading"}
					</span>
				</div>
				{stats && (
					<div className="omp-token-grid" style={{ marginTop: 4 }}>
						<div className="omp-token-item">
							<div className="omp-token-label">Top provider</div>
							<div className="omp-token-value" style={{ fontSize: 14 }}>
								{stats.providers[0]?.provider ?? "—"}
							</div>
							<div className="omp-token-bar">
								<div
									className="omp-token-bar-fill"
									style={{
										width: `${
											((stats.providers[0]?.totalRequests ?? 0) /
												Math.max(
													1,
													stats.providers.reduce((s, p) => s + p.totalRequests, 0),
												)) *
											100
										}%`,
										background: "var(--text)",
									}}
								/>
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Total tokens</div>
							<div className="omp-token-value">
								{formatCompact(stats.providers.reduce((s, p) => s + p.totalTokens, 0))}
							</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
								across all providers
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Est. cost</div>
							<div className="omp-token-value">
								{formatEstimatedCost(
									stats.providers.reduce((s, p) => s + p.totalCost, 0),
									stats.providers.reduce((s, p) => s + p.unpricedRequests, 0),
								)}
							</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
								api-equivalent
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Elevated failures</div>
							<div
								className="omp-token-value"
								style={{
									color: stats.providers.some(p => p.failedRequests / Math.max(1, p.totalRequests) >= 0.08)
										? "var(--danger)"
										: "var(--muted)",
								}}
							>
								{stats.providers.filter(p => p.failedRequests / Math.max(1, p.totalRequests) >= 0.03).length}
							</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--dim)" }}>
								providers ≥3% fail
							</div>
						</div>
					</div>
				)}
			</div>

			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && <ProviderRanked providers={stats.providers} range={range} />}
			</AsyncBoundary>
		</div>
	);
}

function ProviderRanked({ providers, range }: { providers: ProviderAggregate[]; range: TimeRange }) {
	const [sort, setSort] = useState<Stored>(() => load());
	const [expanded, setExpanded] = useState<string | null>(null);
	useEffect(() => save(sort), [sort]);

	const rows = useMemo(() => sortProviderRows(providers, sort.key, sort.dir), [providers, sort]);
	const totalRequests = useMemo(() => providers.reduce((s, p) => s + p.totalRequests, 0), [providers]);
	const toggle = (key: ProviderSortKey) =>
		setSort(prev => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
	const btn = (label: string, key: ProviderSortKey) => {
		const active = sort.key === key;
		return (
			<button type="button" data-active={active ? "true" : "false"} onClick={() => toggle(key)}>
				{label}
				<span style={{ fontSize: 10, opacity: active ? 1 : 0.35 }}>
					{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
				</span>
			</button>
		);
	};

	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Provider share</div>
					<p className="omp-section-desc">
						Operational list — share, cost, failures, cache, models. Elevated failure rows tint red/amber; normal
						providers stay quiet.
					</p>
				</div>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dim)" }}>
					{rows.length} providers
				</span>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div
					className="omp-ranked-head"
					style={{
						display: "grid",
						gridTemplateColumns: "22px minmax(0, 1.4fr) 84px 90px 90px 90px 70px 28px",
						gap: 10,
					}}
				>
					<span style={{ textAlign: "right" }}>#</span>
					<span>{btn("Provider", "provider")}</span>
					<span style={{ textAlign: "center" }}>Share</span>
					<span style={{ textAlign: "right" }}>{btn("Requests", "requests")}</span>
					<span style={{ textAlign: "right" }}>{btn("Est. cost", "cost")}</span>
					<span style={{ textAlign: "right" }}>{btn("Failures", "failure")}</span>
					<span style={{ textAlign: "right" }}>{btn("Cache", "cache")}</span>
					<span />
				</div>
				<div className="omp-ranked-list">
					{rows.map((p, idx) => {
						const rate = p.totalRequests > 0 ? p.failedRequests / p.totalRequests : 0;
						const tone = providerFailureTone(rate);
						const cacheRate = p.totalTokens > 0 ? p.totalCacheReadTokens / p.totalTokens : 0;
						const share = totalRequests > 0 ? p.totalRequests / totalRequests : 0;
						const isExpanded = expanded === p.provider;
						return (
							<div
								key={p.provider}
								className="omp-ranked-row omp-provider-row"
								data-tone={tone}
								data-expanded={isExpanded ? "true" : "false"}
								style={{ gridTemplateColumns: "22px minmax(0, 1.4fr) 84px 90px 90px 90px 70px 28px" }}
								role="button"
								tabIndex={0}
								onClick={() => setExpanded(isExpanded ? null : p.provider)}
								onKeyDown={e => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										setExpanded(isExpanded ? null : p.provider);
									}
								}}
							>
								<span className="omp-ranked-row-rank">{idx + 1}</span>
								<span className="omp-ranked-row-main">
									<span className="omp-ranked-row-title">{p.provider}</span>
									<span className="omp-ranked-row-sub">
										{p.models} model{p.models === 1 ? "" : "s"} · {formatCompact(p.totalTokens)} tok
									</span>
								</span>
								<span className="omp-ranked-bar">
									<span
										className="omp-ranked-bar-fill"
										style={{
											width: `${share * 100}%`,
											background:
												tone === "danger"
													? "var(--danger)"
													: tone === "warning"
														? "var(--amber)"
														: "var(--text)",
										}}
									/>
								</span>
								<span className="omp-ranked-metric">
									<strong>{formatInteger(p.totalRequests)}</strong>
									<small>{formatPercent(share, 1)}</small>
								</span>
								<span className="omp-ranked-metric">
									{formatEstimatedCost(p.totalCost, p.unpricedRequests, 2)}
								</span>
								<span
									className="omp-ranked-metric"
									style={{
										color:
											tone === "danger"
												? "var(--danger)"
												: tone === "warning"
													? "var(--amber)"
													: "var(--muted)",
									}}
								>
									{formatInteger(p.failedRequests)}
									<small>{formatPercent(rate, 1)}</small>
								</span>
								<span className="omp-ranked-metric">{formatPercent(cacheRate, 1)}</span>
								<button
									type="button"
									className="omp-ranked-expand"
									aria-label={isExpanded ? "Collapse" : "Expand"}
									onClick={e => {
										e.stopPropagation();
										setExpanded(isExpanded ? null : p.provider);
									}}
								>
									{isExpanded ? "−" : "+"}
								</button>

								{isExpanded && (
									<div className="omp-ranked-detail" onClick={e => e.stopPropagation()}>
										<div className="omp-ranked-detail-grid">
											<div>
												<div className="omp-ranked-detail-label">Tokens</div>
												<div className="omp-ranked-detail-value">{formatCompact(p.totalTokens)}</div>
												<div
													style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)" }}
												>
													in {formatCompact(p.totalInputTokens)} · out {formatCompact(p.totalOutputTokens)}
												</div>
											</div>
											<div>
												<div className="omp-ranked-detail-label">Cache</div>
												<div className="omp-ranked-detail-value">{formatPercent(cacheRate, 1)}</div>
												<div style={{ fontSize: 11, color: "var(--muted)" }}>
													{formatCompact(p.totalCacheReadTokens)} read
												</div>
											</div>
											<div>
												<div className="omp-ranked-detail-label">Latency</div>
												<div className="omp-ranked-detail-value">
													{p.avgTokensPerSecond ? `${p.avgTokensPerSecond.toFixed(1)} tok/s` : "—"}
												</div>
												<div style={{ fontSize: 11, color: "var(--muted)" }}>{p.models} models</div>
											</div>
											<div>
												<div className="omp-ranked-detail-label">Failures</div>
												<div
													className="omp-ranked-detail-value"
													style={{
														color:
															tone === "ok"
																? "var(--text)"
																: tone === "warning"
																	? "var(--amber)"
																	: "var(--danger)",
													}}
												>
													{formatPercent(rate, 2)}
												</div>
												<div style={{ fontSize: 11, color: "var(--muted)" }}>
													{formatInteger(p.failedRequests)} / {formatInteger(p.totalRequests)}
												</div>
											</div>
										</div>
										<ProviderMiniTrend provider={p.provider} range={range} />
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

function ProviderMiniTrend({ provider, range }: { provider: string; range: TimeRange }) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];
	// We don't have per-provider series loaded here; show placeholder that this would be per-provider trend if needed.
	// To keep data honest, we show a compact note instead of invented data.
	return (
		<div
			style={{
				fontFamily: "var(--font-mono)",
				fontSize: 11,
				color: "var(--dim)",
				paddingTop: 4,
				borderTop: "1px dashed var(--border)",
			}}
		>
			Provider <span style={{ color: "var(--text)" }}>{provider}</span> · window {range} · per-provider burn
			available via Overview trend. No extra mock series — honest placeholder.
		</div>
	);
}
