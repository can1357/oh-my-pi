# memory-eval

Retrieval benchmark harness: Mnemopi (`packages/mnemopi`) vs upstream Mnemosyne 4.0.0b4.
Everything it downloads lives under `~/.cache/omp-memory-eval/` and is never committed.

## One-time setup

```sh
C=~/.cache/omp-memory-eval

# Python environments
uv venv --python 3.13 $C/venv-engine
uv pip install --python $C/venv-engine/bin/python 'mnemosyne-memory[embeddings]==4.0.0b4' datasets pyarrow huggingface_hub
uv venv --python 3.12 $C/venv-lme
uv pip install --python $C/venv-lme/bin/python 'numpy<2'

# Pinned sources
mkdir -p $C/src && cd $C/src
git clone https://github.com/mnemosyne-oss/mnemosyne && git -C mnemosyne checkout e871f39480b9b9156faa4396162f7ec1f3b11525
git clone https://github.com/xiaowu0162/LongMemEval && git -C LongMemEval checkout 9e0b455f4ef0e2ab8f2e582289761153549043fc
```

Check: `$C/venv-engine/bin/python -c "import mnemosyne, fastembed; print(mnemosyne.__version__)"` prints `4.0.0b4`.

## Datasets

```sh
~/.cache/omp-memory-eval/venv-engine/bin/python packages/coding-agent/bench/memory-eval/py/prepare_datasets.py
```

Writes `data/beam-100k.json`, `data/beam-500k.json` and `data/lme-s.json` (pinned HF revisions, idempotent).

## Calibration against upstream (Layer 0 check 2)

Run A is upstream's own `benchmark_mnemosyne` on the first 3 BEAM 100K conversations; Run B replays it through the harness (`--protocol upstream-compat`, Mnemosyne only). `calibration-check` exits 0 only when every question's ranked contents, recall and the mean recall match.

```sh
R="bun packages/coding-agent/bench/memory-eval/run.ts"; O=~/.cache/omp-memory-eval/results
~/.cache/omp-memory-eval/venv-engine/bin/python packages/coding-agent/bench/memory-eval/py/upstream_run_a.py --out $O/calib-a.json
$R run --dataset beam-100k --engine mnemosyne --protocol upstream-compat --out $O/calib-b.json
$R calibration-check $O/calib-a.json $O/calib-b.json
```

Set `MEMORY_EVAL_DEBUG_SCORES=<file.jsonl>` for both runs to append the score, tier and id of every returned memory per question. A reordering whose scores are equal is a tie; Mnemosyne's recency decay reads the wall clock, so scores can also differ between runs by about 1e-4.

`calibration-check` can exit 1 on equal-score ties or recency near-ties; check those reorderings with `MEMORY_EVAL_DEBUG_SCORES`.

## Running

```sh
R="bun packages/coding-agent/bench/memory-eval/run.ts"; O=~/.cache/omp-memory-eval/results
$R run --dataset <beam-100k|beam-500k|lme-s|lme-s-dev> --engine <mnemopi|mnemosyne|oracle|random> --protocol <standard|fts-only|with-sleep|upstream-compat> [--cases N] [--out file]
$R diff a.json b.json
$R calibration-check calib-a.json calib-b.json
```

`run` writes `~/.cache/omp-memory-eval/results/<dataset>.<engine>.<protocol>.<time>.json` unless `--out` is given, and prints the aggregate, per-category means, `fallbackRate`, `droppedRows` and `droppedGoldRows`. `oracle` (recall must be 1) and `random` are sanity engines. `upstream-compat` runs only with `--engine mnemosyne --dataset beam-100k` (see the calibration section).

Mnemosyne also returns derived rows (`memoria`, `memoria_source`, `associative`, `fact`). They are not ranked (the spec ranks working and episodic rows), but every one is recorded per question under `dropped` with its tier, rank in Mnemosyne's raw list and the message ids behind its `source_memory_id`. `droppedGoldRows` counts those that map to a gold message.

Memory: Mnemosyne's baseline and peak resident set size come from the engine process's own `/proc/self/status` (`VmRSS` after imports, `VmHWM`; Linux only). Mnemopi and the sanity engines run in the harness process and report its RSS (`rssScope: "harness-process"`).

### Comparing two runs

`diff a.json b.json` prints both configs (engine, protocol, k, git commit) and a paired bootstrap of the primary metric, where every difference is **b − a**. It exits 1 unless both files have the same dataset, protocol, `k` and question ids (no duplicates), a finite primary metric on every question, and are not `upstream-compat` results.

### Environment guard

Mnemopi runs in the harness process and reads its configuration from the environment, so `run --engine mnemopi` refuses to start while any `MNEMOPI_*` or `OPENROUTER_BASE_URL` (which can route its embeddings to an API) is set. Mnemosyne's child process never inherits the parent's `MNEMOSYNE_*`.

Never run real engines under `bun test`: with `NODE_ENV=test` Mnemopi's local embeddings are disabled. The tests use fakes and stub engine scripts.

## LongMemEval check against the official evaluator (Layer 0 check 4)

```sh
V=~/.cache/omp-memory-eval/venv-lme/bin/python; P=packages/coding-agent/bench/memory-eval/py
$R run --dataset lme-s-dev --engine oracle --protocol standard --out $O/lme-oracle.json
$V $P/lme_official_check.py $O/lme-oracle.json                      # exit 0 iff every metric matches within 1e-12
$V $P/lme_official_check.py $O/lme-oracle.json --oracle-from-cases  # official oracle ranking on our loaded cases
```

## LongMemEval dev subset

`lme-dev-subset.json` holds the 100 question ids behind `--dataset lme-s-dev`. Regenerate it (deterministic) with `~/.cache/omp-memory-eval/venv-engine/bin/python packages/coding-agent/bench/memory-eval/py/make_dev_subset.py`.

## Embedding parity (Layer 0)

Mnemopi and Mnemosyne must embed alike. Embed 50 BEAM messages with fastembed, then embed the same texts through Mnemopi and compare; the second step exits 1 if any cosine is below 0.99.

```sh
~/.cache/omp-memory-eval/venv-engine/bin/python packages/coding-agent/bench/memory-eval/py/embed_parity.py
bun packages/coding-agent/bench/memory-eval/embed-parity.ts ~/.cache/omp-memory-eval/parity-py.json
```
