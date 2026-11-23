"""BuildBuddy profile data tests — no network, no omp runtime.

Uses importlib to load profile.py directly, bypassing __init__.py which
imports devices (requiring the omp native host module).
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PY = ROOT / "src" / "omp_buildbuddy" / "profile.py"

# Load profile module directly without triggering __init__.py
_spec = importlib.util.spec_from_file_location("omp_buildbuddy.profile", PROFILE_PY)
_profile = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_profile)  # type: ignore[union-attr]


class ProfileDefaultsTests(unittest.TestCase):
    """Verify BuildBuddy profile data matches operator convars."""

    def test_credential_header_matches_convar(self) -> None:
        self.assertEqual(_profile.CREDENTIAL_HEADER, "x-buildbuddy-api-key")

    def test_arch_spelling_is_short(self) -> None:
        self.assertEqual(_profile.ARCH_SPELLING, "short")

    def test_fixed_properties_require_oci(self) -> None:
        self.assertEqual(_profile.FIXED_PROPERTIES, "workload-isolation-type=oci")

    def test_profile_name_is_operator(self) -> None:
        self.assertEqual(_profile.PROFILE_NAME, "operator")

    def test_endpoint_is_grpcs(self) -> None:
        self.assertEqual(_profile.ENDPOINT, "grpcs://app.buildbuddy.io")

    def test_endpoint_uses_secure_scheme(self) -> None:
        self.assertTrue(_profile.ENDPOINT.startswith("grpcs://"))
        self.assertIn("app.buildbuddy.io", _profile.ENDPOINT)


if __name__ == "__main__":
    unittest.main()
