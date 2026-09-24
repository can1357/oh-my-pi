import { useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { getGainDashboardStats } from "../api";
import { buildSharedPlugins, buildSharedScales, CHART_THEMES, lineDatasetStyle } from "../components/chart-shared";
import { formatBytes, formatCompact, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import type { GainDashboardStats, GainSourceTotals, GainTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary, Panel } from "../ui";
import { useSystemTheme } from "../useSystemTheme";

export interface GainRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function GainRoute({ active, range, refreshTrigger }: GainRouteProps) {
	const [project, setProject] = useState<string | null>(null);

	const {
		data: stats,
		error,
		loading,
	} = useResource(["gain", range, refreshTrigger, project], signal => getGainDashboardStats(range, project, signal), {
		pollMs: 30_000,
		enabled: active,
	});

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<GainProjectSelector projects={stats.projects} selected={project} onChange={setProject} />
						<GainOverallPanel overall={stats.overall} />
						<GainBySourcePanel bySource={stats.bySource} />
						<GainTimeSeriesPanel timeSeries={stats.timeSeries} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Project selector
// ---------------------------------------------------------------------------

function GainProjectSelector({
	projects,
	selected,
	onChange,
}: {
	projects: string[];
	selected: string | null;
	onChange: (p: string | null) => void;
}) {
	const { i18n } = useStatsI18n();
	if (projects.length === 0) return null;
	return (
		<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
			<span className="stats-text-secondary" style={{ fontSize: "0.875rem", whiteSpace: "nowrap" }}>
				{i18n.t("stats.gain.project")}
			</span>
			<select
				className="stats-select"
				value={selected ?? ""}
				onChange={e => onChange(e.target.value || null)}
				style={{ maxWidth: "480px", flex: 1 }}
			>
				<option value="">{i18n.t("stats.gain.allProjects")}</option>
				{projects.map(p => (
					<option key={p} value={p}>
						{p}
					</option>
				))}
			</select>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Overall metrics panel
// ---------------------------------------------------------------------------

function GainOverallPanel({ overall }: { overall: GainSourceTotals }) {
	const { i18n } = useStatsI18n();
	return (
		<Panel title={i18n.t("stats.gain.overall")} subtitle={i18n.t("stats.gain.overallSubtitle")}>
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.gain.savedTokens")}</div>
					<div className="stats-metric-value">{formatCompact(overall.savedTokens)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.gain.savedBytes")}</div>
					<div className="stats-metric-value">{formatBytes(overall.savedBytes)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.gain.reduction")}</div>
					<div className="stats-metric-value">
						{overall.reductionPercent !== null ? formatPercent(overall.reductionPercent) : "—"}
					</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{i18n.t("stats.gain.totalHits")}</div>
					<div className="stats-metric-value">{formatInteger(overall.hits)}</div>
				</div>
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// By-source breakdown panel
// ---------------------------------------------------------------------------

function SourceCard({ title, totals }: { title: string; totals: GainSourceTotals }) {
	const { i18n } = useStatsI18n();
	return (
		<div className="stats-metric-card secondary" style={{ flex: 1 }}>
			<div className="stats-metric-label" style={{ fontWeight: 600, marginBottom: 8 }}>
				{title}
			</div>
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
				<div>
					<div className="stats-metric-label">{i18n.t("stats.gain.savedTokens")}</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{formatCompact(totals.savedTokens)}
					</div>
				</div>
				<div>
					<div className="stats-metric-label">{i18n.t("stats.gain.savedBytes")}</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{formatBytes(totals.savedBytes)}
					</div>
				</div>
				<div>
					<div className="stats-metric-label">{i18n.t("stats.gain.hits")}</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{formatInteger(totals.hits)}
					</div>
				</div>
				<div>
					<div className="stats-metric-label">{i18n.t("stats.gain.reduction")}</div>
					<div className="stats-metric-value" style={{ fontSize: "1rem" }}>
						{totals.reductionPercent !== null ? formatPercent(totals.reductionPercent) : "—"}
					</div>
				</div>
			</div>
		</div>
	);
}

function GainBySourcePanel({ bySource }: { bySource: GainDashboardStats["bySource"] }) {
	const { i18n } = useStatsI18n();
	return (
		<Panel title={i18n.t("stats.gain.bySource")} subtitle={i18n.t("stats.gain.savingsBreakdown")}>
			<div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
				<SourceCard title="Snapcompact" totals={bySource.snapcompact} />
			</div>
		</Panel>
	);
}

// ---------------------------------------------------------------------------
// Time series chart (stacked area, daily)
// ---------------------------------------------------------------------------

const GAIN_COLORS = {
	snapcompact: "rgb(34, 197, 94)",
} as const;

function GainTimeSeriesPanel({ timeSeries }: { timeSeries: GainTimeSeriesPoint[] }) {
	const { i18n } = useStatsI18n();
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const { data, options } = useMemo(() => {
		const labels = timeSeries.map(p =>
			i18n.date(new Date(`${p.date}T00:00:00.000Z`), { month: "short", day: "numeric", timeZone: "UTC" }),
		);
		const chartData = {
			labels,
			datasets: [
				{
					label: "Snapcompact",
					data: timeSeries.map(p => p.snapcompact),
					...lineDatasetStyle(GAIN_COLORS.snapcompact),
				},
			],
		};

		const { sharedScaleBase, yScale } = buildSharedScales({
			chartTheme,
			formatY: n => formatCompact(n),
		});

		const chartOptions = {
			responsive: true,
			maintainAspectRatio: false,
			plugins: buildSharedPlugins({
				chartTheme,
				showLegend: true,
				defaultLabel: i18n.t("stats.gain.chartLabel"),
				formatValue: formatCompact,
			}),
			scales: {
				x: { ...sharedScaleBase, stacked: true },
				y: { ...yScale, stacked: true },
			},
		};

		return { data: chartData, options: chartOptions };
	}, [timeSeries, chartTheme, i18n]);

	return (
		<Panel title={i18n.t("stats.gain.savingsOverTime")} subtitle={i18n.t("stats.gain.dailySavings")}>
			<div style={{ height: 240 }}>
				{timeSeries.length === 0 ? (
					<div className="stats-table-empty">{i18n.t("stats.gain.noData")}</div>
				) : (
					<Line data={data} options={options as Parameters<typeof Line>[0]["options"]} />
				)}
			</div>
		</Panel>
	);
}
