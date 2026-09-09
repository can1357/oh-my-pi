# 0032. Semantic colors, icons, charset, pacing belong to the renderer

Status: accepted
Date: 2026-09-02
Area: interface

## Context

Under pi's contract there is no place to put presentation policy, so every extension sets it:

- No rule says whether curved borders are acceptable, whether Nerd Font glyphs may be emitted,
  or which color conveys "error" in the user's theme. The community web-search renderer (0030)
  hardcodes `\u25b8` and `\u00b7` as bullets and picks `theme.fg("muted", ...)` /
  `theme.fg("dim", ...)` per line.
- A theme object has to be threaded through every render function for even that much; an
  extension that forgets it falls back to literal colors.
- The result is either the bare minimum ("indistinguishable gray rectangles") or one extension
  that looks fancy and out of place next to a minimalist setup. Restyling is done by asking the
  agent to redo each one and then maintaining the result.
- Streaming text has no owner for its pace. Claude emits a few words per chunk, Codex a few
  characters; rendered raw, one reads as bursts-then-stalls and the other as a steady crawl.
  Steady motion reads as progress; bursts followed by stalls do not.

The component model (0031) gives the renderer a place to resolve all of these, because the markup
carries semantics instead of results.

## Decision

1. Icons are semantic. Extensions write `<ico:new/>` (runtime markup) or `<i:new/>` (`dom!`); the
   renderer resolves the glyph through the user's charset choice: ASCII, Unicode, or Nerd Font.
   Borders, rules, grid chrome, and status-band caps resolve the same way. Hand-emitted glyphs are
   prohibited.
2. Colors are semantic. Extensions ask for `info`, `error`, `muted`, `accent` (`fg=info`,
   `bc=info`, `tone=error`); the theme maps them. Literal colors are prohibited in extension and
   tool markup. Gradients are values, not special elements: `fg=red..blue` is a color value with an
   optional angle, accepted anywhere a color is.
3. No theme object is threaded. Theme, charset, and appearance (dark/light) reach every component
   through one ambient context supplied by the renderer, swappable at run time without rebuilding
   the tree.
4. Truncation is the renderer's. Components declare `wrap=word`, `truncate`, or nothing, and the
   stream adapters (0030) apply width; markup NEVER slices text to a guessed column count.
5. Stream pacing is the renderer's. Provider chunk cadence is smoothed at presentation time into a
   steady reveal; tool and provider code emits text as it arrives and never sleeps or batches for
   appearance.
6. Border defaults are themed and dim, not `#fff`.

The post's example: `border=round bc="info"` resolves to the theme's info color; `fg="red..blue"`
renders a gradient. No theme object anywhere.

## Consequences

- Every plugin gets a consistent look for free, and the user's choices (ASCII terminal, light
  theme, Nerd Font) apply to extensions the plugin author never tested against.
- Restyling the harness is a theme change, not a sweep across extensions.
- Prohibited: hardcoded colors, hand-picked glyphs, per-extension truncation math, per-provider
  presentation timing.
- Cost accepted: an extension cannot pick an exact brand color or a specific glyph even when it
  wants to; the escape hatch is a new semantic slot or icon in the catalog, reviewed centrally.

## Status in omp

**Implemented.** Primary implementation: `crates/chat/src/project.rs`. Chat and cards emit semantic
presentation values into one ambient renderer context. `crates/gui/src/host.rs` maps the native
window's initial and changed light/dark appearance into that same `UiContext`; `NativeHost`
reprojects the retained actor and composer from the ambient palette rather than threading a native
theme through components.

## References

- The Harness Playbook, "The interface": "Presentation policy belongs to the renderer"
- `crates/tui/icons.tsv`, `crates/tui/src/context.rs`, `crates/tui/src/markup.rs`,
  `crates/tui/src/components/text.rs`, `crates/tui/README.md`
- `AGENTS.md` "TUI Rendering Doctrine"
- 0030 (truncation as a stream transform), 0031 (the markup that carries semantics)
