// ============================================================================
// Sequence diagram types
//
// Models the parsed and positioned representations of a Mermaid sequence diagram.
// Sequence diagrams show actor interactions over time (vertical timeline).
// ============================================================================

/** Parsed sequence diagram — logical structure from mermaid text */
export interface SequenceDiagram {
  /** Ordered list of actors/participants */
  actors: Actor[]
  /** Messages between actors in chronological order */
  messages: Message[]
  /** Structural blocks (loop, alt, opt, par, critical) */
  blocks: Block[]
  /** Notes attached to actors */
  notes: Note[]
}

export interface Actor {
  id: string
  label: string
  /** 'participant' renders as a box, 'actor' renders as a stick figure */
  type: 'participant' | 'actor'
}

export interface Message {
  from: string
  to: string
  label: string
  /** Arrow style: solid line or dashed line */
  lineStyle: 'solid' | 'dashed'
  /** Arrow head: filled (closed) or open */
  arrowHead: 'filled' | 'open'
  /** Activate the target lifeline (+) */
  activate?: boolean
  /** Deactivate the source lifeline (-) */
  deactivate?: boolean
}

export interface Block {
  /** Block type keyword */
  type: 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'break' | 'rect'
  /** Label for the block header */
  label: string
  /** Index of the first message inside this block */
  startIndex: number
  /** Index of the last message inside this block (inclusive) */
  endIndex: number
  /** For alt/par blocks: indices where "else"/"and" dividers appear (message indices) */
  dividers: Array<{ index: number; label: string }>
}

export interface Note {
  /** Which actor(s) the note is attached to */
  actorIds: string[]
  /** Note text content */
  text: string
  /** Position relative to the actor(s) */
  position: 'left' | 'right' | 'over'
  /** Message index after which this note appears */
  afterIndex: number
}

// ============================================================================
// Positioned sequence diagram — ready for SVG rendering
// ============================================================================

export interface PositionedSequenceDiagram {
  width: number
  height: number
  actors: PositionedActor[]
  lifelines: Lifeline[]
  messages: PositionedMessage[]
  activations: Activation[]
  blocks: PositionedBlock[]
  notes: PositionedNote[]
}

export interface PositionedActor {
  id: string
  label: string
  type: 'participant' | 'actor'
  /** Center x of the actor box */
  x: number
  /** Top y of the actor box */
  y: number
  width: number
  height: number
}

/** Vertical dashed line from actor to bottom of diagram */
export interface Lifeline {
  actorId: string
  x: number
  topY: number
  bottomY: number
}

export interface PositionedMessage {
  from: string
  to: string
  label: string
  lineStyle: 'solid' | 'dashed'
  arrowHead: 'filled' | 'open'
  /** Start point (from actor's lifeline) */
  x1: number
  /** End point (to actor's lifeline) */
  x2: number
  /** Vertical position */
  y: number
  /** Whether this is a self-message (same actor) */
  isSelf: boolean
}

/** Narrow rectangle on a lifeline showing active processing */
export interface Activation {
  actorId: string
  x: number
  topY: number
  bottomY: number
  width: number
}

export interface PositionedBlock {
  type: Block['type']
  label: string
  x: number
  y: number
  width: number
  height: number
  /** Divider lines within the block (for alt/par) */
  dividers: Array<{ y: number; label: string }>
}

export interface PositionedNote {
  text: string
  x: number
  y: number
  width: number
  height: number
  /** Actor IDs this note is attached to (for SVG attribution) */
  actors?: string[]
  /** Note position relative to actors (for SVG attribution) */
  position?: 'left' | 'right' | 'over'
}
