import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export interface SegmentedOption<T extends string> {
	value: T;
	label: ReactNode;
	title?: string;
}

export interface SegmentedProps<T extends string> {
	options: readonly SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	size?: "md" | "sm";
	"aria-label"?: string;
}

/** Pill toggle with a measured sliding thumb. */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	size = "md",
	"aria-label": ariaLabel,
}: SegmentedProps<T>) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

	useLayoutEffect(() => {
		const root = rootRef.current;
		const active = root?.querySelector<HTMLElement>('[data-active="true"]');
		if (!root || !active) {
			setThumb(null);
			return;
		}
		const measure = () => setThumb({ left: active.offsetLeft, width: active.offsetWidth });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, [value, options]);

	return (
		<div ref={rootRef} className="segmented" data-size={size} role="radiogroup" aria-label={ariaLabel}>
			{thumb && <span className="segmented-thumb" style={{ left: thumb.left, width: thumb.width }} />}
			{options.map(option => (
				<button
					key={option.value}
					type="button"
					role="radio"
					aria-checked={option.value === value}
					className="segmented-option"
					data-active={option.value === value}
					title={option.title}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}
