# inspect_image

> Send a local image file or current-turn image attachment to a vision-capable model and return text analysis.

## Source
- Entry: `packages/coding-agent/src/tools/inspect-image.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/inspect-image.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/inspect-image-renderer.ts` — TUI call/result rendering.
  - `packages/coding-agent/src/utils/image-loading.ts` — path resolution, type detection, size gate, optional resize.
  - `packages/coding-agent/src/utils/image-resize.ts` — downscale and recompress oversized images.
  - `packages/coding-agent/src/tools/path-utils.ts` — resolve input path relative to session cwd.
  - `packages/utils/src/mime.ts` — detect supported image formats from file bytes.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Local image path (resolved relative to `session.cwd`), local `.svg`/`.svgz` path with an explicit `:img` selector, current-turn `Image #N` label, or `attachment://N` / `image://N` URI. Attachment indexes are 1-based. |
| `question` | `string` | Yes | User prompt sent as a text content block alongside the image. |

## Outputs
The tool returns a single `AgentToolResult`:

- `content`: one text block, `[{ type: "text", text }]`, where `text` is the concatenated assistant text content from the model response.
- `details`:
  - `model`: `<provider>/<id>` of the selected model.
  - `imagePath`: resolved filesystem path for a file input, or the canonical attachment URI for an attachment input.
  - `mimeType`: MIME type actually sent to the model after optional resize/re-encode.
  - `usage`: token usage from the model response.

Model-visible output is single-shot, not streamed by this tool.

TUI rendering adds presentation-only truncation from `packages/coding-agent/src/tools/inspect-image-renderer.ts`:

- call preview truncates `question` to 100 columns,
- result view shows 4 lines collapsed or 16 lines expanded,
- each rendered output line is truncated to 120 columns,
- footer metadata shows `model · mimeType` when present.

## Flow
1. `InspectImageTool.execute(...)` rejects immediately if `images.blockImages` is enabled in session settings.
2. It reads `session.modelRegistry`; missing registry, empty registry, missing API key, or unresolved model each raise `ToolError` from `packages/coding-agent/src/tools/inspect-image.ts`.
3. Model selection tries, in order, `@vision`, `@default`, the active model string from the session — each must resolve to a model advertising image input — then the first image-capable model sharing the active model's provider, then the first image-capable model overall. `expandRoleAlias(...)` and `resolveModelFromString(...)` handle each lookup.
4. If no image-capable model is found, execution fails before reading the file.
5. `parseImageAttachmentReference(...)` interprets exact `Image #N` labels (optionally bracketed), `attachment://N`, and `image://N` (case-insensitive) as 1-based references into the turn's image attachments (`session.getImageAttachments()` loaded via `loadImageAttachmentInput(...)`). A reference with no attachments or an out-of-range index raises a `ToolError` listing the available attachments. Other values are loaded as files: `loadImageInput(...)` resolves the path with `resolveReadPath(...)`, detects MIME type with `readImageMetadata(...)`, and rejects files larger than `MAX_IMAGE_INPUT_BYTES` (`20 * 1024 * 1024`, 20 MiB). Attachment bytes have the same 20 MiB cap.
6. A path ending in `:img` selects SVG loading: `splitPathAndSelPreferringLiteral(...)` splits the selector and `loadSvgImageInput(...)` rasterizes `.svg`/`.svgz` bytes to PNG (`rasterizeSvg` from `@oh-my-pi/pi-natives`, max edge 2048px) before the normal encode/resize pipeline. A `:img` selector on a non-SVG file fails with an explicit error.
7. File metadata is detected from headers. Attachment inputs use their supplied image MIME type. Supported MIME types are `image/png`, `image/jpeg`, `image/gif`, and `image/webp`.
8. The loader uses `excludeWebP: webpExclusionForModel(model)` (`true` only for models that cannot decode WebP, such as the Ollama family). It calls `resizeImage(...)` when `images.autoResize` is true, or when WebP must be re-encoded for the selected model. Resize failures are swallowed and the original bytes are kept.
9. If the file header or attachment MIME type is unsupported, `execute(...)` throws `ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.")`.
10. The tool calls `instrumentedCompleteSimple(...)` with one user message containing two content parts in order:
   - `{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType }`
   - `{ type: "text", text: params.question }`
11. `systemPrompt` is a one-element array rendered from `packages/coding-agent/src/prompts/tools/inspect-image-system.md`; telemetry is tagged with oneshot kind `inspect_image`. The request carries the thinking effort selected on the resolved vision/default model role.
12. The model call uses the caller signal plus `inspect_image.timeoutMs` (default 300,000 ms); `0` disables this timeout. Provider errors, aborts, and timeouts become `ToolError`s.
13. `extractTextContent(...)` from `packages/coding-agent/src/commit/utils.ts` concatenates only `text` content blocks from the assistant message, trims the result, and the tool fails if nothing remains.
14. Success returns the text plus `details`; `inspectImageToolRenderer` formats the result for the TUI.

## Modes / Variants
- **Original image path**: `images.autoResize` disabled. The original file bytes are base64-encoded and sent with the detected MIME type.
- **Auto-resized path**: `images.autoResize` enabled. `resizeImage(...)` may downscale and re-encode the image before upload.
- **SVG path**: `<file>.svg:img` / `<file>.svgz:img` rasterizes the vector source to PNG before upload; the 20 MiB cap applies to the source file.
- **Unsupported image path**: file exists but header sniffing does not identify PNG/JPEG/GIF/WEBP. The tool returns a `ToolError` before any model call.
- **Oversize image path**: file size exceeds 20 MiB before upload. The tool returns a `ToolError` before any model call.
- **Attachment path**: resolve a current-turn pasted/uploaded image by its `Image #N` label or attachment URI without reading a filesystem path.

## Side Effects
- Filesystem
  - For file inputs, resolves and reads the target image from disk: stats the file once with `Bun.file(...).stat()` and reads it fully with `fs.readFile(...)`.
  - SVG inputs are additionally rasterized to PNG in memory.
  - Attachment inputs are loaded from the current turn's in-memory image attachment list.
- Network
  - Sends the final base64 image payload plus question text to the selected model through `instrumentedCompleteSimple(...)` / the configured simple completion implementation.
- Session state
  - Reads session settings, active model preferences, cwd, and model registry.
- Background work / cancellation
  - Passes the caller `AbortSignal` into `instrumentedCompleteSimple(...)` and the configured simple completion implementation.
  - Image preprocessing is local and not cancellation-aware in these helpers.

## Limits & Caps
- Supported detected input formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp` (`SUPPORTED_IMAGE_MIME_TYPES` in `packages/utils/src/mime.ts`).
- Metadata sniff cap: `DEFAULT_IMAGE_METADATA_HEADER_BYTES = 256 * 1024` bytes. Format detection only reads up to 256 KiB from the file header.
- Availability is gated by `inspect_image.mode` (`auto`|`on`|`off`, default `auto`) in `packages/coding-agent/src/config/settings-schema.ts`, resolved with the session-scoped `/vision` override and the active model's image capability in `packages/coding-agent/src/utils/inspect-image-mode.ts` / `packages/coding-agent/src/tools/index.ts`. `auto` registers the tool only when the active model lacks native image input; the legacy `inspect_image.enabled` boolean migrates to `mode` (`true`→`on`, `false`→`off`).
- Upload input cap: `MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024` bytes (20 MiB) in `packages/coding-agent/src/utils/image-loading.ts`.
- SVG rasterization cap: `SVG_IMAGE_MAX_EDGE_PX = 2048` (max width/height of the rasterized PNG) in `packages/coding-agent/src/utils/image-loading.ts`.
- Vision request timeout: `inspect_image.timeoutMs` defaults to `300_000` ms (5 minutes); set it to `0` to disable.
- Auto-resize defaults in `packages/coding-agent/src/utils/image-resize.ts`:
  - `maxWidth: 1568`
  - `maxHeight: 1568`
  - `maxBytes: 500 * 1024` bytes (500 KiB target)
  - `jpegQuality: 80`
- Resize fast path: if the original image is already within `1568x1568` and within `maxBytes / 4` (125 KiB by default), `resizeImage(...)` returns the original bytes unchanged.
- Resize quality ladder: after the first encode pass, lossy retries use qualities `[70, 60, 50, 40]`.
- Resize dimension ladder: if quality reduction still misses the byte target, retries scale dimensions by `[1.0, 0.75, 0.5, 0.35, 0.25]` and stop if either dimension would fall below `100` pixels.
- First resize pass encodes PNG, JPEG, and WebP, then keeps the smallest encoded buffer. Fallback passes encode JPEG and WebP only, again keeping the smaller output. WebP is excluded from both ladders when `OMP_NO_WEBP=1`/`true` (or `excludeWebP` is passed).
- Renderer caps:
  - `INSPECT_QUESTION_PREVIEW_WIDTH = 100`
  - `INSPECT_OUTPUT_COLLAPSED_LINES = 4`
  - `INSPECT_OUTPUT_EXPANDED_LINES = 16`
  - `INSPECT_OUTPUT_LINE_WIDTH = 120`

## Errors
- Settings gate:
  - `Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.`
- Model resolution / capability:
  - `Model registry is unavailable for inspect_image.`
  - `No models available for inspect_image.`
  - `Unable to resolve a model for inspect_image.`
  - `Resolved model <provider>/<id> does not support image input. Configure a vision-capable model for modelRoles.vision.`
  - `No API key available for <provider>/<id>. Configure credentials for this provider or choose another vision-capable model.`
- Input file:
  - `Image file too large: <size> exceeds <limit> limit.` from `ImageInputTooLargeError`, remapped to `ToolError`.
  - `inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.` when header sniffing fails.
  - `inspect_image ':img' only supports .svg and .svgz files.` when the `:img` selector targets a non-SVG file.
  - `Could not rasterize SVG: <message>` when SVG rasterization fails.
  - `No image attachments are available in this turn. path="<path>" must be a readable file path or attachment URI.` when an attachment reference is used but the turn has no image attachments.
  - `Could not resolve image attachment '<path>'. Available image attachments: <label -> uri, ...>. Pass an attachment URI or a readable filesystem path.` when the 1-based reference is out of range.
- Model call:
  - `inspect_image request failed.` if the response stop reason is `error` without a provider message.
  - Provider `errorMessage` is passed through when present.
  - `inspect_image request aborted.` on aborted responses.
  - `inspect_image request timed out after <seconds>s...` when `inspect_image.timeoutMs` expires.
  - `inspect_image model returned no text output.` when the assistant message contains no text blocks after filtering.

Failures surface as thrown `ToolError`s from `execute(...)`; the normal success return shape is not used for error reporting.

## Notes
- Although the `AgentTool.strict` transport hint is `false`, the ArkType schema explicitly rejects unknown parameters; only `path` and `question` are accepted.
- The model-facing prompt path on disk is `packages/coding-agent/src/prompts/tools/inspect-image.md`; the underscore form does not exist.
- Format support is based on file content, not filename extension. Renaming a non-image file to `.png` does not make it valid.
- `resolveReadPath(...)` tries macOS-specific path variants: shell-unescaped spaces, AM/PM narrow no-break-space filenames, NFD normalization, and curly-quote variants.
- `loadImageInput(...)` also computes `textNote`, `dimensionNote`, and final `bytes`, but `inspect_image` does not include those in tool output.
- Auto-resize can change the MIME type sent to the model. A JPEG or GIF input may be uploaded as PNG, JPEG, or WebP depending on which encoder output is smallest.
- If `resizeImage(...)` throws or cannot decode the image, `loadImageInput(...)` silently keeps the original base64 payload instead of failing.
