"""Exports a cached source clone's pinned commit into a private directory to import from.

The calibration and official-evaluator scripts import code from these clones. The clone's working tree is mutable:
it can be edited during a run, carry CRLF line endings on Windows, or be hidden from `git status` by settings in
the clone itself (index flags, filters, `core.worktree`, ignore rules). The scripts therefore never import from it.
They import from a fresh copy of the pinned commit's files, read from the object store with each blob's hash
checked, which no other process writes to.
"""

import atexit
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Tree entry modes: symlinks store their target as the blob, gitlinks (submodules) name a commit and have no bytes.
SYMLINK, GITLINK = "120000", "160000"


def pinned_snapshot(repo: Path, commit: str) -> Path:
	"""A private directory holding exactly the files of `commit` in `repo`'s object store; removed at exit."""
	# GIT_DIR, GIT_WORK_TREE and friends would make `-C repo` read another repository; replace refs could swap objects.
	env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
	env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_NO_REPLACE_OBJECTS="1")

	def git(*args: str, stdin: bytes | None = None) -> bytes:
		return subprocess.run(
			["git", "-C", str(repo), *args], input=stdin, check=True, capture_output=True, env=env
		).stdout

	try:
		object_format = git("rev-parse", "--show-object-format").decode().strip()
		listing = git("ls-tree", "-r", "-z", "--full-tree", commit)
		entries = []
		for entry in listing.split(b"\0"):
			if entry:
				meta, name = entry.split(b"\t", 1)
				mode, _kind, blob = meta.decode().split()
				if mode != GITLINK:
					entries.append((mode, blob, os.fsdecode(name)))
		# One batch call returns every blob as `<sha> blob <size>\n<bytes>\n`, in request order.
		batch = git("cat-file", "--batch", stdin="".join(f"{blob}\n" for _, blob, _ in entries).encode())
	except (OSError, subprocess.CalledProcessError) as error:
		sys.exit(f"{repo}: cannot read commit {commit} ({error}); redo the one-time setup")

	dest = Path(tempfile.mkdtemp(prefix="memory-eval-src-"))
	atexit.register(shutil.rmtree, dest, True)
	offset = 0
	for mode, blob, name in entries:
		header_end = batch.index(b"\n", offset)
		size = int(batch[offset:header_end].split()[2])
		data = batch[header_end + 1 : header_end + 1 + size]
		offset = header_end + 1 + size + 1
		# cat-file does not re-hash what it reads, so a rewritten object file would otherwise go unnoticed.
		if hashlib.new(object_format, b"blob %d\0" % len(data) + data).hexdigest() != blob:
			sys.exit(f"{repo}: object {blob} for {name} does not match its id; redo the one-time setup")
		path = dest / name
		path.parent.mkdir(parents=True, exist_ok=True)
		if mode == SYMLINK:
			os.symlink(os.fsdecode(data), path)
		else:
			path.write_bytes(data)
	return dest
