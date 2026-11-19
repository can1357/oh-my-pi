export const EXTRACTION_SYSTEM_PROMPT = `You extract structured facts from conversation messages. For each message or group of related messages, identify:

1. ENTITIES: People, projects, tools, versions, dates, numbers mentioned
2. RELATIONSHIPS: How entities relate to each other (uses, created, set, changed, prefers)
3. TEMPORAL ANCHORS: When something happened, deadlines, durations
4. CONTRADICTIONS: When a fact was later changed or updated

Return ONLY a JSON array of fact objects. Each fact must have:
- subject: the entity the fact is about (string)
- predicate: the relationship or action (string)
- object: the value or related entity (string)
- timestamp: ISO timestamp when this was stated (string, from message context)
- source: which message index this came from (integer, 0-based)
- confidence: 0.0-1.0 how certain you are (float)

RULES:
- One fact per relationship. "I use React 18.2 and Node.js 18" = 2 facts.
- Use lowercase for predicates: "uses", "set", "changed", "created", "prefers"
- Include versions and numbers as objects when available
- If a message states something changed, extract BOTH old and new facts
- If unclear, use confidence < 0.8

Format: [{"subject": "...", "predicate": "...", "object": "...", "timestamp": "...", "source": 0, "confidence": 0.95}]
`;

export const EXTRACTION_USER_TEMPLATE = `Extract all structured facts from the following conversation messages. Return ONLY the JSON array, no other text.

CONVERSATION:
{conversation_text}

FACTS:`;
