// ============================================================================
// ASCII renderer — class diagrams
//
// Renders classDiagram text to ASCII/Unicode art.
// Each class is a multi-compartment box (header | attributes | methods).
// Relationships are drawn as lines between classes with UML markers.
//
// Layout: level-based top-down. "From" classes are placed above "to" classes
// for all relationship types, matching ELK/mermaid.com behavior.
// Relationship lines use simple Manhattan routing (vertical + horizontal).
// ============================================================================

import { parseClassDiagram } from '../class/parser'
import type { ClassDiagram, ClassNode, ClassMember, ClassRelationship, RelationshipType } from '../class/types'
import type { Canvas, AsciiConfig, RoleCanvas, CharRole, AsciiTheme, ColorMode } from './types'
import { mkCanvas, mkRoleCanvas, canvasToString, increaseSize, increaseRoleCanvasSize, setRole } from './canvas'
import { drawMultiBox } from './draw'
import { splitLines } from './multiline-utils'
import { displayWidth, toCells } from '../text-metrics'

/** Classify a character from a box drawing as 'border' or 'text'. */
function classifyBoxChar(ch: string): CharRole {
  if (/^[┌┐└┘├┤┬┴┼│─╭╮╰╯+\-|]$/.test(ch)) return 'border'
  return 'text'
}

// ============================================================================
// Class member formatting
// ============================================================================

/** Format a class member as a display string: visibility + name + optional type */
function formatMember(m: ClassMember): string {
  const vis = m.visibility || ''
  const type = m.type ? `: ${m.type}` : ''
  return `${vis}${m.name}${type}`
}

/** Build the text sections for a class box: [header], [attributes], [methods] */
function buildClassSections(cls: ClassNode): string[][] {
  // Header section: optional annotation + class name (may be multi-line)
  const header: string[] = []
  if (cls.annotation) header.push(`<<${cls.annotation}>>`)
  // Support multi-line class names
  const nameLines = splitLines(cls.label)
  header.push(...nameLines)

  // Attributes section
  const attrs = cls.attributes.map(formatMember)

  // Methods section
  const methods = cls.methods.map(formatMember)

  // If no attrs and no methods, just return header (1-section box)
  if (attrs.length === 0 && methods.length === 0) return [header]
  // If no methods, return header + attrs (2-section box)
  if (methods.length === 0) return [header, attrs]
  // Full 3-section box
  return [header, attrs, methods]
}

// ============================================================================
// Relationship marker characters
// ============================================================================

interface RelMarker {
  /** Relationship type (determines marker shape) */
  type: RelationshipType
  /** Which end the marker is placed at */
  markerAt: 'from' | 'to'
  /** Whether the line is dashed */
  dashed: boolean
}

/**
 * Build the marker metadata for a relationship.
 * The actual marker character will be determined at placement time based on line direction.
 */
function getRelMarker(type: RelationshipType, markerAt: 'from' | 'to'): RelMarker {
  const dashed = type === 'dependency' || type === 'realization'
  return { type, markerAt, dashed }
}

/**
 * Get the UML marker shape character for a relationship type.
 * For directional arrows (association/dependency), the direction parameter
 * specifies which way the arrow should point.
 */
function getMarkerShape(
  type: RelationshipType,
  useAscii: boolean,
  direction?: 'up' | 'down' | 'left' | 'right'
): string {
  switch (type) {
    case 'inheritance':
    case 'realization':
      // Hollow triangle - rotate based on line direction
      // Triangle points TOWARD the parent class
      if (direction === 'down') {
        // Line goes down (parent above, child below) - triangle points UP
        return useAscii ? '^' : '△'
      } else if (direction === 'up') {
        // Line goes up (parent below, child above) - triangle points DOWN
        return useAscii ? 'v' : '▽'
      } else if (direction === 'left') {
        // Line goes left - triangle points LEFT
        return useAscii ? '>' : '◁'
      } else {
        // Default: line goes right - triangle points RIGHT
        return useAscii ? '<' : '▷'
      }
    case 'composition':
      // Filled diamond - omnidirectional shape
      return useAscii ? '*' : '◆'
    case 'aggregation':
      // Hollow diamond - omnidirectional shape
      return useAscii ? 'o' : '◇'
    case 'association':
    case 'dependency':
      // Directional arrow - rotate based on line direction
      if (direction === 'down') {
        return useAscii ? 'v' : '▼'
      } else if (direction === 'up') {
        return useAscii ? '^' : '▲'
      } else if (direction === 'left') {
        return useAscii ? '<' : '◀'
      } else {
        // Default to right (or when direction not specified)
        return useAscii ? '>' : '▶'
      }
  }
}

// ============================================================================
// Layout and rendering
// ============================================================================

/** Positioned class node on the canvas */
interface PlacedClass {
  cls: ClassNode
  sections: string[][]
  x: number
  y: number
  width: number
  height: number
}

/**
 * Render a Mermaid class diagram to ASCII/Unicode text.
 *
 * Pipeline: parse → build boxes → level-based layout → draw boxes → draw relationships → string.
 */
export function renderClassAscii(text: string, config: AsciiConfig, colorMode?: ColorMode, theme?: AsciiTheme): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  const diagram = parseClassDiagram(lines)

  if (diagram.classes.length === 0) return ''

  const useAscii = config.useAscii
  const hGap = 4  // horizontal gap between class boxes
  const vGap = 3  // vertical gap between levels (enough for relationship lines)

  // --- Build box dimensions for each class ---
  const classSections = new Map<string, string[][]>()
  const classBoxW = new Map<string, number>()
  const classBoxH = new Map<string, number>()

  for (const cls of diagram.classes) {
    const sections = buildClassSections(cls)
    classSections.set(cls.id, sections)

    // Compute box dimensions from drawMultiBox logic
    let maxTextW = 0
    for (const section of sections) {
      for (const line of section) maxTextW = Math.max(maxTextW, displayWidth(line))
    }
    const boxW = maxTextW + 4 // 2 border + 2 padding

    let totalLines = 0
    for (const section of sections) totalLines += Math.max(section.length, 1)
    const boxH = totalLines + (sections.length - 1) + 2 // section lines + dividers + top/bottom border

    classBoxW.set(cls.id, boxW)
    classBoxH.set(cls.id, boxH)
  }

  // --- Assign levels: topological sort based on directed relationships ---
  // All relationship types place "from" above "to" in the layout, matching
  // ELK's layered algorithm and the official mermaid.com renderer behavior.
  // For "Animal <|-- Dog": from="Animal", to="Dog" → Animal above Dog.
  //
  // Every relationship type (including association and dependency) forces nodes
  // to different levels. Same-row routing for mixed diagrams causes collisions:
  // detour lines overlap with cross-level routing, and labels overwrite box borders.

  const classById = new Map<string, ClassNode>()
  for (const cls of diagram.classes) classById.set(cls.id, cls)

  const parents = new Map<string, Set<string>>()  // child → set of parent IDs
  const children = new Map<string, Set<string>>() // parent → set of child IDs

  for (const rel of diagram.relationships) {
    // For inheritance/realization, the marker (hollow triangle) points to the parent.
    // - `Animal <|-- Dog` (markerAt='from'): Animal is parent, Dog is child
    // - `Bird ..|> Flyable` (markerAt='to'): Flyable is parent, Bird is child
    // For other relationships, use the default from→to direction.
    const isHierarchical = rel.type === 'inheritance' || rel.type === 'realization'
    const parentId = isHierarchical && rel.markerAt === 'to' ? rel.to : rel.from
    const childId = isHierarchical && rel.markerAt === 'to' ? rel.from : rel.to

    if (!parents.has(childId)) parents.set(childId, new Set())
    parents.get(childId)!.add(parentId)
    if (!children.has(parentId)) children.set(parentId, new Set())
    children.get(parentId)!.add(childId)
  }

  // BFS from roots (classes that have no parents) to assign levels.
  // Cap at classes.length - 1 to prevent infinite loops on cyclic graphs
  // (e.g. View --> Model and Model ..> View would otherwise push levels
  // upward forever). In a DAG the longest path has at most N-1 edges.
  const level = new Map<string, number>()
  const roots = diagram.classes.filter(c => !parents.has(c.id) || parents.get(c.id)!.size === 0)
  const queue: string[] = roots.map(c => c.id)
  for (const id of queue) level.set(id, 0)

  const levelCap = diagram.classes.length - 1
  let qi = 0
  while (qi < queue.length) {
    const id = queue[qi++]!
    const childSet = children.get(id)
    if (!childSet) continue
    for (const childId of childSet) {
      const newLevel = (level.get(id) ?? 0) + 1
      if (newLevel > levelCap) continue // cycle detected — skip to prevent infinite loop
      if (!level.has(childId) || level.get(childId)! < newLevel) {
        level.set(childId, newLevel)
        queue.push(childId)
      }
    }
  }

  // Assign remaining (unconnected) classes to level 0
  for (const cls of diagram.classes) {
    if (!level.has(cls.id)) level.set(cls.id, 0)
  }

  // --- Position classes by level ---
  // Group classes by level
  const maxLevel = Math.max(...[...level.values()], 0)
  const levelGroups: string[][] = Array.from({ length: maxLevel + 1 }, () => [])
  for (const cls of diagram.classes) {
    levelGroups[level.get(cls.id)!]!.push(cls.id)
  }

  // Compute positions: each level is a row, classes in a row are spaced horizontally
  const placed = new Map<string, PlacedClass>()
  let currentY = 0

  for (let lv = 0; lv <= maxLevel; lv++) {
    const group = levelGroups[lv]!
    if (group.length === 0) continue

    let currentX = 0
    let maxH = 0

    for (const id of group) {
      const cls = classById.get(id)!
      const w = classBoxW.get(id)!
      const h = classBoxH.get(id)!
      placed.set(id, {
        cls,
        sections: classSections.get(id)!,
        x: currentX,
        y: currentY,
        width: w,
        height: h,
      })
      currentX += w + hGap
      maxH = Math.max(maxH, h)
    }

    currentY += maxH + vGap
  }

  // --- Create canvas ---
  let totalW = 0
  let totalH = 0
  for (const p of placed.values()) {
    totalW = Math.max(totalW, p.x + p.width)
    totalH = Math.max(totalH, p.y + p.height)
  }

  // Extra space for relationship lines that may go below/beside
  totalW += 4
  totalH += 2

  const canvas = mkCanvas(totalW - 1, totalH - 1)
  const rc = mkRoleCanvas(totalW - 1, totalH - 1)

  /** Set a character on the canvas and track its role. */
  function setC(x: number, y: number, ch: string, role: CharRole): void {
    if (x >= 0 && x < canvas.length && y >= 0 && y < (canvas[0]?.length ?? 0)) {
      canvas[x]![y] = ch
      setRole(rc, x, y, role)
    }
  }

  // --- Draw class boxes ---
  for (const p of placed.values()) {
    const boxCanvas = drawMultiBox(p.sections, useAscii)
    // Copy box onto main canvas at (p.x, p.y) with role tracking
    for (let bx = 0; bx < boxCanvas.length; bx++) {
      for (let by = 0; by < boxCanvas[0]!.length; by++) {
        const ch = boxCanvas[bx]![by]!
        if (ch !== ' ') {
          const cx = p.x + bx
          const cy = p.y + by
          if (cx < totalW && cy < totalH) {
            setC(cx, cy, ch, classifyBoxChar(ch))
          }
        }
      }
    }
  }

  // --- Build occupancy map for collision avoidance ---
  // Track which x positions are occupied at each y level (to avoid routing through boxes)
  const boxOccupancy: { x1: number; x2: number; y1: number; y2: number }[] = []
  for (const p of placed.values()) {
    boxOccupancy.push({
      x1: p.x,
      x2: p.x + p.width - 1,
      y1: p.y,
      y2: p.y + p.height - 1,
    })
  }

  /** Check if a point (x, y) is inside any class box */
  function isInsideBox(x: number, y: number, excludeIds?: Set<string>): boolean {
    for (const [id, p] of placed.entries()) {
      if (excludeIds?.has(id)) continue
      if (x >= p.x && x <= p.x + p.width - 1 && y >= p.y && y <= p.y + p.height - 1) {
        return true
      }
    }
    return false
  }

  /** Find a clear vertical column for routing that doesn't pass through any boxes */
  function findClearColumn(startX: number, y1: number, y2: number, excludeIds: Set<string>): number {
    // Try the original column first
    let clear = true
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      if (isInsideBox(startX, y, excludeIds)) {
        clear = false
        break
      }
    }
    if (clear) return startX

    // Try columns to the left and right, alternating
    for (let offset = 1; offset < totalW + 10; offset++) {
      // Try right
      const rightX = startX + offset
      clear = true
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        if (isInsideBox(rightX, y, excludeIds)) {
          clear = false
          break
        }
      }
      if (clear) return rightX

      // Try left
      const leftX = startX - offset
      if (leftX >= 0) {
        clear = true
        for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
          if (isInsideBox(leftX, y, excludeIds)) {
            clear = false
            break
          }
        }
        if (clear) return leftX
      }
    }

    // Fallback to right edge of canvas + some extra space
    return totalW + 2
  }

  // --- Draw relationship lines ---
  const H = useAscii ? '-' : '─'
  const V = useAscii ? '|' : '│'
  const dashH = useAscii ? '.' : '╌'
  const dashV = useAscii ? ':' : '┊'

  for (const rel of diagram.relationships) {
    const fromP = placed.get(rel.from)
    const toP = placed.get(rel.to)
    if (!fromP || !toP) continue

    const marker = getRelMarker(rel.type, rel.markerAt)
    const lineH = marker.dashed ? dashH : H
    const lineV = marker.dashed ? dashV : V

    // Exclude source and target boxes from collision detection
    const excludeIds = new Set([rel.from, rel.to])

    // Connection points: center-bottom of source → center-top of target
    const fromCX = fromP.x + Math.floor(fromP.width / 2)
    const fromBY = fromP.y + fromP.height - 1
    const toCX = toP.x + Math.floor(toP.width / 2)
    const toTY = toP.y

    // Route: Manhattan routing with collision avoidance
    // If target is below source: vertical down from source, horizontal if needed, vertical down to target
    // If same row: horizontal line with a small vertical detour above or below
    if (fromBY < toTY) {
      // Target is below source — routing with collision avoidance
      // Find a clear vertical column for the ENTIRE path from source to target
      const routeX = findClearColumn(fromCX, fromBY + 1, toTY - 1, excludeIds)
      const needsDetour = routeX !== fromCX

      // Expand canvas if needed to accommodate routing column
      if (routeX >= totalW) {
        increaseSize(canvas, routeX + 2, totalH)
      }

      if (needsDetour) {
        // COLLISION CASE: Route around intermediate boxes
        // Path: source center → horizontal to routeX → vertical to entry → horizontal to target center

        const exitY = fromBY + 1
        const entryY = toTY - 1

        // 1. Horizontal from source center to route column
        const lx1 = Math.min(fromCX, routeX)
        const rx1 = Math.max(fromCX, routeX)
        for (let x = lx1; x <= rx1; x++) {
          setC(x, exitY, lineH, 'line')
        }
        if (!useAscii && exitY < (canvas[0]?.length ?? 0)) {
          if (fromCX < routeX) {
            setC(fromCX, exitY, '└', 'corner')
            setC(routeX, exitY, '┐', 'corner')
          } else {
            setC(fromCX, exitY, '┘', 'corner')
            setC(routeX, exitY, '┌', 'corner')
          }
        }

        // 2. Vertical at routeX from exit to entry
        for (let y = exitY + 1; y <= entryY; y++) {
          setC(routeX, y, lineV, 'line')
        }

        // 3. Horizontal from routeX to target center at entry
        if (routeX !== toCX) {
          const lx2 = Math.min(routeX, toCX)
          const rx2 = Math.max(routeX, toCX)
          for (let x = lx2; x <= rx2; x++) {
            setC(x, entryY, lineH, 'line')
          }
          if (!useAscii && entryY < (canvas[0]?.length ?? 0)) {
            if (routeX < toCX) {
              setC(routeX, entryY, '└', 'corner')
              setC(toCX, entryY, '┐', 'corner')
            } else {
              setC(routeX, entryY, '┘', 'corner')
              setC(toCX, entryY, '┌', 'corner')
            }
          }
        }

        // Markers for detour case
        if (marker.markerAt === 'to') {
          const markerChar = getMarkerShape(marker.type, useAscii, 'down')
          setC(toCX, entryY, markerChar, 'arrow')
        }
        if (marker.markerAt === 'from') {
          const markerChar = getMarkerShape(marker.type, useAscii, 'down')
          setC(fromCX, fromBY + 1, markerChar, 'arrow')
        }
      } else {
        // NO COLLISION CASE: Use original midpoint-based routing
        // Path: source center → vertical to midY → horizontal at midY → vertical to target

        const midY = fromBY + Math.floor((toTY - fromBY) / 2)

        // 1. Vertical from source bottom to midY
        for (let y = fromBY + 1; y <= midY; y++) {
          setC(fromCX, y, lineV, 'line')
        }

        // 2. Horizontal from fromCX to toCX at midY (if needed)
        if (fromCX !== toCX && midY < (canvas[0]?.length ?? 0)) {
          const lx = Math.min(fromCX, toCX)
          const rx = Math.max(fromCX, toCX)
          for (let x = lx; x <= rx; x++) {
            setC(x, midY, lineH, 'line')
          }
          if (!useAscii) {
            setC(fromCX, midY, fromCX < toCX ? '└' : '┘', 'corner')
            setC(toCX, midY, fromCX < toCX ? '┐' : '┌', 'corner')
          }
        }

        // 3. Vertical from midY to target top
        for (let y = midY + 1; y < toTY; y++) {
          setC(toCX, y, lineV, 'line')
        }

        // Markers for no-collision case
        if (marker.markerAt === 'to') {
          setC(toCX, toTY - 1, getMarkerShape(marker.type, useAscii, 'down'), 'arrow')
        }
        if (marker.markerAt === 'from') {
          setC(fromCX, fromBY + 1, getMarkerShape(marker.type, useAscii, 'down'), 'arrow')
        }
      }
    } else if (toP.y + toP.height - 1 < fromP.y) {
      // Target is ABOVE source — draw upward from source top to target bottom
      const fromTY = fromP.y
      const toBY = toP.y + toP.height - 1
      const midY = toBY + Math.floor((fromTY - toBY) / 2)

      for (let y = fromTY - 1; y >= midY; y--) {
        setC(fromCX, y, lineV, 'line')
      }

      if (fromCX !== toCX) {
        const lx = Math.min(fromCX, toCX)
        const rx = Math.max(fromCX, toCX)
        for (let x = lx; x <= rx; x++) {
          setC(x, midY, lineH, 'line')
        }
        if (!useAscii && midY >= 0 && midY < totalH) {
          setC(fromCX, midY, fromCX < toCX ? '┌' : '┐', 'corner')
          setC(toCX, midY, fromCX < toCX ? '┘' : '└', 'corner')
        }
      }

      for (let y = midY - 1; y > toBY; y--) {
        setC(toCX, y, lineV, 'line')
      }

      // Draw markers - arrows point in the direction of the vertical segment (upward)
      if (marker.markerAt === 'from') {
        const markerChar = getMarkerShape(marker.type, useAscii, 'up')
        const my = fromTY - 1
        for (let i = 0; i < markerChar.length; i++) {
          setC(fromCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!, 'arrow')
        }
      }
      if (marker.markerAt === 'to') {
        const isHierarchical = marker.type === 'inheritance' || marker.type === 'realization'
        const markerDir = isHierarchical ? 'down' : 'up'
        const markerChar = getMarkerShape(marker.type, useAscii, markerDir)
        const my = toBY + 1
        for (let i = 0; i < markerChar.length; i++) {
          setC(toCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!, 'arrow')
        }
      }
    } else {
      // Same level — draw horizontal line with a detour below both boxes
      const detourY = Math.max(fromBY, toP.y + toP.height - 1) + 2
      increaseSize(canvas, totalW, detourY + 1)
      increaseRoleCanvasSize(rc, totalW, detourY + 1)

      // Vertical down from source
      for (let y = fromBY + 1; y <= detourY; y++) {
        setC(fromCX, y, lineV, 'line')
      }
      // Horizontal
      const lx = Math.min(fromCX, toCX)
      const rx = Math.max(fromCX, toCX)
      for (let x = lx; x <= rx; x++) {
        setC(x, detourY, lineH, 'line')
      }
      // Vertical up to target
      for (let y = detourY - 1; y >= toP.y + toP.height; y--) {
        setC(toCX, y, lineV, 'line')
      }

      // Draw markers - same-level routing uses vertical segments at both ends
      if (marker.markerAt === 'from') {
        const markerChar = getMarkerShape(marker.type, useAscii, 'down')
        const my = fromBY + 1
        for (let i = 0; i < markerChar.length; i++) {
          setC(fromCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!, 'arrow')
        }
      }
      if (marker.markerAt === 'to') {
        const markerChar = getMarkerShape(marker.type, useAscii, 'up')
        const my = toP.y + toP.height
        for (let i = 0; i < markerChar.length; i++) {
          setC(toCX - Math.floor(markerChar.length / 2) + i, my, markerChar[i]!, 'arrow')
        }
      }
    }

    // Draw relationship label at midpoint if present (supports multi-line)
    // Add padding around the label for readability
    if (rel.label) {
      const lines = splitLines(rel.label)
      const maxLabelWidth = Math.max(...lines.map(l => displayWidth(l))) + 2 // +2 for padding

      // Calculate ideal label position based on routing direction
      let baseMidY: number
      let idealMidX: number

      if (fromBY < toTY) {
        // Target below source: place in gap between source bottom and target top
        baseMidY = Math.floor((fromBY + 1 + toTY - 1) / 2)
        idealMidX = Math.floor((fromCX + toCX) / 2)
      } else if (toP.y + toP.height - 1 < fromP.y) {
        // Target above source: place in gap between target bottom and source top
        const toBY = toP.y + toP.height - 1
        baseMidY = Math.floor((toBY + 1 + fromP.y - 1) / 2)
        idealMidX = Math.floor((fromCX + toCX) / 2)
      } else {
        // Same level: place label at midpoint of the detour line
        baseMidY = Math.max(fromBY, toP.y + toP.height - 1) + 2
        idealMidX = Math.floor((fromCX + toCX) / 2)
      }

      // Find a clear vertical position for the label (not inside any box)
      let labelY = baseMidY
      const halfHeight = Math.floor(lines.length / 2)

      // Check if any label line would be inside a box
      let labelInBox = false
      for (let i = 0; i < lines.length; i++) {
        const y = labelY - halfHeight + i
        const idealLabelStart = idealMidX - Math.floor(maxLabelWidth / 2)
        const labelStart = Math.max(0, idealLabelStart)
        // Check if this line overlaps any box
        for (let x = labelStart; x < labelStart + maxLabelWidth; x++) {
          if (isInsideBox(x, y, excludeIds)) {
            labelInBox = true
            break
          }
        }
        if (labelInBox) break
      }

      // If label is inside a box, find the gap between boxes
      if (labelInBox) {
        // Find the gap between source and target boxes
        const gapTop = fromBY + 1
        const gapBottom = toTY - 1

        // Place label in the middle of the gap, outside any intermediate box
        for (let y = gapTop; y <= gapBottom; y++) {
          let clearRow = true
          const idealLabelStart = idealMidX - Math.floor(maxLabelWidth / 2)
          const labelStart = Math.max(0, idealLabelStart)
          for (let x = labelStart; x < labelStart + maxLabelWidth; x++) {
            if (isInsideBox(x, y, excludeIds)) {
              clearRow = false
              break
            }
          }
          if (clearRow) {
            labelY = y
            break
          }
        }
      }

      // Center lines vertically around labelY
      const startY = labelY - halfHeight

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const paddedLine = ` ${lines[lineIdx]!} `  // Add space padding on both sides
        const cells = toCells(paddedLine)
        // Calculate label start, but ensure it doesn't go negative
        const idealLabelStart = idealMidX - Math.floor(cells.length / 2)
        const labelStart = Math.max(0, idealLabelStart)
        const y = startY + lineIdx
        // Ensure canvas is wide enough for the label
        const labelEnd = labelStart + cells.length
        if (labelEnd > 0 && y >= 0) {
          increaseSize(canvas, Math.max(labelEnd, 1), Math.max(y + 1, 1))
          increaseRoleCanvasSize(rc, Math.max(labelEnd, 1), Math.max(y + 1, 1))
        }
        // Clear the area first (overwrite line characters) then draw the padded label
        for (let i = 0; i < cells.length; i++) {
          const lx = labelStart + i
          if (lx >= 0 && y >= 0) {
            setC(lx, y, cells[i]!, 'text')
          }
        }
      }
    }
  }

  return canvasToString(canvas, { roleCanvas: rc, colorMode, theme })
}
