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

Each device calls the corresponding function in ``client.py``, which uses
``urllib.request`` to call BuildBuddy's Run API REST endpoints. The API key
is read from the macOS Keychain (service ``buildbuddy-omp2-trial``) or the
``BUILDBUDDY_API_KEY`` environment variable.
"""

from __future__ import annotations

from typing import Any

import omp
from omp.devices import MountSpec

from . import client, errors

_ARGS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": True,
}

# Manifest-backed dynamic parent (sealed soft tool). Leaves attach post-FREEZE.
EXEC_PARENT = omp.devices.parent("exec", family="buildbuddy", rev=1, place="host")


async def describe(args: dict[str, Any]) -> dict[str, Any]:
    """Report BuildBuddy backend capabilities."""
    try:
        return client.describe_capabilities()
    except errors.BuildBuddyUnavailable:
        raise
    except Exception as exc:
        raise errors.BuildBuddyUnavailable("describe", str(exc)) from exc


async def start(args: dict[str, Any]) -> dict[str, Any]:
    """Start a remote execution run on BuildBuddy."""
    request = args.get("request", {})
    if not isinstance(request, dict):
        raise errors.BuildBuddyUnavailable("start", "args.request must be an object")
    try:
        return client.start_run(request)
    except errors.BuildBuddyUnavailable:
        raise
    except Exception as exc:
        raise errors.BuildBuddyUnavailable("start", str(exc)) from exc


async def poll(args: dict[str, Any]) -> dict[str, Any]:
    """Poll a BuildBuddy execution's status."""
    operation = args.get("operation", "")
    if not operation:
        raise errors.BuildBuddyUnavailable("poll", "args.operation is required")
    cursor = args.get("cursor")
    try:
        return client.poll_run(str(operation), cursor=str(cursor) if cursor else None)
    except errors.BuildBuddyUnavailable:
        raise
    except Exception as exc:
        raise errors.BuildBuddyUnavailable("poll", str(exc)) from exc


async def cancel(args: dict[str, Any]) -> dict[str, Any]:
    """Cancel a BuildBuddy execution."""
    operation = args.get("operation", "")
    if not operation:
        raise errors.BuildBuddyUnavailable("cancel", "args.operation is required")
    try:
        return client.cancel_run(str(operation))
    except errors.BuildBuddyUnavailable:
        raise
    except Exception as exc:
        raise errors.BuildBuddyUnavailable("cancel", str(exc)) from exc


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
