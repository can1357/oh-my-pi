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
| `model` | `string` | No | OpenRouter image model ID. Selects OpenRouter independently of the chat model and overrides `providers.imageOpenRouterModel`. Compatible with omitted, `auto`, or `openrouter` provider only. |

## Outputs
- Success with image data:
  - `content[0].type = "text"`
  - `content[0].text` summarizes provider/model and saved image paths.
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- Provider responses with no image data return `imageCount: 0`, empty `imagePaths` / `images`, and any provider text/feedback available.

## Flow
1. The SDK injects `generate_image` as a custom tool via `getImageGenTools()` only when the feature gate and tool filter allow it.
2. A per-call `model` selects only OpenRouter. Otherwise, provider order is: concrete per-request `provider`, entries in `providers.imageOrder`, the active session model's corresponding image provider, then the built-in order `openai`, `openai-codex`, `antigravity`, `xai`, `openrouter`, `gemini`, `deepinfra`. Duplicate providers are removed. `provider: "auto"` does not add a provider.
3. `providers.imageOpenRouterModel` supplies the model when routing reaches OpenRouter, without changing provider order. A per-call model takes precedence. Without either, OpenRouter uses `google/gemini-3-pro-image-preview`. Model IDs retain their spelling after whitespace trimming. A blank setting clears the default.
4. An explicitly selected OpenRouter model fails without replacement if credentials are missing or the provider returns an HTTP error. Otherwise, the tool skips providers without credentials and tries the next provider after an HTTP failure. Validation, parsing, local I/O, cancellation, and timeout failures never trigger fallback.
5. Input images are resolved once, after the first usable provider is found. A `path` is resolved relative to session cwd and content-sniffed. Inline `data` may be raw base64 (requiring `mime_type`) or a `data:<mime>;base64,...` URL.
6. Provider-specific aspect-ratio support is checked after provider selection.
7. Provider dispatch:
   - OpenAI: hosted Responses image-generation on an active compatible GPT Responses model.
   - OpenAI Codex: hosted Responses image-generation on a compatible connected ChatGPT/Codex subscription model, even when the active chat model is from another provider.
   - Antigravity: Google Antigravity SSE endpoint.
   - OpenRouter: dedicated `/api/v1/images` endpoint for generation and editing. Before each call, the tool checks the selected model's advertised endpoints for the requested ratio and reference count together. When only some endpoints qualify, routing is restricted to provider tags that identify only qualifying endpoints.
   - xAI: Grok Imagine generation or edit endpoint.
   - Gemini: Gemini `generateContent` with `responseModalities: ["IMAGE"]`.
   - DeepInfra: OpenAI-compatible `images/generations` endpoint (default model `black-forest-labs/FLUX-2-pro`, `DEEPINFRA_API_KEY` accepted). Text-to-image only — edit requests fall through to a later edit-capable provider.
8. Inline images in a successful provider response are saved to temporary files. The result contains paths and base64/MIME metadata. A valid empty image array returns a normal zero-image result.

## Modes / Variants
- Text-to-image: provide `subject` and optional style/composition fields, no `input`.
- Image edit: provide one or more `input` images plus `changes` and a subject that identifies each image role.
- Text rendering: use `text`; the prompt instructs callers to request sharp, legible, correctly spelled short text.
- Provider selection: set `provider` to prefer one backend for a request. Without an explicit OpenRouter model, HTTP fallback follows the remaining configured/session/built-in order.
- OpenRouter model selection: set `providers.imageOpenRouterModel` for a default, or pass `model` for one request. Neither changes the active chat model.

## Side Effects
- Filesystem: reads local input images and writes generated output images to `omp-image-<snowflake>.<ext>` files under the OS temporary directory.
- Network: sends prompts and optional images to the selected image provider. OpenRouter/xAI image URLs in responses are downloaded before saving.
- Session state: reads active model, session id, cwd, credentials, `providers.imageOrder`, `providers.imageOpenRouterModel`, Antigravity endpoint settings, and optional injected `fetch`.
- Background work / cancellation: provider calls use the caller abort signal combined with a 3 minute timeout.

## Limits & Caps
- Local path inputs are capped at `35 * 1024 * 1024` bytes (`MAX_IMAGE_SIZE`). Inline base64 inputs have no separate tool-level size cap.
- A path input must exist and have a supported content-sniffed image type. Each input object must contain `path` or `data`; `path` wins when both are present.
- Raw base64 `data` requires `mime_type`; a data URL supplies its own MIME type.
- Provider timeout is `3 * 60 * 1000` ms.
- OpenAI hosted output is requested as WebP. Other response files use MIME-derived extensions (`png`, `jpg`, `gif`, `webp`, or `svg`). Unknown MIME types fall back to `.png`. Image endpoint responses prefer declared image MIME types, then byte detection. SVG output does not imply support for SVG local-file inputs.
- Common aspect ratios are `1:1`, `3:4`, `4:3`, `9:16`, and `16:9`. xAI also accepts `3:2` and `2:3`. OpenRouter validates any tool-supported ratio against the selected model's endpoints.
- `image_size` accepts `1024x1024`, `1536x1024`, and `1024x1536`. On xAI these map to `1k`, `2k`, and `2k`; omission defaults to `1k`.
- xAI edit requests accept at most 3 input images.
- OpenRouter accepts at most 16 references, subject to each endpoint's advertised bounds. Some models require references or do not accept them.
- OpenRouter forwards `image_size` as `size`, including when the endpoint metadata has no `size` capability. If supplied together, both size and ratio reach the API. Conflicting dimensions can produce an upstream HTTP error.

## Errors
- No usable provider credentials: `No image API credentials found...`; the message lists supported login/API-key routes.
- Invalid input: file not found, file over 35 MiB, unsupported content-sniffed image type, missing `path`/`data`, empty image data, or raw base64 without `mime_type`.
- OpenAI path without a compatible GPT model: `Missing active GPT model for OpenAI image generation`.
- Antigravity credentials without `projectId`: `Missing projectId in antigravity credentials`.
- More than three xAI edit references: `xAI image edits accept up to 3 reference images...`.
- A `3:2` or `2:3` request fails if no usable xAI or supporting OpenRouter route is reached.
- Blank per-call models and conflicting `model`/`provider` arguments fail before credential lookup or input-file reads.
- Explicit OpenRouter selections report model-specific credential, availability, and HTTP failures without trying another model or provider.
- Unsupported OpenRouter options report the requested ratio/reference count and advertised constraints before generation. Change the options or model deliberately before retrying. Invalid metadata, no available endpoints, or inability to restrict routing safely also fail.
- Other credentialed provider HTTP failures fall through to later providers. If every such provider fails, the tool throws an `AggregateError` naming all attempted providers and containing their provider-specific HTTP errors.
- Cancellation, the three-minute timeout, malformed provider responses, and local I/O errors throw directly.

## Notes
- The tool is a custom tool, not a built-in `AgentTool` class, so its root docs live here even though the model-facing prompt is in `src/prompts/tools/image-gen.md`.
- Multiple input images should be named in `subject` as `Image 1`, `Image 2`, etc. so the provider receives unambiguous edit instructions.
