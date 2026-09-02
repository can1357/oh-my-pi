---
title: Voice
description: Text-to-speech synthesis through the `omp say` command and the `tts` tool, plus the related `stt`/`tts` settings.
coverage: B
---

OMP exposes text-to-speech through a local on-device engine (Kokoro-82M) and an xAI Grok Voice cloud option, and a separate setting group `stt.*` for speech-to-text. The local backend needs no network call after model weights are cached; the cloud backend requires xAI credentials.

For realtime spoken conversation, see [Live voice](/oh-my-pi/features/live-voice/).

The `tts` tool is only registered when `speechgen.enabled` is set. The `omp say` command always uses the local backend.

## `omp say`

The CLI command synthesizes text with the local TTS engine and plays it through the speakers. It is a session-level helper, not a model tool.

```bash
omp say "hello world"
omp say --file notes.md --voice bm_fable
omp say "hello world" --out /tmp/hello.wav
```

Flags:

| Flag | Description |
| --- | --- |
| `text` (positional) | Text to speak. Mutually exclusive with `--file`. |
| `--voice` | Voice id; one of the local voice values (see [Local voices](#local-voices)). |
| `--model` | Local TTS model key. Defaults to `tts.localModel`. |
| `--file` / `-f` | Read the text to speak from this file. |
| `--out` / `-o` | Write WAV to this path instead of playing. |

Input is segmented into sentence-sized chunks and synthesized through the streaming TTS worker, so arbitrarily long text plays gaplessly instead of hitting Kokoro's single-call ~510-phoneme truncation. `--out` concatenates the streamed segments into one WAV. The first run downloads the configured local model into the worker's cache.

## The `tts` tool

The `tts` tool generates a speech audio file from text and writes it to `output_path`. It is only injected into the session by the SDK when `speechgen.enabled` is set.

Inputs:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | `string` | Yes | Text to synthesize. Must be `1..15000` chars. |
| `output_path` | `string` | Yes | Destination path, resolved relative to session cwd. |
| `voice_id` | `string` | No | Voice id. Defaults to `eve`; local backend uses `tts.localVoice` instead. |
| `language` | `string` | No | Language hint for xAI. Defaults to `en`. |
| `sample_rate` | `integer` | No | xAI sample rate override. |
| `bit_rate` | `integer` | No | xAI MP3 bit-rate override. |

On success the tool returns `Saved <bytes> bytes to <path> (voice=<voice>, codec=<codec>, backend=<backend>...).` along with `details.bytes`, `details.voiceId`, `details.codec`, and `details.backend`.

### Backend selection

`providers.tts` selects routing:

- `local` — always uses the local on-device backend; output is always WAV/PCM16.
- `xai` — always uses xAI Grok Voice; output can be MP3 or WAV.
- `auto` — prefers local, but routes an MP3 request to xAI when xAI credentials exist because only the cloud path emits MP3.

The destination suffix drives the codec: `.wav` means WAV, anything else means MP3. Local MP3 output is intentionally not bundled — a local request for `speech.mp3` writes `speech.wav` and says so in the tool result.

### xAI built-in voices

`ara`, `eve`, `leo`, `rex`, `sal`. Custom xAI voice ids are also accepted. xAI defaults: sample rate `24000`, bit rate `128000`. xAI calls have a 60-second timeout.

## Settings

The `tts.*` group controls the local synthesis configuration; `speechgen.enabled` gates the tool. The `stt.*` group exists for speech-to-text but is not documented in detail in this repository — inspect it with `omp config list` for the current keys and defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `speechgen.enabled` | — | Inject the `tts` tool into the session. |
| `providers.tts` | — | Backend selector: `local`, `xai`, or `auto`. |
| `tts.localModel` | `kokoro` (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8) | Local model key. |
| `tts.localVoice` | `af_heart` | Local voice id when the `tts` tool does not pass one. |
| `stt.*` | — | Speech-to-text configuration. See `omp config list`. |

Run `omp config list` to inspect every key in the `stt.*` and `tts.*` groups and their current values.

## Local voices

Supported local voices: `af_heart`, `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, `bm_fable`.

## Errors

- Missing xAI credentials: `No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok Subscription) or set XAI_API_KEY.`
- xAI HTTP failure: `xAI TTS failed (<status>): <detail>`.
- Local synthesis failure: an error result that names the model key and notes a possible worker or model-download issue.

## See also

- [Tools: media and desktop](/oh-my-pi/features/tools/#media-and-desktop) — `tts` and `computer` live in the same group
- [Settings](/oh-my-pi/configuration/settings/) — `tts.*` and `speechgen.enabled`
