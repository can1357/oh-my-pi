export interface ShareSegment {
	key: string;
	label: string;
	value: number;
	color: string;
}

/** Single horizontal bar split proportionally among segments (zero segments omitted). */
export function ShareBar({ segments, height = 8 }: { segments: readonly ShareSegment[]; height?: number }) {
	const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
	return (
		<div className="share-bar" style={{ height }} role="img">
			{total > 0 &&
				segments
					.filter(s => s.value > 0)
					.map(s => (
						<div
							key={s.key}
							className="share-bar-seg"
							style={{ flexGrow: s.value / total, background: s.color }}
							title={`${s.label}: ${((s.value / total) * 100).toFixed(1)}%`}
						/>
					))}
		</div>
	);
}
