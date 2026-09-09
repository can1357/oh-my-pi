import type { ErDiagram, ErEntity, ErAttribute, ErRelationship, Cardinality } from './types'
import { normalizeBrTags } from '../multiline-utils'

// ============================================================================
// ER diagram parser
//
// Parses Mermaid erDiagram syntax into an ErDiagram structure.
//
// Supported syntax:
//   CUSTOMER ||--o{ ORDER : places
//   CUSTOMER {
//     string name PK
//     int age
//     string email UK "user email"
//   }
//
// Cardinality notation:
//   ||  exactly one
//   o|  zero or one (also |o)
//   }|  one or more (also |{)
//   o{  zero or more (also {o)
//
// Line style:
//   --  identifying (solid line)
//   ..  non-identifying (dashed line)
// ============================================================================

/**
 * Parse a Mermaid ER diagram.
 * Expects the first line to be "erDiagram".
 */
export function parseErDiagram(lines: string[]): ErDiagram {
  const diagram: ErDiagram = {
    entities: [],
    relationships: [],
  }

  // Track entities by ID for deduplication
  const entityMap = new Map<string, ErEntity>()
  // Track entity body parsing
  let currentEntity: ErEntity | null = null

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    // --- Inside entity body ---
    if (currentEntity) {
      if (line === '}') {
        currentEntity = null
        continue
      }

      // Attribute line: type name [PK|FK|UK] ["comment"]
      const attr = parseAttribute(line)
      if (attr) {
        currentEntity.attributes.push(attr)
      }
      continue
    }

    // --- Entity block start: `ENTITY_NAME {` ---
    const entityBlockMatch = line.match(/^(\S+)\s*\{$/)
    if (entityBlockMatch) {
      const id = entityBlockMatch[1]!
      const entity = ensureEntity(entityMap, id)
      currentEntity = entity
      continue
    }

    // --- Relationship: `ENTITY1 cardinality1--cardinality2 ENTITY2 : label` ---
    const rel = parseRelationshipLine(line)
    if (rel) {
      // Ensure both entities exist
      ensureEntity(entityMap, rel.entity1)
      ensureEntity(entityMap, rel.entity2)
      diagram.relationships.push(rel)
      continue
    }
  }

  diagram.entities = [...entityMap.values()]
  return diagram
}

/** Ensure an entity exists in the map */
function ensureEntity(entityMap: Map<string, ErEntity>, id: string): ErEntity {
  let entity = entityMap.get(id)
  if (!entity) {
    entity = { id, label: id, attributes: [] }
    entityMap.set(id, entity)
  }
  return entity
}

/** Parse an attribute line inside an entity block */
function parseAttribute(line: string): ErAttribute | null {
  // Format: type name [PK|FK|UK [...]] ["comment"]
  const match = line.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/)
  if (!match) return null

  const type = match[1]!
  const name = match[2]!
  const rest = match[3]?.trim() ?? ''

  // Extract key constraints (PK, FK, UK) and optional comment
  const keys: ErAttribute['keys'] = []
  let comment: string | undefined

  // Extract quoted comment first (supports <br> tags)
  const commentMatch = rest.match(/"([^"]*)"/)
  if (commentMatch) {
    comment = normalizeBrTags(commentMatch[1]!)
  }

  // Extract key constraints
  const restWithoutComment = rest.replace(/"[^"]*"/, '').trim()
  for (const part of restWithoutComment.split(/\s+/)) {
    const upper = part.toUpperCase()
    if (upper === 'PK' || upper === 'FK' || upper === 'UK') {
      keys.push(upper as 'PK' | 'FK' | 'UK')
    }
  }

  return { type, name, keys, comment }
}

/**
 * Parse a relationship line.
 *
 * Cardinality symbols on each side of the line style:
 *   Left side (entity1):  ||  |o  o|  }|  |{  o{  {o
 *   Line:                 --  (identifying) or  ..  (non-identifying)
 *   Right side (entity2): ||  o|  |o  |{  }|  {o  o{
 *
 * Full pattern example: CUSTOMER ||--o{ ORDER : places
 */
function parseRelationshipLine(line: string): ErRelationship | null {
  // Match: ENTITY1 <cardinality_and_line> ENTITY2 : label
  const match = line.match(/^(\S+)\s+([|o}{]+(?:--|\.\.)[|o}{]+)\s+(\S+)\s*:\s*(.+)$/)
  if (!match) return null

  const entity1 = match[1]!
  const cardinalityStr = match[2]!
  const entity2 = match[3]!
  // Strip surrounding quotes if present, then normalize br tags
  const rawLabel = match[4]!.trim().replace(/^["']|["']$/g, '')
  const label = normalizeBrTags(rawLabel)

  // Split the cardinality string into left side, line style, right side
  const lineMatch = cardinalityStr.match(/^([|o}{]+)(--|\.\.?)([|o}{]+)$/)
  if (!lineMatch) return null

  const leftStr = lineMatch[1]!
  const lineStyle = lineMatch[2]!
  const rightStr = lineMatch[3]!

  const cardinality1 = parseCardinality(leftStr)
  const cardinality2 = parseCardinality(rightStr)
  const identifying = lineStyle === '--'

  if (!cardinality1 || !cardinality2) return null

  return { entity1, entity2, cardinality1, cardinality2, label, identifying }
}

/** Parse a cardinality notation string into a Cardinality type */
function parseCardinality(str: string): Cardinality | null {
  // Normalize: sort the characters to handle both orders (e.g., |o and o|)
  const sorted = str.split('').sort().join('')

  // Exact one: || → sorted "||"
  if (sorted === '||') return 'one'
  // Zero or one: o| or |o → sorted "o|" (o=111 < |=124 in char codes)
  if (sorted === 'o|') return 'zero-one'
  // One or more: }| or |{ → sorted "|}" or "{|"
  if (sorted === '|}' || sorted === '{|') return 'many'
  // Zero or more: o{ or {o → sorted "{o" or "o{"
  if (sorted === '{o' || sorted === 'o{') return 'zero-many'

  return null
}
