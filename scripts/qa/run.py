#!/usr/bin/env python3
"""QA spec-suite runner.

	python3 scripts/qa/run.py [-v] [-k pattern]

Discovers every ``cases/test_*.py`` module and runs it with stdlib unittest.
The coverage gate (``cases/test_coverage.py``) fails the run when any
inventory symbol/RPC is unclaimed, so a green run means 100% of the Python
extension API and proto services is covered by exercised cases.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

QA_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(QA_ROOT))

if __name__ == "__main__":
	from harness import OMP_BINARY

	if not OMP_BINARY.exists():
		sys.exit(f"missing {OMP_BINARY}; run `cargo build --bin omp` first")
	argv = [sys.argv[0], "discover", "-s", str(QA_ROOT / "cases"), "-t", str(QA_ROOT)]
	argv.extend(sys.argv[1:])
	unittest.main(module=None, argv=argv)
