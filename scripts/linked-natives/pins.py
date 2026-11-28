"""The pinned Bun release and the release targets that have a Bun link kit.

kits.json is the single source: its `targets` keys are the supported standalone targets.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict


class KitPin(TypedDict):
    """Byte size and SHA-256 of a target's compressed kit, and the SHA-256 of its kit.json."""

    bytes: int
    sha256: str
    manifestSha256: str


_LOCK = json.loads(Path(__file__).with_name("kits.json").read_text(encoding="utf-8"))
BUN_VERSION: str = _LOCK["bunVersion"]
BUN_REVISION: str = _LOCK["bunRevision"]
SOURCE_SHA256: str = _LOCK["sourceSha256"]
KITS: dict[str, KitPin] = _LOCK["targets"]


@dataclass(frozen=True)
class Target:
    """A standalone release target such as `linux-musl-arm64`."""

    id: str
    platform: str
    """darwin, linux or win32."""
    arch: str
    """arm64 or x64."""

    @property
    def musl(self) -> bool:
        return "-musl-" in self.id

    @property
    def cpu(self) -> str:
        """LLVM's spelling of `arch`."""
        return "aarch64" if self.arch == "arm64" else "x86_64"

    @classmethod
    def parse(cls, target_id: str) -> "Target":
        """Resolve a pinned target, accepting the `windows-` spelling of local CROSS_TARGET builds."""
        canonical = re.sub(r"^windows-", "win32-", target_id)
        if canonical not in KITS:
            raise ValueError(f"Unsupported standalone runtime target: {target_id}")
        parts = canonical.split("-")
        return cls(canonical, parts[0], parts[-1])
