export interface SegmentedControlOption<T> {
	value: T;
	label: string;
	title?: string;
}

export interface SegmentedControlProps<T> {
	options: SegmentedControlOption<T>[];
	value: T;
	onChange: (value: T) => void;
	className?: string;
}

export function SegmentedControl<T>({ options, value, onChange, className = "" }: SegmentedControlProps<T>) {
	return (
		<div className={`stats-segmented-control ${className}`} role="radiogroup">
			{options.map(opt => {
				const isActive = opt.value === value;
				return (
					<button
						key={String(opt.value)}
						type="button"
						role="radio"
						aria-checked={isActive}
						data-active={isActive ? "true" : "false"}
						className="stats-segmented-control-btn"
						title={opt.title}
						onClick={() => onChange(opt.value)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
