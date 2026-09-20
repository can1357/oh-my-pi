/**
 * Category palette + canvas chrome tokens for the trace flamegraph, keyed by
 * resolved theme. Hues align with the dashboard chip palette; chrome tokens
 * mirror `CHART_THEMES` so the canvas matches the chart.js surfaces.
 */

import type { TraceSpanKind } from "../types";

export interface TraceTheme {
	/** Span fill per category. */
	category: Record<TraceSpanKind, string>;
	/** Error fill tint + left-edge accent. */
	error: string;
	/** Marker diamond fill. */
	marker: string;
	/** Alternating turn-band fill. */
	turnBand: string;
	/** Canvas background. */
	surface: string;
	/** Ruler/lane hairlines. */
	grid: string;
	/** Ruler tick labels. */
	tick: string;
	/** Span label text drawn inside blocks. */
	spanText: string;
	/** Selection outline (brand cyan focus ring). */
	selection: string;
	tooltipBackground: string;
	tooltipTitle: string;
	tooltipBody: string;
	tooltipBorder: string;
}

export const TRACE_THEMES: Record<"dark" | "light", TraceTheme> = {
	dark: {
		category: {
			turn: "#34d399",
			model: "#a78bfa",
			tool: "#fbbf24",
			subagent: "#38bdf8",
			background: "#94a3b8",
		},
		error: "#f87171",
		marker: "#facc15",
		turnBand: "rgba(255, 255, 255, 0.035)",
		surface: "transparent",
		grid: "rgba(255, 255, 255, 0.06)",
		tick: "#867a93",
		spanText: "#16121c",
		selection: "#5ad8e6",
		tooltipBackground: "#241a2e",
		tooltipTitle: "#eae5ef",
		tooltipBody: "#a89fb3",
		tooltipBorder: "rgba(255, 255, 255, 0.12)",
	},
	light: {
		category: {
			turn: "#059669",
			model: "#7c3aed",
			tool: "#d97706",
			subagent: "#0284c7",
			background: "#64748b",
		},
		error: "#ef4444",
		marker: "#ca8a04",
		turnBand: "rgba(0, 0, 0, 0.04)",
		surface: "transparent",
		grid: "rgba(20, 12, 28, 0.08)",
		tick: "#6a6275",
		spanText: "#ffffff",
		selection: "#0e7490",
		tooltipBackground: "#ffffff",
		tooltipTitle: "#241a2e",
		tooltipBody: "#5a5462",
		tooltipBorder: "rgba(20, 12, 28, 0.15)",
	},
};
