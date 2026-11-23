"""BuildBuddy profile data tests — no network, no omp runtime."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PY = ROOT / "src" / "omp_buildbuddy" / "profile.py"


class ProfileDefaultsTests(unittest.TestCase):
    """Verify profile constants match operator convars."""

    def setUp(self) -> None:
        source = PROFILE_PY.read_text(encoding="utf-8")
        self.source = source

    def test_credential_header_matches_convar(self) -> None:
        self.assertIn(
            'CREDENTIAL_HEADER: str = "x-buildbuddy-api-key"',
            self.source,
            "Credential header must match sv_exec_remote_credential_header",
        )

    def test_arch_spelling_is_short(self) -> None:
        self.assertIn(
            'ARCH_SPELLING: str = "short"',
            self.source,
            "Arch spelling must be 'short' for BuildBuddy",
        )

    def test_fixed_properties_require_oci(self) -> None:
        self.assertIn(
            'FIXED_PROPERTIES: str = "workload-isolation-type=oci"',
            self.source,
            "Fixed properties must require OCI workload isolation",
        )

    def test_profile_name_is_operator(self) -> None:
        self.assertIn(
            'PROFILE_NAME: str = "operator"',
            self.source,
            "Profile name must be 'operator'",
        )

    def test_endpoint_is_grpcs(self) -> None:
        self.assertIn(
            'ENDPOINT: str = "grpcs://app.buildbuddy.io"',
            self.source,
            "Endpoint must use grpcs:// scheme",
        )

    def test_endpoint_uses_secure_scheme(self) -> None:
        self.assertIn(
            "grpcs://",
            self.source,
            "Endpoint must use secure gRPC scheme",
        )


if __name__ == "__main__":
    unittest.main()
