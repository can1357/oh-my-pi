import { useWidth } from "./useWidth";

export interface SparklineProps {
	values: readonly number[];
	color?: string;
	height?: number;
	/** Fixed width; omit to fill the container. */
	width?: number;
	/** Fill under the line. Default true. */
	area?: boolean;
}

/** Axis-free trend line for stat tiles and table cells. */
export function Sparkline({ values, color = "var(--chart-primary)", height = 28, width, area = true }: SparklineProps) {
	const [ref, measured] = useWidth<HTMLDivElement>();
	const w = width ?? measured;
	const max = Math.max(0, ...values);
	const n = values.length;
	let line = "";
	if (w > 0 && n > 0) {
		const step = n > 1 ? w / (n - 1) : 0;
		for (let i = 0; i < n; i++) {
			const x = n > 1 ? i * step : w / 2;
			const y = max > 0 ? height - 2 - (values[i] / max) * (height - 4) : height - 2;
			line += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
		}
	}
	return (
		<div ref={ref} className="sparkline" style={{ width: width ?? "100%", height }}>
			{w > 0 && n > 0 && (
				<svg width={w} height={height} aria-hidden="true">
					{area && <path className="area" d={`${line}L${w},${height}L0,${height}Z`} fill={color} />}
					<path className="chart-line" d={line} stroke={color} />
				</svg>
			)}
		</div>
	);
}
