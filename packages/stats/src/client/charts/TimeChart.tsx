import { formatBucket, formatTick } from "../data/range";
import { Chart, type ChartProps } from "./Chart";

const DAY_MS = 24 * 3_600_000;

export interface TimeChartProps extends Omit<ChartProps, "slots" | "tickLabel" | "tooltipTitle" | "onSelect"> {
	/** Ascending bucket starts (see `bucketAxis`); series values align with them. */
	buckets: readonly number[];
	bucketMs: number;
	onSelectBucket?: (bucketStart: number) => void;
}

/** {@link Chart} over a bucketed time axis. */
export function TimeChart({ buckets, bucketMs, onSelectBucket, ...rest }: TimeChartProps) {
	return (
		<Chart
			{...rest}
			slots={buckets.length}
			tickLabel={i =>
				formatTick(
					buckets[i],
					buckets.length > 1 && buckets[buckets.length - 1] - buckets[0] > DAY_MS ? DAY_MS : bucketMs,
				)
			}
			tooltipTitle={i => formatBucket(buckets[i], bucketMs)}
			onSelect={onSelectBucket ? i => onSelectBucket(buckets[i]) : undefined}
		/>
	);
}
