// ============================================================================
// ER diagram types
//
// Models the parsed and positioned representations of a Mermaid ER diagram.
// ER diagrams show database entities, their attributes, and relationships.
// ============================================================================

/** Parsed ER diagram — logical structure from mermaid text */
export interface ErDiagram {
  /** All entity definitions */
  entities: ErEntity[]
  /** Relationships between entities */
  relationships: ErRelationship[]
}

export interface ErEntity {
  id: string
  /** Display name (same as id unless aliased) */
  label: string
  /** Entity attributes (columns) */
  attributes: ErAttribute[]
}

export interface ErAttribute {
  /** Data type (string, int, varchar, etc.) */
  type: string
  /** Attribute name */
  name: string
  /** Key constraints: PK, FK, UK */
  keys: Array<'PK' | 'FK' | 'UK'>
  /** Optional comment */
  comment?: string
}

/**
 * Cardinality notation (crow's foot):
 *   'one'       ||  exactly one
 *   'zero-one'  |o  zero or one
 *   'many'      }|  one or more
 *   'zero-many' o{  zero or more
 */
export type Cardinality = 'one' | 'zero-one' | 'many' | 'zero-many'

export interface ErRelationship {
  entity1: string
  entity2: string
  /** Cardinality at entity1's end */
  cardinality1: Cardinality
  /** Cardinality at entity2's end */
  cardinality2: Cardinality
  /** Relationship verb/label (e.g., "places", "contains") */
  label: string
  /** Whether the relationship is identifying (solid line) or non-identifying (dashed) */
  identifying: boolean
}

// ============================================================================
// Positioned ER diagram — ready for SVG rendering
// ============================================================================

export interface PositionedErDiagram {
  width: number
  height: number
  entities: PositionedErEntity[]
  relationships: PositionedErRelationship[]
}

export interface PositionedErEntity {
  id: string
  label: string
  attributes: ErAttribute[]
  x: number
  y: number
  width: number
  height: number
  /** Height of the header row */
  headerHeight: number
  /** Height per attribute row */
  rowHeight: number
}

export interface PositionedErRelationship {
  entity1: string
  entity2: string
  cardinality1: Cardinality
  cardinality2: Cardinality
  label: string
  identifying: boolean
  /** Path points from entity1 to entity2 */
  points: Array<{ x: number; y: number }>
}
