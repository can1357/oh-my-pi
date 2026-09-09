// ============================================================================
// ASCII renderer — type definitions
//
// Ported from AlexanderGrooff/mermaid-ascii (Go).
// These types model the grid-based coordinate system, 2D text canvas,
// and graph structures used by the ASCII/Unicode renderer.
// ============================================================================

import type { NodeShape } from '../types'

// Re-export NodeShape for convenience
export type { NodeShape }

/**
 * Shape type for ASCII rendering — maps parser shapes to ASCII renderers.
 * Most shapes from the parser are supported, with fallback to 'rectangle'.
 */
export type AsciiNodeShape = NodeShape

/** Logical grid coordinate — nodes occupy 3x3 blocks on this grid. */
export interface GridCoord {
  x: number
  y: number
}

/** Character-level coordinate on the 2D text canvas. */
export interface DrawingCoord {
  x: number
  y: number
}

/**
 * Direction constants model positions on a node's 3x3 grid block.
 * Each node occupies grid cells [x..x+2, y..y+2].
 * Directions are offsets into that block, used for edge attachment points.
 *
 *   (0,0) UL   (1,0) Up   (2,0) UR
 *   (0,1) Left (1,1) Mid  (2,1) Right
 *   (0,2) LL   (1,2) Down (2,2) LR
 */
export interface Direction {
  readonly x: number
  readonly y: number
}

export const Up: Direction         = { x: 1, y: 0 }
export const Down: Direction       = { x: 1, y: 2 }
export const Left: Direction       = { x: 0, y: 1 }
export const Right: Direction      = { x: 2, y: 1 }
export const UpperRight: Direction = { x: 2, y: 0 }
export const UpperLeft: Direction  = { x: 0, y: 0 }
export const LowerRight: Direction = { x: 2, y: 2 }
export const LowerLeft: Direction  = { x: 0, y: 2 }
export const Middle: Direction     = { x: 1, y: 1 }

/** All named directions for iteration. */
export const ALL_DIRECTIONS: readonly Direction[] = [
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
]

/**
 * 2D text canvas — column-major (canvas[x][y]).
 * Each cell holds a single character (or space).
 */
export type Canvas = string[][]

/** A node in the ASCII graph, positioned on the grid. */
export interface AsciiNode {
  /** Unique identity key — the original node ID from the parser (e.g. "A", "B"). */
  name: string
  /** Human-readable label for rendering inside the box (e.g. "Web Server"). */
  displayLabel: string
  /** Node shape from the parser (e.g. "rectangle", "diamond", "circle"). */
  shape: AsciiNodeShape
  index: number
  gridCoord: GridCoord | null
  drawingCoord: DrawingCoord | null
  drawing: Canvas | null
  drawn: boolean
  styleClassName: string
  styleClass: AsciiStyleClass
}

/** Style class for colored node text (ported from Go's classDef). */
export interface AsciiStyleClass {
  name: string
  styles: Record<string, string>
}

/** Edge line style for ASCII rendering. */
export type AsciiEdgeStyle = 'solid' | 'dotted' | 'thick'

/** An edge in the ASCII graph, with a routed path. */
export interface AsciiEdge {
  from: AsciiNode
  to: AsciiNode
  text: string
  path: GridCoord[]
  labelLine: GridCoord[]
  startDir: Direction
  endDir: Direction
  /** Line style: solid (default), dotted (-.->) or thick (==>) */
  style: AsciiEdgeStyle
  /** Whether to render an arrowhead at the start (source end) of the edge */
  hasArrowStart: boolean
  /** Whether to render an arrowhead at the end (target end) of the edge */
  hasArrowEnd: boolean
  /** Bundle this edge belongs to (if any). Set during bundling analysis. */
  bundle?: EdgeBundle
  /**
   * For bundled edges: path from source/target to the junction point.
   * The full visual path is: pathToJunction + bundle.sharedPath (for fan-in)
   * or bundle.sharedPath + pathToJunction (for fan-out).
   */
  pathToJunction?: GridCoord[]
}

/** A subgraph container with bounding box for rendering. */
export interface AsciiSubgraph {
  name: string
  nodes: AsciiNode[]
  parent: AsciiSubgraph | null
  children: AsciiSubgraph[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Optional direction override for layout within this subgraph (LR or TD). */
  direction?: 'LR' | 'TD'
}

/** Configuration for ASCII rendering. */
export interface AsciiConfig {
  /** true = ASCII chars (+,-,|), false = Unicode box-drawing (┌,─,│). Default: false */
  useAscii: boolean
  /** Horizontal spacing between nodes. Default: 5 */
  paddingX: number
  /** Vertical spacing between nodes. Default: 5 */
  paddingY: number
  /** Padding inside node boxes. Default: 1 */
  boxBorderPadding: number
  /** Graph direction: "LR" or "TD". */
  graphDirection: 'LR' | 'TD'
}

/** Full ASCII graph state used during layout and rendering. */
export interface AsciiGraph {
  nodes: AsciiNode[]
  edges: AsciiEdge[]
  canvas: Canvas
  /** Role canvas — tracks the role of each character for colored output. */
  roleCanvas: RoleCanvas
  /** Grid occupancy map — maps "x,y" keys to node references. */
  grid: Map<string, AsciiNode>
  columnWidth: Map<number, number>
  rowHeight: Map<number, number>
  subgraphs: AsciiSubgraph[]
  config: AsciiConfig
  /** Offset applied to all drawing coords to accommodate subgraph borders. */
  offsetX: number
  offsetY: number
  /** Edge bundles for parallel link visualization. Set during bundling analysis. */
  bundles: EdgeBundle[]
}

// ============================================================================
// Coordinate helpers
// ============================================================================

export function gridCoordEquals(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y
}

export function drawingCoordEquals(a: DrawingCoord, b: DrawingCoord): boolean {
  return a.x === b.x && a.y === b.y
}

/** Apply a direction offset to a grid coordinate (move into the 3x3 block). */
export function gridCoordDirection(c: GridCoord, dir: Direction): GridCoord {
  return { x: c.x + dir.x, y: c.y + dir.y }
}

/** Key for storing GridCoord in a Map. */
export function gridKey(c: GridCoord): string {
  return `${c.x},${c.y}`
}

/** Default empty style class. */
export const EMPTY_STYLE: AsciiStyleClass = { name: '', styles: {} }

// ============================================================================
// Character role types for colored output
// ============================================================================

/**
 * Role of a character in the ASCII diagram, used for theming.
 * Each role maps to a different color when colors are enabled.
 */
export type CharRole =
  | 'text'      // Node labels, edge labels
  | 'border'    // Node box borders, subgraph borders
  | 'line'      // Edge lines (paths between nodes)
  | 'arrow'     // Arrowheads (▲▼◄► or ^v<>)
  | 'corner'    // Corner characters at path bends
  | 'junction'  // Junction characters (┬┴├┤ where edges meet boxes)

/**
 * Role canvas — parallel to Canvas, tracks the role of each character.
 * Same column-major structure: roleCanvas[x][y] gives the role at (x, y).
 * null means the character has no role (whitespace).
 */
export type RoleCanvas = (CharRole | null)[][]

/**
 * Theme colors for ASCII output — hex color strings.
 * Derived from the SVG theme system for visual consistency.
 */
export interface AsciiTheme {
  /** Text color (node labels, edge labels) */
  fg: string
  /** Box border color (node borders, subgraph borders) */
  border: string
  /** Edge line color (paths between nodes) */
  line: string
  /** Arrowhead color (▲▼◄► or ^v<>) */
  arrow: string
  /** Theme accent color (optional, used by xycharts for series 0) */
  accent?: string
  /** Background color (optional, used by xycharts for dark-mode-aware shading) */
  bg?: string
  /** Corner character color (optional, defaults to line) */
  corner?: string
  /** Junction character color (optional, defaults to border) */
  junction?: string
}

/** Color mode for output. */
export type ColorMode =
  | 'none'      // No colors (plain text)
  | 'ansi16'    // 16-color ANSI (basic terminals)
  | 'ansi256'   // 256-color ANSI (xterm)
  | 'truecolor' // 24-bit RGB (modern terminals)
  | 'html'      // HTML <span> tags with inline color styles (browsers)

// ============================================================================
// Edge bundling types
// ============================================================================

/**
 * Edge bundle — groups edges that share a common source or target.
 * Used to visually merge parallel links before they reach the shared node.
 *
 * For fan-in (A & B --> C): multiple sources converge to one target.
 * For fan-out (A --> B & C): one source diverges to multiple targets.
 */
export interface EdgeBundle {
  /** Bundle type: fan-in = many→one, fan-out = one→many */
  type: 'fan-in' | 'fan-out'
  /** Edges in this bundle */
  edges: AsciiEdge[]
  /** The common node (target for fan-in, source for fan-out) */
  sharedNode: AsciiNode
  /** The non-shared nodes (sources for fan-in, targets for fan-out) */
  otherNodes: AsciiNode[]
  /** Junction point where edges merge/split — set during routing */
  junctionPoint: GridCoord | null
  /** Path from junction to shared node (drawn once for all edges) */
  sharedPath: GridCoord[]
  /** Direction when entering/exiting the junction */
  junctionDir: Direction
  /** Direction when entering/exiting the shared node */
  sharedNodeDir: Direction
}
