import type { SequenceDiagram, Actor, Message, Block, Note } from './types'
import { normalizeBrTags } from '../multiline-utils'

// ============================================================================
// Sequence diagram parser
//
// Parses Mermaid sequenceDiagram syntax into a SequenceDiagram structure.
//
// Supported syntax:
//   participant A as Alice
//   actor B as Bob
//   A->>B: Solid arrow
//   A-->>B: Dashed arrow
//   A-)B: Open arrow
//   A--)B: Dashed open arrow
//   A->>+B: Activate target
//   A-->>-B: Deactivate source
//   loop Label ... end
//   alt Label ... else Label ... end
//   opt Label ... end
//   par Label ... and Label ... end
//   Note left of A: Text
//   Note right of A: Text
//   Note over A,B: Text
// ============================================================================

/**
 * Parse a Mermaid sequence diagram.
 * Expects the first line to be "sequenceDiagram".
 */
export function parseSequenceDiagram(lines: string[]): SequenceDiagram {
  const diagram: SequenceDiagram = {
    actors: [],
    messages: [],
    blocks: [],
    notes: [],
  }

  // Track actor IDs to auto-create actors referenced in messages
  const actorIds = new Set<string>()
  // Track block nesting with a stack
  const blockStack: Array<{ type: Block['type']; label: string; startIndex: number; dividers: Block['dividers'] }> = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!

    // --- Participant / Actor declaration ---
    // "participant A as Alice" or "participant Alice"
    // "actor B as Bob" or "actor Bob"
    const actorMatch = line.match(/^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/)
    if (actorMatch) {
      const type = actorMatch[1] as 'participant' | 'actor'
      const id = actorMatch[2]!
      const rawLabel = actorMatch[3]?.trim() ?? id
      const label = normalizeBrTags(rawLabel)
      if (!actorIds.has(id)) {
        actorIds.add(id)
        diagram.actors.push({ id, label, type })
      }
      continue
    }

    // --- Note ---
    // "Note left of A: text" / "Note right of A: text" / "Note over A,B: text"
    const noteMatch = line.match(/^Note\s+(left of|right of|over)\s+([^:]+):\s*(.+)$/i)
    if (noteMatch) {
      const posStr = noteMatch[1]!.toLowerCase()
      const actorsStr = noteMatch[2]!.trim()
      const text = normalizeBrTags(noteMatch[3]!.trim())
      const noteActorIds = actorsStr.split(',').map(s => s.trim())

      // Ensure actors exist
      for (const aid of noteActorIds) {
        ensureActor(diagram, actorIds, aid)
      }

      let position: 'left' | 'right' | 'over' = 'over'
      if (posStr === 'left of') position = 'left'
      else if (posStr === 'right of') position = 'right'

      diagram.notes.push({
        actorIds: noteActorIds,
        text,
        position,
        afterIndex: diagram.messages.length - 1,
      })
      continue
    }

    // --- Block start: loop, alt, opt, par, critical, break, rect ---
    const blockMatch = line.match(/^(loop|alt|opt|par|critical|break|rect)\s*(.*)$/)
    if (blockMatch) {
      const blockType = blockMatch[1] as Block['type']
      const rawBlockLabel = blockMatch[2]?.trim() ?? ''
      const label = normalizeBrTags(rawBlockLabel)
      blockStack.push({
        type: blockType,
        label,
        startIndex: diagram.messages.length,
        dividers: [],
      })
      continue
    }

    // --- Block divider: else, and ---
    const dividerMatch = line.match(/^(else|and)\s*(.*)$/)
    if (dividerMatch && blockStack.length > 0) {
      const rawDividerLabel = dividerMatch[2]?.trim() ?? ''
      const label = normalizeBrTags(rawDividerLabel)
      blockStack[blockStack.length - 1]!.dividers.push({
        index: diagram.messages.length,
        label,
      })
      continue
    }

    // --- Block end ---
    if (line === 'end' && blockStack.length > 0) {
      const completed = blockStack.pop()!
      diagram.blocks.push({
        type: completed.type,
        label: completed.label,
        startIndex: completed.startIndex,
        endIndex: Math.max(diagram.messages.length - 1, completed.startIndex),
        dividers: completed.dividers,
      })
      continue
    }

    // --- Message ---
    // Patterns: A->>B, A-->>B, A-)B, A--)B, with optional +/- activation
    // Format: FROM ARROW TO: LABEL
    const msgMatch = line.match(
      /^(\S+?)\s*(--?>?>|--?[)x]|--?>>|--?>)\s*([+-]?)(\S+?)\s*:\s*(.+)$/
    )
    if (msgMatch) {
      const from = msgMatch[1]!
      const arrow = msgMatch[2]!
      const activationMark = msgMatch[3]
      const to = msgMatch[4]!
      const label = normalizeBrTags(msgMatch[5]!.trim())

      // Ensure both actors exist
      ensureActor(diagram, actorIds, from)
      ensureActor(diagram, actorIds, to)

      // Determine line style and arrow head from the arrow operator
      const lineStyle = arrow.startsWith('--') ? 'dashed' : 'solid'
      // ">>" = filled arrow, ")" or ">" alone = open arrow, "x" = cross (treat as filled)
      const arrowHead = arrow.includes('>>') || arrow.includes('x') ? 'filled' : 'open'

      const msg: Message = {
        from,
        to,
        label,
        lineStyle,
        arrowHead,
      }

      // Activation/deactivation via +/- prefix on target
      if (activationMark === '+') msg.activate = true
      if (activationMark === '-') msg.deactivate = true

      diagram.messages.push(msg)
      continue
    }

    // --- Simplified message format: A->>B: Label (fallback with more relaxed regex) ---
    const simpleMsgMatch = line.match(
      /^(\S+?)\s*(->>|-->>|-\)|--\)|-x|--x|->|-->)\s*([+-]?)(\S+?)\s*:\s*(.+)$/
    )
    if (simpleMsgMatch) {
      const from = simpleMsgMatch[1]!
      const arrow = simpleMsgMatch[2]!
      const activationMark = simpleMsgMatch[3]
      const to = simpleMsgMatch[4]!
      const label = normalizeBrTags(simpleMsgMatch[5]!.trim())

      ensureActor(diagram, actorIds, from)
      ensureActor(diagram, actorIds, to)

      const lineStyle = arrow.startsWith('--') ? 'dashed' : 'solid'
      const arrowHead = arrow.includes('>>') || arrow.includes('x') ? 'filled' : 'open'

      const msg: Message = { from, to, label, lineStyle, arrowHead }
      if (activationMark === '+') msg.activate = true
      if (activationMark === '-') msg.deactivate = true

      diagram.messages.push(msg)
      continue
    }

    // --- activate / deactivate explicit commands ---
    // These are handled implicitly via +/- on messages but can also appear standalone
    // For now, we skip explicit activate/deactivate lines (they affect rendering only)
  }

  return diagram
}

/** Ensure an actor exists, creating a default participant if not */
function ensureActor(diagram: SequenceDiagram, actorIds: Set<string>, id: string): void {
  if (!actorIds.has(id)) {
    actorIds.add(id)
    diagram.actors.push({ id, label: id, type: 'participant' })
  }
}
