import type { TimeRange } from "../types";

export interface RangeControlProps {
	value: TimeRange;
	onChange: (value: TimeRange) => void;
	className?: string;
}

const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
	{ value: "1h", label: "1h" },
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
	{ value: "all", label: "All" },
];

export function RangeControl({ value, onChange, className = "" }: RangeControlProps) {
	return (
		<div className={`stats-range-control ${className}`} role="radiogroup" aria-label="Select time range">
			{RANGE_OPTIONS.map(opt => {
				const isActive = opt.value === value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={isActive}
						data-active={isActive ? "true" : "false"}
						className="stats-range-control-btn"
						onClick={() => onChange(opt.value)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
