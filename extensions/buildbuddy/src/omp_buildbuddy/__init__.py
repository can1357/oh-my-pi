"""BuildBuddy remote execution extension (ADR 0040 Dimension 1).

Vendor integration for BuildBuddy that provides:
- REAPI profile data (credential header, arch spelling, fixed properties)
- Run API delegate operations (describe, start, poll, cancel)

The native REAPI gRPC client (`crates/exec-reapi/`) uses the profile data
via operator convars. The future `DelegatedBackend` adapter will call the
Run API operations through this extension.

This extension follows Shape C1 from `docs/research/exec-out-of-core.md`:
a Python extension carrying four short operations behind one adapter.
"""

from __future__ import annotations

from . import devices
from .errors import BuildBuddyUnavailable

__all__ = ["BuildBuddyUnavailable", "devices"]

try:
    from . import profile as profile
except ImportError:  # pragma: no cover - unit tests without omp
    profile = None  # type: ignore[assignment]
else:
    __all__.append("profile")
