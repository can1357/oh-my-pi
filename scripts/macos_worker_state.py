#!/usr/bin/env python3
"""Prepare native state inside the worker's scrubbed, locked process group.

Unlike a composite action, this process can be supervised together with native
commands. Its cache namespace never evicts another workflow's build state.
"""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys

from macos_fallback_common import VerificationError


PYTHON_INPUTS = [
    "scripts/macos_worker_state.py", "crates/py/scripts/fetch-python.sh",
    "crates/py/scripts/pack-pymodules.py", "crates/py/scripts/gen-py-notices.py",
    "crates/py/requirements.txt",
]
PYTHON_MARKER = Path("vendor/.omp-python-ready.json")


def python_identity():
    return {"version": 1, "inputs": key(PYTHON_INPUTS), "workspace": str(Path.cwd().resolve())}


def complete_python():
    """Check restored structure and absolute linker paths, not cache authority."""
    for name in ("python", "python-release"):
        root = Path("vendor", name)
        if root.is_symlink() or not root.is_dir():
            return False
        config = root / "pyo3-config.txt"
        if config.is_symlink() or not config.is_file() or config.stat().st_size > 16384:
            return False
        fields = dict(line.split("=", 1) for line in config.read_text().splitlines() if "=" in line)
        library_dir = Path(fields.get("lib_dir", ""))
        executable = Path(fields.get("executable", ""))
        lib_name = fields.get("lib_name", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", lib_name):
            return False
        library = library_dir / ("lib" + lib_name + ".a")
        for path in (library, executable, root / "stdlib.bin", root / ".archive.stamp"):
            if not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or path.stat().st_size == 0:
                return False
        if not os.access(executable, os.X_OK):
            return False
        requirements = Path("crates/py/requirements.txt")
        if any(line.strip() and not line.lstrip().startswith("#") for line in requirements.read_text().splitlines()):
            stamp = root / "bundled/.requirements.stamp"
            if not stamp.is_file() or stamp.read_bytes() != requirements.read_bytes():
                return False
    return True


def prepare_hosted_python(env, run):
    """Validate cache identity inside the guard; rebuild partial/stale restores."""
    if Path("vendor").is_symlink():
        raise VerificationError("worker vendor directory cannot be a symlink")
    expected = python_identity()
    try:
        ready = (not PYTHON_MARKER.is_symlink() and PYTHON_MARKER.stat().st_size < 16384
                 and json.loads(PYTHON_MARKER.read_text()) == expected and complete_python())
    except (OSError, ValueError, UnicodeError, RuntimeError):
        ready = False
    if ready:
        print("guarded Python cache: validated reuse", flush=True)
        return
    print("guarded Python cache: missing or invalid; preparing", flush=True)
    for name in ("python", "python-release"):
        path = Path("vendor", name)
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.exists():
            shutil.rmtree(path)
    if PYTHON_MARKER.is_symlink() or PYTHON_MARKER.exists():
        PYTHON_MARKER.unlink()
    run(["bash", "crates/py/scripts/fetch-python.sh"], check=True, env=env)
    if not complete_python():
        raise VerificationError("hosted embedded Python state is incomplete")
    PYTHON_MARKER.write_text(json.dumps(expected, sort_keys=True) + "\n")


def directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise VerificationError("unsafe private worker cache directory")
    return path


def key(paths):
    digest = hashlib.sha256()
    for name in paths:
        data = Path(name).read_bytes()
        digest.update(name.encode() + b"\0" + len(data).to_bytes(8, "big") + data)
    return digest.hexdigest()


def prepare(env=None, run=subprocess.run):
    env = dict(os.environ if env is None else env)
    if (platform.system() != "Darwin" or platform.machine().lower() not in ("arm64", "aarch64")
            or env.get("MACOS_WORKER") != "true"):
        raise VerificationError("guarded native macOS worker required")
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    run(["rustup", "show", "active-toolchain"], check=True, env=env)
    if env.get("RUNNER_ENVIRONMENT") == "self-hosted":
        env["RUSTC_WRAPPER"] = ""
        run(["cargo", "nextest", "show-config", "version"], check=True, env=env)
        runner = env.get("RUNNER_NAME", "")
        if not re.fullmatch(r"[A-Za-z0-9_. -]{1,128}", runner) or runner in (".", ".."):
            raise VerificationError("invalid worker runner name")
        # The guard already validates the shared lock ancestors before launch.
        root = directory(Path.home() / "Library/Caches/omp-macos-worker")
        state = directory(root / runner)
        try:
            minimum = int(env.get("CI_MIN_FREE_GB", "60"))
        except ValueError as error:
            raise VerificationError("invalid minimum disk budget") from error
        if not 1 <= minimum <= 4096:
            raise VerificationError("invalid minimum disk budget")
        if shutil.disk_usage(state).free < minimum * 1024**3:
            raise VerificationError("worker disk budget unavailable; refusing cache deletion")
        python_key = key([
            "crates/py/scripts/fetch-python.sh", "crates/py/scripts/pack-pymodules.py",
            "crates/py/scripts/gen-py-notices.py", "crates/py/requirements.txt",
        ])
        target_key = key(["rust-toolchain.toml", "Cargo.lock"])
        python_state = directory(state / ("python-" + python_key))
        target = directory(state / ("target-" + target_key))
        env["CARGO_TARGET_DIR"] = str(target)
        vendor = Path("vendor")
        if vendor.is_symlink():
            raise VerificationError("worker vendor directory cannot be a symlink")
        vendor.mkdir(exist_ok=True)
        for name in ("python", "python-release"):
            link = vendor / name
            destination = python_state / name
            if link.is_symlink():
                if link.resolve() != destination.resolve():
                    raise VerificationError("unexpected worker Python symlink")
            elif link.exists():
                raise VerificationError("worker Python path already exists")
            else:
                link.symlink_to(destination)
        marker = python_state / ".ready"
        if marker.is_symlink():
            raise VerificationError("unexpected Python state marker symlink")
        if not marker.is_file() or not (python_state / "python/pyo3-config.txt").is_file():
            run(["bash", "crates/py/scripts/fetch-python.sh", str(python_state)], check=True, env=env)
            if not (python_state / "python/pyo3-config.txt").is_file():
                raise VerificationError("embedded Python state is incomplete")
            marker.touch()
    elif env.get("RUNNER_ENVIRONMENT") == "github-hosted":
        prepare_hosted_python(env, run)
    else:
        raise VerificationError("unrecognized native execution pool")
    if not Path("vendor/python/pyo3-config.txt").is_file():
        raise VerificationError("embedded Python was not prepared")
    # Check the linker the build invokes. The shim prefers the keg-only lld@22
    # because Homebrew's unversioned lld drifts to newer majors, so probing
    # /opt/homebrew/bin/ld64.lld refused hosts whose build would link correctly.
    linker = run(["bash", "crates/py/scripts/ld64.lld", "--version"], check=True, env=env,
                 capture_output=True, text=True)
    if not re.search(r"\b(?:LLD|LLVM)\s+22(?:\.|\b)", linker.stdout):
        raise VerificationError("native LLVM22 linker required")
    return env


def main(argv=None):
    command = list(sys.argv[1:] if argv is None else argv)
    if command[:1] == ["--"]:
        command.pop(0)
    if not command:
        raise VerificationError("native command required")
    env = prepare()
    os.execvpe(command[0], command, env)


if __name__ == "__main__":
    try:
        main()
    except (VerificationError, OSError, subprocess.SubprocessError):
        print("native worker state preparation refused", file=sys.stderr)
        sys.exit(1)
