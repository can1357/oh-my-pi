import { formatCompact, formatPercent } from "../../data/formatters";

export interface ContextDonutSegment {
	key: string;
	label: string;
	value: number;
	color: string;
}

/** SVG donut with a textual legend; the legend, not the ring, carries the data. */
export function ContextDonut({
	segments,
	centerLabel,
	centerValue,
	ariaLabel,
}: {
	segments: readonly ContextDonutSegment[];
	centerLabel: string;
	centerValue: string;
	ariaLabel: string;
}) {
	const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
	let offset = 0;
	return (
		<div className="context-donut" role="img" aria-label={ariaLabel}>
			<div className="context-donut-ring">
				<svg viewBox="0 0 120 120" aria-hidden="true">
					<circle cx="60" cy="60" r="48" className="context-donut-track" />
					{total > 0 &&
						segments
							.filter(segment => segment.value > 0)
							.map(segment => {
								const share = segment.value / total;
								const dash = Math.max(0, share * 100 - 0.8);
								const element = (
									<circle
										key={segment.key}
										cx="60"
										cy="60"
										r="48"
										className="context-donut-segment"
										stroke={segment.color}
										strokeDasharray={`${dash} ${100 - dash}`}
										strokeDashoffset={-offset}
										pathLength={100}
										transform="rotate(-90 60 60)"
									/>
								);
								offset += share * 100;
								return element;
							})}
				</svg>
				<div className="context-donut-center">
					<strong>{centerValue}</strong>
					<span>{centerLabel}</span>
				</div>
			</div>
			<ul className="context-donut-legend">
				{segments.map(segment => (
					<li key={segment.key}>
						<i style={{ background: segment.color }} aria-hidden="true" />
						<span title={segment.label}>{segment.label}</span>
						<b>{formatCompact(segment.value)}</b>
						<small>{total > 0 ? formatPercent(segment.value / total, 0) : "0%"}</small>
					</li>
				))}
			</ul>
		</div>
	);
}
