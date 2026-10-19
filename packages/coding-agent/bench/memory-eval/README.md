# memory-eval

Retrieval benchmark harness: Mnemopi (`packages/mnemopi`) vs upstream Mnemosyne 4.0.0b4.
Downloads default to `~/.cache/omp-memory-eval/` and are never committed, except the embedding model Mnemopi's own fastembed loads (`--embedder js`, `embed-parity.ts`): Mnemopi has no option to move it, so it shares omp's fastembed cache (`~/.omp/cache/fastembed` by default).
The setup commands below assume a POSIX shell (Linux, macOS or WSL). The CLI resolves `venv-engine/bin/python` on POSIX and `venv-engine/Scripts/python.exe` on native Windows; a native Windows setup needs the corresponding shell commands.

## One-time setup

```sh
C=~/.cache/omp-memory-eval

# Python environments
uv venv --python 3.13 $C/venv-engine
uv pip install --python $C/venv-engine/bin/python 'mnemosyne-memory[embeddings]==4.0.0b4' 'fastembed==0.9.0' 'onnxruntime==1.28.0' datasets pyarrow huggingface_hub
uv venv --python 3.12 $C/venv-lme
uv pip install --python $C/venv-lme/bin/python 'numpy<2'

# Pinned sources
mkdir -p $C/src && cd $C/src
git clone https://github.com/mnemosyne-oss/mnemosyne && git -C mnemosyne checkout e871f39480b9b9156faa4396162f7ec1f3b11525
git clone https://github.com/xiaowu0162/LongMemEval && git -C LongMemEval checkout 9e0b455f4ef0e2ab8f2e582289761153549043fc
```

Check: `$C/venv-engine/bin/python -c "import mnemosyne, fastembed; print(mnemosyne.__version__)"` prints `4.0.0b4`. Results record the `fastembed` and `onnxruntime` versions that produced the vectors (Mnemosyne, and Mnemopi with `--embedder python`), since another numerical runtime can reorder near-ties. `upstream_run_a.py` and `lme_official_check.py` refuse a source clone that is not at its pinned commit or has local changes.

The source-pin check ignores global/system Git configuration and explicitly includes untracked files, even if a checkout sets `status.showUntrackedFiles=no`; untracked evaluator modules make the checkout dirty. It also refuses files marked `assume-unchanged` or `skip-worktree`, since `git status` does not report edits to them.

## Datasets

```sh
~/.cache/omp-memory-eval/venv-engine/bin/python packages/coding-agent/bench/memory-eval/py/prepare_datasets.py
```

Writes `data/beam-100k.json`, `data/beam-500k.json` and `data/lme-s.json` at pinned HF revisions, each with a `<file>.revision` marker holding the revision it was downloaded at. The raw Hugging Face downloads go to `hf/` (as do `upstream_run_a.py`'s), not `~/.cache/huggingface`. It is idempotent: a file whose marker matches the pinned revision is skipped, any other (including a cache from before the markers existed) is downloaded again. `run` refuses a dataset whose marker is missing or differs from the revision it pins, and stamps the marker's revision into the result's `datasetRevision`, which `diff` compares.

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
$R run --dataset <beam-100k|beam-500k|lme-s|lme-s-dev> --engine <mnemopi|mnemosyne|oracle|random> --protocol <standard|fts-only|with-sleep|upstream-compat> [--cache-root dir] [--embedder js|python] [--mnemopi-recall recall|enhanced] [--polyphonic] [--cases N] [--out file]
$R diff a.json b.json
$R calibration-check calib-a.json calib-b.json
```

`run` writes `~/.cache/omp-memory-eval/results/<dataset>.<engine>.<protocol>.<time>-<random>.json` unless `--out` is given (the random suffix keeps parallel ablations that start together from overwriting each other), and prints the aggregate, per-category means, `fallbackRate`, `droppedRows` and `droppedGoldRows`. `oracle` and `random` are sanity engines. `oracle` ranks gold first, so its recall@k must reach the ceiling `min(1, k / |unique gold|)`: `k` slots hold at most `k` gold messages. Some BEAM questions have more than 10, so the oracle's mean recall@10 is below 1. `upstream-compat` runs only with `--engine mnemosyne --dataset beam-100k` (see the calibration section).

`--cache-root dir` selects an already prepared cache instead of relying on the operating system's home-directory variables. `run` reads datasets from `dir/data`, writes default results under `dir/results`, and resolves its Python venv and model cache under that root. Standalone preparation/calibration scripts still use the default paths shown above; the JS embedder's shared cache is unchanged.

The result's `config.gitCommit` and `config.gitDirty` are the checkout's HEAD and whether it had uncommitted or untracked changes, both read before the engine warms up. If HEAD moves during the run, `run` exits 1 without writing a result: the code that produced it would be unknown.

Except under `fts-only`, `run` exits 1 when any case, after ingest and before sleep, has fewer stored vectors than remembered rows: a row without a vector is ranked by full-text search alone, which would quietly score a different retrieval path.

Each returned row maps to messages by its engine row id, else through the rows it summarises (`summary_of`), else by content: to every message whose first 50 characters (lowercased, whitespace collapsed) the row contains. Messages shorter than 20 characters are left out of that fallback, since a hit can contain "ok" or "yes" by chance. `fallbackRate` is the share of ranked rows mapped by content; a row that maps to no message (`messageIds` empty) is unmapped and not counted as a fallback match.

Mnemosyne also returns derived rows (`memoria`, `memoria_source`, `associative`, `fact`). They are not ranked (the spec ranks working and episodic rows). The engine ranks the working and episodic rows of Mnemosyne's native `top_k=k` call in their order. When derived rows took some of those slots, it doubles `top_k` (stopping once a call returns fewer rows than requested) and appends rows the native call did not rank until there are `k`. A wider call scores larger candidate pools and can order rows differently, so only the appended tail comes from it. Each question records the largest `top_k` it needed as `fetchK`. Every derived row in the native top `k` is recorded per question under `dropped` with its tier, rank in that call and the message ids behind its `source_memory_id`. `droppedGoldRows` counts those that map to a gold message.

Both engines run without working-memory eviction: Mnemopi with `workingMemoryLimit: 0` and Mnemosyne with `MNEMOSYNE_WM_MAX_ITEMS=100000`, more rows than any conversation has. This differs from Mnemopi's production default, which keeps the newest 1000 working rows (omp sets no override); BEAM 500K conversations have up to about 1,400 messages, so a default store would delete the oldest ones on ingest, and those hold the long-range gold this benchmark measures. Without eviction both engines rank over the same, complete input, so the numbers compare retrieval and not retention. Mnemosyne's own default, 10,000, would not evict on these datasets either; setting it keeps that from depending on the installed version.

LongMemEval runs ask each engine for a ranking as deep as the case's corpus (`k` = 50 is only the deepest turn cutoff). The official `evaluate_retrieval_turn2session` reads past the session cutoff (5 or 10) until the ranking covers that many distinct sessions, and the official retrieval runner ranks the whole corpus, so a ranking cut at 50 turns would score some questions below their official value. A hit that maps to no message keeps its rank as a non-gold document in a session of its own; the question's `lme.corpusIds` lists these as `<unmapped N>_0`.

Latency (`latency.p50`, `latency.p95`, per question `latencyMs`) is the wall time of one `recall` as the harness sees it, so it includes engine-specific overheads: JSON-lines IPC to Mnemosyne's process and its widening calls, Mnemopi's `flushExtractions()`, and for LongMemEval a ranking as deep as the corpus. It is not comparable across engines as a speed benchmark. `warmupMs` is the engine's start, imports and model load.

### Mnemopi embedder

`--embedder js` (default) uses Mnemopi's own local fastembed, as omp does in production. On the reference machine it embeds about 20-40x slower than Python fastembed with the same ONNX model file, so a full LongMemEval run takes days. `--embedder python` serves the same model from `py/embed_server.py` (in `venv-engine`) through Mnemopi's embedding-provider option. Mnemopi's retrieval code is unchanged, and an embedding-server failure aborts the run. Compare a Python-embedder run against a JS-embedder run with `diff` before relying on it for a new model.

### Recall options

- `--mnemopi-recall recall` (default) ranks with `BeamMemory.recall`. `--mnemopi-recall enhanced` calls `recallEnhanced(question, k, { includeFacts: true })`, the call omp's auto-recall makes. Fact rows take a ranking slot (tier `fact`) and map to messages only through the content fallback. The harness ingests without fact extraction, which in production runs the host LLM over each retained transcript, so these stores hold no extracted facts: fact recall and polyphonic recall's fact voice contribute nothing, on both engines (Mnemosyne runs with `MNEMOSYNE_LLM_ENABLED=false`).
- `--polyphonic` turns on polyphonic recall: `BeamConfig.polyphonicRecall: true` for Mnemopi and `MNEMOSYNE_POLYPHONIC_RECALL=1` in Mnemosyne's environment. Mnemopi runs it only inside `recallEnhanced`, so with `--engine mnemopi` it needs `--mnemopi-recall enhanced`.

Both are recorded in the result's `config` (`mnemopiRecall`, `polyphonic`) for every engine.

### Comparing two runs

`diff a.json b.json` prints both configs (engine, the Mnemopi embedder when recorded, protocol, k, `mnemopiRecall`, `polyphonic`, git commit, marked `(dirty)` when the checkout had uncommitted changes) and a paired bootstrap of the primary metric, where every difference is **b − a**. It exits 1 unless both files have the same dataset, dataset revision, protocol, `k` and question ids (no duplicates), each question in the same case and category in both files, a finite primary metric on every question, and are not `upstream-compat` results. Engine options may differ on either side: comparing one engine with polyphonic recall off and on, or across `--mnemopi-recall` paths, is an ablation, and the printed configs name what changed.

Each question also records `definitionHash`, a hash of the case's remembered messages (id, role and content, in order), its query text and its sorted gold ids, so a loader change that altered the searched corpus or rewrote a question under the same id cannot pass as the same question: `diff` exits 1 when both files carry it and it differs. Result files from before it was recorded still diff; `diff` then warns that corpora, query text and gold sets were not verified.

The 95% interval is a percentile interval from a cluster bootstrap over cases (`caseId`): each of the 10,000 resamples draws whole cases with replacement and averages over all their questions. A BEAM case is a conversation whose questions all query one memory store (BEAM 100K: 355 questions over 20 cases), so resampling questions independently would understate the uncertainty. A LongMemEval case has one question, so there it is the per-question bootstrap. `wins`, `ties` and `losses` count questions; each line shows `n` (questions) and `cases`, overall and per category.

The verdict is `helps` when the overall interval lies above 0 and no category's interval lies wholly below 0, `hurts` for the mirror image, and `neutral` otherwise. With fewer than 2 cases (overall or in a category) every resample draws the same data, so `diff` prints `CI n/a (fewer than 2 cases)`. Without an overall interval the verdict is `insufficient data`; a category without one cannot veto.

`with-sleep` results are not comparable across engines. After sleep, a ranked summary maps through `summary_of` to every message it covers, and recall@k credits all of them for its one slot. Each engine summarises differently (how many working rows go into one episodic row differs), so recall@k under `with-sleep` reflects summary size as much as ranking. `diff` prints a warning when it compares `with-sleep` runs of two different engines; comparing two runs of the same engine is unaffected.

`with-sleep` runs only on BEAM. LongMemEval ranks every message a summary covers as its own corpus document, so one top summary covering six sessions would fill the session cutoff by itself; `run` refuses `--protocol with-sleep` with an `lme-*` dataset.

`with-sleep` is not fact-free either: Mnemopi's sleep consolidation extracts facts and graph links from the summaries it writes (without an LLM), so `--mnemopi-recall enhanced` and `--polyphonic` rank those under `with-sleep`. The `standard` protocol, which the reported results use, never sleeps.

### Environment guard

Mnemopi runs in the harness process and reads its configuration from the environment, so `run --engine mnemopi` and `embed-parity.ts` refuse to start while any `MNEMOPI_*` or `OPENROUTER_BASE_URL` (which can route its embeddings to an API) is set. Mnemosyne's child process never inherits the parent's `MNEMOSYNE_*`.

Never run real engines under `bun test`: with `NODE_ENV=test` Mnemopi's local embeddings are disabled. The tests use fakes and stub engine scripts. Python-backed tests probe for a working Python 3 (`PYTHON`, then `python3`/`python` on `PATH`) and skip if none is available, including nonworking Windows Store aliases. FTS-only and isolated CLI tests still run without Python; their explicit cache roots do not touch the user's benchmark cache.

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

Mnemopi and Mnemosyne must embed alike. Embed 50 BEAM messages with fastembed, then embed the same texts through Mnemopi's local fastembed and compare; the second step exits 1 if any cosine is non-finite or below 0.99.

```sh
~/.cache/omp-memory-eval/venv-engine/bin/python packages/coding-agent/bench/memory-eval/py/embed_parity.py
bun packages/coding-agent/bench/memory-eval/embed-parity.ts ~/.cache/omp-memory-eval/parity-py.json
```
