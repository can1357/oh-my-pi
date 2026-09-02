/**
 * Transcript layout style. `omp` is the default look: tool cards with framed
 * output previews and state-tinted backgrounds. `opencode` is a flat,
 * opencode-style transcript: collapsed tool calls render as a single status
 * line (Ctrl+O still expands the full card) and the user message gets a left
 * accent gutter instead of relying on background fill alone.
 *
 * Module-level flag mirroring the `setTuiTight` precedent in pi-tui: set once
 * at InteractiveMode construction from `display.layout` and live-updated by
 * the settings selector. Components read it at render/rebuild time and fold it
 * into their memo keys, so a toggle only needs invalidate + repaint.
 */
export type LayoutMode = "omp" | "opencode";

let layoutMode: LayoutMode = "omp";

export function setLayoutMode(mode: LayoutMode): void {
	layoutMode = mode;
}

export function isOpencodeLayout(): boolean {
	return layoutMode === "opencode";
}
