# generate_image

> Generate or edit images and write generated image files to temporary paths.

## Source
- Entry: `packages/coding-agent/src/tools/image-gen.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/image-gen.md`
- Session injection: `packages/coding-agent/src/sdk.ts` (`getImageGenTools()`)

The custom tool is registered only when `generate_image.enabled=true` (default `false`) and the session's explicit tool filter, if any, requests `generate_image`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `subject` | `string` | Yes | Main image prompt. For edits, describe the desired result and each input image's role. |
| `action` | `string` | No | What the subject is doing. |
| `scene` | `string` | No | Location or environment. |
| `composition` | `string` | No | Camera angle and framing. |
| `lighting` | `string` | No | Lighting setup. |
| `style` | `string` | No | Artistic style. |
| `text` | `string` | No | Text to render in the image. Keep short and specify legibility when needed. |
| `changes` | `string[]` | No | Edit instructions for input images. |
| `aspect_ratio` | `"1:1" \| "3:4" \| "4:3" \| "9:16" \| "16:9" \| "3:2" \| "2:3"` | No | Requested output aspect ratio. |
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | No | Requested output size where the selected provider supports it. |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | No | Input images by local path or inline base64 data. |
| `provider` | `"auto" \| "openai" \| "openai-codex" \| "antigravity" \| "xai" \| "openrouter" \| "gemini" \| "deepinfra"` | No | Per-request provider preference. A concrete value is tried first; `auto` or omission uses configured/session ordering. |

## Outputs
- Success with image data:
  - `content[0].type = "text"`
  - `content[0].text` summarizes provider/model and saved image paths.
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- Provider responses with no image data return `imageCount: 0`, empty `imagePaths` / `images`, and any provider text/feedback available.

## Flow
1. The SDK injects `generate_image` as a custom tool via `getImageGenTools()` only when the feature gate and tool filter allow it.
2. Provider order is: concrete per-request `provider`, entries in `providers.imageOrder`, the active session model's corresponding image provider, then the built-in order `openai`, `openai-codex`, `antigravity`, `xai`, `openrouter`, `gemini`, `deepinfra`; duplicates are removed. `provider: "auto"` does not add a provider.
3. The tool skips providers without usable credentials. Credentialed provider HTTP failures are collected and the next provider is tried; validation, parsing, local I/O, cancellation, and timeout failures are not fallback conditions.
4. Input images are resolved once, after the first usable provider is found. A `path` is resolved relative to session cwd and content-sniffed. Inline `data` may be raw base64 (requiring `mime_type`) or a `data:<mime>;base64,...` URL.
5. Provider-specific aspect-ratio support is checked after provider selection.
6. Provider dispatch:
   - OpenAI: hosted Responses image-generation on an active compatible GPT Responses model.
   - OpenAI Codex: hosted Responses image-generation on a compatible connected ChatGPT/Codex subscription model, even when the active chat model is from another provider.
   - Antigravity: Google Antigravity SSE endpoint.
   - OpenRouter: image-capable chat completion endpoint.
   - xAI: Grok Imagine generation or edit endpoint.
   - Gemini: Gemini `generateContent` with `responseModalities: ["IMAGE"]`.
   - DeepInfra: OpenAI-compatible `images/generations` endpoint (default model `black-forest-labs/FLUX-2-pro`, `DEEPINFRA_API_KEY` accepted). Text-to-image only — edit requests fall through to a later edit-capable provider.
7. Inline images in a successful provider response are saved to temporary files; paths and base64/MIME image metadata are returned. A response with no image data returns a normal zero-image result rather than `isError`.

## Modes / Variants
- Text-to-image: provide `subject` and optional style/composition fields, no `input`.
- Image edit: provide one or more `input` images plus `changes` and a subject that identifies each image role.
- Text rendering: use `text`; the prompt instructs callers to request sharp, legible, correctly spelled short text.
- Provider selection: set `provider` to prefer one backend for a request; fallback still follows the remaining configured/session/built-in order after credentialed HTTP failures.

## Side Effects
- Filesystem: reads local input images and writes generated output images to `omp-image-<snowflake>.<ext>` files under the OS temporary directory.
- Network: sends prompts and optional images to the selected image provider. OpenRouter/xAI image URLs in responses are downloaded before saving.
- Session state: reads active model, session id, cwd, credentials, `providers.imageOrder`, Antigravity endpoint settings, and optional injected `fetch`.
- Background work / cancellation: provider calls use the caller abort signal combined with a 3 minute timeout.

## Limits & Caps
- Local path inputs are capped at `35 * 1024 * 1024` bytes (`MAX_IMAGE_SIZE`). Inline base64 inputs have no separate tool-level size cap.
- A path input must exist and have a supported content-sniffed image type. Each input object must contain `path` or `data`; `path` wins when both are present.
- Raw base64 `data` requires `mime_type`; a data URL supplies its own MIME type.
- Provider timeout is `3 * 60 * 1000` ms.
- OpenAI hosted output is requested as WebP. Other response files use MIME-derived extensions (`png`, `jpg`, `gif`, or `webp`; unknown MIME types fall back to `.png`).
- Common aspect ratios are `1:1`, `3:4`, `4:3`, `9:16`, and `16:9`; only xAI also accepts `3:2` and `2:3`.
- `image_size` accepts `1024x1024`, `1536x1024`, and `1024x1536`. On xAI these map to `1k`, `2k`, and `2k`; omission defaults to `1k`.
- xAI edit requests accept at most 3 input images.

## Errors
- No usable provider credentials: `No image API credentials found...`; the message lists supported login/API-key routes.
- Invalid input: file not found, file over 35 MiB, unsupported content-sniffed image type, missing `path`/`data`, empty image data, or raw base64 without `mime_type`.
- OpenAI path without a compatible GPT model: `Missing active GPT model for OpenAI image generation`.
- Antigravity credentials without `projectId`: `Missing projectId in antigravity credentials`.
- More than three xAI edit references: `xAI image edits accept up to 3 reference images...`.
- A `3:2` or `2:3` request fails if no usable xAI route is reached.
- Credentialed provider HTTP failures fall through to later providers. If every such provider fails, the tool throws an `AggregateError` naming all attempted providers and containing their provider-specific HTTP errors.
- Cancellation, the three-minute timeout, malformed provider responses, and local I/O errors throw directly.

## Notes
- The tool is a custom tool, not a built-in `AgentTool` class, so its root docs live here even though the model-facing prompt is in `src/prompts/tools/image-gen.md`.
- Multiple input images should be named in `subject` as `Image 1`, `Image 2`, etc. so the provider receives unambiguous edit instructions.
