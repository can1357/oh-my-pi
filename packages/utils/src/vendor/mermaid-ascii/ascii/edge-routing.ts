// ============================================================================
// ASCII renderer — direction system and edge path determination
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/direction.go + cmd/mapping_edge.go.
// Handles direction constants, edge attachment point selection,
// and dual-path comparison for optimal edge routing.
// ============================================================================

import type { GridCoord, Direction, AsciiEdge, AsciiGraph } from './types'
import {
  Up, Down, Left, Right, UpperRight, UpperLeft, LowerRight, LowerLeft, Middle,
  gridCoordDirection,
} from './types'
import { getPath, mergePath } from './pathfinder'
import { getEffectiveDirection, getNodeSubgraph } from './grid'
import { displayWidth } from '../text-metrics'

// ============================================================================
// Direction utilities
// ============================================================================

export function getOpposite(d: Direction): Direction {
  if (d === Up) return Down
  if (d === Down) return Up
  if (d === Left) return Right
  if (d === Right) return Left
  if (d === UpperRight) return LowerLeft
  if (d === UpperLeft) return LowerRight
  if (d === LowerRight) return UpperLeft
  if (d === LowerLeft) return UpperRight
  return Middle
}

/** Compare directions by value (not reference). */
export function dirEquals(a: Direction, b: Direction): boolean {
  return a.x === b.x && a.y === b.y
}

/**
 * Determine 8-way direction from one coordinate to another.
 * Uses the coordinate difference to pick one of 8 cardinal/ordinal directions.
 */
export function determineDirection(from: { x: number; y: number }, to: { x: number; y: number }): Direction {
  if (from.x === to.x) {
    return from.y < to.y ? Down : Up
  } else if (from.y === to.y) {
    return from.x < to.x ? Right : Left
  } else if (from.x < to.x) {
    return from.y < to.y ? LowerRight : UpperRight
  } else {
    return from.y < to.y ? LowerLeft : UpperLeft
  }
}

// ============================================================================
// Start/end direction selection for edges
// ============================================================================

/** Self-reference routing (node points to itself). */
function selfReferenceDirection(graphDirection: string): [Direction, Direction, Direction, Direction] {
  if (graphDirection === 'LR') return [Right, Down, Down, Right]
  return [Down, Right, Right, Down]
}

/**
 * Determine preferred and alternative start/end directions for an edge.
 * Returns [preferredStart, preferredEnd, alternativeStart, alternativeEnd].
 *
 * The edge routing tries both pairs and picks the shorter path.
 * Direction selection depends on relative node positions and graph direction (LR vs TD).
 */
export function determineStartAndEndDir(
  edge: AsciiEdge,
  graphDirection: string,
): [Direction, Direction, Direction, Direction] {
  if (edge.from === edge.to) return selfReferenceDirection(graphDirection)

  const d = determineDirection(edge.from.gridCoord!, edge.to.gridCoord!)

  let preferredDir: Direction
  let preferredOppositeDir: Direction
  let alternativeDir: Direction
  let alternativeOppositeDir: Direction

  const isBackwards = graphDirection === 'LR'
    ? (dirEquals(d, Left) || dirEquals(d, UpperLeft) || dirEquals(d, LowerLeft))
    : (dirEquals(d, Up) || dirEquals(d, UpperLeft) || dirEquals(d, UpperRight))

  if (dirEquals(d, LowerRight)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Left
      alternativeDir = Right; alternativeOppositeDir = Up
    } else {
      preferredDir = Right; preferredOppositeDir = Up
      alternativeDir = Down; alternativeOppositeDir = Left
    }
  } else if (dirEquals(d, UpperRight)) {
    if (graphDirection === 'LR') {
      preferredDir = Up; preferredOppositeDir = Left
      alternativeDir = Right; alternativeOppositeDir = Down
    } else {
      preferredDir = Right; preferredOppositeDir = Down
      alternativeDir = Up; alternativeOppositeDir = Left
    }
  } else if (dirEquals(d, LowerLeft)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Up
    } else {
      preferredDir = Left; preferredOppositeDir = Up
      alternativeDir = Down; alternativeOppositeDir = Right
    }
  } else if (dirEquals(d, UpperLeft)) {
    if (graphDirection === 'LR') {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Down
    } else {
      preferredDir = Right; preferredOppositeDir = Right
      alternativeDir = Up; alternativeOppositeDir = Right
    }
  } else if (isBackwards) {
    if (graphDirection === 'LR' && dirEquals(d, Left)) {
      preferredDir = Down; preferredOppositeDir = Down
      alternativeDir = Left; alternativeOppositeDir = Right
    } else if (graphDirection === 'TD' && dirEquals(d, Up)) {
      preferredDir = Right; preferredOppositeDir = Right
      alternativeDir = Up; alternativeOppositeDir = Down
    } else {
      preferredDir = d; preferredOppositeDir = getOpposite(d)
      alternativeDir = d; alternativeOppositeDir = getOpposite(d)
    }
  } else {
    // Default: go in the natural direction
    preferredDir = d; preferredOppositeDir = getOpposite(d)
    alternativeDir = d; alternativeOppositeDir = getOpposite(d)
  }

  return [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir]
}

// ============================================================================
// Edge path determination
// ============================================================================

/**
 * Determine the path for an edge by trying two candidate routes (preferred + alternative)
 * and picking the shorter one. Sets edge.path, edge.startDir, edge.endDir.
 *
 * When both A* paths fail (common for edges crossing subgraph boundaries), falls back
 * to a direct path using the start/end points. This ensures edges always have a path
 * for arrowhead rendering.
 *
 * Uses the effective direction for edge routing, respecting subgraph direction overrides
 * when both source and target are in the same subgraph.
 */
export function determinePath(graph: AsciiGraph, edge: AsciiEdge): void {
  // Determine effective direction for this edge
  // If both nodes are in the same subgraph with a direction override, use it
  // Otherwise, use the graph's direction (not source's effective direction)
  const sourceSg = getNodeSubgraph(graph, edge.from)
  const targetSg = getNodeSubgraph(graph, edge.to)
  const effectiveDir = (sourceSg && sourceSg === targetSg && sourceSg.direction)
    ? sourceSg.direction
    : graph.config.graphDirection

  const [preferredDir, preferredOppositeDir, alternativeDir, alternativeOppositeDir] =
    determineStartAndEndDir(edge, effectiveDir)

  // Try preferred path
  const prefFrom = gridCoordDirection(edge.from.gridCoord!, preferredDir)
  const prefTo = gridCoordDirection(edge.to.gridCoord!, preferredOppositeDir)
  let preferredPath = getPath(graph.grid, prefFrom, prefTo)

  // Try alternative path
  const altFrom = gridCoordDirection(edge.from.gridCoord!, alternativeDir)
  const altTo = gridCoordDirection(edge.to.gridCoord!, alternativeOppositeDir)
  let alternativePath = getPath(graph.grid, altFrom, altTo)

  // Case 1: Both paths found — pick the shorter one
  if (preferredPath !== null && alternativePath !== null) {
    preferredPath = mergePath(preferredPath)
    alternativePath = mergePath(alternativePath)

    if (preferredPath.length <= alternativePath.length) {
      edge.startDir = preferredDir
      edge.endDir = preferredOppositeDir
      edge.path = preferredPath
    } else {
      edge.startDir = alternativeDir
      edge.endDir = alternativeOppositeDir
      edge.path = alternativePath
    }
    return
  }

  // Case 2: Only preferred path found
  if (preferredPath !== null) {
    edge.startDir = preferredDir
    edge.endDir = preferredOppositeDir
    edge.path = mergePath(preferredPath)
    return
  }

  // Case 3: Only alternative path found
  if (alternativePath !== null) {
    edge.startDir = alternativeDir
    edge.endDir = alternativeOppositeDir
    edge.path = mergePath(alternativePath)
    return
  }

  // Case 4: Both paths failed — create a direct fallback path
  // This happens for edges crossing subgraph boundaries where A* can't find
  // a clear route. We create a direct path from source to target exit points
  // so arrowheads can still be rendered correctly.
  edge.startDir = preferredDir
  edge.endDir = preferredOppositeDir
  edge.path = [prefFrom, prefTo]
}

/**
 * Find the best line segment in an edge's path to place a label on.
 * Prefers vertical segments for TD/BT graphs and horizontal for LR/RL to avoid
 * label collisions when multiple edges share initial segments.
 * Falls back to the widest segment if none are suitable.
 * Also increases the column width at the label position to fit the text.
 */
export function determineLabelLine(graph: AsciiGraph, edge: AsciiEdge): void {
  if (edge.text.length === 0) return

  const lenLabel = displayWidth(edge.text)
  const pathLen = edge.path.length
  const isVerticalFlow = graph.config.graphDirection === 'TD'

  // Collect all segments with their widths and orientation
  const segments: {
    line: [GridCoord, GridCoord]
    width: number
    index: number
    isVertical: boolean
  }[] = []

  for (let i = 1; i < pathLen; i++) {
    const p1 = edge.path[i - 1]!
    const p2 = edge.path[i]!
    const line: [GridCoord, GridCoord] = [p1, p2]
    const width = calculateLineWidth(graph, line)
    // A segment is vertical if X coords are same, horizontal if Y coords are same
    const isVertical = p1.x === p2.x
    segments.push({ line, width, index: i, isVertical })
  }

  // Find segments wide enough for the label, excluding the first segment
  // The first segment is often shared between edges from the same source node
  const suitableSegments = segments.filter(s => s.width >= lenLabel && s.index > 1)

  let largestLine: [GridCoord, GridCoord]

  if (suitableSegments.length > 0) {
    // Prefer segments near the end of the path (closer to target)
    // This avoids the shared initial segments from source
    suitableSegments.sort((a, b) => b.index - a.index)
    largestLine = suitableSegments[0]!.line
  } else {
    // Fall back to any suitable segment including the first
    const fallbackSegments = segments.filter(s => s.width >= lenLabel)
    if (fallbackSegments.length > 0) {
      fallbackSegments.sort((a, b) => b.index - a.index)
      largestLine = fallbackSegments[0]!.line
    } else {
      // No segment wide enough — use the widest one
      segments.sort((a, b) => b.width - a.width)
      largestLine = segments[0]?.line ?? [edge.path[0]!, edge.path[1]!]
    }
  }

  // Ensure column at midpoint is wide enough for the label
  const minX = Math.min(largestLine[0].x, largestLine[1].x)
  const maxX = Math.max(largestLine[0].x, largestLine[1].x)
  const middleX = minX + Math.floor((maxX - minX) / 2)

  const current = graph.columnWidth.get(middleX) ?? 0
  graph.columnWidth.set(middleX, Math.max(current, lenLabel + 2))

  edge.labelLine = [largestLine[0], largestLine[1]]
}

/** Calculate the total character width of a line segment by summing column widths. */
function calculateLineWidth(graph: AsciiGraph, line: [GridCoord, GridCoord]): number {
  let total = 0
  const startX = Math.min(line[0].x, line[1].x)
  const endX = Math.max(line[0].x, line[1].x)
  for (let x = startX; x <= endX; x++) {
    total += graph.columnWidth.get(x) ?? 0
  }
  return total
}
