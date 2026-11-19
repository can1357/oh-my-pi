"""Shared HMAC signing/verification for the roboomp ↔ gh-proxy channel.

Roboomp signs every request to gh-proxy with an HMAC-SHA256 over
`(method, path, timestamp, sha256(body))`. The shared secret never leaves
either container's memory, and the ±skew window bounds the replay surface.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import NamedTuple

# Headers on every roboomp→gh-proxy request.
HEADER_TIMESTAMP = "X-Robomp-Timestamp"  # unix seconds, integer string
HEADER_SIGNATURE = "X-Robomp-Sig"  # hex-encoded HMAC-SHA256

# ±skew permits modest clock drift while keeping the replay window small.
DEFAULT_SKEW_SECONDS = 30


def _string_to_sign(method: str, path: str, timestamp: str, body: bytes) -> bytes:
    return b"\n".join(
        (
            method.upper().encode("ascii"),
            path.encode("utf-8"),
            timestamp.encode("ascii"),
            hashlib.sha256(body or b"").hexdigest().encode("ascii"),
        )
    )


def sign(
    *,
    method: str,
    path: str,
    body: bytes,
    key: bytes,
    timestamp: str | None = None,
) -> tuple[str, str]:
    """Return `(timestamp, signature_hex)` for the given request shape.

    `timestamp` may be supplied explicitly (replay tests); otherwise the
    current unix epoch in integer seconds is used. `path` MUST be the URL
    path-only portion (no scheme, host, or query string trimming) so client
    and server agree on the canonical form.
    """
    ts = timestamp if timestamp is not None else str(int(time.time()))
    sig = hmac.new(key, _string_to_sign(method, path, ts, body), hashlib.sha256).hexdigest()
    return ts, sig


class VerifyResult(NamedTuple):
    ok: bool
    reason: str


def verify(
    *,
    method: str,
    path: str,
    body: bytes,
    timestamp: str | None,
    signature: str | None,
    key: bytes,
    now: float | None = None,
    skew: int = DEFAULT_SKEW_SECONDS,
) -> VerifyResult:
    """Validate an incoming request. Returns `(ok, reason)`.

    Any malformed input returns ok=False with a short reason. The reason
    string is suitable for logging but should NOT be echoed back to the
    caller (it leaks whether the failure was timestamp vs signature).
    """
    if not timestamp or not signature:
        return VerifyResult(False, "missing signature headers")
    try:
        ts_int = int(timestamp)
    except ValueError:
        return VerifyResult(False, "malformed timestamp")
    now_int = int(now if now is not None else time.time())
    if abs(now_int - ts_int) > skew:
        return VerifyResult(False, "timestamp outside skew window")
    expected = hmac.new(key, _string_to_sign(method, path, timestamp, body), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return VerifyResult(False, "signature mismatch")
    return VerifyResult(True, "")


__all__ = [
    "DEFAULT_SKEW_SECONDS",
    "HEADER_SIGNATURE",
    "HEADER_TIMESTAMP",
    "VerifyResult",
    "sign",
    "verify",
]
