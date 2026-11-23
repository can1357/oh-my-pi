"""BuildBuddy error type tests — no network, no omp runtime.

Uses importlib to load errors.py directly, bypassing __init__.py which
imports devices (requiring the omp native host module).
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ERRORS_PY = ROOT / "src" / "omp_buildbuddy" / "errors.py"

# Load errors module directly without triggering __init__.py
_spec = importlib.util.spec_from_file_location("omp_buildbuddy.errors", ERRORS_PY)
_errors = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_errors)  # type: ignore[union-attr]

BuildBuddyUnavailable = _errors.BuildBuddyUnavailable


class BuildBuddyUnavailableTests(unittest.TestCase):
    """Verify BuildBuddyUnavailable error behavior."""

    def test_error_message_format(self) -> None:
        err = BuildBuddyUnavailable("describe", "not ready")
        self.assertEqual(str(err), "BuildBuddy describe: not ready")

    def test_error_preserves_op(self) -> None:
        err = BuildBuddyUnavailable("start", "adapter missing")
        self.assertEqual(err.op, "start")

    def test_error_preserves_reason(self) -> None:
        err = BuildBuddyUnavailable("poll", "DelegatedBackend adapter not yet built")
        self.assertEqual(err.reason, "DelegatedBackend adapter not yet built")

    def test_error_is_exception(self) -> None:
        with self.assertRaises(BuildBuddyUnavailable):
            raise BuildBuddyUnavailable("cancel", "unavailable")

    def test_error_is_base_exception(self) -> None:
        err = BuildBuddyUnavailable("describe", "test")
        self.assertIsInstance(err, Exception)


if __name__ == "__main__":
    unittest.main()
