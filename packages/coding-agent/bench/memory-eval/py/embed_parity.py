"""Embed the first 50 non-empty BEAM messages with the engine venv's fastembed.

Run with venv-engine's python: embed_parity.py [out.json]  (default ~/.cache/omp-memory-eval/parity-py.json)

The output holds the texts and vectors; ../embed-parity.ts embeds the same texts through Mnemopi's provider and
compares them per text by cosine similarity (both engines must share an embedding model).
"""

import os
import sys

# First, before any import that searches PYTHONPATH: an override tree could shadow json, pathlib or fastembed, and
# the engines' own Python helpers run with every PYTHON* variable removed.
for name in ("PYTHONPATH", "PYTHONHOME"):
	if os.environ.get(name):
		sys.exit(f"embed_parity.py: refusing to run with {name} set; unset it so venv-engine's packages are imported")

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
