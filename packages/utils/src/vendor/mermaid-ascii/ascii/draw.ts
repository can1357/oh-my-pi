// ============================================================================
// ASCII renderer — drawing operations
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/draw.go + cmd/arrow.go.
// Contains all visual rendering: boxes, lines, arrows, corners,
// subgraphs, labels, and the top-level draw orchestrator.
// ============================================================================

import type {
  Canvas, DrawingCoord, GridCoord, Direction,
  AsciiGraph, AsciiNode, AsciiEdge, AsciiSubgraph, AsciiEdgeStyle, EdgeBundle,
} from './types'
import {
  Up, Down, Left, Right, UpperLeft, UpperRight, LowerLeft, LowerRight, Middle,
  drawingCoordEquals,
} from './types'
import { mkCanvas, copyCanvas, getCanvasSize, mergeCanvases, drawText, mkRoleCanvas, setRole, mergeRoleCanvases } from './canvas'
import type { RoleCanvas, CharRole } from './types'
import { determineDirection, dirEquals } from './edge-routing'
import { gridToDrawingCoord, lineToDrawing } from './grid'
import { splitLines } from './multiline-utils'
import { getCorners } from './shapes/corners'
import { getShapeAttachmentPoint } from './shapes/index'
import { displayWidth, LABEL_SPACE, toCells, WIDE_PAD } from '../text-metrics'

// ============================================================================
// Node drawing — renders a node using shape-aware rendering
// ============================================================================

/**
 * Draw a node using its shape type.
 * Returns a standalone canvas containing the rendered shape.
 *
 * For basic shapes (rectangle, rounded), uses grid-determined dimensions
 * to ensure consistent sizing across nodes in the same column.
 * For special shapes (diamond, circle, state pseudo-states, etc.),
 * uses shape-specific dimension calculation but centers the content
 * within the grid cell dimensions to ensure proper vertical alignment.
 */
export function drawNode(node: AsciiNode, graph: AsciiGraph): Canvas {
  // All shapes use grid-determined dimensions to fill their allocated space.
  // This ensures consistent sizing across nodes and eliminates gaps between
  // nodes and subgraph borders. All shapes are rectangles with distinctive
  // corner characters (defined in corners.ts) to indicate shape type.
  return drawBoxWithGridDimensions(node, graph)
}

/**
 * Draw a box shape using grid-determined dimensions.
 * This ensures consistent sizing when multiple nodes share a column,
 * and eliminates gaps between nodes and subgraph borders by filling
 * the entire allocated grid space.
 *
 * All shapes are rendered as rectangles with distinctive corner characters
 * (defined in corners.ts) to indicate shape type.
 */
function drawBoxWithGridDimensions(node: AsciiNode, graph: AsciiGraph): Canvas {
  const gc = node.gridCoord!
  const useAscii = graph.config.useAscii

  // Width spans 2 columns (border + content) - matching original behavior
  let w = 0
  for (let i = 0; i < 2; i++) {
    w += graph.columnWidth.get(gc.x + i) ?? 0
  }
  // Height spans 2 rows (border + content)
  let h = 0
  for (let i = 0; i < 2; i++) {
    h += graph.rowHeight.get(gc.y + i) ?? 0
  }

  const from: DrawingCoord = { x: 0, y: 0 }
  const to: DrawingCoord = { x: w, y: h }
  const box = mkCanvas(Math.max(from.x, to.x), Math.max(from.y, to.y))

  // Get corner characters for this shape type
  const corners = getCorners(node.shape, useAscii)

  const isStateStart = node.shape === 'state-start'
  const isStateEnd = node.shape === 'state-end'
  const hChar = useAscii ? (isStateEnd ? '=' : '-') : (isStateEnd ? '═' : '─')
  const vChar = useAscii ? (isStateEnd ? '‖' : '|') : (isStateEnd ? '║' : '│')

  const stateStartCorners = useAscii
    ? { tl: '+', tr: '+', bl: '+', br: '+' }
    : { tl: '╭', tr: '╮', bl: '╰', br: '╯' }
  const stateEndCorners = useAscii
    ? { tl: '#', tr: '#', bl: '#', br: '#' }
    : { tl: '╔', tr: '╗', bl: '╚', br: '╝' }
  const effectiveCorners = isStateEnd ? stateEndCorners : isStateStart ? stateStartCorners : corners

  // Draw box border with shape-specific corners
  for (let x = from.x + 1; x < to.x; x++) box[x]![from.y] = hChar
  for (let x = from.x + 1; x < to.x; x++) box[x]![to.y] = hChar
  for (let y = from.y + 1; y < to.y; y++) box[from.x]![y] = vChar
  for (let y = from.y + 1; y < to.y; y++) box[to.x]![y] = vChar
  box[from.x]![from.y] = effectiveCorners.tl
  box[to.x]![from.y] = effectiveCorners.tr
  box[from.x]![to.y] = effectiveCorners.bl
  box[to.x]![to.y] = effectiveCorners.br

  // Pseudostates have no source label; restore their UML marker explicitly.
  const label = node.displayLabel || (isStateStart ? (useAscii ? '*' : '●') : isStateEnd ? (useAscii ? '*' : '◎') : '')
  const lines = splitLines(label)
  const textCenterY = from.y + Math.floor(h / 2)
  const startY = textCenterY - Math.floor((lines.length - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const cells = toCells(line)
    const textX = from.x + Math.floor(w / 2) - Math.ceil(cells.length / 2) + 1
    for (let j = 0; j < cells.length; j++) {
      if (textX + j >= 0 && textX + j < box.length && startY + i >= 0 && startY + i < box[0]!.length) {
        box[textX + j]![startY + i] = cells[j]!
      }
    }
  }

  return box
}

/**
 * Draw a node box with centered label text.
 * Returns a standalone canvas containing just the box.
 * Box size is determined by the grid column/row sizes for the node's position.
 */
export function drawBox(node: AsciiNode, graph: AsciiGraph): Canvas {
  return drawNode(node, graph)
}

// ============================================================================
// Multi-section box drawing — for class and ER diagram nodes
// ============================================================================

/**
 * Draw a multi-section box with horizontal dividers between sections.
 * Used by class diagrams (header | attributes | methods) and ER diagrams (header | attributes).
 * Each section is an array of text lines to render left-aligned with padding.
 *
 * @param sections - Array of sections, each section is an array of text lines
 * @param useAscii - true for ASCII chars, false for Unicode box-drawing
 * @param padding - horizontal padding inside the box (default 1)
 * @returns A standalone Canvas containing the multi-section box
 */
export function drawMultiBox(
  sections: string[][],
  useAscii: boolean,
  padding: number = 1,
): Canvas {
  // Compute width: widest line across all sections + 2*padding + 2 border chars
  let maxTextWidth = 0
  for (const section of sections) {
    for (const line of section) {
      maxTextWidth = Math.max(maxTextWidth, displayWidth(line))
    }
  }
  const innerWidth = maxTextWidth + 2 * padding
  const boxWidth = innerWidth + 2 // +2 for left/right border

  // Compute height: sum of all section line counts + dividers + 2 border rows
  let totalLines = 0
  for (const section of sections) {
    totalLines += Math.max(section.length, 1) // at least 1 row per section
  }
  const numDividers = sections.length - 1
  const boxHeight = totalLines + numDividers + 2 // +2 for top/bottom border

  // Box-drawing characters
  const hLine = useAscii ? '-' : '─'
  const vLine = useAscii ? '|' : '│'
  const tl = useAscii ? '+' : '┌'
  const tr = useAscii ? '+' : '┐'
  const bl = useAscii ? '+' : '└'
  const br = useAscii ? '+' : '┘'
  const divL = useAscii ? '+' : '├'
  const divR = useAscii ? '+' : '┤'

  const canvas = mkCanvas(boxWidth - 1, boxHeight - 1)

  // Top border
  canvas[0]![0] = tl
  for (let x = 1; x < boxWidth - 1; x++) canvas[x]![0] = hLine
  canvas[boxWidth - 1]![0] = tr

  // Bottom border
  canvas[0]![boxHeight - 1] = bl
  for (let x = 1; x < boxWidth - 1; x++) canvas[x]![boxHeight - 1] = hLine
  canvas[boxWidth - 1]![boxHeight - 1] = br

  // Left and right borders (full height)
  for (let y = 1; y < boxHeight - 1; y++) {
    canvas[0]![y] = vLine
    canvas[boxWidth - 1]![y] = vLine
  }

  // Render sections with dividers
  let row = 1 // current y position (starts after top border)
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!
    const lines = section.length > 0 ? section : ['']

    // Draw section text lines
    for (const line of lines) {
      const startX = 1 + padding
      const cells = toCells(line)
      for (let i = 0; i < cells.length; i++) {
        canvas[startX + i]![row] = cells[i]!
      }
      row++
    }

    // Draw divider after each section except the last
    if (s < sections.length - 1) {
      canvas[0]![row] = divL
      for (let x = 1; x < boxWidth - 1; x++) canvas[x]![row] = hLine
      canvas[boxWidth - 1]![row] = divR
      row++
    }
  }

  return canvas
}

// ============================================================================
// Line drawing — 8-directional lines on the canvas
// ============================================================================

/**
 * Line character sets for different edge styles.
 * Each style has horizontal, vertical, and diagonal characters for both
 * Unicode (box-drawing) and ASCII (basic punctuation) modes.
 *
 * Unicode dotted: ┄ (horizontal), ┆ (vertical) — U+2504, U+2506
 * Unicode thick:  ━ (horizontal), ┃ (vertical) — U+2501, U+2503
 */
/**
 * Line character sets for different edge styles.
 * Only horizontal and vertical characters - no diagonals.
 * All edges use orthogonal Manhattan routing (90° bends only).
 */
const LINE_CHARS = {
  solid: {
    h: { unicode: '─', ascii: '-' },
    v: { unicode: '│', ascii: '|' },
  },
  dotted: {
    h: { unicode: '┄', ascii: '.' },
    v: { unicode: '┆', ascii: ':' },
  },
  thick: {
    h: { unicode: '━', ascii: '=' },
    v: { unicode: '┃', ascii: '‖' },
  },
} as const

/**
 * Draw a line between two drawing coordinates using orthogonal Manhattan routing.
 * Returns the list of coordinates that were drawn on.
 * offsetFrom/offsetTo control how many cells to skip at the start/end.
 *
 * All lines use 90° bends only - no diagonal lines are produced.
 * For diagonal directions, uses horizontal-first routing (draws horizontal
 * segment, then vertical segment).
 */
export function drawLine(
  canvas: Canvas,
  from: DrawingCoord,
  to: DrawingCoord,
  offsetFrom: number,
  offsetTo: number,
  useAscii: boolean,
  style: AsciiEdgeStyle = 'solid',
): DrawingCoord[] {
  const dir = determineDirection(from, to)
  const drawnCoords: DrawingCoord[] = []

  // Select character set based on style (horizontal and vertical only)
  const chars = LINE_CHARS[style]
  const hChar = useAscii ? chars.h.ascii : chars.h.unicode
  const vChar = useAscii ? chars.v.ascii : chars.v.unicode

  // Pure vertical directions
  if (dirEquals(dir, Up)) {
    for (let y = from.y - offsetFrom; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: from.x, y })
      canvas[from.x]![y] = vChar
    }
  } else if (dirEquals(dir, Down)) {
    for (let y = from.y + offsetFrom; y <= to.y + offsetTo; y++) {
      drawnCoords.push({ x: from.x, y })
      canvas[from.x]![y] = vChar
    }
  }
  // Pure horizontal directions
  else if (dirEquals(dir, Left)) {
    for (let x = from.x - offsetFrom; x >= to.x - offsetTo; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
  } else if (dirEquals(dir, Right)) {
    for (let x = from.x + offsetFrom; x <= to.x + offsetTo; x++) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
  }
  // Diagonal directions: use Manhattan routing (horizontal-first, then vertical)
  // UpperLeft: go left first, then up
  else if (dirEquals(dir, UpperLeft)) {
    // Horizontal segment: from.x -> to.x (going left)
    for (let x = from.x - offsetFrom; x >= to.x; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
    // Vertical segment: from.y -> to.y (going up)
    for (let y = from.y - 1; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: to.x, y })
      canvas[to.x]![y] = vChar
    }
  }
  // UpperRight: go right first, then up
  else if (dirEquals(dir, UpperRight)) {
    // Horizontal segment: from.x -> to.x (going right)
    for (let x = from.x + offsetFrom; x <= to.x; x++) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
    // Vertical segment: from.y -> to.y (going up)
    for (let y = from.y - 1; y >= to.y - offsetTo; y--) {
      drawnCoords.push({ x: to.x, y })
      canvas[to.x]![y] = vChar
    }
  }
  // LowerLeft: go left first, then down
  else if (dirEquals(dir, LowerLeft)) {
    // Horizontal segment: from.x -> to.x (going left)
    for (let x = from.x - offsetFrom; x >= to.x; x--) {
      drawnCoords.push({ x, y: from.y })
      canvas[x]![from.y] = hChar
    }
    // Vertical segment: from.y -> to.y (going down)
    for (let y = from.y + 1; y <= to.y + offsetTo; y++) {
      drawnCoords.push({ x: to.x, y })
      canvas[to.x]![y] = vChar
    }
  }
  // LowerRight: go right first, then down
  // Special case: if x difference is small (1), draw straight vertical at from.x
  // This keeps edges visually aligned with the source node
  else if (dirEquals(dir, LowerRight)) {
    const dx = to.x - from.x
    if (dx <= 1) {
      // Draw vertical line at from.x (source's x-coordinate)
      for (let y = from.y + offsetFrom; y <= to.y + offsetTo; y++) {
        drawnCoords.push({ x: from.x, y })
        canvas[from.x]![y] = vChar
      }
    } else {
      // Horizontal segment: from.x -> to.x (going right)
      for (let x = from.x + offsetFrom; x <= to.x; x++) {
        drawnCoords.push({ x, y: from.y })
        canvas[x]![from.y] = hChar
      }
      // Vertical segment: from.y -> to.y (going down)
      for (let y = from.y + 1; y <= to.y + offsetTo; y++) {
        drawnCoords.push({ x: to.x, y })
        canvas[to.x]![y] = vChar
      }
    }
  }

  return drawnCoords
}

// ============================================================================
// Arrow drawing — path, corners, arrowheads, box-start junctions, labels
// ============================================================================

/**
 * Draw a complete arrow (edge) between two nodes.
 * Returns 6 separate canvases for layered compositing:
 * [path, boxStart, arrowHeadEnd, arrowHeadStart, corners, label]
 *
 * Supports bidirectional arrows via edge.hasArrowStart and edge.hasArrowEnd.
 */
export function drawArrow(
  graph: AsciiGraph,
  edge: AsciiEdge,
): [Canvas, Canvas, Canvas, Canvas, Canvas, Canvas] {
  if (edge.path.length === 0) {
    const empty = copyCanvas(graph.canvas)
    return [empty, empty, empty, empty, empty, empty]
  }

  const labelCanvas = drawArrowLabel(graph, edge)
  const [pathCanvas, linesDrawn, lineDirs] = drawPath(graph, edge.path, edge.style)
  const boxStartCanvas = drawBoxStart(graph, edge.path, linesDrawn[0]!, edge.from.shape)

  // Draw end arrowhead only if hasArrowEnd is true (default behavior)
  let arrowHeadEndCanvas: Canvas
  if (edge.hasArrowEnd) {
    arrowHeadEndCanvas = drawArrowHead(
      graph,
      linesDrawn[linesDrawn.length - 1]!,
      lineDirs[lineDirs.length - 1]!,
    )
  } else {
    arrowHeadEndCanvas = copyCanvas(graph.canvas)
  }

  // Draw start arrowhead for bidirectional edges
  // The start arrowhead needs to be at the box connector position (one step back
  // from the first line point), pointing into the source node.
  let arrowHeadStartCanvas: Canvas
  if (edge.hasArrowStart && linesDrawn.length > 0) {
    const firstLine = linesDrawn[0]!
    const firstPoint = firstLine[0]!
    const startDir = reverseDirection(lineDirs[0]!)

    // Calculate the box connector position (one step back from first point)
    const arrowPos: DrawingCoord = { x: firstPoint.x, y: firstPoint.y }
    if (dirEquals(lineDirs[0]!, Right)) arrowPos.x = firstPoint.x - 1
    else if (dirEquals(lineDirs[0]!, Left)) arrowPos.x = firstPoint.x + 1
    else if (dirEquals(lineDirs[0]!, Down)) arrowPos.y = firstPoint.y - 1
    else if (dirEquals(lineDirs[0]!, Up)) arrowPos.y = firstPoint.y + 1

    // Create a synthetic line ending at the arrow position for drawArrowHead
    const syntheticLine: DrawingCoord[] = [firstPoint, arrowPos]
    arrowHeadStartCanvas = drawArrowHead(graph, syntheticLine, startDir)
  } else {
    arrowHeadStartCanvas = copyCanvas(graph.canvas)
  }

  const cornersCanvas = drawCorners(graph, edge.path)

  return [pathCanvas, boxStartCanvas, arrowHeadEndCanvas, arrowHeadStartCanvas, cornersCanvas, labelCanvas]
}

/**
 * Reverse a direction (for bidirectional arrow start heads).
 */
function reverseDirection(dir: Direction): Direction {
  if (dirEquals(dir, Up)) return Down
  if (dirEquals(dir, Down)) return Up
  if (dirEquals(dir, Left)) return Right
  if (dirEquals(dir, Right)) return Left
  if (dirEquals(dir, UpperLeft)) return LowerRight
  if (dirEquals(dir, UpperRight)) return LowerLeft
  if (dirEquals(dir, LowerLeft)) return UpperRight
  if (dirEquals(dir, LowerRight)) return UpperLeft
  return Middle
}

/**
 * Draw the path lines for an edge.
 * Returns the canvas, the coordinates drawn for each segment, and the direction of each segment.
 */
function drawPath(
  graph: AsciiGraph,
  path: GridCoord[],
  style: AsciiEdgeStyle = 'solid',
): [Canvas, DrawingCoord[][], Direction[]] {
  const canvas = copyCanvas(graph.canvas)
  let previousCoord = path[0]!
  const linesDrawn: DrawingCoord[][] = []
  const lineDirs: Direction[] = []

  for (let i = 1; i < path.length; i++) {
    const nextCoord = path[i]!
    const prevDC = gridToDrawingCoord(graph, previousCoord)
    const nextDC = gridToDrawingCoord(graph, nextCoord)

    if (drawingCoordEquals(prevDC, nextDC)) {
      previousCoord = nextCoord
      continue
    }

    const dir = determineDirection(previousCoord, nextCoord)
    const segment = drawLine(canvas, prevDC, nextDC, 1, -1, graph.config.useAscii, style)
    if (segment.length === 0) segment.push(prevDC)
    linesDrawn.push(segment)
    lineDirs.push(dir)
    previousCoord = nextCoord
  }

  return [canvas, linesDrawn, lineDirs]
}

/**
 * Draw the junction character where an edge exits the source node's box.
 * Only applies to Unicode mode (ASCII mode just uses the line characters).
 * Skips drawing for state pseudo-states which have their own visual borders.
 */
function drawBoxStart(
  graph: AsciiGraph,
  path: GridCoord[],
  firstLine: DrawingCoord[],
  sourceShape: string,
): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (graph.config.useAscii) return canvas

  // Skip box start connectors for state pseudo-states (they have their own bordered design)
  if (sourceShape === 'state-start' || sourceShape === 'state-end') {
    return canvas
  }

  const from = firstLine[0]!
  const dir = determineDirection(path[0]!, path[1]!)

  if (dirEquals(dir, Up)) canvas[from.x]![from.y + 1] = '┴'
  else if (dirEquals(dir, Down)) canvas[from.x]![from.y - 1] = '┬'
  else if (dirEquals(dir, Left)) canvas[from.x + 1]![from.y] = '┤'
  else if (dirEquals(dir, Right)) canvas[from.x - 1]![from.y] = '├'

  return canvas
}

/**
 * Draw the arrowhead at the end of an edge path.
 * Uses triangular Unicode symbols (▲▼◄►) or ASCII symbols (^v<>).
 */
function drawArrowHead(
  graph: AsciiGraph,
  lastLine: DrawingCoord[],
  fallbackDir: Direction,
): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (lastLine.length === 0) return canvas

  const from = lastLine[0]!
  const lastPos = lastLine[lastLine.length - 1]!
  let dir = determineDirection(from, lastPos)
  if (lastLine.length === 1 || dirEquals(dir, Middle)) dir = fallbackDir

  let char: string

  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else if (dirEquals(dir, UpperRight)) char = '◥'
    else if (dirEquals(dir, UpperLeft)) char = '◤'
    else if (dirEquals(dir, LowerRight)) char = '◢'
    else if (dirEquals(dir, LowerLeft)) char = '◣'
    else {
      // Fallback
      if (dirEquals(fallbackDir, Up)) char = '▲'
      else if (dirEquals(fallbackDir, Down)) char = '▼'
      else if (dirEquals(fallbackDir, Left)) char = '◄'
      else if (dirEquals(fallbackDir, Right)) char = '►'
      else if (dirEquals(fallbackDir, UpperRight)) char = '◥'
      else if (dirEquals(fallbackDir, UpperLeft)) char = '◤'
      else if (dirEquals(fallbackDir, LowerRight)) char = '◢'
      else if (dirEquals(fallbackDir, LowerLeft)) char = '◣'
      else char = '●'
    }
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else {
      if (dirEquals(fallbackDir, Up)) char = '^'
      else if (dirEquals(fallbackDir, Down)) char = 'v'
      else if (dirEquals(fallbackDir, Left)) char = '<'
      else if (dirEquals(fallbackDir, Right)) char = '>'
      else char = '*'
    }
  }

  canvas[lastPos.x]![lastPos.y] = char
  return canvas
}

/**
 * Draw corner characters at path bends (where the direction changes).
 * Uses ┌┐└┘ in Unicode mode, + in ASCII mode.
 */
function drawCorners(graph: AsciiGraph, path: GridCoord[]): Canvas {
  const canvas = copyCanvas(graph.canvas)

  for (let idx = 1; idx < path.length - 1; idx++) {
    const coord = path[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(path[idx - 1]!, coord)
    const nextDir = determineDirection(coord, path[idx + 1]!)

    let corner: string
    if (!graph.config.useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    canvas[dc.x]![dc.y] = corner
  }

  return canvas
}

/** Draw edge label text centered on the widest path segment. */
function drawArrowLabel(graph: AsciiGraph, edge: AsciiEdge): Canvas {
  const canvas = copyCanvas(graph.canvas)
  if (edge.text.length === 0) return canvas

  const drawingLine = lineToDrawing(graph, edge.labelLine)

  // Determine if this is an upward edge (target is above source in the path)
  // This is used to offset labels on bidirectional edges to prevent overlap
  let isUpwardEdge: boolean | undefined
  if (edge.path.length >= 2) {
    const startY = edge.path[0]!.y
    const endY = edge.path[edge.path.length - 1]!.y
    // Edge goes up if end Y is less than start Y (smaller Y = higher on screen)
    if (endY < startY) {
      isUpwardEdge = true
    } else if (endY > startY) {
      isUpwardEdge = false
    }
    // If endY === startY, it's horizontal, leave isUpwardEdge undefined
  }

  drawTextOnLine(canvas, drawingLine, edge.text, isUpwardEdge)
  return canvas
}

/**
 * Draw text centered on a line segment defined by two drawing coordinates.
 * Supports multi-line labels.
 *
 * When isUpwardEdge is provided, offsets the label vertically to prevent
 * overlapping with labels from edges going the opposite direction:
 * - Upward edges: label placed in lower portion of segment
 * - Downward edges (isUpwardEdge=false): label placed in upper portion
 * - No direction (isUpwardEdge=undefined): label centered (default)
 */
function drawTextOnLine(canvas: Canvas, line: DrawingCoord[], label: string, isUpwardEdge?: boolean): void {
  if (line.length < 2) return
  const minX = Math.min(line[0]!.x, line[1]!.x)
  const maxX = Math.max(line[0]!.x, line[1]!.x)
  const minY = Math.min(line[0]!.y, line[1]!.y)
  const maxY = Math.max(line[0]!.y, line[1]!.y)
  const middleX = minX + Math.floor((maxX - minX) / 2)
  let middleY = minY + Math.floor((maxY - minY) / 2)

  // Offset label vertically to prevent overlap on bidirectional edges
  // For vertical segments (same X), shift based on edge direction
  if (isUpwardEdge !== undefined && minX === maxX) {
    const segmentHeight = maxY - minY
    const offset = Math.max(1, Math.floor(segmentHeight / 4))
    if (isUpwardEdge) {
      // Upward edge: place label in lower portion
      middleY = middleY + offset
    } else {
      // Downward edge: place label in upper portion
      middleY = middleY - offset
    }
  }

  // Support multi-line labels
  const lines = splitLines(label)
  const startY = middleY - Math.floor((lines.length - 1) / 2)

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!
    const startX = middleX - Math.floor(displayWidth(lineText) / 2)
    drawText(canvas, { x: startX, y: startY + i }, lineText.replaceAll(' ', LABEL_SPACE))
  }
}

// ============================================================================
// Node attachment point helper
// ============================================================================

/**
 * Get the drawing coordinate where an edge attaches to a node's border.
 * Uses grid-allocated dimensions so attachment points align with the actual
 * drawn box (which may be wider/taller than the intrinsic shape dimensions
 * when sharing a column/row with a larger node).
 */
function getNodeAttachmentPoint(
  graph: AsciiGraph,
  node: AsciiNode,
  dir: Direction,
): DrawingCoord {
  const gc = node.gridCoord!

  // Calculate actual drawn dimensions from grid (matching drawBoxWithGridDimensions)
  let w = 0
  for (let i = 0; i < 2; i++) {
    w += graph.columnWidth.get(gc.x + i) ?? 0
  }
  let h = 0
  for (let i = 0; i < 2; i++) {
    h += graph.rowHeight.get(gc.y + i) ?? 0
  }

  // Build dimensions matching the actual drawn box size
  const gridDimensions = {
    width: w + 1,
    height: h + 1,
    labelArea: { x: 0, y: 0, width: 0, height: 0 },
    gridColumns: [0, 0, 0] as [number, number, number],
    gridRows: [0, 0, 0] as [number, number, number],
  }

  const baseCoord = node.drawingCoord!
  return getShapeAttachmentPoint(node.shape, dir, gridDimensions, baseCoord)
}

// ============================================================================
// Bundled edge drawing — for parallel links (A & B --> C)
// ============================================================================

/**
 * Draw a single edge's segment in a bundle (source → junction for fan-in,
 * junction → target for fan-out).
 *
 * Returns the same tuple format as drawArrow for consistency.
 */
function drawBundledEdgeSegment(
  graph: AsciiGraph,
  edge: AsciiEdge,
  bundle: EdgeBundle,
): [Canvas, Canvas, Canvas, Canvas, Canvas, Canvas] {
  const empty = copyCanvas(graph.canvas)

  if (!edge.pathToJunction || edge.pathToJunction.length === 0) {
    return [empty, empty, empty, empty, empty, empty]
  }

  // Draw the path segment (pathToJunction)
  const pathCanvas = copyCanvas(graph.canvas)
  const useAscii = graph.config.useAscii

  // Convert grid coords to drawing coords
  // For fan-in: first point is at source node border (use attachment point)
  // For fan-out: last point is at target node border (use attachment point)
  const drawingPath = edge.pathToJunction.map((gc, idx) => {
    if (bundle.type === 'fan-in' && idx === 0) {
      // First point: use source node's actual border position
      return getNodeAttachmentPoint(graph, edge.from, edge.startDir)
    }
    if (bundle.type === 'fan-out' && idx === edge.pathToJunction!.length - 1) {
      // Last point: use target node's actual border position
      return getNodeAttachmentPoint(graph, edge.to, edge.endDir)
    }
    return gridToDrawingCoord(graph, gc)
  })

  // Draw line segments
  for (let i = 1; i < drawingPath.length; i++) {
    const from = drawingPath[i - 1]!
    const to = drawingPath[i]!
    if (!drawingCoordEquals(from, to)) {
      // Always skip both endpoints of every segment (offset 1, -1),
      // matching non-bundled drawPath behavior. This leaves endpoint
      // characters to corner/junction/boxStart canvases, preventing
      // line characters from corrupting them via mergeJunctions.
      drawLine(pathCanvas, from, to, 1, -1, useAscii, edge.style)
    }
  }

  // Draw corners at path bends
  const cornersCanvas = copyCanvas(graph.canvas)
  for (let idx = 1; idx < edge.pathToJunction.length - 1; idx++) {
    const coord = edge.pathToJunction[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(edge.pathToJunction[idx - 1]!, coord)
    const nextDir = determineDirection(coord, edge.pathToJunction[idx + 1]!)

    let corner: string
    if (!useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    cornersCanvas[dc.x]![dc.y] = corner
  }

  // Draw box start connector (for fan-in, from source node)
  // The connector is placed at the first point coordinate (box border position)
  // since we use offsets 1,-1 for drawLine, the line starts one step past this point
  const boxStartCanvas = copyCanvas(graph.canvas)
  if (bundle.type === 'fan-in' && edge.pathToJunction.length >= 2) {
    const firstPoint = drawingPath[0]!
    const dir = determineDirection(edge.pathToJunction[0]!, edge.pathToJunction[1]!)

    if (!useAscii) {
      if (dirEquals(dir, Up)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '┴'
      else if (dirEquals(dir, Down)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '┬'
      else if (dirEquals(dir, Left)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '┤'
      else if (dirEquals(dir, Right)) boxStartCanvas[firstPoint.x]![firstPoint.y] = '├'
    }
  }

  // Label canvas (bundled edges typically don't have labels, but handle it)
  const labelCanvas = copyCanvas(graph.canvas)

  return [pathCanvas, boxStartCanvas, empty, empty, cornersCanvas, labelCanvas]
}

/**
 * Draw the shared path segment of a bundle (junction → target for fan-in,
 * source → junction for fan-out).
 */
function drawBundleSharedPath(graph: AsciiGraph, bundle: EdgeBundle): [Canvas, Canvas] {
  const pathCanvas = copyCanvas(graph.canvas)
  const cornersCanvas = copyCanvas(graph.canvas)

  if (bundle.sharedPath.length < 2) {
    return [pathCanvas, cornersCanvas]
  }

  const useAscii = graph.config.useAscii
  const style = bundle.edges[0]?.style ?? 'solid'
  const graphDir = graph.config.graphDirection

  // Convert grid coords to drawing coords
  // For fan-in: last point is at target node border
  // For fan-out: first point is at source node border
  const drawingPath = bundle.sharedPath.map((gc, idx) => {
    if (bundle.type === 'fan-in' && idx === bundle.sharedPath.length - 1) {
      // Last point: use target node's actual border position (entry from above/left)
      const entryDir = graphDir === 'TD' ? Up : Left
      return getNodeAttachmentPoint(graph, bundle.sharedNode, entryDir)
    }
    if (bundle.type === 'fan-out' && idx === 0) {
      // First point: use source node's actual border position (exit going down/right)
      const exitDir = graphDir === 'TD' ? Down : Right
      return getNodeAttachmentPoint(graph, bundle.sharedNode, exitDir)
    }
    return gridToDrawingCoord(graph, gc)
  })

  // Draw line segments with appropriate offsets
  for (let i = 1; i < drawingPath.length; i++) {
    const from = drawingPath[i - 1]!
    const to = drawingPath[i]!
    if (!drawingCoordEquals(from, to)) {
      // Always skip both endpoints (offset 1, -1), matching non-bundled drawPath.
      drawLine(pathCanvas, from, to, 1, -1, useAscii, style)
    }
  }

  // Draw corners at path bends
  for (let idx = 1; idx < bundle.sharedPath.length - 1; idx++) {
    const coord = bundle.sharedPath[idx]!
    const dc = gridToDrawingCoord(graph, coord)
    const prevDir = determineDirection(bundle.sharedPath[idx - 1]!, coord)
    const nextDir = determineDirection(coord, bundle.sharedPath[idx + 1]!)

    let corner: string
    if (!useAscii) {
      if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Down)) ||
          (dirEquals(prevDir, Up) && dirEquals(nextDir, Left))) {
        corner = '┐'
      } else if ((dirEquals(prevDir, Right) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Left))) {
        corner = '┘'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Down)) ||
                 (dirEquals(prevDir, Up) && dirEquals(nextDir, Right))) {
        corner = '┌'
      } else if ((dirEquals(prevDir, Left) && dirEquals(nextDir, Up)) ||
                 (dirEquals(prevDir, Down) && dirEquals(nextDir, Right))) {
        corner = '└'
      } else {
        corner = '+'
      }
    } else {
      corner = '+'
    }

    cornersCanvas[dc.x]![dc.y] = corner
  }

  return [pathCanvas, cornersCanvas]
}

/**
 * Draw the arrowhead for a fan-in bundle (single arrowhead at the shared target).
 */
function drawBundleArrowhead(graph: AsciiGraph, bundle: EdgeBundle): Canvas {
  const canvas = copyCanvas(graph.canvas)

  if (bundle.sharedPath.length < 2) return canvas

  // Get the last segment direction
  const lastIdx = bundle.sharedPath.length - 1
  const secondLast = bundle.sharedPath[lastIdx - 1]!
  const last = bundle.sharedPath[lastIdx]!
  const dir = determineDirection(secondLast, last)

  // Get drawing coord 1 char outside the target node's border (not on the border itself).
  // This matches non-bundled edges where drawPath uses offsetTo=-1 and the arrowhead
  // sits at the last drawn point (1 char before the border).
  const graphDir = graph.config.graphDirection
  const entryDir = graphDir === 'TD' ? Up : Left
  const dc = getNodeAttachmentPoint(graph, bundle.sharedNode, entryDir)
  // Offset 1 char away from the box border so arrowhead sits outside the box
  if (graphDir === 'TD') dc.y -= 1
  else dc.x -= 1

  // Draw arrowhead
  let char: string
  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else char = '▼'  // default
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else char = 'v'  // default
  }

  canvas[dc.x]![dc.y] = char
  return canvas
}

/**
 * Draw the arrowhead for a single edge in a fan-out bundle.
 */
function drawBundledEdgeArrowhead(graph: AsciiGraph, edge: AsciiEdge): Canvas {
  const canvas = copyCanvas(graph.canvas)

  if (!edge.pathToJunction || edge.pathToJunction.length < 2) return canvas

  // Get the last segment direction
  const lastIdx = edge.pathToJunction.length - 1
  const secondLast = edge.pathToJunction[lastIdx - 1]!
  const last = edge.pathToJunction[lastIdx]!
  const dir = determineDirection(secondLast, last)

  // Get drawing coord 1 char outside the target node's border
  const graphDir = graph.config.graphDirection
  const entryDir = graphDir === 'TD' ? Up : Left
  const dc = getNodeAttachmentPoint(graph, edge.to, entryDir)
  // Offset 1 char away from the box border so arrowhead sits outside the box
  if (graphDir === 'TD') dc.y -= 1
  else dc.x -= 1

  // Draw arrowhead
  let char: string
  if (!graph.config.useAscii) {
    if (dirEquals(dir, Up)) char = '▲'
    else if (dirEquals(dir, Down)) char = '▼'
    else if (dirEquals(dir, Left)) char = '◄'
    else if (dirEquals(dir, Right)) char = '►'
    else char = '▼'  // default
  } else {
    if (dirEquals(dir, Up)) char = '^'
    else if (dirEquals(dir, Down)) char = 'v'
    else if (dirEquals(dir, Left)) char = '<'
    else if (dirEquals(dir, Right)) char = '>'
    else char = 'v'  // default
  }

  canvas[dc.x]![dc.y] = char
  return canvas
}

/**
 * Draw the junction character where bundled edges merge/split.
 *
 * Analyzes actual connecting directions to choose the correct character:
 * - ┼ (cross): lines from all 4 directions
 * - ┬ (T down): lines from left, right, and down
 * - ┴ (T up): lines from left, right, and up
 * - ├ (T right): lines from up, down, and right
 * - ┤ (T left): lines from up, down, and left
 */
function drawJunctionCharacter(graph: AsciiGraph, bundle: EdgeBundle): Canvas {
  const canvas = copyCanvas(graph.canvas)

  if (!bundle.junctionPoint) return canvas

  const dc = gridToDrawingCoord(graph, bundle.junctionPoint)
  const useAscii = graph.config.useAscii

  // Analyze what directions actually connect to the junction
  let hasUp = false
  let hasDown = false
  let hasLeft = false
  let hasRight = false

  // Check shared path direction (where the line continues to/from the shared node)
  if (bundle.sharedPath.length >= 2) {
    // For fan-in: shared path goes FROM junction TO target (index 0 is junction)
    // For fan-out: shared path goes FROM source TO junction (last index is junction)
    const junctionIdx = bundle.type === 'fan-in' ? 0 : bundle.sharedPath.length - 1
    const adjacentIdx = bundle.type === 'fan-in' ? 1 : bundle.sharedPath.length - 2
    const sharedDir = determineDirection(
      bundle.sharedPath[junctionIdx]!,
      bundle.sharedPath[adjacentIdx]!
    )
    // This is the direction the shared path GOES from junction
    if (dirEquals(sharedDir, Down)) hasDown = true
    else if (dirEquals(sharedDir, Up)) hasUp = true
    else if (dirEquals(sharedDir, Right)) hasRight = true
    else if (dirEquals(sharedDir, Left)) hasLeft = true
  }

  // Check each edge's path direction at the junction
  for (const edge of bundle.edges) {
    if (edge.pathToJunction && edge.pathToJunction.length >= 2) {
      // For fan-in: pathToJunction goes FROM source TO junction (last is junction)
      // For fan-out: pathToJunction goes FROM junction TO target (first is junction)
      const junctionIdx = bundle.type === 'fan-in'
        ? edge.pathToJunction.length - 1
        : 0
      const adjacentIdx = bundle.type === 'fan-in'
        ? edge.pathToJunction.length - 2
        : 1

      const arrivalDir = determineDirection(
        edge.pathToJunction[adjacentIdx]!,
        edge.pathToJunction[junctionIdx]!
      )
      // This is the direction the edge ARRIVES at junction from
      // e.g., if arrivalDir is Right, the line comes FROM the left
      if (dirEquals(arrivalDir, Down)) hasUp = true    // arrived going down = came from up
      else if (dirEquals(arrivalDir, Up)) hasDown = true
      else if (dirEquals(arrivalDir, Right)) hasLeft = true
      else if (dirEquals(arrivalDir, Left)) hasRight = true
    }
  }

  // Select character based on connected directions
  let char: string
  if (!useAscii) {
    if (hasUp && hasDown && hasLeft && hasRight) {
      char = '┼'  // cross - all 4 directions
    } else if (hasDown && hasLeft && hasRight && !hasUp) {
      char = '┬'  // T pointing down
    } else if (hasUp && hasLeft && hasRight && !hasDown) {
      char = '┴'  // T pointing up
    } else if (hasUp && hasDown && hasRight && !hasLeft) {
      char = '├'  // T pointing right
    } else if (hasUp && hasDown && hasLeft && !hasRight) {
      char = '┤'  // T pointing left
    } else if (hasLeft && hasRight) {
      char = '─'  // horizontal only
    } else if (hasUp && hasDown) {
      char = '│'  // vertical only
    } else if (hasDown && hasRight) {
      char = '┌'  // corner
    } else if (hasDown && hasLeft) {
      char = '┐'
    } else if (hasUp && hasRight) {
      char = '└'
    } else if (hasUp && hasLeft) {
      char = '┘'
    } else {
      char = '┼'  // fallback
    }
  } else {
    char = '+'
  }

  canvas[dc.x]![dc.y] = char
  return canvas
}

// ============================================================================
// Subgraph drawing
// ============================================================================

/** Draw a subgraph border rectangle. */
export function drawSubgraphBox(sg: AsciiSubgraph, graph: AsciiGraph): Canvas {
  const width = sg.maxX - sg.minX
  const height = sg.maxY - sg.minY
  if (width <= 0 || height <= 0) return mkCanvas(0, 0)

  const from: DrawingCoord = { x: 0, y: 0 }
  const to: DrawingCoord = { x: width, y: height }
  const canvas = mkCanvas(width, height)

  if (!graph.config.useAscii) {
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![from.y] = '─'
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![to.y] = '─'
    for (let y = from.y + 1; y < to.y; y++) canvas[from.x]![y] = '│'
    for (let y = from.y + 1; y < to.y; y++) canvas[to.x]![y] = '│'
    canvas[from.x]![from.y] = '┌'
    canvas[to.x]![from.y] = '┐'
    canvas[from.x]![to.y] = '└'
    canvas[to.x]![to.y] = '┘'
  } else {
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![from.y] = '-'
    for (let x = from.x + 1; x < to.x; x++) canvas[x]![to.y] = '-'
    for (let y = from.y + 1; y < to.y; y++) canvas[from.x]![y] = '|'
    for (let y = from.y + 1; y < to.y; y++) canvas[to.x]![y] = '|'
    canvas[from.x]![from.y] = '+'
    canvas[to.x]![from.y] = '+'
    canvas[from.x]![to.y] = '+'
    canvas[to.x]![to.y] = '+'
  }

  return canvas
}

/** Draw a subgraph label centered in its header area. Supports multi-line labels. */
export function drawSubgraphLabel(sg: AsciiSubgraph, graph: AsciiGraph): [Canvas, DrawingCoord] {
  const width = sg.maxX - sg.minX
  const height = sg.maxY - sg.minY
  if (width <= 0 || height <= 0) return [mkCanvas(0, 0), { x: 0, y: 0 }]

  const canvas = mkCanvas(width, height)

  // Support multi-line subgraph labels
  const lines = splitLines(sg.name)

  // Start at row 1 inside subgraph, expand downward for multiple lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const labelY = 1 + i
    let labelX = Math.floor(width / 2) - Math.floor(displayWidth(line) / 2)
    if (labelX < 1) labelX = 1

    const cells = toCells(line)
    for (let j = 0; j < cells.length; j++) {
      const cell = cells[j]!
      if (cell === WIDE_PAD) continue // written atomically with its lead
      const cx = labelX + j
      const wide = cells[j + 1] === WIDE_PAD
      // Keep wide-glyph pairs atomic at the subgraph edge
      if (cx + (wide ? 1 : 0) >= width || labelY >= height) continue
      canvas[cx]![labelY] = cell
      if (wide) canvas[cx + 1]![labelY] = WIDE_PAD
    }
  }

  return [canvas, { x: sg.minX, y: sg.minY }]
}

// ============================================================================
// Top-level draw orchestrator
// ============================================================================

/** Sort subgraphs by nesting depth (shallowest first) for correct layered rendering. */
function sortSubgraphsByDepth(subgraphs: AsciiSubgraph[]): AsciiSubgraph[] {
  function getDepth(sg: AsciiSubgraph): number {
    return sg.parent === null ? 0 : 1 + getDepth(sg.parent)
  }
  const sorted = [...subgraphs]
  sorted.sort((a, b) => getDepth(a) - getDepth(b))
  return sorted
}

// ============================================================================
// Role tracking helpers for colored output
// ============================================================================

/**
 * Fill roles for all non-space characters in a canvas region.
 * Used after drawing a layer to record what role those characters have.
 */
function fillRolesFromCanvas(
  roleCanvas: RoleCanvas,
  canvas: Canvas,
  offset: DrawingCoord,
  role: CharRole,
): void {
  for (let x = 0; x < canvas.length; x++) {
    for (let y = 0; y < (canvas[0]?.length ?? 0); y++) {
      const char = canvas[x]?.[y]
      if (char && char !== ' ') {
        const rx = x + offset.x
        const ry = y + offset.y
        // Use setRole which auto-expands the role canvas if needed
        if (rx >= 0 && ry >= 0) {
          setRole(roleCanvas, rx, ry, role)
        }
      }
    }
  }
}

/**
 * Fill roles for multiple canvases with the same role.
 */
function fillRolesFromCanvases(
  roleCanvas: RoleCanvas,
  canvases: Canvas[],
  offset: DrawingCoord,
  role: CharRole,
): void {
  for (const canvas of canvases) {
    fillRolesFromCanvas(roleCanvas, canvas, offset, role)
  }
}

/**
 * Special handling for node boxes: border chars get 'border' role, text gets 'text' role.
 * Common final-state border characters (`#` and `=`) count only on the outer edge,
 * so identical characters inside ordinary node labels retain the text role.
 */
function fillRolesForNodeBox(
  roleCanvas: RoleCanvas,
  canvas: Canvas,
  offset: DrawingCoord,
): void {
  const isBorderChar = (c: string) => /^[┌┐└┘├┤┬┴┼│─╭╮╰╯+\-|.':]$/.test(c)
  const isStateEndBorderChar = (c: string) => /^[╔╗╚╝═║#=‖]$/.test(c)
  const maxX = canvas.length - 1
  const maxY = (canvas[0]?.length ?? 1) - 1
  for (let x = 0; x < canvas.length; x++) {
    for (let y = 0; y < (canvas[0]?.length ?? 0); y++) {
      const char = canvas[x]?.[y]
      if (char && char !== ' ') {
        const rx = x + offset.x
        const ry = y + offset.y
        // Use setRole which auto-expands the role canvas if needed
        if (rx >= 0 && ry >= 0) {
          const isOuterEdge = x === 0 || x === maxX || y === 0 || y === maxY
          const role = isBorderChar(char) || (isOuterEdge && isStateEndBorderChar(char)) ? 'border' : 'text'
          setRole(roleCanvas, rx, ry, role)
        }
      }
    }
  }
}

/**
 * Main draw function — renders the entire graph onto the canvas.
 * Drawing order matters for correct layering:
 * 1. Subgraph borders (bottom layer)
 * 2. Node boxes
 * 3. Edge paths (lines)
 * 4. Edge corners
 * 5. Arrowheads
 * 6. Box-start junctions
 * 7. Edge labels
 * 8. Subgraph labels (top layer)
 *
 * Also fills the roleCanvas with character roles for colored output.
 */
export function drawGraph(graph: AsciiGraph): Canvas {
  const useAscii = graph.config.useAscii
  const zero: DrawingCoord = { x: 0, y: 0 }

  // Draw subgraph borders
  const sortedSgs = sortSubgraphsByDepth(graph.subgraphs)
  for (const sg of sortedSgs) {
    const sgCanvas = drawSubgraphBox(sg, graph)
    const offset: DrawingCoord = { x: sg.minX, y: sg.minY }
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, sgCanvas)
    // Subgraph borders get 'border' role
    fillRolesFromCanvas(graph.roleCanvas, sgCanvas, offset, 'border')
  }

  // Draw node boxes
  for (const node of graph.nodes) {
    if (!node.drawn && node.drawingCoord && node.drawing) {
      graph.canvas = mergeCanvases(graph.canvas, node.drawingCoord, useAscii, node.drawing)
      // Node boxes: detect border vs text characters
      fillRolesForNodeBox(graph.roleCanvas, node.drawing, node.drawingCoord)
      node.drawn = true
    }
  }

  // Collect all edge drawing layers
  const lineCanvases: Canvas[] = []
  const cornerCanvases: Canvas[] = []
  const arrowHeadEndCanvases: Canvas[] = []
  const arrowHeadStartCanvases: Canvas[] = []
  const boxStartCanvases: Canvas[] = []
  const labelCanvases: Canvas[] = []
  const junctionCanvases: Canvas[] = []

  // Track which bundles have been processed (to draw shared paths only once)
  const processedBundles = new Set<EdgeBundle>()

  for (const edge of graph.edges) {
    // Handle bundled edges specially
    if (edge.bundle && edge.pathToJunction) {
      const bundle = edge.bundle

      // Draw this edge's individual path (source → junction for fan-in, junction → target for fan-out)
      const [pathC, boxStartC, , , cornersC, labelC] = drawBundledEdgeSegment(graph, edge, bundle)
      lineCanvases.push(pathC)
      cornerCanvases.push(cornersC)
      boxStartCanvases.push(boxStartC)
      labelCanvases.push(labelC)

      // Draw the bundle's shared path and arrowhead only once
      if (!processedBundles.has(bundle)) {
        processedBundles.add(bundle)

        // Draw shared path (junction → target for fan-in, source → junction for fan-out)
        const [sharedPathC, sharedCornersC] = drawBundleSharedPath(graph, bundle)
        lineCanvases.push(sharedPathC)
        cornerCanvases.push(sharedCornersC)

        // Draw arrowhead at target for fan-in (once for all edges in bundle)
        if (bundle.type === 'fan-in') {
          const arrowHeadC = drawBundleArrowhead(graph, bundle)
          arrowHeadEndCanvases.push(arrowHeadC)
        }

        // Draw junction character
        const junctionC = drawJunctionCharacter(graph, bundle)
        junctionCanvases.push(junctionC)
      }

      // For fan-out bundles, draw arrowhead at each target
      if (bundle.type === 'fan-out' && edge.hasArrowEnd) {
        const arrowHeadC = drawBundledEdgeArrowhead(graph, edge)
        arrowHeadEndCanvases.push(arrowHeadC)
      }
    } else {
      // Non-bundled edge: use standard drawing
      const [pathC, boxStartC, arrowHeadEndC, arrowHeadStartC, cornersC, labelC] = drawArrow(graph, edge)
      lineCanvases.push(pathC)
      cornerCanvases.push(cornersC)
      arrowHeadEndCanvases.push(arrowHeadEndC)
      arrowHeadStartCanvases.push(arrowHeadStartC)
      boxStartCanvases.push(boxStartC)
      labelCanvases.push(labelC)
    }
  }

  // Merge edge layers in order and track roles
  // Note: arrowHeadStart is merged AFTER boxStart so bidirectional arrows
  // properly overwrite the box connector at the source end
  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...lineCanvases)
  fillRolesFromCanvases(graph.roleCanvas, lineCanvases, zero, 'line')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...cornerCanvases)
  fillRolesFromCanvases(graph.roleCanvas, cornerCanvases, zero, 'corner')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...junctionCanvases)
  fillRolesFromCanvases(graph.roleCanvas, junctionCanvases, zero, 'junction')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...arrowHeadEndCanvases)
  fillRolesFromCanvases(graph.roleCanvas, arrowHeadEndCanvases, zero, 'arrow')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...boxStartCanvases)
  fillRolesFromCanvases(graph.roleCanvas, boxStartCanvases, zero, 'junction')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...arrowHeadStartCanvases)
  fillRolesFromCanvases(graph.roleCanvas, arrowHeadStartCanvases, zero, 'arrow')

  graph.canvas = mergeCanvases(graph.canvas, zero, useAscii, ...labelCanvases)
  fillRolesFromCanvases(graph.roleCanvas, labelCanvases, zero, 'text')

  // Draw subgraph labels last (on top)
  for (const sg of graph.subgraphs) {
    if (sg.nodes.length === 0) continue
    const [labelCanvas, offset] = drawSubgraphLabel(sg, graph)
    graph.canvas = mergeCanvases(graph.canvas, offset, useAscii, labelCanvas)
    fillRolesFromCanvas(graph.roleCanvas, labelCanvas, offset, 'text')
  }

  return graph.canvas
}
