#!/usr/bin/env python3
"""ADR 0049 D5 / D4 gate for in-repo first-party extensions.

Run from the repository root (or anywhere):

    python3 scripts/check-extension-conformance.py
    just check-extensions

Checks (fail closed, multi-line report):

A. Manifest effect checks (D4) for every ``extensions/*/omp.toml``:
   required keys ``id``, ``name``, ``version``, ``omp_api``, ``entry``,
   ``capabilities`` (list); forge/ci/github/gitlab (and any package that
   already lists a network capability) must declare ``env.net.fetch`` —
   rescue packages without network use are not forced; every capability
   string must be a closed-vocab token (frozen ``omp.Capability`` values,
   envd DATA grants, plus the D4 first-cut fetch spelling
   ``env.net.fetch``); refuse any ``extensions/**/Cargo.toml``; backends
   ``omp.github`` / ``omp.gitlab`` must not declare a soft ``forge`` or
   ``ci`` parent.

B. Unit tests: for each ``extensions/<pkg>/tests/``, run
   ``python3 -m unittest discover`` with PYTHONPATH matching package
   READMEs (forge/ci include sibling github+gitlab ``src``). Rescue wave-1
   packages are included in discovery via their ``omp.toml``.

C. Frozen API import smoke (no live host): install ``_omp`` stubs (same
   pattern as ``scripts/check-python-examples.py``, with stub metaclass
   dunder filtering and a ``Fault.__init_subclass__`` repair so host
   CPython can ``import omp`` without the native extension), then import
   wave-1 mapping/dispatch modules, catalog ``devices`` modules (they
   bind ``omp.devices.parent`` at import time but succeed under stubs),
   and rescue public modules (pure helpers / ``__init__``). Device modules
   that register at import are smuggled like forge/ci ``devices`` where
   feasible; CONTROL-at-import skips stay documented in package READMEs.

Exit 0 prints a short OK summary; non-zero prints every failure.
"""

from __future__ import annotations

import importlib
import importlib.abc
import os
import subprocess
import sys
import tomllib
import types
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[1]
_EXTENSIONS = _ROOT / "extensions"
_PYTHON = _ROOT / "crates" / "py" / "python"

# Forge/CI network packages that must declare env.net.fetch.
_WAVE1_NETWORK = frozenset({"forge", "ci", "github", "gitlab"})

# Rescue wave-1 package directory names (ADR 0049 D5). Must keep tests/.
_RESCUE_WAVE1 = frozenset(
	{
		"pr-review",
		"green-loop",
		"workflows",
		"remote-approve",
		"search-provider",
		"provider-pack",
		"fuzzy-index",
		"spec-flow",
		# ADR 0046 item 4 UI-bound ports (Phase 5 remainder).
		"sidebar",
		"hover-cards",
		"welcome-chrome",
	}
)

# Capability tokens that imply network use (trigger env.net.fetch requirement).
_NETWORK_CAPABILITY_HINTS = frozenset({"env.net", "env.net.fetch"})

# Backends that must not compete for forge/* or ci/* mount ownership.
_BACKEND_IDS = frozenset({"omp.github", "omp.gitlab"})
_COMPETING_SOFT_PARENTS = frozenset({"forge", "ci"})

# Closed capability vocabulary for manifest grants (D4 first cut).
# Mirrors ``omp.Capability`` (crates/py/python/omp/__init__.py), envd DATA
# ``CAPABILITIES`` (crates/envd/src/policy.rs), and the wave-1 fetch spelling
# ``env.net.fetch`` used until host grants align on ``env.net`` alone.
_KNOWN_CAPABILITIES = frozenset(
	{
		"env.blob",
		"env.dap.execute",
		"env.dap.read",
		"env.doc.read",
		"env.doc.write",
		"env.exec",
		"env.fs.read",
		"env.fs.write",
		"env.lsp",
		"env.net",
		"env.net.fetch",
		"env.process",
		"env.search",
		"env.workspace.snapshot",
		"env.worktree",
		"invocation",
		"place.env",
		"place.worker",
		"schedules:project",
		# CONTROL-side UI / session grants (ADR 0046 item 4 host arms).
		"sessions.read",
		"ui.commands",
		"ui.dialogs",
		"ui.ghost",
		"ui.notify",
		"ui.slots",
		"ui.title",
	}
)

_SMOKE_MODULES = (
	"omp_github.mapping",
	"omp_github.ci_mapping",
	"omp_gitlab.mapping",
	"omp_gitlab.ci_mapping",
	"omp_forge_ext.dispatch",
	"omp_ci_ext.dispatch",
	"omp_forge_ext.devices",
	"omp_ci_ext.devices",
	# Rescue public modules (import-clean pure helpers / package roots).
	"omp_pr_review",
	"omp_green_loop",
	"omp_workflows",
	"omp_remote_approve",
	"omp_search_provider",
	"omp_provider_pack",
	"omp_fuzzy_index",
	"omp_spec_flow",
	"omp_sidebar",
	"omp_hover_cards",
	"omp_welcome_chrome",
	"omp_vault",
)

# Device modules that register at import (succeed under stubs like forge devices).
_SMOKE_DEVICE_MODULES = (
	"omp_provider_pack.device",
	"omp_pr_review.device",
	"omp_fuzzy_index.device",
	"omp_search_provider.device",
	"omp_remote_approve.device",
	"omp_workflows.device",
	"omp_green_loop.device",
	"omp_spec_flow.device",
	"omp_vault.device",
)

_REQUIRED_MANIFEST_KEYS = (
	"id",
	"name",
	"version",
	"omp_api",
	"entry",
	"capabilities",
)


class _StubValue:
	"""Permissive inert stand-in for values constructed by native bindings."""

	def __call__(self, *_args: Any, **_kwargs: Any) -> "_StubValue":
		return self

	def __getattr__(self, _name: str) -> "_StubValue":
		return self

	def __iter__(self):
		return iter(())

	def __bool__(self) -> bool:
		return False

	def __lt__(self, _other: Any) -> bool:
		return False

	__le__ = __gt__ = __ge__ = __lt__

	def __add__(self, _other: Any) -> "_StubValue":
		return self

	__radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __add__


_VALUE = _StubValue()


class _NativeMeta(type):
	def __getattr__(cls, name: str) -> _StubValue:
		# Do not synthesize dunders: ``is_dataclass`` probes
		# ``__dataclass_fields__`` and a truthy stub would mark every native
		# exception as a non-frozen dataclass (breaks PolicyDenied et al.).
		if name.startswith("__") and name.endswith("__"):
			raise AttributeError(name)
		return _VALUE


class _NativeError(Exception, metaclass=_NativeMeta):
	"""Common inert native type; exception ancestry supports package errors."""

	def __lt__(self, _other: Any) -> bool:
		return False

	__le__ = __gt__ = __ge__ = __lt__

	def __add__(self, _other: Any) -> "_NativeError":
		return self

	__radd__ = __sub__ = __rsub__ = __mul__ = __rmul__ = __add__


class _NativeModule(types.ModuleType):
	def __getattr__(self, name: str) -> Any:
		if name.startswith("__"):
			raise AttributeError(name)
		value = _NativeError
		setattr(self, name, value)
		return value


def _install_native_stubs() -> None:
	"""Install in-memory ``_omp`` / ``_omp_url_vocab`` stubs (examples-gate pattern)."""

	native = _NativeModule("_omp")
	native._runtime_metadata = lambda: {}
	native._phase_legality_matrix = lambda: {}
	native._scheme_snapshot = lambda: (b"stub", ())
	native.operation_spec = lambda _symbol: None
	native._read_bytes_blocking = lambda *_args, **_kwargs: b""
	native._interrupt = lambda *_args, **_kwargs: None
	native._thread_id = lambda: 0
	native.resources = _VALUE
	# Named exception bases so frozen ``@dataclass(..., frozen=True)`` subclasses
	# of ``OmpError`` do not see a synthesized ``__dataclass_fields__``.
	native.OmpError = _NativeError
	native.HostDisconnected = type("HostDisconnected", (_NativeError,), {})
	native.EnvUnavailable = type("EnvUnavailable", (_NativeError,), {})
	native.PlacementError = type("PlacementError", (_NativeError,), {})
	native.StaleGeneration = type("StaleGeneration", (_NativeError,), {})
	sys.modules["_omp"] = native

	vocab = types.ModuleType("_omp_url_vocab")
	vocab.URL_VOCAB_VERSION = 1
	vocab.SELECTOR_GRAMMAR = "stub"
	vocab.SCHEMES = (("FILE", ("file",), True),)
	sys.modules["_omp_url_vocab"] = vocab


def _verdict_init_subclass(cls: type, **kwargs: Any) -> None:
	"""``object.__init_subclass__`` stand-in for slots+verdict bases on host CPython."""

	object.__init_subclass__(**kwargs)
	from omp._verdicts import _validate_verdict_schema

	_validate_verdict_schema(cls)


def _patch_verdict_bases(omp: Any) -> None:
	"""Repair ``Fault`` / ``Payload`` ``__init_subclass__`` for offline smoke."""

	for name in ("Fault", "Payload"):
		base = getattr(omp, name, None)
		if base is None:
			continue
		base.__init_subclass__ = classmethod(_verdict_init_subclass)  # type: ignore[method-assign]


def _install_fault_patch() -> None:
	"""Repair verdict ``__init_subclass__`` before ``omp.env`` loads.

	``@dataclass(..., slots=True)`` plus ``super().__init_subclass__`` fails on
	host CPython (``TypeError: super(type, obj)...``). The embedded host is not
	exercised here; replace with ``object.__init_subclass__`` for the offline
	smoke only. Applies to both ``Fault`` and ``Payload`` (rescue device
	modules subclass both).
	"""

	class Hook(importlib.abc.MetaPathFinder):
		def find_spec(self, fullname, path=None, target=None):  # noqa: ANN001
			del path, target
			if fullname != "omp.env":
				return None
			omp = sys.modules.get("omp")
			if omp is None:
				return None
			_patch_verdict_bases(omp)
			return None

	sys.meta_path.insert(0, Hook())


def _package_dirs() -> list[Path]:
	if not _EXTENSIONS.is_dir():
		return []
	return sorted(
		path
		for path in _EXTENSIONS.iterdir()
		if path.is_dir() and not path.name.startswith(".") and (path / "omp.toml").is_file()
	)


def _check_no_cargo_members(errors: list[str]) -> None:
	for cargo in sorted(_EXTENSIONS.rglob("Cargo.toml")):
		rel = cargo.relative_to(_ROOT)
		errors.append(f"{rel}: extensions must never be Cargo members (ADR 0049 D5)")


def _check_manifest(pkg: Path, errors: list[str]) -> None:
	manifest_path = pkg / "omp.toml"
	rel = manifest_path.relative_to(_ROOT)
	try:
		data = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
	except tomllib.TOMLDecodeError as error:
		errors.append(f"{rel}: invalid TOML: {error}")
		return

	for key in _REQUIRED_MANIFEST_KEYS:
		if key not in data:
			errors.append(f"{rel}: missing required key `{key}`")

	capabilities = data.get("capabilities")
	if "capabilities" in data:
		if not isinstance(capabilities, list) or not all(
			isinstance(item, str) and item for item in capabilities
		):
			errors.append(f"{rel}: `capabilities` must be a list of non-empty strings")
			capabilities = []
		else:
			needs_fetch = pkg.name in _WAVE1_NETWORK or any(
				cap in _NETWORK_CAPABILITY_HINTS for cap in capabilities
			)
			if needs_fetch and "env.net.fetch" not in capabilities:
				errors.append(
					f"{rel}: network package must include capability `env.net.fetch`"
				)
		for cap in capabilities if isinstance(capabilities, list) else []:
			if isinstance(cap, str) and cap and cap not in _KNOWN_CAPABILITIES:
				errors.append(f"{rel}: unknown capability `{cap}` (not in closed vocab)")

	ext_id = data.get("id")
	if isinstance(ext_id, str) and ext_id in _BACKEND_IDS:
		for declaration in data.get("declarations", []) or []:
			if not isinstance(declaration, dict):
				continue
			kind = declaration.get("kind")
			decl_id = declaration.get("id")
			if kind == "soft" and decl_id in _COMPETING_SOFT_PARENTS:
				errors.append(
					f"{rel}: backend `{ext_id}` must not declare soft parent "
					f"`{decl_id}` (only omp.forge / omp.ci may)"
				)


def _pythonpath_for(pkg: Path) -> str:
	"""Match package README proofs: forge/ci need sibling backend src dirs."""

	parts = [str(pkg / "src")]
	if pkg.name in {"forge", "ci"}:
		parts.append(str(_EXTENSIONS / "github" / "src"))
		parts.append(str(_EXTENSIONS / "gitlab" / "src"))
	return os.pathsep.join(parts)


def _run_unit_tests(pkg: Path, errors: list[str], summary: list[str]) -> None:
	tests = pkg / "tests"
	if not tests.is_dir():
		return
	env = os.environ.copy()
	env["PYTHONPATH"] = _pythonpath_for(pkg)
	completed = subprocess.run(
		[sys.executable, "-m", "unittest", "discover", "-s", str(tests), "-v"],
		cwd=_ROOT,
		env=env,
		check=False,
		capture_output=True,
		text=True,
	)
	detail = (completed.stderr or completed.stdout).strip()
	ran_line = next(
		(
			line
			for line in reversed(detail.splitlines())
			if line.startswith("Ran ") or line.startswith("FAILED")
		),
		"",
	)
	if completed.returncode != 0:
		errors.append(
			f"{pkg.relative_to(_ROOT)}/tests: unittest failed (exit {completed.returncode})"
		)
		for line in detail.splitlines()[-40:]:
			errors.append(f"  {line}")
	else:
		summary.append(f"unittest {pkg.name}: {ran_line or 'OK'}")


def _smoke_imports(errors: list[str], summary: list[str]) -> None:
	_install_native_stubs()
	_install_fault_patch()
	python_root = str(_PYTHON)
	if python_root not in sys.path:
		sys.path.insert(0, python_root)
	for sibling in sorted(
		{
			"forge",
			"ci",
			"github",
			"gitlab",
			"vault",
			*_RESCUE_WAVE1,
		}
	):
		src = str(_EXTENSIONS / sibling / "src")
		if src not in sys.path:
			sys.path.insert(0, src)

	try:
		import omp  # noqa: F401
	except Exception as error:  # pragma: no cover - stub/host skew
		errors.append(f"frozen API: import omp failed: {type(error).__name__}: {error}")
		return
	_patch_verdict_bases(omp)
	summary.append("import omp: ok (native stubs)")

	imported: list[str] = []
	for module in _SMOKE_MODULES + _SMOKE_DEVICE_MODULES:
		try:
			importlib.import_module(module)
		except Exception as error:
			errors.append(
				f"frozen API: import {module} failed: {type(error).__name__}: {error}"
			)
		else:
			imported.append(module)
	if imported:
		summary.append(f"smoke imports: {', '.join(imported)}")


def main() -> int:
	errors: list[str] = []
	summary: list[str] = []

	if not _EXTENSIONS.is_dir():
		print("extensions/: missing", file=sys.stderr)
		return 1

	_check_no_cargo_members(errors)

	packages = _package_dirs()
	if not packages:
		errors.append("extensions/: no packages with omp.toml found")

	for pkg in packages:
		_check_manifest(pkg, errors)
		_run_unit_tests(pkg, errors, summary)

	tested = [pkg.name for pkg in packages if (pkg / "tests").is_dir()]
	required_tests = _WAVE1_NETWORK | _RESCUE_WAVE1
	missing_tests = sorted(required_tests - set(tested))
	for name in missing_tests:
		errors.append(f"extensions/{name}/tests: wave-1 package is missing a tests/ directory")

	missing_rescue = sorted(_RESCUE_WAVE1 - {pkg.name for pkg in packages})
	for name in missing_rescue:
		errors.append(f"extensions/{name}/omp.toml: rescue wave-1 package is missing")

	_smoke_imports(errors, summary)

	if errors:
		print("extension conformance FAILED:", file=sys.stderr)
		for line in errors:
			print(f"  {line}", file=sys.stderr)
		return 1

	print(
		"ok: "
		f"{len(packages)} manifests, "
		f"unittests for {', '.join(tested)}, "
		+ "; ".join(summary)
	)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
