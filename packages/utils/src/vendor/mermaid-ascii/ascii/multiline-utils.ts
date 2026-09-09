// ============================================================================
// ASCII renderer — multi-line text utilities
//
// Shared utilities for handling multi-line labels (containing \n from <br> tags)
// in ASCII/Unicode rendering. Provides consistent text splitting, sizing, and
// centered rendering across all diagram types.
// ============================================================================

import type { Canvas } from './types'
import { drawText } from './canvas'
import { displayWidth } from '../text-metrics'

/**
 * Split a label into lines.
 * Labels are already normalized by parsers (br tags → \n).
 */
export function splitLines(label: string): string[] {
  return label.split('\n')
}

/**
 * Get the maximum line width for sizing calculations.
 * Used to determine column widths for multi-line labels.
 */
export function maxLineWidth(label: string): number {
  const lines = splitLines(label)
  return Math.max(...lines.map(l => displayWidth(l)), 0)
}

/**
 * Get the number of lines for height calculations.
 * Used to determine row heights for multi-line labels.
 */
export function lineCount(label: string): number {
  return splitLines(label).length
}

/**
 * Draw multi-line text centered at (cx, cy).
 * Expands vertically from the center point.
 * Each line is horizontally centered independently.
 */
export function drawMultilineTextCentered(
  canvas: Canvas,
  label: string,
  cx: number,
  cy: number
): void {
  const lines = splitLines(label)
  const totalHeight = lines.length
  // Center vertically: start y positions lines evenly around cy
  const startY = cy - Math.floor((totalHeight - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Center each line horizontally
    const startX = cx - Math.floor(displayWidth(line) / 2)
    // Force overwrite for node labels (they take priority)
    drawText(canvas, { x: startX, y: startY + i }, line, true)
  }
}

/**
 * Draw multi-line text left-aligned starting at (x, y).
 * Each subsequent line is placed one row below.
 */
export function drawMultilineTextLeft(
  canvas: Canvas,
  label: string,
  x: number,
  y: number
): void {
  const lines = splitLines(label)
  for (let i = 0; i < lines.length; i++) {
    // Force overwrite for node labels (they take priority)
    drawText(canvas, { x, y: y + i }, lines[i]!, true)
  }
}
