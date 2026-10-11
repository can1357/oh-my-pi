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
