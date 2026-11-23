"""Dyn ``exec/*`` device mounts for BuildBuddy remote execution.

Declares one dynamic parent with ``omp.devices.parent`` and mounts five
delegate operations (describe, start, poll, get_log, cancel) at
``extension_activate``.

These operations follow the delegate contract from
``docs/research/exec-out-of-core.md`` (Shape C1):

| Operation | Returns | Safe to repeat |
|---|---|---|
| describe | BackendCapabilities | Yes |
| start(request, inputs) | Opaque operation identity | No |
| poll(operation, cursor) | State, output page, next cursor | Yes |
| get_log(operation, cursor) | Log output, next cursor | Yes |
| cancel(operation) | CancelOutcome | Yes |

Each device calls the corresponding function in ``client.py``, which uses
``omp.env.http_post`` to call BuildBuddy's Run API REST endpoints. All
endpoints are POST-based JSON calls routed through the sandbox's HTTP egress
broker, so the extension respects ``sv_sandbox_allow_domains``. The API key
is read from the operator credential convar via ``omp.credential`` at call
time.
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
        return await client.start_run(request)
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
        return await client.poll_run(str(operation), cursor=str(cursor) if cursor else None)
    except errors.BuildBuddyUnavailable:
        raise
    except Exception as exc:
        raise errors.BuildBuddyUnavailable("poll", str(exc)) from exc


async def get_log(args: dict[str, Any]) -> dict[str, Any]:
    """Fetch logs for a BuildBuddy execution."""
    operation = args.get("operation", "")
    if not operation:
        raise errors.BuildBuddyUnavailable("get_log", "args.operation is required")
    cursor = args.get("cursor")
    try:
        return await client.get_log(str(operation), cursor=str(cursor) if cursor else None)
    except errors.BuildBuddyUnavailable:
        raise
    except Exception as exc:
        raise errors.BuildBuddyUnavailable("get_log", str(exc)) from exc


async def cancel(args: dict[str, Any]) -> dict[str, Any]:
    """Cancel a BuildBuddy execution (returns Unsupported via REST API)."""
    operation = args.get("operation", "")
    if not operation:
        raise errors.BuildBuddyUnavailable("cancel", "args.operation is required")
    try:
        return await client.cancel_run(str(operation))
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
        summary="Poll a BuildBuddy execution's status",
    ),
    MountSpec(
        subpath="get_log",
        body=get_log,
        schema=_ARGS_SCHEMA,
        summary="Fetch logs for a BuildBuddy execution",
    ),
    MountSpec(
        subpath="cancel",
        body=cancel,
        schema=_ARGS_SCHEMA,
        summary="Cancel a BuildBuddy execution (REST returns Unsupported)",
    ),
)


@omp.hook("extension_activate")
async def mount_exec_leaves(_event: object) -> None:
    """Mount the five delegate operations into the host dynamic device catalog."""
    await EXEC_PARENT.mount_many(*_LEAVES)
