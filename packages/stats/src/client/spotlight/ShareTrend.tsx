import { useMemo } from "react";
import { type ChartSeries, Legend, type SlotMarker, TimeChart } from "../charts";
import { formatPercent } from "../data/formatters";
import { bucketAxis, formatBucket, rangeMeta } from "../data/range";
import { densify } from "../data/series";
import type { SpotlightDashboardStats, SpotlightSharePoint, TimeRange } from "../types";
import { Card } from "../ui";
import { bucketNoun, formatShare } from "./meta";

/** Trailing buckets in each rolling share. */
const ROLLING_WINDOW = 7;

type ShareGroup = SpotlightSharePoint["group"];

const GROUPS: readonly { group: ShareGroup; label: string; color: string }[] = [
	{ group: "shaped", label: "Shaped sessions", color: "var(--spot-shaped)" },
	{ group: "outside", label: "Outside the experiment", color: "var(--spot-outside)" },
];

export interface ShareTrendProps {
	stats: SpotlightDashboardStats;
	range: TimeRange;
	stale: boolean;
}

/** Share of context that is tool output, per session group, raw per bucket and as a rolling ratio. */
export function ShareTrend({ stats, range, stale }: ShareTrendProps) {
	const meta = rangeMeta(range);
	const chart = useMemo(() => {
		const buckets = bucketAxis(
			range,
			stats.share.map(p => p.timestamp),
			meta.bucketMs,
		);
		const series: ChartSeries[] = [];
		const legend: { key: string; label: string; color: string; value?: string }[] = [];
		for (const { group, label, color } of GROUPS) {
			const points = stats.share.filter(p => p.group === group);
			const tool = densify(points, buckets, p => p.toolTokens);
			const ctx = densify(points, buckets, p => p.contextTokens);
			let toolSum = 0;
			let ctxSum = 0;
			const rolling = buckets.map((_, i) => {
				let t = 0;
				let c = 0;
				for (let j = Math.max(0, i - ROLLING_WINDOW + 1); j <= i; j++) {
					t += tool[j];
					c += ctx[j];
				}
				toolSum += tool[i];
				ctxSum += ctx[i];
				return c > 0 ? t / c : null;
			});
			if (ctxSum === 0) continue;
			series.push(
				{
					key: `${group}:raw`,
					label: `${label} · bucket`,
					color,
					kind: "dots",
					values: buckets.map((_, i) => (ctx[i] > 0 ? tool[i] / ctx[i] : null)),
				},
				{ key: `${group}:avg`, label: `${label} · rolling`, color, kind: "line", values: rolling },
			);
			legend.push({ key: group, label, color, value: formatShare(toolSum / ctxSum) });
		}
		const markers: SlotMarker[] = [];
		if (stats.experimentStart !== null) {
			const start = Math.floor(stats.experimentStart / meta.bucketMs) * meta.bucketMs;
			const index = buckets.indexOf(start);
			if (index >= 0) markers.push({ index, label: "experiment starts" });
		}
		return { buckets, series, legend, markers };
	}, [stats.share, stats.experimentStart, range, meta.bucketMs]);

	return (
		<Card
			index={4}
			title="Tool-output share of context"
			description={
				stats.experimentStart !== null && chart.markers.length === 0
					? `Since ${formatBucket(stats.experimentStart, 86_400_000)}, shaped sessions should carry less tool output`
					: "Shaped sessions should carry less tool output than the rest of your history"
			}
			actions={<Legend items={chart.legend} />}
			stale={stale}
			footer={`Tool tokens are result chars ÷ 4; context adds assistant output, your prompts (chars ÷ 4) and each session's first prompt. Dots are single buckets (one ${bucketNoun(meta.bucketMs)}); lines are the trailing ${ROLLING_WINDOW}-bucket ratio of sums.`}
		>
			<TimeChart
				buckets={chart.buckets}
				bucketMs={meta.bucketMs}
				series={chart.series}
				markers={chart.markers}
				stacked={false}
				height={260}
				format={v => formatPercent(v, 0)}
				formatTooltip={v => formatPercent(v)}
				showTotal={false}
				emptyLabel="No tool calls in this range"
			/>
		</Card>
	);
}
