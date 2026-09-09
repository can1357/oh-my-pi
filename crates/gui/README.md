# `omp-gui`

`omp-gui` hosts `omp-tui` applications in a native, GPU-accelerated window. The
same retained `Frame` cell grids a terminal `Renderer` would emit as ANSI are
composited and rasterized directly by wgpu — no escape bytes, no intermediate
terminal emulator — inside a semi-transparent, decoration-less, vibrancy-backed
shell.

## Structure

- `fonts` discovers system faces (fontdb), shapes cell clusters (rustybuzz),
  rasterizes glyphs (swash), and packs them into two atlases: an R8 coverage
  atlas for outlined text and an RGBA atlas for color bitmap emoji.
- `gpu` owns the wgpu device and the two-pipeline painter: instanced SDF
  rounded rects (fills, shadows, carets, scrollbars) and instanced atlas
  glyphs, alpha-premultiplied end to end so the window can go translucent.
- `cells` is the compositor: it walks the document `Frame`'s visible window
  plus declarative `Layer` bands and emits rect/glyph instances, resolving
  `Style` attributes (reverse, dim, underline, strikethrough, wide graphemes).
- `pixels` bridges externally rendered content into the frame: a
  `PixelSurface` keeps one GPU texture current from CPU-side RGBA frames
  (an embedded browser via `omp-webview` frames surfaces, video, any
  offscreen producer) — full frames or damage-rect regions, tight rows
  straight to `write_texture` — and a `PixelPainter` composites surfaces as
  premultiplied gamma-space quads over or under the cell pass (see
  `examples/browser.rs`, including its `--delta` readback proof).
- `scene` is the host contract: a `Scene` produces `SceneFrame`s and routes
  input; `mux` is the pure split-tree layout; `host` is the winit shell that
  drives windows → tabs → split panes (one scene per pane) — window
  lifecycle, IME marked-text/candidate-caret synchronization, native
  file/media drops, OS focus/resize/appearance changes, cell geometry,
  animation ticks, smooth transcript scrolling, clipboard pastes, mux
  hotkeys, and window chrome (tab strip, pane dividers, drag zones,
  vibrancy, rounded corners).

## Philosophy

Text is parsed once, at the component boundary, exactly like the terminal
host: the GUI consumes the retained cell grid, never escape sequences. The
window is chrome the application never thinks about — it renders the same
document and layers the terminal would, with pixel freedom the terminal does not have: smooth scrolling, soft shadows, translucency, and real emoji.
The native adapter still projects the terminal actor's retained `Frame`; its
named off-screen debug socket drives the same scene methods as winit and can
inject IME, drop, focus, theme, key, mouse, paste, resize, and clean-close
events without gaining controller or session authority.

## Run the chat demo

```sh
cargo run -p omp-gui --example chat            # native window
cargo run -p omp-gui --example chat -- --shot welcome /tmp/welcome.png
```

The example reuses the terminal chat's scene modules verbatim (`#[path]`
includes, the same pattern the gallery example uses); only the host changes.
