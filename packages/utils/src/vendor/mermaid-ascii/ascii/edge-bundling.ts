// ============================================================================
// ASCII renderer — edge bundling for parallel links
//
// Analyzes edges to find parallel links (A & B --> C or A --> B & C) and
// groups them into bundles. Bundled edges share a visual junction point
// where they merge/split, creating cleaner diagrams.
//
// This module provides:
//   - analyzeEdgeBundles(): Finds and creates bundles from graph edges
//   - calculateJunctionPoint(): Computes optimal merge/split locations
//   - routeBundledEdges(): Routes edges through junction points
// ============================================================================

import type {
  AsciiGraph, AsciiNode, AsciiEdge, EdgeBundle, GridCoord, Direction,
} from './types'
import { Up, Down, Left, Right, Middle, gridKey, gridCoordEquals } from './types'
import { getPath, mergePath } from './pathfinder'
import { getNodeSubgraph } from './grid'

// ============================================================================
// Bundle analysis
// ============================================================================

/**
 * Analyze graph edges and create bundles for parallel links.
 *
 * Groups edges by:
 * - Fan-in: Multiple edges sharing the same target (A & B --> C)
 * - Fan-out: Multiple edges sharing the same source (A --> B & C)
 *
 * Only creates bundles when:
 * - Graph direction is TD (top-down) - LR routing handles merging naturally
 * - 2+ edges share the endpoint
 * - All edges have the same style (solid/dotted/thick)
 * - None of the edges have labels (labels would overlap at junction)
 * - Edges are not self-loops
 *
 * @returns Array of bundles. Each edge can belong to at most one bundle.
 */
export function analyzeEdgeBundles(graph: AsciiGraph): EdgeBundle[] {
  // Only bundle in TD direction - LR routing handles merging naturally at corners
  if (graph.config.graphDirection !== 'TD') {
    return []
  }
  const bundles: EdgeBundle[] = []
  const bundledEdges = new Set<AsciiEdge>()

  // Group edges by target (fan-in candidates)
  const edgesByTarget = new Map<AsciiNode, AsciiEdge[]>()
  for (const edge of graph.edges) {
    // Skip self-loops
    if (edge.from === edge.to) continue

    const existing = edgesByTarget.get(edge.to) ?? []
    existing.push(edge)
    edgesByTarget.set(edge.to, existing)
  }

  // Create fan-in bundles
  for (const [target, edges] of edgesByTarget) {
    if (edges.length < 2) continue
    if (!canBundle(edges, graph)) continue

    // Check if all edges are already bundled
    if (edges.some(e => bundledEdges.has(e))) continue

    const bundle: EdgeBundle = {
      type: 'fan-in',
      edges: [...edges],
      sharedNode: target,
      otherNodes: edges.map(e => e.from),
      junctionPoint: null,
      sharedPath: [],
      junctionDir: Middle,
      sharedNodeDir: Middle,
    }

    // Mark edges as bundled
    for (const edge of edges) {
      edge.bundle = bundle
      bundledEdges.add(edge)
    }

    bundles.push(bundle)
  }

  // Group edges by source (fan-out candidates)
  const edgesBySource = new Map<AsciiNode, AsciiEdge[]>()
  for (const edge of graph.edges) {
    // Skip self-loops and already bundled edges
    if (edge.from === edge.to) continue
    if (bundledEdges.has(edge)) continue

    const existing = edgesBySource.get(edge.from) ?? []
    existing.push(edge)
    edgesBySource.set(edge.from, existing)
  }

  // Create fan-out bundles
  for (const [source, edges] of edgesBySource) {
    if (edges.length < 2) continue
    if (!canBundle(edges, graph)) continue

    const bundle: EdgeBundle = {
      type: 'fan-out',
      edges: [...edges],
      sharedNode: source,
      otherNodes: edges.map(e => e.to),
      junctionPoint: null,
      sharedPath: [],
      junctionDir: Middle,
      sharedNodeDir: Middle,
    }

    // Mark edges as bundled
    for (const edge of edges) {
      edge.bundle = bundle
      bundledEdges.add(edge)
    }

    bundles.push(bundle)
  }

  return bundles
}

/**
 * Check if a group of edges can be bundled together.
 * Returns false if edges have different styles, any have labels,
 * or if the edges span subgraph boundaries (which creates complex routing).
 */
function canBundle(edges: AsciiEdge[], graph: AsciiGraph): boolean {
  if (edges.length < 2) return false

  const firstStyle = edges[0]!.style
  const firstFromSg = getNodeSubgraph(graph, edges[0]!.from)
  const firstToSg = getNodeSubgraph(graph, edges[0]!.to)

  for (const edge of edges) {
    // Different styles can't be bundled (would look confusing)
    if (edge.style !== firstStyle) return false

    // Edges with labels can't be bundled (labels would overlap at junction)
    if (edge.text.length > 0) return false

    // Don't bundle if edges span different subgraph boundaries
    // (creates complex routing that doesn't look good)
    const fromSg = getNodeSubgraph(graph, edge.from)
    const toSg = getNodeSubgraph(graph, edge.to)
    if (fromSg !== firstFromSg || toSg !== firstToSg) return false

    // Don't bundle if source and target are in different subgraphs
    // (cross-boundary edges have special routing needs)
    if (fromSg !== toSg) return false
  }

  return true
}

// ============================================================================
// Junction point calculation
// ============================================================================

/**
 * Calculate the optimal junction point for a bundle.
 *
 * For fan-in (A & B --> C):
 *   - Junction is placed between the sources and the target
 *   - In TD: above the target, horizontally centered between sources
 *   - In LR: left of the target, vertically centered between sources
 *
 * For fan-out (A --> B & C):
 *   - Junction is placed between the source and the targets
 *   - In TD: below the source, horizontally centered between targets
 *   - In LR: right of the source, vertically centered between targets
 */
export function calculateJunctionPoint(
  graph: AsciiGraph,
  bundle: EdgeBundle,
): GridCoord {
  const dir = graph.config.graphDirection
  const sharedCoord = bundle.sharedNode.gridCoord!
  const otherCoords = bundle.otherNodes.map(n => n.gridCoord!)

  if (bundle.type === 'fan-in') {
    // Junction is BEFORE the shared target
    // Calculate center of sources
    const minX = Math.min(...otherCoords.map(c => c.x))
    const maxX = Math.max(...otherCoords.map(c => c.x))
    const minY = Math.min(...otherCoords.map(c => c.y))
    const maxY = Math.max(...otherCoords.map(c => c.y))

    if (dir === 'TD') {
      // Junction above target, centered between sources
      // Place it one row above the target's entry point
      const junctionY = sharedCoord.y - 1
      // X is centered between sources, but clamped to shared node's X for alignment
      const centerX = Math.floor((minX + maxX) / 2) + 1 // +1 for center of 3x3 block
      const junctionX = sharedCoord.x + 1 // Align with target's center

      return { x: junctionX, y: junctionY }
    } else {
      // LR: Junction left of target, centered between sources
      const junctionX = sharedCoord.x - 1
      const junctionY = sharedCoord.y + 1 // Align with target's center

      return { x: junctionX, y: junctionY }
    }
  } else {
    // fan-out: Junction is AFTER the shared source
    const minX = Math.min(...otherCoords.map(c => c.x))
    const maxX = Math.max(...otherCoords.map(c => c.x))
    const minY = Math.min(...otherCoords.map(c => c.y))
    const maxY = Math.max(...otherCoords.map(c => c.y))

    if (dir === 'TD') {
      // Junction below source, will then split to targets
      const junctionY = sharedCoord.y + 3 // Just below source's 3x3 block
      const junctionX = sharedCoord.x + 1 // Align with source's center

      return { x: junctionX, y: junctionY }
    } else {
      // LR: Junction right of source
      const junctionX = sharedCoord.x + 3
      const junctionY = sharedCoord.y + 1

      return { x: junctionX, y: junctionY }
    }
  }
}

// ============================================================================
// Bundled edge routing
// ============================================================================

/**
 * Route all edges in a bundle through the junction point.
 *
 * For fan-in bundles:
 *   1. Route each source → junction (stored in edge.pathToJunction)
 *   2. Route junction → target (stored in bundle.sharedPath)
 *
 * For fan-out bundles:
 *   1. Route source → junction (stored in bundle.sharedPath)
 *   2. Route junction → each target (stored in edge.pathToJunction)
 */
export function routeBundledEdges(graph: AsciiGraph, bundle: EdgeBundle): void {
  const dir = graph.config.graphDirection

  // Calculate and store junction point
  bundle.junctionPoint = calculateJunctionPoint(graph, bundle)
  const junction = bundle.junctionPoint

  // Determine directions based on graph direction and bundle type
  if (bundle.type === 'fan-in') {
    // Sources converge to junction, then junction to target
    bundle.junctionDir = dir === 'TD' ? Up : Left
    bundle.sharedNodeDir = dir === 'TD' ? Down : Right

    // Route junction → target (shared path)
    const targetCoord = bundle.sharedNode.gridCoord!
    const targetEntry = dir === 'TD'
      ? { x: targetCoord.x + 1, y: targetCoord.y } // Top center of target
      : { x: targetCoord.x, y: targetCoord.y + 1 } // Left center of target

    const sharedPath = getPath(graph.grid, junction, targetEntry)
    bundle.sharedPath = sharedPath ? mergePath(sharedPath) : [junction, targetEntry]

    // Route each source → junction
    for (const edge of bundle.edges) {
      const sourceCoord = edge.from.gridCoord!
      const sourceExit = dir === 'TD'
        ? { x: sourceCoord.x + 1, y: sourceCoord.y + 2 } // Bottom center of source
        : { x: sourceCoord.x + 2, y: sourceCoord.y + 1 } // Right center of source

      const pathToJunction = getPath(graph.grid, sourceExit, junction)
      edge.pathToJunction = pathToJunction ? mergePath(pathToJunction) : [sourceExit, junction]

      // Set edge directions for proper drawing
      edge.startDir = dir === 'TD' ? Down : Right
      edge.endDir = dir === 'TD' ? Up : Left

      // Build full path for grid size calculation: source → junction → target
      edge.path = [...edge.pathToJunction, ...bundle.sharedPath.slice(1)]
    }
  } else {
    // fan-out: Source to junction, then junction splits to targets
    bundle.junctionDir = dir === 'TD' ? Down : Right
    bundle.sharedNodeDir = dir === 'TD' ? Up : Left

    // Route source → junction (shared path)
    const sourceCoord = bundle.sharedNode.gridCoord!
    const sourceExit = dir === 'TD'
      ? { x: sourceCoord.x + 1, y: sourceCoord.y + 2 } // Bottom center of source
      : { x: sourceCoord.x + 2, y: sourceCoord.y + 1 } // Right center of source

    const sharedPath = getPath(graph.grid, sourceExit, junction)
    bundle.sharedPath = sharedPath ? mergePath(sharedPath) : [sourceExit, junction]

    // Route junction → each target
    for (const edge of bundle.edges) {
      const targetCoord = edge.to.gridCoord!
      const targetEntry = dir === 'TD'
        ? { x: targetCoord.x + 1, y: targetCoord.y } // Top center of target
        : { x: targetCoord.x, y: targetCoord.y + 1 } // Left center of target

      const pathToJunction = getPath(graph.grid, junction, targetEntry)
      edge.pathToJunction = pathToJunction ? mergePath(pathToJunction) : [junction, targetEntry]

      // Set edge directions
      edge.startDir = dir === 'TD' ? Down : Right
      edge.endDir = dir === 'TD' ? Up : Left

      // Build full path for grid size calculation: source → junction → target
      edge.path = [...bundle.sharedPath, ...edge.pathToJunction.slice(1)]
    }
  }
}

/**
 * Process all bundles in a graph: calculate junction points and route edges.
 */
export function processBundles(graph: AsciiGraph): void {
  for (const bundle of graph.bundles) {
    routeBundledEdges(graph, bundle)
  }
}
