"""Frozen core-enforced ceilings."""

from __future__ import annotations

import sysconfig
from typing import Final

from _omp import Duration

ACTIVATION_TIMEOUT: Final[Duration] = Duration("10s")
"""Budget for one extension activation before it is degraded."""

API_LEVEL: Final[int] = 1
"""Current extension API level."""

API_LEVELS: Final[frozenset[int]] = frozenset({API_LEVEL})
"""Extension API levels admitted by this host."""

DOCS_TOTAL_BUDGET: Final[int] = 48_000
"""Total documentation-character budget across one extension's device tree."""

HOST_VERSION: Final[str] = "0.1.0"
"""Build-stamped omp host version."""

MAX_FRAME_BYTES: Final[int] = 67_108_864
"""Largest encoded CONTROL or DATA frame accepted by the host."""

MAX_HOST_CHILDREN: Final[int] = 32
"""Maximum live extension-host children in one session."""

MAX_PENDING_EFFECTS: Final[int] = 1024
"""Maximum pending CONTROL requests and fire-and-forget effects per child."""

PING_INTERVAL: Final[Duration] = Duration("15s")
"""Idle interval between host health probes."""

PYTHON_REV: Final[str] = (
    "3.14t" if sysconfig.get_config_var("Py_GIL_DISABLED") else "3.14"
)
"""CPython 3.14 ABI revision required by the host."""

SCHEMA_REV: Final[int] = 7
"""Wire schema revision shared with ``omp_proto::SCHEMA_REV``."""

CANCEL_GRACE: Final[Duration] = Duration("150ms")
"""Grace between cooperative task cancellation and thread interruption."""

SHUTDOWN_GRACE: Final[Duration] = Duration("2s")
"""Maximum grace for authorized work to settle during shutdown."""

HEALTH_TIMEOUT: Final[Duration] = Duration("5s")
"""Budget for host health checks, handshakes, and frame reads."""

REENTRANCY_DEPTH: Final[int] = 4
INTERACTIVE_CAP: Final[Duration] = Duration("15m")
SETTLE_CONTINUATION_CAP: Final[int] = 8
SHUTDOWN_BUDGET: Final[Duration] = Duration("2s")
OBSERVE_CAP: Final[int] = 64
MODIFY_ROUNDS: Final[int] = 1

__all__ = (
    "ACTIVATION_TIMEOUT",
    "API_LEVEL",
    "API_LEVELS",
    "CANCEL_GRACE",
    "DOCS_TOTAL_BUDGET",
    "HEALTH_TIMEOUT",
    "HOST_VERSION",
    "INTERACTIVE_CAP",
    "MAX_FRAME_BYTES",
    "MAX_HOST_CHILDREN",
    "MAX_PENDING_EFFECTS",
    "MODIFY_ROUNDS",
    "OBSERVE_CAP",
    "PING_INTERVAL",
    "PYTHON_REV",
    "REENTRANCY_DEPTH",
    "SCHEMA_REV",
    "SETTLE_CONTINUATION_CAP",
    "SHUTDOWN_BUDGET",
    "SHUTDOWN_GRACE",
)
