import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getBehaviorDashboardStats } from "../api";
import { CHART_THEMES } from "../components/chart-shared";
import { formatInteger } from "../data/formatters";
import { useResource } from "../data/useResource";
import { buildBehaviorSummary } from "../data/view-models";
import type { BehaviorModelStats, BehaviorOverallStats, BehaviorTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface BehaviorRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function BehaviorRoute({ active, range, refreshTrigger }: BehaviorRouteProps) {
	const {
		data: stats,
		error,
		loading,
	} = useResource(["behavior", range, refreshTrigger], signal => getBehaviorDashboardStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	return (
		<div className="stats-route-container">
			<div className="omp-hero">
				<div className="omp-hero-head">
					<h2 className="omp-hero-title">
						Behavior <span>{range} · user-message telemetry</span>
					</h2>
					<span className="omp-hero-range">
						{stats
							? `${formatInteger(stats.overall.totalMessages)} messages · ${stats.byModel.length} models`
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
					OMP-specific signals from user messages — yelling, profanity, anguish, negation, repetition, blame. Not
					sentiment guesses; deterministic lexical heuristics surfaced per responding model so you see which
					contexts attract friction.
				</p>
			</div>

			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<BehaviorSummary overall={stats.overall} series={stats.behaviorSeries} />
						<BehaviorChart series={stats.behaviorSeries} />
						<BehaviorModels models={stats.byModel} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

function BehaviorSummary({ overall, series }: { overall: BehaviorOverallStats; series: BehaviorTimeSeriesPoint[] }) {
	const summary = useMemo(() => buildBehaviorSummary(overall, series), [overall, series]);
	const perMsg = (total: number) =>
		overall.totalMessages > 0 ? `${(total / overall.totalMessages).toFixed(2)} / msg` : undefined;
	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Overview</div>
					<p className="omp-section-desc">
						Counts are hits across all user messages in window. Highest-friction model surfaces where intervention
						may help.
					</p>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div className="omp-behavior-grid">
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Messages</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalMessages)}</div>
						<div className="omp-behavior-kpi-sub">{overall.totalChars.toLocaleString()} chars</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Yelling</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalYelling)}</div>
						<div className="omp-behavior-kpi-sub">{perMsg(overall.totalYelling)}</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Profanity</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalProfanity)}</div>
						<div className="omp-behavior-kpi-sub">{perMsg(overall.totalProfanity)}</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Anguish</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalAnguish)}</div>
						<div className="omp-behavior-kpi-sub">{perMsg(overall.totalAnguish)}</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Negation</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalNegation)}</div>
						<div className="omp-behavior-kpi-sub">{perMsg(overall.totalNegation)}</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Repetition</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalRepetition)}</div>
						<div className="omp-behavior-kpi-sub">{perMsg(overall.totalRepetition)}</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Blame</div>
						<div className="omp-behavior-kpi-value">{formatInteger(overall.totalBlame)}</div>
						<div className="omp-behavior-kpi-sub">{perMsg(overall.totalBlame)}</div>
					</div>
					<div className="omp-behavior-kpi">
						<div className="omp-behavior-kpi-label">Peak friction model</div>
						<div className="omp-behavior-kpi-value" style={{ fontSize: 13 }}>
							{summary.highestFrictionModel?.model ?? "—"}
						</div>
						<div className="omp-behavior-kpi-sub">
							{summary.highestFrictionModel
								? `${formatInteger(summary.highestFrictionModel.score)} hits`
								: "no data"}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

type Metric = "yelling" | "profanity" | "anguish" | "negation" | "repetition" | "blame";
const METRICS: { value: Metric; label: string }[] = [
	{ value: "yelling", label: "Yelling" },
	{ value: "profanity", label: "Profanity" },
	{ value: "anguish", label: "Anguish" },
	{ value: "negation", label: "Negation" },
	{ value: "repetition", label: "Repetition" },
	{ value: "blame", label: "Blame" },
];

function BehaviorChart({ series }: { series: BehaviorTimeSeriesPoint[] }) {
	const [metric, setMetric] = useState<Metric>("anguish");
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const bucketed = useMemo(() => {
		const map = new Map<number, number>();
		for (const p of series) {
			const v =
				metric === "yelling"
					? p.yelling
					: metric === "profanity"
						? p.profanity
						: metric === "anguish"
							? p.anguish
							: metric === "negation"
								? p.negation
								: metric === "repetition"
									? p.repetition
									: p.blame;
			map.set(p.timestamp, (map.get(p.timestamp) ?? 0) + v);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	}, [series, metric]);

	const data = useMemo(() => {
		const labels = bucketed.map(([ts]) =>
			new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
		);
		return {
			labels,
			datasets: [
				{
					label: metric,
					data: bucketed.map(([, v]) => v),
					borderColor: theme === "dark" ? "oklch(0.78 0.09 30)" : "oklch(0.55 0.12 30)",
					backgroundColor: theme === "dark" ? "oklch(0.78 0.09 30 / 0.08)" : "oklch(0.55 0.12 30 / 0.06)",
					tension: 0.3,
					borderWidth: 1.6,
					pointRadius: bucketed.length <= 12 ? 3 : 0,
					fill: true,
				},
			],
		};
	}, [bucketed, metric, theme]);

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
					ticks: { color: chartTheme.tick, font: { size: 10, family: "var(--font-mono)" } },
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
					<div className="omp-section-title">Signals over time</div>
					<p className="omp-section-desc">Daily buckets — pick a signal to see when friction rose.</p>
				</div>
				<div className="stats-segmented-control">
					{METRICS.map(m => (
						<button
							key={m.value}
							type="button"
							className="stats-segmented-control-btn"
							data-active={metric === m.value ? "true" : "false"}
							onClick={() => setMetric(m.value)}
						>
							{m.label}
						</button>
					))}
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div style={{ height: 220 }}>
					{bucketed.length === 0 ? (
						<div className="stats-table-empty">No behavior data in range.</div>
					) : (
						<Line data={data as never} options={options as never} />
					)}
				</div>
			</div>
		</div>
	);
}

function BehaviorModels({ models }: { models: BehaviorModelStats[] }) {
	const rows = useMemo(() => [...models].sort((a, b) => b.totalMessages - a.totalMessages), [models]);
	return (
		<div className="omp-section">
			<div className="omp-section-head">
				<div>
					<div className="omp-section-title">Per-model friction</div>
					<p className="omp-section-desc">
						Hits per responding model — helps isolate which model contexts attract user frustration.
					</p>
				</div>
			</div>
			<div className="omp-section-rule" />
			<div className="omp-section-body">
				<div className="omp-ranked-list">
					<div
						className="omp-ranked-head"
						style={{ display: "grid", gridTemplateColumns: "22px minmax(0, 1.6fr) repeat(6, 64px) 70px", gap: 8 }}
					>
						<span>#</span>
						<span>Model</span>
						<span style={{ textAlign: "right" }}>Msgs</span>
						<span style={{ textAlign: "right" }}>Yell</span>
						<span style={{ textAlign: "right" }}>Prof</span>
						<span style={{ textAlign: "right" }}>Angu</span>
						<span style={{ textAlign: "right" }}>Neg</span>
						<span style={{ textAlign: "right" }}>Rep</span>
						<span style={{ textAlign: "right" }}>Blame</span>
					</div>
					{rows.map((m, i) => (
						<div
							key={`${m.model}::${m.provider}`}
							className="omp-ranked-row"
							style={{ gridTemplateColumns: "22px minmax(0, 1.6fr) repeat(6, 64px) 70px", padding: "8px 0" }}
						>
							<span className="omp-ranked-row-rank">{i + 1}</span>
							<span className="omp-ranked-row-main">
								<span className="omp-ranked-row-title" style={{ fontSize: 12 }}>
									{m.model}
								</span>
								<span className="omp-ranked-row-sub">{m.provider}</span>
							</span>
							<span className="omp-ranked-metric">
								<strong>{formatInteger(m.totalMessages)}</strong>
							</span>
							<span className="omp-ranked-metric">{formatInteger(m.totalYelling)}</span>
							<span className="omp-ranked-metric">{formatInteger(m.totalProfanity)}</span>
							<span className="omp-ranked-metric">{formatInteger(m.totalAnguish)}</span>
							<span className="omp-ranked-metric">{formatInteger(m.totalNegation)}</span>
							<span className="omp-ranked-metric">{formatInteger(m.totalRepetition)}</span>
							<span className="omp-ranked-metric">{formatInteger(m.totalBlame)}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
