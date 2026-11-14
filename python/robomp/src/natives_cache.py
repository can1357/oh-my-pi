"""Shared content-addressed cache of native artifacts.

Artifacts are copied or reflinked into independent workspace inodes. Capture
accepts slot-produced artifacts, so tasks sharing a key also share their trust
domain. The cache directory must be inaccessible to slots.
"""

from __future__ import annotations

import errno
import fcntl
import fnmatch
import hashlib
import json
import logging
import os
import platform
import secrets
import shutil
import stat
import subprocess
import sys
import time
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import IO

log = logging.getLogger(__name__)


# Paths whose git tree-hash feeds the cache key. Order is significant — the
# hash incorporates the (path, tree_hash) pairs in this exact order so a
# different ordering would produce a different key. Cover every input the
# napi build reads: all workspace crates (pi-natives transitively depends on
# pi-ast/pi-iso/pi-shell), the workspace Cargo manifest + lock, the rust
# toolchain pin, and the natives package itself (build script + scripts/* +
# package.json with napi config).
CACHE_KEY_PATHS: tuple[str, ...] = (
    "crates",
    "Cargo.lock",
    "Cargo.toml",
    "rust-toolchain.toml",
    "packages/natives",
)

# Files in ``packages/natives/native/`` that ARE pure functions of the
# cache-key inputs and travel as a unit. ``.node`` is matched by glob since
# the basename embeds the target triple + variant.
_CACHED_NODE_GLOB = "pi_natives.*.node"
_CACHED_COMPANION_FILES: tuple[str, ...] = (
    "index.d.ts",
    "index.js",
    "embedded-addon.js",
)
_MANIFEST_FILENAME = "manifest.json"
_LOCKFILE_NAME = ".lock"

_NULL_TREE_HASH = "0" * 40  # placeholder for paths missing from HEAD
_MAX_ARTIFACT_SIZE = 512 * 1024 * 1024


def _normalize_platform() -> str:
    """Mirror node's ``process.platform`` so the cache key matches
    ``build-native.ts``'s filename convention."""
    s = sys.platform
    if s.startswith("linux"):
        return "linux"
    if s == "darwin":
        return "darwin"
    if s in ("win32", "cygwin"):
        return "win32"
    return s


def _normalize_arch() -> str:
    """Mirror node's ``process.arch``."""
    m = platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "x64"
    if m in ("aarch64", "arm64"):
        return "arm64"
    return m


def target_triple() -> str:
    """``<platform>-<arch>[-<variant>]`` matching the napi addon basename.

    ``TARGET_VARIANT`` is honored only on x64 (the build script enforces the
    same restriction). On x64 hosts that leave the variant unset we encode
    ``host`` to keep the key stable across workspaces on the same machine
    without trying to autodetect AVX2 from Python.
    """
    plat = _normalize_platform()
    arch = _normalize_arch()
    if arch != "x64":
        return f"{plat}-{arch}"
    variant = os.environ.get("TARGET_VARIANT", "").strip() or "host"
    return f"{plat}-{arch}-{variant}"


def _git_safe_directory_env(repo_dir: Path) -> dict[str, str]:
    """Env overlay that whitelists ``repo_dir`` for git's safe.directory check.

    The orchestrator runs as root but workspaces are owned by the slot UID
    (see ``SandboxManager._chown_workspace``). Without this whitelist, every
    git invocation from the orchestrator on a slot-owned repo aborts with
    "fatal: detected dubious ownership". Mirrors
    ``robomp.sandbox._safe_directory_env`` but kept local to avoid a circular
    import (sandbox imports this module).
    """
    env = os.environ.copy()
    count = int(env.get("GIT_CONFIG_COUNT", "0"))
    env[f"GIT_CONFIG_KEY_{count}"] = "safe.directory"
    env[f"GIT_CONFIG_VALUE_{count}"] = str(repo_dir)
    env["GIT_CONFIG_COUNT"] = str(count + 1)
    return env


def compute_key(repo_dir: Path, *, target: str | None = None) -> str:
    """Deterministic sha256 over the git tree-hashes of cache-key paths.

    Uses ``git cat-file --batch-check`` for one subprocess invocation. Missing
    paths fold in as a fixed null hash so the key remains deterministic
    across repos that don't ship every input file.

    Raises ``subprocess.CalledProcessError`` if ``git`` itself fails (e.g.
    not a repo) — callers SHOULD treat that as "no cache" and proceed.
    """
    tgt = target if target is not None else target_triple()
    stdin = "".join(f"HEAD:{p}\n" for p in CACHE_KEY_PATHS)
    proc = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        input=stdin,
        cwd=str(repo_dir),
        text=True,
        capture_output=True,
        check=True,
        env=_git_safe_directory_env(repo_dir),
        timeout=120.0,
    )
    return _key_from_lines(proc.stdout.splitlines(), tgt)


def _key_from_lines(lines: list[str], tgt: str) -> str:
    """Hash build input tree IDs and target into the shared cache key."""
    if len(lines) != len(CACHE_KEY_PATHS):
        raise RuntimeError(f"git cat-file returned {len(lines)} lines, expected {len(CACHE_KEY_PATHS)}: {lines!r}")
    h = hashlib.sha256()
    for path, line in zip(CACHE_KEY_PATHS, lines, strict=True):
        stripped = line.strip()
        if stripped.endswith("missing"):
            tree_hash = _NULL_TREE_HASH
        else:
            # "<hash> <type> <size>" — take the first token as the tree/blob hash.
            tree_hash = stripped.split(None, 1)[0]
        h.update(f"{path}\t{tree_hash}\n".encode())
    h.update(f"TARGET\t{tgt}\n".encode())
    return h.hexdigest()


def _repo_slug(repo: str) -> str:
    """Same convention as ``SandboxManager.pool_path``."""
    return repo.replace("/", "__")


@contextmanager
def _directory(path: Path, *, create: bool = False, owner: tuple[int, int] | None = None) -> Generator[int]:
    """Pin every directory component without following symbolic links."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.absolute().parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                if owner is not None:
                    os.fchown(child, *owner)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _copy_file(
    src_dir: int, dst_dir: int, name: str, *, expected_uid: int | None = None, owner: tuple[int, int] | None = None
) -> None:
    """Copy an opened regular file, reflinking when the filesystem supports it."""
    src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=src_dir)
    tmp = f".{name}.{secrets.token_hex(12)}.tmp"
    try:
        info = os.fstat(src)
        if not stat.S_ISREG(info.st_mode) or (expected_uid is not None and info.st_uid != expected_uid):
            raise PermissionError(f"unsafe cache source: {name}")
        if info.st_size > _MAX_ARTIFACT_SIZE:
            raise OSError(errno.EFBIG, "native artifact too large", name)
        dst = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dst_dir)
        try:
            cloned = False
            clone = getattr(fcntl, "FICLONE", None)
            if clone is not None:
                try:
                    fcntl.ioctl(dst, clone, src)
                    cloned = True
                except OSError as exc:
                    if exc.errno not in (errno.EOPNOTSUPP, errno.EXDEV, errno.EINVAL, errno.ENOTTY, errno.ENOSYS):
                        raise
            if not cloned:
                with os.fdopen(os.dup(src), "rb") as source, os.fdopen(os.dup(dst), "wb") as dest:
                    remaining = _MAX_ARTIFACT_SIZE + 1
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        dest.write(chunk)
                        remaining -= len(chunk)
            if os.fstat(dst).st_size > _MAX_ARTIFACT_SIZE:
                raise OSError(errno.EFBIG, "native artifact too large", name)
            os.fchmod(dst, stat.S_IMODE(info.st_mode))
            if owner is not None:
                os.fchown(dst, *owner)
            os.utime(dst, ns=(info.st_atime_ns, info.st_mtime_ns))
            os.replace(tmp, name, src_dir_fd=dst_dir, dst_dir_fd=dst_dir)
        finally:
            os.close(dst)
            try:
                os.unlink(tmp, dir_fd=dst_dir)
            except FileNotFoundError:
                pass
    finally:
        os.close(src)


@contextmanager
def _flock(path: Path) -> Generator[IO[bytes]]:
    """Exclusive ``fcntl.flock`` on ``path`` (created if missing).

    ``flock`` is advisory but every caller goes through ``NativesCache``, so
    cooperative locking is sufficient. POSIX-only — Windows is not a target.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "ab+")  # noqa: SIM115 — managed by the context manager
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield fh
    finally:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        finally:
            fh.close()


@dataclass(slots=True, frozen=True)
class CacheHit:
    """Files copied/linked into the workspace by ``populate_workspace``."""

    cache_dir: Path
    files: tuple[Path, ...]


class NativesCache:
    """Per-repo content-addressed cache of pi-natives build outputs."""

    def __init__(
        self,
        root: Path,
        *,
        max_entries_per_repo: int = 8,
        max_bytes: int = 4 * 1024**3,
    ) -> None:
        self.root = root
        self.max_entries_per_repo = max(1, max_entries_per_repo)
        self.max_bytes = max(0, max_bytes)
        root.mkdir(parents=True, exist_ok=True)

    # ---- layout helpers ----
    def repo_root(self, repo: str) -> Path:
        return self.root / _repo_slug(repo)

    def entry_dir(self, repo: str, key: str) -> Path:
        return self.repo_root(repo) / key

    def lockfile(self, repo: str) -> Path:
        return self.repo_root(repo) / _LOCKFILE_NAME

    # ---- query ----
    def lookup(self, repo: str, key: str) -> Path | None:
        """Return the trusted seed or repository entry when complete."""
        if repo != "_image-seed":
            seed = self.lookup("_image-seed", key)
            if seed is not None:
                return seed
        entry = self.entry_dir(repo, key)
        if not (entry / _MANIFEST_FILENAME).exists():
            return None
        # A complete entry has a node file plus all companions.
        if not list(entry.glob(_CACHED_NODE_GLOB)):
            return None
        for name in _CACHED_COMPANION_FILES:
            if not (entry / name).exists():
                return None
        return entry

    def import_image_seed(self, seed_dir: Path) -> Path | None:
        """Import image-built artifacts under their source-tree and target key."""
        try:
            lines = (seed_dir / "trees.txt").read_text(encoding="utf-8").splitlines()
            key = _key_from_lines(lines, target_triple())
            return self.capture("_image-seed", key, seed_dir, expected_uid=os.geteuid())
        except (OSError, ValueError, RuntimeError):
            log.exception("natives_cache image seed import failed")
            return None

    # ---- populate (workspace ← cache) ----
    def populate_workspace(
        self,
        repo: str,
        key: str,
        native_dir: Path,
        *,
        owner: tuple[int, int] | None = None,
    ) -> CacheHit | None:
        """Copy cached artifacts into independent workspace inodes."""
        entry = self.lookup(repo, key)
        if entry is None:
            return None
        copied: list[Path] = []
        with _directory(entry) as source, _directory(native_dir, create=True, owner=owner) as dest:
            if owner is not None:
                os.fchown(dest, *owner)
            names = sorted(name for name in os.listdir(source) if fnmatch.fnmatchcase(name, _CACHED_NODE_GLOB))
            for name in (*names, *_CACHED_COMPANION_FILES):
                _copy_file(source, dest, name, owner=owner)
                copied.append(native_dir / name)
        return CacheHit(cache_dir=entry, files=tuple(copied))

    # ---- capture (cache ← workspace) ----
    def capture(
        self,
        repo: str,
        key: str,
        native_dir: Path,
        *,
        source_workspace: str | None = None,
        commit: str | None = None,
        expected_uid: int | None = None,
    ) -> Path | None:
        """Atomically capture ``native_dir`` contents under ``key``.

        Returns the final cache directory on store, ``None`` if there was
        nothing to capture or if another worker already populated the same
        key (idempotent under flock).
        """
        if expected_uid is None:
            expected_uid = os.geteuid()
        try:
            with _directory(native_dir) as source:
                node_names = sorted(name for name in os.listdir(source) if fnmatch.fnmatchcase(name, _CACHED_NODE_GLOB))
                if not node_names or any(name not in os.listdir(source) for name in _CACHED_COMPANION_FILES):
                    return None

                repo_root = self.repo_root(repo)
                repo_root.mkdir(parents=True, exist_ok=True)
                with _flock(self.lockfile(repo)):
                    existing = self.lookup(repo, key)
                    if existing is not None:
                        return existing
                    final = self.entry_dir(repo, key)
                    staging = repo_root / f".{key}.tmp.{os.getpid()}"
                    if staging.exists():
                        shutil.rmtree(staging, ignore_errors=True)
                    staging.mkdir(parents=True)
                    try:
                        with _directory(staging) as dest:
                            for name in (*node_names, *_CACHED_COMPANION_FILES):
                                _copy_file(source, dest, name, expected_uid=expected_uid)
                        manifest = {
                            "key": key,
                            "target": target_triple(),
                            "captured_at": time.time(),
                            "source_workspace": source_workspace,
                            "commit": commit,
                            "node_files": node_names,
                        }
                        (staging / _MANIFEST_FILENAME).write_text(
                            json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
                        )
                        os.replace(staging, final)
                    except Exception:
                        shutil.rmtree(staging, ignore_errors=True)
                        raise
                    self._gc_locked(repo)
                    return final
        except FileNotFoundError:
            return None

    # ---- gc ----
    def gc(self, repo: str | None = None) -> int:
        """Evict entries beyond per-repo or total caps.

        ``repo`` scopes to one repo when given; otherwise sweeps every repo
        directory under ``root``. Returns the count of evicted entries.
        """
        if repo is not None:
            with _flock(self.lockfile(repo)):
                return self._gc_locked(repo)
        total = 0
        if not self.root.exists():
            return 0
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            # Reconstruct repo identifier from directory name (best-effort;
            # only used for lockfile path, not for any externally-visible
            # identifier).
            repo_name = child.name.replace("__", "/", 1)
            try:
                with _flock(self.lockfile(repo_name)):
                    total += self._gc_locked(repo_name)
            except OSError as exc:
                log.warning("natives_cache gc skip", extra={"repo": child.name, "err": str(exc)})
        return total

    def _gc_locked(self, repo: str) -> int:
        """Caller MUST hold the per-repo flock."""
        repo_root = self.repo_root(repo)
        if not repo_root.exists():
            return 0
        entries: list[tuple[float, int, Path]] = []
        for child in repo_root.iterdir():
            if not child.is_dir():
                # Stale staging dirs (".<key>.tmp.<pid>") from a crashed
                # capture: drop them opportunistically.
                continue
            if child.name.startswith("."):
                shutil.rmtree(child, ignore_errors=True)
                continue
            manifest_path = child / _MANIFEST_FILENAME
            if not manifest_path.exists():
                # Incomplete entry — evict.
                shutil.rmtree(child, ignore_errors=True)
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                captured_at = float(manifest.get("captured_at", 0.0))
            except (OSError, ValueError, json.JSONDecodeError):
                captured_at = manifest_path.stat().st_mtime
            size = _dir_size(child)
            entries.append((captured_at, size, child))
        entries.sort(key=lambda row: row[0])  # oldest first

        evicted = 0
        # 1. Per-repo entry-count cap (drop oldest).
        while len(entries) > self.max_entries_per_repo:
            _, _, victim = entries.pop(0)
            shutil.rmtree(victim, ignore_errors=True)
            evicted += 1

        # 2. Per-repo byte cap (drop oldest until under).
        if self.max_bytes > 0:
            total = sum(size for _, size, _ in entries)
            while total > self.max_bytes and len(entries) > 1:
                _, size, victim = entries.pop(0)
                shutil.rmtree(victim, ignore_errors=True)
                total -= size
                evicted += 1
        return evicted


def _dir_size(path: Path) -> int:
    """Sum of file sizes under ``path``. Symlinks counted as their lstat
    size (not the target). Errors swallowed — GC is best-effort."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


__all__ = [
    "CACHE_KEY_PATHS",
    "CacheHit",
    "NativesCache",
    "compute_key",
    "target_triple",
]
