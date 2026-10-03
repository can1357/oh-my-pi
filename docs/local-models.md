# Local Model Catalog and Experiments

This document covers the on-device models in the `local` catalog and records the tiny-model experiments behind the shipped title and memory recommendations. Model selection is role-based: use `modelRoles.<role>` for the primary selector and `retry.fallbackChains.<role>` for ordered alternatives. Catalog entries are authored in `packages/catalog/src/compat/rules/providers/local.kdl`; text model exports live in `packages/coding-agent/src/tiny/models.ts`. Benchmark timings below are historical measurements, not current-runtime guarantees.

```yaml
modelRoles:
  tiny: local/lfm2.5-230m
  memory: local/lfm2-1.2b
  speech: local/kokoro
  dictation: local/parakeet-tdt-0.6b-v3
  # A local tiny model may also serve typed judgments:
  judge: local/lfm2-1.2b

retry:
  fallbackChains:
    tiny: []
    memory: []
    speech: []
    dictation: []
    judge: []
```

An explicit empty chain keeps each workload local. Leaving a model-kind chain unset instead uses that role's built-in priority list. The `default` fallback chain does not apply to `speech`, `dictation`, or `judge`.

Inspect the catalog with `omp models --kind tiny`, `omp models --kind tts`, and `omp models --kind stt`. Download tiny models with `omp tiny-models list`, `omp tiny-models download <model-id>`, or `omp tiny-models download all`. Run `omp setup speech` to choose, persist, and download the local speech and dictation models selected by their roles.

The tiny-model CLI and source registry retain **title** and **memory** groupings because those are the workloads used to benchmark and recommend model sizes. They are not runtime model classes: every entry in both groups has catalog kind `tiny`, and any compatible entry can be assigned to `tiny`, `memory`, or `judge`. Choose based on quality and resource needs rather than the CLI grouping alone.

## Runtime / environment findings

- **Text/Whisper stack**: `@huggingface/transformers` (transformers.js) v4 running in a Bun
  worker, using the native `onnxruntime-node` backend by default. Kokoro uses a separate
  `kokoro-js` side runtime in an isolated worker; Parakeet uses `sherpa-onnx-node`.
- **Non-FHS distros (NixOS, and any host without `libstdc++.so.6` on the loader path)**: the
  on-demand `onnxruntime-node` / `sherpa-onnx-node` / `sharp` addons are prebuilt binaries that
  `dlopen` `libstdc++.so.6` and `libgcc_s.so.1`, and they carry their own `DT_RUNPATH`, so nothing in
  the omp executable's own RPATH can resolve them. Set `OMP_NATIVE_LIBRARY_PATH` to the
  colon-separated directories holding those libraries; omp appends it to `LD_LIBRARY_PATH` for the
  inference worker subprocesses only (never for shell/eval/daemon children). The Nix package
  (`nix/package.nix`) sets this by default.
- **One text worker per model/backend, keep-alive not persistent**: each tiny text model/backend
  pair is served by one machine-wide worker owning
  `~/.omp/run/tiny/<model>-<backend>.sock` (Windows: a named pipe).
  ONNX and MLX workers for the same model can coexist. The first omp process that needs
  the pair spawns it detached (log next to the socket, `<model>-<backend>.log`);
  other omp processes connect, so weights are not duplicated per omp instance.
  Nothing supervises it: the worker exits on its own
  after 15 minutes without a request (`OMP_TINY_WORKER_IDLE_MS` overrides the window for tests),
  unlinks its socket, and the next request from any omp process spawns a fresh one. Concurrent
  spawns race on a `.bind.lock` file lock: the loser sees a live socket and exits while its parent
  adopts the winner. `ping` returns a launch tag (`<omp version>|onnx|<device>|<dtype>` or
  `mlx|<mlx-lm version>|<script crc>`), so an omp upgrade or a changed
  `providers.tinyModelDevice`/`providers.tinyModelDtype` replaces a stale ONNX worker;
  MLX replacement follows its runtime version/script tag. Concurrent ONNX clients with
  conflicting device/dtype settings can replace each other's worker, so agree on those settings.
  The protocol is message-level (`load`, `chat` with messages / prefill /
  stop / max tokens); prompt construction and title extraction live in the client so both worker
  kinds are interchangeable.
- **Device policy**: local tiny models default to CPU-only inference and retry once on CPU if an
  explicit accelerated provider cannot initialize.
  - Pick a provider persistently with the `providers.tinyModelDevice` setting (`default` keeps CPU),
    or per-run with the `PI_TINY_DEVICE` env var (which overrides the setting).
  - Accepted values are `cpu`, `gpu`, `mlx`/`metal`, `webgpu`, `auto`, `cuda`, `dml`, `coreml`,
    `wasm`, `webnn`, `webnn-gpu`, `webnn-cpu`, and `webnn-npu`.
  - Direct `coreml` remains opt-in via `PI_TINY_DEVICE=coreml`; it is not part of the default because
    cached decoder-LLM ONNX loads can fail during session initialization.
  - WebGPU/Metal works for the single-process eval harness, but the production worker forces
    Darwin `gpu`/`webgpu`/`auto` requests back to CPU because ONNX Runtime/Bun currently
    hard-crashes on worker teardown after WebGPU inference.
  - Use `providers.tinyModelDevice` or `PI_TINY_DEVICE` only when explicitly opting out of the CPU
    default.
- **MLX backend (Apple silicon)**: `PI_TINY_DEVICE=mlx` (or `metal`) swaps the worker itself, not
  the ONNX provider: the per-model worker is `mlx-server.py` running from a pinned `mlx-lm` venv
  that omp installs under `~/.omp/agent/cache/tiny-mlx-runtime/` on first use (via `uv`, else
  `python3 -m venv` with Python ≥ 3.10). It downloads the model's pre-quantized 4-bit MLX export
  (`mlxRepo` in the registry) into `~/.omp/agent/cache/tiny-models/mlx/` with per-byte progress,
  loads it with `mlx_lm.load`, and speaks the exact protocol the ONNX worker speaks, so titles,
  memory completions, and local typed judgments use the same backend. Inference runs in the
  Python worker. `PI_TINY_DTYPE` is ignored by MLX. If the venv bootstrap fails (no Python,
  install error, non-Apple host) omp logs a warning and uses the ONNX CPU worker for the rest of
  the process. Measured on an M4 Max: cold venv install + LFM2.5-230M download + load 15.7s; a
  second omp instance attaches to a running worker in well under a second; titles 15–60ms after
  warmup; Qwen3-1.7B (blocked on onnxruntime-node) downloads 984MB and answers a memory
  extraction in ~200ms.
- **Quantization: q4 is the sweet spot** — smaller on disk, faster to load, and fast at inference.
  q8/int8 loads slower _and_ infers slower on CPU. Every shipped model defaults to `q4`; override the
  precision persistently with the `providers.tinyModelDtype` setting (`default` keeps `q4`, e.g. `fp16`
  for higher fidelity), or per-run with `PI_TINY_DTYPE` (which overrides the setting). Accepts `auto`,
  `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16`; an
  unrecognized value fails loudly at worker startup.
- **Load-time correction (important).** An earlier belief that "q4 >=1B models take minutes to load"
  was a **measurement artifact** caused by running ~5 multi-GB HuggingFace downloads in parallel
  (I/O saturation). Clean, isolated **warm** loads are all sub-3s:
  - TinyLlama-1.1B q4: ~0.5s
  - Llama-3.2-1B q4: ~2.8s (`graphOpt=all`) / ~0.5s (`disabled`)
  - LFM2-1.2B q4: ~0.36s
  - Qwen2.5-1.5B q4: ~1.5s
  - Qwen3-1.7B q4: ~1.6s
  - gemma-3-1b q4: ~1.1s
  - Conclusion: **1B–1.7B models are viable on CPU.**
- **`session_options.graphOptimizationLevel`** trades load vs inference speed: `disabled` = fastest
  load, slightly slower inference; `all` = default.
- **First run** downloads weights from the HF Hub to a cache dir (q4 weights ~150MB–1.1GB depending
  on model); subsequent **warm** loads are sub-second to ~3s. Inference is async and
  background-friendly for memory tasks; titles are semi-interactive.

## Task 1: Session title generation (`modelRoles.tiny`)

**Task**: turn the first user message into a 3–7 word title. Tiny models (sub-1B) suffice.

**Winning recipe**:

- Plain system prompt (no few-shot).
- **Prefill** the assistant turn with `<title>` and **stop at `</title>`**, then take the first line.
- Greedy decoding (`do_sample:false`), `enable_thinking:false` in the chat template.

**What we learned**:

- **Few-shot examples contaminate sub-0.6B titles** with copied example subjects. The current
  local title system prompt contains no examples.
- **Casing instructions become output** on the smallest models. [`normalizeGeneratedTitle`](../packages/coding-agent/src/tiny/text.ts)
  reconciles casing after generation, so the prompt omits that rule.
- **Token biasing (`bad_words_ids`) is a confirmed no-op** here — the prefill already controls the
  opener.

**Replacement benchmark** (30 recent first-session prompts, q4 CPU, no examples):

| Model              | Cache | Warm mean / p95 | 3–7 words | Observed tradeoff                               |
| ------------------ | ----: | --------------: | ----------: | ----------------------------------------------- |
| LFM2.5-230M        | 214MB |      93 / 194ms |       21/28 | Best semantic balance; occasional generic title |
| Falcon-H1-Tiny-90M | 147MB |     117 / 174ms |       17/29 | Smallest; lower fidelity on complex inputs       |
| LFM2.5-350M        | 292MB |     166 / 266ms |        4/30 | Aggressively terse, often a one-word label       |

**Shipped local options**: `lfm2.5-230m`, `lfm2.5-350m`, `falcon-h1-90m`.
When `modelRoles.tiny` is unset, title generation resolves its built-in online role path; no local weights are downloaded automatically. A local primary is an explicit no-billing boundary: if its worker fails or returns no title, the session stays untitled instead of falling through to an online model. The default download for a bare `omp tiny-models` command is `lfm2.5-230m`.

## Task 2: Mnemopi memory (`modelRoles.memory`)

Mnemopi runs two small-LLM tasks:

1. **Extraction** — pull durable, structured items from a single message.
2. **Consolidation** — summarize a list of memories into 1–3 faithful sentences.

These need **bigger models than titles: 1B–1.7B**. We tested LFM2-1.2B, Qwen2.5-1.5B, Qwen3-1.7B,
and gemma-3-1b (q4, CPU) via four parallel agents each running 27–31 experiments.

### Extraction findings

The experiments exposed two problems with the stock 5-category JSON prompt:

1. The all-empty example `{"facts":[],...}` was **copied verbatim**, producing no facts.
2. Object-valued category entries previously became `[object Object]`.

The managed memory path now puts extraction instructions in a system turn and the raw
message in the user turn, for both local and online models. It requests **one plain-text
fact per line**, or exactly `NO_FACTS` for greetings and other nonpersistent content.
The current parser also accepts structured category objects with string entries or
recognized text fields; it no longer coerces arbitrary objects to strings.

### Technique polarity flips vs titles

- At 1B+, **few-shot is the dominant quality lever**: e.g. Qwen2.5-1.5B extraction F1 0.52 → 0.83
  going 1 → 3 shots; gemma recall 0.65 → 0.92 with 2 shots.
- **Prefill HURTS extraction** — it forces output on small talk, producing false positives.
- **System-split** (instructions in the system role) helps models that have a system role.
- **Greedy >= temperature** for both tasks.
- **Token biasing** is again a no-op.

### Per-model verdicts (head-to-head, 16-fixture set)

- **Qwen3-1.7B** — most disciplined extraction: returns empty on small talk, no buried-fact leak,
  preserves language, clean flat JSON. Weaknesses: coarse granularity, missed a multi-turn value
  update.
- **Qwen2.5-1.5B** — best extraction granularity (atomic facts), caught the value update, zero
  small-talk leakage. Weaknesses: weakest consolidation (run-on, no dedup) and one degenerate
  buried-fact output.
- **gemma-3-1b** — best consolidation (dedup works, faithful, clean single-memory). Weaknesses: leaks
  small talk and translated German.
- **LFM2-1.2B** — solid and fastest to load. Weaknesses: `Label: value` noise, small-talk + buried
  leaks, a fluffy single-memory summary.

### Recommendation and current availability

The experiments favored **Qwen3-1.7B** for extraction precision. Its shipped ONNX export is
disabled because `onnxruntime-node` does not support its RotaryEmbedding cache updates;
the ONNX worker rejects it before loading the runtime. It is available through the MLX
backend on Apple silicon (`providers.tinyModelDevice: mlx` or `PI_TINY_DEVICE=mlx`).
`omp tiny-models download all` skips ONNX-disabled models unless MLX is active.

Of the runnable options, `lfm2-1.2b` loads fastest and is a solid all-rounder; nothing selects it automatically.
`gemma-3-1b` favors consolidation quality, while `qwen2.5-1.5b` favors fine-grained extraction.

**Configured local options**: `llama3.2:3b`, `qwen3-1.7b` (ONNX-disabled as described above),
`gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`.
When `modelRoles.memory` is unset, it resolves through the effective `tiny` role and then the built-in smol priority list; no local weights are downloaded automatically.

### Mnemopi parser behavior

`packages/mnemopi/src/core/extraction.ts` preserves structured facts, instructions,
preferences, timelines, and knowledge-graph triples. It extracts recognized text fields
from object-valued entries rather than returning `[object Object]`. The plain-line
fallback still ignores lines of 10 characters or fewer, so a short fact such as
`Name: Can` is discarded; structured string entries do not have that length gate.

## Local speech and dictation models

The `speech` role accepts TTS catalog models and the `dictation` role accepts STT catalog models. `omp setup speech` offers the local entries accepted by those roles, persists the selected `modelRoles.speech` and `modelRoles.dictation` values, and downloads their model/runtime files.

### Text to speech

| Selector       | Repository                                | Precision | Download | Notes                                  |
| -------------- | ----------------------------------------- | --------- | -------- | -------------------------------------- |
| `local/kokoro` | `onnx-community/Kokoro-82M-v1.0-ONNX`    | q8        | ~100 MB  | 24 kHz Kokoro-82M, fully local ONNX TTS |

Kokoro voice selection remains independent of the model role. Set `tts.localVoice` for the `tts` tool and `speech.voice` for assistant-output vocalization. Available local voice ids are `af_heart` (default), `af_bella`, `af_nicole`, `af_aoede`, `af_kore`, `af_sarah`, `am_michael`, `am_fenrir`, `am_puck`, `bf_emma`, `bm_george`, and `bm_fable`. Changing voices does not download another model.

### Speech to text

Use these canonical catalog model ids:

| Selector                         | Repository                                                    | Runtime / precision | Download | Notes                                      |
| -------------------------------- | ------------------------------------------------------------- | ------------------- | -------- | ------------------------------------------ |
| `local/whisper-base`             | `onnx-community/whisper-base`                                 | transformers.js q8  | ~60 MB   | Smallest multilingual Whisper option       |
| `local/whisper-small`            | `onnx-community/whisper-small`                                | transformers.js q8  | ~190 MB  | Balanced multilingual Whisper option       |
| `local/whisper-large-v3-turbo`   | `onnx-community/whisper-large-v3-turbo`                       | transformers.js q4  | ~600 MB  | Whisper large-v3-turbo, 99 languages       |
| `local/parakeet-tdt-0.6b-v3`     | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`      | sherpa-onnx int8    | ~680 MB  | Default; fast multilingual Parakeet TDT v3 |

Kokoro and the transformers.js Whisper models read `providers.tinyModelDevice` / `PI_TINY_DEVICE` and `providers.tinyModelDtype` / `PI_TINY_DTYPE`; the default precision comes from each speech model's spec, not the text models' q4 default. Kokoro maps the device preference to its narrower CPU/WASM/WebGPU set. MLX is a text-model backend, so selecting it leaves speech inference on CPU. Parakeet uses its shipped sherpa-onnx int8 files. Keep `stt.language`, `stt.submitTrigger`, `tts.localVoice`, and the other speech/live settings for behavior; only model selection moved into roles.

## Integration notes

- Local tiny inference for title, memory, or judgment workloads is selected with a `local/<model-id>` role assignment. An unset `tiny` role stays on its online default; an unset `memory` role follows the effective `tiny` role and can therefore become local when `tiny` is local. Unset `speech` and `dictation` roles use their own built-in priority lists, whose first candidates are local.
- Local inference runs **in a worker** (off the main thread); weights are downloaded only when a local candidate is used or explicitly prefetched with `omp tiny-models` or `omp setup speech`, then cached on disk.
- Session-title generation uses `modelRoles.tiny`; Mnemopi extraction and consolidation use `modelRoles.memory` when its LLM mode is enabled. Their distinct prompts and benchmark groups do not impose separate runtime model types.
- Auto-thinking, Smart unexpected-stop detection, typed Eval judgments, and AI-assisted git staging use the `judge` role. Assign `typesafe/jev-latest` for TypeSafe or a compatible local tiny model for on-device judgment; order alternatives under `retry.fallbackChains.judge`.
- Managed memory extraction uses the shared line-format, small-talk-guarded system prompt on both local and online transports. A local primary additionally selects the local consolidation prompt. Explicit external Mnemopi endpoints remain authoritative instead of being replaced by the memory role.
