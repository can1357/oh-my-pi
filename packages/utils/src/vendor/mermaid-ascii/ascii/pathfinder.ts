// ============================================================================
// ASCII renderer — A* pathfinding for edge routing
//
// Ported from AlexanderGrooff/mermaid-ascii cmd/arrow.go.
// Uses A* search with a corner-penalizing heuristic to find clean
// paths between nodes on the grid. Prefers straight lines over zigzags.
// ============================================================================

import type { GridCoord, AsciiNode } from './types'
import { gridKey, gridCoordEquals } from './types'

// ============================================================================
// Priority queue (min-heap) for A* open set
// ============================================================================

interface PQItem {
  coord: GridCoord
  priority: number
}

/**
 * Simple min-heap priority queue.
 * For the grid sizes we handle (~100s of cells), this is more than fast enough.
 */
class MinHeap {
  private items: PQItem[] = []

  get length(): number {
    return this.items.length
  }

  push(item: PQItem): void {
    this.items.push(item)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): PQItem | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]!
    const last = this.items.pop()!
    if (this.items.length > 0) {
      this.items[0] = last
      this.sinkDown(0)
    }
    return top
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.items[i]!.priority < this.items[parent]!.priority) {
        ;[this.items[i], this.items[parent]] = [this.items[parent]!, this.items[i]!]
        i = parent
      } else {
        break
      }
    }
  }

  private sinkDown(i: number): void {
    const n = this.items.length
    while (true) {
      let smallest = i
      const left = 2 * i + 1
      const right = 2 * i + 2
      if (left < n && this.items[left]!.priority < this.items[smallest]!.priority) {
        smallest = left
      }
      if (right < n && this.items[right]!.priority < this.items[smallest]!.priority) {
        smallest = right
      }
      if (smallest !== i) {
        ;[this.items[i], this.items[smallest]] = [this.items[smallest]!, this.items[i]!]
        i = smallest
      } else {
        break
      }
    }
  }
}

// ============================================================================
// A* heuristic
// ============================================================================

/**
 * Manhattan distance with a +1 penalty when both dx and dy are non-zero.
 * This encourages the pathfinder to prefer straight lines and minimize corners.
 */
export function heuristic(a: GridCoord, b: GridCoord): number {
  const absX = Math.abs(a.x - b.x)
  const absY = Math.abs(a.y - b.y)
  if (absX === 0 || absY === 0) {
    return absX + absY
  }
  return absX + absY + 1
}

// ============================================================================
// A* pathfinding
// ============================================================================

/** 4-directional movement (no diagonals in grid pathfinding). */
const MOVE_DIRS: GridCoord[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
]

interface SearchBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  expansionLimit: number
}

const MIN_ROUTING_MARGIN = 8
const MIN_EXPANSION_BUDGET = 256
const MAX_EXPANSION_BUDGET = 50_000

function searchBoundsFor(grid: Map<string, AsciiNode>, from: GridCoord, to: GridCoord): SearchBounds {
  let minX = Math.min(from.x, to.x)
  let maxX = Math.max(from.x, to.x)
  let minY = Math.min(from.y, to.y)
  let maxY = Math.max(from.y, to.y)

  for (const key of grid.keys()) {
    const comma = key.indexOf(',')
    if (comma === -1) continue

    const x = Number(key.slice(0, comma))
    const y = Number(key.slice(comma + 1))
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const margin = Math.max(MIN_ROUTING_MARGIN, Math.ceil(Math.max(width, height) / 2))
  const boundedMinX = Math.max(0, minX - margin)
  const boundedMaxX = maxX + margin
  const boundedMinY = Math.max(0, minY - margin)
  const boundedMaxY = maxY + margin
  const area = (boundedMaxX - boundedMinX + 1) * (boundedMaxY - boundedMinY + 1)

  return {
    minX: boundedMinX,
    maxX: boundedMaxX,
    minY: boundedMinY,
    maxY: boundedMaxY,
    expansionLimit: Math.min(MAX_EXPANSION_BUDGET, Math.max(MIN_EXPANSION_BUDGET, area * 4)),
  }
}

/** Check if a grid cell is unoccupied and inside the bounded routing area. */
function isFreeInGrid(grid: Map<string, AsciiNode>, c: GridCoord, bounds: SearchBounds): boolean {
  if (c.x < bounds.minX || c.x > bounds.maxX || c.y < bounds.minY || c.y > bounds.maxY) {
    return false
  }

  return !grid.has(gridKey(c))
}

/**
 * Find a path from `from` to `to` on the grid using A*.
 * Returns the path as an array of GridCoords, or null if no bounded path exists.
 */
export function getPath(
  grid: Map<string, AsciiNode>,
  from: GridCoord,
  to: GridCoord,
): GridCoord[] | null {
  const bounds = searchBoundsFor(grid, from, to)
  const pq = new MinHeap()
  pq.push({ coord: from, priority: 0 })

  const costSoFar = new Map<string, number>()
  costSoFar.set(gridKey(from), 0)

  const cameFrom = new Map<string, GridCoord | null>()
  cameFrom.set(gridKey(from), null)

  let expansions = 0

  while (pq.length > 0) {
    if (expansions++ >= bounds.expansionLimit) {
      return null
    }

    const current = pq.pop()!.coord

    if (gridCoordEquals(current, to)) {
      // Reconstruct path by walking backwards through cameFrom
      const path: GridCoord[] = []
      let c: GridCoord | null = current
      while (c !== null) {
        path.unshift(c)
        c = cameFrom.get(gridKey(c)) ?? null
      }
      return path
    }

    const currentCost = costSoFar.get(gridKey(current))!

    for (const dir of MOVE_DIRS) {
      const next: GridCoord = { x: current.x + dir.x, y: current.y + dir.y }
      const insideBounds = next.x >= bounds.minX && next.x <= bounds.maxX
        && next.y >= bounds.minY && next.y <= bounds.maxY

      // Allow moving to the destination even if it's occupied (it's a node boundary)
      if (!insideBounds || (!isFreeInGrid(grid, next, bounds) && !gridCoordEquals(next, to))) {
        continue
      }

      const newCost = currentCost + 1
      const nextKey = gridKey(next)
      const existingCost = costSoFar.get(nextKey)

      if (existingCost === undefined || newCost < existingCost) {
        costSoFar.set(nextKey, newCost)
        const priority = newCost + heuristic(next, to)
        pq.push({ coord: next, priority })
        cameFrom.set(nextKey, current)
      }
    }
  }

  return null // No path found
}

/**
 * Simplify a path by removing intermediate waypoints on straight segments.
 * E.g., [(0,0), (1,0), (2,0), (2,1)] becomes [(0,0), (2,0), (2,1)].
 * This reduces the number of line-drawing operations.
 */
export function mergePath(path: GridCoord[]): GridCoord[] {
  if (path.length <= 2) return path

  const toRemove = new Set<number>()
  let step0 = path[0]!
  let step1 = path[1]!

  for (let idx = 2; idx < path.length; idx++) {
    const step2 = path[idx]!
    const prevDx = step1.x - step0.x
    const prevDy = step1.y - step0.y
    const dx = step2.x - step1.x
    const dy = step2.y - step1.y

    // Same direction — the middle point is redundant
    if (prevDx === dx && prevDy === dy) {
      // In Go: indexToRemove = append(indexToRemove, idx+1) but idx is 0-based from path[2:]
      // which corresponds to index idx in the full path. Go uses idx+1 because idx iterates
      // from 0 in the [2:] slice, mapping to full-array index idx+1.
      // Actually re-checking Go code: the loop is `for idx, step2 := range path[2:]`
      // so idx=0 → path[2], and it removes idx+1 which is index 1 in the full array.
      // Wait, that doesn't look right. Let me re-read:
      //   step0 = path[0], step1 = path[1]
      //   for idx, step2 := range path[2:] { ... indexToRemove = append(indexToRemove, idx+1) ... }
      //   When idx=0, step2=path[2], and it removes index 1 (step1 = path[1]) if directions match
      // So it removes the middle point (step1) which is at index idx+1 in the original array
      // when counting from the 2-ahead loop. Let me just track which middle indices to remove.
      toRemove.add(idx - 1) // Remove the middle point (step1's position)
    }

    step0 = step1
    step1 = step2
  }

  return path.filter((_, i) => !toRemove.has(i))
}
