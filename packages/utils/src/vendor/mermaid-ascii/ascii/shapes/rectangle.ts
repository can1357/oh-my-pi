// ============================================================================
// Rectangle shape renderer — standard box with corners
// ============================================================================
//
// This module provides the base box rendering used by all rectangular shapes.
// The renderBox() function accepts custom corner characters, allowing different
// shapes to reuse the same rendering logic with different visual markers.

import type { Canvas, DrawingCoord, Direction } from '../types'
import { Up, Down, Left, Right, UpperLeft, UpperRight, LowerLeft, LowerRight, Middle } from '../types'
import { mkCanvas } from '../canvas'
import { splitLines } from '../multiline-utils'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions } from './types'
import { dirEquals } from '../edge-routing'
import { type CornerChars, getCorners } from './corners'
import { displayWidth, toCells } from '../../text-metrics'

// ============================================================================
// Shared dimension calculation
// ============================================================================

/**
 * Calculate standard box dimensions for any rectangular shape.
 * Used by rectangle, circle, diamond, hexagon, etc.
 */
export function getBoxDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions {
  const lines = splitLines(label)
  const maxLineWidth = Math.max(...lines.map(l => displayWidth(l)), 0)
  const lineCount = lines.length

  // Width: 2*padding + maxLineWidth + 2 border chars
  const innerWidth = 2 * options.padding + maxLineWidth
  const width = innerWidth + 2

  // Height: lineCount + 2*padding + 2 border chars
  // Ensure innerHeight is odd for symmetric vertical centering
  const rawInnerHeight = lineCount + 2 * options.padding
  const innerHeight = rawInnerHeight % 2 === 0 ? rawInnerHeight + 1 : rawInnerHeight
  const height = innerHeight + 2

  return {
    width,
    height,
    labelArea: {
      x: 1 + options.padding,
      y: 1 + options.padding,
      width: maxLineWidth,
      height: lineCount,
    },
    // Grid layout: [border=1, content, border=1]
    gridColumns: [1, innerWidth, 1],
    gridRows: [1, innerHeight, 1],
  }
}

// ============================================================================
// Shared box rendering
// ============================================================================

/**
 * Render a box with custom corner characters.
 * This is the core rendering function used by all rectangular shapes.
 *
 * @param label - Text to display in the box
 * @param dimensions - Pre-calculated dimensions
 * @param corners - Corner characters (tl, tr, bl, br)
 * @param useAscii - Whether to use ASCII or Unicode for lines
 */
export function renderBox(
  label: string,
  dimensions: ShapeDimensions,
  corners: CornerChars,
  useAscii: boolean
): Canvas {
  const { width, height } = dimensions
  const canvas = mkCanvas(width - 1, height - 1)

  const from = { x: 0, y: 0 }
  const to = { x: width - 1, y: height - 1 }

  // Line characters
  const hLine = useAscii ? '-' : '─'
  const vLine = useAscii ? '|' : '│'

  // Draw horizontal lines (top and bottom)
  for (let x = from.x + 1; x < to.x; x++) {
    canvas[x]![from.y] = hLine
    canvas[x]![to.y] = hLine
  }

  // Draw vertical lines (left and right)
  for (let y = from.y + 1; y < to.y; y++) {
    canvas[from.x]![y] = vLine
    canvas[to.x]![y] = vLine
  }

  // Draw corners
  canvas[from.x]![from.y] = corners.tl
  canvas[to.x]![from.y] = corners.tr
  canvas[from.x]![to.y] = corners.bl
  canvas[to.x]![to.y] = corners.br

  // Center the multi-line label
  const lines = splitLines(label)
  const w = width - 1  // Match original grid-based width calculation
  const h = height - 1
  const centerY = Math.floor(h / 2)
  const startY = centerY - Math.floor((lines.length - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const cells = toCells(line)
    const textX = Math.floor(w / 2) - Math.ceil(cells.length / 2) + 1
    for (let j = 0; j < cells.length; j++) {
      const x = textX + j
      const y = startY + i
      if (x >= 0 && x < canvas.length && y >= 0 && y < canvas[0]!.length) {
        canvas[x]![y] = cells[j]!
      }
    }
  }

  return canvas
}

// ============================================================================
// Shared attachment point calculation
// ============================================================================

/**
 * Calculate edge attachment point for rectangular shapes.
 * All box-based shapes use the same attachment logic.
 */
export function getBoxAttachmentPoint(
  dir: Direction,
  dimensions: ShapeDimensions,
  baseCoord: DrawingCoord
): DrawingCoord {
  const { width, height } = dimensions
  const centerX = baseCoord.x + Math.floor(width / 2)
  const centerY = baseCoord.y + Math.floor(height / 2)

  if (dirEquals(dir, Up)) return { x: centerX, y: baseCoord.y }
  if (dirEquals(dir, Down)) return { x: centerX, y: baseCoord.y + height - 1 }
  if (dirEquals(dir, Left)) return { x: baseCoord.x, y: centerY }
  if (dirEquals(dir, Right)) return { x: baseCoord.x + width - 1, y: centerY }
  if (dirEquals(dir, UpperLeft)) return { x: baseCoord.x, y: baseCoord.y }
  if (dirEquals(dir, UpperRight)) return { x: baseCoord.x + width - 1, y: baseCoord.y }
  if (dirEquals(dir, LowerLeft)) return { x: baseCoord.x, y: baseCoord.y + height - 1 }
  if (dirEquals(dir, LowerRight)) return { x: baseCoord.x + width - 1, y: baseCoord.y + height - 1 }
  // Middle
  return { x: centerX, y: centerY }
}

// ============================================================================
// Rectangle renderer
// ============================================================================

/**
 * Rectangle shape renderer — the default box shape.
 * Renders as:
 *   ┌─────────┐
 *   │  Label  │
 *   └─────────┘
 */
export const rectangleRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label: string, dimensions: ShapeDimensions, options: ShapeRenderOptions): Canvas {
    const corners = getCorners('rectangle', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}
