"""Embed the first 50 non-empty BEAM messages with the engine venv's fastembed.

Run with venv-engine's python: embed_parity.py [out.json]  (default ~/.cache/omp-memory-eval/parity-py.json)

The output holds the texts and vectors; ../embed-parity.ts embeds the same texts through Mnemopi's provider and
compares them per text by cosine similarity (both engines must share an embedding model).
"""

import os
import sys

# First, before any import: os and sys are loaded at interpreter startup. PYTHONPATH, PYTHONHOME, PYTHONPYCACHEPREFIX and
# their kin change which code or bytecode an import loads, while the engines' own Python helpers run with every PYTHON*
# variable removed. Only these, which affect I/O and locale but not imports, are allowed. Inline in every script: an
# imported guard could itself be loaded through an override.
SAFE_PYTHON_ENV = {"PYTHONUNBUFFERED", "PYTHONIOENCODING", "PYTHONUTF8", "PYTHONCOERCECLOCALE", "PYTHONDONTWRITEBYTECODE", "PYTHONNOUSERSITE", "PYTHONSTARTUP"}
for name in sorted(os.environ):
	if name.upper().startswith("PYTHON") and name.upper() not in SAFE_PYTHON_ENV and os.environ[name]:
		sys.exit(f"embed_parity.py: refusing to run with {name} set; unset it so only venv-engine's code runs")

import json  # noqa: E402
from pathlib import Path  # noqa: E402

from fastembed import TextEmbedding  # noqa: E402

CACHE = Path.home() / ".cache" / "omp-memory-eval"
MODEL = "BAAI/bge-small-en-v1.5"
COUNT = 50

beam = json.loads((CACHE / "data" / "beam-100k.json").read_text(encoding="utf-8"))
texts = [m["content"] for row in beam for batch in row["chat"] for m in batch if m["content"].strip()][:COUNT]

model = TextEmbedding(MODEL, cache_dir=str(CACHE / "fastembed"))
vectors = [vector.tolist() for vector in model.embed(texts)]

out = Path(sys.argv[1]) if len(sys.argv) > 1 else CACHE / "parity-py.json"
out.write_text(json.dumps({"model": MODEL, "texts": texts, "vectors": vectors}), encoding="utf-8")
print(f"wrote {len(vectors)} vectors of dim {len(vectors[0])} to {out}")
