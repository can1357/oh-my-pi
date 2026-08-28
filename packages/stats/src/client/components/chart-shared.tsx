/**
 * Shared chart primitives for the dashboard timeline charts: the OMP color
 * palette, light/dark chart chrome, legend/tooltip + scale plumbing, dataset
 * styling, and the top-N-by-model / aggregate bucketing used by the cost and
 * behavior series.
 */

import { format } from "@oh-my-pi/pi-utils/dates";

// OMP brand palette (packages/collab-web/src/styles/tokens.css): pink/purple/cyan.
// Categorical series lead with the brand gradient hues (pink -> purple -> cyan).
export const MODEL_COLORS = [
	"#ed4abf", // brand pink (accent)
	"#9b4dff", // brand violet
	"#5ad8e6", // brand cyan
	"#62d394", // green
	"#c77dff", // light purple
	"#ff8fd1", // light pink
	"#f5c14b", // amber
	"#ff6b7d", // rose
];

export function buildModelColorLookup(
	records: readonly { model: string; provider: string; totalRequests: number }[],
): Map<string, string> {
	const rankedRecords = [...records].sort(
		(a, b) =>
			b.totalRequests - a.totalRequests || `${a.model}::${a.provider}`.localeCompare(`${b.model}::${b.provider}`),
	);

	return new Map(
		rankedRecords.map((record, index) => [
			`${record.model}::${record.provider}`,
			MODEL_COLORS[index % MODEL_COLORS.length],
		]),
	);
}

export const CHART_THEMES = {
	dark: {
		legendLabel: "#a89fb3",
		tooltipBackground: "#241a2e",
		tooltipTitle: "#eae5ef",
		tooltipBody: "#a89fb3",
		tooltipBorder: "rgba(255, 255, 255, 0.12)",
		grid: "rgba(255, 255, 255, 0.06)",
		tick: "#867a93",
	},
	light: {
		legendLabel: "#5a5462",
		tooltipBackground: "#ffffff",
		tooltipTitle: "#241a2e",
		tooltipBody: "#5a5462",
		tooltipBorder: "rgba(20, 12, 28, 0.15)",
		grid: "rgba(20, 12, 28, 0.08)",
		tick: "#6a6275",
	},
} as const;

export type ChartTheme = (typeof CHART_THEMES)[keyof typeof CHART_THEMES];

export interface ChartSeries {
	labels: string[];
	datasets: Array<{ label: string; data: number[] }>;
}

interface TooltipItem {
	parsed: { y: number | null };
}

/** Tooltip + legend config common to bar and line variants of the time charts. */
export function buildSharedPlugins(opts: {
	chartTheme: ChartTheme;
	showLegend: boolean;
	defaultLabel: string;
	formatValue: (n: number) => string;
	footer?: (items: TooltipItem[]) => string | undefined;
}) {
	const { chartTheme, showLegend, defaultLabel, formatValue, footer } = opts;
	return {
		legend: {
			display: showLegend,
			position: "top" as const,
			align: "start" as const,
			labels: {
				color: chartTheme.legendLabel,
				usePointStyle: true,
				padding: 16,
				font: { size: 12 },
				boxWidth: 8,
			},
		},
		tooltip: {
			backgroundColor: chartTheme.tooltipBackground,
			titleColor: chartTheme.tooltipTitle,
			bodyColor: chartTheme.tooltipBody,
			borderColor: chartTheme.tooltipBorder,
			borderWidth: 1,
			padding: 12,
			cornerRadius: 8,
			callbacks: {
				label: (ctx: { dataset: { label?: string }; parsed: { y: number | null } }) => {
					const label = ctx.dataset.label ?? defaultLabel;
					const value = ctx.parsed.y ?? 0;
					return `${label}: ${formatValue(value)}`;
				},
				...(footer ? { footer } : {}),
			},
		},
	};
}

/** Y-axis tick formatter + grid/tick styling shared by both charts. */
export function buildSharedScales(opts: { chartTheme: ChartTheme; formatY: (n: number) => string }) {
	const { chartTheme, formatY } = opts;
	const sharedScaleBase = {
		grid: { color: chartTheme.grid, drawBorder: false },
		ticks: { color: chartTheme.tick, font: { size: 11 } },
	};
	const yScale = {
		...sharedScaleBase,
		ticks: {
			...sharedScaleBase.ticks,
			callback: (value: number | string) => formatY(Number(value)),
		},
		min: 0,
	};
	return { sharedScaleBase, yScale };
}

/** Stylistic defaults for a single line dataset in a stacked/by-model chart. */
export function lineDatasetStyle(color: string) {
	return {
		borderColor: color,
		backgroundColor: `${color}20`,
		fill: true,
		tension: 0,
		pointRadius: 3,
		pointHoverRadius: 4,
		borderWidth: 2,
	};
}

/** Stylistic defaults for a single bar dataset in a stacked chart. */
export function barDatasetStyle(color: string) {
	return {
		backgroundColor: color,
		borderColor: color,
		borderWidth: 0,
		borderRadius: 4,
		maxBarThickness: 56,
	};
}

/**
 * Map a generic ChartSeries' datasets through a per-index style function so
 * callers can supply line or bar styling without repeating the label/data
 * spread at every chart site.
 */
export function styleDatasets(series: ChartSeries, styleFor: (index: number) => Record<string, unknown>) {
	return series.datasets.map((ds, index) => ({
		label: ds.label,
		data: ds.data,
		...styleFor(index),
	}));
}

/**
 * Bucket points by day into a single aggregate series. Caller supplies the
 * per-bucket accumulator + final value extractor; mirrors the shape of
 * `buildTopNByModelSeries` for the non-by-model variant of each time chart.
 */
export function buildAggregateTimeSeries<T extends { timestamp: number }, B>(
	points: T[],
	label: string,
	opts: {
		initBucket: () => B;
		accumulate: (bucket: B, point: T) => void;
		bucketToValue: (bucket: B) => number;
	},
): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };
	const { initBucket, accumulate, bucketToValue } = opts;
	const byDay = new Map<number, B>();
	for (const point of points) {
		const bucket = byDay.get(point.timestamp) ?? initBucket();
		accumulate(bucket, point);
		byDay.set(point.timestamp, bucket);
	}
	const sorted = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
	return {
		labels: sorted.map(([ts]) => format(new Date(ts), "MMM d")),
		datasets: [{ label, data: sorted.map(([, bucket]) => bucketToValue(bucket)) }],
	};
}

interface ModelKeyedPoint {
	timestamp: number;
	model: string;
	provider: string;
}

/**
 * Bucket points by day and by top-N model (with an "Other" rollup), producing
 * a ChartSeries. Caller controls how points contribute to ranking and to each
 * day-bucket value via the `rankWeight`/`accumulate`/`bucketToValue` callbacks
 * — keeps the behavior chart's rate math separate from the cost chart's sum.
 */
export function buildTopNByModelSeries<T extends ModelKeyedPoint, B>(
	points: T[],
	opts: {
		topN?: number;
		rankWeight: (point: T) => number;
		initBucket: () => B;
		accumulate: (bucket: B, point: T) => void;
		bucketToValue: (bucket: B) => number;
	},
): ChartSeries {
	if (points.length === 0) return { labels: [], datasets: [] };
	const { topN = 5, rankWeight, initBucket, accumulate, bucketToValue } = opts;

	const totals = new Map<string, { model: string; provider: string; weight: number }>();
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const existing = totals.get(key);
		if (existing) {
			existing.weight += rankWeight(point);
		} else {
			totals.set(key, { model: point.model, provider: point.provider, weight: rankWeight(point) });
		}
	}

	const sorted = [...totals.entries()].sort((a, b) => b[1].weight - a[1].weight);
	const topEntries = sorted.slice(0, topN);
	const topKeys = new Set(topEntries.map(([key]) => key));

	const modelCount = new Map<string, number>();
	for (const [, { model }] of topEntries) {
		modelCount.set(model, (modelCount.get(model) ?? 0) + 1);
	}
	const labelByKey = new Map<string, string>();
	for (const [key, { model, provider }] of topEntries) {
		labelByKey.set(key, (modelCount.get(model) ?? 0) > 1 ? `${model} (${provider})` : model);
	}

	const allDays = [...new Set(points.map(p => p.timestamp))].sort((a, b) => a - b);
	const seriesNames = topEntries.map(([key]) => labelByKey.get(key) ?? key);
	const hasOther = points.some(p => !topKeys.has(`${p.model}::${p.provider}`));
	if (hasOther) seriesNames.push("Other");

	const dayMap = new Map<number, Record<string, B>>();
	for (const day of allDays) dayMap.set(day, {});
	for (const point of points) {
		const key = `${point.model}::${point.provider}`;
		const label = topKeys.has(key) ? (labelByKey.get(key) ?? point.model) : "Other";
		const row = dayMap.get(point.timestamp);
		if (!row) continue;
		const bucket = row[label] ?? initBucket();
		accumulate(bucket, point);
		row[label] = bucket;
	}

	return {
		labels: allDays.map(ts => format(new Date(ts), "MMM d")),
		datasets: seriesNames.map(name => ({
			label: name,
			data: allDays.map(day => {
				const bucket = dayMap.get(day)?.[name];
				return bucket ? bucketToValue(bucket) : 0;
			}),
		})),
	};
}
