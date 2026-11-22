"""BuildBuddy extension errors."""

from __future__ import annotations


class BuildBuddyUnavailable(Exception):
    """BuildBuddy operation unavailable."""

    def __init__(self, op: str, reason: str) -> None:
        super().__init__(f"BuildBuddy {op}: {reason}")
        self.op = op
        self.reason = reason
