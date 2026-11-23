"""BuildBuddy device stub tests — no network, no omp runtime.

The devices module imports `omp` at module level, so it cannot be loaded
without the native host. These tests verify the device source code structure
by reading the file directly, checking that each operation raises
BuildBuddyUnavailable.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEVICES_PY = ROOT / "src" / "omp_buildbuddy" / "devices.py"


class DeviceSourceTests(unittest.TestCase):
    """Verify device stubs raise BuildBuddyUnavailable by inspecting source AST."""

    def setUp(self) -> None:
        source = DEVICES_PY.read_text(encoding="utf-8")
        self.tree = ast.parse(source, filename=str(DEVICES_PY))

    def _find_async_func(self, name: str) -> ast.AsyncFunctionDef | None:
        for node in ast.walk(self.tree):
            if isinstance(node, ast.AsyncFunctionDef) and node.name == name:
                return node
        return None

    def _func_raises_buildbuddy_unavailable(self, func_name: str) -> bool:
        """Check if the function body contains a raise of BuildBuddyUnavailable."""
        func = self._find_async_func(func_name)
        self.assertIsNotNone(func, f"Function {func_name} should exist")
        for node in ast.walk(func):
            if isinstance(node, ast.Raise):
                if node.exc is not None:
                    # Check for `raise errors.BuildBuddyUnavailable(...)`
                    if isinstance(node.exc, ast.Call):
                        if isinstance(node.exc.func, ast.Attribute):
                            if node.exc.func.attr == "BuildBuddyUnavailable":
                                return True
        return False

    def test_describe_raises_unavailable(self) -> None:
        self.assertTrue(
            self._func_raises_buildbuddy_unavailable("describe"),
            "describe should raise BuildBuddyUnavailable",
        )

    def test_start_raises_unavailable(self) -> None:
        self.assertTrue(
            self._func_raises_buildbuddy_unavailable("start"),
            "start should raise BuildBuddyUnavailable",
        )

    def test_poll_raises_unavailable(self) -> None:
        self.assertTrue(
            self._func_raises_buildbuddy_unavailable("poll"),
            "poll should raise BuildBuddyUnavailable",
        )

    def test_cancel_raises_unavailable(self) -> None:
        self.assertTrue(
            self._func_raises_buildbuddy_unavailable("cancel"),
            "cancel should raise BuildBuddyUnavailable",
        )

    def test_all_four_operations_exist(self) -> None:
        """Verify all four delegate operations are defined."""
        for name in ("describe", "start", "poll", "cancel"):
            self.assertIsNotNone(
                self._find_async_func(name),
                f"Operation {name} should be defined",
            )

    def test_mount_exec_leaves_hook_exists(self) -> None:
        """Verify the extension_activate hook is defined."""
        self.assertIsNotNone(
            self._find_async_func("mount_exec_leaves"),
            "mount_exec_leaves hook should be defined",
        )

    def test_leaves_tuple_has_four_entries(self) -> None:
        """Verify _LEAVES contains exactly four MountSpec entries."""
        source = DEVICES_PY.read_text(encoding="utf-8")
        # Count MountSpec( calls in the file
        count = source.count("MountSpec(")
        self.assertEqual(count, 4, "_LEAVES should have exactly 4 MountSpec entries")


if __name__ == "__main__":
    unittest.main()
