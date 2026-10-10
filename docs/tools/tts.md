# tts

> Generate a speech audio file from text using the speech model role and write it to `output_path`.

## Source
- Entry: `packages/coding-agent/src/tools/tts.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/tts.md`
- Speech role selection: `packages/coding-agent/src/config/model-resolver.ts`, `packages/coding-agent/src/priority.json`
- Cloud transports: `packages/ai/src/speech/`
- Local voice catalog: `packages/coding-agent/src/tts/models.ts`
- Local worker client: `packages/coding-agent/src/tts/tts-client.ts`
- Session injection: `packages/coding-agent/src/sdk.ts` (`speechgen.enabled`)

The SDK registers this write-approved custom tool when `speechgen.enabled=true` (default `false`), unless tool registration is restricted or a same-named tool is already registered. Live setting changes add or remove the SDK-owned entry. The tool has `strict=false`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `text` | `string` | Yes | Text to synthesize. Must be `1..15000` JavaScript string characters. |
| `voice_id` | `string` | No | Cloud voice id. xAI defaults to `eve`; OpenAI-compatible speech forwards it only when explicitly set. Local synthesis uses `tts.localVoice` instead. |
| `language` | `string` | No | Schema default `en`; currently unused by every execution path, including xAI. |
| `output_path` | `string` | Yes | Destination resolved relative to session cwd. Case-insensitive `.wav` requests WAV; any other suffix requests MP3. |
| `sample_rate` | `number.integer` | No | xAI sample-rate override. Ignored by local and OpenAI-compatible speech. |
| `bit_rate` | `number.integer` | No | xAI MP3 bit-rate override. Ignored for WAV and by local and OpenAI-compatible speech. |

## Outputs
- Success returns one text block and `details = { bytes, voiceId, codec, backend }`.
  - Cloud: `Saved <bytes> bytes to <path> (model=<provider>/<model>, voice=<voice>, codec=<codec>).`
  - Local: names the actual WAV path, `<model>/<voice>`, sample rate, and any container substitution.
  - `backend` is `"local-inference"`, `"xai-tts"`, or `"openai-speech"`.
- No matching speech model, exhaustion of missing-key/HTTP failures, or a `null` local-worker response returns `isError: true` with one text block and no `details`.
- Other exceptions, caller cancellation, and transport timeouts propagate.

## Flow
1. Resolve cwd, destination, and requested codec.
2. Build the available `tts`-kind model pool and resolve `modelRoles.speech` plus `retry.fallbackChains.speech`. When no explicit configuration is present, the priority list is `local/kokoro`, `xai/grok-tts`, `xai-oauth/grok-tts`.
3. For MP3, reorder only non-explicit candidates so cloud models precede local models. Explicit primary/fallback slots retain their positions. WAV preserves the resolved chain order.
4. Try candidates sequentially:
   - `local-inference` calls the local worker with the selected model id, `tts.localVoice`, and `tts.localSpeed`, encodes PCM16 WAV, and writes it. Per-call voice, language, sample rate, and bit rate are ignored.
   - `xai-tts` calls the selected model's `<baseUrl>/tts` through the model-registry credential resolver. It sends text and voice, and an explicit `output_format` only when WAV or non-default sample/MP3 bit rates require it.
   - `openai-speech` calls the selected model's `<baseUrl>/audio/speech` with `{ model, input, response_format, voice? }`; voice is sent only when explicitly supplied. This includes compatible providers such as DeepInfra, not just OpenAI.
5. Missing API keys and provider HTTP errors advance to the next candidate. A local `null` response returns its error immediately; other failures do not trigger fallback.

## Modes / Variants
- Local: Kokoro-82M on-device inference; always WAV/PCM16. Model weights may need downloading before local inference can run.
- xAI: Grok Voice cloud synthesis; MP3 or WAV.
- OpenAI-compatible speech: selected cloud model and endpoint; MP3 or WAV.
- Legacy `providers.tts` values (`local`, `xai`, `deepinfra`) migrate to speech-role selectors on settings load. `providers.tts` and `tts.localModel` are removed; local model selection now comes from the speech role.

## Side Effects
- Filesystem: writes the destination, or a sibling `.wav` when the chain reaches local for a non-WAV destination.
- Network: cloud synthesis calls the selected endpoint; local model loading may download/cache weights.
- Session state: reads cwd, model registry, session id, speech-role settings, `tts.localVoice`, and `tts.localSpeed`.
- Cancellation: cloud requests combine the caller signal with a 60-second timeout; local synthesis receives the caller signal.
- Streaming: single-shot; no `onUpdate` progress.

## Limits & Caps
- Text limit: `1..15_000` JavaScript string characters for every backend.
- xAI defaults: voice `eve`, sample rate `24000`, MP3 bit rate `128000`.
- Built-in xAI voices: `ara`, `eve`, `leo`, `rex`, `sal`; custom voice ids are accepted.
- Default local model: `local/kokoro` (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8).
- Default local voice: `af_heart`; the settings catalog also includes `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, and `bm_fable`.

## Errors
- Empty candidate chain: `No available speech model matches the speech role.`
- All retryable candidates failed: `Speech synthesis failed for every candidate: <provider/model>: <error>; ...`.
- Cloud HTTP errors include status and at most the first 300 characters of provider detail.
- A local worker `null` response reports the model id and possible worker/model-download issue.
- Caller cancellation, the cloud timeout, filesystem write errors, unsupported speech APIs, and thrown local-worker failures propagate rather than becoming fallback results.

## Notes
- No local MP3 encoder is bundled. A local request for `speech.mp3` writes `speech.wav` and reports the substitution.
- There is no per-call model selector. Configure the speech role and fallback chain; local voice selection remains a setting.
