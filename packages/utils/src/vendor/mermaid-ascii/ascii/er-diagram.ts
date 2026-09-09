// ============================================================================
// ASCII renderer — ER diagrams
//
// Renders erDiagram text to ASCII/Unicode art.
// Each entity is a 2-section box (header | attributes).
// Relationships are drawn as lines with crow's foot notation at endpoints.
//
// Layout: entities are placed in a grid pattern (multiple rows if needed).
// Relationship lines use Manhattan routing between entity boxes.
// ============================================================================

import { parseErDiagram } from '../er/parser'
import type { ErDiagram, ErEntity, ErAttribute, Cardinality } from '../er/types'
import type { Canvas, AsciiConfig, RoleCanvas, CharRole, AsciiTheme, ColorMode } from './types'
import { mkCanvas, mkRoleCanvas, canvasToString, increaseSize, increaseRoleCanvasSize, setRole } from './canvas'
import { drawMultiBox } from './draw'
import { splitLines } from './multiline-utils'
import { displayWidth, toCells, WIDE_PAD } from '../text-metrics'

/** Classify a character from a box drawing as 'border' or 'text'. */
function classifyBoxChar(ch: string): CharRole {
  if (/^[┌┐└┘├┤┬┴┼│─╭╮╰╯+\-|]$/.test(ch)) return 'border'
  return 'text'
}

// ============================================================================
// Entity box content
// ============================================================================

/** Format an attribute line: "PK type name" or "FK type name" etc. */
function formatAttribute(attr: ErAttribute): string {
  const keyStr = attr.keys.length > 0 ? attr.keys.join(',') + ' ' : '   '
  return `${keyStr}${attr.type} ${attr.name}`
}

/** Build sections for an entity box: [header], [attributes] */
function buildEntitySections(entity: ErEntity): string[][] {
  // Support multi-line entity names
  const header = splitLines(entity.label)
  const attrs = entity.attributes.map(formatAttribute)
  if (attrs.length === 0) return [header]
  return [header, attrs]
}

// ============================================================================
// Crow's foot notation
// ============================================================================

/**
 * Returns the ASCII/Unicode characters for a crow's foot cardinality marker.
 * Markers are drawn adjacent to entity boxes at relationship endpoints.
 *
 * Standard ER notation:
 *   one:       ─┤├─   perpendicular line (exactly one)
 *   zero-one:  ─○┤─   circle + perpendicular (zero or one)
 *   many:      ─<>─   crow's foot (one or more)
 *   zero-many: ─○<─   circle + crow's foot (zero or more)
 *
 * @param card - The cardinality type
 * @param useAscii - Use ASCII-only characters
 * @param isRight - True if this marker is on the right side of the relationship
 */
function getCrowsFootChars(card: Cardinality, useAscii: boolean, isRight = false): string {
  if (useAscii) {
    switch (card) {
      case 'one':       return '|'
      case 'zero-one':  return 'o|'
      case 'many':      return isRight ? '<' : '>'
      case 'zero-many': return isRight ? 'o<' : '>o'
    }
  } else {
    // Use cleaner Unicode characters
    switch (card) {
      case 'one':       return '│'
      case 'zero-one':  return '○│'
      case 'many':      return isRight ? '╟' : '╢'
      case 'zero-many': return isRight ? '○╟' : '╢○'
    }
  }
}

// ============================================================================
// Positioned entity
// ============================================================================

interface PlacedEntity {
  entity: ErEntity
  sections: string[][]
  x: number
  y: number
  width: number
  height: number
}

// ============================================================================
// Connected Component Detection
// ============================================================================

/**
 * Find connected components in the ER diagram using DFS.
 * Treats relationships as undirected edges for connectivity.
 *
 * Returns an array of entity ID sets, one per connected component.
 */
function findConnectedComponents(diagram: ErDiagram): Set<string>[] {
  const visited = new Set<string>()
  const components: Set<string>[] = []

  // Build undirected adjacency list from relationships
  const neighbors = new Map<string, Set<string>>()
  for (const ent of diagram.entities) {
    neighbors.set(ent.id, new Set())
  }
  for (const rel of diagram.relationships) {
    neighbors.get(rel.entity1)?.add(rel.entity2)
    neighbors.get(rel.entity2)?.add(rel.entity1)
  }

  // DFS to find each component
  function dfs(startId: string, component: Set<string>): void {
    const stack = [startId]
    while (stack.length > 0) {
      const nodeId = stack.pop()!
      if (visited.has(nodeId)) continue

      visited.add(nodeId)
      component.add(nodeId)

      for (const neighbor of neighbors.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor)
        }
      }
    }
  }

  // Find all components
  for (const ent of diagram.entities) {
    if (!visited.has(ent.id)) {
      const component = new Set<string>()
      dfs(ent.id, component)
      if (component.size > 0) {
        components.push(component)
      }
    }
  }

  return components
}

// ============================================================================
// Layout and rendering
// ============================================================================

/**
 * Render a Mermaid ER diagram to ASCII/Unicode text.
 *
 * Pipeline: parse → build boxes → component-aware layout → draw boxes → draw relationships → string.
 */
export function renderErAscii(text: string, config: AsciiConfig, colorMode?: ColorMode, theme?: AsciiTheme): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  const diagram = parseErDiagram(lines)

  if (diagram.entities.length === 0) return ''

  const useAscii = config.useAscii
  const hGap = 6  // horizontal gap between entity boxes
  const vGap = 4  // vertical gap between rows (for relationship lines)
  const componentGap = 6  // vertical gap between disconnected components

  // --- Build entity box dimensions ---
  const entitySections = new Map<string, string[][]>()
  const entityBoxW = new Map<string, number>()
  const entityBoxH = new Map<string, number>()
  const entityById = new Map<string, ErEntity>()

  for (const ent of diagram.entities) {
    entityById.set(ent.id, ent)
    const sections = buildEntitySections(ent)
    entitySections.set(ent.id, sections)

    let maxTextW = 0
    for (const section of sections) {
      for (const line of section) maxTextW = Math.max(maxTextW, displayWidth(line))
    }
    const boxW = maxTextW + 4 // 2 border + 2 padding

    let totalLines = 0
    for (const section of sections) totalLines += Math.max(section.length, 1)
    const boxH = totalLines + (sections.length - 1) + 2

    entityBoxW.set(ent.id, boxW)
    entityBoxH.set(ent.id, boxH)
  }

  // --- Find connected components ---
  const components = findConnectedComponents(diagram)

  // --- Layout: place each component, then stack components vertically ---
  const placed = new Map<string, PlacedEntity>()
  let currentY = 0

  for (const component of components) {
    // Get entities in this component (preserve original order for consistency)
    const componentEntities = diagram.entities.filter(e => component.has(e.id))

    // Layout entities within this component horizontally
    // Use sqrt-based row limit for larger components
    const maxPerRow = Math.max(2, Math.ceil(Math.sqrt(componentEntities.length)))

    let currentX = 0
    let maxRowH = 0
    let colCount = 0
    const componentStartY = currentY

    for (const ent of componentEntities) {
      const w = entityBoxW.get(ent.id)!
      const h = entityBoxH.get(ent.id)!

      if (colCount >= maxPerRow) {
        // Wrap to next row within this component
        currentY += maxRowH + vGap
        currentX = 0
        maxRowH = 0
        colCount = 0
      }

      placed.set(ent.id, {
        entity: ent,
        sections: entitySections.get(ent.id)!,
        x: currentX,
        y: currentY,
        width: w,
        height: h,
      })

      currentX += w + hGap
      maxRowH = Math.max(maxRowH, h)
      colCount++
    }

    // Move to next component row (add gap between components)
    currentY += maxRowH + componentGap
  }

  // --- Create canvas ---
  let totalW = 0
  let totalH = 0
  for (const p of placed.values()) {
    totalW = Math.max(totalW, p.x + p.width)
    totalH = Math.max(totalH, p.y + p.height)
  }
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

  // --- Draw entity boxes ---
  for (const p of placed.values()) {
    const boxCanvas = drawMultiBox(p.sections, useAscii)
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

  // --- Draw relationships ---
  const H = useAscii ? '-' : '─'
  const V = useAscii ? '|' : '│'
  const dashH = useAscii ? '.' : '╌'
  const dashV = useAscii ? ':' : '┊'

  for (const rel of diagram.relationships) {
    const e1 = placed.get(rel.entity1)
    const e2 = placed.get(rel.entity2)
    if (!e1 || !e2) continue

    const lineH = rel.identifying ? H : dashH
    const lineV = rel.identifying ? V : dashV

    // Determine connection direction based on relative position.
    // Connect from right side of left entity to left side of right entity (horizontal),
    // or from bottom of upper entity to top of lower entity (vertical).
    const e1CX = e1.x + Math.floor(e1.width / 2)
    const e1CY = e1.y + Math.floor(e1.height / 2)
    const e2CX = e2.x + Math.floor(e2.width / 2)
    const e2CY = e2.y + Math.floor(e2.height / 2)

    // Check if entities are on the same row (horizontal connection)
    const sameRow = Math.abs(e1CY - e2CY) < Math.max(e1.height, e2.height)

    if (sameRow) {
      // Horizontal connection: right side of left entity → left side of right entity
      const [left, right] = e1CX < e2CX ? [e1, e2] : [e2, e1]
      const [leftCard, rightCard] = e1CX < e2CX
        ? [rel.cardinality1, rel.cardinality2]
        : [rel.cardinality2, rel.cardinality1]

      const startX = left.x + left.width
      const endX = right.x - 1
      const lineY = left.y + Math.floor(left.height / 2)

      // Draw horizontal line
      for (let x = startX; x <= endX; x++) {
        setC(x, lineY, lineH, 'line')
      }

      // Draw crow's foot markers at endpoints
      // Left marker (at left entity's right edge) - isRight=false
      const leftChars = getCrowsFootChars(leftCard, useAscii, false)
      for (let i = 0; i < leftChars.length; i++) {
        setC(startX + i, lineY, leftChars[i]!, 'arrow')
      }

      // Right marker (at right entity's left edge) - isRight=true
      const rightChars = getCrowsFootChars(rightCard, useAscii, true)
      for (let i = 0; i < rightChars.length; i++) {
        setC(endX - rightChars.length + 1 + i, lineY, rightChars[i]!, 'arrow')
      }

      // Relationship label centered in the gap between the two entities, below the line.
      // Clamp label to the gap region [startX, endX] to avoid overwriting box borders.
      // Supports multi-line labels.
      if (rel.label) {
        const lines = splitLines(rel.label)
        const gapMid = Math.floor((startX + endX) / 2)

        // Place lines below the relationship line (lineY + 1, lineY + 2, ...)
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx]!
          const cells = toCells(line)
          const labelStart = Math.max(startX, gapMid - Math.floor(cells.length / 2))
          const labelY = lineY + 1 + lineIdx
          // Ensure canvas is tall enough
          increaseSize(canvas, Math.max(labelStart + cells.length, 1), Math.max(labelY + 1, 1))
          increaseRoleCanvasSize(rc, Math.max(labelStart + cells.length, 1), Math.max(labelY + 1, 1))
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i]!
            if (cell === WIDE_PAD) continue // written atomically with its lead
            const lx = labelStart + i
            const wide = cells[i + 1] === WIDE_PAD
            // Keep wide-glyph pairs atomic within the gap region
            if (lx < startX || lx + (wide ? 1 : 0) > endX) continue
            setC(lx, labelY, cell, 'text')
            if (wide) setC(lx + 1, labelY, WIDE_PAD, 'text')
          }
        }
      }
    } else {
      // Vertical connection: bottom of upper entity → top of lower entity
      const [upper, lower] = e1CY < e2CY ? [e1, e2] : [e2, e1]
      const [upperCard, lowerCard] = e1CY < e2CY
        ? [rel.cardinality1, rel.cardinality2]
        : [rel.cardinality2, rel.cardinality1]

      const startY = upper.y + upper.height
      const endY = lower.y - 1
      const lineX = upper.x + Math.floor(upper.width / 2)

      // Vertical line
      for (let y = startY; y <= endY; y++) {
        setC(lineX, y, lineV, 'line')
      }

      // If horizontal offset needed, add a horizontal segment
      const lowerCX = lower.x + Math.floor(lower.width / 2)
      if (lineX !== lowerCX) {
        const midY = Math.floor((startY + endY) / 2)
        // Horizontal segment at midY
        const lx = Math.min(lineX, lowerCX)
        const rx = Math.max(lineX, lowerCX)
        for (let x = lx; x <= rx; x++) {
          setC(x, midY, lineH, 'line')
        }
        // Vertical from midY to lower entity
        for (let y = midY + 1; y <= endY; y++) {
          setC(lowerCX, y, lineV, 'line')
        }
      }

      // Crow's foot markers (vertical direction)
      // Upper marker (at upper entity's bottom edge) - treat as source side (isRight=false)
      const upperChars = getCrowsFootChars(upperCard, useAscii, false)
      for (let i = 0; i < upperChars.length; i++) {
        setC(lineX - Math.floor(upperChars.length / 2) + i, startY, upperChars[i]!, 'arrow')
      }

      // Lower marker (at lower entity's top edge) - treat as target side (isRight=true)
      const targetX = lineX !== lowerCX ? lowerCX : lineX
      const lowerChars = getCrowsFootChars(lowerCard, useAscii, true)
      for (let i = 0; i < lowerChars.length; i++) {
        setC(targetX - Math.floor(lowerChars.length / 2) + i, endY, lowerChars[i]!, 'arrow')
      }

      // Relationship label — placed to the right of the vertical line at the midpoint.
      // We expand the canvas as needed since labels can extend beyond the initial bounds.
      // Supports multi-line labels.
      if (rel.label) {
        const lines = splitLines(rel.label)
        const midY = Math.floor((startY + endY) / 2)
        // Center lines vertically around midY
        const startLabelY = midY - Math.floor((lines.length - 1) / 2)

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const cells = toCells(lines[lineIdx]!)
          const labelX = lineX + 2
          const y = startLabelY + lineIdx
          if (y >= 0) {
            for (let i = 0; i < cells.length; i++) {
              const lx = labelX + i
              if (lx >= 0) {
                increaseSize(canvas, lx + 1, y + 1)
                increaseRoleCanvasSize(rc, lx + 1, y + 1)
                setC(lx, y, cells[i]!, 'text')
              }
            }
          }
        }
      }
    }
  }

  return canvasToString(canvas, { roleCanvas: rc, colorMode, theme })
}
