# @oh-my-pi/snapcompact

Bitmap-frame context compression for vision-capable LLMs.

Instead of asking an LLM to summarize discarded conversation history, snapcompact serializes it and renders the text into dense PNG frames of pixel-font glyphs that vision models read back directly. The whole pass is local and deterministic — no LLM call, no API key, no latency beyond rendering. Rasterization and PNG encoding happen in native code (`@oh-my-pi/pi-natives`).

Built for [omp](https://github.com/can1357/oh-my-pi)'s compaction pipeline, but the rendering API works on arbitrary text.

## How it works

1. Discarded history is serialized to compact text (`serializeConversation`), with per-tool-result and per-argument character caps.
2. Text is normalized (`normalize`): ANSI sequences and decorative emoji are stripped, whitespace collapses, newline runs become full-block markers, and common symbols fold to ASCII. Snapcompact selects one installed font that covers the whole transcript. If none does, the agent uses text compaction and inline content stays text.
3. Pages of text are rasterized into PNG frames (`render` / `renderMany`). Frame width is fixed per shape; height hugs the rows actually printed, with a 64px minimum so short final frames remain valid for vision processors.
4. Frames persist in the compaction entry's `preserveData` and are re-attached to the summary message on every context rebuild.

Frame shapes are provider-aware, chosen by SQuAD recall evals (see `research/`) against real provider billing:

| Reader    | Default shape    | Notes                                                                                                     |
| --------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| Anthropic | `11on16-bw`      | 11px advance and 16px row pitch; high-res Claude lines get 1932px frames                             |
| Google    | `8on22-bw` @2048 | 8px advance and 22px row pitch; Gemini bills a fixed per-image budget, so larger frames are free chars |
| OpenAI    | `8on22-bw`       | 8px advance and 22px row pitch, sent at `detail: "original"`                                           |
| Unknown   | Anthropic shape  | Per-provider image-count budgets guard against gateways that silently drop frames                         |

`resolveShape({ api, id })` matches the model id, not just the wire API — a Claude routed through Vertex or OpenRouter keeps its Claude shape. Frames are priced by the reading model's lineage: its catalog `image-tokenization` rule (so that Claude is billed as Claude, and Opus 4.6 under the standard 1,568-token tier), falling back to the catalog rule for the wire API carrying the request when the lineage has none. A reader with neither costs `FRAME_TOKEN_ESTIMATE` per frame. Archive sizing (`plannedFrameTokens`) charges each frame its own price when the rule is `verified` against provider billing, and at least `FRAME_TOKEN_ESTIMATE` otherwise.

Narrow grids give wide CJK glyphs two cells. Auto uses `cjk16-bw` for CJK-heavy text: one 16×22 cell per glyph, with extra spacing between rows. All pages use the same face; no glyph is borrowed from a second font.

A host that downscales images before the model reads them (catalog `image-max-edge`; Cursor fits Claude and GPT images into 1024×1024) gets frames rendered at that edge, forced variants included, so the glyphs reach the model at the size they were drawn.

## Install

```sh
bun add @oh-my-pi/snapcompact
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.4.4.

## Usage

Render arbitrary text into LLM image blocks:

```ts
import { renderMany, frames, resolveShape } from "@oh-my-pi/snapcompact";

const images = renderMany(longText, { model }); // ImageContent[], first page first
const count = frames(longText, { model }); // frame count without rendering
const shape = resolveShape(model); // eval-optimal Shape for the reader
```

Run a full compaction pass over prepared messages:

```ts
import { compact } from "@oh-my-pi/snapcompact";

const result = await compact(preparation, { model });
// result.summary        — short "resume prior conversation" lead-in, reading guide, and FILES section
// result.preserveData   — bounded archive source + rendered image middle
```

## API surface

- **Compaction**: `compact`, `CompactionPreparation`, `CompactionResult`, `getPreservedArchive`, `images`, `historyBlocks`, `capFrameDataBytes`
- **Rendering**: `render`, `renderMany`, `frames`, `geometry`
- **Shapes**: `SHAPES`, `SHAPE_VARIANTS`, `resolveShape`, `resolveShapeForText`, `resolveShapeAndScan`, `idealShapeVariant`, `isShape`, `isShapeVariantName`
- **Text**: `serializeConversation`, `normalize`, `scanRenderability`, `renderabilityProbeText`, `dimStopwords`, `wrap`
- **Budgets**: `providerImageBudget`, `frameDataBytesBudget`, `MAX_FRAMES_DEFAULT`, `FRAME_TOKEN_ESTIMATE`, `frameBilling`, `frameTokens`, `frameBillingKey`, `plannedFrameTokens`, `HQ_EDGE_FRAMES`
- **File ops**: `createFileOps`, `computeFileLists`, `upsertFileOperations`

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [Compaction architecture](../../docs/compaction.md)
- [CHANGELOG](./CHANGELOG.md)
