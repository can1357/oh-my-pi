"""Dyn ``exec/*`` device mounts for BuildBuddy remote execution.

Declares one dynamic parent with ``omp.devices.parent`` and mounts the four
delegate operations (describe, start, poll, cancel) at ``extension_activate``.

These operations follow the delegate contract from
``docs/research/exec-out-of-core.md`` (Shape C1):

| Operation | Returns | Safe to repeat |
|---|---|---|
| describe | BackendCapabilities | Yes |
| start(request, inputs) | Opaque operation identity | No |
| poll(operation, cursor) | State, output page, next cursor | Yes |
| cancel(operation) | CancelOutcome | Yes |

The ``DelegatedBackend`` adapter (ADR 0040 Dimension 3, not yet built) will
call these operations through the extension host. Until then, these devices
are stubs that return ``BuildBuddyUnavailable``.
"""

from __future__ import annotations

from typing import Any

import omp
from omp.devices import MountSpec

from . import errors

_ARGS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": True,
}

# Manifest-backed dynamic parent (sealed soft tool). Leaves attach post-FREEZE.
EXEC_PARENT = omp.devices.parent("exec", family="buildbuddy", rev=1, place="host")


async def describe(args: dict[str, Any]) -> dict[str, Any]:
    """Report BuildBuddy backend capabilities."""
    raise errors.BuildBuddyUnavailable(
        "describe", "DelegatedBackend adapter not yet built (ADR 0040 Dimension 3)"
    )


async def start(args: dict[str, Any]) -> dict[str, Any]:
    """Start a remote execution run on BuildBuddy."""
    raise errors.BuildBuddyUnavailable(
        "start", "DelegatedBackend adapter not yet built (ADR 0040 Dimension 3)"
    )


async def poll(args: dict[str, Any]) -> dict[str, Any]:
    """Poll a BuildBuddy execution's status."""
    raise errors.BuildBuddyUnavailable(
        "poll", "DelegatedBackend adapter not yet built (ADR 0040 Dimension 3)"
    )


async def cancel(args: dict[str, Any]) -> dict[str, Any]:
    """Cancel a BuildBuddy execution."""
    raise errors.BuildBuddyUnavailable(
        "cancel", "DelegatedBackend adapter not yet built (ADR 0040 Dimension 3)"
    )


_LEAVES: tuple[MountSpec, ...] = (
    MountSpec(
        subpath="describe",
        body=describe,
        schema=_ARGS_SCHEMA,
        summary="BuildBuddy backend capabilities (REAPI + Run API)",
    ),
    MountSpec(
        subpath="start",
        body=start,
        schema=_ARGS_SCHEMA,
        summary="Start a remote execution run on BuildBuddy",
    ),
    MountSpec(
        subpath="poll",
        body=poll,
        schema=_ARGS_SCHEMA,
        summary="Poll a BuildBuddy execution's status and output",
    ),
    MountSpec(
        subpath="cancel",
        body=cancel,
        schema=_ARGS_SCHEMA,
        summary="Cancel a BuildBuddy execution",
    ),
)


@omp.hook("extension_activate")
async def mount_exec_leaves(_event: object) -> None:
    """Mount the four delegate operations into the host dynamic device catalog."""
    await EXEC_PARENT.mount_many(*_LEAVES)
