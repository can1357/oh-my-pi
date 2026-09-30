# generate_image

> Generate or edit images and write generated image files to temporary paths.

## Source
- Entry: `packages/coding-agent/src/tools/image-gen.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/image-gen.md`
- Session injection: `packages/coding-agent/src/sdk.ts` (`imageGenTool`)
- Provider transports: `packages/ai/src/images/`
- Image role/candidate resolution: `packages/coding-agent/src/config/model-roles.ts`, `packages/coding-agent/src/config/model-resolver.ts`

The custom tool is registered only when `generate_image.enabled=true` (default `false`) and the session's explicit tool filter, if any, requests `generate_image`. Toggling the setting reconciles it in the running session; a same-named extension tool takes precedence. It requests `write` approval, is non-strict, and emits no progress updates.

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
  - `content[0].text` summarizes provider/model and saved image paths, with each image's reported size/quality when the provider returns them.
  - `details = { provider, model, imageCount, imagePaths, images, responseText?, usage? }`; each image includes base64 `data` and `mimeType`.
  - `model` is the image model the provider reports having run when it echoes one (hosted OpenAI transports), otherwise the selected catalog model id. When they differ, the text shows both, e.g. `Model: gpt-image-2-codex (catalog entry openai-codex/gpt-image-2)`. Each `images[]` entry may carry the provider-reported `size` and `quality`.
- Model responses with no image data return `No image data returned.`, `imageCount: 0`, empty `imagePaths` / `images`, and any response text/usage available. No image content blocks are returned; open the saved paths with `read`.

## Flow
1. The SDK injects `imageGenTool` as the `generate_image` custom tool only when the feature gate and tool filter allow it.
2. A request with `model` resolves that selector against available catalog models of kind `image` and attempts only the selected model. Without it, candidates are ordered as explicitly configured image-role/fallback entries, the active model's configured `imageModel` target and then the active model itself when it supports hosted images, then non-explicit role-chain defaults. Duplicate provider/model entries are removed. `retry.fallbackChains.image: []` removes fallback selectors from the role chain, but does not suppress the active model's image candidates.
3. The tool skips candidates with an unsupported API transport, unavailable credentials, or an unavailable hosted carrier. A provider HTTP failure advances to the next model in the resolved chain; validation, parsing, local I/O, cancellation, and timeout failures do not.
4. Input images are resolved once, after the first usable model is found. A `path` is resolved relative to session cwd and content-sniffed. Inline `data` may be raw base64 (requiring `mime_type`) or a `data:<mime>;base64,...` URL.
5. The selected catalog model's `api` determines the transport:
   - `openai-images`: OpenAI-compatible `/images/generations` and `/images/edits` requests, including xAI/xAI OAuth and DeepInfra. OpenAI edits use multipart image uploads; other providers use JSON references. A `404` from the edit endpoint retries the generation endpoint with the edit payload.
   - `openrouter-images`: OpenRouter's native `/images` endpoint, not chat completions. The catalog's request model id is sent directly, for example `google/gemini-3-pro-image` for selector `openrouter/google/gemini-3-pro-image`.
   - `google-generative-ai`: Gemini `:generateContent` with `responseModalities: ["IMAGE"]`.
   - `google-gemini-cli`: Google Antigravity's internal SSE image endpoint, using the account-advertised image model when discovery provides one.
   - `openai-responses`: OpenAI hosted Responses image generation.
   - `openai-codex-responses`: ChatGPT/Codex hosted Responses image generation through a connected subscription.
6. Hosted Responses transports use a model with the catalog's `hostedImage` capability as carrier. A selected hosted-capable model carries its own request; otherwise the active model is preferred only when it has that capability and the same provider, then the available same-provider carrier with the lowest input cost. For an `openai-responses` image-kind entry, the image tool names the selected image model. For Codex, or a chat model carrying its own image request, the host chooses the image model. The request always selects `image_generation` and requests WebP; a resolved size is sent for both hosted transports.
7. Inline images in a successful response are saved to temporary files; paths and base64/MIME image metadata are returned. A response with no image data returns a normal zero-image result rather than `isError`.

## Modes / Variants
- Text-to-image: provide `subject` and optional style/composition fields, no `input`.
- Image edit: provide one or more `input` images plus `changes` and a subject that identifies each image role.
- Text rendering: use `text`; the prompt instructs callers to request sharp, legible, correctly spelled short text.
- Model selection: set `model` to pin one available image catalog model for the request. Omit it to use the `image` role and its fallback chain.

## Side Effects
- Filesystem: reads local input images and writes generated output images to `omp-image-<snowflake>.<ext>` files under the OS temporary directory.
- Network: sends prompts and optional images through the selected catalog model's API transport. OpenRouter/xAI image URLs in responses are downloaded before saving.
- Session state: reads the active model and its image capabilities/target, session id, cwd, credentials, `modelRoles.image`, `retry.fallbackChains.image`, model endpoints/headers, and optional injected `fetch`.
- Background work / cancellation: provider calls use the caller abort signal combined with a 3 minute timeout.

## Limits & Caps
- Local path inputs are capped at `35 * 1024 * 1024` bytes (`MAX_IMAGE_SIZE`). Inline base64 inputs have no separate tool-level size cap.
- A path input must exist and have a supported content-sniffed image type. Each input object must contain `path` or `data`; `path` wins when both are present.
- Raw base64 `data` requires `mime_type`; a data URL supplies its own MIME type.
- Request timeout is `3 * 60 * 1000` ms.
- OpenAI hosted output is requested as WebP. Other response files use MIME-derived extensions (`png`, `jpg`, `gif`, or `webp`; unknown MIME types fall back to `.png`).
- The schema accepts `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, `3:2`, and `2:3`; upstream support depends on the selected model transport. xAI/xAI OAuth receive the ratio unchanged, defaulting to `1:1`.
- `image_size` accepts `1024x1024`, `1536x1024`, and `1024x1536`. On xAI these map to `1k`, `2k`, and `2k`; omission defaults to `1k`.
- OpenAI-compatible and hosted transports prefer explicit `image_size`; otherwise `1:1` maps to `1024x1024`, `3:4` / `9:16` to `1024x1536`, and `4:3` / `16:9` to `1536x1024`. `3:2` / `2:3` have no inferred OpenAI size. OpenRouter and Gemini receive the requested ratio/size directly. Upstream acceptance and actual dimensions remain provider-dependent.
- The ChatGPT/Codex subscription backend chooses the image model; the tool does send requested/resolved size rather than discarding it. Results report the backend-returned model, size, and quality when available.
- xAI/xAI OAuth edit requests are limited to 3 input images.

## Errors
- No usable model in the resolved chain: the aggregate error lists attempted models and candidates skipped for unsupported transports, unavailable credentials, invalid credentials, or unavailable hosted carriers.
- Invalid input: file not found, file over 35 MiB, unsupported content-sniffed image type, missing `path`/`data`, empty image data, or raw base64 without `mime_type`.
- Hosted image models without an available same-provider `hostedImage` carrier are skipped as `hosted chat carrier unavailable`; a carrier without usable credentials is skipped as `carrier credentials unavailable`.
- Antigravity credentials that do not contain both an access token and `projectId` cause that candidate to be skipped as `invalid credentials`.
- More than three xAI/xAI OAuth edit references: `<provider> image edits accept up to 3 reference images; got <N>`.
- Credentialed model HTTP failures fall through to later candidates in the image chain. If every candidate fails or is skipped, the tool throws an `AggregateError` naming the attempted models and containing collected provider HTTP errors.
- Cancellation, the three-minute timeout, malformed provider responses, and local I/O errors throw directly.

## Notes
- The tool is a custom tool, not a built-in `AgentTool` class, so its root docs live here even though the model-facing prompt is in `src/prompts/tools/image-gen.md`.
- Multiple input images should be named in `subject` as `Image 1`, `Image 2`, etc. so the provider receives unambiguous edit instructions.
