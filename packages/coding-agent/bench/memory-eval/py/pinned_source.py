"""Refuses a cached source checkout that is not at its pinned commit or has local changes.

The calibration and official-evaluator scripts import code from these clones; a moved or edited clone would run
other logic under the promised revision. Once the checkout passes, later imports compile bytecode into a fresh
private cache, so no `__pycache__` in the checkout is ever read or written.
"""

import atexit
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

# Files Python can import or that alter sys.path; ignored ones would shadow evaluator dependencies unseen by `status`.
IMPORTABLE = {".py", ".pyc", ".pyo", ".pyd", ".so", ".pth"}


def require_pinned(repo: Path, commit: str) -> None:
	# GIT_DIR, GIT_WORK_TREE and friends would make `-C repo` check another repository.
	env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
	env["GIT_CONFIG_NOSYSTEM"] = "1"
	env["GIT_CONFIG_GLOBAL"] = os.devnull

	def git(*args: str) -> str:
		return subprocess.run(
			["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, env=env
		).stdout.strip()

	try:
		head = git("rev-parse", "HEAD")
		# `-z` keeps paths unquoted; ignored files are listed one by one, so a shadow module under .git/info/exclude shows.
		entries = [e for e in git("status", "--porcelain", "-z", "--untracked-files=all", "--ignored=traditional").split("\0") if e]
		status = [e for e in entries if not e.startswith("!! ")]
		# Bytecode caches are written by every evaluator run and only load next to their source, so they stay allowed.
		ignored = [
			e[3:]
			for e in entries
			if e.startswith("!! ")
			and PurePosixPath(e[3:]).suffix in IMPORTABLE
			and "__pycache__" not in PurePosixPath(e[3:]).parts
		]
		# A local `core.worktree` would make every check above inspect another tree than the one callers import.
		top = git("rev-parse", "--show-toplevel")
		# `status` skips files marked assume-unchanged (lowercase tag) or skip-worktree (`S`), so edits to them hide.
		hidden = [line[2:] for line in git("ls-files", "-v").splitlines() if line[:1].islower() or line[:1] == "S"]
	except (OSError, subprocess.CalledProcessError) as error:
		sys.exit(f"{repo}: not a readable git checkout ({error}); redo the one-time setup")
	if Path(top).resolve() != repo.resolve():
		sys.exit(f"{repo}: work tree is {top}, not the checkout itself; restore it to {commit}")
	if head != commit:
		sys.exit(f"{repo}: HEAD is {head}, expected {commit}; redo the one-time setup")
	if status:
		sys.exit(f"{repo}: has local changes; restore it to {commit}")
	if hidden:
		sys.exit(f"{repo}: index flags hide changes to {hidden[:5]}; restore it to {commit}")
	if ignored:
		sys.exit(f"{repo}: has ignored importable files {ignored[:5]}; remove them to restore {commit}")
	# CPython trusts a .pyc whose source has the recorded mtime and size, so an ignored cache built from edited code
	# could run in place of the pinned source. A fresh prefix makes every later import compile from the source itself.
	sys.pycache_prefix = tempfile.mkdtemp(prefix="memory-eval-pycache-")
	atexit.register(shutil.rmtree, sys.pycache_prefix, True)
