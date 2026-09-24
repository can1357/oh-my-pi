# generate_image

> Generate or edit images and write generated image files to temporary paths.

## Source
- Entry: `packages/coding-agent/src/tools/image-gen.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/image-gen.md`
- Session injection: `packages/coding-agent/src/sdk.ts` (`getImageGenTools()`)

The custom tool is registered only when `generate_image.enabled=true` (default `false`) and the session's explicit tool filter, if any, requests `generate_image`. Toggling the setting registers or removes it in the running session.

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
| `image_size` | `"1024x1024" \| "1536x1024" \| "1024x1536"` | No | Requested output size where the selected model transport supports it. |
| `input` | `Array<{ path?: string; data?: string; mime_type?: string }>` | No | Input images by local path or inline base64 data. |
| `model` | `string` | No | Image-model selector for this request, for example `openrouter/google/gemini-3-pro-image` or `xai/grok-imagine-image`. When omitted, the configured `image` role chain is used. |

## Outputs
- Success with image data:
  - `content[0].type = "text"`
  - `content[0].text` summarizes provider/model and saved image paths.
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, revisedPrompt?, promptFeedback?, usage? }`
- Model responses with no image data return `imageCount: 0`, empty `imagePaths` / `images`, and any provider text/feedback available.

## Flow
1. The SDK injects `generate_image` as a custom tool via `getImageGenTools()` only when the feature gate and tool filter allow it.
2. A request with `model` resolves that selector against available catalog models of kind `image` and attempts only the selected model. Without `model`, the tool resolves `modelRoles.image` followed by `retry.fallbackChains.image`; when no fallback chain is configured, the built-in image defaults apply, while `retry.fallbackChains.image: []` disables fallbacks. The active session provider is hoisted only among non-explicit built-in candidates.
3. The tool skips candidates with an unsupported API transport, unavailable credentials, or an unavailable hosted carrier. A provider HTTP failure advances to the next model in the resolved chain; validation, parsing, local I/O, cancellation, and timeout failures do not.
4. Input images are resolved once, after the first usable model is found. A `path` is resolved relative to session cwd and content-sniffed. Inline `data` may be raw base64 (requiring `mime_type`) or a `data:<mime>;base64,...` URL.
5. The selected catalog model's `api` determines the transport:
   - `openai-images`: OpenAI-compatible `/images/generations` and `/images/edits` requests. This carries xAI Grok Imagine and DeepInfra image models; a `404` from the edit endpoint retries the generation endpoint with the edit payload.
   - `openrouter-images`: OpenRouter's native `/images` endpoint. It does not use OpenRouter chat completions. The selected OpenRouter image model ID is sent directly, for example `openrouter/google/gemini-3-pro-image`.
   - `google-generative-ai`: Gemini `:generateContent` with `responseModalities: ["IMAGE"]`.
   - `google-gemini-cli`: Google Antigravity's internal SSE image endpoint, using the account-advertised image model when discovery provides one.
   - `openai-responses`: OpenAI hosted Responses image generation.
   - `openai-codex-responses`: ChatGPT/Codex hosted Responses image generation through a connected subscription.
6. Hosted OpenAI transports separate the selected image model from the chat carrier that invokes the Responses `image_generation` tool. The carrier must be a compatible GPT/o3 Responses model from the same provider. The active session model is used only when it is such a carrier for that provider; otherwise the registry selects a compatible hosted carrier. OpenAI API-key requests include the selected image model in the image tool. Codex requests use the selected Codex image catalog entry with the subscription backend's hosted image tool and do not borrow the active model from another provider.
7. Inline images in a successful response are saved to temporary files; paths and base64/MIME image metadata are returned. A response with no image data returns a normal zero-image result rather than `isError`.

## Modes / Variants
- Text-to-image: provide `subject` and optional style/composition fields, no `input`.
- Image edit: provide one or more `input` images plus `changes` and a subject that identifies each image role.
- Text rendering: use `text`; the prompt instructs callers to request sharp, legible, correctly spelled short text.
- Model selection: set `model` to pin one available image catalog model for the request. Omit it to use the `image` role and its fallback chain.

## Side Effects
- Filesystem: reads local input images and writes generated output images to `omp-image-<snowflake>.<ext>` files under the OS temporary directory.
- Network: sends prompts and optional images through the selected catalog model's API transport. OpenRouter/xAI image URLs in responses are downloaded before saving.
- Session state: reads the active model, session id, cwd, credentials, `modelRoles.image`, `retry.fallbackChains.image`, Antigravity endpoint settings, and optional injected `fetch`.
- Background work / cancellation: provider calls use the caller abort signal combined with a 3 minute timeout.

## Limits & Caps
- Local path inputs are capped at `35 * 1024 * 1024` bytes (`MAX_IMAGE_SIZE`). Inline base64 inputs have no separate tool-level size cap.
- A path input must exist and have a supported content-sniffed image type. Each input object must contain `path` or `data`; `path` wins when both are present.
- Raw base64 `data` requires `mime_type`; a data URL supplies its own MIME type.
- Request timeout is `3 * 60 * 1000` ms.
- OpenAI hosted output is requested as WebP. Other response files use MIME-derived extensions (`png`, `jpg`, `gif`, or `webp`; unknown MIME types fall back to `.png`).
- The schema accepts `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, `3:2`, and `2:3`; upstream support depends on the selected model transport. xAI accepts the two additional landscape/portrait ratios `3:2` and `2:3`.
- `image_size` accepts `1024x1024`, `1536x1024`, and `1024x1536`. On xAI these map to `1k`, `2k`, and `2k`; omission defaults to `1k`.
- xAI edit requests accept at most 3 input images.

## Errors
- No usable model in the resolved chain: the aggregate error lists attempted models and candidates skipped for unsupported transports, unavailable credentials, invalid credentials, or unavailable hosted carriers.
- Invalid input: file not found, file over 35 MiB, unsupported content-sniffed image type, missing `path`/`data`, empty image data, or raw base64 without `mime_type`.
- Hosted OpenAI image models without a compatible same-provider GPT/o3 carrier are skipped as `hosted chat carrier unavailable`.
- Antigravity credentials that do not contain both an access token and `projectId` cause that candidate to be skipped as `invalid credentials`.
- More than three xAI edit references: `xAI image edits accept up to 3 reference images...`.
- Credentialed model HTTP failures fall through to later candidates in the image chain. If every candidate fails or is skipped, the tool throws an `AggregateError` naming the attempted models and containing collected provider HTTP errors.
- Cancellation, the three-minute timeout, malformed provider responses, and local I/O errors throw directly.

## Notes
- The tool is a custom tool, not a built-in `AgentTool` class, so its root docs live here even though the model-facing prompt is in `src/prompts/tools/image-gen.md`.
- Multiple input images should be named in `subject` as `Image 1`, `Image 2`, etc. so the provider receives unambiguous edit instructions.
