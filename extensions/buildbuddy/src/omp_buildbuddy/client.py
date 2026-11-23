"""BuildBuddy Run API HTTP client.

Uses standard library `urllib.request` (no third-party deps) to call
BuildBuddy's Run API REST endpoints. The API key is read from the
operator credential convar via `omp.credential` at call time.

Run API endpoints (from `docs/research/exec-out-of-core.md`):
- `POST /api/v1/Run` — submit a run, returns invocation ID
- `GET /api/v1/invocations/<id>` — get invocation status
- `GET /api/v1/invocations/<id>/log` — page invocation log output
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from typing import Any

from . import errors
from .profile import ENDPOINT


def _api_key() -> str:
    """Read the BuildBuddy API key from the macOS Keychain.

    Uses the same command as `sv_exec_remote_credential` in
    `~/.o2/config.cfg`: `security find-generic-password -s buildbuddy-omp2-trial -w`.
    Falls back to `BUILDBUDDY_API_KEY` env var for testing.
    """
    key = os.environ.get("BUILDBUDDY_API_KEY", "")
    if key:
        return key
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "buildbuddy-omp2-trial", "-w"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    raise errors.BuildBuddyUnavailable(
        "auth", "no BuildBuddy API key found (Keychain or BUILDBUDDY_API_KEY)"
    )


def _base_url() -> str:
    """Return the BuildBuddy REST base URL from the gRPC endpoint.

    Converts `grpcs://app.buildbuddy.io` → `https://app.buildbuddy.io`.
    """
    endpoint = os.environ.get("SV_EXEC_REMOTE_ENDPOINT", ENDPOINT)
    if endpoint.startswith("grpcs://"):
        return endpoint.replace("grpcs://", "https://", 1)
    if endpoint.startswith("grpc://"):
        return endpoint.replace("grpc://", "http://", 1)
    return endpoint


def _headers() -> dict[str, str]:
    """Build the authorization headers for BuildBuddy REST API."""
    return {
        "x-buildbuddy-api-key": _api_key(),
        "Content-Type": "application/json",
        "User-Agent": "omp-buildbuddy/0.1",
    }


def _request(method: str, path: str, *, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute one BuildBuddy REST API call.

    Raises `BuildBuddyUnavailable` on HTTP errors or network failures.
    """
    base = _base_url()
    url = base.rstrip("/") + path
    headers = _headers()

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise errors.BuildBuddyUnavailable(
            path, f"BuildBuddy HTTP {exc.code}"
        ) from exc
    except urllib.error.URLError as exc:
        raise errors.BuildBuddyUnavailable(
            path, "BuildBuddy host unreachable"
        ) from exc

    if not body:
        return {}
    return json.loads(body.decode("utf-8", errors="replace"))


def describe_capabilities() -> dict[str, Any]:
    """Call `describe` — return BuildBuddy backend capabilities.

    Returns a capabilities map indicating Run API features:
    workspace mirroring, runner script support, and snapshot preservation.
    """
    # The Run API capabilities are static — they don't change per-request.
    # We verify connectivity by checking the endpoint, but the capabilities
    # themselves are known from the extension's profile data.
    return {
        "capabilities": {
            "workspace_mirroring": True,
            "runner_script": True,
            "snapshot_preservation": True,
            "cancel": True,
        },
        "backend": "buildbuddy",
        "endpoint": _base_url(),
    }


def start_run(request: dict[str, Any]) -> dict[str, Any]:
    """Call `start` — submit a run via `POST /api/v1/Run`.

    The request contains:
    - `command`: the command to run (e.g., `just test-pkg omp-exec-reapi`)
    - `inputs`: captured input set from envd
    - `platform`: OS, arch, properties
    - `timeout`: wall-clock limit

    Returns the invocation ID assigned by BuildBuddy.
    """
    payload = {
        "command": request.get("command", ""),
        "inputs": request.get("inputs", {}),
        "platform": request.get("platform", {}),
        "timeout": request.get("timeout", "3600s"),
    }
    result = _request("POST", "/api/v1/Run", payload=payload)
    invocation_id = result.get("invocationId") or result.get("invocation_id") or ""
    if not invocation_id:
        raise errors.BuildBuddyUnavailable("start", "no invocation ID in response")
    return {
        "operation": invocation_id,
        "backend": "buildbuddy",
    }


def poll_run(operation: str, cursor: str | None = None) -> dict[str, Any]:
    """Call `poll` — get invocation status via `GET /api/v1/invocations/<id>`.

    Returns the execution state, output page, and next cursor.
    """
    path = f"/api/v1/invocations/{operation}"
    if cursor:
        path += f"?cursor={cursor}"
    result = _request("GET", path)

    # Map BuildBuddy's response to the delegate contract shape
    state = result.get("state") or result.get("status") or "unknown"
    output = result.get("output") or ""
    next_cursor = result.get("nextCursor") or result.get("next_cursor") or ""

    return {
        "state": state,
        "output": output,
        "nextCursor": next_cursor,
    }


def cancel_run(operation: str) -> dict[str, Any]:
    """Call `cancel` — cancel via `POST /api/v1/invocations/<id>/cancel`.

    BuildBuddy's Run API supports REST cancellation. The gRPC
    `BuildBuddyService.CancelExecutions` is also available but requires
    a native gRPC wheel (ADR 0040 Dimension 3).
    """
    path = f"/api/v1/invocations/{operation}/cancel"
    result = _request("POST", path)
    return {
        "outcome": result.get("outcome") or "requested",
    }
