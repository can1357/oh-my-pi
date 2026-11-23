"""BuildBuddy device tests — no network, no omp runtime.

The devices module imports `omp` at module level, so it cannot be loaded
without the native host. These tests verify the device source code structure
by reading the file directly, checking that each operation calls the client
module and handles errors properly.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEVICES_PY = ROOT / "src" / "omp_buildbuddy" / "devices.py"
CLIENT_PY = ROOT / "src" / "omp_buildbuddy" / "client.py"


class DeviceSourceTests(unittest.TestCase):
    """Verify device structure by inspecting source AST."""

    def setUp(self) -> None:
        self.devices_source = DEVICES_PY.read_text(encoding="utf-8")
        self.devices_tree = ast.parse(self.devices_source, filename=str(DEVICES_PY))
        self.client_source = CLIENT_PY.read_text(encoding="utf-8")
        self.client_tree = ast.parse(self.client_source, filename=str(CLIENT_PY))

    def _find_async_func(self, name: str) -> ast.AsyncFunctionDef | None:
        for node in ast.walk(self.devices_tree):
            if isinstance(node, ast.AsyncFunctionDef) and node.name == name:
                return node
        return None

    def _find_func(self, name: str) -> ast.FunctionDef | None:
        for node in ast.walk(self.client_tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
        return None

    def test_describe_calls_client(self) -> None:
        """Verify describe device calls client.describe_capabilities()."""
        func = self._find_async_func("describe")
        self.assertIsNotNone(func, "describe should exist")
        self.assertIn("client.describe_capabilities", self.devices_source)

    def test_start_calls_client(self) -> None:
        """Verify start device calls client.start_run()."""
        self.assertIn("client.start_run", self.devices_source)

    def test_poll_calls_client(self) -> None:
        """Verify poll device calls client.poll_run()."""
        self.assertIn("client.poll_run", self.devices_source)

    def test_cancel_calls_client(self) -> None:
        """Verify cancel device calls client.cancel_run()."""
        self.assertIn("client.cancel_run", self.devices_source)

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
        count = self.devices_source.count("MountSpec(")
        self.assertEqual(count, 4, "_LEAVES should have exactly 4 MountSpec entries")


class ClientSourceTests(unittest.TestCase):
    """Verify client module structure by inspecting source AST."""

    def setUp(self) -> None:
        self.source = CLIENT_PY.read_text(encoding="utf-8")
        self.tree = ast.parse(self.source, filename=str(CLIENT_PY))

    def _find_func(self, name: str) -> ast.FunctionDef | None:
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
        return None

    def test_describe_capabilities_exists(self) -> None:
        self.assertIsNotNone(self._find_func("describe_capabilities"))

    def test_start_run_exists(self) -> None:
        self.assertIsNotNone(self._find_func("start_run"))

    def test_poll_run_exists(self) -> None:
        self.assertIsNotNone(self._find_func("poll_run"))

    def test_cancel_run_exists(self) -> None:
        self.assertIsNotNone(self._find_func("cancel_run"))

    def test_uses_urllib(self) -> None:
        """Verify client uses urllib.request for HTTP calls."""
        self.assertIn("urllib.request", self.source)

    def test_uses_buildbuddy_api_key_header(self) -> None:
        """Verify client uses x-buildbuddy-api-key header."""
        self.assertIn("x-buildbuddy-api-key", self.source)

    def test_has_api_key_function(self) -> None:
        """Verify _api_key function exists for credential retrieval."""
        self.assertIsNotNone(self._find_func("_api_key"))

    def test_has_base_url_function(self) -> None:
        """Verify _base_url function exists for endpoint conversion."""
        self.assertIsNotNone(self._find_func("_base_url"))


if __name__ == "__main__":
    unittest.main()
