/** One plotted series. `values` align index-for-index with the chart's x slots. */
export interface ChartSeries {
	key: string;
	label: string;
	color: string;
	/** `null` leaves a gap (lines) or an empty slot (bars). */
	values: readonly (number | null)[];
	/** Overrides the chart-level `kind` for this series (e.g. a line over bars). */
	kind?: ChartKind;
	/** Plot against the right axis (uses `formatRight`). Right-axis series never stack. */
	axis?: "left" | "right";
	/** Diagonal hatching instead of a solid fill (bars/areas). */
	pattern?: "hatch";
	/** Dashed stroke (lines, area outlines). */
	dashed?: boolean;
	/** Leave this series out of the tooltip (e.g. a trend line that repeats a bar). */
	tooltip?: false;
}

/** `dots` marks each value with a point and no connecting segment (raw samples under a trend line). */
export type ChartKind = "bars" | "area" | "line" | "dots";

/** Vertical guide at an x slot (e.g. an experiment start or a compaction). */
export interface SlotMarker {
	index: number;
	label?: string;
}

/** Horizontal guide drawn across the plot (e.g. a 100% capacity line). */
export interface ReferenceLine {
	value: number;
	label?: string;
	axis?: "left" | "right";
}
