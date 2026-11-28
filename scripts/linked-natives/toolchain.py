"""Build-host tools: LLVM lookup and subprocesses.

Build steps log to stderr so a script's stdout carries only its result (build.py prints the runtime
path there).
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

HOST_ARCH = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine().lower())
"""The build host's CPU in release-target spelling."""


def tool(name: str) -> str:
    """Find an LLVM tool in LLVM_BIN, then on PATH."""
    bindir = os.environ.get("LLVM_BIN")
    found = (shutil.which(name, path=bindir) if bindir else None) or shutil.which(name)
    if not found:
        raise RuntimeError(f"Missing {name}; set LLVM_BIN to your LLVM 23 bin directory")
    return found


def bun() -> str:
    """The Bun that runs upstream's build and verifier scripts and the native version stamper."""
    found = shutil.which("bun")
    if not found:
        raise RuntimeError("bun is required on PATH")
    return found


def run(
    *argv: str | Path,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    input: bytes | None = None,
) -> None:
    """Run a build step, sending its stdout to stderr."""
    subprocess.run([os.fspath(a) for a in argv], cwd=cwd, env=env, input=input, stdout=sys.stderr, check=True)


def capture(*argv: str | Path, cwd: Path | None = None) -> str:
    """Run a query and return its stripped stdout."""
    result = subprocess.run([os.fspath(a) for a in argv], cwd=cwd, stdout=subprocess.PIPE, text=True, check=True)
    return result.stdout.strip()
