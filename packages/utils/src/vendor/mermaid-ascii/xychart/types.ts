// ============================================================================
// XY Chart types
//
// Models the parsed and positioned representations of a Mermaid xychart-beta
// diagram. Supports bar charts, line charts, and combinations with categorical
// or numeric x-axes.
// ============================================================================

/** Parsed XY chart — logical structure from mermaid text */
export interface XYChart {
  /** Optional chart title */
  title?: string
  /** Chart orientation: vertical (default) or horizontal */
  horizontal: boolean
  /** X-axis configuration */
  xAxis: XYAxis
  /** Y-axis configuration */
  yAxis: XYAxis
  /** Data series (bar and/or line) */
  series: XYChartSeries[]
}

/** Axis configuration — categorical (labels) or numeric (range) */
export interface XYAxis {
  /** Optional axis title/label */
  title?: string
  /** Categorical labels (e.g., ["jan", "feb", "mar"]) — mutually exclusive with range */
  categories?: string[]
  /** Numeric range — mutually exclusive with categories */
  range?: { min: number; max: number }
}

/** A single data series (bar or line) */
export interface XYChartSeries {
  /** Series type */
  type: 'bar' | 'line'
  /** Data values — one per category, or evenly spaced across numeric range */
  data: number[]
}

// ============================================================================
// Positioned XY chart — ready for SVG rendering
// ============================================================================

export interface PositionedXYChart {
  width: number
  height: number
  /** Whether this is a horizontal (rotated) chart */
  horizontal?: boolean
  /** Title text and position (if present) */
  title?: PositionedTitle
  /** Positioned x-axis with tick marks and labels */
  xAxis: PositionedAxis
  /** Positioned y-axis with tick marks and labels */
  yAxis: PositionedAxis
  /** The plot area bounds (inside axes) */
  plotArea: PlotArea
  /** Positioned bar groups */
  bars: PositionedBar[]
  /** Positioned line polylines */
  lines: PositionedLine[]
  /** Horizontal grid lines for readability */
  gridLines: GridLine[]
  /** Legend items (shown when multiple series) */
  legend: LegendItem[]
}

export interface LegendItem {
  /** Display label */
  label: string
  /** Position of the swatch/icon */
  x: number
  y: number
  /** Series type determines swatch shape (rect for bar, line+dot for line) */
  type: 'bar' | 'line'
  /** Series index within its type (for layout grouping) */
  seriesIndex: number
  /** Global color index across all series (for unified color assignment) */
  colorIndex: number
}

export interface PositionedTitle {
  text: string
  x: number
  y: number
}

export interface PositionedAxis {
  /** Optional axis title text and position */
  title?: { text: string; x: number; y: number; rotate?: number }
  /** Tick positions along the axis */
  ticks: AxisTick[]
  /** Axis line: start and end coordinates */
  line: { x1: number; y1: number; x2: number; y2: number }
}

export interface AxisTick {
  /** Label text for this tick */
  label: string
  /** Position of the tick mark on the axis */
  x: number
  y: number
  /** End of the tick mark (short perpendicular line) */
  tx: number
  ty: number
  /** Label anchor position */
  labelX: number
  labelY: number
  /** Text anchor for label */
  textAnchor: 'start' | 'middle' | 'end'
}

export interface PlotArea {
  x: number
  y: number
  width: number
  height: number
}

export interface PositionedBar {
  /** Bar rectangle in SVG coordinates */
  x: number
  y: number
  width: number
  height: number
  /** Original data value */
  value: number
  /** Category label for this bar (e.g. "Jan") */
  label?: string
  /** Series index within bar type (for layout grouping) */
  seriesIndex: number
  /** Global color index across all series */
  colorIndex: number
}

export interface PositionedLine {
  /** Polyline points */
  points: Array<{ x: number; y: number; value: number; label?: string }>
  /** Series index within line type (for layout grouping) */
  seriesIndex: number
  /** Global color index across all series */
  colorIndex: number
}

export interface GridLine {
  x1: number
  y1: number
  x2: number
  y2: number
}
