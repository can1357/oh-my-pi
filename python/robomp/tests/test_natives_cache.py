"""Unit tests for `robomp.natives_cache`.

The module's filesystem operations (independent copies, atomic rename, flock) are
exercised against `tmp_path`; nothing here requires a running orchestrator.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path

import pytest

import robomp.natives_cache as natives_cache
from robomp.natives_cache import (
    CACHE_KEY_PATHS,
    NativesCache,
    compute_key,
)

REPO = "octo/widget"


# ---- repo + workspace fixtures ----


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
        },
    )


def _seed_repo(root: Path, *, with_all_inputs: bool = True) -> Path:
    """Stand up a minimal repo with the cache-key inputs present.

    When `with_all_inputs=False`, only `Cargo.lock` exists — used to exercise
    the missing-path code path in `compute_key`.
    """
    root.mkdir(parents=True, exist_ok=True)
    _git(["init", "--initial-branch=main", str(root)], cwd=root.parent)
    (root / "Cargo.lock").write_text("# lock v1\n")
    if with_all_inputs:
        (root / "Cargo.toml").write_text("[workspace]\nmembers = ['crates/*']\n")
        (root / "rust-toolchain.toml").write_text('[toolchain]\nchannel = "1.85.0"\n')
        crates = root / "crates" / "pi-natives"
        crates.mkdir(parents=True)
        (crates / "Cargo.toml").write_text('[package]\nname = "pi-natives"\n')
        (crates / "src.rs").write_text("// source\n")
        natives = root / "packages" / "natives"
        natives.mkdir(parents=True)
        (natives / "package.json").write_text('{"name":"@oh-my-pi/pi-natives"}\n')
        scripts = natives / "scripts"
        scripts.mkdir()
        (scripts / "build-native.ts").write_text("// build script\n")
        native_dir = natives / "native"
        native_dir.mkdir()
        (native_dir / "index.d.ts").write_text("// initial typings\n")
    _git(["-C", str(root), "add", "."], cwd=root.parent)
    _git(["-C", str(root), "commit", "-m", "init"], cwd=root.parent)
    return root


def _populate_built_artifacts(repo_dir: Path, *, body: bytes = b"\x7fELF...native") -> Path:
    """Fill `packages/natives/native/` with a complete built-artifact set."""
    native_dir = repo_dir / "packages" / "natives" / "native"
    native_dir.mkdir(parents=True, exist_ok=True)
    (native_dir / "pi_natives.linux-arm64.node").write_bytes(body)
    (native_dir / "index.d.ts").write_text("export const X: number;\n")
    (native_dir / "index.js").write_text("export const X = 1;\n")
    (native_dir / "embedded-addon.js").write_text("export const embeddedAddon = null;\n")
    return native_dir


# ---- compute_key ----


def test_compute_key_deterministic_across_clones(tmp_path: Path) -> None:
    a = _seed_repo(tmp_path / "a")
    b_root = tmp_path / "b"
    subprocess.run(["git", "clone", str(a), str(b_root)], check=True, capture_output=True, text=True)
    key_a = compute_key(a, target="linux-arm64")
    key_b = compute_key(b_root, target="linux-arm64")
    assert key_a == key_b


def test_compute_key_changes_when_each_input_changes(tmp_path: Path) -> None:
    base = _seed_repo(tmp_path / "base")
    base_key = compute_key(base, target="linux-arm64")

    # Touching a file under each key path must shift the key.
    mutations: dict[str, tuple[str, str]] = {
        "crates": ("crates/pi-natives/src.rs", "// new comment\n"),
        "Cargo.lock": ("Cargo.lock", "# lock v2\n"),
        "Cargo.toml": ("Cargo.toml", "[workspace]\nmembers = ['crates/*', 'extra']\n"),
        "rust-toolchain.toml": ("rust-toolchain.toml", '[toolchain]\nchannel = "1.86.0"\n'),
        "packages/natives": ("packages/natives/scripts/build-native.ts", "// edited\n"),
    }
    for label, (rel, body) in mutations.items():
        clone = tmp_path / f"clone-{label.replace('/', '-')}"
        subprocess.run(
            ["git", "clone", str(base), str(clone)],
            check=True,
            capture_output=True,
            text=True,
        )
        target = clone / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
        _git(["-C", str(clone), "add", "."], cwd=clone.parent)
        _git(["-C", str(clone), "commit", "-m", f"mutate {label}"], cwd=clone.parent)
        new_key = compute_key(clone, target="linux-arm64")
        assert new_key != base_key, f"key did not change after mutating {label}"


def test_compute_key_target_triple_changes_key(tmp_path: Path) -> None:
    repo = _seed_repo(tmp_path / "repo")
    arm = compute_key(repo, target="linux-arm64")
    x64 = compute_key(repo, target="linux-x64-modern")
    assert arm != x64


def test_compute_key_handles_missing_inputs(tmp_path: Path) -> None:
    """Missing key paths fold to a fixed null hash → key still deterministic."""
    repo = _seed_repo(tmp_path / "repo", with_all_inputs=False)
    # Lock-only repo: should compute without error, and adding a tracked
    # crates/ subtree shifts the key.
    key_before = compute_key(repo, target="linux-arm64")
    crates = repo / "crates" / "pi-natives"
    crates.mkdir(parents=True)
    (crates / "lib.rs").write_text("// new\n")
    _git(["-C", str(repo), "add", "."], cwd=repo.parent)
    _git(["-C", str(repo), "commit", "-m", "add crates"], cwd=repo.parent)
    key_after = compute_key(repo, target="linux-arm64")
    assert key_before != key_after


def test_compute_key_uses_all_documented_paths() -> None:
    # Sanity contract: the exported path list IS the input set.
    assert CACHE_KEY_PATHS == (
        "crates",
        "Cargo.lock",
        "Cargo.toml",
        "rust-toolchain.toml",
        "packages/natives",
    )


def test_compute_key_raises_on_non_repo(tmp_path: Path) -> None:
    with pytest.raises(subprocess.CalledProcessError):
        compute_key(tmp_path, target="linux-arm64")


# ---- populate / capture ----


def _cache(tmp_path: Path, **kwargs: object) -> NativesCache:
    return NativesCache(tmp_path / "natives-cache", **kwargs)  # type: ignore[arg-type]


def test_populate_workspace_miss_is_noop(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    repo_dir = _seed_repo(tmp_path / "ws" / "repo")
    native_dir = repo_dir / "packages" / "natives" / "native"
    before = sorted(p.name for p in native_dir.iterdir())
    hit = cache.populate_workspace(REPO, "deadbeef" * 8, native_dir)
    after = sorted(p.name for p in native_dir.iterdir())
    assert hit is None
    assert before == after


def test_capture_then_populate_copies_artifacts(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    src_repo = _seed_repo(tmp_path / "src" / "repo")
    native_dir = _populate_built_artifacts(src_repo)
    key = compute_key(src_repo, target="linux-arm64")
    stored = cache.capture(REPO, key, native_dir, source_workspace="src__001")
    assert stored is not None
    manifest = json.loads((stored / "manifest.json").read_text())
    assert manifest["key"] == key
    assert "pi_natives.linux-arm64.node" in manifest["node_files"]

    # Populate a fresh workspace from the same source state.
    dst_repo = src_repo.parent.parent / "dst" / "repo"
    dst_repo.mkdir(parents=True)
    _git(["clone", str(src_repo), str(dst_repo)], cwd=dst_repo.parent)
    dst_native = dst_repo / "packages" / "natives" / "native"
    dst_native.mkdir(parents=True, exist_ok=True)
    hit = cache.populate_workspace(REPO, key, dst_native)
    assert hit is not None
    assert {p.name for p in hit.files} >= {
        "pi_natives.linux-arm64.node",
        "index.d.ts",
        "index.js",
        "embedded-addon.js",
    }
    cached_node = stored / "pi_natives.linux-arm64.node"
    workspace_node = dst_native / "pi_natives.linux-arm64.node"
    workspace_node.write_bytes(b"changed")
    assert cached_node.read_bytes() == b"\x7fELF...native"
    # Companions are COPIED (independent inodes): in-place rewrite in the
    # workspace (gen-enums.ts / installGeneratedBindings open-truncate-write)
    # MUST NOT mutate the cached copy.
    for name in ("index.d.ts", "index.js", "embedded-addon.js"):
        cached_companion = stored / name
        ws_companion = dst_native / name
        assert cached_companion.stat().st_ino != ws_companion.stat().st_ino, name
        original = cached_companion.read_text()
        ws_companion.write_text("rewritten\n")
        assert cached_companion.read_text() == original, name


@pytest.mark.parametrize("name", ["index.js", "pi_natives.linux-arm64.node"])
def test_capture_rejects_symlink_sources(tmp_path: Path, name: str) -> None:
    cache = _cache(tmp_path)
    native = _populate_built_artifacts(_seed_repo(tmp_path / "repo"))
    secret = tmp_path / "secret"
    secret.write_text("private marker")
    (native / name).unlink()
    (native / name).symlink_to(secret)
    with pytest.raises(OSError):
        cache.capture(REPO, "key", native, expected_uid=os.geteuid())
    assert cache.lookup(REPO, "key") is None


def test_capture_rejects_source_replaced_during_capture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = _cache(tmp_path)
    native = _populate_built_artifacts(_seed_repo(tmp_path / "repo"))
    secret = tmp_path / "secret"
    secret.write_text("private marker")
    copy_file = natives_cache._copy_file

    def replace_then_copy(src_dir: int, dst_dir: int, name: str, **kwargs: object) -> None:
        if name == "index.js":
            (native / name).unlink()
            (native / name).symlink_to(secret)
        copy_file(src_dir, dst_dir, name, **kwargs)

    monkeypatch.setattr(natives_cache, "_copy_file", replace_then_copy)
    with pytest.raises(OSError):
        cache.capture(REPO, "key", native, expected_uid=os.geteuid())
    assert cache.lookup(REPO, "key") is None


def test_image_seed_serves_matching_source_key_across_repositories(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    repo = _seed_repo(tmp_path / "repo")
    native = _populate_built_artifacts(repo)
    proc = subprocess.run(
        ["git", "cat-file", "--batch-check"],
        input="".join(f"HEAD:{p}\n" for p in CACHE_KEY_PATHS),
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    )
    (native / "trees.txt").write_text(proc.stdout)
    assert cache.import_image_seed(native) is not None
    key = compute_key(repo)
    dest = tmp_path / "consumer" / "native"
    assert cache.populate_workspace("another/repo", key, dest) is not None
    assert (dest / "index.js").read_text() == "export const X = 1;\n"
    assert cache.populate_workspace(REPO, "different-key", tmp_path / "miss") is None


def test_populate_rejects_symlinked_destination(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    native = _populate_built_artifacts(_seed_repo(tmp_path / "repo"))
    cache.capture(REPO, "key", native, expected_uid=os.geteuid())
    victim = tmp_path / "victim"
    victim.mkdir()
    link = tmp_path / "link"
    link.symlink_to(victim, target_is_directory=True)
    with pytest.raises(OSError):
        cache.populate_workspace(REPO, "key", link)
    assert list(victim.iterdir()) == []


def test_populate_rejects_symlinked_cache_artifact(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    native = _populate_built_artifacts(_seed_repo(tmp_path / "repo"))
    entry = cache.capture(REPO, "key", native, expected_uid=os.geteuid())
    assert entry is not None
    secret = tmp_path / "secret"
    secret.write_text("private marker")
    (entry / "index.js").unlink()
    (entry / "index.js").symlink_to(secret)
    with pytest.raises(OSError):
        cache.populate_workspace(REPO, "key", tmp_path / "workspace" / "native")
    assert not (tmp_path / "workspace" / "native" / "index.js").exists()


def test_capture_rejects_foreign_owned_file(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    native = _populate_built_artifacts(_seed_repo(tmp_path / "repo"))
    with pytest.raises(PermissionError):
        cache.capture(REPO, "key", native, expected_uid=os.geteuid() + 1)
    assert cache.lookup(REPO, "key") is None


def test_capture_skips_when_artifacts_incomplete(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    repo = _seed_repo(tmp_path / "ws" / "repo")
    native_dir = repo / "packages" / "natives" / "native"
    # Only the .node — missing companions → capture refuses.
    (native_dir / "pi_natives.linux-arm64.node").write_bytes(b"x")
    assert cache.capture(REPO, "k", native_dir) is None
    # And no entry was created.
    assert not cache.entry_dir(REPO, "k").exists()


def test_capture_is_idempotent_under_lock(tmp_path: Path) -> None:
    """Two concurrent captures of the same key end with one final entry."""
    cache = _cache(tmp_path)
    src_repo = _seed_repo(tmp_path / "src" / "repo")
    _populate_built_artifacts(src_repo)
    key = compute_key(src_repo, target="linux-arm64")
    native_dir = src_repo / "packages" / "natives" / "native"

    results: list[Path | None] = []
    barrier = threading.Barrier(2)

    def run() -> None:
        barrier.wait()
        results.append(cache.capture(REPO, key, native_dir))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # Both calls succeed (one captures, the other recognizes the entry).
    assert all(isinstance(r, Path) for r in results)
    # Exactly one final entry directory (no leftover staging).
    repo_root = cache.repo_root(REPO)
    final_dirs = [p for p in repo_root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    assert len(final_dirs) == 1
    assert final_dirs[0].name == key


def test_populate_replaces_existing_file_atomically(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    src_repo = _seed_repo(tmp_path / "src" / "repo")
    _populate_built_artifacts(src_repo, body=b"\x7fELF.A")
    key = compute_key(src_repo, target="linux-arm64")
    cache.capture(REPO, key, src_repo / "packages" / "natives" / "native")

    dst_native = tmp_path / "dst" / "packages" / "natives" / "native"
    dst_native.mkdir(parents=True)
    # Pre-existing stub bytes — populate must replace, not append/error.
    target = dst_native / "pi_natives.linux-arm64.node"
    target.write_bytes(b"old-stub")
    hit = cache.populate_workspace(REPO, key, dst_native)
    assert hit is not None
    assert target.read_bytes() == b"\x7fELF.A"


# ---- gc ----


def _stamp_entry(cache: NativesCache, repo: str, key: str, captured_at: float) -> Path:
    entry = cache.entry_dir(repo, key)
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "pi_natives.linux-arm64.node").write_bytes(b"x" * 1024)
    (entry / "index.d.ts").write_text("")
    (entry / "index.js").write_text("")
    (entry / "embedded-addon.js").write_text("")
    (entry / "manifest.json").write_text(
        json.dumps({"key": key, "captured_at": captured_at, "node_files": ["pi_natives.linux-arm64.node"]})
    )
    return entry


def test_gc_evicts_oldest_beyond_entry_cap(tmp_path: Path) -> None:
    cache = _cache(tmp_path, max_entries_per_repo=2, max_bytes=0)
    now = time.time()
    _stamp_entry(cache, REPO, "k1", now - 300)
    _stamp_entry(cache, REPO, "k2", now - 200)
    _stamp_entry(cache, REPO, "k3", now - 100)
    evicted = cache.gc(REPO)
    assert evicted == 1
    remaining = {p.name for p in cache.repo_root(REPO).iterdir() if p.is_dir() and not p.name.startswith(".")}
    assert remaining == {"k2", "k3"}


def test_gc_evicts_for_byte_cap(tmp_path: Path) -> None:
    cache = _cache(tmp_path, max_entries_per_repo=8, max_bytes=2500)
    now = time.time()
    # Each entry weighs ~1024 bytes (the .node); 3 entries → ~3072 bytes > cap.
    _stamp_entry(cache, REPO, "k1", now - 300)
    _stamp_entry(cache, REPO, "k2", now - 200)
    _stamp_entry(cache, REPO, "k3", now - 100)
    cache.gc(REPO)
    remaining = {p.name for p in cache.repo_root(REPO).iterdir() if p.is_dir() and not p.name.startswith(".")}
    # Oldest evicted; at least one survives.
    assert "k1" not in remaining
    assert remaining <= {"k2", "k3"}
    assert remaining


def test_gc_preserves_populated_workspace(tmp_path: Path) -> None:
    cache = _cache(tmp_path, max_entries_per_repo=1, max_bytes=0)
    now = time.time()
    entry = _stamp_entry(cache, REPO, "k1", now - 500)
    _stamp_entry(cache, REPO, "k2", now - 100)
    workspace = tmp_path / "ws"
    assert cache.populate_workspace(REPO, "k1", workspace) is not None
    cache.gc(REPO)
    assert not entry.exists()
    assert (workspace / "pi_natives.linux-arm64.node").read_bytes() == b"x" * 1024


def test_gc_clears_stale_staging_dirs(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    repo_root = cache.repo_root(REPO)
    repo_root.mkdir(parents=True)
    stale = repo_root / ".aabb.tmp.99999"
    stale.mkdir()
    (stale / "leaked").write_text("from a crashed capture")
    cache.gc(REPO)
    assert not stale.exists()


def test_gc_drops_entry_with_missing_manifest(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    incomplete = cache.entry_dir(REPO, "bogus")
    incomplete.mkdir(parents=True)
    (incomplete / "pi_natives.linux-arm64.node").write_bytes(b"x")
    cache.gc(REPO)
    assert not incomplete.exists()


def test_lookup_rejects_incomplete_entry(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    entry = cache.entry_dir(REPO, "partial")
    entry.mkdir(parents=True)
    (entry / "manifest.json").write_text("{}")
    # No .node → no hit even though manifest exists.
    assert cache.lookup(REPO, "partial") is None
