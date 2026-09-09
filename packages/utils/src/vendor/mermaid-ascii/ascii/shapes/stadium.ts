// ============================================================================
// Stadium (pill) shape renderer — special parentheses-based rendering
// ============================================================================
//
// Stadium has unique rendering: single-line is inline `(Label)`, multi-line
// uses parentheses or rounded corners. This differs from other shapes that
// use corner decorators with box lines.

import type { Canvas, DrawingCoord, Direction } from '../types'
import { mkCanvas } from '../canvas'
import { splitLines } from '../multiline-utils'
import type { ShapeRenderer, ShapeDimensions, ShapeRenderOptions } from './types'
import { getBoxAttachmentPoint } from './rectangle'
import { displayWidth, toCells } from '../../text-metrics'

/**
 * Stadium (pill) shape renderer.
 *
 * Single-line:  ( Label )
 *
 * Multi-line unicode:
 *   ╭──────────╮
 *   │  Label   │
 *   ╰──────────╯
 *
 * Multi-line ASCII:
 *   (----------)
 *   (  Label   )
 *   (----------)
 */
export const stadiumRenderer: ShapeRenderer = {
  getDimensions(label: string, options: ShapeRenderOptions): ShapeDimensions {
    const lines = splitLines(label)
    const maxLineWidth = Math.max(...lines.map(l => displayWidth(l)), 0)
    const lineCount = lines.length

    const innerWidth = 2 * options.padding + maxLineWidth
    const width = innerWidth + 4  // Extra for rounded ends
    const innerHeight = lineCount + 2 * options.padding
    const height = Math.max(innerHeight + 2, 3)

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

    const centerY = Math.floor(height / 2)
    const hChar = options.useAscii ? '-' : '─'

    if (height === 3) {
      // Single row pill: (  Label  )
      canvas[0]![centerY] = '('
      canvas[width - 1]![centerY] = ')'
    } else if (!options.useAscii) {
      // Multi-row stadium with rounded corners (unicode)
      canvas[0]![0] = '╭'
      for (let x = 1; x < width - 1; x++) canvas[x]![0] = hChar
      canvas[width - 1]![0] = '╮'

      for (let y = 1; y < height - 1; y++) {
        canvas[0]![y] = '│'
        canvas[width - 1]![y] = '│'
      }

      canvas[0]![height - 1] = '╰'
      for (let x = 1; x < width - 1; x++) canvas[x]![height - 1] = hChar
      canvas[width - 1]![height - 1] = '╯'
    } else {
      // Multi-row stadium ASCII — parentheses on all sides
      for (let y = 0; y < height; y++) {
        canvas[0]![y] = '('
        canvas[width - 1]![y] = ')'
      }
      for (let x = 1; x < width - 1; x++) {
        canvas[x]![0] = hChar
        canvas[x]![height - 1] = hChar
      }
    }

    // Center the label
    const lines = splitLines(label)
    const startY = centerY - Math.floor((lines.length - 1) / 2)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const cells = toCells(line)
      const textX = Math.floor(width / 2) - Math.floor(cells.length / 2)
      for (let j = 0; j < cells.length; j++) {
        const x = textX + j
        const y = startY + i
        if (x > 0 && x < width - 1 && y >= 0 && y < height) {
          canvas[x]![y] = cells[j]!
        }
      }
    }

    return canvas
  },

  getAttachmentPoint: getBoxAttachmentPoint,
}
