"""Bun link kits: the kit.json schema, verified download, local cache and compressed transport.

A kit holds the Bun side of one target's final link (see link.py). Builds use the archive pinned in
kits.json; a cache miss downloads it from OMP_BUN_KIT_BASE_URL and never compiles Bun. Maintainers
mint kits with prepare_kit.py and compress them here.

Usage: python3 scripts/linked-natives/kit.py pack <kit-directory> <output.tar.zst>  (prints the pin)
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, TypedDict

from pins import BUN_VERSION, KITS, KitPin, Target

CACHE = Path(__file__).resolve().parents[2] / "target" / "linked-natives" / "kits"
CHUNK = 1 << 20


class _KitFields(TypedDict):
    format: int
    target: str
    bun: str
    revision: str
    files: dict[str, str]
    """SHA-256 of every payload: `files/<n>-<name>`, LICENSE.md and verify.mjs (upstream's bundled verifier)."""
    eager: list[str]
    lazy: list[str]
    """Link inputs in upstream order; the lazy ones form a `--start-lib` group."""
    audit: list[str]
    """Inputs of upstream's duplicate-symbol check."""
    ldflags: list[str]
    """Upstream's link flags with {native}, {kit}, {out}, {sdk}, {lld} and {ucrt} placeholders."""
    stripflags: list[str]
    profile: dict[str, Any]
    """Upstream's verifier spec for the linked profile, without tool paths; files are kit paths."""


class Kit(_KitFields, total=False):
    """kit.json: the Bun side of one target's final link."""

    shim: dict[str, Any]
    """Windows only: the verifier spec of the prebuilt bun-shim-impl.exe in the kit."""


def digest(path: Path) -> str:
    """Stream a file's SHA-256."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(CHUNK):
            h.update(block)
    return h.hexdigest()


def fetch(url: str, dest: Path, sha256: str, size: int | None = None) -> None:
    """Download over HTTPS into the new file `dest`, rejecting any other size or digest."""
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ValueError(f"Refusing a non-HTTPS download: {url}")
    name = url.rsplit("/", 1)[-1]
    expected = f"{size} bytes, {sha256}" if size is not None else sha256
    try:
        response = urllib.request.urlopen(url)
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"Fetching {name} failed: HTTP {err.code}") from err
    h = hashlib.sha256()
    count = 0
    with response, dest.open("xb") as out:
        length = response.headers.get("Content-Length")
        if size is not None and length is not None and not response.headers.get("Content-Encoding"):
            if int(length) != size:
                raise RuntimeError(f"Unexpected download size for {name}: {length}, expected {size}")
        while chunk := response.read(CHUNK):
            count += len(chunk)
            if size is not None and count > size:
                raise RuntimeError(f"Download exceeds {size} bytes for {name}")
            h.update(chunk)
            out.write(chunk)
    if (size is not None and count != size) or h.hexdigest() != sha256:
        raise RuntimeError(f"Invalid download for {name}; expected {expected}")


def _check_manifest(directory: Path, pin: KitPin) -> None:
    if digest(directory / "kit.json") != pin["manifestSha256"]:
        raise RuntimeError(f"Unexpected link-kit manifest in {directory}")


def resolve(target: Target) -> Path:
    """Return the verified, unpacked kit for `target`; download only without a trusted local archive."""
    pin = KITS[target.id]
    filename = f"omp-bun-{BUN_VERSION}-{target.id}.tar.zst"
    archive = CACHE / filename
    unpacked = CACHE / pin["sha256"]
    if (unpacked / "kit.json").exists():
        _check_manifest(unpacked, pin)
        return unpacked
    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="unpack-", dir=CACHE))
    try:
        if archive.exists():
            if archive.stat().st_size != pin["bytes"] or digest(archive) != pin["sha256"]:
                raise RuntimeError(
                    f"Invalid size or SHA-256 for {filename}; expected {pin['bytes']} bytes, {pin['sha256']}"
                )
        else:
            base = os.environ.get("OMP_BUN_KIT_BASE_URL")
            if not base:
                raise RuntimeError(
                    f"Missing {archive}. Install the pinned kit or set OMP_BUN_KIT_BASE_URL to its HTTPS origin."
                )
            download = tmp / filename
            url = urllib.parse.urljoin(base.rstrip("/") + "/", f"{pin['sha256']}/{filename}")
            fetch(url, download, pin["sha256"], pin["bytes"])
            # Another build may be unpacking this archive on Windows. Never replace an open verified file.
            try:
                os.link(download, archive)
            except FileExistsError:
                if archive.stat().st_size != pin["bytes"] or digest(archive) != pin["sha256"]:
                    raise
        extracted = tmp / "kit"
        extracted.mkdir()
        unpack(archive, extracted)
        _check_manifest(extracted, pin)
        try:
            extracted.rename(unpacked)
        except OSError:
            if not (unpacked / "kit.json").exists():
                raise
            _check_manifest(unpacked, pin)
        return unpacked
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def pack(root: Path, dest: Path) -> KitPin:
    """Compress a minted kit directory; the returned pin belongs in kits.json."""
    manifest = digest(root / "kit.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The final name only appears once both tar and zstd have finished.
    with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as tmp:
        name = Path(tmp.name)
    try:
        with (
            name.open("wb") as out,
            subprocess.Popen(["zstd", "-q", "-T2", "-8", "-c"], stdin=subprocess.PIPE, stdout=out) as proc,
        ):
            assert proc.stdin is not None
            with proc.stdin, tarfile.open(fileobj=proc.stdin, mode="w|", bufsize=CHUNK) as tar:
                for source in sorted(root.rglob("*")):
                    if source.is_symlink() or not (source.is_file() or source.is_dir()):
                        raise ValueError(f"link kits accept only regular files and directories: {source}")
                    if source.is_dir():
                        continue
                    info = tarfile.TarInfo(source.relative_to(root).as_posix())
                    info.size = source.stat().st_size
                    info.mode = 0o755 if os.access(source, os.X_OK) else 0o644
                    with source.open("rb") as f:
                        tar.addfile(info, f)
            if proc.wait():
                raise RuntimeError("zstd failed to compress link kit")
        pin: KitPin = {"bytes": name.stat().st_size, "sha256": digest(name), "manifestSha256": manifest}
        os.replace(name, dest)
        return pin
    finally:
        name.unlink(missing_ok=True)


def unpack(archive: Path, dest: Path) -> None:
    """Extract a kit archive into the new, empty directory `dest`, admitting only plain relative files."""
    if not dest.is_dir() or any(dest.iterdir()):
        raise ValueError("extract link kits into a new, empty directory")
    with subprocess.Popen(["zstd", "-q", "-d", "-c", str(archive)], stdout=subprocess.PIPE) as proc:
        assert proc.stdout is not None
        with proc.stdout, tarfile.open(fileobj=proc.stdout, mode="r|", bufsize=CHUNK) as tar:
            for item in tar:
                path = PurePosixPath(item.name)
                if (
                    not item.isfile()
                    or not path.parts
                    or path.is_absolute()
                    or ".." in path.parts
                    or any(c in item.name for c in "\\:")
                ):
                    raise ValueError(f"unsafe link kit member: {item.name!r}")
                target = dest.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                src = tar.extractfile(item)
                assert src is not None
                with src, target.open("xb") as output:
                    shutil.copyfileobj(src, output, CHUNK)
                target.chmod(0o755 if item.mode & 0o111 else 0o644)
            # tar stops at the end marker. Drain the frame so zstd verifies its checksum.
            while proc.stdout.read(CHUNK):
                pass
        if proc.wait():
            raise RuntimeError("zstd failed to decompress link kit")


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] != "pack":
        sys.exit("usage: kit.py pack <kit-directory> <output.tar.zst>")
    print(json.dumps(pack(Path(sys.argv[2]), Path(sys.argv[3]))))
