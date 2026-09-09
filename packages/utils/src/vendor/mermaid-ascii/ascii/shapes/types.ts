// ============================================================================
// Shape renderer types — interface for pluggable ASCII shape renderers
// ============================================================================

import type { Canvas, DrawingCoord, Direction, AsciiNodeShape } from '../types'

/**
 * Dimensions calculated for a shape, used by layout and rendering.
 */
export interface ShapeDimensions {
  /** Total width in characters including borders */
  width: number
  /** Total height in characters including borders */
  height: number
  /** Label area bounds (where text can be placed) */
  labelArea: {
    x: number
    y: number
    width: number
    height: number
  }
  /** Grid column widths for the 3-column layout [left, center, right] */
  gridColumns: [number, number, number]
  /** Grid row heights for the 3-row layout [top, middle, bottom] */
  gridRows: [number, number, number]
}

/**
 * Options passed to shape renderers.
 */
export interface ShapeRenderOptions {
  /** Use ASCII chars (+,-,|) vs Unicode box-drawing (┌,─,│) */
  useAscii: boolean
  /** Padding inside the shape */
  padding: number
}

/**
 * Interface for pluggable shape renderers.
 * Each shape type implements this interface.
 */
export interface ShapeRenderer {
  /**
   * Calculate dimensions for this shape given a label.
   * Used during layout to determine node size.
   */
  getDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions

  /**
   * Render the shape to a canvas.
   * Returns a standalone canvas containing just the shape.
   */
  render(
    label: string,
    dimensions: ShapeDimensions,
    options: ShapeRenderOptions
  ): Canvas

  /**
   * Get the edge attachment point for a given direction.
   * Used by edge routing to determine where edges connect.
   */
  getAttachmentPoint(
    dir: Direction,
    dimensions: ShapeDimensions,
    baseCoord: DrawingCoord
  ): DrawingCoord
}

/**
 * Registry of shape renderers keyed by shape type.
 */
export type ShapeRegistry = Map<AsciiNodeShape, ShapeRenderer>
