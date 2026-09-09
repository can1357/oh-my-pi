"""Ground-truth coverage inventories for the QA spec suite.

Two mechanically derived surfaces:

- ``rpc_inventory()`` — every RPC declared in the served protos, as
  ``omp.<pkg>.v1.<Service>/<Rpc>``.
- ``py_inventory()`` — every public symbol of the embedded ``omp`` Python
  extension API, as ``omp[.<module>].<symbol>``, extracted with ``ast``
  (``__all__`` when declared, else top-level public defs/classes/assignments).

``cases/test_coverage.py`` asserts the union of every case module's
``COVERS`` declaration equals these inventories, so "100% coverage" is a
checked property, not a claim.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PROTO_FILES = (
	REPO_ROOT / "crates/proto/proto/omp/inference/v1/inference.proto",
	REPO_ROOT / "crates/proto/proto/omp/auth/v1/auth.proto",
	REPO_ROOT / "crates/proto/proto/omp/blob/v1/blob.proto",
)
PY_PACKAGE = REPO_ROOT / "crates/py/python/omp"


def rpc_inventory() -> set[str]:
	"""All served RPCs as ``omp.<pkg>.v1.<Service>/<Rpc>``."""
	rpcs: set[str] = set()
	for proto in PROTO_FILES:
		text = proto.read_text()
		package = re.search(r"^package\s+([\w.]+);", text, re.M).group(1)
		for service_match in re.finditer(r"^service\s+(\w+)\s*\{", text, re.M):
			service = service_match.group(1)
			depth = 0
			body_start = text.index("{", service_match.start())
			for offset, char in enumerate(text[body_start:], body_start):
				if char == "{":
					depth += 1
				elif char == "}":
					depth -= 1
					if depth == 0:
						body = text[body_start:offset]
						break
			for rpc in re.findall(r"^\s*rpc\s+(\w+)\s*\(", body, re.M):
				rpcs.add(f"{package}.{service}/{rpc}")
	return rpcs


def _module_symbols(source: str) -> set[str]:
	tree = ast.parse(source)
	declared_all: set[str] | None = None
	for node in tree.body:
		if (
			isinstance(node, ast.Assign)
			and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets)
			and isinstance(node.value, (ast.List, ast.Tuple))
		):
			declared_all = {
				element.value
				for element in node.value.elts
				if isinstance(element, ast.Constant) and isinstance(element.value, str)
			}
	if declared_all is not None:
		return declared_all
	symbols: set[str] = set()
	for node in tree.body:
		if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
			if not node.name.startswith("_"):
				symbols.add(node.name)
		elif isinstance(node, ast.Assign):
			for target in node.targets:
				if isinstance(target, ast.Name) and not target.id.startswith("_"):
					symbols.add(target.id)
		elif isinstance(node, ast.AnnAssign):
			if isinstance(node.target, ast.Name) and not node.target.id.startswith("_"):
				symbols.add(node.target.id)
	return symbols


def py_inventory() -> set[str]:
	"""Public ``omp`` API symbols as ``omp[.<module>].<symbol>``."""
	symbols: set[str] = set()
	for path in sorted(PY_PACKAGE.rglob("*.py")):
		relative = path.relative_to(PY_PACKAGE)
		parts = relative.with_suffix("").parts
		if parts[-1] == "__init__":
			parts = parts[:-1]
		if any(part.startswith("_") for part in parts):
			continue  # private modules surface through re-exports
		module = ".".join(("omp", *parts))
		for symbol in _module_symbols(path.read_text()):
			symbols.add(f"{module}.{symbol}")
	return symbols


if __name__ == "__main__":
	rpcs = sorted(rpc_inventory())
	api = sorted(py_inventory())
	print(f"# RPCs: {len(rpcs)}")
	for rpc in rpcs:
		print(rpc)
	print(f"# Python API symbols: {len(api)}")
	for symbol in api:
		print(symbol)
