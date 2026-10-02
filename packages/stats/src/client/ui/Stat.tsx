import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Sparkline } from "../charts/Sparkline";

export interface StatDelta {
	/** Relative change vs the previous period (0.12 = +12%). `null` when there is no baseline. */
	change: number | null;
	/** Which direction is good news. Default `"up"`. */
	good?: "up" | "down";
}

export interface StatProps {
	label: ReactNode;
	value: ReactNode;
	/** Small print under the value. */
	hint?: ReactNode;
	delta?: StatDelta;
	/** Trend under the value. */
	spark?: readonly number[];
	sparkColor?: string;
	size?: "md" | "sm";
	/** Title tooltip explaining the metric. */
	title?: string;
}

/**
 * One metric tile. The value flashes briefly when it changes after mount, so
 * live updates are noticeable without being loud.
 */
export function Stat({ label, value, hint, delta, spark, sparkColor, size = "md", title }: StatProps) {
	const flash = useChangeFlash(typeof value === "string" || typeof value === "number" ? value : null);
	return (
		<div className="stat" data-size={size} title={title}>
			<div className="stat-label">{label}</div>
			<div className="stat-value" data-flash={flash}>
				{value}
			</div>
			{(hint !== undefined || delta) && (
				<div className="stat-foot">
					{delta && <Delta {...delta} />}
					{hint !== undefined && <span className="truncate">{hint}</span>}
				</div>
			)}
			{spark && spark.length > 1 && (
				<div className="stat-spark">
					<Sparkline values={spark} color={sparkColor} />
				</div>
			)}
		</div>
	);
}

export interface StatGridProps {
	/** Minimum tile width before wrapping. Default 170px. */
	min?: number;
	children: ReactNode;
}

/** Tiles sharing one card, separated by hairlines. */
export function StatGrid({ min, children }: StatGridProps) {
	return (
		<div
			className="stat-grid rise"
			style={min !== undefined ? ({ "--stat-min": `${min}px` } as CSSProperties) : undefined}
		>
			{children}
		</div>
	);
}

/** Signed percentage change pill, green when the move is good news. */
export function Delta({ change, good = "up" }: StatDelta) {
	if (change === null || !Number.isFinite(change)) return <span className="delta">new</span>;
	const rounded = Math.abs(change) < 0.0005 ? 0 : change;
	const tone = rounded === 0 ? undefined : rounded > 0 === (good === "up") ? "good" : "bad";
	const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
	const pct = Math.abs(rounded) * 100;
	return (
		<span className="delta" data-tone={tone}>
			{sign}
			{pct >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%
		</span>
	);
}

/** Relative change from `previous` to `current`; `null` when there is no baseline. */
export function relativeChange(current: number, previous: number): number | null {
	if (previous === 0) return current === 0 ? 0 : null;
	return (current - previous) / previous;
}

function useChangeFlash(value: string | number | null): boolean {
	const previous = useRef(value);
	const [flash, setFlash] = useState(false);
	useEffect(() => {
		if (previous.current === value) return;
		const hadValue = previous.current !== null;
		previous.current = value;
		if (!hadValue) return;
		setFlash(true);
		const timer = setTimeout(() => setFlash(false), 900);
		return () => clearTimeout(timer);
	}, [value]);
	return flash;
}
