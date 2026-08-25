import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import { getGainDashboardStats } from "../api";
import { CHART_THEMES } from "../components/chart-shared";
import { formatBytes, formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import type { GainDashboardStats, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface GainRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function GainRoute({ active, range, refreshTrigger }: GainRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["gain", range, refreshTrigger], signal => getGainDashboardStats(range, null, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Gain <span>{range} · efficiency</span>
					</h2>
					<span className="omp-hero-range">
						{stats
							? `${formatInteger(stats.overall.hits)} hits · ${formatCompact(stats.overall.savedTokens)} tokens saved`
							: "loading"}
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
					First-class efficiency — only defensible “saved” numbers. Snapcompact savings are measured bytes not
					re-sent. Methodology below; no hand-wavy “estimated savings” without basis.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && <GainBody stats={stats} />}
			</AsyncBoundary>
		</div>
	);
}

function GainBody({ stats }: { stats: GainDashboardStats }) {
	return (
		<>
			<div className="omp-section">
				<div className="omp-section-head">
					<div>
						<div className="omp-section-title">Overall savings</div>
						<p className="omp-section-desc">
							Snapcompact — context compression that avoids re-sending unchanged prefix.
						</p>
					</div>
				</div>
				<div className="omp-section-rule" />
				<div className="omp-section-body">
					<div className="omp-token-grid">
						<div className="omp-token-item">
							<div className="omp-token-label">Saved tokens</div>
							<div className="omp-token-value">{formatCompact(stats.overall.savedTokens)}</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
								≈ {formatBytes(stats.overall.savedBytes)} not re-sent
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Hits</div>
							<div className="omp-token-value">{formatInteger(stats.overall.hits)}</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
								compactions that saved
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Reduction</div>
							<div className="omp-token-value">
								{stats.overall.reductionPercent !== null ? formatPercent(stats.overall.reductionPercent) : "—"}
							</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>
								saved vs original
							</div>
						</div>
						<div className="omp-token-item">
							<div className="omp-token-label">Avg saved / hit</div>
							<div className="omp-token-value">
								{stats.overall.hits
									? formatCompact(Math.round(stats.overall.savedTokens / stats.overall.hits))
									: "—"}
							</div>
							<div style={{ fontFamily: "var(--font-sans)", fontSize: 11, color: "var(--muted)" }}>tokens</div>
						</div>
					</div>

					<div className="omp-method" style={{ marginTop: 12 }}>
						<strong>Methodology:</strong> Snapcompact records are read from the session store; each record’s{" "}
						<span style={{ fontFamily: "var(--font-mono)" }}>savedTokens = originalTokens − compactedTokens</span>{" "}
						and <span style={{ fontFamily: "var(--font-mono)" }}>savedBytes = originalBytes − outputBytes</span>.
						“Reduction %” is <span style={{ fontFamily: "var(--font-mono)" }}>saved / original</span>. No
						model-pricing extrapolation; tokens are real tokenizer deltas.
					</div>
				</div>
			</div>

			<GainChart timeSeries={stats.timeSeries} />

			<GainProjects stats={stats} />
		</>
	);
}

function GainChart({ timeSeries }: { timeSeries: GainDashboardStats["timeSeries"] }) {
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const data = useMemo(() => {
		const labels = timeSeries.map(p => p.date);
		return {
			labels,
			datasets: [
				{
					label: "Saved tokens",
					data: timeSeries.map(p => p.snapcompact),
					borderColor: theme === "dark" ? "oklch(0.74 0.13 150)" : "oklch(0.55 0.13 150)",
					backgroundColor: theme === "dark" ? "oklch(0.74 0.13 150 / 0.08)" : "oklch(0.55 0.13 150 / 0.06)",
					tension: 0.32,
					borderWidth: 1.6,
					pointRadius: timeSeries.length <= 12 ? 3 : 0,
					fill: true,
				},
			],
		};
	}, [timeSeries, theme]);

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
						maxTicksLimit: 8,
						maxRotation: 0,
					},
					border: { display: false },
				},
				y: {
					grid: { color: chartTheme.grid, drawBorder: false },
					ticks: {
						color: chartTheme.tick,
						font: { size: 10, family: "var(--font-mono)" },
						callback: (v: number | string) => formatCompact(Number(v)),
					},
					min: 0,
					border: { display: false },
				},
			},
		}),
		[chartTheme],
	);

	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Savings over time</div>
					<p className="omp-section-desc">
						Daily buckets — snapcompact tokens saved per day. One source is enough to be honest.
					</p>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div style={{ height: 220 }}>
					{timeSeries.length === 0 ? (
						<div className="stats-table-empty">No savings yet</div>
					) : (
						<Line data={data as never} options={options as never} />
					)}
				</div>
			</div>
		</div>
	);
}

function GainProjects({ stats }: { stats: GainDashboardStats }) {
	if (!stats.projects || stats.projects.length === 0) return null;
	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Projects observed</div>
					<p className="omp-section-desc">
						Distinct project roots with snapcompact activity — filter via Gain API project param.
					</p>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					{stats.projects.slice(0, 12).map(p => (
						<div
							key={p}
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--muted)",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								borderBottom: "1px solid var(--border)",
								padding: "6px 0",
							}}
						>
							{p}
						</div>
					))}
				</div>
				<div className="omp-method" style={{ marginTop: 10 }}>
					<strong>Scope:</strong> Counts and savings respect the active time range and optional project filter. No
					cross-project double-counting — each compact record is attributed to the project that emitted it.
				</div>
			</div>
		</div>
	);
}
