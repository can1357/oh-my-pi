// ============================================================================
// Shape registry — pluggable ASCII shape renderers
// ============================================================================

import type { AsciiNodeShape, Canvas, DrawingCoord, Direction } from '../types'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions, ShapeRegistry } from './types'

// Import all shape renderers
import { rectangleRenderer } from './rectangle'
import { diamondRenderer } from './diamond'
import { circleRenderer } from './circle'
import { stateStartRenderer, stateEndRenderer } from './state'
import { roundedRenderer } from './rounded'
import { stadiumRenderer } from './stadium'
import { hexagonRenderer } from './hexagon'
import {
  subroutineRenderer,
  doublecircleRenderer,
  cylinderRenderer,
  asymmetricRenderer,
  trapezoidRenderer,
  trapezoidAltRenderer,
} from './special'

// Re-export types
export type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions, ShapeRegistry }

/**
 * Global shape registry — maps shape types to their renderers.
 * Rectangle is the default fallback for unregistered shapes.
 */
export const shapeRegistry: ShapeRegistry = new Map<AsciiNodeShape, ShapeRenderer>([
  // Core shapes
  ['rectangle', rectangleRenderer],
  ['rounded', roundedRenderer],
  ['diamond', diamondRenderer],
  ['stadium', stadiumRenderer],
  ['circle', circleRenderer],

  // Batch 1 additions
  ['subroutine', subroutineRenderer],
  ['doublecircle', doublecircleRenderer],
  ['hexagon', hexagonRenderer],

  // Batch 2 additions
  ['cylinder', cylinderRenderer],
  ['asymmetric', asymmetricRenderer],
  ['trapezoid', trapezoidRenderer],
  ['trapezoid-alt', trapezoidAltRenderer],

  // State diagram pseudo-states
  ['state-start', stateStartRenderer],
  ['state-end', stateEndRenderer],
])

/**
 * Get the renderer for a shape type, falling back to rectangle.
 */
export function getShapeRenderer(shape: AsciiNodeShape): ShapeRenderer {
  return shapeRegistry.get(shape) ?? rectangleRenderer
}

/**
 * Render a node shape to a canvas.
 * This is the main entry point for shape rendering.
 */
export function renderShape(
  shape: AsciiNodeShape,
  label: string,
  options: ShapeRenderOptions
): Canvas {
  const renderer = getShapeRenderer(shape)
  const dimensions = renderer.getDimensions(label, options)
  return renderer.render(label, dimensions, options)
}

/**
 * Get dimensions for a shape given a label.
 * Used during layout to determine node size.
 */
export function getShapeDimensions(
  shape: AsciiNodeShape,
  label: string,
  options: ShapeRenderOptions
): ShapeDimensions {
  const renderer = getShapeRenderer(shape)
  return renderer.getDimensions(label, options)
}

/**
 * Get edge attachment point for a shape.
 */
export function getShapeAttachmentPoint(
  shape: AsciiNodeShape,
  dir: Direction,
  dimensions: ShapeDimensions,
  baseCoord: DrawingCoord
): DrawingCoord {
  const renderer = getShapeRenderer(shape)
  return renderer.getAttachmentPoint(dir, dimensions, baseCoord)
}
