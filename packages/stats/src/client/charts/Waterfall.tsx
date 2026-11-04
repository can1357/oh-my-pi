import type { ReactNode } from "react";

export interface WaterfallStep {
	key: string;
	label: ReactNode;
	/** `total` bars start at zero and reset the running total; `delta` bars float from it. */
	kind: "total" | "delta";
	/** A total's level, or a delta's signed change. */
	value: number;
	/** Any CSS background (solid color or gradient). */
	color: string;
	/** Dim figure after the value (e.g. share of the first total). */
	note?: ReactNode;
	title?: string;
}

export interface WaterfallProps {
	steps: readonly WaterfallStep[];
	/** Formats magnitudes; deltas get their sign from the component. */
	format: (value: number) => string;
}

interface PlacedStep extends WaterfallStep {
	from: number;
	to: number;
	/** Running total before this step (the connector's position). */
	before: number;
}

/**
 * Horizontal bridge chart: a total, the changes that eat into it, and the
 * total left at the end. Rows read top to bottom; dashed connectors carry the
 * running total from one bar to the next. Pure layout (percentages), so it
 * never measures the DOM and reflows with its column.
 */
export function Waterfall({ steps, format }: WaterfallProps) {
	let running = 0;
	const placed: PlacedStep[] = steps.map(step => {
		const before = running;
		if (step.kind === "total") {
			running = step.value;
			return { ...step, from: 0, to: step.value, before };
		}
		running += step.value;
		return { ...step, from: before, to: running, before };
	});
	let lo = 0;
	let hi = 0;
	for (const step of placed) {
		lo = Math.min(lo, step.from, step.to);
		hi = Math.max(hi, step.from, step.to);
	}
	const span = hi - lo || 1;
	const pct = (v: number) => ((v - lo) / span) * 100;

	return (
		<ol className="waterfall">
			{placed.map((step, i) => {
				const left = pct(Math.min(step.from, step.to));
				const width = Math.abs(pct(step.to) - pct(step.from));
				const sign = step.kind === "delta" ? (step.value < 0 ? "−" : "+") : step.value < 0 ? "−" : "";
				return (
					<li key={step.key} className="waterfall-row" data-kind={step.kind} title={step.title}>
						<span className="waterfall-label">{step.label}</span>
						<span className="waterfall-track">
							{lo < 0 && <span className="waterfall-zero" style={{ left: `${pct(0)}%` }} />}
							{i > 0 && <span className="waterfall-link" style={{ left: `${pct(step.before)}%` }} />}
							<span
								className="waterfall-bar"
								data-empty={step.value === 0}
								style={{ left: `${left}%`, width: `${width}%`, "--bar": step.color }}
							/>
						</span>
						<span className="waterfall-value">
							<span className="num">
								{sign}
								{format(Math.abs(step.value))}
							</span>
							{step.note !== undefined && <span className="waterfall-note">{step.note}</span>}
						</span>
					</li>
				);
			})}
		</ol>
	);
}
