import type { I18n } from "@oh-my-pi/pi-i18n";
import { useMemo, useState } from "react";
import { Bar, Line } from "react-chartjs-2";
import { getBehaviorDashboardStats } from "../api";
import {
	barDatasetStyle,
	buildAggregateTimeSeries,
	buildSharedPlugins,
	buildSharedScales,
	buildTopNByModelSeries,
	CHART_THEMES,
	lineDatasetStyle,
	MODEL_COLORS,
	styleDatasets,
} from "../components/chart-shared";
import {
	DetailChartEmpty,
	detailChartPlugins,
	detailChartScalesSingleAxis,
	ExpandableModelRow,
	lineSeriesStyle,
	MiniSparkline,
	ModelNameCell,
	ModelTableBody,
	ModelTableHeader,
	ModelTableShell,
	TABLE_CHART_THEMES,
	type TableChartTheme,
	TrendEmpty,
} from "../components/models-table-shared";
import { formatInteger } from "../data/formatters";
import { useResource } from "../data/useResource";
import { useStatsI18n } from "../i18n";
import { buildBehaviorSummary } from "../data/view-models";
import type { BehaviorModelStats, BehaviorOverallStats, BehaviorTimeSeriesPoint, TimeRange } from "../types";
import { AsyncBoundary, Panel, SegmentedControl } from "../ui";
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
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<BehaviorSummaryPanel overall={stats.overall} behaviorSeries={stats.behaviorSeries} />
						<BehaviorChartPanel behaviorSeries={stats.behaviorSeries} />
						<BehaviorModelsTable models={stats.byModel} behaviorSeries={stats.behaviorSeries} />
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}

function perMsg(total: number, messages: number): string | undefined {
	if (messages <= 0) return undefined;
	return `${(total / messages).toFixed(2)} / msg`;
}

function BehaviorSummaryPanel({
	overall,
	behaviorSeries,
}: {
	overall: BehaviorOverallStats;
	behaviorSeries: BehaviorTimeSeriesPoint[];
}) {
	const { i18n } = useStatsI18n();
	const summary = useMemo(() => buildBehaviorSummary(overall, behaviorSeries), [overall, behaviorSeries]);
	const messages = overall.totalMessages;

	const cards = [
		{
			label: i18n.t("stats.behavior.userMessages"),
			value: formatInteger(overall.totalMessages),
			sub: messages > 0 ? i18n.t("stats.behavior.inRange") : undefined,
		},
		{
			label: i18n.t("stats.behavior.yelling"),
			value: formatInteger(overall.totalYelling),
			sub: perMsg(overall.totalYelling, messages)
				? `${(overall.totalYelling / messages).toFixed(2)}${i18n.t("stats.behavior.perMessage")}`
				: undefined,
		},
		{
			label: `${i18n.t("stats.behavior.profane")} ${i18n.t("stats.behavior.hits")}`,
			value: formatInteger(overall.totalProfanity),
			sub: perMsg(overall.totalProfanity, messages)
				? `${(overall.totalProfanity / messages).toFixed(2)}${i18n.t("stats.behavior.perMessage")}`
				: undefined,
		},
		{
			label: `${i18n.t("stats.behavior.anguish")} ${i18n.t("stats.behavior.signals")}`,
			value: formatInteger(overall.totalAnguish),
			sub: perMsg(overall.totalAnguish, messages)
				? `${(overall.totalAnguish / messages).toFixed(2)}${i18n.t("stats.behavior.perMessage")}`
				: undefined,
		},
		{
			label: i18n.t("stats.behavior.friction"),
			value: formatInteger(summary.totalFrustration),
			sub: perMsg(summary.totalFrustration, messages)
				? `${(summary.totalFrustration / messages).toFixed(2)}${i18n.t("stats.behavior.perMessage")}`
				: undefined,
		},
		{
			label: i18n.t("stats.behavior.highestFrictionModel"),
			value: summary.highestFrictionModel?.model ?? "—",
			sub: summary.highestFrictionModel
				? `${formatInteger(summary.highestFrictionModel.score)} ${i18n.t("stats.behavior.hits")}`
				: undefined,
		},
	];

	return (
		<div className="grid grid-cols-2 md:grid-cols-6 gap-4">
			{cards.map(card => (
				<Panel key={card.label} className="stats-behavior-summary-card py-3 px-4">
					<p className="text-xs stats-text-muted mb-1 font-medium truncate">{card.label}</p>
					<p className="text-lg font-bold stats-text-primary truncate" title={card.value}>
						{card.value}
					</p>
					{card.sub && <p className="text-xs stats-text-muted mt-0.5">{card.sub}</p>}
				</Panel>
			))}
		</div>
	);
}

const METRIC_OPTIONS = [
	{ value: "yelling", label: "CAPS", title: "Yelling (CAPS)" },
	{ value: "profanity", label: "Profanity", title: "Profanity" },
	{ value: "anguish", label: "Anguish", title: "Anguish (!!!, nooo, ugh, dude, ':(')" },
	{ value: "negation", label: "Negation", title: "Negation (no/nope/wrong, makes no sense)" },
	{
		value: "repetition",
		label: "Repetition",
		title: "Repetition (i meant, still doesnt)",
	},
	{ value: "blame", label: "Blame", title: "Blame (you didnt, why did you, stop X-ing)" },
	{
		value: "frustration",
		label: "Frustration",
		title: "Frustration (neg + rep + blame)",
	},
	{ value: "total", label: "All", title: "All signals combined" },
] as const;

type Metric = (typeof METRIC_OPTIONS)[number]["value"];

function metricLabel(i18n: I18n, metric: Metric): string {
	switch (metric) {
		case "yelling":
			return i18n.t("stats.behavior.caps");
		case "profanity":
			return i18n.t("stats.behavior.profane");
		case "anguish":
			return i18n.t("stats.behavior.anguish");
		case "negation":
			return i18n.t("stats.behavior.negation");
		case "repetition":
			return i18n.t("stats.behavior.repetition");
		case "blame":
			return i18n.t("stats.behavior.blame");
		case "frustration":
			return i18n.t("stats.behavior.frustration");
		case "total":
			return i18n.t("stats.behavior.all");
	}
}

function metricTitle(i18n: I18n, metric: Metric): string {
	switch (metric) {
		case "yelling":
			return i18n.t("stats.behavior.capsTitle");
		case "profanity":
			return i18n.t("stats.behavior.profaneTitle");
		case "anguish":
			return i18n.t("stats.behavior.anguishTitle");
		case "negation":
			return i18n.t("stats.behavior.negationTitle");
		case "repetition":
			return i18n.t("stats.behavior.repetition");
		case "blame":
			return i18n.t("stats.behavior.blameTitle");
		case "frustration":
			return i18n.t("stats.behavior.frustrationTitle");
		case "total":
			return i18n.t("stats.behavior.allSignals");
	}
}

function formatRateAxis(value: number): string {
	if (!Number.isFinite(value)) return "-";
	if (value === 0) return "0%";
	if (Math.abs(value) < 1) return `${value.toFixed(1)}%`;
	return `${value.toFixed(0)}%`;
}

function pointHits(point: BehaviorTimeSeriesPoint, metric: Metric): number {
	if (metric === "frustration") {
		return point.negation + point.repetition + point.blame;
	}
	if (metric === "total") {
		return point.yelling + point.profanity + point.anguish + point.negation + point.repetition + point.blame;
	}
	return point[metric];
}

function ratePercent(hits: number, messages: number): number {
	if (messages <= 0) return 0;
	return (hits / messages) * 100;
}

interface DailyBucket {
	hits: number;
	messages: number;
}

function BehaviorChartPanel({ behaviorSeries }: { behaviorSeries: BehaviorTimeSeriesPoint[] }) {
	const { i18n } = useStatsI18n();
	const [byModel, setByModel] = useState(false);
	const [metric, setMetric] = useState<Metric>("total");
	const theme = useSystemTheme();
	const chartTheme = CHART_THEMES[theme];

	const chartData = useMemo(() => {
		if (byModel) {
			return buildTopNByModelSeries<BehaviorTimeSeriesPoint, DailyBucket>(behaviorSeries, {
				rankWeight: point => point.messages,
				initBucket: () => ({ hits: 0, messages: 0 }),
				accumulate: (bucket, point) => {
					bucket.hits += pointHits(point, metric);
					bucket.messages += point.messages;
				},
				bucketToValue: bucket => ratePercent(bucket.hits, bucket.messages),
			});
		}
		return buildAggregateTimeSeries<BehaviorTimeSeriesPoint, DailyBucket>(behaviorSeries, metricTitle(i18n, metric), {
			initBucket: () => ({ hits: 0, messages: 0 }),
			accumulate: (bucket, point) => {
				bucket.hits += pointHits(point, metric);
				bucket.messages += point.messages;
			},
			bucketToValue: bucket => ratePercent(bucket.hits, bucket.messages),
		});
	}, [behaviorSeries, byModel, metric, i18n]);

	const sharedPlugins = useMemo(() => {
		return buildSharedPlugins({
			chartTheme,
			showLegend: byModel,
			defaultLabel: i18n.t("stats.behavior.hits"),
			formatValue: formatRateAxis,
		});
	}, [chartTheme, byModel, i18n]);

	const { sharedScaleBase, yScale } = useMemo(() => {
		return buildSharedScales({ chartTheme, formatY: formatRateAxis });
	}, [chartTheme]);

	const metricLabelText = metricTitle(i18n, metric);

	const lineData = useMemo(() => {
		if (!byModel) return null;
		return {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => lineDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};
	}, [chartData, byModel]);

	const lineOptions = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: sharedPlugins,
			scales: { x: sharedScaleBase, y: yScale },
		};
	}, [sharedPlugins, sharedScaleBase, yScale]);

	const barData = useMemo(() => {
		if (byModel) return null;
		return {
			labels: chartData.labels,
			datasets: styleDatasets(chartData, i => barDatasetStyle(MODEL_COLORS[i % MODEL_COLORS.length])),
		};
	}, [chartData, byModel]);

	const barOptions = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index" as const, intersect: false },
			plugins: sharedPlugins,
			scales: {
				x: { ...sharedScaleBase, stacked: true },
				y: { ...yScale, stacked: true },
			},
			layout: { padding: { top: 8 } },
		};
	}, [sharedPlugins, sharedScaleBase, yScale]);

	const byModelOptions = [
		{ value: false, label: i18n.t("stats.behavior.allModels") },
		{ value: true, label: i18n.t("stats.behavior.byModel") },
	];
	const metricOptions = METRIC_OPTIONS.map(option => ({
		value: option.value,
		label: metricLabel(i18n, option.value),
		title: metricTitle(i18n, option.value),
	}));

	return (
		<Panel
			title={i18n.t("stats.behavior.signals")}
			subtitle={i18n.t("stats.behavior.frictionSubtitle", { metric: metricLabelText })}
			actions={
				<div className="flex items-center gap-3 flex-wrap">
					<SegmentedControl options={metricOptions} value={metric} onChange={setMetric} />
					<SegmentedControl options={byModelOptions} value={byModel} onChange={setByModel} />
				</div>
			}
		>
			<div className="h-[300px]">
				{chartData.labels.length === 0 ? (
					<div className="h-full flex items-center justify-center text-stats-muted text-sm">
						{i18n.t("stats.behavior.noData")}
					</div>
				) : byModel && lineData ? (
					<Line data={lineData} options={lineOptions} />
				) : barData ? (
					<Bar data={barData} options={barOptions} />
				) : null}
			</div>
		</Panel>
	);
}

const TABLE_GRID_TEMPLATE = "2fr 0.9fr 0.8fr 0.8fr 0.8fr 0.9fr 0.8fr 140px 40px";

function totalHitRate(model: BehaviorModelStats): number {
	if (model.totalMessages === 0) return 0;
	const hits =
		model.totalYelling +
		model.totalProfanity +
		model.totalAnguish +
		model.totalNegation +
		model.totalRepetition +
		model.totalBlame;
	return hits / model.totalMessages;
}

function formatRate(total: number, messages: number): string {
	if (messages === 0) return "-";
	const pct = (total / messages) * 100;
	if (pct === 0) return "0%";
	if (pct < 1) return `${pct.toFixed(1)}%`;
	return `${pct.toFixed(0)}%`;
}

function BehaviorModelsTable({
	models,
	behaviorSeries,
}: {
	models: BehaviorModelStats[];
	behaviorSeries: BehaviorTimeSeriesPoint[];
}) {
	const { i18n } = useStatsI18n();
	const [expandedKey, setExpandedKey] = useState<string | null>(null);
	const theme = useSystemTheme();
	const chartTheme = TABLE_CHART_THEMES[theme];

	const trendByKey = useMemo(() => buildTrendLookup(behaviorSeries), [behaviorSeries]);

	const sortedModels = useMemo(() => {
		return [...models].sort((a, b) => {
			if (b.totalMessages !== a.totalMessages) {
				return b.totalMessages - a.totalMessages;
			}
			return totalHitRate(b) - totalHitRate(a);
		});
	}, [models]);

	return (
		<ModelTableShell
			title={i18n.t("stats.behavior.behaviorByModel")}
			subtitle={i18n.t("stats.behavior.behaviorByModelSubtitle")}
		>
			<ModelTableHeader
				gridTemplate={TABLE_GRID_TEMPLATE}
				columns={[
					{ label: i18n.t("stats.table.model") },
					{ label: i18n.t("stats.behavior.messages"), align: "right" },
					{ label: i18n.t("stats.behavior.capsPercent"), align: "right" },
					{ label: i18n.t("stats.behavior.profanityPercent"), align: "right" },
					{ label: i18n.t("stats.behavior.anguishPercent"), align: "right" },
					{ label: i18n.t("stats.behavior.frustrationPercent"), align: "right" },
					{ label: i18n.t("stats.behavior.hitsPercent"), align: "right" },
					{ label: i18n.t("stats.behavior.trend"), align: "center" },
				]}
			/>

			<ModelTableBody>
				{sortedModels.map((model, index) => {
					const key = `${model.model}::${model.provider}`;
					const trend = trendByKey.get(key)?.data ?? [];
					const trendColor = MODEL_COLORS[index % MODEL_COLORS.length];
					const isExpanded = expandedKey === key;
					const totalFrustration = model.totalNegation + model.totalRepetition + model.totalBlame;
					const totalHits = model.totalYelling + model.totalProfanity + model.totalAnguish + totalFrustration;

					return (
						<ExpandableModelRow
							key={key}
							gridTemplate={TABLE_GRID_TEMPLATE}
							isExpanded={isExpanded}
							onToggle={() => setExpandedKey(isExpanded ? null : key)}
							cells={[
								<ModelNameCell key="name" model={model.model} provider={model.provider} />,
								<div key="messages" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatInteger(model.totalMessages)}
								</div>,
								<div key="caps" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(model.totalYelling, model.totalMessages)}
								</div>,
								<div key="profanity" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(model.totalProfanity, model.totalMessages)}
								</div>,
								<div key="anguish" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(model.totalAnguish, model.totalMessages)}
								</div>,
								<div key="frustration" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(totalFrustration, model.totalMessages)}
								</div>,
								<div key="hits" className="text-right text-[var(--text-secondary)] font-mono text-sm">
									{formatRate(totalHits, model.totalMessages)}
								</div>,
							]}
							trendCell={
								trend.length === 0 ? (
									<TrendEmpty />
								) : (
									<MiniSparkline
										timestamps={trend.map(d => d.timestamp)}
										values={trend.map(d => d.total)}
										color={trendColor}
										locale={i18n.locale}
									/>
								)
							}
							expandedContent={
								<div className="grid gap-4" style={{ gridTemplateColumns: "220px 1fr" }}>
									<div className="space-y-4 text-sm">
										<DetailRow
											label={i18n.t("stats.behavior.yelling")}
											total={model.totalYelling}
											messages={model.totalMessages}
											valueClass="text-[#ed4abf]"
										/>
										<DetailRow
											label={i18n.t("stats.behavior.profane")}
											total={model.totalProfanity}
											messages={model.totalMessages}
											valueClass="text-[#ff6b7d]"
										/>
										<DetailRow
											label={i18n.t("stats.behavior.anguishTitle")}
											total={model.totalAnguish}
											messages={model.totalMessages}
											valueClass="text-[#9b4dff]"
										/>
										<DetailRow
											label={i18n.t("stats.behavior.negationTitle")}
											total={model.totalNegation}
											messages={model.totalMessages}
											valueClass="text-[#5ad8e6]"
										/>
										<DetailRow
											label={i18n.t("stats.behavior.repetition")}
											total={model.totalRepetition}
											messages={model.totalMessages}
											valueClass="text-[#5ad8e6]"
										/>
										<DetailRow
											label={i18n.t("stats.behavior.blameTitle")}
											total={model.totalBlame}
											messages={model.totalMessages}
											valueClass="text-[#5ad8e6]"
										/>
										<DetailRow
											label={i18n.t("stats.metrics.avgLatency")}
											total={model.totalChars}
											messages={model.totalMessages}
											valueClass="stats-text-secondary"
											mode="average"
										/>
									</div>
									<div className="h-[200px]">
										{trend.length === 0 ? (
											<DetailChartEmpty />
										) : (
											<BreakdownChart data={trend} chartTheme={chartTheme} />
										)}
									</div>
								</div>
							}
						/>
					);
				})}
				{sortedModels.length === 0 ? (
					<div className="border-t border-[var(--border-subtle)] px-5 py-8 text-center text-[var(--text-muted)] text-sm">
						{i18n.t("stats.behavior.noRecorded")}
					</div>
				) : null}
			</ModelTableBody>
		</ModelTableShell>
	);
}

function DetailRow({
	label,
	total,
	messages,
	valueClass,
	mode = "rate",
}: {
	label: string;
	total: number;
	messages: number;
	valueClass: string;
	mode?: "rate" | "average";
}) {
	const { i18n } = useStatsI18n();
	const perMsgLabel = mode === "rate" ? i18n.t("stats.behavior.perMessages") : i18n.t("stats.behavior.perMsg");
	const perMsgValue = useMemo(() => {
		if (messages === 0) return "-";
		return mode === "rate" ? formatRate(total, messages) : (total / messages).toFixed(0);
	}, [total, messages, mode]);

	return (
		<div>
			<div className="text-[var(--text-primary)] font-medium mb-1">{label}</div>
			<div className="space-y-0.5 text-[var(--text-secondary)]">
				<div className="flex items-center justify-between">
					<span className="stats-text-muted text-xs">{i18n.t("stats.behavior.total")}</span>
					<span className={`font-mono text-xs ${valueClass}`}>{formatInteger(total)}</span>
				</div>
				<div className="flex items-center justify-between">
					<span className="stats-text-muted text-xs">{perMsgLabel}</span>
					<span className="font-mono text-xs stats-text-primary">{perMsgValue}</span>
				</div>
			</div>
		</div>
	);
}

const SERIES_COLORS = {
	yelling: "#ed4abf", // brand pink
	profanity: "#ff6b7d", // rose
	anguish: "#9b4dff", // brand violet
	frustration: "#5ad8e6", // brand cyan
} as const;

function BreakdownChart({ data, chartTheme }: { data: DailyPoint[]; chartTheme: TableChartTheme }) {
	const { i18n } = useStatsI18n();
	const chartData = useMemo(() => {
		return {
			labels: data.map(d => i18n.date(d.timestamp, { month: "short", day: "numeric" })),
			datasets: [
				{
					label: "CAPS",
					data: data.map(d => d.yelling),
					...lineSeriesStyle(SERIES_COLORS.yelling),
				},
				{
					label: "Profanity",
					data: data.map(d => d.profanity),
					...lineSeriesStyle(SERIES_COLORS.profanity),
				},
				{
					label: "Anguish",
					data: data.map(d => d.anguish),
					...lineSeriesStyle(SERIES_COLORS.anguish),
				},
				{
					label: "Frustration",
					data: data.map(d => d.frustration),
					...lineSeriesStyle(SERIES_COLORS.frustration),
				},
			],
		};
	}, [data, i18n]);

	const options = useMemo(() => {
		return {
			responsive: true,
			maintainAspectRatio: false,
			plugins: detailChartPlugins(chartTheme),
			scales: detailChartScalesSingleAxis(chartTheme),
		};
	}, [chartTheme]);

	return <Line data={chartData} options={options} />;
}

interface DailyPoint {
	timestamp: number;
	yelling: number;
	profanity: number;
	anguish: number;
	frustration: number;
	total: number;
}

interface ModelTrendSeries {
	data: DailyPoint[];
}

function buildTrendLookup(points: BehaviorTimeSeriesPoint[]): Map<string, ModelTrendSeries> {
	if (points.length === 0) return new Map();

	const allDays = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);
	const byKey = new Map<string, Map<number, DailyPoint>>();

	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		let dayMap = byKey.get(key);
		if (!dayMap) {
			dayMap = new Map();
			byKey.set(key, dayMap);
		}
		const existing = dayMap.get(point.timestamp) ?? {
			timestamp: point.timestamp,
			yelling: 0,
			profanity: 0,
			anguish: 0,
			frustration: 0,
			total: 0,
		};
		existing.yelling += point.yelling;
		existing.profanity += point.profanity;
		existing.anguish += point.anguish;
		existing.frustration += point.negation + point.repetition + point.blame;
		existing.total = existing.yelling + existing.profanity + existing.anguish + existing.frustration;
		dayMap.set(point.timestamp, existing);
	}

	const out = new Map<string, ModelTrendSeries>();
	for (const [key, dayMap] of byKey) {
		const data = allDays.map(
			ts =>
				dayMap.get(ts) ?? {
					timestamp: ts,
					yelling: 0,
					profanity: 0,
					anguish: 0,
					frustration: 0,
					total: 0,
				},
		);
		out.set(key, { data });
	}
	return out;
}
