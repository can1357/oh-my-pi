// ============================================================================
// ASCII renderer — MermaidGraph → AsciiGraph converter
//
// Bridges the existing TypeScript parser output to the ASCII renderer's
// internal graph structure. This avoids maintaining a separate parser
// for ASCII rendering — we reuse parseMermaid() and convert its output.
// ============================================================================

import type { MermaidGraph, MermaidSubgraph } from '../types'
import type {
  AsciiGraph, AsciiNode, AsciiEdge, AsciiSubgraph, AsciiConfig,
} from './types'
import { EMPTY_STYLE } from './types'
import { mkCanvas, mkRoleCanvas } from './canvas'

/**
 * Convert a parsed MermaidGraph into an AsciiGraph ready for grid layout.
 *
 * Key mappings:
 * - MermaidGraph.nodes (Map) → ordered AsciiNode[] preserving insertion order
 * - MermaidGraph.edges → AsciiEdge[] with resolved node references
 * - MermaidGraph.subgraphs → AsciiSubgraph[] with parent/child tree
 * - Node labels are used as display names (not raw IDs)
 */
export function convertToAsciiGraph(parsed: MermaidGraph, config: AsciiConfig): AsciiGraph {
  // Build node list preserving Map insertion order
  const nodeMap = new Map<string, AsciiNode>()
  let index = 0

  for (const [id, mNode] of parsed.nodes) {
    const asciiNode: AsciiNode = {
      // Use the parser ID as the unique identity key to avoid collisions
      // when multiple nodes share the same label (e.g. A[Web Server], C[Web Server]).
      name: id,
      // The label is used for rendering inside the box.
      displayLabel: mNode.label,
      // Preserve shape from parser for shape-aware rendering
      shape: mNode.shape,
      index,
      gridCoord: null,
      drawingCoord: null,
      drawing: null,
      drawn: false,
      styleClassName: '',
      styleClass: EMPTY_STYLE,
    }
    nodeMap.set(id, asciiNode)
    index++
  }

  const nodes = [...nodeMap.values()]

  // Build edges with resolved node references
  const edges: AsciiEdge[] = []
  for (const mEdge of parsed.edges) {
    const from = nodeMap.get(mEdge.source)
    const to = nodeMap.get(mEdge.target)
    if (!from || !to) continue

    edges.push({
      from,
      to,
      text: mEdge.label ?? '',
      path: [],
      labelLine: [],
      startDir: { x: 0, y: 0 },
      endDir: { x: 0, y: 0 },
      style: mEdge.style,
      hasArrowStart: mEdge.hasArrowStart,
      hasArrowEnd: mEdge.hasArrowEnd,
    })
  }

  // Convert subgraphs recursively
  const subgraphs: AsciiSubgraph[] = []
  for (const mSg of parsed.subgraphs) {
    convertSubgraph(mSg, null, nodeMap, subgraphs)
  }

  // Deduplicate subgraph node membership to match Go parser behavior.
  // In Go, a node belongs only to the subgraph where it was FIRST DEFINED.
  // The TS parser adds referenced nodes to all subgraphs they appear in,
  // which causes incorrect bounding boxes when nodes span subgraph boundaries.
  deduplicateSubgraphNodes(parsed.subgraphs, subgraphs, nodeMap, parsed)

  // Apply class definitions
  for (const [nodeId, className] of parsed.classAssignments) {
    const node = nodeMap.get(nodeId)
    const classDef = parsed.classDefs.get(className)
    if (node && classDef) {
      node.styleClassName = className
      node.styleClass = { name: className, styles: classDef }
    }
  }

  return {
    nodes,
    edges,
    canvas: mkCanvas(0, 0),
    roleCanvas: mkRoleCanvas(0, 0),
    grid: new Map(),
    columnWidth: new Map(),
    rowHeight: new Map(),
    subgraphs,
    config,
    offsetX: 0,
    offsetY: 0,
    bundles: [], // Populated by analyzeEdgeBundles() during layout
  }
}

/**
 * Recursively convert a MermaidSubgraph to AsciiSubgraph.
 * Flattens the tree into the subgraphs array while maintaining parent/child references.
 * This matches the Go implementation where all subgraphs are in a flat list
 * but linked via parent/children pointers.
 */
function convertSubgraph(
  mSg: MermaidSubgraph,
  parent: AsciiSubgraph | null,
  nodeMap: Map<string, AsciiNode>,
  allSubgraphs: AsciiSubgraph[],
): AsciiSubgraph {
  // Normalize subgraph direction: BT→TD, RL→LR (same as root graph normalization)
  let normalizedDirection: 'LR' | 'TD' | undefined
  if (mSg.direction) {
    normalizedDirection = (mSg.direction === 'LR' || mSg.direction === 'RL') ? 'LR' : 'TD'
  }

  const sg: AsciiSubgraph = {
    name: mSg.label,
    nodes: [],
    parent,
    children: [],
    minX: 0, minY: 0, maxX: 0, maxY: 0,
    direction: normalizedDirection,
  }

  // Resolve node references
  for (const nodeId of mSg.nodeIds) {
    const node = nodeMap.get(nodeId)
    if (node) sg.nodes.push(node)
  }

  allSubgraphs.push(sg)

  // Recurse into children
  for (const childMSg of mSg.children) {
    const child = convertSubgraph(childMSg, sg, nodeMap, allSubgraphs)
    sg.children.push(child)

    // Child nodes are also part of parent subgraphs (Go behavior).
    // The Go parser adds nodes to ALL subgraphs in the stack, so a nested
    // node belongs to both the inner and outer subgraph.
    for (const childNode of child.nodes) {
      if (!sg.nodes.includes(childNode)) {
        sg.nodes.push(childNode)
      }
    }
  }

  return sg
}

/**
 * Deduplicate subgraph node membership to match Go parser behavior.
 *
 * The Go parser only adds a node to the subgraph that was active when the node
 * was FIRST CREATED. If a node is later referenced inside a different subgraph,
 * it is NOT added to that subgraph. The TS parser is more permissive — it adds
 * referenced nodes to whichever subgraph they appear in.
 *
 * This function fixes the discrepancy by:
 * 1. Walking the edges to determine which nodes were first created inside each subgraph
 * 2. Removing nodes from subgraphs where they weren't first created
 */
function deduplicateSubgraphNodes(
  mermaidSubgraphs: MermaidSubgraph[],
  asciiSubgraphs: AsciiSubgraph[],
  nodeMap: Map<string, AsciiNode>,
  parsed: MermaidGraph,
): void {
  // Build a map from MermaidSubgraph to its corresponding AsciiSubgraph.
  // The ordering matches since we convert them in the same order.
  const sgMap = new Map<MermaidSubgraph, AsciiSubgraph>()
  buildSgMap(mermaidSubgraphs, asciiSubgraphs, sgMap)

  // Determine which subgraph each node was "first defined" in.
  // A node is first defined in the subgraph where it first appears as a NEW node
  // in the ordered edge/node list. We approximate this by checking the global
  // node insertion order against subgraph membership.
  const nodeOwner = new Map<string, AsciiSubgraph>() // nodeId → owning subgraph

  // Walk all mermaid subgraphs in document order. For each subgraph,
  // claim nodes that haven't been claimed yet by any previous subgraph.
  function claimNodes(mSg: MermaidSubgraph): void {
    const asciiSg = sgMap.get(mSg)
    if (!asciiSg) return

    // Recurse into children first (they appear before parent in the Go parser stack,
    // but nodes defined in children are added to parent too — this is handled by
    // the convertSubgraph function which propagates child nodes to parents).
    // For dedup, we process children first so their claims propagate up correctly.
    for (const child of mSg.children) {
      claimNodes(child)
    }

    // Claim unclaimed nodes in this subgraph
    for (const nodeId of mSg.nodeIds) {
      if (!nodeOwner.has(nodeId)) {
        nodeOwner.set(nodeId, asciiSg)
      }
    }
  }

  for (const mSg of mermaidSubgraphs) {
    claimNodes(mSg)
  }

  // Now remove nodes from subgraphs that don't own them.
  // A node should remain in: its owner subgraph + all ancestors of the owner.
  for (const asciiSg of asciiSubgraphs) {
    asciiSg.nodes = asciiSg.nodes.filter(node => {
      // Find this node's ID in the nodeMap
      let nodeId: string | undefined
      for (const [id, n] of nodeMap) {
        if (n === node) { nodeId = id; break }
      }
      if (!nodeId) return false

      const owner = nodeOwner.get(nodeId)
      if (!owner) return true // not in any subgraph claim — keep as-is

      // Keep the node if this subgraph is the owner or an ancestor of the owner
      return isAncestorOrSelf(asciiSg, owner)
    })
  }
}

/** Check if `candidate` is the same as or an ancestor of `target`. */
function isAncestorOrSelf(candidate: AsciiSubgraph, target: AsciiSubgraph): boolean {
  let current: AsciiSubgraph | null = target
  while (current !== null) {
    if (current === candidate) return true
    current = current.parent
  }
  return false
}

/** Build a mapping from MermaidSubgraph → AsciiSubgraph (matching by position). */
function buildSgMap(
  mSgs: MermaidSubgraph[],
  aSgs: AsciiSubgraph[],
  result: Map<MermaidSubgraph, AsciiSubgraph>,
): void {
  // The asciiSubgraphs array is flat (all subgraphs including nested ones),
  // while mermaidSubgraphs is hierarchical. We need to flatten the mermaid tree
  // in the same order the converter processes them (pre-order DFS).
  const flatMermaid: MermaidSubgraph[] = []
  function flatten(sgs: MermaidSubgraph[]): void {
    for (const sg of sgs) {
      flatMermaid.push(sg)
      flatten(sg.children)
    }
  }
  flatten(mSgs)

  for (let i = 0; i < flatMermaid.length && i < aSgs.length; i++) {
    result.set(flatMermaid[i]!, aSgs[i]!)
  }
}
