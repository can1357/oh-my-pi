Generates/edits images.

<instructions>
- One detailed `subject` prompt: generation or editing.
- Multiple `input`: describe each image's role in `subject` (e.g. `Image 1` for composition, `Image 2` for lighting).
- Text: add "sharp, legible, correctly spelled"; keep short.
- `model`: catalog alias or raw `fal:<endpoint-id>` / `openrouter:<model-id>`; omit to follow `providers.imageModel` / the credentialed provider order.
- Canonical knobs: `aspect_ratio`, `resolution` (`512`/`1K`/`2K`/`4K`), `n`, `quality` (`auto`/`low`/`medium`/`high`), `output_format` (`png`/`jpeg`/`webp`/`svg`), `background` (`auto`/`transparent`/`opaque`), `seed`. A knob a model does not support fails closed with the supported values — no silent model substitution.
- Multi-image/grid: `n` defaults to `1`. If the user asks for a grid, contact sheet, multiple variants, or two or more outputs, MUST set `n` explicitly to `2` or more in one call; do not satisfy that request with separate calls. One result with `details.images` containing multiple images is what the TUI renders as one `ImageGrid`; separate tool calls remain separate blocks and are never merged. For deterministic multi-image behavior, pin `provider: "fal"` and use a multi-image-capable binding such as `nano-banana-pro`, `nano-banana-2`, `gpt-image-2`, `seedream-4.5`, or `flux-schnell`. Unsupported counts fail closed. One call cannot mix models or per-image prompts.
- If the request needs distinct prompts or models for each image, use separate calls; that produces separate image blocks rather than one grid.
- `provider` pins the backend for this request; otherwise `providers.imageOrder`, the active session provider, and the built-in order decide.
</instructions>

Catalog models:
{{#each models}}- `{{this.id}}` — {{this.summary}}
{{/each}}
