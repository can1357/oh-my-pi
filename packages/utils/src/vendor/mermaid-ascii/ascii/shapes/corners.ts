// ============================================================================
// Corner character lookup table for shape rendering
// ============================================================================
//
// All shapes are rendered as rectangles with distinctive corner characters
// to indicate shape type. This eliminates diagonal characters while keeping
// shapes visually distinguishable.

import type { AsciiNodeShape } from '../types'

/**
 * Corner characters for a shape in both Unicode and ASCII modes.
 */
export interface CornerChars {
  /** Top-left corner */
  tl: string
  /** Top-right corner */
  tr: string
  /** Bottom-left corner */
  bl: string
  /** Bottom-right corner */
  br: string
}

/**
 * Shape corner configuration with both Unicode and ASCII variants.
 */
export interface ShapeCorners {
  unicode: CornerChars
  ascii: CornerChars
}

/**
 * Corner character lookup table for all shape types.
 *
 * Design principles:
 * - All shapes use orthogonal box structure (no diagonals)
 * - Corner characters indicate shape semantics
 * - ASCII fallbacks use available punctuation
 */
export const SHAPE_CORNERS: Record<AsciiNodeShape, ShapeCorners> = {
  // Standard rectangular shapes
  rectangle: {
    unicode: { tl: '┌', tr: '┐', bl: '└', br: '┘' },
    ascii: { tl: '+', tr: '+', bl: '+', br: '+' },
  },
  rounded: {
    unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
    ascii: { tl: '.', tr: '.', bl: "'", br: "'" },
  },

  // Circular shapes - use circle markers at corners
  circle: {
    unicode: { tl: '◯', tr: '◯', bl: '◯', br: '◯' },
    ascii: { tl: 'o', tr: 'o', bl: 'o', br: 'o' },
  },
  doublecircle: {
    unicode: { tl: '◎', tr: '◎', bl: '◎', br: '◎' },
    ascii: { tl: '@', tr: '@', bl: '@', br: '@' },
  },

  // Diamond - decision nodes
  diamond: {
    unicode: { tl: '◇', tr: '◇', bl: '◇', br: '◇' },
    ascii: { tl: '<', tr: '>', bl: '<', br: '>' },
  },

  // Hexagon - process nodes (crop corners — monospace-safe, distinct from rectangle)
  hexagon: {
    unicode: { tl: '⌜', tr: '⌝', bl: '⌞', br: '⌟' },
    ascii: { tl: '*', tr: '*', bl: '*', br: '*' },
  },

  // Stadium/pill shape
  stadium: {
    unicode: { tl: '(', tr: ')', bl: '(', br: ')' },
    ascii: { tl: '(', tr: ')', bl: '(', br: ')' },
  },

  // Subroutine - double vertical bars
  subroutine: {
    unicode: { tl: '╟', tr: '╢', bl: '╟', br: '╢' },
    ascii: { tl: '|', tr: '|', bl: '|', br: '|' },
  },

  // Cylinder/database
  cylinder: {
    unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
    ascii: { tl: '.', tr: '.', bl: "'", br: "'" },
  },

  // Asymmetric/flag - pointer on left side
  asymmetric: {
    unicode: { tl: '▷', tr: '┐', bl: '▷', br: '┘' },
    ascii: { tl: '>', tr: '+', bl: '>', br: '+' },
  },

  // Trapezoid - wider at bottom (top corners slope inward)
  trapezoid: {
    unicode: { tl: '/', tr: '\\', bl: '└', br: '┘' },
    ascii: { tl: '/', tr: '\\', bl: '+', br: '+' },
  },

  // Trapezoid-alt - wider at top (bottom corners slope inward)
  'trapezoid-alt': {
    unicode: { tl: '┌', tr: '┐', bl: '\\', br: '/' },
    ascii: { tl: '+', tr: '+', bl: '\\', br: '/' },
  },

  // State diagram pseudostates (special handling, not corner-based)
  'state-start': {
    unicode: { tl: '●', tr: '●', bl: '●', br: '●' },
    ascii: { tl: '*', tr: '*', bl: '*', br: '*' },
  },
  'state-end': {
    unicode: { tl: '◉', tr: '◉', bl: '◉', br: '◉' },
    ascii: { tl: '@', tr: '@', bl: '@', br: '@' },
  },
}

/**
 * Get corner characters for a shape type.
 */
export function getCorners(shape: AsciiNodeShape, useAscii: boolean): CornerChars {
  const corners = SHAPE_CORNERS[shape] ?? SHAPE_CORNERS.rectangle
  return useAscii ? corners.ascii : corners.unicode
}
