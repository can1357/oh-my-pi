"""Digest of an embedding model directory: the files actually loaded, not the model name.

Must match `modelDirDigest` in engines/mnemopi.ts: SHA-256 over `<name>\\0<sha256 of bytes>\\n` for every regular
file in the directory (symlinks followed, as in a Hugging Face snapshot), in sorted name order.
"""

import hashlib
import sys
from pathlib import Path


def model_dir_digest(model_dir: str | Path) -> str:
	outer = hashlib.sha256()
	for path in sorted(Path(model_dir).iterdir(), key=lambda p: p.name):
		if path.is_file():
			outer.update(f"{path.name}\0{hashlib.sha256(path.read_bytes()).hexdigest()}\n".encode())
	return outer.hexdigest()


if __name__ == "__main__":
	print(model_dir_digest(sys.argv[1]))
