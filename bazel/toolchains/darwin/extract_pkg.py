#!/usr/bin/env python3
"""Extracts one directory tree from an Apple flat package (.pkg) on any host.

    extract_pkg.py <pkg> <member> <dest> [--exclude <subpath>]...

Copies the payload entries under <member> (a path inside the package payload,
e.g. Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk) into <dest>,
dropping the <member> prefix and every entry under an excluded <subpath>
(relative to <member>). Regular files, directories and symlinks are supported;
anything else fails the extraction. Symlinks to one of their own ancestors
(Ruby.framework's `Headers/ruby/ruby -> .`) are dropped: they make the tree
infinitely deep, and Bazel's glob fails on them.

Used by //bazel/toolchains/darwin:sdk.bzl to unpack the macOS SDK from Apple's
Command Line Tools package on Linux hosts, where neither `pkgutil` nor `xar`
exists. Standard library only. The three nested formats:

    xar     the .pkg container: a zlib-compressed XML table of contents
            locating each member (here `Payload`) in the heap after it
    pbzx    the Payload stream: 16-byte-framed chunks, each xz-compressed
            or stored
    cpio    the decoded stream: odc ("070707") entries, octal ASCII headers
"""

import lzma
import os
import shutil
import stat
import struct
import sys
import xml.etree.ElementTree as ET
import zlib

_CHUNK = 1 << 20


def _payload_span(pkg):
    """Returns (offset, length, encoding) of the top-level `Payload` member."""
    header = pkg.read(28)
    magic, header_size, _version, toc_compressed, _toc_size = struct.unpack(">4sHHQQ", header[:24])
    if magic != b"xar!":
        raise SystemExit("extract_pkg: not a xar archive (Apple flat package)")
    pkg.seek(header_size)
    toc = ET.fromstring(zlib.decompress(pkg.read(toc_compressed)))
    heap = header_size + toc_compressed
    for entry in toc.find("toc").findall("file"):
        if entry.findtext("name") == "Payload":
            data = entry.find("data")
            encoding = data.find("encoding").get("style")
            return heap + int(data.findtext("offset")), int(data.findtext("length")), encoding
    raise SystemExit("extract_pkg: package has no Payload member")


def _pbzx_chunks(pkg, offset, length):
    """Yields the decoded bytes of a pbzx stream stored at pkg[offset:offset+length]."""
    pkg.seek(offset)
    if pkg.read(4) != b"pbzx":
        raise SystemExit("extract_pkg: Payload is not a pbzx stream")
    (flags,) = struct.unpack(">Q", pkg.read(8))
    end = offset + length
    while flags & (1 << 24) and pkg.tell() < end:
        flags, size = struct.unpack(">QQ", pkg.read(16))
        chunk = pkg.read(size)
        yield lzma.decompress(chunk) if chunk.startswith(b"\xfd7zXZ\x00") else chunk


class _Stream:
    """Sequential reader over an iterator of byte chunks."""

    def __init__(self, chunks):
        self._chunks = chunks
        self._buf = bytearray()

    def read(self, n):
        while len(self._buf) < n:
            chunk = next(self._chunks, None)
            if chunk is None:
                raise SystemExit("extract_pkg: truncated cpio stream")
            self._buf += chunk
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def copy(self, n, out):
        while n:
            if not self._buf:
                chunk = next(self._chunks, None)
                if chunk is None:
                    raise SystemExit("extract_pkg: truncated cpio stream")
                self._buf += chunk
            take = min(n, len(self._buf), _CHUNK)
            if out:
                out.write(self._buf[:take])
            del self._buf[:take]
            n -= take


def _cpio_entries(stream):
    """Yields (name, mode, size) for each odc cpio entry; data follows each yield."""
    while True:
        header = stream.read(76)
        if header[:6] != b"070707":
            raise SystemExit("extract_pkg: unsupported cpio format (want odc 070707)")
        mode = int(header[18:24], 8)
        namesize = int(header[59:65], 8)
        size = int(header[65:76], 8)
        name = stream.read(namesize)[:-1].decode("utf-8")
        if name == "TRAILER!!!":
            return
        yield name, mode, size


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    pkg_path, member, dest = argv[0], argv[1].strip("/"), argv[2]
    rest = argv[3:]
    excludes = []
    while rest:
        if rest[0] != "--exclude" or len(rest) < 2:
            raise SystemExit(__doc__)
        excludes.append(rest[1].strip("/") + "/")
        rest = rest[2:]
    prefix = member + "/"
    found = False
    with open(pkg_path, "rb") as pkg:
        offset, length, encoding = _payload_span(pkg)
        if encoding != "application/octet-stream":
            raise SystemExit("extract_pkg: unsupported Payload encoding " + encoding)
        stream = _Stream(_pbzx_chunks(pkg, offset, length))
        for name, mode, size in _cpio_entries(stream):
            name = name[2:] if name.startswith("./") else name
            rel = None
            if name == member:
                rel = ""
            elif name.startswith(prefix):
                rel = name[len(prefix):]
            if rel is None or any((rel + "/").startswith(e) for e in excludes):
                stream.copy(size, None)
                continue
            found = True
            path = os.path.join(dest, rel)
            kind = stat.S_IFMT(mode)
            if kind == stat.S_IFDIR:
                os.makedirs(path, exist_ok=True)
                stream.copy(size, None)
            elif kind == stat.S_IFLNK:
                link = stream.read(size).decode("utf-8")
                target = os.path.normpath(os.path.join(os.path.dirname(rel), link))
                if not os.path.isabs(link) and (target == "." or (rel + "/").startswith(target + "/")):
                    continue
                os.makedirs(os.path.dirname(path), exist_ok=True)
                os.symlink(link, path)
            elif kind == stat.S_IFREG:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as out:
                    stream.copy(size, out)
                os.chmod(path, (mode & 0o777) | 0o644)
            else:
                raise SystemExit("extract_pkg: unsupported entry type for " + name)
    if not found:
        shutil.rmtree(dest, ignore_errors=True)
        raise SystemExit("extract_pkg: package payload has no " + member)


if __name__ == "__main__":
    main(sys.argv[1:])
