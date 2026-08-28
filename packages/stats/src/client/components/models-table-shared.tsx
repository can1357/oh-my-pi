/**
 * Shared primitives for the per-model breakdown tables. Each table owns its
 * column definitions, sort order, and chart type — this module owns the
 * surface chrome, expand-row plumbing, theme palette, the mini-sparkline, and
 * the shared plugin/scale config consumed by multi-line detail charts.
 */

import { format } from "@oh-my-pi/pi-utils/dates";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Line } from "react-chartjs-2";
import type { ChartTheme } from "./chart-shared";

// Detail-table charts share the exact OMP chart chrome as the timeline charts;
// re-export rather than duplicate so the palette has a single source of truth.
export { CHART_THEMES as TABLE_CHART_THEMES, MODEL_COLORS } from "./chart-shared";
export type TableChartTheme = ChartTheme;

/** Style defaults for one line in a non-stacked detail chart. */
export function lineSeriesStyle(color: string) {
	return {
		borderColor: color,
		backgroundColor: "transparent",
		tension: 0.4,
		pointRadius: 0,
		borderWidth: 2,
	};
}

/**
 * No-axis, no-legend single-series sparkline used in the trend cell of every
 * model row. Caller supplies the already-extracted numeric series so this
 * stays agnostic of the row's underlying data shape.
 */
export function MiniSparkline({
	timestamps,
	values,
	color,
}: {
	timestamps: number[];
	values: number[];
	color: string;
}) {
	const chartData = {
		labels: timestamps.map(ts => format(new Date(ts), "MMM d")),
		datasets: [{ data: values, ...lineSeriesStyle(color) }],
	};

	const options = {
		responsive: true,
		maintainAspectRatio: false,
		plugins: { legend: { display: false }, tooltip: { enabled: false } },
		scales: {
			x: { display: false },
			y: { display: false, min: 0 },
		},
	};

	return <Line data={chartData} options={options} />;
}

/**
 * Plugin block (legend + tooltip) shared by every multi-series detail chart
 * in the table expanded views.
 */
export function detailChartPlugins(chartTheme: TableChartTheme) {
	return {
		legend: {
			display: true,
			position: "top" as const,
			labels: {
				color: chartTheme.legendLabel,
				usePointStyle: true,
				padding: 16,
				font: { size: 12 },
			},
		},
		tooltip: {
			backgroundColor: chartTheme.tooltipBackground,
			titleColor: chartTheme.tooltipTitle,
			bodyColor: chartTheme.tooltipBody,
			borderColor: chartTheme.tooltipBorder,
			borderWidth: 1,
			cornerRadius: 8,
		},
	};
}

/**
 * Single-Y-axis scales for a detail chart (used when every series shares a
 * unit, e.g. behavior counts). Min anchored at 0.
 */
export function detailChartScalesSingleAxis(chartTheme: TableChartTheme) {
	return {
		x: {
			grid: { color: chartTheme.grid },
			ticks: { color: chartTheme.tick, font: { size: 11 } },
		},
		y: {
			grid: { color: chartTheme.grid },
			ticks: { color: chartTheme.tick, font: { size: 11 } },
			min: 0,
		},
	};
}

/**
 * Dual-Y-axis scales for a detail chart with mixed units (e.g. TTFT seconds
 * on left, tokens/s on right). Right-axis grid is suppressed so it doesn't
 * collide with the left.
 */
export function detailChartScalesDualAxis(chartTheme: TableChartTheme) {
	return {
		x: {
			grid: { color: chartTheme.grid },
			ticks: { color: chartTheme.tick, font: { size: 11 } },
		},
		y: {
			type: "linear" as const,
			display: true,
			position: "left" as const,
			grid: { color: chartTheme.grid },
			ticks: { color: chartTheme.tick, font: { size: 11 } },
		},
		y1: {
			type: "linear" as const,
			display: true,
			position: "right" as const,
			grid: { drawOnChartArea: false },
			ticks: { color: chartTheme.tick, font: { size: 11 } },
		},
	};
}

export interface TableColumn {
	label: string;
	align?: "left" | "right" | "center";
}

/** Outer card + section title used by every model table. */
export function ModelTableShell({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="stats-panel overflow-hidden">
			<div className="px-5 py-4 border-b border-[var(--border-subtle)]">
				<h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
				{subtitle ? <p className="text-xs text-[var(--text-muted)] mt-1">{subtitle}</p> : null}
			</div>
			<div className="overflow-x-auto">{children}</div>
		</div>
	);
}

function alignClass(align: TableColumn["align"]): string {
	if (align === "right") return "text-right";
	if (align === "center") return "text-center";
	return "";
}

/** Sticky column-header row for a model table. */
export function ModelTableHeader({ columns, gridTemplate }: { columns: TableColumn[]; gridTemplate: string }) {
	return (
		<div
			className="grid gap-3 px-5 py-3 text-[var(--text-muted)] text-xs uppercase tracking-wider font-semibold"
			style={{ gridTemplateColumns: gridTemplate }}
		>
			{columns.map(col => (
				<div key={col.label} className={alignClass(col.align)}>
					{col.label}
				</div>
			))}
			{/* trailing chevron column has no header label */}
			<div />
		</div>
	);
}

/** Scroll wrapper for the row stack — capped to fit the dashboard viewport. */
export function ModelTableBody({ children }: { children: React.ReactNode }) {
	return <div className="max-h-[calc(100vh-300px)] overflow-y-auto">{children}</div>;
}

/**
 * Two-line model identity cell (model name + provider) shared by every
 * per-model table. Kept as a stable named contract so callers don't restate
 * the same two divs and font-utility classes.
 */
export function ModelNameCell({ model, provider }: { model: string; provider: string }) {
	return (
		<div>
			<div className="font-medium text-[var(--text-primary)]">{model}</div>
			<div className="text-xs text-[var(--text-muted)]">{provider}</div>
		</div>
	);
}

/**
 * One expandable model row. `cells` matches the column order from
 * `ModelTableHeader` plus the trend cell at the end (caller controls the
 * sparkline / placeholder). `expandedContent` is the panel revealed on toggle.
 */
export function ExpandableModelRow({
	gridTemplate,
	cells,
	trendCell,
	isExpanded,
	onToggle,
	expandedContent,
}: {
	gridTemplate: string;
	cells: React.ReactNode[];
	trendCell: React.ReactNode;
	isExpanded: boolean;
	onToggle: () => void;
	expandedContent: React.ReactNode;
}) {
	return (
		<div className="border-t border-[var(--border-subtle)]">
			<button
				type="button"
				onClick={onToggle}
				className="w-full bg-transparent border-none text-left px-5 py-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
			>
				<div className="grid gap-3 items-center" style={{ gridTemplateColumns: gridTemplate }}>
					{cells}
					<div className="h-10">{trendCell}</div>
					<div className="flex justify-center text-[var(--text-muted)]">
						{isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
					</div>
				</div>
			</button>
			{isExpanded ? (
				<div className="px-5 py-4 bg-[var(--bg-elevated)] border-t border-[var(--border-subtle)]">
					{expandedContent}
				</div>
			) : null}
		</div>
	);
}

/** Placeholder shown in the trend cell when a model has no time-series data. */
export function TrendEmpty() {
	return <div className="text-[var(--text-muted)] text-center text-sm">-</div>;
}

/** Placeholder shown in the expanded detail-chart slot when data is missing. */
export function DetailChartEmpty({ message = "No data available" }: { message?: string }) {
	return <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">{message}</div>;
}
