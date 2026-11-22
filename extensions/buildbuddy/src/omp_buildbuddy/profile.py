"""BuildBuddy REAPI profile data.

Pure data — no code. The native REAPI gRPC client (`crates/exec-reapi/`)
reads these values from operator convars. This module provides defaults
that match BuildBuddy's requirements.

Profile values replace the removed `Profile::buildbuddy()` method and the
three `"buildbuddy"` branches in `crates/driver/src/adw/remote.rs`.
"""

from __future__ import annotations

# BuildBuddy REAPI profile defaults
# These match the operator convars in ~/.o2/config.cfg:
#   sv_exec_remote_credential_header "x-buildbuddy-api-key"
#   sv_exec_remote_arch_spelling "short"
#   sv_exec_remote_fixed_properties "workload-isolation-type=oci"
#   sv_exec_remote_profile "operator"

CREDENTIAL_HEADER: str = "x-buildbuddy-api-key"
"""gRPC metadata header for API key authentication."""

ARCH_SPELLING: str = "short"
"""Architecture property spelling. BuildBuddy uses Arch/amd64, not ISA/x86-64."""

FIXED_PROPERTIES: str = "workload-isolation-type=oci"
"""Fixed platform properties. BuildBuddy requires OCI workload isolation."""

PROFILE_NAME: str = "operator"
"""REAPI profile name. BuildBuddy uses 'operator'."""

ENDPOINT: str = "grpcs://app.buildbuddy.io"
"""Default REAPI gRPC endpoint."""
