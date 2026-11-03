import type { ReactNode } from "react";
import { niceScale } from "./Chart";

/** One estimate on a row: a point and its interval. */
export interface DotWhiskerMark {
	key: string;
	value: number | null;
	lo: number | null;
	hi: number | null;
	color: string;
	/** `dot` (default) filled; `ring` hollow (a counterfactual); `diamond` a reference level; `square` a variant. */
	shape?: "dot" | "ring" | "diamond" | "square";
	/** Vertical offset from the row's center in px, to keep several marks of one row apart. */
	offset?: number;
	/** Hover text naming the mark. */
	title?: string;
}

export interface DotWhiskerRow {
	key: string;
	label: ReactNode;
	marks: readonly DotWhiskerMark[];
	/** Right-column figure; defaults to the first mark's value. */
	figure?: ReactNode;
	/** Small print under the figure; defaults to the first mark's interval. */
	detail?: ReactNode;
}

export interface DotWhiskerGuide {
	key: string;
	value: number;
	color: string;
}

/** A shaded span through every row (e.g. a reference's interval). */
export interface DotWhiskerBand {
	lo: number;
	hi: number;
	color: string;
}

export interface DotWhiskerProps {
	rows: readonly DotWhiskerRow[];
	/** Vertical guides through every row (e.g. chance levels). */
	guides?: readonly DotWhiskerGuide[];
	band?: DotWhiskerBand;
	format: (value: number) => string;
	/** Axis tick formatter; defaults to `format`. */
	formatTick?: (value: number) => string;
}

/**
 * Point estimates with their intervals on one shared axis that always spans
 * zero (and extends below it for signed values), one row per group. Layout is
 * percentage-based, so it never measures the DOM.
 */
export function DotWhisker({ rows, guides, band, format, formatTick }: DotWhiskerProps) {
	let max = 0;
	let min = 0;
	const extend = (v: number | null) => {
		if (v === null) return;
		max = Math.max(max, v);
		min = Math.min(min, v);
	};
	for (const row of rows) {
		for (const mark of row.marks) {
			extend(mark.value);
			extend(mark.lo);
			extend(mark.hi);
		}
	}
	for (const guide of guides ?? []) extend(guide.value);
	if (band) {
		extend(band.lo);
		extend(band.hi);
	}
	const scale = niceScale(max, min);
	const span = scale.max - scale.min;
	const at = (v: number) => ((Math.min(scale.max, Math.max(scale.min, v)) - scale.min) / span) * 100;
	const pct = (v: number) => `${at(v)}%`;
	const underlay = (
		<>
			{band && (
				<span
					className="dw-band"
					style={{ left: pct(band.lo), width: `${at(band.hi) - at(band.lo)}%`, "--band": band.color }}
				/>
			)}
			{guides?.map(guide => (
				<span key={guide.key} className="dw-guide" style={{ left: pct(guide.value), "--guide": guide.color }} />
			))}
		</>
	);

	return (
		<div className="dw">
			{rows.map(row => {
				const first = row.marks[0];
				const interval =
					first !== undefined && first.lo !== null && first.hi !== null
						? `${format(first.lo)}–${format(first.hi)}`
						: "";
				return (
					<div key={row.key} className="dw-row">
						<div className="dw-label">{row.label}</div>
						<div className="dw-track">
							{underlay}
							{row.marks.map(mark => (
								<span
									key={mark.key}
									className="dw-mark"
									data-shape={mark.shape ?? "dot"}
									style={{ "--dot": mark.color, "--dy": `${mark.offset ?? 0}px` }}
								>
									{mark.lo !== null && mark.hi !== null && (
										<span
											className="dw-whisker"
											style={{ left: pct(mark.lo), width: `${at(mark.hi) - at(mark.lo)}%` }}
										/>
									)}
									{mark.value !== null && (
										<span className="dw-dot" style={{ left: pct(mark.value) }} title={mark.title} />
									)}
								</span>
							))}
						</div>
						<div className="dw-value">
							<span className="num">
								{row.figure ?? (first?.value === null || first === undefined ? "–" : format(first.value))}
							</span>
							<span className="dw-detail">{row.detail ?? interval}</span>
						</div>
					</div>
				);
			})}
			<div className="dw-row dw-axis" aria-hidden="true">
				<div />
				<div className="dw-track">
					{scale.ticks.map(t => (
						<span key={t} className="dw-tick" style={{ left: pct(t) }}>
							{(formatTick ?? format)(t)}
						</span>
					))}
				</div>
				<div />
			</div>
		</div>
	);
}
