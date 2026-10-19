"""Refuses a cached source checkout whose files are not exactly its pinned commit's.

The calibration and official-evaluator scripts import code from these clones; a moved or edited clone would run
other logic under the promised revision. Git's own view of the working tree (status, index flags, filters,
`core.worktree`, ignore rules) is configurable from inside the clone, so the check reads the pinned commit's tree
from the object store and hashes every file on disk itself. Once the checkout passes, later imports compile
bytecode into a fresh private cache, so no `__pycache__` in the checkout is ever read or written.
"""

import atexit
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Tracked entry modes: symlinks hash their target, gitlinks (submodules) name a commit and have no bytes here.
SYMLINK, GITLINK = "120000", "160000"


def require_pinned(repo: Path, commit: str) -> None:
	# GIT_DIR, GIT_WORK_TREE and friends would make `-C repo` check another repository; replace refs could swap objects.
	env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
	env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_NO_REPLACE_OBJECTS="1")

	def git(*args: str) -> bytes:
		return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env).stdout

	try:
		head = git("rev-parse", "HEAD").decode().strip()
		object_format = git("rev-parse", "--show-object-format").decode().strip()
		listing = git("ls-tree", "-r", "-z", "--full-tree", commit)
	except (OSError, subprocess.CalledProcessError) as error:
		sys.exit(f"{repo}: not a readable git checkout ({error}); redo the one-time setup")
	if head != commit:
		sys.exit(f"{repo}: HEAD is {head}, expected {commit}; redo the one-time setup")

	tracked: dict[str, tuple[str, str]] = {}
	for entry in listing.split(b"\0"):
		if entry:
			meta, name = entry.split(b"\t", 1)
			mode, _kind, blob = meta.decode().split()
			tracked[name.decode("utf-8", "surrogateescape")] = (mode, blob)

	changed = []
	for name, (mode, blob) in tracked.items():
		if mode == GITLINK:
			continue
		path = repo / name
		try:
			if mode == SYMLINK:
				data = os.fsencode(os.readlink(path))
			elif path.is_symlink():
				changed.append(name)
				continue
			else:
				data = path.read_bytes()
		except OSError:
			changed.append(name)
			continue
		if hashlib.new(object_format, b"blob %d\0" % len(data) + data).hexdigest() != blob:
			changed.append(name)

	# Anything else on disk could be imported or read. Bytecode caches are allowed: the prefix below bypasses them.
	extra = []
	for root, dirs, files in os.walk(repo):
		here = Path(root)
		if here == repo:
			dirs[:] = [d for d in dirs if d != ".git"]
			files = [f for f in files if f != ".git"]
		dirs[:] = [d for d in dirs if d != "__pycache__"]
		# os.walk does not descend into a symlinked directory, so name it here: it could hold a shadow package.
		for name in files + [d for d in dirs if (here / d).is_symlink()]:
			rel = (here / name).relative_to(repo).as_posix()
			if rel not in tracked:
				extra.append(rel)

	if changed:
		sys.exit(f"{repo}: has local changes to {sorted(changed)[:5]}; restore it to {commit}")
	if extra:
		sys.exit(f"{repo}: has files the pinned commit does not have: {sorted(extra)[:5]}; remove them")
	# CPython trusts a .pyc whose source has the recorded mtime and size, so a cache built from edited code could run
	# in place of the pinned source. A fresh prefix makes every later import compile from the source itself.
	sys.pycache_prefix = tempfile.mkdtemp(prefix="memory-eval-pycache-")
	atexit.register(shutil.rmtree, sys.pycache_prefix, True)
