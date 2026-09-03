# tts

> Generate a speech audio file from text and write it to `output_path`.

## Source
- Entry: `packages/coding-agent/src/tools/tts.ts`
- Local voice catalog: `packages/coding-agent/src/tts/models.ts`
- Local worker client: `packages/coding-agent/src/tts/tts-client.ts`
- Session injection: `packages/coding-agent/src/sdk.ts` (`speechgen.enabled`)

The SDK registers this write-approved custom tool only when `speechgen.enabled=true` (default `false`).

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `text` | `string` | Yes | Text to synthesize. Must be `1..15000` chars. |
| `voice_id` | `string` | No | Voice id. Defaults to `eve` on xAI; the local backend uses `tts.localVoice` instead; DeepInfra forwards it only when set (model-specific ids, server default otherwise). |
| `language` | `string` | No | Language hint for xAI. Defaults to `en`. |
| `output_path` | `string` | Yes | Destination path resolved relative to session cwd. |
| `sample_rate` | `number.integer` | No | xAI sample-rate override. Ignored by the local and DeepInfra backends. |
| `bit_rate` | `number.integer` | No | xAI MP3 bit-rate override. Ignored for WAV and by the local and DeepInfra backends. |

## Outputs
- Success:
  - `content[0].type = "text"`
  - `content[0].text = "Saved <bytes> bytes to <path> (voice=<voice>, codec=<codec>, backend=<backend>...)."`
  - `details = { bytes, voiceId, codec, backend }`
- Missing-credential (xAI or DeepInfra), cloud HTTP, and a `null` local-worker response return `isError: true` with one text block and no `details`. Other exceptions, cancellation, and timeout propagate.

## Flow
1. The SDK injects `tts` only when `speechgen.enabled` is true.
2. `output_path` is resolved relative to the session cwd. The requested codec is inferred from its case-insensitive suffix: `.wav` means WAV, anything else means MP3.
3. `providers.tts` (default `auto`) selects routing (`local` / `xai` / `deepinfra` / `auto`):
   - `local` always uses the local on-device backend.
   - `xai` always uses xAI Grok Voice; absent credentials return an error result.
   - `deepinfra` always uses DeepInfra's OpenAI-compatible speech endpoint; absent credentials return an error result.
   - `auto` prefers local, but routes an MP3 request to xAI when xAI credentials exist because only the cloud path emits MP3.
4. Local synthesis ignores per-call `voice_id`, `language`, `sample_rate`, and `bit_rate`; it uses `tts.localModel` and `tts.localVoice`, calls Kokoro-82M through the shared ONNX tiny-model worker, encodes PCM16 WAV, and writes the WAV file.
5. xAI synthesis resolves Grok Voice credentials, calls `<baseURL>/tts`, and writes the provider bytes directly. It sends an explicit `output_format` only when WAV, sample rate, or MP3 bit rate differs from xAI defaults.
6. DeepInfra synthesis resolves a DeepInfra API key, posts `{ model, input, response_format, voice? }` to `https://api.deepinfra.com/v1/openai/audio/speech` (model `hexgrad/Kokoro-82M`), and writes the provider bytes directly; `voice` is forwarded only when the caller set `voice_id`.

## Modes / Variants
- Local backend: fully on-device Kokoro-82M, no network provider call after model weights are available; output is always WAV/PCM16.
- xAI backend: Grok Voice cloud synthesis; output can be MP3 or WAV.
- DeepInfra backend: OpenAI-compatible `/audio/speech` cloud synthesis (`hexgrad/Kokoro-82M`); output can be MP3 or WAV.
- Auto backend: local unless an MP3 path plus xAI credentials requires cloud routing.

## Side Effects
- Filesystem: writes `output_path`, or a sibling `.wav` path when local synthesis receives a non-WAV destination.
- Network: xAI backend calls the configured xAI/Grok Voice HTTP endpoint; DeepInfra backend calls `api.deepinfra.com`; local backend may download/cache model weights through the tiny-model stack.
- Session state: reads cwd, model registry, and settings `providers.tts`, `tts.localModel`, and `tts.localVoice`.
- Background work / cancellation: cloud calls (xAI and DeepInfra) use a 60 s timeout; local synthesis receives the caller abort signal.
- Streaming / updates: synthesis is single-shot and does not emit `onUpdate` progress.

## Limits & Caps
- Text schema limit: `1..15_000` JavaScript string characters.
- xAI defaults: voice `eve`, language `en`, sample rate `24000`, bit rate `128000`; a non-`.wav` path requests MP3.
- DeepInfra default model: `hexgrad/Kokoro-82M`; the server default voice applies unless `voice_id` is set.
- Built-in xAI voices listed in the description: `ara`, `eve`, `leo`, `rex`, `sal`; custom xAI voice ids are accepted.
- Default local model: `kokoro` (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8).
- Default local voice: `af_heart`; supported local voices include `af_heart`, `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, and `bm_fable`.

## Errors

- Missing xAI credentials returns an error result: `No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.`
- Missing DeepInfra credentials returns an error result: `No DeepInfra credentials. Run /login → DeepInfra or set DEEPINFRA_API_KEY.`
- Cloud HTTP failures (xAI or DeepInfra) return an error result containing at most the first 300 characters of provider detail: `<xAI TTS|DeepInfra TTS> failed (<status>): <detail>`.
- A local worker `null` response returns an error result noting the model key and possible worker/model-download issue.
- Caller cancellation, the 60-second cloud timeout, filesystem write errors, and thrown local worker failures propagate rather than being wrapped in an `isError` result.

## Notes
- Local MP3 output is intentionally not bundled. A local request for `speech.mp3` writes `speech.wav` and says so in the tool result.
- `voice_id` and `language` are xAI payload fields; local voice selection comes from settings so model calls do not have to enumerate local voice ids per invocation.
