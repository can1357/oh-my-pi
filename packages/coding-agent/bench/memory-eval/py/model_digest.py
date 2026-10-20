"""Digests two harness runs compare: the embedding model files loaded, and a calibration corpus.

`model_dir_digest` must match `modelDirDigest` in engines/mnemopi.ts: SHA-256 over `<name>\\0<sha256 of bytes>\\n` for
each file in LOADED that exists (symlinks followed, as in a Hugging Face snapshot), in sorted name order. LOADED is what
fastembed loads for the harness's one model, BAAI/bge-small-en-v1.5 (`Qdrant/bge-small-en-v1.5-onnx-Q`; see
`packages/mnemopi/src/core/fastembed-model-cache.ts`). Anything else in the directory, such as an alternate `.onnx`
export, a quarantined `*.onnx.corrupt-<time>` download or a lock file, is not the model.

`corpus_digest` must match `corpusSha256` in compat.ts.
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


def corpus_digest(conversations: list[list[str]]) -> str:
	"""SHA-256 over each conversation's message count, then each message as `<utf-8 byte length>\\n<bytes>`, in order."""
	outer = hashlib.sha256()
	for messages in conversations:
		outer.update(f"{len(messages)}\n".encode())
		for message in messages:
			data = message.encode("utf-8")
			outer.update(f"{len(data)}\n".encode() + data)
	return outer.hexdigest()


if __name__ == "__main__":
	print(model_dir_digest(sys.argv[1]))
