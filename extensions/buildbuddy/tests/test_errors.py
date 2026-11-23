"""BuildBuddy error type tests — no network, no omp runtime."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ERRORS_PY = ROOT / "src" / "omp_buildbuddy" / "errors.py"


class BuildBuddyUnavailableTests(unittest.TestCase):
    """Verify BuildBuddyUnavailable error type."""

    def setUp(self) -> None:
        source = ERRORS_PY.read_text(encoding="utf-8")
        self.source = source

    def test_error_is_exception(self) -> None:
        self.assertIn(
            "class BuildBuddyUnavailable(Exception)",
            self.source,
            "BuildBuddyUnavailable must inherit from Exception",
        )

    def test_error_is_base_exception(self) -> None:
        self.assertIn(
            "Exception",
            self.source,
            "BuildBuddyUnavailable must inherit from Exception (base)",
        )

    def test_error_message_format(self) -> None:
        self.assertIn(
            'f"BuildBuddy {op}: {reason}"',
            self.source,
            "Error message must format op and reason",
        )

    def test_error_preserves_op(self) -> None:
        self.assertIn(
            "self.op = op",
            self.source,
            "Error must preserve operation name",
        )

    def test_error_preserves_reason(self) -> None:
        self.assertIn(
            "self.reason = reason",
            self.source,
            "Error must preserve reason",
        )


if __name__ == "__main__":
    unittest.main()
