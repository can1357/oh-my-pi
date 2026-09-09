// ============================================================================
// Mermaid → ASCII renderer (vendored)
//
// First-party copy of the ASCII rendering pipeline from `beautiful-mermaid`
// (MIT, Copyright (c) 2026 Craft Docs — see ./NOTICE). The SVG pipeline and
// its `elkjs` graph-layout dependency are omitted; the ASCII renderers use
// their own grid layout + A* edge routing and need no external deps. Terminal
// display-width math is delegated to `Bun.stringWidth` (see ./text-metrics).
//
// Public surface: renderMermaidASCII + AsciiRenderOptions (incl. the
// `direction` override) and the theme/color-mode types.
// ============================================================================

export * from './ascii/index'
