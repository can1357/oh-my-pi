"""Refuses a cached source checkout that is not at its pinned commit or has local changes.

The calibration and official-evaluator scripts import code from these clones; a moved or edited clone would run
other logic under the promised revision.
"""

import subprocess
import sys
from pathlib import Path


def require_pinned(repo: Path, commit: str) -> None:
	def git(*args: str) -> str:
		return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()

	try:
		head, status = git("rev-parse", "HEAD"), git("status", "--porcelain")
	except (OSError, subprocess.CalledProcessError) as error:
		sys.exit(f"{repo}: not a readable git checkout ({error}); redo the one-time setup")
	if head != commit:
		sys.exit(f"{repo}: HEAD is {head}, expected {commit}; redo the one-time setup")
	if status:
		sys.exit(f"{repo}: has local changes; restore it to {commit}")
