// ============================================================================
// Label normalization
//
// Shared by the diagram parsers (flowchart/state, class, ER, sequence) to
// normalize raw Mermaid label text before it reaches the ASCII renderers.
// The SVG-only multi-line tspan renderers from upstream are not vendored.
// ============================================================================

/**
 * Normalize label text for terminal ASCII output: strip surrounding quotes,
 * convert <br> tags and literal newline escapes to newlines, and reduce
 * inline formatting (HTML bold/italic/underline/strike tags and the markdown
 * bold, italic, and strikethrough markers) to plain text. The ASCII renderer
 * has no styled spans, so preserving the markup would print raw tags and
 * markers inside node boxes.
 */
export function normalizeBrTags(label: string): string {
  // Strip surrounding double quotes (Mermaid uses them for special chars in labels)
  const unquoted = label.startsWith('"') && label.endsWith('"') ? label.slice(1, -1) : label
  return unquoted
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\n/g, '\n')
    .replace(/<\/?(?:sub|sup|small|mark)\s*>/gi, '')
    // Drop inline HTML formatting tags — ASCII output has no styled spans
    .replace(/<\/?(?:b|strong|i|em|u|s|del)\s*>/gi, '')
    // Reduce markdown emphasis to its inner text (order matters: ** before *)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^\s*](?:[^*]*[^\s*])?)\*(?!\*)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
}
