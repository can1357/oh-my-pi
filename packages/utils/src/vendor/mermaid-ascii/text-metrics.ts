// ============================================================================
// Terminal display width — used by the ASCII renderer
//
// Terminals render most characters in 1 column, but East Asian wide
// characters (CJK ideographs, Hangul, kana, fullwidth forms) and
// emoji-presentation glyphs occupy 2 columns. The ASCII canvas is a
// cell-per-column grid, so its width math counts display columns rather
// than code units.
//
// Width is delegated to Bun.stringWidth (wcwidth-style, locale-insensitive):
// East Asian Wide/Fullwidth and emoji-presentation graphemes (incl. ZWJ
// sequences and regional-indicator flags) measure 2; box-drawing, the
// renderer's narrow arrowheads (◀ ▶ ►), and East Asian Ambiguous glyphs
// measure 1. This matches the renderer's structural glyph set exactly.
//
// Text is measured in grapheme clusters (Intl.Segmenter): a cluster that
// renders 2 columns is stored as its full string in one canvas cell
// followed by WIDE_PAD in the continuation cell it covers. The ASCII
// serializers drop WIDE_PAD cells when joining a row, so the emitted line
// occupies exactly as many terminal columns as the canvas has cells.
// ============================================================================

/**
 * Placeholder occupying the second cell of a fullwidth glyph on the ASCII
 * canvas. U+0000 cannot appear in parsed Mermaid labels, is treated as
 * occupied label content by canvas merging, and is stripped at
 * serialization time. Invariant: a WIDE_PAD cell always sits immediately
 * right of its lead cell; canvas writes keep the pair atomic.
 */
export const WIDE_PAD = '\u0000'

/** Opaque label-space placeholder that serializes back to a regular space. */
export const LABEL_SPACE = '\u0001'

const graphemeSegmenter = new Intl.Segmenter()

/**
 * Display width of a string in terminal columns, summed over grapheme
 * clusters so it always equals `toCells(text).length`. ASCII-only strings
 * take a fast path.
 */
export function displayWidth(text: string): number {
  let ascii = true
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7e) {
      ascii = false
      break
    }
  }
  if (ascii) return text.length

  let width = 0
  for (const seg of graphemeSegmenter.segment(text)) {
    width += Bun.stringWidth(seg.segment) >= 2 ? 2 : 1
  }
  return width
}

/**
 * Expand a string into ASCII-canvas cells: each 2-column grapheme cluster
 * is stored whole in one cell and followed by WIDE_PAD, so that
 * `cells.length === displayWidth(text)`. Per-character placement loops can
 * iterate the result with plain cell offsets.
 */
export function toCells(text: string): string[] {
  const cells: string[] = []
  for (const seg of graphemeSegmenter.segment(text)) {
    cells.push(seg.segment)
    if (Bun.stringWidth(seg.segment) >= 2) {
      cells.push(WIDE_PAD)
    }
  }
  return cells
}
