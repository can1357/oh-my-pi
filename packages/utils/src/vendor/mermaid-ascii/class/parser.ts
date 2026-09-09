import type { ClassDiagram, ClassNode, ClassRelationship, ClassMember, RelationshipType, ClassNamespace } from './types'
import { normalizeBrTags } from '../multiline-utils'

// ============================================================================
// Class diagram parser
//
// Parses Mermaid classDiagram syntax into a ClassDiagram structure.
//
// Supported syntax:
//   class Animal { +String name; +eat() void }
//   class Shape { <<abstract>> }
//   Animal <|-- Dog           (inheritance)
//   Car *-- Engine            (composition)
//   Car o-- Wheel             (aggregation)
//   A --> B                   (association)
//   A ..> B                   (dependency)
//   A ..|> B                  (realization)
//   A "1" --> "*" B : label   (with cardinality + label)
//   Animal : +String name     (inline attribute)
//   namespace MyNamespace { class A { } }
// ============================================================================

/**
 * Parse a Mermaid class diagram.
 * Expects the first line to be "classDiagram".
 */
export function parseClassDiagram(lines: string[]): ClassDiagram {
  const diagram: ClassDiagram = {
    classes: [],
    relationships: [],
    namespaces: [],
  }

  // Track classes by ID for deduplication
  const classMap = new Map<string, ClassNode>()
  // Track namespace nesting
  let currentNamespace: ClassNamespace | null = null
  // Track class body parsing
  let currentClass: ClassNode | null = null
  let braceDepth = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    // --- Inside a class body block ---
    if (currentClass && braceDepth > 0) {
      if (line === '}') {
        braceDepth--
        if (braceDepth === 0) {
          currentClass = null
        }
        continue
      }

      // Check for annotation like <<interface>>
      const annotMatch = line.match(/^<<(\w+)>>$/)
      if (annotMatch) {
        currentClass.annotation = annotMatch[1]!
        continue
      }

      // Parse member: visibility, name, type, optional parens for method
      const member = parseMember(line)
      if (member) {
        if (member.isMethod) {
          currentClass.methods.push(member.member)
        } else {
          currentClass.attributes.push(member.member)
        }
      }
      continue
    }

    // --- Namespace block start ---
    const nsMatch = line.match(/^namespace\s+(\S+)\s*\{$/)
    if (nsMatch) {
      currentNamespace = { name: nsMatch[1]!, classIds: [] }
      continue
    }

    // --- Namespace end ---
    if (line === '}' && currentNamespace) {
      diagram.namespaces.push(currentNamespace)
      currentNamespace = null
      continue
    }

    // --- Class block start: `class ClassName {` or `class ClassName` ---
    const classBlockMatch = line.match(/^class\s+(\S+?)(?:\s*~(\w+)~)?\s*\{$/)
    if (classBlockMatch) {
      const id = classBlockMatch[1]!
      const generic = classBlockMatch[2]
      const cls = ensureClass(classMap, id)
      if (generic) {
        cls.label = `${id}<${generic}>`
      }
      currentClass = cls
      braceDepth = 1
      if (currentNamespace) {
        currentNamespace.classIds.push(id)
      }
      continue
    }

    // --- Standalone class declaration (no body): `class ClassName` ---
    const classOnlyMatch = line.match(/^class\s+(\S+?)(?:\s*~(\w+)~)?\s*$/)
    if (classOnlyMatch) {
      const id = classOnlyMatch[1]!
      const generic = classOnlyMatch[2]
      const cls = ensureClass(classMap, id)
      if (generic) {
        cls.label = `${id}<${generic}>`
      }
      if (currentNamespace) {
        currentNamespace.classIds.push(id)
      }
      continue
    }

    // --- Inline annotation: `class ClassName { <<interface>> }` (single line) ---
    const inlineAnnotMatch = line.match(/^class\s+(\S+?)\s*\{\s*<<(\w+)>>\s*\}$/)
    if (inlineAnnotMatch) {
      const cls = ensureClass(classMap, inlineAnnotMatch[1]!)
      cls.annotation = inlineAnnotMatch[2]!
      continue
    }

    // --- Inline attribute: `ClassName : +String name` ---
    const inlineAttrMatch = line.match(/^(\S+?)\s*:\s*(.+)$/)
    if (inlineAttrMatch) {
      // Make sure this isn't a relationship line (those have arrows)
      const rest = inlineAttrMatch[2]!
      if (!rest.match(/<\|--|--|\*--|o--|-->|\.\.>|\.\.\|>/)) {
        const cls = ensureClass(classMap, inlineAttrMatch[1]!)
        const member = parseMember(rest)
        if (member) {
          if (member.isMethod) {
            cls.methods.push(member.member)
          } else {
            cls.attributes.push(member.member)
          }
        }
        continue
      }
    }

    // --- Relationship ---
    // Pattern: [FROM] ["card"] ARROW ["card"] [TO] [: label]
    // Arrows: <|--, *--, o--, -->, ..|>, ..>
    // Can also be reversed: --o, --*, --|>
    const rel = parseRelationship(line)
    if (rel) {
      // Ensure both classes exist
      ensureClass(classMap, rel.from)
      ensureClass(classMap, rel.to)
      diagram.relationships.push(rel)
      continue
    }
  }

  diagram.classes = [...classMap.values()]
  return diagram
}

/** Ensure a class exists in the map, creating a default if needed */
function ensureClass(classMap: Map<string, ClassNode>, id: string): ClassNode {
  let cls = classMap.get(id)
  if (!cls) {
    cls = { id, label: id, attributes: [], methods: [] }
    classMap.set(id, cls)
  }
  return cls
}

/** Parse a class member line (attribute or method) */
function parseMember(line: string): { member: ClassMember; isMethod: boolean } | null {
  const trimmed = line.trim().replace(/;$/, '')
  if (!trimmed) return null

  // Extract visibility prefix
  let visibility: ClassMember['visibility'] = ''
  let rest = trimmed
  if (/^[+\-#~]/.test(rest)) {
    visibility = rest[0] as ClassMember['visibility']
    rest = rest.slice(1).trim()
  }

  // Check if it's a method (has parentheses)
  const methodMatch = rest.match(/^(.+?)\(([^)]*)\)(?:\s*(.+))?$/)
  if (methodMatch) {
    const name = methodMatch[1]!.trim()
    const params = methodMatch[2]?.trim() || undefined // Store the parameter string
    const type = methodMatch[3]?.trim()
    // Check for static ($) or abstract (*) markers
    const isStatic = name.endsWith('$') || rest.includes('$')
    const isAbstract = name.endsWith('*') || rest.includes('*')
    return {
      member: {
        visibility,
        name: name.replace(/[$*]$/, ''),
        type: type || undefined,
        isStatic,
        isAbstract,
        isMethod: true,
        params,
      },
      isMethod: true,
    }
  }

  // It's an attribute: [Type] name or name Type
  // Common patterns: "String name", "+int age", "name"
  const parts = rest.split(/\s+/)
  let name: string
  let type: string | undefined

  if (parts.length >= 2) {
    // "Type name" pattern
    type = parts[0]
    name = parts.slice(1).join(' ')
  } else {
    name = parts[0] ?? rest
  }

  const isStatic = name.endsWith('$')
  const isAbstract = name.endsWith('*')

  return {
    member: {
      visibility,
      name: name.replace(/[$*]$/, ''),
      type: type || undefined,
      isStatic,
      isAbstract,
      isMethod: false,
    },
    isMethod: false,
  }
}

/** Parse a relationship line into a ClassRelationship */
function parseRelationship(line: string): ClassRelationship | null {
  // Relationship regex — handles all arrow types with optional cardinality and labels
  // Pattern: FROM ["card"] ARROW ["card"] TO [: label]
  const match = line.match(
    /^(\S+?)\s+(?:"([^"]*?)"\s+)?(<\|--|<\|\.\.|\*--|o--|-->|--\*|--o|--\|>|\.\.>|\.\.\|>|<--|<\.\.?|--)\s+(?:"([^"]*?)"\s+)?(\S+?)(?:\s*:\s*(.+))?$/
  )
  if (!match) return null

  const from = match[1]!
  const rawFromCardinality = match[2]
  const fromCardinality = rawFromCardinality ? normalizeBrTags(rawFromCardinality) : undefined
  const arrow = match[3]!.trim()
  const rawToCardinality = match[4]
  const toCardinality = rawToCardinality ? normalizeBrTags(rawToCardinality) : undefined
  const to = match[5]!
  const rawLabel = match[6]?.trim()
  const label = rawLabel ? normalizeBrTags(rawLabel) : undefined

  const parsed = parseArrow(arrow)
  if (!parsed) return null

  return { from, to, type: parsed.type, markerAt: parsed.markerAt, label, fromCardinality, toCardinality }
}

/**
 * Map arrow syntax to relationship type and marker placement side.
 * Prefix markers (`<|--`, `*--`, `o--`) place the UML shape at the 'from' end.
 * Suffix markers (`..|>`, `-->`, `..>`, `--*`, `--o`) place it at the 'to' end.
 */
function parseArrow(arrow: string): { type: RelationshipType; markerAt: 'from' | 'to' } | null {
  // Trim whitespace that might be captured by the regex
  const a = arrow.trim()
  switch (a) {
    case '<|--': return { type: 'inheritance',  markerAt: 'from' }
    case '--|>': return { type: 'inheritance',  markerAt: 'to' }
    case '<|..': return { type: 'realization',  markerAt: 'from' }
    case '..|>': return { type: 'realization',  markerAt: 'to' }
    case '*--':  return { type: 'composition',  markerAt: 'from' }
    case '--*':  return { type: 'composition',  markerAt: 'to' }
    case 'o--':  return { type: 'aggregation',  markerAt: 'from' }
    case '--o':  return { type: 'aggregation',  markerAt: 'to' }
    case '-->':  return { type: 'association',  markerAt: 'to' }
    case '<--':  return { type: 'association',  markerAt: 'from' }
    case '..>':  return { type: 'dependency',   markerAt: 'to' }
    case '<..':  return { type: 'dependency',   markerAt: 'from' }
    case '--':   return { type: 'association',  markerAt: 'to' }
    default:     return null
  }
}
