"""Coverage gate: every inventory symbol and RPC must be claimed by a case.

Each ``cases/test_*.py`` module declares::

	COVERS = {"py": ["omp.devices.tool", ...], "rpc": ["omp.blob.v1.Blob/Put", ...]}

meaning its cases genuinely exercise those symbols/RPCs. This gate asserts
the union of all claims equals ``inventory.py``'s mechanically derived
surface — both directions: nothing uncovered, nothing claimed that does not
exist (typo guard).
"""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import inventory  # noqa: E402

CASES_DIR = Path(__file__).resolve().parent

COVERS: dict[str, list[str]] = {"py": [], "rpc": []}


def claimed() -> tuple[set[str], set[str], list[str]]:
	"""Union of COVERS across case modules, plus modules missing COVERS."""
	py_claims: set[str] = set()
	rpc_claims: set[str] = set()
	missing: list[str] = []
	for path in sorted(CASES_DIR.glob("test_*.py")):
		module = importlib.import_module(f"cases.{path.stem}")
		covers = getattr(module, "COVERS", None)
		if covers is None:
			missing.append(path.stem)
			continue
		py_claims.update(covers.get("py", []))
		rpc_claims.update(covers.get("rpc", []))
	return py_claims, rpc_claims, missing


def format_gap(label: str, gap: set[str], limit: int = 40) -> str:
	listed = "\n  ".join(sorted(gap)[:limit])
	suffix = f"\n  … and {len(gap) - limit} more" if len(gap) > limit else ""
	return f"{len(gap)} {label}:\n  {listed}{suffix}"


class Coverage(unittest.TestCase):
	"""The suite must claim exactly the mechanically derived surface."""

	def test_every_python_api_symbol_is_covered(self):
		py_claims, _, missing = claimed()
		self.assertFalse(missing, f"case modules without COVERS: {missing}")
		gap = inventory.py_inventory() - py_claims
		self.assertFalse(gap, format_gap("uncovered Python API symbols", gap))

	def test_every_rpc_is_covered(self):
		_, rpc_claims, _ = claimed()
		gap = inventory.rpc_inventory() - rpc_claims
		self.assertFalse(gap, format_gap("uncovered RPCs", gap))

	def test_no_phantom_claims(self):
		py_claims, rpc_claims, _ = claimed()
		phantom = (py_claims - inventory.py_inventory()) | (
			rpc_claims - inventory.rpc_inventory()
		)
		self.assertFalse(phantom, format_gap("claims not in the inventory", phantom))


if __name__ == "__main__":
	unittest.main()
