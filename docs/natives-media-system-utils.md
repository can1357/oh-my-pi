# Natives media + system utilities

This document covers the media/system/conversion exports in `@oh-my-pi/pi-natives`: audio capture/playback and live WebRTC media, terminal SIXEL conversion, SVG rasterization, snapcompact PNG rendering, HTML/PDF conversion, clipboard access, token counting, DeviceCheck, macOS appearance/power helpers, and work profiling.

## Implementation files

- `crates/pi-natives/src/audio.rs`
- `crates/pi-natives/src/live.rs`
- `crates/pi-voice/src/audio.rs` and `crates/pi-voice/src/live.rs` (media engines behind the N-API adapters)
- `crates/pi-natives/src/snapcompact.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/svg.rs`
- `crates/pi-natives/src/pdf.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/tokens.rs`
- `crates/pi-natives/src/utok/` (embedded tokenizer implementation and vocabularies)
- `crates/pi-natives/src/devicecheck.rs`
- `crates/pi-natives/src/appearance.rs`
- `crates/pi-natives/src/power.rs`
- `crates/pi-natives/src/prof.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

There is no native `PhotonImage` class or `image.rs` in the addon. General-purpose image processing stays in `Bun.Image`; the native image surface supplies SIXEL encoding/decoding, bounded SVG rasterization, and snapcompact frame rendering. Filesystem isolation is a separate subsystem.

## JS API ↔ Rust export/module mapping

| JS export                                | Rust N-API export              | Rust module      |
| ---------------------------------------- | ------------------------------ | ---------------- |
| `new AudioCapture(sampleRate, cb)`       | `AudioCapture`                 | `audio.rs`       |
| `new AudioPlayback(sampleRate)`          | `AudioPlayback`                | `audio.rs`       |
| `new LiveWebRtcPeer(...)`                | `LiveWebRtcPeer`               | `live.rs`        |
| `encodeSixel(bytes, width, height)`      | `encode_sixel`                 | `sixel.rs`       |
| `decodeSixelToPng(bytes)`                | `decode_sixel_to_png`          | `sixel.rs`       |
| `rasterizeSvg(bytes, maxWidth, maxHeight)` | `rasterize_svg`               | `svg.rs`         |
| `pdfToMarkdown(bytes)`                   | `pdf_to_markdown`              | `pdf.rs`         |
| `renderSnapcompactPng(text, options)`    | `render_snapcompact_png`       | `snapcompact.rs` |
| `snapcompactSupportedChars(font, chars)` | `snapcompact_supported_chars`  | `snapcompact.rs` |
| `htmlToMarkdown(html, options?)`         | `html_to_markdown`             | `html.rs`        |
| `copyToClipboard(text)`                  | `copy_to_clipboard`            | `clipboard.rs`   |
| `readImageFromClipboard()`               | `read_image_from_clipboard`    | `clipboard.rs`   |
| `countTokens(input, encoding?)`          | `count_tokens`                 | `tokens.rs`      |
| `detectMacOSAppearance()`                | `detect_macos_appearance`      | `appearance.rs`  |
| `MacAppearanceObserver.start(cb)`        | `MacAppearanceObserver::start` | `appearance.rs`  |
| `PowerAssertion.start(options?)`         | `PowerAssertion::start`        | `power.rs`       |
| `getWorkProfile(lastSeconds)`            | `get_work_profile`             | `prof.rs`        |
| `deviceCheckGenerateToken()`             | `device_check_generate_token`  | `devicecheck.rs` |

## Data format boundaries and conversions

### Audio and live WebRTC

- `AudioCapture(sampleRate, callback)` opens the default microphone and delivers low-latency mono `Float32Array` PCM chunks at the requested logical rate. `stop()` immediately releases capture.
- `AudioPlayback(sampleRate)` opens the default speaker. `write(samples)` queues mono `Float32Array` PCM in order; `setGain(gain)` changes render-time gain even for queued samples; `end()` drains and closes, while `stop()` discards queued audio immediately.
- `LiveWebRtcPeer(onEvent, onLevel, onFailure)` owns a WebRTC peer for Codex live media. `createOffer()` returns SDP, `acceptAnswer(sdp)` applies the remote answer, and `waitForOpen(timeoutMs?)` waits for the `oai-events` data channel (default 20 seconds). `pushAudio(samples)` accepts 16 kHz mono PCM with a bounded queue; muted input and input that would overflow the queue are dropped. `setMuted()` controls transmission and discards partial muted frames; `close()` asynchronously tears down media, data channel, peer, and playback.
- The N-API modules adapt callbacks/buffers; device discovery, conversion, playback, WebRTC, and Opus media live in `pi-voice`. The TypeScript host owns authenticated signaling and sideband protocol handling.

### SIXEL image encoding (`sixel`)

- **JS input boundary**: `Uint8Array` containing encoded image bytes.
- **Rust decode boundary**: format is guessed with `ImageReader::with_guessed_format()`, then decoded to `DynamicImage`.
- **Resize boundary**: image is resized with `resize_exact(..., FilterType::Lanczos3)` only when source dimensions differ from `targetWidthPx`/`targetHeightPx`.
- **Output boundary**: `encodeSixel(...)` returns a SIXEL escape string synchronously.

The configured `image` features enable PNG, JPEG, WebP, GIF, and BMP decoding. Invalid target dimensions (`0` width or height) fail with `Target SIXEL dimensions must be greater than zero`.

`decodeSixelToPng(bytes)` synchronously converts one SIXEL control string into PNG bytes. It preflights raster declarations, repeats, and row advances before decoding, then checks the decoded dimensions again. Limits are 20 MiB input/output, 8192 pixels per edge, and 4,194,304 decoded pixels; malformed or oversized input throws.

### SVG rasterization

`rasterizeSvg(bytes, maxWidthPx, maxHeightPx)` accepts SVG/SVGZ and returns PNG bytes from `task::blocking("svg.rasterize", (), ...)`. It preserves aspect ratio, never upscales, and fits the intrinsic image within the supplied bounds. Bounds must be positive and their product must not exceed 16,777,216 pixels. File-backed image references are disabled; embedded data URLs remain supported. System fonts are loaded once. Invalid input, allocation, and PNG encoding failures reject; there is no timeout/signal option.

### PDF conversion

`pdfToMarkdown(bytes)` copies the input before dispatching `task::blocking("pdf.to_markdown", (), ...)`. `pdf-inspector` extracts Markdown with page numbers and returns `{ markdown, title?, pageCount, pagesNeedingOcr, hasEncodingIssues }`. OCR page numbers are one-indexed; the function reports pages needing OCR rather than performing OCR. Missing Markdown is accepted as an empty string only when OCR pages were identified; otherwise it rejects. Parse/conversion errors reject with `PDF conversion failed: ...`; there is no timeout/signal option.

### Snapcompact PNG rendering

`renderSnapcompactPng(text, options)` renders pre-normalized text on a bounded bitmap and asynchronously returns a **base64-encoded PNG string**. The N-API transport type is `Latin1String`, but the string contains base64 text rather than raw one-byte PNG data; base64-decode it before treating the result as PNG bytes. `options.size` is required and must be `1..16384`; optional controls include `font`, `cellWidth`, `cellHeight`, `variant`, `lineRepeat`, `stretch`, and `columns`. Fonts are `"5x8"` (default), `"6x12"`, `"8x13"`, `"8x8"`, and `"silver"`; variants are `"sent"` (default) and `"bw"`; columns are `1` (default) or `2`. Output height hugs used rows and overflowing input is ignored. `U+000E`/`U+000F` toggle dim-gray ink without consuming cells. `snapcompactSupportedChars(font, chars)` preserves supported glyphs and renderer control characters.

### HTML conversion (`html`)

- **JS input boundary**: HTML `string` + optional `{ cleanContent?: boolean; skipImages?: boolean }`.
- **Rust conversion boundary**: conversion is scheduled through `task::blocking("html_to_markdown", (), ...)`; there is no timeout/abort option on this export.
- **Output boundary**: Markdown `string` promise.

Conversion behavior:

- `cleanContent` defaults to `false`.
- When `cleanContent=true`, preprocessing is enabled with `PreprocessingPreset::Aggressive`, `remove_navigation=true`, and `remove_forms=true`.
- `skipImages` defaults to `false` and is passed to `html_to_markdown_rs::ConversionOptions`.
- Conversion explicitly selects `TierStrategy::Tier2`. A `DepthLimitExceeded` warning is promoted to a rejection instead of returning partial Markdown.

### Clipboard (`clipboard`)

- `copyToClipboard(text)` is a synchronous native call using `arboard::Clipboard::set_text`. On Linux a single process-lifetime `Clipboard` instance is kept alive (X11/Wayland selection ownership); macOS/Windows use a transient instance per call.
- `readImageFromClipboard()` runs in `task::blocking("clipboard.read_image", (), ...)`.
- Image read returns `null`/`undefined` when `arboard` reports `ContentNotAvailable`.
- Successful image read converts clipboard RGBA data into PNG bytes and returns `{ data: Uint8Array, mimeType: "image/png" }`.
- On Windows, an operational `arboard` image-read error triggers a raw `CF_DIB` decoding fallback for bitmap layouts such as those produced by Qt screenshot tools. If fallback fails, the original image-read error is retained.
- Clipboard access or image encoding failures reject/throw as native errors.

There is no current `packages/natives` TS wrapper that emits OSC52, handles Termux, or suppresses native clipboard failures. Any best-effort clipboard policy must live in consumers.

### Tokens (`tokens`)

- `countTokens(input, encoding?)` accepts a single string or an array of strings.
- Arrays return one aggregate token count. Batches of at least 16 strings use Rayon when the global pool is available; smaller batches count serially.
- Default encoding is `O200kBase`. Other exports are `Cl100kBase`, `ClaudeV3`, `ClaudeV47`, `ClaudeV5`, `ClaudeV5Sonnet`, `Qwen3`, `DeepSeekV3`, `KimiK2`, `Glm5`, and `Jev`.
- `tokens.rs` dispatches to the embedded `utok` tokenizer using JS UTF-16 input directly. Vocabularies are decoded on first use and reused.
- Counts measure content, not wire-protocol framing. BPE encodings use ordinary encoding without special-token handling; Claude counts exclude fixed per-message frames.

### DeviceCheck

`deviceCheckGenerateToken()` runs on the blocking pool and returns `{ supported, tokenBase64?, error?, latencyMs }`. On macOS, the token callback wait is capped at one second; this is not an end-to-end promise deadline. The helper requires a GUI login session before calling DeviceCheck. Unsupported platforms return `{ supported: false, latencyMs: 0 }`; unsupported devices and generation failures are reported in the result rather than requiring a token to be present.

### macOS appearance and cross-platform power helpers

- `detectMacOSAppearance()` returns `"dark"`, `"light"`, or `null` on non-macOS.
- `MacAppearanceObserver.start(callback)` returns a handle with `stop()`; on macOS it reports the initial appearance, then changes via distributed notifications plus a 2-second polling fallback, deduplicating repeated values. On non-macOS it is a no-op observer.
- `PowerAssertion.start(options?)` returns a handle with idempotent `stop()` and drop-time release. It uses IOKit on macOS, login1 inhibition on Linux (plus best-effort ScreenSaver inhibition for `display`), and thread-affine execution state on Windows. Unsupported platforms receive a no-op handle.
- Options are `{ reason?, idle?, system?, user?, display? }`; the default reason is `"omp agent session"`. If no boolean is true, idle-sleep prevention is enabled even when `idle: false` was supplied. `user` is macOS-only. Linux login1 failures reject, while display-inhibitor failures are soft.

### Work profiling (`prof`)

- **Collection boundary**: profiling samples are produced by `profile_region(tag)` guards, including those in `task::blocking`, `task::blocking_mapped`, and `task::future`.
- **Storage format**: fixed-size circular buffer (`MAX_SAMPLES = 10_000`) storing stack path, duration, and timestamp.
- **Output boundary**: `getWorkProfile(lastSeconds)` returns:
  - `folded`: folded-stack text (flamegraph input)
  - `summary`: markdown table summary
  - `svg`: optional flamegraph SVG
  - `totalMs`, `sampleCount`

## Lifecycle and state transitions

### SIXEL lifecycle

1. `encodeSixel(bytes, targetWidthPx, targetHeightPx)` validates target dimensions.
2. Rust guesses and decodes the encoded image.
3. Image is resized exactly to the target dimensions when needed.
4. Pixels are converted to RGBA8 and encoded with `icy_sixel::sixel_encode`.
5. The SIXEL escape string is returned synchronously.

Failure transitions:

- Format detection/decode failure throws.
- Invalid target dimensions throw.
- SIXEL encoding failure throws with `Failed to encode SIXEL: ...`.

### HTML lifecycle

1. `htmlToMarkdown(html, options)` schedules a blocking conversion task.
2. Conversion runs with defaulted options (`cleanContent=false`, `skipImages=false`) unless specified.
3. The upstream converter owns normalization and preprocessing. Native code rejects conversion errors and `DepthLimitExceeded` warnings rather than accepting partial Markdown.
4. Returns markdown string or rejects with `Conversion error: ...`.

### Clipboard lifecycle

- Text copy calls `set_text` synchronously; macOS/Windows construct a transient `arboard::Clipboard` per call, while Linux initializes one process-lifetime instance on first copy and reuses it.
- Image read constructs an `arboard::Clipboard`, calls `get_image`, encodes PNG on success, maps `ContentNotAvailable` to `None`, and tries the Windows raw-DIB fallback before rejecting other image-read errors.

### Work profiling lifecycle

1. No explicit start: profiling is active when task helpers execute.
2. Every instrumented task scope records one sample on guard drop.
3. Samples overwrite oldest entries after buffer capacity is reached.
4. `getWorkProfile(lastSeconds)` reads a time window and derives folded/summary/svg artifacts.

Failure transitions:

- SVG generation failure is soft (`svg` omitted/undefined), while folded and summary still return.
- Empty sample windows return empty folded data and no SVG, not an error.

## Unsupported operations and error propagation

### SIXEL

- Unsupported or corrupted image input is a strict failure.
- Invalid SIXEL target dimensions are a strict failure.
- No JS fallback path is exposed by the natives package.

### HTML

- Conversion errors are strict failures.
- Option omission is defaulting, not failure.

### Clipboard

- Text copy is strict at the native API surface.
- Image read distinguishes "no image" (`null`/`undefined`) from operational failure (rejection).

### Work profiling

- Retrieval is strict for the function call itself.
- Flamegraph SVG generation is nullable/optional.
- Buffer truncation is expected ring-buffer behavior.

## Platform caveats

- Clipboard access depends on OS/session support exposed through `arboard`.
- macOS appearance and power helpers intentionally return no-op/null behavior on unsupported platforms.
- ProjFS is not exposed by this media/system native utility surface. Isolation backend selection, including any ProjFS support, lives in the separate `iso` subsystem.
