# Embedded Local Tiny-Model Experiments

This document summarizes the experiments behind the optional **local** tiny-model paths for
session-title generation (`providers.tinyModel`), Mnemopi memory extraction/consolidation
(`providers.memoryModel`), and the `auto` thinking-level difficulty classifier
(`providers.autoThinkingModel`, which uses the memory-model registry). It is a factual engineering
record for maintainers: what we measured, which recipes won, and which models we shipped. All three
settings default to `online`, so existing users incur no downloads or on-device inference cost unless
they opt in. On the online path, the configured `tiny` role is preferred and the task-specific online
fallback is used when that role is unset.

## Runtime / environment findings

- **Stack**: `@huggingface/transformers` (transformers.js) v4 running under Bun. In Bun the library
  loads the **native `onnxruntime-node` backend** (not the WASM build).
- **Non-FHS distros (NixOS, and any host without `libstdc++.so.6` on the loader path)**: the
  on-demand `onnxruntime-node` / `sherpa-onnx-node` / `sharp` addons are prebuilt binaries that
  `dlopen` `libstdc++.so.6` and `libgcc_s.so.1`, and they carry their own `DT_RUNPATH`, so nothing in
  the omp executable's own RPATH can resolve them. Set `OMP_NATIVE_LIBRARY_PATH` to the
  colon-separated directories holding those libraries; omp appends it to `LD_LIBRARY_PATH` for the
  inference worker subprocesses only (never for shell/eval/daemon children). The Nix package
  (`nix/package.nix`) sets this by default.
- **Device policy**: local tiny models default to CPU-only inference and retry once on CPU if an
  explicit accelerated provider cannot initialize.
  - Pick a provider persistently with the `providers.tinyModelDevice` setting (`default` keeps CPU),
    or per-run with the `PI_TINY_DEVICE` env var (which overrides the setting).
  - Accepted values are `cpu`, `gpu`, `metal`/`webgpu`, `auto`, `cuda`, `dml`, `coreml`, `wasm`,
    `webnn`, `webnn-gpu`, `webnn-cpu`, and `webnn-npu`.
  - Direct `coreml` remains opt-in via `PI_TINY_DEVICE=coreml`; it is not part of the default because
    cached decoder-LLM ONNX loads can fail during session initialization.
  - WebGPU/Metal works for the single-process eval harness, but the production worker forces
    Darwin `gpu`/`webgpu`/`auto` requests back to CPU because ONNX Runtime/Bun currently
    hard-crashes on worker teardown after WebGPU inference.
  - Use `providers.tinyModelDevice` or `PI_TINY_DEVICE` only when explicitly opting out of the CPU
    default.
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

## Task 1: Session title generation (`providers.tinyModel`)

**Task**: turn the first user message into a 3–7 word title. Tiny models (sub-1B) suffice.

**Winning recipe**:

- Plain system prompt (no few-shot).
- **Prefill** the assistant turn with `<title>` and **stop at `</title>`**, then take the first line.
- Greedy decoding (`do_sample:false`), `enable_thinking:false` in the chat template.

**What we learned**:

- **Few-shot examples contaminate sub-0.6B titles** with copied example subjects. The shared prompt
  gates examples off for embedded models while retaining them for capable online models.
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
**Default setting**: `online`. The default local download for `omp tiny-models` is `lfm2.5-230m`.

## Task 2: Mnemopi memory (`providers.memoryModel`)

Mnemopi runs two small-LLM tasks:

1. **Extraction** — pull durable, structured items from a single message.
2. **Consolidation** — summarize a list of memories into 1–3 faithful sentences.

These need **bigger models than titles: 1B–1.7B**. We tested LFM2-1.2B, Qwen2.5-1.5B, Qwen3-1.7B,
and gemma-3-1b (q4, CPU) via four parallel agents each running 27–31 experiments.

### Extraction findings

The stock 5-category JSON prompt fails on small models in two ways:

1. The all-empty example `{"facts":[],...}` gets **copied verbatim** → 0 facts extracted.
2. Capable models emit **JSON objects inside arrays**, which Mnemopi's `String(item)` coerces into
   the literal string `[object Object]`.

The robust fix is a **one-item-per-line output format** (consumed by Mnemopi's parser line-fallback)
or a **flat JSON array of strings**. Every model also over-extracts pure small talk; an explicit
chit-chat → NONE example is the best mitigation.

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

The experiments favored **Qwen3-1.7B** for extraction precision, but the shipped ONNX export cannot
currently run under `onnxruntime-node`: its RotaryEmbedding cache updates are unsupported. The
runtime rejects this choice before loading the model rather than failing during inference.

Of the runnable options, the registry marks `lfm2-1.2b` as the recommended local memory model.
`gemma-3-1b` favors consolidation quality, while `qwen2.5-1.5b` favors fine-grained extraction.

**Configured local options**: `llama3.2:3b`, `qwen3-1.7b` (currently disabled as described above),
`gemma-3-1b`, `qwen2.5-1.5b`, `lfm2-1.2b`.
**Default setting**: `online`.

### Known Mnemopi parser bugs (surfaced by these experiments)

- `String(item)` produces `[object Object]` on object array items.
- The line-fallback drops items `<=10` chars, so a correct short fact like `Name: Can` is discarded.

## Integration notes

- `providers.tinyModel`, `providers.memoryModel`, and `providers.autoThinkingModel` default to
  `online`, so existing users get **no downloads or on-device inference cost** unless they opt in.
- Local inference runs **in a worker** (off the main thread); models are cached on disk and
  downloaded on first use.
- The memory local path applies the refined recipes (line-format + small-talk-guarded extraction
  prompt, hardened consolidation prompt) via Mnemopi prompt overrides; the **online path is
  unchanged**.
- `providers.autoThinkingModel` uses the same shipped local options as `providers.memoryModel`.
