// ============================================================================
// Special shape renderers — subroutine, doublecircle, cylinder, etc.
// ============================================================================
//
// Some shapes have unique internal structure (subroutine, cylinder) and keep
// custom rendering. Others use the corner decorator pattern for simplicity.

import type { Canvas, DrawingCoord, Direction } from '../types'
import { Up, Down, Left, Right } from '../types'
import { mkCanvas } from '../canvas'
import { splitLines } from '../multiline-utils'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions } from './types'
import { dirEquals } from '../edge-routing'
import { getBoxDimensions, renderBox, getBoxAttachmentPoint } from './rectangle'
import { getCorners } from './corners'
import { displayWidth, toCells } from '../../text-metrics'

// ============================================================================
// Subroutine — keeps custom double-border rendering
// ============================================================================

/**
 * Subroutine shape renderer — double-bordered rectangle.
 * Renders as:
 *   ┌┬─────────┬┐
 *   ││  Label  ││
 *   └┴─────────┴┘
 */
export const subroutineRenderer: ShapeRenderer = {
  getDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions {
    const lines = splitLines(label)
    const maxLineWidth = Math.max(...lines.map(l => displayWidth(l)), 0)
    const lineCount = lines.length

    const innerWidth = 2 * options.padding + maxLineWidth
    const width = innerWidth + 4  // Double borders on each side
    const innerHeight = lineCount + 2 * options.padding
    const height = innerHeight + 2

    return {
      width,
      height,
      labelArea: {
        x: 2 + options.padding,
        y: 1 + options.padding,
        width: maxLineWidth,
        height: lineCount,
      },
      gridColumns: [2, innerWidth, 2],
      gridRows: [1, innerHeight, 1],
    }
  },

  render(label: string, dimensions: ShapeDimensions, options: ShapeRenderOptions): Canvas {
    const { width, height } = dimensions
    const canvas = mkCanvas(width - 1, height - 1)

    const hChar = options.useAscii ? '-' : '─'
    const vChar = options.useAscii ? '|' : '│'

    // Top border
    canvas[0]![0] = options.useAscii ? '+' : '┌'
    canvas[1]![0] = options.useAscii ? '+' : '┬'
    for (let x = 2; x < width - 2; x++) canvas[x]![0] = hChar
    canvas[width - 2]![0] = options.useAscii ? '+' : '┬'
    canvas[width - 1]![0] = options.useAscii ? '+' : '┐'

    // Sides with double border
    for (let y = 1; y < height - 1; y++) {
      canvas[0]![y] = vChar
      canvas[1]![y] = vChar
      canvas[width - 2]![y] = vChar
      canvas[width - 1]![y] = vChar
    }

    // Bottom border
    canvas[0]![height - 1] = options.useAscii ? '+' : '└'
    canvas[1]![height - 1] = options.useAscii ? '+' : '┴'
    for (let x = 2; x < width - 2; x++) canvas[x]![height - 1] = hChar
    canvas[width - 2]![height - 1] = options.useAscii ? '+' : '┴'
    canvas[width - 1]![height - 1] = options.useAscii ? '+' : '┘'

    // Center the label
    const lines = splitLines(label)
    const centerY = Math.floor(height / 2)
    const startY = centerY - Math.floor((lines.length - 1) / 2)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const cells = toCells(line)
      const textX = Math.floor(width / 2) - Math.floor(cells.length / 2)
      for (let j = 0; j < cells.length; j++) {
        const x = textX + j
        const y = startY + i
        if (x > 1 && x < width - 2 && y > 0 && y < height - 1) {
          canvas[x]![y] = cells[j]!
        }
      }
    }

    return canvas
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}

// ============================================================================
// Double circle — uses corner decorators
// ============================================================================

/**
 * Double circle shape renderer.
 * Uses double circle markers (◎) at corners.
 *
 * Renders as:
 *   ◎─────────◎
 *   │  Label  │
 *   ◎─────────◎
 */
export const doublecircleRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label, dimensions, options) {
    const corners = getCorners('doublecircle', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}

// ============================================================================
// Cylinder — keeps custom rendering for database appearance
// ============================================================================

/**
 * Cylinder shape renderer — database symbol.
 * Renders as:
 *   ╭─────╮
 *   │─────│
 *   │ DB  │
 *   │─────│
 *   ╰─────╯
 */
export const cylinderRenderer: ShapeRenderer = {
  getDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions {
    const lines = splitLines(label)
    const maxLineWidth = Math.max(...lines.map(l => displayWidth(l)), 0)
    const lineCount = lines.length

    const innerWidth = 2 * options.padding + maxLineWidth
    const width = innerWidth + 2
    const innerHeight = lineCount + 2 * options.padding + 2  // Extra for curved top/bottom
    const height = innerHeight + 2

    return {
      width,
      height,
      labelArea: {
        x: 1 + options.padding,
        y: 2 + options.padding,
        width: maxLineWidth,
        height: lineCount,
      },
      gridColumns: [1, innerWidth, 1],
      gridRows: [2, innerHeight - 2, 2],
    }
  },

  render(label: string, dimensions: ShapeDimensions, options: ShapeRenderOptions): Canvas {
    const { width, height } = dimensions
    const canvas = mkCanvas(width - 1, height - 1)

    const hChar = options.useAscii ? '-' : '─'
    const vChar = options.useAscii ? '|' : '│'

    // Top ellipse
    canvas[0]![0] = options.useAscii ? '.' : '╭'
    for (let x = 1; x < width - 1; x++) canvas[x]![0] = hChar
    canvas[width - 1]![0] = options.useAscii ? '.' : '╮'

    // Second row - bottom of top ellipse
    canvas[0]![1] = vChar
    for (let x = 1; x < width - 1; x++) canvas[x]![1] = hChar
    canvas[width - 1]![1] = vChar

    // Middle section
    for (let y = 2; y < height - 2; y++) {
      canvas[0]![y] = vChar
      canvas[width - 1]![y] = vChar
    }

    // Second to last row - top of bottom ellipse
    canvas[0]![height - 2] = vChar
    for (let x = 1; x < width - 1; x++) canvas[x]![height - 2] = hChar
    canvas[width - 1]![height - 2] = vChar

    // Bottom ellipse
    canvas[0]![height - 1] = options.useAscii ? '\'' : '╰'
    for (let x = 1; x < width - 1; x++) canvas[x]![height - 1] = hChar
    canvas[width - 1]![height - 1] = options.useAscii ? '\'' : '╯'

    // Center the label
    const lines = splitLines(label)
    const centerY = Math.floor(height / 2)
    const startY = centerY - Math.floor((lines.length - 1) / 2)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const cells = toCells(line)
      const textX = Math.floor(width / 2) - Math.floor(cells.length / 2)
      for (let j = 0; j < cells.length; j++) {
        const x = textX + j
        const y = startY + i
        if (x > 0 && x < width - 1 && y > 1 && y < height - 2) {
          canvas[x]![y] = cells[j]!
        }
      }
    }

    return canvas
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}

// ============================================================================
// Asymmetric (flag) — uses corner decorators
// ============================================================================

/**
 * Asymmetric (flag/banner) shape renderer.
 * Uses arrow markers (▷) on left corners.
 *
 * Renders as:
 *   ▷─────────┐
 *   │  Label  │
 *   ▷─────────┘
 */
export const asymmetricRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label, dimensions, options) {
    const corners = getCorners('asymmetric', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}

// ============================================================================
// Trapezoid — uses corner decorators instead of diagonal sides
// ============================================================================

/**
 * Trapezoid shape renderer — wider at bottom.
 * Uses slope markers (◸◹) on top corners.
 *
 * Renders as:
 *   ◸─────────◹
 *   │  Label  │
 *   └─────────┘
 */
export const trapezoidRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label, dimensions, options) {
    const corners = getCorners('trapezoid', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}

// ============================================================================
// Trapezoid-alt — uses corner decorators instead of diagonal sides
// ============================================================================

/**
 * Trapezoid-alt shape renderer — wider at top.
 * Uses slope markers (◺◿) on bottom corners.
 *
 * Renders as:
 *   ┌─────────┐
 *   │  Label  │
 *   ◺─────────◿
 */
export const trapezoidAltRenderer: ShapeRenderer = {
  getDimensions: getBoxDimensions,

  render(label, dimensions, options) {
    const corners = getCorners('trapezoid-alt', options.useAscii)
    return renderBox(label, dimensions, corners, options.useAscii)
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}
