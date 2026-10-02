import { useCallback, useState } from "react";

export interface LegendItem {
	key: string;
	label: string;
	color: string;
	/** Optional right-hand figure (e.g. the series total). */
	value?: string;
}

export interface LegendProps {
	items: readonly LegendItem[];
	/** Keys currently hidden; with `onToggle` the items become buttons. */
	hidden?: ReadonlySet<string>;
	onToggle?: (key: string) => void;
}

export function Legend({ items, hidden, onToggle }: LegendProps) {
	return (
		<div className="legend">
			{items.map(item => {
				const body = (
					<>
						<span className="swatch" style={{ background: item.color }} />
						<span className="truncate">{item.label}</span>
						{item.value && <span className="legend-value">{item.value}</span>}
					</>
				);
				return onToggle ? (
					<button
						key={item.key}
						type="button"
						className="legend-item"
						data-off={hidden?.has(item.key) ?? false}
						onClick={() => onToggle(item.key)}
						title={item.label}
					>
						{body}
					</button>
				) : (
					<span key={item.key} className="legend-item" title={item.label}>
						{body}
					</span>
				);
			})}
		</div>
	);
}

/** Hidden-key set for toggleable legends. */
export function useHiddenSeries(): [ReadonlySet<string>, (key: string) => void] {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = useCallback((key: string) => {
		setHidden(prev => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	}, []);
	return [hidden, toggle];
}
