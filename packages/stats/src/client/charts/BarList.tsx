import type { ReactNode } from "react";

export interface BarListItem {
	key: string;
	label: ReactNode;
	value: number;
	/** Formatted figure; defaults to `value.toLocaleString()`. */
	display?: string;
	color?: string;
}

export interface BarListProps {
	items: readonly BarListItem[];
	/** Scale maximum; defaults to the largest value. */
	max?: number;
	onSelect?: (key: string) => void;
}

/** Ranked rows with a proportional tinted fill behind each label. */
export function BarList({ items, max, onSelect }: BarListProps) {
	const top = max ?? Math.max(0, ...items.map(i => i.value));
	return (
		<div className="bar-list">
			{items.map(item => {
				const pct = top > 0 ? Math.max(0.5, (item.value / top) * 100) : 0;
				const content = (
					<>
						<span
							className="bar-list-fill"
							style={{ width: `${pct}%`, background: item.color ?? "var(--chart-primary)" }}
						/>
						<span className="bar-list-label">{item.label}</span>
						<span className="bar-list-value">{item.display ?? item.value.toLocaleString()}</span>
					</>
				);
				return onSelect ? (
					<button key={item.key} type="button" className="bar-list-row" onClick={() => onSelect(item.key)}>
						{content}
					</button>
				) : (
					<div key={item.key} className="bar-list-row">
						{content}
					</div>
				);
			})}
		</div>
	);
}
