"""Digest of an embedding model directory: the files actually loaded, not the model name.

Must match `modelDirDigest` in engines/mnemopi.ts: SHA-256 over `<name>\\0<sha256 of bytes>\\n` for each file in
LOADED that exists (symlinks followed, as in a Hugging Face snapshot), in sorted name order. LOADED is what fastembed
loads for the harness's one model, BAAI/bge-small-en-v1.5 (`Qdrant/bge-small-en-v1.5-onnx-Q`; see
`packages/mnemopi/src/core/fastembed-model-cache.ts`). Anything else in the directory, such as an alternate `.onnx`
export, a quarantined `*.onnx.corrupt-<time>` download or a lock file, is not the model.
"""

import hashlib
import sys
from pathlib import Path

LOADED = {"model_optimized.onnx", "config.json", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"}


def is_loaded(name: str) -> bool:
	return name in LOADED


def model_dir_digest(model_dir: str | Path) -> str:
	outer = hashlib.sha256()
	for path in sorted(Path(model_dir).iterdir(), key=lambda p: p.name):
		if is_loaded(path.name) and path.is_file():
			outer.update(f"{path.name}\0{hashlib.sha256(path.read_bytes()).hexdigest()}\n".encode())
	return outer.hexdigest()


if __name__ == "__main__":
	print(model_dir_digest(sys.argv[1]))
