/**
 * Transcript layout style. `omp` is the default look: tool cards with framed
 * output previews and state-tinted backgrounds. `opencode` is a flat,
 * opencode-style transcript: collapsed tool calls render as a single status
 * line (Ctrl+O still expands the full card) and the user message gets a left
 * accent gutter instead of relying on background fill alone.
 *
 * The value is per-mode state: `InteractiveMode` owns it (`ctx.layoutMode`,
 * seeded from `display.layout` and live-updated by the settings selector and
 * setup wizard). Transcript components capture a {@link LayoutAccessor} at
 * construction and fold the value into their memo keys, so two concurrently
 * live modes never share layout state and a toggle only needs invalidate +
 * repaint. Framed tool renderers receive the resolved flag as `flat` on their
 * render context and pass it through to `renderOutputBlock`.
 */
export type LayoutMode = "omp" | "opencode";

/** Reads the owning mode's current layout at render/rebuild time. */
export type LayoutAccessor = () => LayoutMode;
